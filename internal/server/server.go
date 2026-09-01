// Package server wires every route together. Port of fileserver.ps1's
// `while ($listener.IsListening)` dispatch block.
//
// Route order matters — more-specific prefixes must come before catch-alls:
//
//	/login, /logout            unauthenticated
//	/favicon.ico               unauthenticated (so the login tab isn't ugly)
//	-------------------------- auth gate --------------------------
//	/health-fileserver         liveness, plus what this server is capable of
//	/active-model.json         model identity for the UI
//	/models-list.json          the header dropdown
//	/catalog.json              the download catalogue, for the add-a-model modal
//	/model-download            start (POST) and poll (GET) a model download
//	/state, /state/*           cross-device state sync
//	/perf                      llama-server tuning the settings panel edits
//	/swap-model, /swap-status  model-swap contract
//	/llm/jobs, /llm/jobs/*     detached generation (OUR routes, not llama.cpp's)
//	/llm, /llm/*               reverse proxy -> llama.cpp
//	/search/health             answered here; see handleSearch
//	/search, /search/*         reverse proxy -> the web-search API
//	/embed, /embed/*           reverse proxy -> embedding server
//	everything else            static files
package server

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/httpx"
	"github.com/jmccardle/gobbonet/internal/jobs"
	"github.com/jmccardle/gobbonet/internal/models"
	"github.com/jmccardle/gobbonet/internal/proxy"
	"github.com/jmccardle/gobbonet/internal/state"
	"github.com/jmccardle/gobbonet/internal/static"
	"github.com/jmccardle/gobbonet/internal/supervisor"
	"github.com/jmccardle/gobbonet/internal/version"
)

// Server holds the long-lived state shared by every request.
type Server struct {
	cfg  config.Config
	mode config.Mode

	sessions *auth.SessionStore
	limiter  *auth.LoginLimiter
	info     *models.Info
	jobs     *jobs.Manager
	sup      *supervisor.Supervisor
	// tuning is the live ctx/gpu-layers/kv-cache triple. Held here rather than
	// read off cfg because /perf changes it while the server runs.
	tuning *tuning

	llmProxy    *proxy.Proxy
	searchProxy *proxy.Proxy
	embedProxy  *proxy.Proxy

	// secret is guarded because a successful login against a legacy hash
	// rewrites it in place.
	secretMu sync.RWMutex
	secret   string

	// cat is the download catalogue, loaded on first use by catalog(). catErr
	// caches the failure so a missing models.ini disables the add-a-model modal
	// rather than being re-stat-ed on every request.
	//
	// catForced is when an explicit refresh last bypassed the fetch's own 24
	// hour disk cache, so that opening the modal repeatedly on a dead network
	// costs one timeout rather than one per open.
	catMu     sync.Mutex
	cat       *catalog.Catalog
	catErr    error
	catSource string
	catNotes  []string
	catForced time.Time
	catForce  bool

	// downloads enforces one model download at a time, the wizard's policy.
	downloads downloads

	upstream upstreamHealth

	// bind is what Listen actually got, published so /health-fileserver can
	// report whether LAN access exists. Guarded because it is written once at
	// startup and read by every health request thereafter.
	//
	// It is reported over HTTP because the startup banner scrolls away, and
	// "I can't reach it from my phone" arrives long after it did. A user who
	// cannot read a terminal can still open /health-fileserver in the browser
	// — the same reason the build stamp is served there.
	bindMu sync.RWMutex
	bind   *Bind
}

// New builds a Server. sup may be nil, which selects remote mode behaviour for
// the swap routes.
func New(cfg config.Config, mode config.Mode, sup *supervisor.Supervisor) (*Server, error) {
	s := &Server{
		cfg:      cfg,
		mode:     mode,
		sessions: auth.NewSessionStore(cfg.SessionTTLHours),
		limiter:  auth.NewLoginLimiter(),
		sup:      sup,
		secret:   cfg.AccessSecret,
		tuning:   newTuning(cfg),
	}

	s.info = models.NewInfo(cfg.LLMURL, cfg.LLMAPIKey, cfg.ModelDir, mode == config.ModeLocal)
	if sup != nil {
		s.info.LocalFile = sup.CurrentFile
		// A completed swap must not leave the UI describing the old model.
		sup.OnReady = s.info.Invalidate
	}

	s.jobs = jobs.NewManager(cfg.LLMURL, cfg.LLMAPIKey, cfg.JobMaxConcurrent, cfg.JobMaxAgeHours)

	var err error
	// Only the LLM upstream gets the API key: it is the one we authenticate to.
	if s.llmProxy, err = proxy.New("/llm", cfg.LLMURL, cfg.LLMAPIKey); err != nil {
		return nil, fmt.Errorf("llm_url: %w", err)
	}
	if s.searchProxy, err = proxy.New("/search", cfg.SearchURL, ""); err != nil {
		return nil, fmt.Errorf("search_url: %w", err)
	}
	if s.embedProxy, err = proxy.New("/embed", cfg.EmbedURL, ""); err != nil {
		return nil, fmt.Errorf("embed_url: %w", err)
	}

	return s, nil
}

