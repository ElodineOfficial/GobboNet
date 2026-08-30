package setup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/autostart"
	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
)

func newTestServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := config.WriteDefault(cfgPath); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = filepath.Join(dir, "data")

	ini := filepath.Join(dir, "models.ini")
	body := "[recommend]\r\ncpu_only=1\r\ndefault=1\r\n" +
		"\r\n[1]\r\ndisplay=Small\r\nrepo=a/b\r\nfile=small.gguf\r\nsize_gb=2.0\r\nctx=32768\r\nkv=f16\r\n"
	if err := os.WriteFile(ini, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(ini)
	if err != nil {
		t.Fatal(err)
	}

	return &server{
		opts:     Options{ConfigPath: cfgPath, ServerExe: "/usr/lib/gobbonet/llama-cpp/llama-server"},
		cfg:      &cfg,
		cat:      cat,
		out:      &strings.Builder{},
		shutdown: make(chan struct{}),
	}
}

func post(t *testing.T, s *server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

// Part 3b: the password is step one, and nothing else is reachable until it is
// set. Without this the wizard is briefly a way to configure a server that has
// no access control yet.
func TestEverythingIsGatedBehindThePassword(t *testing.T) {
	s := newTestServer(t)
	for _, path := range []string{"/api/backend", "/api/download", "/api/finish"} {
		rec := post(t, s, path, `{}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s before a password: got %d, want 403", path, rec.Code)
		}
	}
}

func TestPasswordIsStoredAsArgon2id(t *testing.T) {
	s := newTestServer(t)
	rec := post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("set password: got %d (%s)", rec.Code, rec.Body)
	}
	cfg, err := config.Load(s.cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.AccessSecret, "$argon2id$") {
		t.Errorf("secret is not an Argon2id PHC string: %q", cfg.AccessSecret)
	}
	if !auth.SecretConfigured(cfg.AccessSecret) {
		t.Error("the stored secret does not verify as configured")
	}
	if strings.Contains(cfg.AccessSecret, "hunter22") {
		t.Error("the plaintext password appears in the config")
	}
}

func TestShortAndMismatchedPasswordsAreRejected(t *testing.T) {
	s := newTestServer(t)
	if rec := post(t, s, "/api/password", `{"password":"abc","confirm":"abc"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("short password: got %d, want 400", rec.Code)
	}
	if rec := post(t, s, "/api/password", `{"password":"longenough","confirm":"different"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("mismatched password: got %d, want 400", rec.Code)
	}
}

// Part 6's first pitfall. A double-click on the final button, a browser retry
// and a refresh-and-resubmit all produce a second call. If the handler closes
// its shutdown channel unguarded, the second close panics the setup server —
// and every later request then fails to decode, which reads as a payload bug
// rather than an earlier panic.
func TestFinishIsIdempotent(t *testing.T) {
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)

	first := post(t, s, "/api/finish", `{"lan":false}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first finish: got %d (%s)", first.Code, first.Body)
	}
	second := post(t, s, "/api/finish", `{"lan":false}`)
	if second.Code != http.StatusOK {
		t.Fatalf("second finish: got %d (%s) — want the same success", second.Code, second.Body)
	}
	if first.Body.String() != second.Body.String() {
		t.Errorf("repeat call returned a different payload:\n first:  %s\n second: %s",
			first.Body.String(), second.Body.String())
	}
}

// The same thing under concurrency, which is what a double-click actually is.
func TestFinishSurvivesConcurrentCalls(t *testing.T) {
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)

	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = post(t, s, "/api/finish", `{"lan":false}`).Code
		}(i)
	}
	wg.Wait() // a panic in any handler fails the test run
	for i, c := range codes {
		if c != http.StatusOK {
			t.Errorf("concurrent finish %d: got %d, want 200", i, c)
		}
	}
}

