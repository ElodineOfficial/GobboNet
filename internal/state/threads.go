package state

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// # Addressing one conversation
//
// /state stores one document per sync target and always will; these routes
// change the request, not the file. A phone that adds a message sends that
// message, not its entire history, and a request that names thread A has no
// expression for thread B -- so "do not overwrite the other device's chats"
// stops being a rule that has to be applied correctly and becomes something the
// protocol cannot say.
//
//	GET    /state/index                   ids, versions and message counts
//	GET    /state/threads/<id>            one conversation
//	PUT    /state/threads/<id>            replace or create it
//	POST   /state/threads/<id>/append     add messages to the end
//	DELETE /state/threads/<id>            remove it
//	GET    /state/meta                    everything that is not a conversation
//	PUT    /state/meta                    replace that
//
// Every one of them takes the same ?profile= selector as /state.
//
// # Preconditions are required, not optional
//
// Each mutating route demands If-Match or If-None-Match and answers 428 without
// one. An unconditional write to a thread is a blind overwrite, which is the
// behaviour these routes exist to remove; leaving it available as the default
// would mean a client could opt out of the safety by forgetting a header.
//
// A failed precondition is 412 with the current version in the body, so the
// caller can reconcile in one round trip rather than two. Nothing is written
// and nothing is read past the check.
//
// On append the precondition does a second job: appends are not idempotent, so
// a request that times out after the server committed would duplicate messages
// on retry. A successful append changes the thread's etag, so the retry's stale
// If-Match fails -- provided the client only advances its cached etag on a
// response it actually received.

// threadRoute splits /state/threads/<id> and /state/threads/<id>/append.
//
// ok is false for anything else, including an unknown trailing segment, which
// sends the request to the 404 the package comment describes rather than to a
// route that half matches.
func threadRoute(path string) (id, sub string, ok bool) {
	rest, found := strings.CutPrefix(path, "/state/threads/")
	if !found {
		return "", "", false
	}
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		id, sub = rest[:i], rest[i+1:]
	} else {
		id = rest
	}
	if !validThreadID(id) || (sub != "" && sub != "append") {
		return "", "", false
	}
	return id, sub, true
}

// validThreadID checks only what has to be true.
//
// Deliberately looser than profileRe, because the two are not the same problem:
// a profile name becomes a filename, a thread id does not. It is a JSON field
// value and a URL path segment, so the real constraints are that it is
// non-empty, bounded, and free of control characters. generateId() emits
// base36, but importData() takes thread ids straight out of whatever file the
// user picked, and refusing an id we would otherwise round-trip fine would be
// inventing a failure rather than catching one.
func validThreadID(id string) bool {
	if id == "" || len(id) > 256 || !utf8.ValidString(id) {
		return false
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Writes are serialised per file.
//
// store() never needed this: it was a blind overwrite, so last writer wins was
// the whole design. Read-modify-write is different. Two requests patching
// different conversations would each read the same document, each splice their
// own change, and the second write would silently drop the first -- which is
// precisely the bug these routes exist to remove, reintroduced one layer down.
//
// Readers do not take the lock. writeAtomic renames into place, so a reader
// sees either the whole old file or the whole new one, never a torn one.
//
// Entries are never evicted. The key space is the set of state files, which the
// profile allowlist already bounds.
var (
	locksMu sync.Mutex
	locks   = map[string]*sync.Mutex{}
)

func lockFor(path string) *sync.Mutex {
	locksMu.Lock()
	defer locksMu.Unlock()
	m, ok := locks[path]
	if !ok {
		m = &sync.Mutex{}
		locks[path] = m
	}
	return m
}

// checkPrecondition compares the caller's headers against the current version.
// current is "" when the resource does not exist. A zero status means proceed.
func checkPrecondition(r *http.Request, current string) (int, string) {
	ifMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	ifNone := strings.TrimSpace(r.Header.Get("If-None-Match"))

	switch {
	case ifMatch == "" && ifNone == "":
		return http.StatusPreconditionRequired,
			"send If-Match with the version you are replacing, or If-None-Match: * to create"

	case ifMatch != "":
		// If-Match wins when both are present, per RFC 9110.
		if current == "" {
			return http.StatusPreconditionFailed, "no such resource"
		}
		if ifMatch == "*" {
			return 0, ""
		}
		for _, tag := range strings.Split(ifMatch, ",") {
			if strings.TrimSpace(tag) == current {
				return 0, ""
			}
		}
		return http.StatusPreconditionFailed, "version mismatch"

	default:
		if ifNone != "*" {
			return http.StatusBadRequest, "If-None-Match is only supported as *"
		}
		if current != "" {
			return http.StatusPreconditionFailed, "already exists"
		}
		return 0, ""
	}
}

// failPrecondition answers with the current version so the caller can
// reconcile without a second request.
func failPrecondition(w http.ResponseWriter, r *http.Request, status int, message, etag string, count int) {
	body := map[string]any{"error": message}
	if etag != "" {
		w.Header().Set("ETag", etag)
		body["etag"] = etag
		if count >= 0 {
			body["messages"] = count
		}
	}
	httpx.WriteJSON(w, r, status, body)
}

// readJSONBody reads a request body under the shared size cap.
func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return nil, false
	}
	if len(body) > MaxBodyBytes {
		httpx.Error(w, r, http.StatusRequestEntityTooLarge, "state too large")
		return nil, false
	}
	if !json.Valid(body) {
		httpx.Error(w, r, http.StatusBadRequest, "body is not valid JSON")
		return nil, false
	}
	return body, true
}

