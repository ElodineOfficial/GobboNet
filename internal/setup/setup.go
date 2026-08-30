// Package setup implements `gobbonet setup` — the first-run wizard for
// platforms whose installer is silent.
//
// A .deb install asks nothing (the Linux norm), so the questions the NSIS
// wizard asks at install time have to move to the first launch instead. This
// serves them as a small local web page rather than a terminal prompt, because
// a .desktop launch has no terminal: `Terminal=false` means stdin is not a
// thing that exists, and a console prompt there fails invisibly.
//
// Three properties matter more than the UI:
//
//   - It binds loopback only, on a kernel-assigned port, whatever listen_host
//     is destined to become. The wizard runs *before* a password exists, so for
//     the length of that window there is nothing standing between the network
//     and a form that sets one.
//   - The password is step one and nothing else is reachable until it is set.
//   - It is idempotent. The launcher runs it unconditionally on every start, so
//     "already done" has to be a fast, silent success rather than a re-ask.
package setup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/autostart"
	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/modelfetch"
)

// MinPasswordLength matches the console path and the NSIS wizard's own rule.
const MinPasswordLength = 6

// Options configures a wizard run. The launcher supplies all of these so the
// packaged paths are used rather than whatever the discovery order finds.
type Options struct {
	ConfigPath  string // --config
	CatalogPath string // --catalog: installer/models.ini, shipped beside the binary
	ServerExe   string // --server-exe: the packaged llama-server the launcher picked
	NoBrowser   bool   // --no-browser: print the URL instead of opening it
	Force       bool   // --force: re-run even if setup already completed
	Out         io.Writer
}

// Result reports what the wizard did, so the caller can decide whether there is
// anything left to say.
type Result struct {
	AlreadyComplete bool
}

// markerName records that setup finished. Completion genuinely is not derivable
// from the config: a password with no backend is a half-finished setup that
// looks identical to a user who ran `set-password` by hand, and guessing wrong
// either re-asks every launch or skips a setup that never happened.
//
// This is not the .gobbonet-port sidecar under another name. That file
// duplicated state the config already held; this records a fact the config has
// nowhere to put.
const markerName = "setup-complete.json"

type marker struct {
	CompletedAt time.Time `json:"completed_at"`
	Mode        string    `json:"mode"`
}

// Complete reports whether setup has already run to completion.
func Complete(dataDir string) bool {
	_, err := os.Stat(filepath.Join(dataDir, markerName))
	return err == nil
}

type server struct {
	opts Options
	cfg  *config.Config
	cat  *catalog.Catalog
	out  io.Writer

	mu           sync.Mutex
	passwordSet  bool
	backendMode  string // "local" or "remote"
	dl           *modelfetch.Download
	finishedBody []byte

	shutdown     chan struct{}
	shutdownOnce sync.Once
}

// Run serves the wizard and returns when the user finishes it.
func Run(opts Options) (Result, error) {
	if opts.Out == nil {
		opts.Out = os.Stdout
	}

	cfg, err := config.Load(opts.ConfigPath)
	if err != nil {
		return Result{}, fmt.Errorf("setup needs an existing config; %w", err)
	}

	if !opts.Force && Complete(cfg.DataDir) {
		return Result{AlreadyComplete: true}, nil
	}

	cat, err := catalog.Load(opts.CatalogPath)
	if err != nil {
		return Result{}, err
	}

	s := &server{
		opts:        opts,
		cfg:         &cfg,
		cat:         cat,
		out:         opts.Out,
		passwordSet: auth.SecretConfigured(cfg.AccessSecret),
		shutdown:    make(chan struct{}),
	}

	// Loopback, kernel-assigned port. Not cfg.ListenHost: that is 0.0.0.0 by
	// compiled-in default and is exactly what must not happen here.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return Result{}, fmt.Errorf("could not open a local port for setup: %w", err)
	}
	defer ln.Close()

	url := fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)

	httpSrv := &http.Server{Handler: s.routes()}
	errc := make(chan error, 1)
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	fmt.Fprintf(s.out, "\n  GobboNet setup is at:  %s\n", url)
	if opts.NoBrowser {
		fmt.Fprintf(s.out, "  Open that in a browser to continue.\n\n")
	} else {
		openBrowser(url)
		fmt.Fprintf(s.out, "  Opening a browser. Leave this running until setup finishes.\n\n")
	}

	select {
	case err := <-errc:
		return Result{}, err
	case <-s.shutdown:
	}

	// Give the final response time to reach the browser before the listener
	// goes away, or the last click ends on a connection error.
	time.Sleep(300 * time.Millisecond)
	_ = httpSrv.Close()
	return Result{}, nil
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/password", s.handlePassword)
	mux.HandleFunc("/api/backend", s.handleBackend)
	mux.HandleFunc("/api/download", s.handleDownload)
	mux.HandleFunc("/api/finish", s.handleFinish)
	return mux
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(wizardHTML)
}

