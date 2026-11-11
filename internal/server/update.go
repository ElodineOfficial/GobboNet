package server

// The update button (1.8.0): ABOUT > CHECK FOR UPDATES, then UPDATE NOW and
// RESTART NOW. Finding, checking and installing a release is
// internal/update; this is who may ask, and the one install at a time.
//
// WHO MAY DO WHAT.
//
//   - Checking: any signed-in device, from GobboNet's own page. It costs a
//     request to GitHub and changes nothing. Same-origin because
//     CommonHeaders' CORS "*" would otherwise let any website read what
//     version this is.
//   - Installing and restarting: a browser on this PC, on GobboNet's own page
//     -- config.toml's rule (configfile.go), for the same reason: this
//     decides which program runs. A call must carry an Origin that is this
//     server, so no other website can start one, even on an install with no
//     password. And what it installs is only ever a release signed with a
//     key built into this program (internal/update), never a file a request
//     names.
//
// Nothing here runs on its own. The release list is asked for when the button
// is pressed and at no other time, which is what PRIVATE BY DESIGN in ABOUT
// promises.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/update"
)

const (
	// updateCheckFresh is how long one check answers every press of the
	// button. GitHub allows 60 unauthenticated requests an hour per address.
	updateCheckFresh = time.Minute
	// updateOfferFresh is how long an offer can be installed without asking
	// GitHub again: long enough to read the notes and confirm.
	updateOfferFresh = 30 * time.Minute
	updateCheckWait  = 45 * time.Second
	updateErrorFresh = 5 * time.Second
)

const (
	updateNotOnThisPC = "Updates are installed from GobboNet on the PC it runs on (at http://localhost). From here you can check for one."
	updateNotOurPage  = "Updates can only be checked and installed from GobboNet's own page, not from another website."
)

// updater is the update button's state: the last check, and the install.
type updater struct {
	place update.Place
	// newChecker builds the checker for a check; replaced in tests.
	newChecker func() *update.Checker
	// newInstaller likewise.
	newInstaller func() *update.Installer
	current      func() update.Build

	checkMu sync.Mutex // one check at a time
	mu      sync.Mutex
	last    *update.Result
	lastErr error
	lastAt  time.Time

	state     string // "", downloading, checking, installing, installed, failed
	done      int64
	total     int64
	failure   string
	installed *update.Installed
	target    update.Build
	cancel    context.CancelFunc

	restart func()
}

func newUpdater(dataDir, releasesURL string) *updater {
	u := &updater{place: update.Locate(), current: update.Current}
	u.newChecker = func() *update.Checker {
		return &update.Checker{ReleasesURL: releasesURL, Keys: update.TrustedKeys()}
	}
	u.newInstaller = func() *update.Installer {
		client, _ := update.NewClient(releasesURL)
		return &update.Installer{Client: client, WorkDir: filepath.Join(dataDir, "update")}
	}
	return u
}

// UpdatePlace is where this install's program is, for the restart and for
// clearing what an earlier update left behind (cmd/gobbonet).
func (s *Server) UpdatePlace() update.Place { return s.upd.place }

// SetRestart gives the server the way to restart into an installed update.
// Without one, RESTART NOW says to restart GobboNet by hand.
func (s *Server) SetRestart(fn func()) {
	s.upd.mu.Lock()
	s.upd.restart = fn
	s.upd.mu.Unlock()
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request, path string) {
	switch path {
	case "/update/check":
		s.handleUpdateCheck(w, r)
	case "/update/status":
		s.handleUpdateStatus(w, r)
	case "/update/install":
		s.handleUpdateInstall(w, r)
	case "/update/restart":
		s.handleUpdateRestart(w, r)
	default:
		httpx.Error(w, r, http.StatusNotFound, "not found")
	}
}