// Info exposes the model resolver for CLI subcommands.
func (s *Server) Info() *models.Info { return s.info }

// Shutdown releases everything the server owns.
func (s *Server) Shutdown() {
	s.jobs.Shutdown()
	if s.sup != nil {
		s.sup.Shutdown()
	}
}

// authRequired reports whether the password gate is active.
func (s *Server) authRequired() bool {
	if !s.cfg.RequireAuth {
		return false
	}
	s.secretMu.RLock()
	defer s.secretMu.RUnlock()
	return auth.SecretConfigured(s.secret)
}

func (s *Server) authenticated(r *http.Request) bool {
	if !s.authRequired() {
		return true
	}
	return s.sessions.Validate(auth.TokenFromRequest(r), auth.ClientFingerprint(r))
}

// ServeHTTP is the dispatcher.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Host validation before anything else. We bind 0.0.0.0 by default, so a
	// DNS-rebinding page could otherwise reach us from a victim's browser with
	// their session cookie attached.
	if !s.cfg.HostAllowed(r.Host) {
		httpx.Error(w, r, http.StatusMisdirectedRequest, "unrecognised Host header")
		return
	}

	// CORS preflight never carries credentials and must answer before the auth
	// gate, or the browser reports a CORS failure instead of a 401 the app can
	// actually handle.
	if r.Method == http.MethodOptions {
		httpx.CommonHeaders(w)
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := r.URL.Path

	// --- Unauthenticated routes ---------------------------------------------
	switch {
	case path == "/login":
		s.handleLogin(w, r)
		return
	case path == "/logout":
		s.handleLogout(w, r)
		return
	case path == "/favicon.ico" && !s.authenticated(r):
		// Served without auth purely so the login tab isn't ugly.
		static.Serve(w, r, s.cfg.WebRoot, "/favicon.ico")
		return
	}

	// --- Auth gate -----------------------------------------------------------
	if !s.authenticated(r) {
		// A browser navigating to a page gets the login screen; an API or proxy
		// call gets a clean JSON 401 that chat.html can detect and act on.
		if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
			httpx.WriteText(w, r, http.StatusUnauthorized, "text/html; charset=utf-8", auth.LoginPage(false))
		} else {
			httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{
				"error": "authentication required",
				"login": "/login",
			})
		}
		return
	}

	// --- Routing -------------------------------------------------------------
	switch {
	case path == "/health-fileserver":
		s.handleHealth(w, r)

	case path == "/active-model.json":
		// The live context size, not cfg's: a /perf change that has been applied
		// by a swap must not leave the UI budgeting against the old window.
		httpx.WriteJSON(w, r, http.StatusOK, s.info.ActiveModelPayload(s.tuning.CtxSize()))

	case path == "/models-list.json":
		httpx.WriteJSON(w, r, http.StatusOK, s.info.ModelsListPayload())

	// The add-a-model modal. Authenticated like everything else in this block —
	// /model-download writes files to disk and makes outbound requests, and this
	// server can be bound to the LAN.
	case path == "/catalog.json":
		s.handleCatalog(w, r)

	case path == "/model-download":
		s.handleModelDownload(w, r)

	case path == "/state" || strings.HasPrefix(path, "/state/"):
		state.Handle(w, r, s.cfg.StatePath())

	case path == "/perf":
		s.handlePerf(w, r)

	// Wrapped rather than delegated straight through: the model about to be
	// launched may have a published ctx/kv, and this is the only point at which
	// we know which model that is. See handleSwapModel in models.go.
	case path == "/swap-model":
		s.handleSwapModel(w, r)

	case path == "/swap-status":
		supervisor.Handlers{Sup: s.sup}.HandleSwapStatus(w, r)

	// Must precede the /llm/* proxy catch-all — these are OUR routes, not
	// llama.cpp's. Living under /llm keeps the client's relative addressing
	// (and the session cookie) working unchanged.
	case path == "/llm/jobs" || strings.HasPrefix(path, "/llm/jobs/"):
		s.jobs.Handle(w, r)

	case path == "/llm" || strings.HasPrefix(path, "/llm/"):
		s.llmProxy.ServeHTTP(w, r)

	case path == "/search" || strings.HasPrefix(path, "/search/"):
		s.handleSearch(w, r, path)

	case path == "/embed" || strings.HasPrefix(path, "/embed/"):
		// RAG embeddings. If nothing is listening the proxy returns 502 and the
		// client falls back to tag-only retrieval.
		s.embedProxy.ServeHTTP(w, r)

	default:
		static.Serve(w, r, s.cfg.WebRoot, path)
	}
}

