package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

/*
Idle stand-down, server side.

The mechanism lives in internal/supervisor/standdown.go. This file is the two
places it touches the outside world: the proxy hop that wakes the model before
forwarding, and the endpoint the CONFIG panel reads and writes.

WHY THE WAKE IS SYNCHRONOUS. The alternative is to answer 503 and let the
client retry, which is how a swap works — but a swap is something the user
asked for and is watching a progress panel for. A stand-down reload is not:
the user pressed send. Returning an error there would mean the feature's most
common visible behaviour is a failed message, and the setting would be off on
every machine within a day. Blocking costs the same wall-clock time and
arrives as a slow reply rather than a broken one.
*/

// standDownTimeout is read atomically so the watchdog goroutine and an HTTP
// request can change it without coordinating. Stored in seconds; 0 is off.
type standDown struct {
	seconds atomic.Int64
	stop    chan struct{}
}

func (s *standDown) after() time.Duration {
	return time.Duration(s.seconds.Load()) * time.Second
}

// startStandDownWatch begins the idle timer. A no-op unless a supervisor is
// present, which is exactly the managed/remote distinction: in remote mode
// llama.cpp is somebody else's process and stopping it is not ours to do.
func (s *Server) startStandDownWatch() {
	if s.sup == nil {
		return
	}
	s.standDown.seconds.Store(int64(s.cfg.IdleStandDownMinutes) * 60)
	s.standDown.stop = make(chan struct{})
	go s.sup.WatchIdle(s.standDown.after, s.standDown.stop, log.Printf)
}

func (s *Server) stopStandDownWatch() {
	if s.standDown.stop != nil {
		close(s.standDown.stop)
		s.standDown.stop = nil
	}
}

// usePaths are the proxied endpoints that mean the user is USING the model.
//
// WHY THIS LIST EXISTS -- and it is the bug that made idle stand-down look
// broken on every machine with a browser tab open.
//
// MarkActivity used to be called for every request that reached the proxy, on
// the stated reasoning that "generation is the only thing the frontend sends
// through the proxy, so that needs no special-casing today". That was simply
// not true. The chat page also sends /health, /props, /tokenize and
// /apply-template through the same proxy -- and js/24-boot.js polls
// checkConnection() every 5 SECONDS, which fetches /llm/health.
//
// So an open tab reset the idle clock twelve times a minute, and a feature
// whose own changelog says "an idle open tab is exactly the case this exists
// for" could not fire while a tab was open. The setting worked, the timer ran,
// the clock was simply never allowed to reach the timeout.
//
// Written without the /llm prefix, which this handler still carries (the proxy
// strips it on the way out, not on the way in), so it is removed before
// comparing.
var usePaths = []string{
	"/v1/chat/completions",
	"/v1/completions",
	"/completion",
	"/completions",
	"/infill",
}

// countsAsUse separates using the model from asking after it.
//
// Inspection -- /health, /props, /tokenize, /slots, /metrics -- deliberately
// does NOT count, and deliberately does not wake a stood-down model either.
// Waking on a health poll would be the same bug wearing a different hat: the
// model would reload five seconds after every stand-down, forever.
//
// EXACT, not a suffix match. Suffix matching was the first version and it is
// too loose: URL.Path arrives percent-DECODED, so a request for
// "/llm/props%3Fx=/completion" becomes the path "/llm/props?x=/completion",
// which ends in "/completion" and would have counted. Nothing serious follows
// from that -- the worst case is a model held in VRAM by a crafted URL -- but a
// rule this cheap to state exactly should be stated exactly.
func countsAsUse(path string) bool {
	if p, ok := strings.CutPrefix(path, "/llm"); ok {
		path = p
	}
	for _, p := range usePaths {
		if path == p {
			return true
		}
	}
	return false
}

