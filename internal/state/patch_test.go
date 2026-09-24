package state

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// A document with two conversations plus a handful of the sibling keys the
// browser actually sends, so the round-trip assertions have something to lose.
const seedDoc = `{
  "threads": [
    {"id":"alpha","name":"Alpha","messages":[{"role":"user","content":"one"}],"unknownField":{"keep":"me"}},
    {"id":"beta","name":"Beta","messages":[{"role":"user","content":"two"},{"role":"assistant","content":"three"}]}
  ],
  "settings": {"temperature": 0.7},
  "folders": [],
  "aKeyThisBuildHasNeverHeardOf": {"nested": [1, 2, 3]},
  "bigIntegerId": 90071992547409911,
  "preciseFloat": 0.1000000000000000055511151231257827,
  "angleBrackets": "a <b> & c"
}`

type req struct {
	method, target, body string
	headers              map[string]string
}

func send(t *testing.T, path string, q req) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if q.body == "" {
		r = httptest.NewRequest(q.method, q.target, nil)
	} else {
		r = httptest.NewRequest(q.method, q.target, strings.NewReader(q.body))
	}
	for k, v := range q.headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	Handle(rec, r, path, testKey)
	return rec
}

func seed(t *testing.T) string {
	t.Helper()
	sp := statePath(t)
	rec := send(t, sp, req{method: http.MethodPost, target: "/state", body: seedDoc})
	if rec.Code != http.StatusOK {
		t.Fatalf("seed: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	return sp
}

func body(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v\nbody: %s", err, rec.Body)
	}
	return out
}

// etagFor reads a thread's current version the way a client does.
func etagFor(t *testing.T, sp, id string) string {
	t.Helper()
	rec := send(t, sp, req{method: http.MethodGet, target: "/state/threads/" + id})
	if rec.Code != http.StatusOK {
		t.Fatalf("GET thread %s: got %d, want 200", id, rec.Code)
	}
	tag := rec.Header().Get("ETag")
	if tag == "" {
		t.Fatalf("GET thread %s: no ETag header", id)
	}
	return tag
}

// compact normalises insignificant whitespace, which is the only thing a patch
// is allowed to change about a value it did not touch.
func compact(t *testing.T, raw []byte) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, raw)
	}
	return buf.String()
}

// readDoc returns the file as the server left it.
func readDoc(t *testing.T, sp string) *document {
	t.Helper()
	d, err := parseDocument(storedBytes(t, sp))
	if err != nil {
		t.Fatalf("stored document does not parse: %v", err)
	}
	return d
}

// --- the index -------------------------------------------------------------

func TestIndexReportsVersionsAndCounts(t *testing.T) {
	sp := seed(t)
	rec := send(t, sp, req{method: http.MethodGet, target: "/state/index"})
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /state/index: got %d, want 200", rec.Code)
	}
	got := body(t, rec)

	threads, _ := got["threads"].([]any)
	if len(threads) != 2 {
		t.Fatalf("index threads: got %d, want 2", len(threads))
	}
	first, _ := threads[0].(map[string]any)
	if first["id"] != "alpha" {
		t.Errorf("first id: got %v, want alpha", first["id"])
	}
	if first["messages"] != float64(1) {
		t.Errorf("alpha messages: got %v, want 1", first["messages"])
	}
	if tag, _ := first["etag"].(string); !strings.HasPrefix(tag, `"`) {
		t.Errorf("etag is not a quoted entity tag: %q", tag)
	}
	second, _ := threads[1].(map[string]any)
	if second["messages"] != float64(2) {
		t.Errorf("beta messages: got %v, want 2", second["messages"])
	}
	// No message content may appear in the index -- it is fetched on every
	// conversation switch, so it has to stay small and boring.
	if strings.Contains(rec.Body.String(), "content") {
		t.Errorf("index leaked message content: %s", rec.Body)
	}
	for _, key := range []string{"mtime", "size", "meta", "unaddressable"} {
		if _, ok := got[key]; !ok {
			t.Errorf("index is missing %q", key)
		}
	}
}