// --- Auth routes -----------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteText(w, r, http.StatusOK, "text/html; charset=utf-8", auth.LoginPage(false))
		return
	}

	// Rate limit before doing any work. Constant-time comparison stops an
	// attacker learning the password a byte at a time; it does nothing about
	// simply trying a lot of passwords quickly.
	if !s.limiter.Allow(r) {
		if strings.Contains(r.Header.Get("Accept"), "text/html") {
			httpx.WriteText(w, r, http.StatusTooManyRequests, "text/html; charset=utf-8", auth.TooManyAttemptsPage())
		} else {
			httpx.Error(w, r, http.StatusTooManyRequests, "too many login attempts")
		}
		return
	}

	if err := r.ParseForm(); err != nil {
		httpx.WriteText(w, r, http.StatusBadRequest, "text/html; charset=utf-8", auth.LoginPage(true))
		return
	}
	password := r.PostFormValue("password")

	s.secretMu.RLock()
	secret := s.secret
	s.secretMu.RUnlock()

	ok, needsRehash, err := auth.Verify(secret, password)
	if err != nil {
		log.Printf("[auth] stored secret is unusable: %v", err)
	}
	if !ok {
		httpx.WriteText(w, r, http.StatusUnauthorized, "text/html; charset=utf-8", auth.LoginPage(true))
		return
	}

	if needsRehash {
		s.upgradeSecret(password)
	}

	token, err := s.sessions.Create(auth.ClientFingerprint(r))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not create session", err.Error())
		return
	}
	auth.SetSessionCookie(w, token, s.sessions.TTL())
	httpx.WriteRedirect(w, "/")
}

// upgradeSecret rewrites a verified legacy SHA-256 secret as Argon2id.
//
// This is the whole migration: the user logs in once with the password they
// already have, and the weak hash is gone. No forced reset, no separate step.
func (s *Server) upgradeSecret(password string) {
	upgraded, err := auth.NewSecret(password)
	if err != nil {
		log.Printf("[auth] could not compute Argon2 hash: %v", err)
		return
	}

	s.secretMu.Lock()
	s.secret = upgraded
	s.secretMu.Unlock()

	if err := config.Set(s.cfg.Path, "access_secret", upgraded); err != nil {
		// The in-memory upgrade still stands for this run, but it will be lost
		// on restart, so say so rather than let it fail silently every time.
		log.Printf("[auth] upgraded password hash to Argon2id but could not save it to %s: %v", s.cfg.Path, err)
		return
	}
	log.Printf("[auth] upgraded stored password hash from SHA-256 to Argon2id")
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.Revoke(auth.TokenFromRequest(r))
	auth.ClearSessionCookie(w)
	httpx.WriteRedirect(w, "/login")
}

// --- Health ----------------------------------------------------------------

// upstreamHealth caches the upstream liveness probe.
type upstreamHealth struct {
	mu      sync.Mutex
	ok      bool
	checked time.Time
}

const upstreamHealthTTL = 3 * time.Second

