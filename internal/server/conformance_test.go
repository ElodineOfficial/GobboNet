// Conformance tests for the wire contract chat.html depends on.
//
// The design docs call this the precondition, and for a specific reason: the
// /state/info regression was invisible to every other kind of check. The
// wildcard route swallowed the request, the client parsed the body without
// error, and boot-time conflict detection silently stopped firing. Nothing
// crashed. Prose could not catch it a second time, so these assertions exist to.
//
// Everything here asserts on the documented contract — exact field names, exact
// headers, exact status codes — not on implementation details.
package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/config"
)

// newTestServer builds a server with auth disabled and temp directories.
func newTestServer(t *testing.T) (*Server, config.Config) {
	t.Helper()

	dir := t.TempDir()
	webRoot := filepath.Join(dir, "web")
	dataDir := filepath.Join(dir, "data")
	for _, d := range []string{webRoot, dataDir, filepath.Join(webRoot, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(webRoot, "chat.html"), "<html>chat</html>")
	write(filepath.Join(webRoot, "style.css"), "body{}")
	write(filepath.Join(webRoot, ".secret"), "should never be served")
	// A file outside the web root, for the traversal tests to try to reach.
	write(filepath.Join(dir, "outside.txt"), "SECRET")

	cfgPath := filepath.Join(dir, "config.toml")
	write(cfgPath, "llm_url = \"http://127.0.0.1:1\"\n")

	cfg := config.Default()
	cfg.Path = cfgPath
	cfg.WebRoot = webRoot
	cfg.DataDir = dataDir
	cfg.ModelDir = filepath.Join(dir, "models")
	cfg.SkillsDir = filepath.Join(dir, "skills")
	cfg.StoriesDir = filepath.Join(dir, "stories")
	cfg.LLMURL = "http://127.0.0.1:1" // nothing listens; proxy tests expect 502
	cfg.SearchURL = "http://127.0.0.1:1"
	cfg.EmbedURL = "http://127.0.0.1:1"
	cfg.RequireAuth = false

	// Mirrors the serve path: it is ApplyPerf that separates the auto baseline
	// from the live values, and /perf reports both. Without it the baseline
	// would be zero here and the tests would be checking a state that never
	// occurs in a real run.
	if err := cfg.ApplyPerf(); err != nil {
		t.Fatal(err)
	}

	srv, err := New(cfg, config.ModeRemote, nil)
	if err != nil {
		t.Fatal(err)
	}
	return srv, cfg
}

// newReq builds a request with a Host the server will accept. httptest defaults
// to "example.com", which the Host allowlist correctly refuses — see
// TestHostHeaderValidation, which is the test that cares about that.
func newReq(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1:8080"
	return req
}

func do(t *testing.T, srv *Server, method, target string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := newReq(method, target, body)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v\nbody: %s", err, rec.Body.String())
	}
	return out
}

// --- State -----------------------------------------------------------------

// The three client decisions that hang off these fields — auto-restore,
// quota-truncation recovery, and conflict detection — all read `mtime` and
// `size` by name. Renaming either one breaks boot silently.
func TestStateInfoContract(t *testing.T) {
	srv, cfg := newTestServer(t)

	// Before anything is stored, /state/info must 404 with this exact envelope.
	rec := do(t, srv, http.MethodGet, "/state/info", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("empty /state/info: got %d, want 404", rec.Code)
	}
	if got := decode(t, rec)["error"]; got != "no state on server" {
		t.Errorf(`empty /state/info error: got %q, want "no state on server"`, got)
	}

	// Store some state.
	payload := `{"threads":[{"id":"a"}]}`
	rec = do(t, srv, http.MethodPost, "/state", strings.NewReader(payload))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /state: got %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	stored := decode(t, rec)
	if stored["status"] != "ok" {
		t.Errorf(`POST /state status: got %v, want "ok"`, stored["status"])
	}
	if _, ok := stored["mtime"]; !ok {
		t.Error("POST /state response is missing the mtime field")
	}
	if rec.Header().Get("X-State-Mtime") == "" {
		t.Error("POST /state is missing the X-State-Mtime header")
	}

	// /state/info must now report mtime and size by those names.
	rec = do(t, srv, http.MethodGet, "/state/info", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/state/info: got %d, want 200", rec.Code)
	}
	info := decode(t, rec)
	mtime, ok := info["mtime"].(float64)
	if !ok {
		t.Fatalf("/state/info mtime: got %#v, want a number", info["mtime"])
	}
	size, ok := info["size"].(float64)
	if !ok {
		t.Fatalf("/state/info size: got %#v, want a number", info["size"])
	}
	if int(size) != len(payload) {
		t.Errorf("/state/info size: got %d, want %d", int(size), len(payload))
	}
	// This is the regression that started it all: /state/info must NOT return
	// the full state body.
	if _, leaked := info["threads"]; leaked {
		t.Error("/state/info returned the full state body -- the wildcard route has swallowed it again")
	}

	// The header must agree with the body, on every /state* response.
	header := rec.Header().Get("X-State-Mtime")
	if header == "" {
		t.Fatal("/state/info is missing the X-State-Mtime header")
	}
	if headerMS, err := strconv.ParseInt(header, 10, 64); err != nil {
		t.Errorf("X-State-Mtime is not an integer: %q", header)
	} else if headerMS != int64(mtime) {
		t.Errorf("X-State-Mtime %d disagrees with body mtime %d", headerMS, int64(mtime))
	}

	// A full GET returns the body plus the same header.
	rec = do(t, srv, http.MethodGet, "/state", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /state: got %d, want 200", rec.Code)
	}
	if rec.Body.String() != payload {
		t.Errorf("GET /state body: got %q, want %q", rec.Body.String(), payload)
	}
	if rec.Header().Get("X-State-Mtime") == "" {
		t.Error("GET /state is missing the X-State-Mtime header")
	}

	_ = cfg
}

