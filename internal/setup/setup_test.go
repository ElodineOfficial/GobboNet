package setup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/auth"
	"github.com/ElodineOfficial/GobboNet/internal/autostart"
	"github.com/ElodineOfficial/GobboNet/internal/catalog"
	"github.com/ElodineOfficial/GobboNet/internal/config"
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
//
// This test found a real race, and then spent a while unable to prove it. The
// bug: the handler checked "has finish already run?" under the lock but did the
// work outside it, so every concurrent caller saw nil, every one of them ran
// config.Set, and config.Set writes through a fixed path+".tmp" — first rename
// wins, the rest get ENOENT and a 500.
//
// Two things make it reproducible rather than lucky, and both matter:
//
//   - GOMAXPROCS. On a single-CPU machine the goroutines below never overlap
//     enough to collide, and this test passes with the bug fully present. It
//     was passing on exactly such a machine while failing for users. Asking for
//     8 here costs nothing and is the difference between a test that catches
//     the bug and one that reports what the hardware happens to allow.
//   - A start barrier. Goroutines launched in a loop drift apart by however
//     long it takes to spawn the next one, which is enough for the first to
//     finish. Releasing them together closes that gap.
//
// Repeated because it is a race, but only 25 times, and the reason matters
// because the number looks too small next to the measurement. Against the
// unfixed handler a single attempt caught it roughly one time in twenty, and
// the slowest of 200 took until attempt 28 — so 25 would be a poor bet if this
// were still the test doing the catching.
//
// It is not. The 500s came from config.Set sharing one temporary filename
// between concurrent writers, and internal/atomicfile now owns that write.
// Its own test reproduces the collision on attempt 0, every run, in a tenth of
// a second, because it exercises the collision directly instead of hunting for
// it through eight HTTP round-trips. Deep detection lives there.
//
// What is left here is the handler's own contract: however many callers arrive
// at once they all get 200 and they all get the same body. That needs a
// handful of attempts, not hundreds.
func TestFinishSurvivesConcurrentCalls(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(8))

	attempts := 25
	if testing.Short() {
		attempts = 3
	}

	for attempt := 0; attempt < attempts; attempt++ {
		s := newTestServer(t)
		post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)

		start := make(chan struct{})
		var wg sync.WaitGroup
		codes := make([]int, 8)
		bodies := make([]string, 8)
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				rec := post(t, s, "/api/finish", `{"lan":false}`)
				codes[i], bodies[i] = rec.Code, rec.Body.String()
			}(i)
		}
		close(start)
		wg.Wait() // a panic in any handler fails the test run

		for i, c := range codes {
			if c != http.StatusOK {
				// The body names which write lost, which is the whole
				// diagnosis; without it this reads as an unexplained 500.
				t.Fatalf("attempt %d, concurrent finish %d: got %d, want 200\n  %s",
					attempt, i, c, bodies[i])
			}
		}
	}
}

// The other two handlers that write config. handleFinish got a test because a
// user hit it; these had the same exposure and nothing watching them.
//
// RUN THIS UNDER -race. That is not a suggestion, it is where the value is.
// The unguarded handler assigned s.cfg.AccessSecret and s.passwordSet from
// several goroutines with no synchronisation, and the visible consequence —
// config.toml holding one hash while the process holds another — surfaces
// perhaps once in a hundred attempts. Two 120-attempt runs against the broken
// code caught it once and missed it once, at nearly three minutes a run: a
// detector that slow and that unreliable is worse than none, because a pass
// reads as proof.
//
// -race finds the same bug in three attempts, every time, and names the two
// lines. So the attempt count here is small on purpose: the concurrency is
// bait for the race detector, and the assertions below are a second net for
// the consequence if the underlying writes are ever made unsafe some other way.
func TestPasswordSurvivesConcurrentCalls(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(8))

	// Five, not fifty: each attempt hashes eight passwords with a deliberately
	// slow KDF, and -race needs three.
	attempts := 5
	if testing.Short() {
		attempts = 2
	}
	for attempt := 0; attempt < attempts; attempt++ {
		s := newTestServer(t)

		start := make(chan struct{})
		var wg sync.WaitGroup
		codes := make([]int, 8)
		bodies := make([]string, 8)
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				rec := post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)
				codes[i], bodies[i] = rec.Code, rec.Body.String()
			}(i)
		}
		close(start)
		wg.Wait()

		for i, c := range codes {
			if c != http.StatusOK {
				t.Fatalf("attempt %d, concurrent password %d: got %d, want 200\n  %s",
					attempt, i, c, bodies[i])
			}
		}

		// What was written and what this process believes have to agree, or the
		// password accepted now is not the one that works at next launch.
		cfg, err := config.Load(s.cfg.Path)
		if err != nil {
			t.Fatalf("attempt %d: reading config back: %v", attempt, err)
		}
		s.mu.Lock()
		inMemory := s.cfg.AccessSecret
		s.mu.Unlock()
		if cfg.AccessSecret == "" {
			t.Fatalf("attempt %d: no password was persisted", attempt)
		}
		if cfg.AccessSecret != inMemory {
			t.Fatalf("attempt %d: config holds a different hash than the server does", attempt)
		}
	}
}

// Concurrent mode choices must not blend.
//
// Honest about its reach: this does NOT currently distinguish the guarded
// handler from the unguarded one. It was run against both and passed against
// both. Once config.Set stopped colliding, the remaining benefit of the lock in
// applyBackend is that a mode's several settings are written as one unit and
// backendMode cannot disagree with them — and no black-box assertion available
// here separates that from the alternative, because nothing clears the fields
// the other mode wrote, by design.
//
// Kept anyway, for two reasons. It is bait for -race, the same as the password
// test above. And it pins the contract that concurrent submissions all succeed
// and leave a config consistent with whichever mode won, so a future change
// that breaks that is caught rather than shipped.
//
// It is not evidence the lock fixed something. The lock is defence in depth.
func TestBackendSurvivesConcurrentCalls(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(8))

	attempts := 10
	if testing.Short() {
		attempts = 3
	}
	for attempt := 0; attempt < attempts; attempt++ {
		s := newTestServer(t)
		post(t, s, "/api/password", `{"password":"hunter22","confirm":"hunter22"}`)

		// Half pick remote, half pick local: the interleaving that could mix them.
		payloads := []string{
			`{"mode":"remote","url":"http://192.168.1.9:11434"}`,
			`{"mode":"local"}`,
		}

		start := make(chan struct{})
		var wg sync.WaitGroup
		codes := make([]int, 8)
		bodies := make([]string, 8)
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				rec := post(t, s, "/api/backend", payloads[i%2])
				codes[i], bodies[i] = rec.Code, rec.Body.String()
			}(i)
		}
		close(start)
		wg.Wait()

		for i, c := range codes {
			if c != http.StatusOK {
				t.Fatalf("attempt %d, concurrent backend %d: got %d, want 200\n  %s",
					attempt, i, c, bodies[i])
			}
		}

		cfg, err := config.Load(s.cfg.Path)
		if err != nil {
			t.Fatalf("attempt %d: reading config back: %v", attempt, err)
		}
		s.mu.Lock()
		mode := s.backendMode
		s.mu.Unlock()
		// server_exe is what actually selects local mode, so it is the field
		// that has to match the mode the server thinks it recorded.
		if mode == "local" && cfg.ServerExe == "" {
			t.Fatalf("attempt %d: mode is local but server_exe was not written", attempt)
		}
		if mode == "remote" && cfg.LLMURL == "" {
			t.Fatalf("attempt %d: mode is remote but llm_url was not written", attempt)
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