// upstreamOK probes the upstream's /health, cached briefly so a dashboard
// polling this endpoint can't turn into a probe storm.
func (s *Server) upstreamOK() bool {
	s.upstream.mu.Lock()
	defer s.upstream.mu.Unlock()

	if time.Since(s.upstream.checked) < upstreamHealthTTL {
		return s.upstream.ok
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(s.cfg.LLMURL + "/health")
	ok := false
	if err == nil {
		resp.Body.Close()
		ok = resp.StatusCode == http.StatusOK
	}

	s.upstream.ok = ok
	s.upstream.checked = time.Now()
	return ok
}

// handleHealth reports both liveness and capability.
//
// The PowerShell version sent {status, pid, hotswap} and the Python version sent
// {status, upstream, hotswap:false}; a client had to know which server it was
// talking to. This sends all of it, always, so the frontend can adapt without
// guessing.
//
// upstream_ok matters more than it looks: without it this endpoint reports only
// that the Go process is alive, which for a proxy is close to useless — the
// diagnostic endpoint would say "ok" in precisely the scenario you'd use it to
// debug.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":      "ok",
		"version":     version.String(),
		"pid":         os.Getpid(),
		"hotswap":     s.sup != nil,
		"mode":        string(s.mode),
		"upstream":    s.cfg.LLMURL,
		"upstream_ok": s.upstreamOK(),
	}

	// Absent when nothing published a bind — a Server driven directly by a test
	// harness, say. Reporting an unknown bind as "no LAN access" would be a
	// guess, and the fields are omitted rather than guessed at.
	if b := s.Bind(); b != nil {
		body["listen_host"] = b.Host
		body["listen_port"] = b.Port
		body["lan_access"] = b.LANReachable()
		if b.FellBack {
			body["lan_bind_denied"] = b.WideErr.Error()
		}
	}
	httpx.WriteJSON(w, r, http.StatusOK, body)
}

// SetBind publishes the bind for the health endpoint to report.
func (s *Server) SetBind(b *Bind) {
	s.bindMu.Lock()
	defer s.bindMu.Unlock()
	s.bind = b
}

// Bind returns the published bind, or nil if none was set.
func (s *Server) Bind() *Bind {
	s.bindMu.RLock()
	defer s.bindMu.RUnlock()
	return s.bind
}

// handleSearch forwards /search/* to the web-search API, answering /health here.
//
// The client (js/11-search.js) probes /search/health before every search and
// treats a failure as "the proxy is not running". That probe made sense when a
// relay process owned the route: upstream started one on 11435 and the health
// check asked whether it had come up. Upstream 1.6.0 deleted the relay and
// answers /health inside the file server; this does the same.
//
// What it reports is configuration, not reachability — search_url is set, so
// the route is wired. It deliberately does not reach out to the API to find
// out: that would spend a round trip on every search to answer a question the
// search itself is about to answer properly, and an unauthenticated probe
// cannot distinguish "the internet is down" from "your key is wrong" anyway.
// A real failure surfaces on the real request, with the upstream's own status.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/search" || path == "/search/" || path == "/search/health" {
		if s.cfg.SearchURL == "" {
			httpx.Error(w, r, http.StatusBadGateway, "web search is switched off (search_url is empty)")
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"status":   "ok",
			"upstream": s.cfg.SearchURL,
		})
		return
	}
	s.searchProxy.ServeHTTP(w, r)
}

// --- Listening -------------------------------------------------------------

// Bind is the outcome of Listen: the socket, and what had to be given up to
// get it.
//
// The caller needs more than a net.Listener because the two outcomes are not
// interchangeable to a user. Binding 0.0.0.0 means the phone on the sofa can
// reach this; binding 127.0.0.1 means it cannot. A banner that prints the
// configured host rather than the bound one would promise phone access that
// does not exist, which is the specific wrong-but-reassuring status this whole
// path exists to remove.
type Bind struct {
	Listener net.Listener

	// Host is the address actually bound, which is not always cfg.ListenHost.
	Host string
	Port int

	// FellBack is set when a wide bind was refused and loopback was taken
	// instead. WideErr is why, kept so the caller can print the real OS error
	// rather than a paraphrase of it.
	FellBack bool
	WideErr  error
}

// LANReachable reports whether the bound address is one another device can
// reach. Loopback is not, whether it was configured or fallen back to.
func (b *Bind) LANReachable() bool {
	return !isLoopbackHost(b.Host)
}

