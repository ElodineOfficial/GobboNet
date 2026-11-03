package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/auth"
)

// From a browser on this PC, and from a phone on the LAN.
func pc(t *testing.T, srv *Server, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := newReq(method, target, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:50000"
	req.Host = "localhost:9066"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func lan(t *testing.T, srv *Server, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := newReq(method, target, strings.NewReader(body))
	req.RemoteAddr = "192.168.1.20:50000"
	req.Host = "192.168.1.5:9066"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

type modList struct {
	Mods []struct {
		ID, Name, Hash, Error string
		Enabled               bool
		Position              int
		Files                 []struct{ Path, URL, Type, Name string }
	} `json:"mods"`
	CanManage bool   `json:"canManage"`
	Dir       string `json:"dir"`
}

func listMods(t *testing.T, rec *httptest.ResponseRecorder) modList {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mods: %d %s", rec.Code, rec.Body.String())
	}
	var l modList
	if err := json.Unmarshal(rec.Body.Bytes(), &l); err != nil {
		t.Fatal(err)
	}
	return l
}

func handMod(t *testing.T, srv *Server, id, order, files string, body map[string]string) {
	t.Helper()
	dir := filepath.Join(srv.cfg.DataDir, "mods", id)
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "mod.json"), []byte(`{"name":"`+id+`","order":`+order+`,"files":`+files+`}`), 0o644)
	for name, b := range body {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755)
		os.WriteFile(filepath.Join(dir, name), []byte(b), 0o644)
	}
}

