package server

// Endorsed mods (1.7.9, F6): the list Elodine publishes, and installing from
// it. See internal/mods/endorsed.go for the list format and the checks.
//
//	GET  /mod-list.json[?refresh=1]   the list, each entry marked against what is installed
//	POST /mod-list/install {id}       download, check every pin, put it in place (this PC only)
//
// The list is fetched when the browse section of the MODS panel is opened,
// and held for ten minutes so reopening it costs nothing; refresh=1 fetches
// again. Installing is code that will run in every browser, so it is decided
// at the PC's keyboard, like everything else that adds or enables a mod.

import (
	"log"
	"net/http"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/mods"
	"github.com/ElodineOfficial/GobboNet/internal/version"
)

const modListHold = 10 * time.Minute

// modList returns the endorsed list, fetching it when it is older than
// modListHold or when force is set.
func (s *Server) modList(force bool) (*mods.List, []string, error) {
	s.modListMu.Lock()
	defer s.modListMu.Unlock()
	if !force && s.modListGot != nil && time.Since(s.modListAt) < modListHold && s.modListGot.URL == s.cfg.ModListURL {
		return s.modListGot, s.modListNotes, nil
	}
	l, notes, err := mods.FetchList(mods.FetchOptions{
		URL:           s.cfg.ModListURL,
		CacheDir:      s.cfg.DataDir,
		ClientVersion: version.String(),
		Client:        s.modHTTP,
	})
	for _, n := range notes {
		log.Printf("[mods] %s", n)
	}
	if err == nil && l != nil {
		s.modListGot, s.modListAt, s.modListNotes = l, time.Now(), notes
	}
	return l, notes, err
}

type modListRow struct {
	mods.ListEntry
	// State against this PC's mods folder: new, installed, update, taken (a
	// folder of that name that did not come from the list), problem.
	State     string `json:"state"`
	Installed string `json:"installed,omitempty"` // the version installed now
}

func (s *Server) handleModList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}
	resp := map[string]any{
		"url":       s.cfg.ModListURL,
		"canManage": fromThisPC(r),
		"page":      "https://goblincorps.com/gobbonet_extras",
		"mods":      []modListRow{},
	}
	if s.cfg.ModListURL == "" {
		resp["off"] = true
		resp["notes"] = []string{"The endorsed list is switched off: mod_list_url is empty in config.toml."}
		httpx.WriteJSON(w, r, http.StatusOK, resp)
		return
	}
	l, notes, err := s.modList(r.URL.Query().Get("refresh") == "1")
	if notes == nil {
		notes = []string{}
	}
	resp["notes"] = notes
	if err != nil {
		resp["error"] = "The endorsed list could not be reached, and there is no earlier copy on this PC. Mods you add by hand still work."
		httpx.WriteJSON(w, r, http.StatusOK, resp)
		return
	}
	store := s.modStore()
	rows := make([]modListRow, 0, len(l.Mods))
	for _, e := range l.Mods {
		row := modListRow{ListEntry: e}
		have, fromList := store.InstalledFrom(e.ID)
		switch {
		case e.Problem != "":
			row.State = "problem"
		case !fromList:
			row.State = "taken"
		case have == "":
			row.State = "new"
		case have == e.Version:
			row.State, row.Installed = "installed", have
		default:
			row.State, row.Installed = "update", have
		}
		rows = append(rows, row)
	}
	resp["mods"] = rows
	resp["source"] = l.Source
	resp["generated"] = l.Generated
	httpx.WriteJSON(w, r, http.StatusOK, resp)
}

func (s *Server) handleModInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if !mayManage(w, r) {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if !readJSON(w, r, &body, 4<<10) {
		return
	}
	if !mods.ValidID(body.ID) {
		httpx.Error(w, r, http.StatusBadRequest, "no such mod on the endorsed list")
		return
	}
	l, _, err := s.modList(false)
	if err != nil {
		httpx.Error(w, r, http.StatusBadGateway, "The endorsed list could not be reached, so nothing was installed.")
		return
	}
	e, ok := l.Find(body.ID)
	if !ok {
		httpx.Error(w, r, http.StatusNotFound, "no such mod on the endorsed list")
		return
	}
	res, err := s.modStore().Install(e, l.URL, s.modHTTP)
	if err != nil {
		log.Printf("[mods] did not install %s: %v", e.ID, err)
		httpx.Error(w, r, http.StatusBadGateway, err.Error())
		return
	}
	if res.Updated {
		log.Printf("[mods] updated %s from %s to %s (its switch kept: %v)", e.ID, res.From, e.Version, res.Enabled)
	} else {
		log.Printf("[mods] installed %s %s from the endorsed list, switched on", e.ID, e.Version)
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"id": e.ID, "version": e.Version, "updated": res.Updated, "from": res.From, "enabled": res.Enabled,
	})
}
