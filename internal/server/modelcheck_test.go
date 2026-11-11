package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
)

// CHECK FILE (1.8.0, #67).

func checkServer(t *testing.T, entries ...catalog.Entry) (*Server, string) {
	t.Helper()
	srv, cfg := newTestServer(t)
	os.MkdirAll(cfg.ModelDir, 0o755)
	srv.catMu.Lock()
	srv.cat, srv.catErr = &catalog.Catalog{Entries: entries}, nil
	srv.catMu.Unlock()
	return srv, cfg.ModelDir
}

func sumOf(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func postCheck(t *testing.T, srv *Server, body string) (int, modelCheckStatus) {
	t.Helper()
	rec := do(t, srv, http.MethodPost, "/model-check", strings.NewReader(body))
	var st modelCheckStatus
	json.Unmarshal(rec.Body.Bytes(), &st)
	if st.Message == "" {
		var e map[string]any
		if json.Unmarshal(rec.Body.Bytes(), &e) == nil {
			if m, ok := e["error"].(string); ok {
				st.Message = m
			}
		}
	}
	return rec.Code, st
}

func waitCheck(t *testing.T, srv *Server) modelCheckStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var st modelCheckStatus
		json.Unmarshal(do(t, srv, http.MethodGet, "/model-check", nil).Body.Bytes(), &st)
		if st.State != "running" {
			return st
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the check never finished")
	return modelCheckStatus{}
}

func TestCheckFileMatchesTheCataloguePin(t *testing.T) {
	data := []byte("GGUF" + strings.Repeat("w", 100000))
	srv, dir := checkServer(t,
		catalog.Entry{Index: 1, Display: "Good", File: "good.gguf", SHA256: strings.ToUpper(sumOf(data))},
		catalog.Entry{Index: 2, Display: "Cut", File: "cut.gguf", SHA256: sumOf(data)})
	os.WriteFile(filepath.Join(dir, "good.gguf"), data, 0o600)
	os.WriteFile(filepath.Join(dir, "cut.gguf"), data[:len(data)/2], 0o600)

	if code, st := postCheck(t, srv, `{"index":1}`); code != http.StatusAccepted || st.State != "running" {
		t.Fatalf("POST good: %d %+v", code, st)
	}
	st := waitCheck(t, srv)
	if st.Result != "match" || st.Got != sumOf(data) || !strings.Contains(st.Message, "complete and unchanged") || st.Percent != 100 {
		t.Errorf("good file: %+v", st)
	}

	postCheck(t, srv, `{"index":2,"source":"catalogue"}`)
	st = waitCheck(t, srv)
	if st.Result != "mismatch" || st.Expected == st.Got || !strings.Contains(st.Message, "download it again") {
		t.Errorf("a file cut in half: %+v", st)
	}
}

func TestCheckFileWithNoPinNeedsHuggingFace(t *testing.T) {
	data := []byte("GGUF" + strings.Repeat("x", 5000))
	var asked []string
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		w.Write([]byte("oid sha256:" + sumOf(data) + "\n"))
	}))
	defer hf.Close()
	srv, dir := checkServer(t, catalog.Entry{Index: 3, Display: "NoPin", Repo: "org/r", File: "nopin.gguf"})
	srv.check.hostBase = hf.URL
	os.WriteFile(filepath.Join(dir, "nopin.gguf"), data, 0o600)

	code, st := postCheck(t, srv, `{"index":3}`)
	if code != http.StatusOK || st.State != "done" || st.Result != "no-reference" || !strings.Contains(st.Message, "huggingface.co") {
		t.Fatalf("no pin: %d %+v, want an immediate no-reference that names huggingface.co", code, st)
	}
	if len(asked) != 0 {
		t.Fatalf("the offline check asked HuggingFace: %v", asked)
	}

	if code, _ := postCheck(t, srv, `{"index":3,"source":"huggingface"}`); code != http.StatusAccepted {
		t.Fatalf("Ask HuggingFace: %d", code)
	}
	st = waitCheck(t, srv)
	if st.Result != "match" || !strings.Contains(st.Message, "HuggingFace records") {
		t.Errorf("Ask HuggingFace: %+v", st)
	}
	if len(asked) != 1 || asked[0] != "/org/r/raw/main/nopin.gguf" {
		t.Errorf("asked %v, want one request for this file's record", asked)
	}
}

func TestCheckFileReportsACatalogueAndHuggingFaceThatDisagree(t *testing.T) {
	hf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("oid sha256:" + strings.Repeat("b", 64) + "\n"))
	}))
	defer hf.Close()
	srv, dir := checkServer(t, catalog.Entry{Index: 4, Display: "Both", Repo: "o/r", File: "both.gguf", SHA256: strings.Repeat("a", 64)})
	srv.check.hostBase = hf.URL
	os.WriteFile(filepath.Join(dir, "both.gguf"), []byte("GGUF"), 0o600)
	postCheck(t, srv, `{"index":4,"source":"huggingface"}`)
	if st := waitCheck(t, srv); st.Result != "disagree" || st.Expected != strings.Repeat("a", 64) || st.Got != strings.Repeat("b", 64) {
		t.Errorf("disagreeing references: %+v", st)
	}
}

func TestCheckFileRefusals(t *testing.T) {
	srv, dir := checkServer(t,
		catalog.Entry{Index: 5, Display: "Absent", File: "absent.gguf", SHA256: strings.Repeat("a", 64)},
		catalog.Entry{Index: 6, Display: "Escape", File: "../outside.gguf", SHA256: strings.Repeat("a", 64)})
	os.WriteFile(filepath.Join(filepath.Dir(dir), "outside.gguf"), []byte("x"), 0o600)
	for _, c := range []struct {
		body string
		code int
	}{
		{`{"index":5}`, http.StatusNotFound},            // not installed
		{`{"index":6}`, http.StatusBadRequest},          // a catalogue naming a path
		{`{"index":99}`, http.StatusNotFound},           // no such entry
		{`{"file":"good.gguf"}`, http.StatusBadRequest}, // a name, not an index
		{`{"index":5,"source":"elsewhere"}`, http.StatusBadRequest},
		{`not json`, http.StatusBadRequest},
	} {
		if code, st := postCheck(t, srv, c.body); code != c.code {
			t.Errorf("POST %s: %d (%s), want %d", c.body, code, st.Message, c.code)
		}
	}
	req := newReq(http.MethodPost, "/model-check", strings.NewReader(`{"index":5}`))
	req.Header.Set("Origin", "https://elsewhere.example")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-site POST: %d, want 403", rec.Code)
	}
	if rec := do(t, srv, http.MethodDelete, "/model-check", nil); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE: %d", rec.Code)
	}

	none, _ := newTestServer(t)
	none.catMu.Lock()
	none.cat = nil
	none.catMu.Unlock()
	if code, _ := postCheck(t, none, `{"index":1}`); code != http.StatusConflict {
		t.Errorf("no catalogue loaded: %d, want 409 (and no network fetch to load one)", code)
	}
}
