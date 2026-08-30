package server

// GET/POST /perf — the settings panel's performance section.
//
// Port of fileserver.ps1's Handle-Perf. The wire shape is upstream's, verbatim
// and camelCase, because js/02-model.js reads p.current.ctxSize, p.auto,
// p.overridden and p.modelMaxCtx by name and the same file has to drive both
// servers.
//
// What this endpoint does NOT do is restart llama-server. The client saves
// here and then posts the model it already has to /swap-model, so the change
// rides the existing hot-swap path — one lock, one status feed, one thing to
// debug — instead of a second restart mechanism racing the first.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/httpx"
	"github.com/jmccardle/gobbonet/internal/supervisor"
)

// tuning holds the live launch arguments and the baseline to reset to.
//
// The server owns this rather than reading it off cfg each time because a POST
// changes it, and /active-model.json has to report the context size that is
// actually in force — not the one the file said at startup.
type tuning struct {
	// writeMu serialises the whole read-modify-write of a POST. Without it two
	// concurrent saves can interleave between reading the current values and
	// publishing the new ones, leaving perf.toml and memory describing
	// different settings — and the file is the one that survives a restart, so
	// the disagreement outlives the request that caused it. Separate from mu so
	// a GET is never blocked behind a disk write.
	writeMu sync.Mutex

	mu      sync.RWMutex
	current supervisor.Tuning
	auto    supervisor.Tuning
	// overridden mirrors "perf.toml exists". Kept alongside rather than
	// re-stat-ing the file per request: this is the authority on what is in
	// force, and the file is only ever written through here.
	overridden bool
	path       string
}

func newTuning(cfg config.Config) *tuning {
	return &tuning{
		current:    supervisor.Tuning{CtxSize: cfg.CtxSize, GPULayers: cfg.GPULayers, KVCacheType: cfg.KVCacheType},
		auto:       supervisor.Tuning{CtxSize: cfg.AutoCtxSize, GPULayers: cfg.AutoGPULayers, KVCacheType: cfg.AutoKVCacheType},
		overridden: cfg.PerfOverridden,
		path:       config.PerfPath(cfg.Path),
	}
}

func (t *tuning) get() (current, auto supervisor.Tuning, overridden bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.current, t.auto, t.overridden
}

// CtxSize is the context window in force, for /active-model.json.
func (t *tuning) CtxSize() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.current.CtxSize
}

// setAuto moves the baseline, and puts it in force unless perf.toml is
// overriding. Zero ctxSize and empty kv mean "no opinion", and leave that field
// alone.
//
// This is the layer a catalogue entry's ctx/kv belongs in. config.toml is what
// the hardware probe decided for the model being run, perf.toml is what the
// user asked for instead, and a model's published tuning is the former: it
// should move the baseline that "reset to automatic" restores, and it must not
// silently discard a setting the user typed in the panel.
//
// GPULayers is deliberately untouched. The catalogue has no opinion on it and
// the probe's answer is about the card, not the model.
//
// Reports whether the values in force changed, so the caller knows whether the
// supervisor needs telling.
func (t *tuning) setAuto(ctxSize int, kv string) (supervisor.Tuning, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if ctxSize > 0 {
		t.auto.CtxSize = ctxSize
	}
	if kv != "" {
		t.auto.KVCacheType = kv
	}
	if t.overridden {
		return t.current, false
	}

	before := t.current
	if ctxSize > 0 {
		t.current.CtxSize = ctxSize
	}
	if kv != "" {
		t.current.KVCacheType = kv
	}
	return t.current, t.current != before
}

// perfTriple is the {ctxSize, gpuLayers, kvCacheType} object upstream sends.
type perfTriple struct {
	CtxSize     int    `json:"ctxSize"`
	GPULayers   int    `json:"gpuLayers"`
	KVCacheType string `json:"kvCacheType"`
}

func triple(t supervisor.Tuning) perfTriple {
	return perfTriple{CtxSize: t.CtxSize, GPULayers: t.GPULayers, KVCacheType: t.KVCacheType}
}

// perfRequest is the POST body. Every field is a pointer so "absent" is
// distinguishable from "zero": the panel sends gpuLayers 0 to mean CPU-only,
// and sends null for a field whose input was empty, which must leave that
// setting alone rather than reset it.
type perfRequest struct {
	Reset       bool    `json:"reset"`
	CtxSize     *int    `json:"ctxSize"`
	GPULayers   *int    `json:"gpuLayers"`
	KVCacheType *string `json:"kvCacheType"`
}

