// Package state implements cross-device chat state sync. Port of Handle-State
// from fileserver.ps1.
//
// chat.html mirrors its state here so a phone landing on a fresh origin (new IP,
// new device, cleared cache) can be offered its threads back instead of showing
// an empty chat.
//
// Routes, kept separate on purpose:
//
//	GET    /state/info       metadata only (mtime + size) for the boot-time
//	                         conflict check. The full body can be multi-MB once
//	                         threads pile up, so the boot path must not pull it.
//	GET    /state            the full body, once the client has decided to restore.
//	POST   /state            store a snapshot.
//	DELETE /state            remove a stored snapshot.
//	GET    /state/profiles   what is on the server, so a device can be pointed
//	                         at a slot without guessing what exists.
//
// # Profiles
//
// Every route above takes an optional ?profile= selector. Without one the
// request lands on the single shared state.json, which is what every existing
// install already does and what every existing client still sends -- so the
// default behaviour of this package is byte-for-byte what it was.
//
// With one, it lands on state-<name>.json beside it. That is the whole
// mechanism behind "make sharing between phone and computer optional": the
// reason the two were joined was never a design decision, it was that there
// was exactly one file. A phone pointed at its own profile still gets the
// thing sync exists for -- landing on a rotated IP with an empty localStorage
// and being handed its history back -- without also being handed the desktop's
// history.
//
// An unrecognised profile name is a 400, never a silent fall back to the
// shared file. Quietly writing the desktop's history into the slot the user
// separated would be the one unrecoverable outcome here, and a typo in a query
// string is not worth that risk.
//
// The /state/info branch was once missing, and the wildcard route sent it into
// the plain GET branch. The body parsed fine on the client but carried no
// top-level mtime or size, so checkServerStateOnBoot() silently treated the
// server as empty: auto-restore and the conflict prompt could never fire, and
// real data sat untouched on disk while the user stared at an empty chat.
//
// Three client decisions hang off these exact field names — auto-restore,
// quota-truncation recovery, and conflict detection — so the contract here is
// not negotiable. See the conformance tests.
package state

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// MaxBodyBytes caps a state upload. Generous — state is the user's entire chat
// history — but finite, so a runaway client can't fill the disk.
const MaxBodyBytes = 128 << 20 // 128 MiB

// profileRe is the entire allowlist for a profile name.
//
// Deliberately narrow, because this string becomes part of a filename. No dot
// means no "..", no slash or backslash means no escaping the data directory,
// and the 32-character cap keeps the result well inside every path limit. The
// name is lower-cased before matching so "Phone" and "phone" cannot become two
// profiles on Linux and one on Windows and macOS, which would look like data
// loss the first time someone moved a backup between machines.
//
// The Windows reserved device names (CON, NUL, COM1...) survive this pattern,
// and are harmless: the file is state-con.json, whose stem is "state-con", not
// "con". That safety comes from the prefix, so the prefix is not cosmetic.
var profileRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// profilePath maps ?profile= onto a file beside the shared one.
//
// An empty name is the shared state.json -- the default, and what every client
// written before profiles existed sends.
func profilePath(defaultPath, profile string) (string, bool) {
	name := strings.ToLower(strings.TrimSpace(profile))
	if name == "" {
		return defaultPath, true
	}
	if !profileRe.MatchString(name) {
		return "", false
	}
	dir := filepath.Dir(defaultPath)
	p := filepath.Join(dir, "state-"+name+".json")
	// Defence in depth. profileRe already makes this impossible, but the check
	// costs nothing and turns a future loosening of the pattern into a failed
	// request instead of a write outside the data directory.
	if filepath.Dir(p) != dir {
		return "", false
	}
	return p, true
}

// resolve pulls the profile out of the query and turns it into a path,
// answering the request itself if the name is not usable.
func resolve(w http.ResponseWriter, r *http.Request, defaultPath string) (string, bool) {
	path, ok := profilePath(defaultPath, r.URL.Query().Get("profile"))
	if !ok {
		httpx.Error(w, r, http.StatusBadRequest,
			"profile must be 1-32 characters of a-z, 0-9, _ or -, starting with a letter or digit")
		return "", false
	}
	return path, true
}