// POST /state/info must be refused, not treated as a state write.
func TestStateInfoRejectsWrites(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, method := range []string{http.MethodPost, http.MethodPut} {
		rec := do(t, srv, method, "/state/info", strings.NewReader(`{}`))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /state/info: got %d, want 405", method, rec.Code)
		}
	}
}

func TestStateRejectsInvalidJSON(t *testing.T) {
	srv, cfg := newTestServer(t)

	rec := do(t, srv, http.MethodPost, "/state", strings.NewReader("not json at all"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST invalid JSON: got %d, want 400", rec.Code)
	}
	// Nothing may have been written -- a rejected body must not land on disk.
	if _, err := os.Stat(cfg.StatePath()); err == nil {
		t.Error("an invalid body was persisted anyway")
	}
}

func TestStatePutIsSameAsPost(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodPut, "/state", strings.NewReader(`{"v":2}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /state: got %d, want 200", rec.Code)
	}
	rec = do(t, srv, http.MethodGet, "/state", nil)
	if rec.Body.String() != `{"v":2}` {
		t.Errorf("PUT did not store the body: got %q", rec.Body.String())
	}
}

// --- Static files ----------------------------------------------------------

func TestStaticServesRoot(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "chat") {
		t.Errorf("GET / did not serve chat.html: %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("GET / content type: got %q, want text/html", ct)
	}
}

func TestStaticRejectsTraversal(t *testing.T) {
	srv, _ := newTestServer(t)

	// Every one of these must fail. A traversal that returns 200 means the
	// whole filesystem is readable by anyone who can reach the port.
	paths := []string{
		"/../outside.txt",
		"/sub/../../outside.txt",
		"/..%2foutside.txt",
		"/%2e%2e/outside.txt",
		"/....//outside.txt",
		"/sub/%2e%2e/%2e%2e/outside.txt",
	}
	for _, p := range paths {
		req := newReq(http.MethodGet, "http://example.com", nil)
		// Set the path directly so the test can express raw escapes that
		// url.Parse would otherwise normalise away before the server sees them.
		u, err := url.Parse(p)
		if err != nil {
			continue
		}
		req.URL = u
		req.Host = "127.0.0.1:8080"

		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)

		// Assert the status, not merely the absence of the secret. A test that
		// only checks "didn't leak" passes just as happily when the request was
		// rejected for some unrelated reason, and would stop testing traversal
		// without anyone noticing.
		if rec.Code != http.StatusNotFound {
			t.Errorf("traversal %q: got %d, want 404", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "SECRET") {
			t.Errorf("traversal %q escaped the web root", p)
		}
	}

	// Positive control: a legitimate file must still be served, so the test
	// above can't pass by refusing everything.
	rec := do(t, srv, http.MethodGet, "/style.css", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /style.css: got %d, want 200 -- static serving is broken entirely", rec.Code)
	}
}

func TestStaticRejectsDotfiles(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/.secret", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /.secret: got %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "should never be served") {
		t.Error("a dot-prefixed file was served")
	}
}

// --- Auth ------------------------------------------------------------------

// The 401 split is what lets a browser land on the login form while chat.html's
// fetch() calls get a JSON error they can detect.
func TestUnauthenticatedContentNegotiation(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	// A browser navigation gets HTML.
	req := newReq(http.MethodGet, "/", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("HTML navigation: got %d, want 401", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("HTML navigation content type: got %q, want text/html", ct)
	}
	if !strings.Contains(rec.Body.String(), "Sign in") {
		t.Error("HTML navigation did not return the login page")
	}

	// An API call gets JSON with the login pointer.
	req = newReq(http.MethodGet, "/state", nil)
	req.Header.Set("Accept", "application/json")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("API call: got %d, want 401", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "authentication required" {
		t.Errorf(`API 401 error: got %v, want "authentication required"`, body["error"])
	}
	if body["login"] != "/login" {
		t.Errorf(`API 401 login: got %v, want "/login"`, body["login"])
	}
}

func TestLoginSetsSessionCookieAndRedirects(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	form := strings.NewReader("password=correct+horse+battery")
	req := newReq(http.MethodPost, "/login", form)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("login: got %d, want 302 (body %s)", rec.Code, rec.Body)
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Errorf("login redirect: got %q, want /", loc)
	}

	cookies := rec.Result().Cookies()
	var session *http.Cookie
	for _, c := range cookies {
		if c.Name == auth.CookieName {
			session = c
		}
	}
	if session == nil {
		t.Fatal("login did not set the session cookie")
	}
	if !session.HttpOnly {
		t.Error("session cookie is not HttpOnly -- JS could read it")
	}
	if session.SameSite != http.SameSiteLaxMode {
		t.Error("session cookie is not SameSite=Lax")
	}

	// The cookie must actually authenticate a subsequent request.
	req = newReq(http.MethodGet, "/state/info", nil)
	req.AddCookie(session)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Error("the session cookie issued at login did not authenticate")
	}
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	req := newReq(http.MethodPost, "/login", strings.NewReader("password=wrong"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d, want 401", rec.Code)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			t.Error("a session cookie was issued for a wrong password")
		}
	}
}

// A legacy salt:hash secret must keep working and be upgraded in place.
func TestLegacySecretVerifiesAndUpgrades(t *testing.T) {
	srv, cfg := newTestServer(t)

	// "salt:sha256(salt + password)", the format launch.bat wrote.
	const salt = "0011223344556677"
	const password = "hunter2hunter2"
	legacy := salt + ":" + sha256Hex(salt+password)

	srv.cfg.RequireAuth = true
	srv.secret = legacy

	req := newReq(http.MethodPost, "/login", strings.NewReader("password="+url.QueryEscape(password)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("legacy login: got %d, want 302", rec.Code)
	}

	srv.secretMu.RLock()
	upgraded := srv.secret
	srv.secretMu.RUnlock()

	if !strings.HasPrefix(upgraded, "$argon2id$") {
		t.Fatalf("secret was not upgraded to Argon2id: %q", upgraded)
	}
	// The upgrade must be durable, or it silently repeats on every login.
	raw, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "$argon2id$") {
		t.Error("the upgraded hash was not written back to the config file")
	}
	// The same password must still work against the new hash.
	ok, needsRehash, err := auth.Verify(upgraded, password)
	if err != nil || !ok {
		t.Errorf("upgraded hash does not verify the original password (ok=%v err=%v)", ok, err)
	}
	if needsRehash {
		t.Error("the upgraded hash still reports needsRehash")
	}
}

func TestLoginRateLimited(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	limited := false
	for i := 0; i < 40; i++ {
		req := newReq(http.MethodPost, "/login", strings.NewReader("password=wrong"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.RemoteAddr = "203.0.113.9:5555"
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Error("40 wrong-password attempts from one IP were never rate limited")
	}
}

func TestLogoutRevokesSession(t *testing.T) {
	srv, _ := newTestServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	token, err := srv.sessions.Create(auth.ClientFingerprint(newReq(http.MethodGet, "/", nil)))
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: auth.CookieName, Value: token}

	req := newReq(http.MethodGet, "/logout", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("logout: got %d, want 302", rec.Code)
	}

	req = newReq(http.MethodGet, "/state/info", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("the revoked session still authenticates: got %d, want 401", rec.Code)
	}
}

// favicon must be reachable while logged out, so the login tab isn't ugly.
func TestFaviconUnauthenticated(t *testing.T) {
	srv, cfg := newTestServer(t)
	if err := os.WriteFile(filepath.Join(cfg.WebRoot, "favicon.ico"), []byte("icon"), 0o644); err != nil {
		t.Fatal(err)
	}
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	rec := do(t, srv, http.MethodGet, "/favicon.ico", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("unauthenticated favicon: got %d, want 200", rec.Code)
	}
}

// --- CORS / OPTIONS --------------------------------------------------------

func TestOptionsPreflight(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.cfg.RequireAuth = true

	// Preflight must answer before the auth gate, or the browser reports a CORS
	// failure instead of the 401 the app knows how to handle.
	rec := do(t, srv, http.MethodOptions, "/state", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS: got %d, want 204", rec.Code)
	}
	want := map[string]string{
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Cache-Control":                "no-store",
	}
	for header, expected := range want {
		if got := rec.Header().Get(header); got != expected {
			t.Errorf("OPTIONS %s: got %q, want %q", header, got, expected)
		}
	}
}

func TestCommonHeadersOnEveryResponse(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, path := range []string{"/", "/health-fileserver", "/state/info", "/does-not-exist"} {
		rec := do(t, srv, http.MethodGet, path, nil)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("%s: Access-Control-Allow-Origin is %q, want *", path, got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control is %q, want no-store", path, got)
		}
	}
}

// --- Host validation -------------------------------------------------------

func TestHostHeaderValidation(t *testing.T) {
	srv, _ := newTestServer(t)

	// IP literals and localhost are how the LAN case actually works.
	for _, host := range []string{"127.0.0.1:8080", "192.168.1.50:8080", "localhost:8080", "desktop.local:8080"} {
		req := newReq(http.MethodGet, "/health-fileserver", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code == http.StatusMisdirectedRequest {
			t.Errorf("host %q was rejected but should be allowed", host)
		}
	}

	// An unknown DNS name is the rebinding case.
	req := newReq(http.MethodGet, "/health-fileserver", nil)
	req.Host = "attacker.example.com"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("unknown host: got %d, want 421", rec.Code)
	}

	// ...unless it was explicitly allowlisted.
	srv.cfg.AllowedHosts = []string{"gobbonet.example.com"}
	req = newReq(http.MethodGet, "/health-fileserver", nil)
	req.Host = "gobbonet.example.com"
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code == http.StatusMisdirectedRequest {
		t.Error("an allowlisted host was rejected")
	}
}

// --- Health ----------------------------------------------------------------

func TestHealthPayload(t *testing.T) {
	srv, cfg := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/health-fileserver", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/health-fileserver: got %d, want 200", rec.Code)
	}
	body := decode(t, rec)

	if body["status"] != "ok" {
		t.Errorf(`status: got %v, want "ok"`, body["status"])
	}
	// pid is always present, so a log line can be correlated to a process
	// regardless of which implementation the client is talking to.
	if _, ok := body["pid"].(float64); !ok {
		t.Errorf("pid: got %#v, want a number", body["pid"])
	}
	if body["mode"] != "remote" {
		t.Errorf(`mode: got %v, want "remote"`, body["mode"])
	}
	if body["hotswap"] != false {
		t.Errorf("hotswap in remote mode: got %v, want false", body["hotswap"])
	}
	if body["upstream"] != cfg.LLMURL {
		t.Errorf("upstream: got %v, want %q", body["upstream"], cfg.LLMURL)
	}
	// upstream_ok must be present and false -- nothing is listening on the test
	// upstream. Without this field the endpoint would report "ok" in exactly the
	// situation you'd use it to diagnose.
	ok, present := body["upstream_ok"].(bool)
	if !present {
		t.Fatalf("upstream_ok: got %#v, want a bool", body["upstream_ok"])
	}
	if ok {
		t.Error("upstream_ok is true, but no upstream is running")
	}
}

// --- Swap ------------------------------------------------------------------

func TestSwapInRemoteMode(t *testing.T) {
	srv, _ := newTestServer(t)

	// Remote mode cannot swap, and says so with 503 rather than pretending.
	rec := do(t, srv, http.MethodPost, "/swap-model", strings.NewReader(`{"file":"x.gguf"}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("POST /swap-model in remote mode: got %d, want 503", rec.Code)
	}
	if body := decode(t, rec); body["phase"] != "error" {
		t.Errorf(`swap-model phase: got %v, want "error"`, body["phase"])
	}

	// /swap-status must still answer, because chat.html polls it unconditionally.
	rec = do(t, srv, http.MethodGet, "/swap-status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /swap-status: got %d, want 200", rec.Code)
	}
	if body := decode(t, rec); body["phase"] != "idle" {
		t.Errorf(`swap-status phase: got %v, want "idle"`, body["phase"])
	}
}