// check answers from the last check while it is fresh, and asks again
// otherwise. Concurrent presses share one request.
func (u *updater) check(ctx context.Context, fresh time.Duration) (*update.Result, error) {
	u.checkMu.Lock()
	defer u.checkMu.Unlock()
	u.mu.Lock()
	// A failure is kept only a moment, so that TRY AGAIN tries again.
	if u.lastErr != nil && fresh > updateErrorFresh {
		fresh = updateErrorFresh
	}
	if u.last != nil && time.Since(u.lastAt) < fresh {
		res, err := u.last, u.lastErr
		u.mu.Unlock()
		return res, err
	}
	u.mu.Unlock()

	cur := u.current()
	ctx, cancel := context.WithTimeout(ctx, updateCheckWait)
	defer cancel()
	res, err := u.newChecker().Check(ctx, cur, u.place.Target)
	if err != nil {
		log.Printf("update: check failed: %v", err)
	}
	u.mu.Lock()
	u.last, u.lastErr, u.lastAt = res, err, time.Now()
	u.mu.Unlock()
	return res, err
}

// GET /update/check: is there a newer build, and can it be installed here.
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}
	if !sameOriginStrict(r, false) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOurPage)
		return
	}
	u := s.upd
	cur := u.current()
	hasKey := len(u.newChecker().Keys) > 0
	body := map[string]any{
		"current":       cur,
		"on_this_pc":    fromThisPC(r),
		"install":       map[string]any{"kind": u.place.Kind, "target": u.place.Target, "reason": u.place.Reason, "can_install": u.place.CanInstall()},
		"signing_key":   hasKey,
		"releases_page": update.ReleasesPage,
		"notes":         []string{},
		"progress":      u.progress(),
	}
	switch {
	case s.cfg.UpdateReleasesURL == "":
		body["status"] = "off"
		body["error"] = update.ErrOff.Error()
		httpx.WriteJSON(w, r, http.StatusOK, body)
		return
	case !cur.Updatable():
		// Nothing to compare an unstamped build with, so nothing is asked.
		body["status"] = "dev"
		httpx.WriteJSON(w, r, http.StatusOK, body)
		return
	}

	res, err := u.check(r.Context(), updateCheckFresh)
	if res != nil {
		if len(res.Notes) > 0 {
			body["notes"] = res.Notes
		}
		body["checked_at"] = res.Checked.UTC().Format(time.RFC3339)
	}
	switch {
	case err != nil:
		body["status"] = "error"
		body["error"] = err.Error()
	case !hasKey:
		body["status"] = "unverifiable"
		if res.NewestTag != "" {
			body["newest"] = map[string]any{"tag": res.NewestTag, "page_url": res.NewestPage}
		}
	case res.Offer == nil:
		body["status"] = "current"
	default:
		o := res.Offer
		offer := map[string]any{
			"version":     o.Manifest.Version,
			"build":       o.Manifest.Build,
			"serial":      o.Manifest.Serial,
			"hotfix":      update.Hotfix(cur, o.Manifest.Of()),
			"published":   o.Manifest.Published,
			"notes":       o.Manifest.Notes,
			"notes_url":   o.Manifest.NotesURL,
			"page_url":    o.PageURL,
			"tag":         o.Tag,
			"installable": o.TargetKey != "" && u.place.CanInstall(),
		}
		if o.TargetKey != "" {
			offer["size"] = o.Target.Size
		}
		body["offer"] = offer
		switch {
		case o.TargetKey != "" && u.place.CanInstall():
			body["status"] = "available"
		case !u.place.CanInstall():
			body["status"] = "manual"
			body["reason"] = u.place.Reason
		default:
			body["status"] = "manual"
			body["reason"] = "This release has no download that updates this copy of GobboNet (" + u.place.Target + "). Get it from the release page."
		}
	}
	httpx.WriteJSON(w, r, http.StatusOK, body)
}

// progress is the install's state, for the page.
func (u *updater) progress() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := map[string]any{"state": u.state, "done": u.done, "total": u.total}
	if u.failure != "" {
		out["error"] = u.failure
	}
	if u.state != "" {
		out["build"] = u.target.Build
		out["version"] = u.target.Version
	}
	out["can_restart"] = u.installed != nil && u.restart != nil
	return out
}

// GET /update/status: how the install is going.
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}
	if !sameOriginStrict(r, false) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOurPage)
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, s.upd.progress())
}

type updateInstallRequest struct {
	Build  string `json:"build"`
	Serial int64  `json:"serial"`
}