// A thread with no usable id round-trips fine but cannot be addressed. The
// index says how many there are rather than pretending they are not there.
func TestIndexCountsUnaddressableThreads(t *testing.T) {
	sp := statePath(t)
	send(t, sp, req{method: http.MethodPost, target: "/state",
		body: `{"threads":[{"id":"ok","messages":[]},{"name":"no id here"},{"id":42}]}`})

	got := body(t, send(t, sp, req{method: http.MethodGet, target: "/state/index"}))
	if got["unaddressable"] != float64(2) {
		t.Errorf("unaddressable: got %v, want 2", got["unaddressable"])
	}
	if threads, _ := got["threads"].([]any); len(threads) != 1 {
		t.Errorf("addressable threads: got %d, want 1", len(threads))
	}
}

// --- the property the whole design rests on --------------------------------

// Writing one conversation must not disturb any other, and must not disturb
// keys this build does not understand.
func TestPatchingOneThreadLeavesEverythingElseIntact(t *testing.T) {
	sp := seed(t)
	before := readDoc(t, sp)
	betaBefore := string(before.threads[1])

	tag := etagFor(t, sp, "alpha")
	rec := send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/alpha/append",
		body:    `[{"role":"assistant","content":"appended"}]`,
		headers: map[string]string{"If-Match": tag},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("append: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := body(t, rec)["messages"]; got != float64(2) {
		t.Errorf("message count after append: got %v, want 2", got)
	}

	after := readDoc(t, sp)

	// The untouched conversation keeps its exact bytes.
	if got := string(after.threads[1]); got != betaBefore {
		t.Errorf("untouched thread was rewritten:\n got %s\nwant %s", got, betaBefore)
	}
	// Sibling keys survive, including one the server has no idea about.
	//
	// Compared after compaction, because that is the guarantee this package
	// actually makes: raw values are never decoded, so structure and every
	// literal survive, but insignificant whitespace does not.
	for key, want := range before.keys {
		got, ok := after.keys[key]
		if !ok {
			t.Errorf("top-level key %q was dropped", key)
			continue
		}
		if compact(t, got) != compact(t, want) {
			t.Errorf("top-level key %q changed:\n got %s\nwant %s", key, got, want)
		}
	}
	// And the patched thread kept the field the server does not model.
	if !strings.Contains(string(after.threads[0]), `"unknownField"`) {
		t.Errorf("patched thread lost an unmodelled field: %s", after.threads[0])
	}
	if n := messageCount(after.threads[0]); n != 2 {
		t.Errorf("patched thread messages: got %d, want 2", n)
	}
}

// The reason values are carried as raw bytes rather than decoded into any.
//
// A map[string]any round-trip puts every number through float64, which silently
// mangles an integer past 2^53 and rewrites a high-precision literal. Both occur
// in real state: message timestamps and sampler values. The same decode would
// also HTML-escape every angle bracket in every message.
func TestPatchingPreservesNumericAndTextLiterals(t *testing.T) {
	sp := seed(t)
	tag := etagFor(t, sp, "alpha")
	rec := send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/alpha/append",
		body:    `[{"role":"user","content":"x"}]`,
		headers: map[string]string{"If-Match": tag},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("append: got %d, want 200", rec.Code)
	}

	stored := storedBytes(t, sp)
	for _, literal := range []string{
		`90071992547409911`,                    // would become 90071992547409920
		`0.1000000000000000055511151231257827`, // would become 0.1
		`"a <b> & c"`,                          // would become "a <b> & c"
	} {
		if !strings.Contains(string(stored), literal) {
			t.Errorf("literal %s did not survive the patch\nstored: %s", literal, stored)
		}
	}
}

// --- preconditions ---------------------------------------------------------