// --- Perf ------------------------------------------------------------------

// js/02-model.js reads p.current.ctxSize, p.auto.gpuLayers, p.overridden and
// p.modelMaxCtx by name. These are upstream's spellings, they are camelCase in
// a codebase that is otherwise snake_case on the wire, and one shared frontend
// file drives both this server and fileserver.ps1 — so they are pinned here
// rather than left to whichever casing felt natural on the day.
func TestPerfGetContract(t *testing.T) {
	srv, cfg := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/perf", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /perf: got %d, want 200", rec.Code)
	}
	body := decode(t, rec)

	for _, key := range []string{"current", "auto", "overridden", "modelMaxCtx"} {
		if _, ok := body[key]; !ok {
			t.Errorf("GET /perf is missing %q; body: %s", key, rec.Body.String())
		}
	}

	for _, key := range []string{"current", "auto"} {
		obj, ok := body[key].(map[string]any)
		if !ok {
			t.Fatalf("%s is not an object: %v", key, body[key])
		}
		for _, field := range []string{"ctxSize", "gpuLayers", "kvCacheType"} {
			if _, ok := obj[field]; !ok {
				t.Errorf("%s is missing %q; got %v", key, field, obj)
			}
		}
	}

	// With no perf.toml, current and auto are the config file's values and the
	// panel must be told it is not overriding anything.
	current := body["current"].(map[string]any)
	if got := int(current["ctxSize"].(float64)); got != cfg.CtxSize {
		t.Errorf("current.ctxSize: got %d, want %d", got, cfg.CtxSize)
	}
	if body["overridden"] != false {
		t.Errorf("overridden with no perf.toml: got %v, want false", body["overridden"])
	}
}

