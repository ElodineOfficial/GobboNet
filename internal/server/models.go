package server

// GET /catalog.json, GET/POST /model-download — the settings panel's
// add-a-model modal.
//
// The download machinery here is not new. internal/modelfetch is the first-run
// wizard's downloader, lifted out of `package setup` unchanged so both callers
// share one implementation: the .part file, the atomic rename, the streaming
// SHA-256 against HuggingFace's LFS pointer, the size floor that catches an
// error page arriving as a clean 200. This file is the second caller, not a
// second downloader.
//
// The browser never talks to HuggingFace itself. It cannot write a 12 GB file
// into the model directory, a cross-origin fetch would need CORS on someone
// else's host, and routing through Go keeps the third-party origin out of the
// page. That last one is the same privacy posture the rest of the app takes.
//
// Nothing here invalidates the installed-model list, because nothing needs to:
// models.Info.scanCached keys on the model directory's mtime *and* its entry
// count, and renaming a .part into place changes both. The header dropdown
// picks the new model up on its next /models-list.json poll.
//
// These routes sit after the auth gate in ServeHTTP's switch, with everything
// else. That placement is load-bearing rather than incidental: this is the one
// route pair that writes files to disk and makes outbound requests, and
// GobboNet can be bound to the LAN. Unauthenticated, it would let any device
// that can reach the port fill the disk.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/httpx"
	"github.com/jmccardle/gobbonet/internal/modelfetch"
	"github.com/jmccardle/gobbonet/internal/supervisor"
	"github.com/jmccardle/gobbonet/internal/version"
)

// downloads owns the one-at-a-time download policy, carried over from the
// wizard. A second request while one is running reports the running one rather
// than starting another: two concurrent 16 GB transfers saturate the line and
// race each other for disk, and the modal has one progress bar.
type downloads struct {
	mu      sync.Mutex
	current *modelfetch.Download
}

func (d *downloads) status() modelfetch.Status {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.current == nil {
		return modelfetch.Status{State: "idle"}
	}
	return d.current.Status()
}

// running reports whether a download is in flight. Separate from begin so the
// caller can answer "one is already going" before spending work on checks whose
// answer that would make misleading.
func (d *downloads) running() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.current != nil && d.current.Status().State == "running"
}

// clear forgets a finished download. A running one is left alone, and reports
// so, because forgetting it would let a second start against the same .part.
//
// Without this the last download stayed "done" for the life of the process:
// every subsequent open of the modal was greeted by a finished transfer it had
// already been told about, and the client redrew the catalogue for it.
func (d *downloads) clear() (cleared bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.current != nil && d.current.Status().State == "running" {
		return false
	}
	d.current = nil
	return true
}

// begin starts a download unless one is already running. running reports which
// case happened, so the caller can tell the user it ignored their pick.
func (d *downloads) begin(e catalog.Entry, dir string) (running bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.current != nil && d.current.Status().State == "running" {
		return true
	}
	dl := modelfetch.New(e, dir)
	d.current = dl
	go dl.Run()
	return false
}

// catalogEntry is one model as the modal sees it.
//
// Deliberately not catalog.Entry itself: that carries Repo and File, which are
// the download target. The client submits an index and the server resolves it,
// so a crafted request cannot name an arbitrary URL to fetch or an arbitrary
// filename to write. File is included because the modal needs to tell whether a
// model is already installed, and it is compared against /models-list.json
// rather than used as a path.
type catalogEntry struct {
	Index     int     `json:"index"`
	Display   string  `json:"display"`
	File      string  `json:"file"`
	SizeGB    float64 `json:"sizeGB"`
	MinVRAM   int     `json:"minVRAM"`
	Ctx       int     `json:"ctx"`
	Installed bool    `json:"installed"`
}