// Part 3b: off writes 127.0.0.1, on writes 0.0.0.0. This is the behaviour that
// actually matters; the wire type of the field does not.
func TestLANAnswerControlsListenHost(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"lan":false}`, "127.0.0.1"},
		{`{"lan":true}`, "0.0.0.0"},
		{`{"lan":"off"}`, "127.0.0.1"},
		{`{"lan":"on"}`, "0.0.0.0"},
	} {
		s := newTestServer(t)
		post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
		rec := post(t, s, "/api/finish", tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("finish %s: got %d (%s)", tc.body, rec.Code, rec.Body)
		}
		cfg, err := config.Load(s.cfg.Path)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.ListenHost != tc.want {
			t.Errorf("finish %s: listen_host = %q, want %q", tc.body, cfg.ListenHost, tc.want)
		}
	}
}

// Part 6's third pitfall: a UI/server disagreement over the LAN field's
// representation shows up as a decode error on the last click. Accepting both
// shapes removes the failure mode rather than documenting it.
func TestLANFieldAcceptsBothRepresentations(t *testing.T) {
	var f finishRequest
	for _, body := range []string{`{"lan":true}`, `{"lan":"on"}`, `{"lan":"true"}`, `{"lan":"1"}`} {
		if err := json.Unmarshal([]byte(body), &f); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if !bool(f.LAN) {
			t.Errorf("%s decoded to false", body)
		}
	}
	for _, body := range []string{`{"lan":false}`, `{"lan":"off"}`, `{"lan":""}`} {
		if err := json.Unmarshal([]byte(body), &f); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if bool(f.LAN) {
			t.Errorf("%s decoded to true", body)
		}
	}
}

func TestFinishWritesTheCompletionMarker(t *testing.T) {
	s := newTestServer(t)
	if Complete(s.cfg.DataDir) {
		t.Fatal("a fresh install reports setup already complete")
	}
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	post(t, s, "/api/finish", `{"lan":false}`)
	if !Complete(s.cfg.DataDir) {
		t.Error("setup finished but left no completion marker, so the launcher would re-ask every start")
	}
}

func TestRemoteBackendNeedsAURL(t *testing.T) {
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	if rec := post(t, s, "/api/backend", `{"mode":"remote","url":"  "}`); rec.Code != http.StatusBadRequest {
		t.Errorf("remote with a blank URL: got %d, want 400", rec.Code)
	}
}

// server_exe is what selects local mode; empty means remote. A remote choice
// must not quietly set it, or the server comes up local with no engine.
func TestRemoteModeLeavesServerExeEmpty(t *testing.T) {
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	rec := post(t, s, "/api/backend", `{"mode":"remote","url":"http://10.0.0.5:8080"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("remote backend: got %d (%s)", rec.Code, rec.Body)
	}
	cfg, err := config.Load(s.cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerExe != "" {
		t.Errorf("remote mode set server_exe to %q", cfg.ServerExe)
	}
	if !strings.Contains(cfg.LLMURL, "10.0.0.5") {
		t.Errorf("llm_url was not written: %q", cfg.LLMURL)
	}
}

func TestLocalModePointsAtThePackagedEngine(t *testing.T) {
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	rec := post(t, s, "/api/backend", `{"mode":"local"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("local backend: got %d (%s)", rec.Code, rec.Body)
	}
	cfg, err := config.Load(s.cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerExe != s.opts.ServerExe {
		t.Errorf("server_exe = %q, want %q", cfg.ServerExe, s.opts.ServerExe)
	}
}

func TestIndexServesTheWizard(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "GobboNet") {
		t.Error("the wizard page did not render")
	}
}

// Autostart is off unless asked for. A chat server that begins listening at
// every login is not something to switch on for someone.
func TestAutostartIsOffUnlessRequested(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	post(t, s, "/api/finish", `{"lan":false}`)
	if autostart.Enabled() {
		t.Error("setup enabled autostart without being asked")
	}
}

func TestAutostartIsSetWhenRequested(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	rec := post(t, s, "/api/finish", `{"lan":false,"autostart":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("finish: got %d (%s)", rec.Code, rec.Body)
	}
	if !autostart.Enabled() {
		t.Error("setup did not write the login entry when asked to")
	}
	if !strings.Contains(rec.Body.String(), `"autostart":true`) {
		t.Errorf("finish did not report the autostart decision back: %s", rec.Body)
	}
}

// Same both-shapes tolerance as the LAN field, for the same reason.
func TestAutostartAcceptsStringForm(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := newTestServer(t)
	post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
	post(t, s, "/api/finish", `{"lan":"off","autostart":"on"}`)
	if !autostart.Enabled() {
		t.Error(`autostart:"on" was not honoured`)
	}
}
