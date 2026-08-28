// Package state implements cross-device chat state sync. Port of Handle-State
// from fileserver.ps1.
//
// chat.html mirrors its state here so a phone landing on a fresh origin (new IP,
// new device, cleared cache) can be offered its threads back instead of showing
// an empty chat.
//
// Two routes, kept separate on purpose:
//
//	GET /state/info   metadata only (mtime + size) for the boot-time conflict
//	                  check. The full body can be multi-MB once threads pile up,
//	                  so the boot path must not pull it.
//	GET /state        the full body, once the client has decided to restore.
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
	"strconv"

	"github.com/jmccardle/gobbonet/internal/httpx"
)

// MaxBodyBytes caps a state upload. Generous — state is the user's entire chat
// history — but finite, so a runaway client can't fill the disk.
const MaxBodyBytes = 128 << 20 // 128 MiB

// Handle serves /state and /state/info.
func Handle(w http.ResponseWriter, r *http.Request, statePath string) {
	if r.URL.Path == "/state/info" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// Explicitly 405 rather than falling through to the write branch:
			// a POST here means the client is confused about which route it
			// wants, and silently accepting it would overwrite state.
			httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		serveInfo(w, r, statePath)
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		serveBody(w, r, statePath)
	case http.MethodPost, http.MethodPut:
		store(w, r, statePath)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
	}
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
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// mtimeMS is milliseconds since the Unix epoch, matching what the PowerShell
// (LastWriteTimeUtc) and Python (st_mtime * 1000) implementations sent. The
// client compares this against its own Date.now()-derived timestamps.
func mtimeMS(info os.FileInfo) int64 {
	return info.ModTime().UnixNano() / int64(1e6)
}
