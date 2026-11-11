package server

// Mods (1.7.9, F1): named units of CSS and JavaScript kept on this PC, each
// with its own switch. See internal/mods for the layout and the reasoning.
//
//	GET    /mods                         the list, in load order
//	GET    /mods/<id>/files/<path>       a file the mod lists (the page loads these)
//	GET    /mods/<id>/source             an editor-managed mod's content
//	PUT    /mods/<id>/source             save it            (this PC only)
//	POST   /mods/<id>/enable {enabled}   switch on (this PC only) or off (any device)
//	POST   /mods/<id>/entry-enable {kind, index, enabled}
//	                                     one My extensions entry: on (this PC only) or off (any device)
//	POST   /mods/<id>/move {delta}       load earlier/later (this PC only)
//	DELETE /mods/<id>                    remove, UNDO-able   (this PC only)
//	POST   /mods/<id>/restore            the UNDO           (this PC only)
//	POST   /mods/import-legacy           the old extensions blob -> My extensions (this PC only)
//
// All of it sits behind the auth gate. "This PC only" is the same test the
// config.toml editor uses (fromThisPC): a browser on the machine GobboNet runs
// on, reaching it at a loopback address, with no proxy headers. Anything that
// can make code run in every browser -- writing it, switching it or one of its
// entries on, ordering it -- is decided at that keyboard. A phone on the LAN
// can read the list and switch a mod or an entry off, which is never the
// dangerous direction.
//
// "This PC" is not enough on its own (1.8.0): another website open in a
// browser on this PC is also on this PC. With a password, its request carries
// no session cookie (SameSite=Lax) and stops at the auth gate; an install with
// no password has no gate, so every write that can make code run also checks
// that the request came from GobboNet's own page (sameOriginStrict, as the
// config.toml editor does). curl and other tools send no Origin and pass.

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/mods"
)

// modStore is one Store per server, so its lock covers every request: two
// tabs switching mods at once, or an install finishing while a switch is
// flipped, cannot lose each other's write to mods-state.json.
func (s *Server) modStore() *mods.Store {
	s.modsOnce.Do(func() { s.mods = mods.Open(filepath.Join(s.cfg.DataDir, "mods")) })
	return s.mods
}

const notOnThisPC = "Mods are managed from GobboNet on the PC it runs on. Open it there " +
	"(at http://localhost) to add, change or switch on a mod; from here you can switch one off."

const notOurPage = "Mods can only be changed from GobboNet's own page, not from another website."

// mayManage is the test for every mods request that can make code run: a
// browser on this PC, on GobboNet's own page. It answers the request itself
// when the answer is no.
func mayManage(w http.ResponseWriter, r *http.Request) bool {
	if !fromThisPC(r) {
		httpx.Error(w, r, http.StatusForbidden, notOnThisPC)
		return false
	}
	if !sameOriginStrict(r, false) {
		httpx.Error(w, r, http.StatusForbidden, notOurPage)
		return false
	}
	return true
}

