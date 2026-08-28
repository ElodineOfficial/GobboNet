package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Proxy rewrites the path, stripping the prefix and forwarding to the upstream.
func TestProxyPathRewrite(t *testing.T) {
	upstreamHit := false
	upstreamPath := ""
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
		upstreamPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	p, err := New("/llm", ts.URL, "")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}

	req := httptest.NewRequest("POST", "/llm/v1/completions", nil)
	rr := httptest.NewRecorder()

	p.ServeHTTP(rr, req)

	if !upstreamHit {
		t.Fatal("Upstream was not hit")
	}
	if upstreamPath != "/v1/completions" {
		t.Errorf("Path rewrite failed: got %q, want %q", upstreamPath, "/v1/completions")
	}
}

// API key must be injected into the upstream request to authenticate it.
func TestProxyAPIKeyInjection(t *testing.T) {
	var authHeader string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	p, _ := New("/llm", ts.URL, "secret-key")
	req := httptest.NewRequest("POST", "/llm/chat", nil)
	p.ServeHTTP(httptest.NewRecorder(), req)

	if authHeader != "Bearer secret-key" {
		t.Errorf("API key injection failed: got %q, want 'Bearer secret-key'", authHeader)
	}
}

// The GobboNet session cookie must be stripped before forwarding to the upstream
// so it doesn't leak to potentially external services.
func TestProxyCookieStripped(t *testing.T) {
	var cookieHeader string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookieHeader = r.Header.Get("Cookie")
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	p, _ := New("/llm", ts.URL, "")
	req := httptest.NewRequest("GET", "/llm/models", nil)
	req.Header.Set("Cookie", "gobbonet_session=secret_token; other=1")
	p.ServeHTTP(httptest.NewRecorder(), req)

	if cookieHeader != "" {
		t.Errorf("Cookie was not stripped: got %q", cookieHeader)
	}
}

// X-Forwarded-For must NOT be added to protect user privacy.
func TestProxyXForwardedForOmitted(t *testing.T) {
	var xff string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		xff = r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	p, _ := New("/llm", ts.URL, "")
	req := httptest.NewRequest("GET", "/llm/models", nil)
	req.RemoteAddr = "192.168.1.5:1234"
	p.ServeHTTP(httptest.NewRecorder(), req)

	if xff != "" {
		t.Errorf("X-Forwarded-For was leaked: got %q", xff)
	}
}

// CORS headers must be added on the response so web UI requests succeed.
func TestProxySetsCORSHeaders(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	p, _ := New("/llm", ts.URL, "")
	req := httptest.NewRequest("GET", "/llm/models", nil)
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)

	if cors := rr.Header().Get("Access-Control-Allow-Origin"); cors != "*" {
		t.Errorf("CORS Allow-Origin missing or wrong: got %q", cors)
	}
}

// A down upstream must return 502 Bad Gateway with JSON error format used by GobboNet.
func TestProxyUpstreamDown(t *testing.T) {
	// Create an empty proxy to an unreachable port
	p, _ := New("/llm", "http://127.0.0.1:0", "")
	
	req := httptest.NewRequest("GET", "/llm/models", nil)
	rr := httptest.NewRecorder()
	
	p.ServeHTTP(rr, req)
	
	res := rr.Result()
	if res.StatusCode != http.StatusBadGateway {
		t.Errorf("Upstream down: got status %d, want %d", res.StatusCode, http.StatusBadGateway)
	}
	
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "upstream unreachable") {
		t.Errorf("Upstream down response missing expected error text, got: %s", string(body))
	}
}