// A save has to survive a restart, so it lands on disk; and the panel reads the
// result back immediately, so it must be visible without one.
func TestPerfSaveRoundTrips(t *testing.T) {
	srv, cfg := newTestServer(t)
	perfPath := config.PerfPath(cfg.Path)

	rec := do(t, srv, http.MethodPost, "/perf",
		strings.NewReader(`{"ctxSize":8192,"gpuLayers":0,"kvCacheType":"f16"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /perf: got %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if body := decode(t, rec); body["ok"] != true {
		t.Errorf("POST /perf ok: got %v, want true", body["ok"])
	}

	if _, err := os.Stat(perfPath); err != nil {
		t.Fatalf("POST /perf did not write %s: %v", perfPath, err)
	}

	body := decode(t, do(t, srv, http.MethodGet, "/perf", nil))
	current := body["current"].(map[string]any)
	if got := int(current["ctxSize"].(float64)); got != 8192 {
		t.Errorf("current.ctxSize after save: got %d, want 8192", got)
	}
	// gpuLayers 0 means CPU-only. It is a real setting, not an absent field,
	// which is the whole reason the request type uses pointers.
	if got := int(current["gpuLayers"].(float64)); got != 0 {
		t.Errorf("current.gpuLayers after saving 0: got %d, want 0", got)
	}
	if current["kvCacheType"] != "f16" {
		t.Errorf("current.kvCacheType after save: got %v, want f16", current["kvCacheType"])
	}
	if body["overridden"] != true {
		t.Errorf("overridden after save: got %v, want true", body["overridden"])
	}

	// auto is untouched: config.toml is the baseline and a save must not
	// rewrite it, or "reset" would have nothing to go back to.
	auto := body["auto"].(map[string]any)
	if got := int(auto["ctxSize"].(float64)); got != cfg.AutoCtxSize {
		t.Errorf("auto.ctxSize after save: got %d, want %d (the baseline must not move)", got, cfg.AutoCtxSize)
	}

	// A reload of the same config now yields the overridden values.
	reloaded := cfg
	if err := reloaded.ApplyPerf(); err != nil {
		t.Fatalf("reloading with perf.toml present: %v", err)
	}
	if reloaded.CtxSize != 8192 || reloaded.GPULayers != 0 || reloaded.KVCacheType != "f16" {
		t.Errorf("after restart: ctx=%d gpu=%d kv=%s, want 8192/0/f16",
			reloaded.CtxSize, reloaded.GPULayers, reloaded.KVCacheType)
	}
	if !reloaded.PerfOverridden {
		t.Error("PerfOverridden after restart: got false, want true")
	}
}

// Reset deletes the file rather than writing the auto values into it. Writing
// them would freeze today's guess forever — move to a better GPU and the stale
// numbers would still be in force with nothing recording that they were a guess.
func TestPerfResetRemovesTheOverride(t *testing.T) {
	srv, cfg := newTestServer(t)
	perfPath := config.PerfPath(cfg.Path)

	if rec := do(t, srv, http.MethodPost, "/perf",
		strings.NewReader(`{"ctxSize":4096}`)); rec.Code != http.StatusOK {
		t.Fatalf("POST /perf: got %d, want 200", rec.Code)
	}

	rec := do(t, srv, http.MethodPost, "/perf", strings.NewReader(`{"reset":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /perf reset: got %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["reset"] != true {
		t.Errorf("reset flag in response: got %v, want true", body["reset"])
	}
	// The panel writes j.current straight back into its inputs.
	current := body["current"].(map[string]any)
	if got := int(current["ctxSize"].(float64)); got != cfg.AutoCtxSize {
		t.Errorf("reset current.ctxSize: got %d, want the baseline %d", got, cfg.AutoCtxSize)
	}

	if _, err := os.Stat(perfPath); !os.IsNotExist(err) {
		t.Errorf("%s still exists after reset (err=%v)", perfPath, err)
	}
	if body := decode(t, do(t, srv, http.MethodGet, "/perf", nil)); body["overridden"] != false {
		t.Errorf("overridden after reset: got %v, want false", body["overridden"])
	}

	// Resetting twice is not an error: the caller asked for "no override in
	// force", and after the first call that is already true.
	if rec := do(t, srv, http.MethodPost, "/perf", strings.NewReader(`{"reset":true}`)); rec.Code != http.StatusOK {
		t.Errorf("second reset: got %d, want 200", rec.Code)
	}
}

// A rejected value must not be written, and must come back as {"error": ...},
// which is the envelope _perfStatus renders.
func TestPerfRejectsOutOfRange(t *testing.T) {
	srv, cfg := newTestServer(t)

	for _, tc := range []struct{ name, body string }{
		{"ctxSize below the floor", `{"ctxSize":16}`},
		{"ctxSize past any model", `{"ctxSize":99999999}`},
		{"negative gpuLayers", `{"gpuLayers":-1}`},
		{"gpuLayers past the cap", `{"gpuLayers":1000}`},
		{"unknown kvCacheType", `{"kvCacheType":"q2_k"}`},
		{"not JSON at all", `ctxSize=8192`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, srv, http.MethodPost, "/perf", strings.NewReader(tc.body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400; body: %s", rec.Code, rec.Body.String())
			}
			if _, ok := decode(t, rec)["error"]; !ok {
				t.Errorf("no error field; body: %s", rec.Body.String())
			}
		})
	}

	if _, err := os.Stat(config.PerfPath(cfg.Path)); !os.IsNotExist(err) {
		t.Errorf("a rejected request wrote perf.toml anyway (err=%v)", err)
	}
}

// The panel sends null for an input it did not touch. That means "leave this
// alone", not "set it to zero" — the distinction the pointer fields exist for.
func TestPerfPartialUpdateLeavesTheRestAlone(t *testing.T) {
	srv, _ := newTestServer(t)

	before := decode(t, do(t, srv, http.MethodGet, "/perf", nil))["current"].(map[string]any)

	if rec := do(t, srv, http.MethodPost, "/perf",
		strings.NewReader(`{"ctxSize":8192,"gpuLayers":null,"kvCacheType":null}`)); rec.Code != http.StatusOK {
		t.Fatalf("POST /perf: got %d, want 200; body: %s", rec.Code, rec.Body.String())
	}

	after := decode(t, do(t, srv, http.MethodGet, "/perf", nil))["current"].(map[string]any)
	if got := int(after["ctxSize"].(float64)); got != 8192 {
		t.Errorf("ctxSize: got %d, want 8192", got)
	}
	if after["gpuLayers"] != before["gpuLayers"] {
		t.Errorf("gpuLayers moved on a null: %v -> %v", before["gpuLayers"], after["gpuLayers"])
	}
	if after["kvCacheType"] != before["kvCacheType"] {
		t.Errorf("kvCacheType moved on a null: %v -> %v", before["kvCacheType"], after["kvCacheType"])
	}
}

// /active-model.json budgets the client's context against defaultCtx. A saved
// perf change that the UI has applied must move it, or the client keeps packing
// prompts for a window llama-server is no longer running.
func TestPerfChangeReachesActiveModel(t *testing.T) {
	srv, _ := newTestServer(t)

	if rec := do(t, srv, http.MethodPost, "/perf",
		strings.NewReader(`{"ctxSize":4096}`)); rec.Code != http.StatusOK {
		t.Fatalf("POST /perf: got %d, want 200", rec.Code)
	}

	body := decode(t, do(t, srv, http.MethodGet, "/active-model.json", nil))
	if got := int(body["defaultCtx"].(float64)); got != 4096 {
		t.Errorf("active-model.json defaultCtx after a /perf save: got %d, want 4096", got)
	}
}

func TestPerfRejectsOtherMethods(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodDelete, "/perf", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE /perf: got %d, want 405", rec.Code)
	}
}

// --- Jobs ------------------------------------------------------------------

// The jobs routes must win over the /llm/* proxy catch-all. If the proxy
// swallowed them, every job POST would be forwarded to llama.cpp, which has no
// such route, and detached generation would silently stop working.
func TestJobRoutesPrecedeProxy(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/llm/jobs/"+strings.Repeat("a", 32), nil)
	// 404 from OUR handler ("unknown job"), not 502 from the dead proxy.
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown job: got %d, want 404", rec.Code)
	}
	if body := decode(t, rec); body["error"] != "unknown job" {
		t.Errorf(`unknown job error: got %v, want "unknown job"`, body["error"])
	}

	// A path under /llm that is NOT a job route must reach the proxy, which
	// fails with 502 because the test upstream is dead.
	rec = do(t, srv, http.MethodGet, "/llm/props", nil)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("GET /llm/props: got %d, want 502 from the proxy", rec.Code)
	}
}