// serveIndex lists what the server holds, without any message content.
//
// This is what a conversation switch fetches: one small body that answers "has
// anything here changed since I last looked" for every thread at once. It is
// derived from the document on each request rather than cached in a sidecar,
// which costs a parse we already do on every write and keeps every identifier
// and count inside the single file -- so an encrypted store later has nothing
// sitting outside the envelope.
func serveIndex(w http.ResponseWriter, r *http.Request, t target) {
	d, info, exists, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	if !exists {
		httpx.Error(w, r, http.StatusNotFound, "no state on server")
		return
	}

	type entry struct {
		ID       string `json:"id"`
		ETag     string `json:"etag"`
		Messages int    `json:"messages"`
		Bytes    int    `json:"bytes"`
	}
	threads := []entry{}
	unaddressable := 0
	for _, t := range d.threads {
		id, ok := threadID(t)
		if !ok {
			// Counted rather than hidden: a thread with no usable id round-trips
			// fine but can never be the target of a per-thread request, and a
			// client that cannot see why would have no way to find out.
			unaddressable++
			continue
		}
		threads = append(threads, entry{
			ID:       id,
			ETag:     etagOf(t),
			Messages: messageCount(t),
			Bytes:    len(t),
		})
	}

	mtime := mtimeMS(info)
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtime, 10))
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"threads":       threads,
		"unaddressable": unaddressable,
		"meta":          etagOf(metaBytes(d)),
		"mtime":         mtime,
		"size":          info.Size(),
	})
}

// metaBytes is everything that is not a conversation, encoded. Used for both
// the /state/meta body and its version token.
func metaBytes(d *document) []byte {
	body, err := marshalJSON(d.keys)
	if err != nil {
		return []byte("{}")
	}
	return body
}

// handleThread serves the per-conversation routes.
func handleThread(w http.ResponseWriter, r *http.Request, t target, id, sub string) {
	if sub == "append" {
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		appendToThread(w, r, t, id)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		serveThread(w, r, t, id)
	case http.MethodPut:
		putThread(w, r, t, id)
	case http.MethodDelete:
		deleteThread(w, r, t, id)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func serveThread(w http.ResponseWriter, r *http.Request, t target, id string) {
	d, info, exists, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	if !exists {
		httpx.Error(w, r, http.StatusNotFound, "no state on server")
		return
	}
	i := d.find(id)
	if i < 0 {
		httpx.Error(w, r, http.StatusNotFound, "no such thread")
		return
	}
	w.Header().Set("ETag", etagOf(d.threads[i]))
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtimeMS(info), 10))
	httpx.WriteBytes(w, r, http.StatusOK, "application/json; charset=utf-8", d.threads[i])
}

func putThread(w http.ResponseWriter, r *http.Request, t target, id string) {
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	// The body must be one conversation object, and if it names itself it must
	// agree with the URL. A mismatch means the caller is confused about which
	// thread it is writing, and guessing which of the two it meant is exactly
	// the kind of recovery that turns into a support thread later.
	if bodyID, named := threadID(body); named && bodyID != id {
		httpx.Error(w, r, http.StatusBadRequest,
			"thread id in the body does not match the one in the path")
		return
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "body is not a JSON object")
		return
	}

	mu := lockFor(t.path)
	mu.Lock()
	defer mu.Unlock()

	d, _, _, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	i := d.find(id)
	current := ""
	count := -1
	if i >= 0 {
		current = etagOf(d.threads[i])
		count = messageCount(d.threads[i])
	}
	if status, msg := checkPrecondition(r, current); status != 0 {
		failPrecondition(w, r, status, msg, current, count)
		return
	}

	if i >= 0 {
		d.threads[i] = json.RawMessage(body)
	} else {
		d.threads = append(d.threads, json.RawMessage(body))
		d.hadThreads = true
	}
	writeAndReport(w, r, t, d, etagOf(json.RawMessage(body)), messageCount(body))
}

