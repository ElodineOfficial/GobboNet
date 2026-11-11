package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fromSite is pc() with the headers a browser adds: the page's Origin and
// where the fetch came from.
func fromSite(t *testing.T, srv *Server, method, target, body, origin, site string) *httptest.ResponseRecorder {
	t.Helper()
	req := newReq(method, target, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:50000"
	req.Host = "localhost:9066"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if site != "" {
		req.Header.Set("Sec-Fetch-Site", site)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

// 1.8.0, from Larck Drakengold's 4db2469: POST /mods/<id>/entry-enable
// switches one My extensions entry, on the same terms as a mod's own switch.
func TestModEntrySwitch(t *testing.T) {
	srv, _ := newTestServer(t)
	src := `{"name":"My extensions","styles":[{"name":"A","raw":"a{}"},{"name":"B","url":"https://cdn.example/b.css"}],"scripts":[],"enabled":true}`
	if rec := pc(t, srv, http.MethodPut, "/mods/my-extensions/source", src); rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}

	if rec := lan(t, srv, http.MethodPost, "/mods/my-extensions/entry-enable", `{"kind":"css","index":0,"enabled":false}`); rec.Code != http.StatusOK {
		t.Fatalf("a phone may switch an entry off: %d %s", rec.Code, rec.Body.String())
	}
	body := pc(t, srv, http.MethodGet, "/mods", "").Body.String()
	if !strings.Contains(body, `"path":"style-1.css","type":"css","name":"A","size":3,"entryIndex":0,"enabled":false`) ||
		!strings.Contains(body, `"url":"https://cdn.example/b.css","type":"css","name":"B","entryIndex":1,"enabled":true`) {
		t.Errorf("the list says which entry is off: %s", body)
	}
	if rec := lan(t, srv, http.MethodPost, "/mods/my-extensions/entry-enable", `{"kind":"css","index":0,"enabled":true}`); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "on the PC it runs on") {
		t.Errorf("a phone may not switch an entry on: %d %s", rec.Code, rec.Body.String())
	}
	if rec := pc(t, srv, http.MethodPost, "/mods/my-extensions/entry-enable", `{"kind":"css","index":0,"enabled":true}`); rec.Code != http.StatusOK {
		t.Errorf("this PC may: %d %s", rec.Code, rec.Body.String())
	}
	src2 := pc(t, srv, http.MethodGet, "/mods/my-extensions/source", "").Body.String()
	if !strings.Contains(src2, `"enabled":true,"index":0`) || !strings.Contains(src2, `"enabled":true,"index":1`) {
		t.Errorf("the editor reads each entry's switch and saved number: %s", src2)
	}

	for _, c := range []struct {
		body string
		code int
	}{
		{`{"kind":"css","index":7,"enabled":false}`, http.StatusNotFound},
		{`{"kind":"asset","index":0,"enabled":false}`, http.StatusNotFound},
		{`not json`, http.StatusBadRequest},
	} {
		if rec := pc(t, srv, http.MethodPost, "/mods/my-extensions/entry-enable", c.body); rec.Code != c.code {
			t.Errorf("%s: got %d, want %d", c.body, rec.Code, c.code)
		}
	}
	if rec := pc(t, srv, http.MethodGet, "/mods/my-extensions/entry-enable", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", rec.Code)
	}
}

// Another website open on this PC is "on this PC" too. With a password its
// request has no session and stops at the gate; with none (the test server
// has none) the mods routes that can make code run must still refuse it.
func TestModCodeWritesRefuseOtherSites(t *testing.T) {
	srv, _ := newTestServer(t)
	handMod(t, srv, "a", "10", `["a.css"]`, map[string]string{"a.css": "x"})
	handMod(t, srv, "b", "20", `[]`, nil)
	src := `{"name":"My extensions","styles":[{"name":"x","raw":"body{}"}],"scripts":[],"enabled":true}`
	pc(t, srv, http.MethodPut, "/mods/my-extensions/source", src)

	writes := []struct{ method, path, body string }{
		{http.MethodPut, "/mods/my-extensions/source", `{"name":"My extensions","styles":[{"raw":"evil{}"}],"scripts":[],"enabled":true}`},
		{http.MethodPost, "/mods/a/enable", `{"enabled":true}`},
		{http.MethodPost, "/mods/my-extensions/entry-enable", `{"kind":"css","index":0,"enabled":true}`},
		{http.MethodPost, "/mods/b/move", `{"delta":-1}`},
		{http.MethodPost, "/mods/import-legacy", `{"enabled":true,"styles":[{"raw":"p{}"}]}`},
		{http.MethodPost, "/mod-list/install", `{"id":"neon"}`},
		{http.MethodDelete, "/mods/a", ""},
		{http.MethodPost, "/mods/a/restore", ""},
	}
	for _, c := range writes {
		for _, h := range []struct{ origin, site string }{
			{"https://evil.example", "cross-site"},
			{"https://evil.example", ""},
			{"", "cross-site"},
			{"null", ""},
		} {
			rec := fromSite(t, srv, c.method, c.path, c.body, h.origin, h.site)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "not from another website") {
				t.Errorf("%s %s from %q/%q: %d %s", c.method, c.path, h.origin, h.site, rec.Code, rec.Body.String())
			}
		}
	}
	if got := pc(t, srv, http.MethodGet, "/mods/my-extensions/source", "").Body.String(); strings.Contains(got, "evil") {
		t.Errorf("a refused write landed: %s", got)
	}

	// GobboNet's own page, and a tool with no Origin at all, still work.
	if rec := fromSite(t, srv, http.MethodPost, "/mods/a/enable", `{"enabled":true}`, "http://localhost:9066", "same-origin"); rec.Code != http.StatusOK {
		t.Errorf("own page: %d %s", rec.Code, rec.Body.String())
	}
	if rec := pc(t, srv, http.MethodPost, "/mods/my-extensions/entry-enable", `{"kind":"css","index":0,"enabled":true}`); rec.Code != http.StatusOK {
		t.Errorf("no Origin (curl): %d %s", rec.Code, rec.Body.String())
	}
	// Switching OFF is never the dangerous direction, and stays open, as before.
	if rec := fromSite(t, srv, http.MethodPost, "/mods/a/enable", `{"enabled":false}`, "https://evil.example", "cross-site"); rec.Code != http.StatusOK {
		t.Errorf("switching off: %d %s", rec.Code, rec.Body.String())
	}
}