func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}

	// The modal asks for this on every open. A model list is only useful if it
	// is the live one, and the user clicking Add a Model is the clearest
	// statement there is that they want it looked up now.
	if r.URL.Query().Get("refresh") == "1" {
		s.refreshCatalog()
	}

	cat, err := s.catalog()
	if err != nil {
		// 503 rather than 500: the server is fine, this one feature has no data
		// to work from. The modal shows the message and offers nothing to click,
		// which is the honest state of things.
		//
		// The notes go with it. "No catalogue available" alone tells a user
		// nothing they can act on; "the catalogue needs GobboNet 1.7.0 or newer
		// and this is 1.6" tells them exactly what happened.
		httpx.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]any{
			"error":  "The model catalogue is not available.",
			"detail": err.Error(),
			"notes":  s.catalogNotes(),
		})
		return
	}

	installed := map[string]bool{}
	for _, rec := range s.info.Installed() {
		installed[rec.File] = true
	}

	out := make([]catalogEntry, 0, len(cat.Entries))
	for _, e := range cat.Entries {
		out = append(out, catalogEntry{
			Index:     e.Index,
			Display:   e.Display,
			File:      e.File,
			SizeGB:    e.SizeGB,
			MinVRAM:   e.MinVRAM,
			Ctx:       e.Ctx,
			Installed: installed[e.File],
		})
	}

	// source and notes let the modal say where the list came from. A user
	// looking at a stale list needs to know it is the shipped one, not the
	// live one, and a bug report is much easier to act on with it stated.
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"models":    out,
		"default":   cat.Default,
		"freeGB":    float64(modelfetch.FreeBytes(s.modelDir())) / (1 << 30),
		"source":    cat.Source,
		"generated": cat.Generated,
		"notes":     s.catalogNotes(),
	})
}

type downloadRequest struct {
	Index int `json:"index"`
	// Clear asks to forget a finished download rather than start one. Sent when
	// the modal closes, so the next open shows a list instead of the last
	// transfer's result.
	Clear bool `json:"clear"`
}

func (s *Server) handleModelDownload(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		httpx.WriteJSON(w, r, http.StatusOK, s.downloads.status())
	case http.MethodPost:
		s.modelDownloadPost(w, r)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

func (s *Server) modelDownloadPost(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	var req downloadRequest
	if err := json.Unmarshal(body, &req); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "Body is not valid JSON.")
		return
	}

	// Answered before the catalogue is touched: closing the modal must not be
	// able to trigger a fetch, and clearing has to keep working when the
	// catalogue is the thing that is broken.
	if req.Clear {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"cleared": s.downloads.clear(),
			"status":  s.downloads.status(),
		})
		return
	}

	cat, err := s.catalog()
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusServiceUnavailable,
			"The model catalogue is not available.", err.Error())
		return
	}
	entry, ok := cat.Find(req.Index)
	if !ok {
		httpx.Error(w, r, http.StatusBadRequest, "That model is not in the catalogue.")
		return
	}

	dir := s.modelDir()

	// One-at-a-time before the disk check, deliberately. A download in flight is
	// both the cheaper question and the more relevant answer: while 16 GB is
	// landing, free space is falling, so asking about space first can refuse a
	// second click with a disk message when the true reason is that a download
	// is already running. begin() re-checks under its own lock, which is what
	// actually closes the race — this is about which message the user gets.
	if s.downloads.running() {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"started": false,
			"status":  s.downloads.status(),
		})
		return
	}

	// Free space before a byte moves, the wizard's reasoning verbatim: a 16 GB
	// download that dies at 15 costs far more of the user's evening than one
	// dialog does, and the failure arrives with no clue that space was the
	// problem. FreeBytes returning 0 means "could not tell", which is treated as
	// "do not block".
	need := int64(entry.SizeGB*float64(1<<30)) + (1 << 30) // + 1 GB headroom
	if free := modelfetch.FreeBytes(dir); free > 0 && free < need {
		httpx.Error(w, r, http.StatusBadRequest, fmt.Sprintf(
			"%s needs about %.1f GB and there is %.1f GB free on this disk. "+
				"Free some space, or pick a smaller model.",
			entry.Display, entry.SizeGB, float64(free)/(1<<30)))
		return
	}

	if running := s.downloads.begin(entry, dir); running {
		// Lost the race against another request between the check above and
		// here. Same answer, same shape.
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"started": false,
			"status":  s.downloads.status(),
		})
		return
	}

	// The model's ctx/kv are NOT recorded here. They used to be, and it was
	// wrong in three ways at once: the write landed at download *start*, so a
	// download that then failed still moved the settings; it applied the new
	// model's tuning to the model still running, so downloading a 22 GB entry
	// with ctx 8192 while chatting on a 32768 one silently shrank the running
	// window at the next restart; and it only ever touched the file, never
	// s.tuning or the supervisor, so the swap the modal offers respawned
	// llama-server on the PREVIOUS model's context size and KV type. Going the
	// other way -- a large model launched under a small model's generous
	// window -- exhausts VRAM, fails to load, and rolls back looking like a bad
	// download.
	//
	// applyCatalogTuning does this at swap time instead, where the model whose
	// tuning it is, is the model about to be launched. See handleSwapModel.

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"started": true,
		"status":  s.downloads.status(),
	})
}

