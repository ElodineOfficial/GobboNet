package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// /launch-settings (1.8.0, PR #58): what happens when GobboNet starts on the
// PC. One setting so far, open_browser, behind CONFIG > Basics.
//
// Any signed-in device may read and change it. It decides nothing but whether
// a browser tab opens on the PC, and cannot make anything run, so it does not
// need the this-PC-only rule the Config File editor and mods have. A page on
// another site still cannot flip it (sameOriginOrNone, as for LAN access).
//
// config.toml is the truth, not this process: the launchers -- gobbonet launch,
// launch.bat, gobbonet-launch -- read the file when they start, so GET reads
// the file too, and a POST that cannot write it fails rather than pretending.
// A change applies from the next start.
func (s *Server) handleLaunchSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"open_browser": s.launchOpenBrowser()})
	case http.MethodPost:
		s.launchSettingsPost(w, r)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

// launchOpenBrowser is open_browser as config.toml says it now. A file that
// cannot be read is answered with what the server started with.
func (s *Server) launchOpenBrowser() bool {
	if s.cfg.Path != "" {
		if cfg, err := config.Load(s.cfg.Path); err == nil {
			return cfg.OpenBrowser
		}
	}
	return s.cfg.OpenBrowser
}

func (s *Server) launchSettingsPost(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOrNone(r) {
		httpx.Error(w, r, http.StatusForbidden, "this setting can only be changed from GobboNet's own page")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	var in struct {
		OpenBrowser *bool `json:"open_browser"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "body must be JSON", err.Error())
		return
	}
	if in.OpenBrowser == nil {
		httpx.Error(w, r, http.StatusBadRequest, "open_browser is required (true or false)")
		return
	}
	if s.cfg.Path == "" {
		httpx.Error(w, r, http.StatusConflict, "this server was started without a config file, so there is nowhere to save it")
		return
	}
	if err := config.Set(s.cfg.Path, "open_browser", strconv.FormatBool(*in.OpenBrowser)); err != nil {
		log.Printf("[launch] could not save open_browser to %s: %v", s.cfg.Path, err)
		httpx.Error(w, r, http.StatusInternalServerError, "config.toml could not be written, so the setting was not changed")
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"open_browser": s.launchOpenBrowser()})
}