func TestModsListServeAndToggle(t *testing.T) {
	srv, _ := newTestServer(t)
	handMod(t, srv, "theme", "10", `["theme.css"]`, map[string]string{"theme.css": ":root{--x:1}"})
	handMod(t, srv, "tools", "20", `["tools.js","notes.txt"]`, map[string]string{"tools.js": "window.t=1", "notes.txt": "hi", "secret.js": "unlisted"})

	l := listMods(t, pc(t, srv, http.MethodGet, "/mods", ""))
	if len(l.Mods) != 2 || l.Mods[0].ID != "theme" || l.Mods[1].ID != "tools" || l.Mods[0].Enabled || !l.CanManage {
		t.Fatalf("list: %+v", l)
	}
	if lanList := listMods(t, lan(t, srv, http.MethodGet, "/mods", "")); lanList.CanManage {
		t.Error("a LAN device must be told it cannot manage mods")
	}

	rec := pc(t, srv, http.MethodGet, "/mods/tools/files/tools.js", "")
	if rec.Code != http.StatusOK || rec.Body.String() != "window.t=1" || !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Errorf("serving a listed file: %d %q %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
	for _, bad := range []string{"/mods/tools/files/secret.js", "/mods/tools/files/mod.json", "/mods/tools/files/../theme/theme.css",
		"/mods/tools/files/%2e%2e/theme/theme.css", "/mods/..%2ftools/files/tools.js", "/mods/nope/files/x.js"} {
		if rec := pc(t, srv, http.MethodGet, bad, ""); rec.Code == http.StatusOK {
			t.Errorf("%s was served: %q", bad, rec.Body.String())
		}
	}

	// Switching on is for this PC; off is for anyone signed in.
	if rec := lan(t, srv, http.MethodPost, "/mods/tools/enable", `{"enabled":true}`); rec.Code != http.StatusForbidden {
		t.Errorf("a LAN device switched a mod on: %d", rec.Code)
	}
	if rec := pc(t, srv, http.MethodPost, "/mods/tools/enable", `{"enabled":true}`); rec.Code != http.StatusOK {
		t.Fatalf("enable from this PC: %d %s", rec.Code, rec.Body.String())
	}
	pc(t, srv, http.MethodPost, "/mods/theme/enable", `{"enabled":true}`)
	if rec := lan(t, srv, http.MethodPost, "/mods/tools/enable", `{"enabled":false}`); rec.Code != http.StatusOK {
		t.Errorf("a LAN device could not switch a mod off: %d", rec.Code)
	}
	l = listMods(t, pc(t, srv, http.MethodGet, "/mods", ""))
	if !l.Mods[0].Enabled || l.Mods[1].Enabled {
		t.Errorf("switching tools off touched theme: %+v", l.Mods)
	}
}

func TestModsWritesAreForThisPCOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	handMod(t, srv, "a", "10", `[]`, nil)
	handMod(t, srv, "b", "20", `[]`, nil)
	src := `{"name":"My extensions","styles":[{"name":"x","raw":"body{}"}],"scripts":[],"enabled":true}`
	for _, c := range []struct{ method, path, body string }{
		{http.MethodPut, "/mods/my-extensions/source", src},
		{http.MethodPost, "/mods/b/move", `{"delta":-1}`},
		{http.MethodDelete, "/mods/a", ""},
		{http.MethodPost, "/mods/a/restore", ""},
		{http.MethodPost, "/mods/import-legacy", `{"enabled":true,"styles":[{"raw":"p{}"}]}`},
	} {
		if rec := lan(t, srv, c.method, c.path, c.body); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "on the PC it runs on") {
			t.Errorf("LAN %s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(srv.cfg.DataDir, "mods", "my-extensions")); err == nil {
		t.Error("a refused write still created a mod")
	}

	if rec := pc(t, srv, http.MethodPut, "/mods/my-extensions/source", src); rec.Code != http.StatusOK {
		t.Fatalf("save from this PC: %d %s", rec.Code, rec.Body.String())
	}
	rec := lan(t, srv, http.MethodGet, "/mods/my-extensions/source", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"raw":"body{}"`) {
		t.Errorf("anyone signed in may read the source: %d %s", rec.Code, rec.Body.String())
	}
	if rec := pc(t, srv, http.MethodPut, "/mods/a/source", src); rec.Code != http.StatusConflict {
		t.Errorf("the editor overwrote a hand-made mod: %d", rec.Code)
	}

	pc(t, srv, http.MethodPost, "/mods/b/move", `{"delta":-5}`)
	if l := listMods(t, pc(t, srv, http.MethodGet, "/mods", "")); l.Mods[0].ID != "b" {
		t.Errorf("move: %+v", l.Mods)
	}

	if rec := pc(t, srv, http.MethodDelete, "/mods/a", ""); rec.Code != http.StatusOK {
		t.Fatalf("remove: %d", rec.Code)
	}
	if l := listMods(t, pc(t, srv, http.MethodGet, "/mods", "")); len(l.Mods) != 2 {
		t.Errorf("after remove: %+v", l.Mods)
	}
	if rec := pc(t, srv, http.MethodPost, "/mods/a/restore", ""); rec.Code != http.StatusOK {
		t.Fatalf("UNDO: %d %s", rec.Code, rec.Body.String())
	}
	if l := listMods(t, pc(t, srv, http.MethodGet, "/mods", "")); len(l.Mods) != 3 {
		t.Errorf("after UNDO: %+v", l.Mods)
	}
}

func TestTheOldExtensionsMigrateToMyExtensions(t *testing.T) {
	srv, _ := newTestServer(t)
	blob := `{"enabled":true,"styles":[{"name":"Theme","url":"","raw":"body{color:red}"},{"name":"","url":"","raw":""}],
	          "scripts":[{"name":"Remote","url":"https://example.com/a.js","raw":""}]}`
	rec := pc(t, srv, http.MethodPost, "/mods/import-legacy", blob)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"created":true`) || !strings.Contains(rec.Body.String(), `"id":"my-extensions"`) {
		t.Fatalf("import: %d %s", rec.Code, rec.Body.String())
	}
	if rec := pc(t, srv, http.MethodPost, "/mods/import-legacy", blob); !strings.Contains(rec.Body.String(), `"created":false`) {
		t.Errorf("a second import of the same blob made a copy: %s", rec.Body.String())
	}
	l := listMods(t, pc(t, srv, http.MethodGet, "/mods", ""))
	if len(l.Mods) != 1 || l.Mods[0].Name != "My extensions" || !l.Mods[0].Enabled || len(l.Mods[0].Files) != 2 {
		t.Fatalf("My extensions: %+v", l.Mods)
	}
	css := l.Mods[0].Files[0]
	if rec := pc(t, srv, http.MethodGet, "/mods/my-extensions/files/"+css.Path, ""); rec.Body.String() != "body{color:red}" {
		t.Errorf("the migrated stylesheet: %q", rec.Body.String())
	}
	if l.Mods[0].Files[1].URL != "https://example.com/a.js" || l.Mods[0].Files[1].Type != "js" {
		t.Errorf("the URL entry was not kept: %+v", l.Mods[0].Files[1])
	}
}

func TestModRoutesRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t)
	handMod(t, srv, "theme", "10", `["theme.css"]`, map[string]string{"theme.css": "x"})
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/mods", ""},
		{http.MethodGet, "/mods/theme/files/theme.css", ""},
		{http.MethodPost, "/mods/theme/enable", `{"enabled":true}`},
		{http.MethodPost, "/mods/import-legacy", `{}`},
	} {
		if rec := pc(t, srv, c.method, c.path, c.body); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without signing in: %d", c.method, c.path, rec.Code)
		}
	}
}