// serveLLMProxy forwards to llama.cpp, reloading the model first if it was
// stood down.
func (s *Server) serveLLMProxy(w http.ResponseWriter, r *http.Request) {
	if s.sup != nil {
		use := countsAsUse(r.URL.Path)
		if use {
			done, err := s.sup.AcquireRequest()
			if err != nil {
				httpx.ErrorDetail(w, r, http.StatusServiceUnavailable, "model is not ready", err.Error())
				return
			}
			defer done()
		} else if s.sup.IsStoodDown() {
			// An inspection request while the model is unloaded. Answered
			// plainly rather than by waking it or by letting the proxy report a
			// dead upstream: "asleep" and "broken" look identical from a failed
			// connection, and only one of them is true.
			httpx.ErrorDetail(w, r, http.StatusServiceUnavailable,
				"the model is stood down to free VRAM",
				"it reloads automatically on your next message")
			return
		}
	}
	s.llmProxy.ServeHTTP(w, r)
}

// serveLLMJobs is the detached-generation route, wrapped for the same reasons
// as the proxy above.
//
// It was NOT wrapped, and that was the other half of the bug. The chat page
// generates through /llm/jobs, which is dispatched to the jobs manager and
// never touched the proxy -- so real use never marked activity, and a
// stood-down model was never woken for the one request type that actually
// needs it. With the fix above and not this one, stand-down would have started
// firing in the middle of conversations.
func (s *Server) serveLLMJobs(w http.ResponseWriter, r *http.Request) {
	s.jobs.Handle(w, r)
}

// handleStandDown is GET/POST /standdown, the CONFIG panel's view of the
// setting. Shaped after /perf, which is the existing precedent for a
// server-side value the page is allowed to change.
func (s *Server) handleStandDown(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.standDownGet(w, r)
	case http.MethodPost:
		s.standDownPost(w, r)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

func (s *Server) standDownGet(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		// supported says whether the control should appear at all. Showing a
		// switch that cannot do anything is worse than showing nothing: the
		// user turns it on, VRAM stays pinned, and the setting gets the blame.
		"supported": s.sup != nil,
		"minutes":   int(s.standDown.after() / time.Minute),
	}
	if s.sup != nil {
		body["stood_down"] = s.sup.IsStoodDown()
		if t := s.sup.IdleSince(); !t.IsZero() {
			body["idle_seconds"] = int(time.Since(t).Seconds())
		}
	}
	httpx.WriteJSON(w, r, http.StatusOK, body)
}

func (s *Server) standDownPost(w http.ResponseWriter, r *http.Request) {
	if s.sup == nil {
		httpx.Error(w, r, http.StatusConflict,
			"this server does not manage llama.cpp, so it cannot unload it")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	var in struct {
		Minutes *int `json:"minutes"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "body must be JSON", err.Error())
		return
	}
	if in.Minutes == nil {
		httpx.Error(w, r, http.StatusBadRequest, "minutes is required (0 disables)")
		return
	}
	m := *in.Minutes
	if m < 0 || m > 24*60 {
		httpx.Error(w, r, http.StatusBadRequest, "minutes must be between 0 and 1440")
		return
	}

	s.standDown.seconds.Store(int64(m) * 60)

	// Persisted, not just applied. A setting that reverts on restart is one
	// the user has to rediscover every time, and the people most likely to
	// change this are the ones it has just surprised.
	saved := true
	if s.cfg.Path != "" {
		if err := config.Set(s.cfg.Path, "idle_standdown_minutes", itoa(m)); err != nil {
			log.Printf("[standdown] could not persist the setting to %s: %v", s.cfg.Path, err)
			saved = false
		}
	} else {
		saved = false
	}

	// Turning it off should wake a model that is already down, or the user
	// disables the feature and still has to send a message to get their
	// backend back.
	if m == 0 && s.sup.IsStoodDown() {
		go func() {
			if err := s.sup.EnsureAwake(); err != nil {
				log.Printf("[standdown] reload after disabling failed: %v", err)
			}
		}()
	}

	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"minutes": m,
		// Reported rather than assumed: a read-only config file is a thing
		// that happens, and the panel should say "applied for now" instead of
		// claiming a save that did not occur.
		"persisted":  saved,
		"stood_down": s.sup.IsStoodDown(),
	})
}

var _ = supervisor.PhaseStoodDown