type stateResponse struct {
	PasswordSet bool               `json:"password_set"`
	BackendMode string             `json:"backend_mode"`
	Models      []catalogModel     `json:"models"`
	Default     int                `json:"default"`
	CPUOnly     int                `json:"cpu_only"`
	HasEngine   bool               `json:"has_engine"`
	FreeGB      float64            `json:"free_gb"`
	Download    *modelfetch.Status `json:"download,omitempty"`
}

type catalogModel struct {
	Index   int     `json:"index"`
	Display string  `json:"display"`
	SizeGB  float64 `json:"size_gb"`
	MinVRAM int     `json:"min_vram"`
	File    string  `json:"file"`
}

func (s *server) handleState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	resp := stateResponse{
		PasswordSet: s.passwordSet,
		BackendMode: s.backendMode,
		Default:     s.cat.Default,
		CPUOnly:     s.cat.CPUOnly,
		HasEngine:   s.opts.ServerExe != "",
		FreeGB:      float64(modelfetch.FreeBytes(s.modelDir())) / (1 << 30),
	}
	for _, e := range s.cat.Entries {
		resp.Models = append(resp.Models, catalogModel{
			Index: e.Index, Display: e.Display, SizeGB: e.SizeGB,
			MinVRAM: e.MinVRAM, File: e.File,
		})
	}
	if s.dl != nil {
		st := s.dl.Status()
		resp.Download = &st
	}
	writeJSON(w, http.StatusOK, resp)
}

type passwordRequest struct {
	Password string `json:"password"`
	Confirm  string `json:"confirm"`
}

func (s *server) handlePassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	if !decode(w, r, &req) {
		return
	}
	if len(req.Password) < MinPasswordLength {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("Use at least %d characters.", MinPasswordLength))
		return
	}
	if req.Confirm != "" && req.Password != req.Confirm {
		writeErr(w, http.StatusBadRequest, "The two passwords do not match.")
		return
	}

	// auth.NewSecret + config.Set is the whole of it. This is a second door
	// onto the hashing the console path already uses, not a second scheme.
	secret, err := auth.NewSecret(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Could not hash the password: "+err.Error())
		return
	}
	if err := config.Set(s.cfg.Path, "access_secret", secret); err != nil {
		writeErr(w, http.StatusInternalServerError, "Could not save the password: "+err.Error())
		return
	}

	s.mu.Lock()
	s.cfg.AccessSecret = secret
	s.passwordSet = true
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type backendRequest struct {
	Mode string `json:"mode"` // "local" | "remote"
	URL  string `json:"url"`
	Key  string `json:"key"`
}

