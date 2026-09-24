package state

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// statePath returns a fresh data dir with the shared state file path in it.
func statePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "state.json")
}

func call(t *testing.T, path, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	Handle(rec, r, path, testKey)
	return rec
}

// An unknown subpath used to fall through to the whole-document branch, so a
// PUT to an invented route replaced the entire history and reported success.
// That is the failure this test exists to make impossible, and the GET half
// matters too: it served the whole file to a caller that asked for a part.
func TestUnknownSubpathIsNotTheWholeDocument(t *testing.T) {
	sp := statePath(t)
	const history = `{"threads":[{"id":"a","messages":[1,2,3]}]}`
	if rec := call(t, sp, http.MethodPost, "/state", history); rec.Code != http.StatusOK {
		t.Fatalf("seed POST /state: got %d, want 200", rec.Code)
	}

	for _, target := range []string{
		"/state/anything",
		"/state/info/extra",
		"/state/profiles/extra",
		"/state/threads",
		"/state/threads/",
		"/state/threads/abc/nonsense",
		"/state/meta/extra",
	} {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete} {
			rec := call(t, sp, method, target, `{"threads":[]}`)
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s: got %d, want 404", method, target, rec.Code)
			}
		}
	}

	// The seeded document must be untouched, byte for byte.
	got := storedBytes(t, sp)
	if string(got) != history {
		t.Fatalf("state was modified by a request to an unknown subpath:\n got %s\nwant %s", got, history)
	}
}

// The routes that do exist must keep working exactly as before.
func TestKnownRoutesStillAnswer(t *testing.T) {
	sp := statePath(t)
	const payload = `{"threads":[]}`

	if rec := call(t, sp, http.MethodPost, "/state", payload); rec.Code != http.StatusOK {
		t.Fatalf("POST /state: got %d, want 200", rec.Code)
	}
	if rec := call(t, sp, http.MethodGet, "/state", ""); rec.Code != http.StatusOK ||
		rec.Body.String() != payload {
		t.Errorf("GET /state: got %d %q, want 200 %q", rec.Code, rec.Body.String(), payload)
	}
	if rec := call(t, sp, http.MethodGet, "/state/info", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /state/info: got %d, want 200", rec.Code)
	}
	if rec := call(t, sp, http.MethodGet, "/state/profiles", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /state/profiles: got %d, want 200", rec.Code)
	}
	if rec := call(t, sp, http.MethodDelete, "/state", ""); rec.Code != http.StatusOK {
		t.Errorf("DELETE /state: got %d, want 200", rec.Code)
	}
}