// Every mutating route must refuse to act without a stated intent. An
// unconditional write is the behaviour these routes exist to remove.
func TestMutationsRequireAPrecondition(t *testing.T) {
	sp := seed(t)
	for _, q := range []req{
		{method: http.MethodPut, target: "/state/threads/alpha", body: `{"id":"alpha","messages":[]}`},
		{method: http.MethodPut, target: "/state/threads/gamma", body: `{"id":"gamma","messages":[]}`},
		{method: http.MethodDelete, target: "/state/threads/alpha"},
		{method: http.MethodPost, target: "/state/threads/alpha/append", body: `[{"role":"user"}]`},
		{method: http.MethodPut, target: "/state/meta", body: `{"settings":{}}`},
	} {
		rec := send(t, sp, q)
		if rec.Code != http.StatusPreconditionRequired {
			t.Errorf("%s %s without a precondition: got %d, want 428",
				q.method, q.target, rec.Code)
		}
	}
	// Nothing may have been written.
	if n := len(readDoc(t, sp).threads); n != 2 {
		t.Errorf("document changed despite every request being refused: %d threads", n)
	}
}

func TestStaleVersionIsRefusedWithTheCurrentOne(t *testing.T) {
	sp := seed(t)
	stale := etagFor(t, sp, "alpha")

	// Somebody else moves the conversation on.
	rec := send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/alpha/append",
		body:    `[{"role":"user","content":"from the phone"}]`,
		headers: map[string]string{"If-Match": stale},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("first append: got %d, want 200", rec.Code)
	}
	fresh := rec.Header().Get("ETag")

	// The stale writer is refused, and told what it should have sent.
	rec = send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/alpha/append",
		body:    `[{"role":"user","content":"from the desktop"}]`,
		headers: map[string]string{"If-Match": stale},
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale append: got %d, want 412 (%s)", rec.Code, rec.Body)
	}
	got := body(t, rec)
	if got["etag"] != fresh {
		t.Errorf("412 body etag: got %v, want %v", got["etag"], fresh)
	}
	if got["messages"] != float64(2) {
		t.Errorf("412 body messages: got %v, want 2", got["messages"])
	}
	// The refused message must not have landed.
	if strings.Contains(string(readDoc(t, sp).threads[0]), "from the desktop") {
		t.Error("a refused append was written anyway")
	}
}

// The precondition is also what makes a retried append safe: replaying the
// same request cannot append twice, because the first one moved the version.
func TestReplayedAppendIsRefused(t *testing.T) {
	sp := seed(t)
	tag := etagFor(t, sp, "beta")
	q := req{
		method: http.MethodPost, target: "/state/threads/beta/append",
		body:    `[{"role":"user","content":"exactly once"}]`,
		headers: map[string]string{"If-Match": tag},
	}
	if rec := send(t, sp, q); rec.Code != http.StatusOK {
		t.Fatalf("first send: got %d, want 200", rec.Code)
	}
	if rec := send(t, sp, q); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("replay: got %d, want 412", rec.Code)
	}
	if n := messageCount(readDoc(t, sp).threads[1]); n != 3 {
		t.Errorf("messages after a replayed append: got %d, want 3", n)
	}
}

// Append must name the version it extends. "*" means "whatever is there",
// which is the blind write this route replaces.
func TestAppendRefusesWildcardPrecondition(t *testing.T) {
	sp := seed(t)
	rec := send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/alpha/append",
		body:    `[{"role":"user"}]`,
		headers: map[string]string{"If-Match": "*"},
	})
	if rec.Code != http.StatusPreconditionRequired {
		t.Errorf("append with If-Match: *: got %d, want 428", rec.Code)
	}
}