func (s *Server) handleMods(w http.ResponseWriter, r *http.Request, path string) {
	store := s.modStore()
	rest := strings.TrimPrefix(strings.TrimPrefix(path, "/mods"), "/")

	if rest == "" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
			return
		}
		list := store.List()
		if list == nil {
			list = []mods.Mod{}
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"mods":      list,
			"canManage": fromThisPC(r),
			"dir":       store.Dir(),
		})
		return
	}

	if rest == "import-legacy" {
		s.modsImportLegacy(w, r, store)
		return
	}

	id, tail, _ := strings.Cut(rest, "/")
	if !mods.ValidID(id) {
		httpx.Error(w, r, http.StatusNotFound, "no such mod")
		return
	}
	switch {
	case strings.HasPrefix(tail, "files/"):
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
			return
		}
		full, err := store.File(id, strings.TrimPrefix(tail, "files/"))
		if err != nil {
			httpx.Error(w, r, http.StatusNotFound, "not found")
			return
		}
		body, err := os.ReadFile(full)
		if err != nil {
			httpx.Error(w, r, http.StatusNotFound, "not found")
			return
		}
		httpx.WriteBytes(w, r, http.StatusOK, httpx.MimeType(full), body)

	case tail == "source":
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			src, err := store.Source(id)
			if err != nil {
				httpx.Error(w, r, http.StatusNotFound, "no such mod")
				return
			}
			httpx.WriteJSON(w, r, http.StatusOK, src)
		case http.MethodPut:
			if !mayManage(w, r) {
				return
			}
			var body struct {
				mods.Source
				Enabled *bool `json:"enabled"`
			}
			if !readJSON(w, r, &body, 8<<20) {
				return
			}
			if err := store.WriteSource(id, body.Source, "", body.Enabled); err != nil {
				code := http.StatusBadRequest
				if errors.Is(err, mods.ErrNotEditable) {
					code = http.StatusConflict
				}
				httpx.Error(w, r, code, err.Error())
				return
			}
			log.Printf("[mods] saved %s", id)
			m, _ := store.Get(id)
			httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"saved": true, "mod": m})
		default:
			httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or PUT only")
		}

	case tail == "enable":
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if !readJSON(w, r, &body, 4<<10) {
			return
		}
		if body.Enabled && !mayManage(w, r) {
			return
		}
		if err := store.SetEnabled(id, body.Enabled); err != nil {
			code := http.StatusBadRequest
			if errors.Is(err, mods.ErrNotFound) {
				code = http.StatusNotFound
			}
			httpx.Error(w, r, code, err.Error())
			return
		}
		log.Printf("[mods] %s switched %s", id, map[bool]string{true: "on", false: "off"}[body.Enabled])
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"id": id, "enabled": body.Enabled})

	case tail == "entry-enable":
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
			return
		}
		var body struct {
			Kind    string `json:"kind"`
			Index   int    `json:"index"`
			Enabled bool   `json:"enabled"`
		}
		if !readJSON(w, r, &body, 4<<10) {
			return
		}
		if body.Enabled && !mayManage(w, r) {
			return
		}
		if err := store.SetEntryEnabled(id, body.Kind, body.Index, body.Enabled); err != nil {
			code := http.StatusBadRequest
			if errors.Is(err, mods.ErrNotFound) {
				code = http.StatusNotFound
			}
			httpx.Error(w, r, code, err.Error())
			return
		}
		log.Printf("[mods] %s %s entry %d switched %s", id, body.Kind, body.Index+1, map[bool]string{true: "on", false: "off"}[body.Enabled])
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"id": id, "kind": body.Kind, "index": body.Index, "enabled": body.Enabled})

	case tail == "move":
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
			return
		}
		if !mayManage(w, r) {
			return
		}
		var body struct {
			Delta int `json:"delta"`
		}
		if !readJSON(w, r, &body, 4<<10) {
			return
		}
		if err := store.Move(id, body.Delta); err != nil {
			httpx.Error(w, r, http.StatusNotFound, err.Error())
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"moved": true})

	case tail == "restore":
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
			return
		}
		if !mayManage(w, r) {
			return
		}
		if err := store.Restore(id); err != nil {
			httpx.Error(w, r, http.StatusConflict, err.Error())
			return
		}
		log.Printf("[mods] put %s back", id)
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"restored": true})

	case tail == "":
		if r.Method != http.MethodDelete {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "DELETE only")
			return
		}
		if !mayManage(w, r) {
			return
		}
		if err := store.Remove(id); err != nil {
			httpx.Error(w, r, http.StatusNotFound, err.Error())
			return
		}
		log.Printf("[mods] removed %s (UNDO-able until GobboNet restarts)", id)
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"removed": true})

	default:
		httpx.Error(w, r, http.StatusNotFound, "not found")
	}
}

// modsImportLegacy turns the pre-1.7.9 extensions blob (state.extensions,
// sent by the page that holds it) into My extensions. Its on/off is kept:
// the blob in a browser's own storage was switched on by that browser's user,
// because anything arriving by restore or import is switched off first
// (neutralizeUntrustedCode in js/23-card-code.js).
func (s *Server) modsImportLegacy(w http.ResponseWriter, r *http.Request, store *mods.Store) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if !mayManage(w, r) {
		return
	}
	var body struct {
		Enabled bool         `json:"enabled"`
		Styles  []mods.Entry `json:"styles"`
		Scripts []mods.Entry `json:"scripts"`
	}
	if !readJSON(w, r, &body, 8<<20) {
		return
	}
	id, created, err := store.ImportLegacy(mods.Source{Styles: body.Styles, Scripts: body.Scripts}, body.Enabled)
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if created {
		log.Printf("[mods] moved the old extensions into the mod %q (%s)", id,
			map[bool]string{true: "switched on, as they were", false: "switched off, as they were"}[body.Enabled])
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"id": id, "created": created})
}

// readJSON decodes a bounded JSON body, answering 400 itself on failure.
func readJSON(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	b, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		httpx.Error(w, r, http.StatusBadRequest, "body too large or unreadable")
		return false
	}
	if err := json.Unmarshal(b, v); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "body is not valid JSON")
		return false
	}
	return true
}