// handleSwapModel applies the incoming model's published tuning, then hands the
// swap itself to the supervisor unchanged.
//
// The wrapper exists because ctx and kv belong to the model, and the only
// moment we know which model is about to be launched is here. Setting them
// before delegating is what makes it stick: Swap() dispatches a goroutine that
// calls start(), and start() reads Tuning() -- so a value published before the
// call is the one the new process gets, with no window to race.
//
// This helps every swap, not only one that follows a download. Picking a
// catalogue model out of the header dropdown launched it under whatever the
// previous model wanted, which was the same bug arriving by a different route.
func (s *Server) handleSwapModel(w http.ResponseWriter, r *http.Request) {
	h := supervisor.Handlers{Sup: s.sup}
	if r.Method != http.MethodPost || s.sup == nil {
		h.HandleSwapModel(w, r)
		return
	}

	// Read the body here and give it back, so the supervisor handler keeps
	// doing its own parsing and its own error messages. One reader, one set of
	// wire-format rules.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil {
		var req struct {
			File string `json:"file"`
		}
		if json.Unmarshal(body, &req) == nil && req.File != "" {
			s.applyCatalogTuning(req.File)
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	h.HandleSwapModel(w, r)
}

// applyCatalogTuning publishes the ctx/kv the catalogue lists for file, if it
// lists any.
//
// Only an ALREADY RESOLVED catalogue is consulted. Resolving one can mean a
// network fetch, and a five second timeout does not belong in front of a model
// swap -- a user who never opened the modal would pay for a lookup they did not
// ask for. Unresolved means this does nothing, which is what the code did
// before this existed.
func (s *Server) applyCatalogTuning(file string) {
	cat := s.resolvedCatalog()
	if cat == nil {
		return
	}
	var entry catalog.Entry
	found := false
	for _, e := range cat.Entries {
		if e.File == file {
			entry, found = e, true
			break
		}
	}
	if !found {
		return
	}

	ctx := entry.Ctx
	if ctx != 0 && (ctx < config.MinCtxSize || ctx > config.MaxCtxSize) {
		// A catalogue is editable on disk and fetched over the network. An
		// out-of-range window would be refused by SavePerf and rejected by the
		// panel, so it does not get a private door in here either.
		log.Printf("[catalog] ignoring ctx %d for %s: outside %d-%d",
			ctx, file, config.MinCtxSize, config.MaxCtxSize)
		ctx = 0
	}
	kv := entry.KV
	if kv != "" && !config.ValidKVCacheType(kv) {
		log.Printf("[catalog] ignoring kv_cache_type %q for %s", kv, file)
		kv = ""
	}
	if ctx == 0 && kv == "" {
		return
	}

	// writeMu, not just mu: this is the same read-modify-write /perf does, and
	// two of them interleaving would leave the files and memory describing
	// different settings.
	s.tuning.writeMu.Lock()
	defer s.tuning.writeMu.Unlock()

	// config.toml is the auto baseline -- what this model was measured for --
	// and the thing /perf's reset restores to. perf.toml, if the user wrote
	// one, still wins; setAuto reports that by declining to change what is in
	// force.
	if ctx != 0 {
		_ = config.Set(s.cfg.Path, "ctx_size", fmt.Sprint(ctx))
	}
	if kv != "" {
		_ = config.Set(s.cfg.Path, "kv_cache_type", kv)
	}

	inForce, changed := s.tuning.setAuto(ctx, kv)
	if !changed {
		log.Printf("[catalog] %s wants ctx=%d kv=%s; perf.toml is overriding, so it stays as set",
			entry.Display, entry.Ctx, entry.KV)
		return
	}
	if s.sup != nil {
		s.sup.SetTuning(inForce)
	}
	log.Printf("[catalog] %s launching with ctx=%d kv=%s", entry.Display, inForce.CtxSize, inForce.KVCacheType)
}

// resolvedCatalog returns the catalogue only if it is already in hand. Never
// fetches. See applyCatalogTuning for why that matters.
func (s *Server) resolvedCatalog() *catalog.Catalog {
	s.catMu.Lock()
	defer s.catMu.Unlock()
	return s.cat
}

// catalog resolves the download catalogue on first use and caches the result.
//
// The precedence is fresh remote -> cached remote -> bundled models.ini, and
// every step down it is a normal outcome rather than an error path. See
// internal/catalog/fetch.go for the privacy constraints on the fetch itself.
//
// Lazy rather than resolved in New for two reasons: a network call must not sit
// in the startup path, and a catalogue that cannot be resolved at all should
// disable one modal rather than prevent the server from starting. Chat works
// fine without a download list.
//
// Resolved once per process. The remote copy is cached on disk with its own
// age policy, so re-running this per request would buy nothing but latency.
func (s *Server) catalog() (*catalog.Catalog, error) {
	s.catMu.Lock()
	defer s.catMu.Unlock()
	if s.cat != nil || s.catErr != nil {
		return s.cat, s.catErr
	}

	force := s.catForce
	s.catForce = false

	cat, notes, err := catalog.Fetch(catalog.Options{
		URL:           s.cfg.ModelCatalogURL,
		Enabled:       s.cfg.ModelCatalogRemote,
		CacheDir:      s.cfg.DataDir,
		ClientVersion: version.String(),
		Force:         force,
	})
	// The notes say which source won and why the earlier ones did not. Logged
	// once, at resolution, because "where did this list come from" is the first
	// question any report about a wrong model list needs answered.
	for _, n := range notes {
		log.Printf("[catalog] %s", n)
	}
	// Held whatever happened. They used to be recorded only on success, which
	// dropped them in the one case that needs them: when every source failed,
	// the 503 carried the generic "no catalogue available" and the notes saying
	// WHY -- endpoint unreachable, client too old, no models.ini found -- went
	// to the log and nowhere the user could see.
	s.catNotes = notes

	if err != nil {
		s.catErr = err
		return nil, err
	}
	log.Printf("[catalog] %d models from the %s list", len(cat.Entries), cat.Source)
	s.cat = cat
	s.catSource = cat.Source
	return s.cat, nil
}

// refreshCatalog drops the memoised resolution so the next catalog() call goes
// looking again.
//
// The resolution is cached for the life of the process, which is right for a
// list that changes every few weeks but wrong for the case it kept producing:
// offline when the modal first opened, online a minute later, and still staring
// at the bundled list until GobboNet was restarted.
//
// It also arms a bypass of the fetch's own 24 hour disk cache, because opening
// the modal is an explicit ask for the live list. Not more than once a minute:
// four opens in a row on a dead network should cost one five second timeout,
// not four. The flag is set and consumed under catMu so two tabs refreshing at
// once cannot lose it or double it.
func (s *Server) refreshCatalog() {
	s.catMu.Lock()
	defer s.catMu.Unlock()
	s.cat, s.catErr, s.catNotes, s.catSource = nil, nil, nil, ""

	if now := time.Now(); now.Sub(s.catForced) >= forceInterval {
		s.catForced = now
		s.catForce = true
	}
}

// forceInterval is how often an explicit refresh may bypass the disk cache.
const forceInterval = time.Minute

func (s *Server) modelDir() string { return s.cfg.ModelDir }

// catalogNotes returns the provenance notes from the last resolution. Held
// separately from the catalogue so a fallback still explains itself.
func (s *Server) catalogNotes() []string {
	s.catMu.Lock()
	defer s.catMu.Unlock()
	if s.catNotes == nil {
		return []string{}
	}
	out := make([]string, len(s.catNotes))
	copy(out, s.catNotes)
	return out
}