func (s *Server) handlePerf(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.perfGet(w, r)
	case http.MethodPost:
		s.perfPost(w, r)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

func (s *Server) perfGet(w http.ResponseWriter, r *http.Request) {
	current, auto, overridden := s.tuning.get()

	// modelMaxCtx lets the panel cap its own input, so a number the server
	// would refuse cannot be typed in the first place. Zero means "unknown" —
	// no model identified yet — and the client leaves its input uncapped.
	maxCtx := s.info.Current(false).MaxCtx

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"current":     triple(current),
		"auto":        triple(auto),
		"overridden":  overridden,
		"modelMaxCtx": maxCtx,
	})
}

func (s *Server) perfPost(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	var req perfRequest
	if err := json.Unmarshal(body, &req); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "Body is not valid JSON.")
		return
	}

	s.tuning.writeMu.Lock()
	defer s.tuning.writeMu.Unlock()

	if req.Reset {
		s.perfReset(w, r)
		return
	}

	// Validate against the current values, so a request that sets only one
	// field is checked as the combination it will actually produce.
	current, _, _ := s.tuning.get()
	next := current
	if req.CtxSize != nil {
		if *req.CtxSize < config.MinCtxSize || *req.CtxSize > config.MaxCtxSize {
			httpx.Error(w, r, http.StatusBadRequest, "ctxSize must be a number between 512 and 1048576.")
			return
		}
		next.CtxSize = *req.CtxSize
	}
	if req.GPULayers != nil {
		if *req.GPULayers < config.MinGPULayers || *req.GPULayers > config.MaxGPULayers {
			httpx.Error(w, r, http.StatusBadRequest, "gpuLayers must be a number between 0 and 999.")
			return
		}
		next.GPULayers = *req.GPULayers
	}
	if req.KVCacheType != nil && *req.KVCacheType != "" {
		if !config.ValidKVCacheType(*req.KVCacheType) {
			httpx.Error(w, r, http.StatusBadRequest, "kvCacheType must be f16, q8_0 or q4_0.")
			return
		}
		next.KVCacheType = *req.KVCacheType
	}

	// Disk first. If the write fails, nothing has changed anywhere and the
	// client gets to see why — the alternative is a server running settings
	// that vanish on restart with no record of the discrepancy.
	if err := config.SavePerf(s.tuning.path, next.CtxSize, next.GPULayers, next.KVCacheType); err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not write "+s.tuning.path, err.Error())
		return
	}

	s.applyTuning(next, true)
	log.Printf("[perf] saved: ctx=%d gpu_layers=%d kv=%s", next.CtxSize, next.GPULayers, next.KVCacheType)

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"ok":      true,
		"current": triple(next),
		"note":    "Saved. Applies on the next llama-server start.",
	})
}

// perfReset deletes perf.toml rather than writing today's auto values into it.
// Called with writeMu held.
// Writing them would freeze the current guess forever: swap to a bigger model,
// or move the install to a better GPU, and the stale numbers would still be in
// force with nothing saying they were ever a guess.
func (s *Server) perfReset(w http.ResponseWriter, r *http.Request) {
	if err := config.ClearPerf(s.tuning.path); err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not remove "+s.tuning.path, err.Error())
		return
	}

	_, auto, _ := s.tuning.get()
	s.applyTuning(auto, false)
	log.Printf("[perf] reset to auto: ctx=%d gpu_layers=%d kv=%s", auto.CtxSize, auto.GPULayers, auto.KVCacheType)

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"ok":      true,
		"reset":   true,
		"current": triple(auto),
	})
}

// applyTuning publishes a new tuning to both readers of it: this server, for
// /active-model.json and the next /perf GET, and the supervisor, for the next
// llama-server start. In remote mode there is no supervisor and the values are
// informational — the panel still reports them, and still says they apply on
// the next start, which for a server we do not own is true and not ours to do.
func (s *Server) applyTuning(t supervisor.Tuning, overridden bool) {
	s.tuning.mu.Lock()
	s.tuning.current = t
	s.tuning.overridden = overridden
	s.tuning.mu.Unlock()

	if s.sup != nil {
		s.sup.SetTuning(t)
	}
}