func deleteThread(w http.ResponseWriter, r *http.Request, t target, id string) {
	mu := lockFor(t.path)
	mu.Lock()
	defer mu.Unlock()

	d, _, exists, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	i := -1
	if exists {
		i = d.find(id)
	}
	current := ""
	count := -1
	if i >= 0 {
		current = etagOf(d.threads[i])
		count = messageCount(d.threads[i])
	}
	// A precondition is required here too. Deleting a conversation another
	// device has since extended discards messages this device never saw, and
	// the user asked to delete the thread they were looking at. If-Match: *
	// is the explicit "whatever is there" form.
	if status, msg := checkPrecondition(r, current); status != 0 {
		failPrecondition(w, r, status, msg, current, count)
		return
	}
	if i < 0 {
		httpx.Error(w, r, http.StatusNotFound, "no such thread")
		return
	}

	d.threads = append(d.threads[:i], d.threads[i+1:]...)
	writeAndReport(w, r, t, d, "", -1)
}

func appendToThread(w http.ResponseWriter, r *http.Request, t target, id string) {
	// A concrete version is required. If-Match: * would mean "append to
	// whatever is there", which is the blind write this route replaces.
	if strings.TrimSpace(r.Header.Get("If-Match")) == "*" {
		httpx.Error(w, r, http.StatusPreconditionRequired,
			"append needs the exact version it is extending, not *")
		return
	}
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	var extra []json.RawMessage
	if err := json.Unmarshal(body, &extra); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "body must be a JSON array of messages")
		return
	}
	if len(extra) == 0 {
		httpx.Error(w, r, http.StatusBadRequest, "body must contain at least one message")
		return
	}

	mu := lockFor(t.path)
	mu.Lock()
	defer mu.Unlock()

	d, _, exists, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	i := -1
	if exists {
		i = d.find(id)
	}
	current := ""
	count := -1
	if i >= 0 {
		current = etagOf(d.threads[i])
		count = messageCount(d.threads[i])
	}
	if status, msg := checkPrecondition(r, current); status != 0 {
		failPrecondition(w, r, status, msg, current, count)
		return
	}
	if i < 0 {
		// Append extends; it does not create. A client with a thread the server
		// has never seen should PUT it, and saying so is more useful than
		// inventing an empty conversation to append to.
		httpx.Error(w, r, http.StatusNotFound, "no such thread")
		return
	}

	patched, total, err := appendMessages(d.threads[i], extra)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusConflict, "cannot append to this thread", err.Error())
		return
	}
	d.threads[i] = patched
	writeAndReport(w, r, t, d, etagOf(patched), total)
}

// handleMeta serves everything that is not a conversation: settings, character
// and persona cards, folders, thread order.
func handleMeta(w http.ResponseWriter, r *http.Request, t target) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		d, info, exists, err := loadDocument(t)
		if err != nil {
			httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
			return
		}
		if !exists {
			httpx.Error(w, r, http.StatusNotFound, "no state on server")
			return
		}
		body := metaBytes(d)
		w.Header().Set("ETag", etagOf(body))
		w.Header().Set("X-State-Mtime", strconv.FormatInt(mtimeMS(info), 10))
		httpx.WriteBytes(w, r, http.StatusOK, "application/json; charset=utf-8", body)

	case http.MethodPut:
		putMeta(w, r, t)

	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func putMeta(w http.ResponseWriter, r *http.Request, t target) {
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	incoming := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &incoming); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "body is not a JSON object")
		return
	}
	// Conversations belong to the thread routes. Accepting them here would give
	// a caller two ways to write the same data, one of which skips every
	// per-thread precondition.
	if _, found := incoming["threads"]; found {
		httpx.Error(w, r, http.StatusBadRequest,
			"meta must not contain threads -- use /state/threads/<id>")
		return
	}

	mu := lockFor(t.path)
	mu.Lock()
	defer mu.Unlock()

	d, _, exists, err := loadDocument(t)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	current := ""
	if exists {
		current = etagOf(metaBytes(d))
	}
	if status, msg := checkPrecondition(r, current); status != 0 {
		failPrecondition(w, r, status, msg, current, -1)
		return
	}

	d.keys = incoming
	writeAndReport(w, r, t, d, etagOf(metaBytes(d)), -1)
}

// writeAndReport saves the patched document and answers with the new version.
func writeAndReport(w http.ResponseWriter, r *http.Request, t target, d *document, etag string, count int) {
	mtime, err := saveDocument(t, d)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "write failed", err.Error())
		return
	}
	out := map[string]any{"status": "ok", "mtime": mtime}
	if etag != "" {
		w.Header().Set("ETag", etag)
		out["etag"] = etag
	}
	if count >= 0 {
		out["messages"] = count
	}
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtime, 10))
	httpx.WriteJSON(w, r, http.StatusOK, out)
}