func (s *server) handleBackend(w http.ResponseWriter, r *http.Request) {
	if !s.requirePassword(w) {
		return
	}
	var req backendRequest
	if !decode(w, r, &req) {
		return
	}

	switch req.Mode {
	case "remote":
		if strings.TrimSpace(req.URL) == "" {
			writeErr(w, http.StatusBadRequest, "Enter the address of the server you want to use.")
			return
		}
		if err := config.Set(s.cfg.Path, "llm_url", strings.TrimSpace(req.URL)); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if k := strings.TrimSpace(req.Key); k != "" {
			if err := config.Set(s.cfg.Path, "llm_api_key", k); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		// server_exe empty is what selects remote mode. Leave it alone.
	case "local":
		if s.opts.ServerExe == "" {
			writeErr(w, http.StatusBadRequest,
				"This install has no bundled engine, so models can only run on another machine.")
			return
		}
		if err := config.Set(s.cfg.Path, "server_exe", s.opts.ServerExe); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := config.Set(s.cfg.Path, "model_dir", s.modelDir()); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "Choose where models should run.")
		return
	}

	s.mu.Lock()
	s.backendMode = req.Mode
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type downloadRequest struct {
	Index int `json:"index"`
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if !s.requirePassword(w) {
		return
	}

	if r.Method == http.MethodGet {
		s.mu.Lock()
		dl := s.dl
		s.mu.Unlock()
		if dl == nil {
			writeJSON(w, http.StatusOK, modelfetch.Status{State: "idle"})
			return
		}
		writeJSON(w, http.StatusOK, dl.Status())
		return
	}

	var req downloadRequest
	if !decode(w, r, &req) {
		return
	}
	entry, ok := s.cat.Find(req.Index)
	if !ok {
		writeErr(w, http.StatusBadRequest, "That model is not in the catalogue.")
		return
	}

	s.mu.Lock()
	if s.dl != nil && s.dl.Status().State == "running" {
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	dir := s.modelDir()
	s.mu.Unlock()

	// Free space before a byte moves. A 16 GB download that dies at 15 costs
	// far more of the user's evening than one dialog does, and the failure
	// arrives with no clue that space was the problem.
	need := int64(entry.SizeGB*float64(1<<30)) + (1 << 30) // + 1 GB headroom
	if free := modelfetch.FreeBytes(dir); free > 0 && free < need {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf(
			"%s needs about %.1f GB and there is %.1f GB free on this disk. "+
				"Free some space, or pick a smaller model.",
			entry.Display, entry.SizeGB, float64(free)/(1<<30)))
		return
	}

	dl := modelfetch.New(entry, dir)
	s.mu.Lock()
	s.dl = dl
	s.mu.Unlock()
	go dl.Run()

	// Record the model's tuning alongside the choice, the way the NSIS wizard
	// does — a model picked without its ctx/kv settings loads with the wrong
	// window and looks like a bad model rather than a missing setting.
	if entry.Ctx > 0 {
		_ = config.Set(s.cfg.Path, "ctx_size", fmt.Sprint(entry.Ctx))
	}
	if entry.KV != "" && config.ValidKVCacheType(entry.KV) {
		_ = config.Set(s.cfg.Path, "kv_cache_type", entry.KV)
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// flexLAN accepts the LAN answer as a boolean or as "on"/"off"/"true"/"false".
//
// The build spec flags a UI/server disagreement here as a real trap: it
// surfaces as a decode error on the last click, which reads as a broken payload
// rather than a type mismatch, and sends you looking in the wrong place.
// Accepting both shapes removes the failure mode instead of documenting it.
type flexLAN bool

func (f *flexLAN) UnmarshalJSON(b []byte) error {
	var asBool bool
	if err := json.Unmarshal(b, &asBool); err == nil {
		*f = flexLAN(asBool)
		return nil
	}
	var asString string
	if err := json.Unmarshal(b, &asString); err == nil {
		switch strings.ToLower(strings.TrimSpace(asString)) {
		case "on", "true", "yes", "1":
			*f = true
		default:
			*f = false
		}
		return nil
	}
	return fmt.Errorf("lan must be a boolean or one of \"on\"/\"off\"")
}

type finishRequest struct {
	LAN       flexLAN `json:"lan"`
	Autostart flexLAN `json:"autostart"`
}

func (s *server) handleFinish(w http.ResponseWriter, r *http.Request) {
	if !s.requirePassword(w) {
		return
	}

	// A second call must not close an already-closed channel. A double-click on
	// the final button, a browser retry and a refresh-and-resubmit all produce
	// one, and the panic takes the server down mid-response — after which every
	// later request fails to decode and looks like a payload bug.
	s.mu.Lock()
	if s.finishedBody != nil {
		body := s.finishedBody
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
		s.shutdownOnce.Do(func() { close(s.shutdown) })
		return
	}
	s.mu.Unlock()

	var req finishRequest
	if !decode(w, r, &req) {
		return
	}

	host := "127.0.0.1"
	if bool(req.LAN) {
		host = "0.0.0.0"
	}
	if err := config.Set(s.cfg.Path, "listen_host", host); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Written as this user, into this user's own config — the package cannot
	// do it, and would be wrong to. A failure here does not fail setup:
	// everything else is already saved, and losing a working install over a
	// login convenience would be a poor trade.
	if err := autostart.Set(bool(req.Autostart)); err != nil {
		fmt.Fprintf(s.out, "  [WARN] could not set the login entry: %v\n", err)
	}

	s.mu.Lock()
	mode := s.backendMode
	s.mu.Unlock()
	if mode == "" {
		mode = "local"
	}

	if err := os.MkdirAll(s.cfg.DataDir, 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	blob, _ := json.MarshalIndent(marker{CompletedAt: time.Now().UTC(), Mode: mode}, "", "  ")
	if err := os.WriteFile(filepath.Join(s.cfg.DataDir, markerName), blob, 0o600); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	body, _ := json.Marshal(map[string]any{
		"ok":        true,
		"port":      s.cfg.ListenPort,
		"host":      host,
		"autostart": bool(req.Autostart),
	})

	s.mu.Lock()
	s.finishedBody = body
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)

	s.shutdownOnce.Do(func() { close(s.shutdown) })
}

func (s *server) requirePassword(w http.ResponseWriter) bool {
	s.mu.Lock()
	ok := s.passwordSet
	s.mu.Unlock()
	if !ok {
		writeErr(w, http.StatusForbidden, "Set the access password first.")
		return false
	}
	return true
}

func (s *server) modelDir() string {
	if s.cfg.ModelDir != "" {
		return s.cfg.ModelDir
	}
	return filepath.Join(s.cfg.DataDir, "models")
}

// --- helpers ----------------------------------------------------------------

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	// Best effort by design: if no browser opens, the URL is already on stdout
	// and in the launcher's log.
	_ = cmd.Start()
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST required.")
		return false
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "Could not read the request: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