// Handle serves /state, /state/info and /state/profiles.
func Handle(w http.ResponseWriter, r *http.Request, statePath string) {
	switch r.URL.Path {
	case "/state/info":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// Explicitly 405 rather than falling through to the write branch:
			// a POST here means the client is confused about which route it
			// wants, and silently accepting it would overwrite state.
			httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		path, ok := resolve(w, r, statePath)
		if !ok {
			return
		}
		serveInfo(w, r, path)
		return

	case "/state/profiles":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		serveProfiles(w, r, statePath)
		return
	}

	path, ok := resolve(w, r, statePath)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		serveBody(w, r, path)
	case http.MethodPost, http.MethodPut:
		store(w, r, path)
	case http.MethodDelete:
		remove(w, r, path)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// serveProfiles lists what is actually on disk.
//
// Without this the client would have to remember every slot it has ever used,
// which is exactly the state that goes stale -- a profile created on the phone
// would be invisible from the desktop, and the only way to reach it would be
// to type its name from memory.
//
// The shared file is reported with an empty name and shared:true rather than
// being called "shared", so that a user who names a profile "shared" does not
// end up with two indistinguishable rows.
func serveProfiles(w http.ResponseWriter, r *http.Request, defaultPath string) {
	type profile struct {
		Name   string `json:"name"`
		Shared bool   `json:"shared"`
		Mtime  int64  `json:"mtime"`
		Size   int64  `json:"size"`
	}
	out := []profile{}

	if info, err := os.Stat(defaultPath); err == nil && info.Mode().IsRegular() {
		out = append(out, profile{Shared: true, Mtime: mtimeMS(info), Size: info.Size()})
	}

	dir := filepath.Dir(defaultPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		// A missing data directory means nothing has ever been stored, which is
		// an empty list rather than an error -- a first boot should not look
		// like a broken server.
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"profiles": out})
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		// Prefix and suffix are checked before trimming, not inferred from
		// whether trimming changed anything. TrimPrefix is a no-op when the
		// prefix is absent, so "did it change?" silently accepts state.json
		// itself (as a profile called "state") and notstate-phone.json (as
		// "notstate-phone"). Both showed up the first time this ran.
		fn := e.Name()
		if !strings.HasPrefix(fn, "state-") || !strings.HasSuffix(fn, ".json") {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(fn, "state-"), ".json")
		if !profileRe.MatchString(name) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, profile{Name: name, Mtime: mtimeMS(info), Size: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Shared != out[j].Shared {
			return out[i].Shared
		}
		return out[i].Name < out[j].Name
	})
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"profiles": out})
}

// remove deletes a stored snapshot. Deleting one that is not there is a
// success, not a 404: the caller asked for it to be gone, and it is.
func remove(w http.ResponseWriter, r *http.Request, statePath string) {
	if err := os.Remove(statePath); err != nil && !os.IsNotExist(err) {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "delete failed", err.Error())
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"status": "ok"})
}

func serveInfo(w http.ResponseWriter, r *http.Request, statePath string) {
	info, err := os.Stat(statePath)
	if err != nil || !info.Mode().IsRegular() {
		httpx.Error(w, r, http.StatusNotFound, "no state on server")
		return
	}
	mtime := mtimeMS(info)
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtime, 10))
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"mtime": mtime,
		"size":  info.Size(),
	})
}

func serveBody(w http.ResponseWriter, r *http.Request, statePath string) {
	info, err := os.Stat(statePath)
	if err != nil || !info.Mode().IsRegular() {
		httpx.Error(w, r, http.StatusNotFound, "no state on server")
		return
	}
	body, err := os.ReadFile(statePath)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	// Stat before the read, so the header can never advertise an mtime newer
	// than the bytes actually sent.
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtimeMS(info), 10))
	httpx.WriteBytes(w, r, http.StatusOK, "application/json; charset=utf-8", body)
}

func store(w http.ResponseWriter, r *http.Request, statePath string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	if len(body) > MaxBodyBytes {
		httpx.Error(w, r, http.StatusRequestEntityTooLarge, "state too large")
		return
	}
	// Validate before persisting. Writing a body that doesn't parse would leave
	// the client unable to restore and unable to tell why.
	if !json.Valid(body) {
		httpx.Error(w, r, http.StatusBadRequest, "body is not valid JSON")
		return
	}
	if err := writeAtomic(statePath, body); err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "write failed", err.Error())
		return
	}

	info, err := os.Stat(statePath)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "stat after write failed", err.Error())
		return
	}
	mtime := mtimeMS(info)
	w.Header().Set("X-State-Mtime", strconv.FormatInt(mtime, 10))
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"status": "ok",
		"mtime":  mtime,
	})
}

// writeAtomic writes via a temp file in the same directory, then renames. A
// crash mid-write leaves the previous state intact rather than a truncated file
// the client would restore from.
func writeAtomic(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(path, body, 0o600)
}

// mtimeMS is milliseconds since the Unix epoch, matching what the PowerShell
// (LastWriteTimeUtc) and Python (st_mtime * 1000) implementations sent. The
// client compares this against its own Date.now()-derived timestamps.
func mtimeMS(info os.FileInfo) int64 {
	return info.ModTime().UnixNano() / int64(1e6)
}