func TestJobCreateRejectsBadInput(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/llm/jobs", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /llm/jobs: got %d, want 405", rec.Code)
	}

	rec = do(t, srv, http.MethodPost, "/llm/jobs", strings.NewReader("not json"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /llm/jobs with bad JSON: got %d, want 400", rec.Code)
	}
}

// A job against a dead upstream must reach a terminal status and report the
// failure, rather than sitting at "running" forever.
func TestJobLifecycleAgainstDeadUpstream(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodPost, "/llm/jobs?thread=t1", strings.NewReader(`{"messages":[]}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST /llm/jobs: got %d, want 202 (body %s)", rec.Code, rec.Body)
	}
	created := decode(t, rec)
	id, _ := created["id"].(string)
	if len(id) != 32 {
		t.Fatalf("job id: got %q, want 32 hex chars", id)
	}
	if created["status"] != "running" {
		t.Errorf(`create status: got %v, want "running"`, created["status"])
	}

	// Poll until terminal. The upstream is unreachable, so this resolves fast.
	var final map[string]any
	for i := 0; i < 200; i++ {
		rec = do(t, srv, http.MethodGet, "/llm/jobs/"+id+"?from=0", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("poll: got %d, want 200", rec.Code)
		}
		final = decode(t, rec)
		if final["status"] != "running" {
			break
		}
	}
	if final["status"] != "error" {
		t.Fatalf("job against a dead upstream: got status %v, want error", final["status"])
	}
	if final["error"] == nil || final["error"] == "" {
		t.Error("a failed job carries no error message")
	}
	// The poll envelope must always carry the offset bookkeeping.
	for _, field := range []string{"id", "status", "size", "next"} {
		if _, ok := final[field]; !ok {
			t.Errorf("poll response is missing the %q field", field)
		}
	}
	// Chunks must be framed the way fileserver.ps1 frames them. js/03-generation.js
	// reads chunk_b64 and nothing else, and its failure mode for an unrecognised
	// payload is an infinite poll with no error — so pin the field name here
	// rather than discover it as a hung UI.
	if _, plain := final["chunk"]; plain {
		t.Error(`poll response carries "chunk"; the stock frontend only reads "chunk_b64"`)
	}

	// DELETE acknowledges and drops the job.
	rec = do(t, srv, http.MethodDelete, "/llm/jobs/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE: got %d, want 200", rec.Code)
	}
	if body := decode(t, rec); body["status"] != "deleted" {
		t.Errorf(`DELETE status: got %v, want "deleted"`, body["status"])
	}
	rec = do(t, srv, http.MethodGet, "/llm/jobs/"+id, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("polling a deleted job: got %d, want 404", rec.Code)
	}
}

// --- Model metadata --------------------------------------------------------

// Both endpoints must answer even when the upstream is unreachable, so the UI
// loads and shows its own connection error rather than failing on metadata.
func TestModelEndpointsSurviveDeadUpstream(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/active-model.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/active-model.json: got %d, want 200", rec.Code)
	}
	active := decode(t, rec)
	for _, field := range []string{"id", "name", "family", "ggufFile", "maxCtx", "defaultCtx", "thinkingFormat"} {
		if _, ok := active[field]; !ok {
			t.Errorf("/active-model.json is missing the %q field", field)
		}
	}

	rec = do(t, srv, http.MethodGet, "/models-list.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/models-list.json: got %d, want 200", rec.Code)
	}
	list := decode(t, rec)
	if _, ok := list["active"]; !ok {
		t.Error("/models-list.json is missing the active field")
	}
	if _, ok := list["models"]; !ok {
		t.Error("/models-list.json is missing the models field")
	}
}

// sha256Hex reproduces the legacy hash launch.bat wrote, so the migration test
// starts from a genuinely old-format secret rather than one this code minted.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// A proxied response must carry the same permissive CORS headers as every other
// response. ReverseProxy writes the upstream's headers straight through, so it
// never passes httpx.CommonHeaders — stripping the upstream's copies without
// setting our own leaves /llm, /search and /embed with no CORS at all, while the
// OPTIONS preflight for those same paths answers "*". A browser told the
// preflight passed and then handed a response with no Allow-Origin blocks it.
func TestProxiedResponsesCarryCORSHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// llama.cpp sets its own CORS headers; ours must win, not duplicate.
		w.Header().Set("Access-Control-Allow-Origin", "http://upstream.invalid")
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	srv, _ := newTestServer(t)
	defer srv.Shutdown()

	for _, route := range []string{"/llm/v1/models", "/search/x", "/embed/x"} {
		t.Run(route, func(t *testing.T) {
			cfg := config.Default()
			cfg.Path = filepath.Join(t.TempDir(), "config.toml")
			cfg.WebRoot = t.TempDir()
			cfg.DataDir = t.TempDir()
			cfg.LLMURL = upstream.URL
			cfg.SearchURL = upstream.URL
			cfg.EmbedURL = upstream.URL
			cfg.RequireAuth = false
			if err := os.WriteFile(filepath.Join(cfg.WebRoot, "chat.html"), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
			s, err := New(cfg, config.ModeRemote, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Shutdown()

			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, newReq(http.MethodGet, route, nil))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			got := rec.Header().Values("Access-Control-Allow-Origin")
			if len(got) != 1 {
				t.Fatalf("Allow-Origin appeared %d times (%v); duplicates are rejected by browsers", len(got), got)
			}
			if got[0] != "*" {
				t.Errorf("Allow-Origin = %q, want \"*\" (upstream's value must not survive)", got[0])
			}
			if m := rec.Header().Get("Access-Control-Allow-Methods"); m != "GET, POST, PUT, DELETE, OPTIONS" {
				t.Errorf("Allow-Methods = %q, upstream's value survived", m)
			}
		})
	}
}

// The preflight and the actual response must agree, or the browser blocks the
// result after being told the request was allowed.
func TestPreflightAndProxiedResponseAgreeOnCORS(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	cfg := config.Default()
	cfg.Path = filepath.Join(t.TempDir(), "config.toml")
	cfg.WebRoot = t.TempDir()
	cfg.DataDir = t.TempDir()
	cfg.LLMURL = upstream.URL
	cfg.RequireAuth = false
	if err := os.WriteFile(filepath.Join(cfg.WebRoot, "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(cfg, config.ModeRemote, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Shutdown()

	pre := httptest.NewRecorder()
	s.ServeHTTP(pre, newReq(http.MethodOptions, "/llm/v1/chat/completions", nil))
	post := httptest.NewRecorder()
	s.ServeHTTP(post, newReq(http.MethodGet, "/llm/v1/chat/completions", nil))

	if a, b := pre.Header().Get("Access-Control-Allow-Origin"), post.Header().Get("Access-Control-Allow-Origin"); a != b {
		t.Errorf("preflight says Allow-Origin %q but the response says %q", a, b)
	}
}

// Two saves landing together must not leave perf.toml and memory describing
// different settings. The file is the half that survives a restart, so such a
// disagreement outlives the request that caused it.
func TestPerfConcurrentSavesStayConsistent(t *testing.T) {
	srv, cfg := newTestServer(t)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		ctx := 1024 * (i + 1)
		wg.Add(1)
		go func() {
			defer wg.Done()
			do(t, srv, http.MethodPost, "/perf",
				strings.NewReader(fmt.Sprintf(`{"ctxSize":%d}`, ctx)))
		}()
	}
	wg.Wait()

	inMemory := decode(t, do(t, srv, http.MethodGet, "/perf", nil))["current"].(map[string]any)

	reloaded := cfg
	if err := reloaded.ApplyPerf(); err != nil {
		t.Fatal(err)
	}
	if got := int(inMemory["ctxSize"].(float64)); got != reloaded.CtxSize {
		t.Errorf("perf.toml says ctx_size %d but the running server says %d",
			reloaded.CtxSize, got)
	}
}

// --- Web search ------------------------------------------------------------

// /search/health must be answered here, not forwarded.
//
// js/11-search.js probes it before every search and abandons the search if it
// does not return 200. Upstream ran a relay on 11435 that answered /health
// itself; 1.6.0 deleted that process and answered the probe inside the file
// server. The Go port forwards /search to the search API directly, and the API
// has no /health — so without this route every search would stop at step one
// while the thing it depends on was working perfectly.
func TestSearchHealthIsAnsweredLocally(t *testing.T) {
	srv, _ := newTestServer(t) // SearchURL points at a port nothing listens on
	defer srv.Shutdown()

	rec := do(t, srv, http.MethodGet, "/search/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /search/health = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := decode(t, rec)["status"]; got != "ok" {
		t.Errorf(`status = %v, want "ok"`, got)
	}

	// Everything else is still a proxy hop. Nothing is listening in this test,
	// so a 502 here is the proof it was actually forwarded.
	if rec := do(t, srv, http.MethodPost, "/search/web_search", strings.NewReader(`{}`)); rec.Code != http.StatusBadGateway {
		t.Errorf("POST /search/web_search = %d, want 502 from the proxy", rec.Code)
	}
}

// An empty search_url means the feature is off, and the health probe has to say
// so rather than reporting a route that would 502 on use.
func TestSearchHealthReportsDisabled(t *testing.T) {
	srv, cfg := newTestServer(t)
	srv.Shutdown()

	cfg.SearchURL = ""
	s, err := New(cfg, config.ModeRemote, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Shutdown()

	if rec := do(t, s, http.MethodGet, "/search/health", nil); rec.Code != http.StatusBadGateway {
		t.Errorf("GET /search/health with search_url empty = %d, want 502", rec.Code)
	}
}

// --- Skills ----------------------------------------------------------------

func TestSkillsRoutesConformance(t *testing.T) {
	srv, cfg := newTestServer(t)
	defer srv.Shutdown()

	// Initial empty list
	rec := do(t, srv, http.MethodGet, "/skills", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /skills = %d, want 200", rec.Code)
	}
	resp := decode(t, rec)
	skillsList, ok := resp["skills"].([]any)
	if !ok || len(skillsList) != 0 {
		t.Errorf("expected empty skills array, got %v", resp["skills"])
	}

	// Create skill via PUT /skills/test-skill
	skillMarkdown := "---\nname: test-skill\nversion: 1.0.0\ndescription: Test skill\nscope: global\ntags: [unit, test]\n---\n# Test\n## System Prompt\nYou are a helpful test skill.\n"
	putRec := do(t, srv, http.MethodPut, "/skills/test-skill", strings.NewReader(fmt.Sprintf(`{"raw_markdown": %q}`, skillMarkdown)))
	if putRec.Code != http.StatusOK {
		t.Fatalf("PUT /skills/test-skill = %d, want 200 (body: %s)", putRec.Code, putRec.Body.String())
	}
	created := decode(t, putRec)
	if created["name"] != "test-skill" || created["version"] != "1.0.0" {
		t.Errorf("unexpected created skill payload: %+v", created)
	}

	// GET /skills should now list the skill
	rec = do(t, srv, http.MethodGet, "/skills", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /skills = %d, want 200", rec.Code)
	}
	resp = decode(t, rec)
	skillsList = resp["skills"].([]any)
	if len(skillsList) != 1 {
		t.Fatalf("expected 1 skill in list, got %d", len(skillsList))
	}

	// GET /skills/test-skill should return full detail
	rec = do(t, srv, http.MethodGet, "/skills/test-skill", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /skills/test-skill = %d, want 200", rec.Code)
	}
	skillDetail := decode(t, rec)
	if skillDetail["name"] != "test-skill" || skillDetail["system_prompt"] != "You are a helpful test skill." {
		t.Errorf("unexpected skill detail: %+v", skillDetail)
	}

	// Check file actually exists in cfg.SkillsDir
	onDisk, err := os.ReadFile(filepath.Join(cfg.SkillsDir, "test-skill", "SKILL.md"))
	if err != nil {
		t.Fatalf("SKILL.md missing from disk: %v", err)
	}
	if string(onDisk) != skillMarkdown {
		t.Errorf("content on disk did not match submitted markdown")
	}
}

// --- Mocking & Stories -----------------------------------------------------

func TestMockRoutesConformance(t *testing.T) {
	srv, cfg := newTestServer(t)
	defer srv.Shutdown()

	// Initial empty list
	rec := do(t, srv, http.MethodGet, "/mock/stories", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mock/stories = %d, want 200", rec.Code)
	}
	resp := decode(t, rec)
	storiesList, ok := resp["stories"].([]any)
	if !ok || len(storiesList) != 0 {
		t.Errorf("expected empty stories array, got %v", resp["stories"])
	}

	// Write a test story to disk
	storyMarkdown := "---\nid: conformance-story\nname: Conformance Story\n---\n## Step 1\nTest prompt\n- TextAssertion: test\n"
	_ = os.MkdirAll(cfg.StoriesDir, 0o755)
	if err := os.WriteFile(filepath.Join(cfg.StoriesDir, "conformance-story.story.md"), []byte(storyMarkdown), 0o644); err != nil {
		t.Fatalf("write story file failed: %v", err)
	}

	// GET /mock/stories should now list the story
	rec = do(t, srv, http.MethodGet, "/mock/stories", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mock/stories = %d, want 200", rec.Code)
	}
	resp = decode(t, rec)
	storiesList = resp["stories"].([]any)
	if len(storiesList) != 1 {
		t.Fatalf("expected 1 story in list, got %d", len(storiesList))
	}

	// GET /mock/stories/conformance-story
	rec = do(t, srv, http.MethodGet, "/mock/stories/conformance-story", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mock/stories/conformance-story = %d, want 200", rec.Code)
	}
	storyDetail := decode(t, rec)
	if storyDetail["id"] != "conformance-story" || storyDetail["name"] != "Conformance Story" {
		t.Errorf("unexpected story detail: %+v", storyDetail)
	}

	// POST /mock/replay with raw markdown
	replayReq := `{"raw_markdown": "---\nid: direct-story\nname: Direct Story\n---\n## Step 1\nDirect prompt\n"}`
	rec = do(t, srv, http.MethodPost, "/mock/replay", strings.NewReader(replayReq))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /mock/replay = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	runResult := decode(t, rec)
	if runResult["run_id"] == "" || runResult["status"] == "" {
		t.Errorf("expected valid run_id and status, got %+v", runResult)
	}
}