func TestCreateAndReplaceThread(t *testing.T) {
	sp := seed(t)

	// If-None-Match: * creates.
	rec := send(t, sp, req{
		method: http.MethodPut, target: "/state/threads/gamma",
		body:    `{"id":"gamma","name":"Gamma","messages":[]}`,
		headers: map[string]string{"If-None-Match": "*"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if n := len(readDoc(t, sp).threads); n != 3 {
		t.Fatalf("threads after create: got %d, want 3", n)
	}

	// The same request again must fail: it already exists.
	rec = send(t, sp, req{
		method: http.MethodPut, target: "/state/threads/gamma",
		body:    `{"id":"gamma","messages":[]}`,
		headers: map[string]string{"If-None-Match": "*"},
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Errorf("create over an existing thread: got %d, want 412", rec.Code)
	}

	// Replacing with the current version succeeds.
	tag := etagFor(t, sp, "gamma")
	rec = send(t, sp, req{
		method: http.MethodPut, target: "/state/threads/gamma",
		body:    `{"id":"gamma","name":"Renamed","messages":[]}`,
		headers: map[string]string{"If-Match": tag},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("replace: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(string(readDoc(t, sp).threads[2]), "Renamed") {
		t.Error("replacement did not take")
	}
}

// A body that names a different thread than the path is a confused client, not
// something to guess at.
func TestPutRefusesIdMismatch(t *testing.T) {
	sp := seed(t)
	rec := send(t, sp, req{
		method: http.MethodPut, target: "/state/threads/alpha",
		body:    `{"id":"beta","messages":[]}`,
		headers: map[string]string{"If-Match": "*"},
	})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("id mismatch: got %d, want 400", rec.Code)
	}
}

func TestDeleteThread(t *testing.T) {
	sp := seed(t)
	tag := etagFor(t, sp, "alpha")

	rec := send(t, sp, req{method: http.MethodDelete, target: "/state/threads/alpha",
		headers: map[string]string{"If-Match": tag}})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	d := readDoc(t, sp)
	if len(d.threads) != 1 {
		t.Fatalf("threads after delete: got %d, want 1", len(d.threads))
	}
	if id, _ := threadID(d.threads[0]); id != "beta" {
		t.Errorf("wrong thread survived: %s", id)
	}
	// Deleting it again is a 404, not a silent success: the caller is working
	// from a view of the world that no longer holds.
	rec = send(t, sp, req{method: http.MethodDelete, target: "/state/threads/alpha",
		headers: map[string]string{"If-Match": "*"}})
	if rec.Code != http.StatusPreconditionFailed {
		t.Errorf("delete of a missing thread: got %d, want 412", rec.Code)
	}
}

// --- append edge cases -----------------------------------------------------

func TestAppendRejectsNonArrayAndEmptyBodies(t *testing.T) {
	sp := seed(t)
	tag := etagFor(t, sp, "alpha")
	for _, b := range []string{`{"role":"user"}`, `[]`, `"a string"`} {
		rec := send(t, sp, req{
			method: http.MethodPost, target: "/state/threads/alpha/append",
			body: b, headers: map[string]string{"If-Match": tag},
		})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("append body %s: got %d, want 400", b, rec.Code)
		}
	}
}

func TestAppendDoesNotCreate(t *testing.T) {
	sp := seed(t)
	rec := send(t, sp, req{
		method: http.MethodPost, target: "/state/threads/nope/append",
		body: `[{"role":"user"}]`, headers: map[string]string{"If-Match": `"whatever"`},
	})
	if rec.Code != http.StatusPreconditionFailed {
		t.Errorf("append to a missing thread: got %d, want 412", rec.Code)
	}
}

// --- meta ------------------------------------------------------------------

func TestMetaExcludesThreadsBothWays(t *testing.T) {
	sp := seed(t)

	rec := send(t, sp, req{method: http.MethodGet, target: "/state/meta"})
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /state/meta: got %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "threads") {
		t.Errorf("meta included conversations: %s", rec.Body)
	}
	if _, ok := body(t, rec)["aKeyThisBuildHasNeverHeardOf"]; !ok {
		t.Error("meta dropped an unmodelled key")
	}
	tag := rec.Header().Get("ETag")

	// Writing threads through meta would be a second way to write the same
	// data, skipping every per-thread precondition.
	rec = send(t, sp, req{method: http.MethodPut, target: "/state/meta",
		body:    `{"settings":{},"threads":[]}`,
		headers: map[string]string{"If-Match": tag}})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("meta containing threads: got %d, want 400", rec.Code)
	}

	// A legitimate meta write leaves conversations alone.
	rec = send(t, sp, req{method: http.MethodPut, target: "/state/meta",
		body:    `{"settings":{"temperature":0.2}}`,
		headers: map[string]string{"If-Match": tag}})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /state/meta: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	d := readDoc(t, sp)
	if len(d.threads) != 2 {
		t.Errorf("threads after a meta write: got %d, want 2", len(d.threads))
	}
}

// --- concurrency -----------------------------------------------------------

// Read-modify-write without a lock loses writes: two requests patching
// different conversations both read the same document and the second write
// drops the first. That is the bug these routes remove, one layer down.
func TestConcurrentAppendsToDifferentThreadsAllLand(t *testing.T) {
	sp := statePath(t)
	const threads = 8
	const perThread = 12

	var doc strings.Builder
	doc.WriteString(`{"threads":[`)
	for i := range threads {
		if i > 0 {
			doc.WriteString(",")
		}
		fmt.Fprintf(&doc, `{"id":"t%d","messages":[]}`, i)
	}
	doc.WriteString(`]}`)
	if rec := send(t, sp, req{method: http.MethodPost, target: "/state", body: doc.String()}); rec.Code != http.StatusOK {
		t.Fatalf("seed: got %d", rec.Code)
	}

	var wg sync.WaitGroup
	for i := range threads {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("t%d", n)
			for range perThread {
				// Each worker re-reads its own version, the way a client does
				// after a successful write.
				tag := ""
				rec := send(t, sp, req{method: http.MethodGet, target: "/state/threads/" + id})
				if rec.Code == http.StatusOK {
					tag = rec.Header().Get("ETag")
				}
				send(t, sp, req{
					method: http.MethodPost, target: "/state/threads/" + id + "/append",
					body:    fmt.Sprintf(`[{"role":"user","content":"m%d"}]`, n),
					headers: map[string]string{"If-Match": tag},
				})
			}
		}(i)
	}
	wg.Wait()

	d := readDoc(t, sp)
	if len(d.threads) != threads {
		t.Fatalf("threads: got %d, want %d", len(d.threads), threads)
	}
	total := 0
	for _, th := range d.threads {
		n := messageCount(th)
		if n < 0 {
			t.Fatalf("thread lost its messages array: %s", th)
		}
		total += n
	}
	// Every append either succeeded or was refused with a 412; none may have
	// been overwritten by a concurrent patch to a different conversation.
	if total != threads*perThread {
		t.Errorf("messages across all threads: got %d, want %d -- a write was lost",
			total, threads*perThread)
	}
}

// --- profiles --------------------------------------------------------------

// The per-thread routes take the same selector as everything else, and must
// not reach across to the shared file.
func TestThreadRoutesHonourProfiles(t *testing.T) {
	sp := seed(t)

	rec := send(t, sp, req{
		method: http.MethodPut, target: "/state/threads/only-here?profile=phone",
		body:    `{"id":"only-here","messages":[]}`,
		headers: map[string]string{"If-None-Match": "*"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create in a profile: got %d, want 200 (%s)", rec.Code, rec.Body)
	}
	// The shared document is untouched.
	if len(readDoc(t, sp).threads) != 2 {
		t.Error("a profile write reached the shared file")
	}
	// And the profile has exactly the one thread.
	got := body(t, send(t, sp, req{method: http.MethodGet, target: "/state/index?profile=phone"}))
	if threads, _ := got["threads"].([]any); len(threads) != 1 {
		t.Errorf("profile index: got %d threads, want 1", len(threads))
	}
	// A bad profile name is still a 400, never a fall back to shared.
	rec = send(t, sp, req{method: http.MethodGet, target: "/state/index?profile=../escape"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad profile: got %d, want 400", rec.Code)
	}
}