// Listen binds the configured address without serving.
//
// Split from Serve so the caller can fail before it prints "serving on ...".
// The banner used to go out first and a bind failure landed underneath it,
// which reads as a server that started and then broke rather than one that
// never got the port — the same confusion launch.bat's port-holder check was
// added to clear up in 1.6.0.
//
// When the configured host is network-facing and the kernel refuses it, this
// retries on loopback instead of failing. The file server SERVES THE CHAT PAGE:
// before the retry a user whose machine would not allow a wide bind lost
// desktop chat entirely, while llama.cpp on its own port stayed healthy — which
// reads as a front-end bug and is the hardest kind of report to act on. Phone
// access genuinely needs the wide bind; chat on this machine never did.
//
// The retry only ever NARROWS what is exposed. There is no path here from
// loopback out to the network, so a machine that was configured to stay local
// cannot be widened by a failure.
func (s *Server) Listen() (*Bind, error) {
	host := s.cfg.ListenHost
	port := s.cfg.ListenPort
	ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	if err == nil {
		return &Bind{Listener: ln, Host: host, Port: port}, nil
	}

	// Already loopback, or a failure loopback would hit too: report it as it
	// is. Retrying an in-use port on a narrower address would either fail the
	// same way or, worse, quietly succeed while another GobboNet holds the
	// address the user was told to visit.
	if isLoopbackHost(host) || !recoverableOnLoopback(err) {
		return nil, err
	}

	wideErr := err
	fallbackHost := loopbackFor(host)
	ln, err = net.Listen("tcp", net.JoinHostPort(fallbackHost, fmt.Sprintf("%d", port)))
	if err != nil {
		// Both failed. The wide error is the one that describes the user's
		// actual problem; the loopback attempt was diagnosis, and saying so
		// keeps the caller from reporting the narrower failure as the cause.
		return nil, wideErr
	}
	return &Bind{
		Listener: ln,
		Host:     fallbackHost,
		Port:     port,
		FellBack: true,
		WideErr:  wideErr,
	}, nil
}

// recoverableOnLoopback reports whether a wide-bind failure is the kind that a
// loopback bind might survive.
//
// Permission and address-availability failures are: they are properties of the
// address, and loopback is a different address. "Already in use" is not — the
// port is occupied, the user needs to hear that rather than be moved somewhere
// quieter, and portInUseError already says it well.
//
// The Windows numbers are checked directly because WSA errors are their own
// Errno values that do not compare equal to the syscall constants of the same
// name: WSAEACCES is 10013, not EACCES's 13.
func recoverableOnLoopback(err error) bool {
	for _, target := range []syscall.Errno{
		syscall.EACCES,        // policy, privileged port, or a reserved range
		syscall.EADDRNOTAVAIL, // configured address is not on this machine
		syscall.EAFNOSUPPORT,  // e.g. "::" where IPv6 is switched off
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch uintptr(errno) {
		case 10013, // WSAEACCES
			10047, // WSAEAFNOSUPPORT
			10049: // WSAEADDRNOTAVAIL
			return true
		}
	}
	return false
}

// isLoopbackHost reports whether host names only this machine.
func isLoopbackHost(host string) bool {
	if host == "" {
		// The empty host is the wildcard, not loopback: net.Listen on ":9066"
		// binds every interface. Reading it as local-only would be the one
		// mistake this file must not make.
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// loopbackFor picks the loopback address in the same family as the host we
// failed to bind, so an IPv6-only configuration does not land on an IPv4 socket
// its clients cannot reach.
func loopbackFor(host string) string {
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		return "::1"
	}
	return "127.0.0.1"
}

// Serve runs until the listener is closed.
func (s *Server) Serve(ln net.Listener) error {
	srv := &http.Server{
		Handler: s,
		// No WriteTimeout: a streaming generation legitimately holds a response
		// open for many minutes, and a write deadline would sever it mid-reply.
		// The proxy's own idle watchdog bounds a wedged upstream instead.
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return srv.Serve(ln)
}

// ListenAndServe binds and serves until the listener is closed.
func (s *Server) ListenAndServe() error {
	b, err := s.Listen()
	if err != nil {
		return err
	}
	s.SetBind(b)
	return s.Serve(b.Listener)
}

// LANIP is a best-effort local address for the "open this on your phone" hint.
//
// Replaces launch.bat's `ipconfig | findstr IPv4` parse. Opening a UDP socket to
// a routable address makes the kernel pick the interface it would actually use;
// nothing is sent.
func LANIP() string {
	conn, err := net.Dial("udp", "192.0.2.1:53")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP.String()
	}
	return "127.0.0.1"
}