// POST /update/install {build, serial}: install the build the page offered
// and the person confirmed. The two fields only say WHICH offer was
// confirmed; what is downloaded comes from the signed update file.
func (s *Server) handleUpdateInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if !sameOriginStrict(r, true) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOurPage)
		return
	}
	if !fromThisPC(r) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOnThisPC)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<10))
	var in updateInstallRequest
	if err != nil || json.Unmarshal(raw, &in) != nil || in.Build == "" {
		httpx.Error(w, r, http.StatusBadRequest, "Say which build to install.")
		return
	}
	u := s.upd
	if !u.place.CanInstall() {
		httpx.Error(w, r, http.StatusConflict, u.place.Reason)
		return
	}
	u.mu.Lock()
	busy, done := u.state == update.StageDownloading || u.state == update.StageChecking || u.state == update.StageInstalling, u.installed != nil
	u.mu.Unlock()
	if busy {
		httpx.Error(w, r, http.StatusConflict, "An update is already being installed.")
		return
	}
	if done {
		httpx.Error(w, r, http.StatusConflict, "An update is installed and waiting: restart GobboNet to finish it.")
		return
	}

	res, err := u.check(r.Context(), updateOfferFresh)
	if err != nil {
		httpx.Error(w, r, http.StatusBadGateway, err.Error())
		return
	}
	if res == nil || res.Offer == nil || res.Offer.TargetKey == "" ||
		res.Offer.Manifest.Build != in.Build || res.Offer.Manifest.Serial != in.Serial {
		httpx.Error(w, r, http.StatusConflict, "That update is no longer the one on offer. Press CHECK FOR UPDATES again.")
		return
	}
	// Checked again here rather than trusted from the check: the rule is the
	// point of the feature.
	if !update.Newer(u.current(), res.Offer.Manifest.Of()) {
		httpx.Error(w, r, http.StatusConflict, "That build is not newer than this one.")
		return
	}

	offer := res.Offer
	ctx, cancel := context.WithCancel(context.Background())
	u.mu.Lock()
	u.state, u.done, u.total, u.failure = update.StageDownloading, 0, offer.Target.Size, ""
	u.target = offer.Manifest.Of()
	u.cancel = cancel
	u.mu.Unlock()

	inst := u.newInstaller()
	inst.Progress = func(stage string, done, total int64) {
		u.mu.Lock()
		u.state, u.done, u.total = stage, done, total
		u.mu.Unlock()
	}
	log.Printf("update: installing %s (serial %d) from %s", offer.Manifest.Build, offer.Manifest.Serial, offer.Tag)
	go func() {
		defer cancel()
		got, err := inst.Install(ctx, offer, u.place)
		u.mu.Lock()
		defer u.mu.Unlock()
		if err != nil {
			log.Printf("update: install failed: %v", err)
			u.state, u.failure = "failed", err.Error()
			return
		}
		log.Printf("update: installed %s; the program it replaced is at %s until the next start", got.Build.Build, got.Old)
		u.state, u.installed = "installed", got
		u.done = u.total
	}()
	httpx.WriteJSON(w, r, http.StatusAccepted, u.progress())
}

// POST /update/restart: start the installed update in place of this one.
func (s *Server) handleUpdateRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if !sameOriginStrict(r, true) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOurPage)
		return
	}
	if !fromThisPC(r) {
		httpx.Error(w, r, http.StatusForbidden, updateNotOnThisPC)
		return
	}
	u := s.upd
	u.mu.Lock()
	installed, restart := u.installed, u.restart
	u.mu.Unlock()
	switch {
	case installed == nil:
		httpx.Error(w, r, http.StatusConflict, "No update has been installed since GobboNet started.")
		return
	case restart == nil:
		httpx.Error(w, r, http.StatusConflict, "Close GobboNet and start it again to finish the update.")
		return
	}
	httpx.WriteJSON(w, r, http.StatusAccepted, map[string]any{"restarting": true, "build": installed.Build.Build})
	// After the answer has gone out: the restart closes this connection.
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		restart()
	}()
}

// stop cancels an install that is still downloading.
func (u *updater) stop() {
	u.mu.Lock()
	cancel := u.cancel
	u.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
