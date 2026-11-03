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

	"github.com/ElodineOfficial/GobboNet/internal/auth"
)

func hexSum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

type endorsedSite struct {
	*httptest.Server
	files map[string]string
}

// endorsedServer: a test server whose mod_list_url is a TLS test site
// serving a list of two mods, one of them 18+, plus their files.
func endorsedServer(t *testing.T) (*Server, *endorsedSite) {
	t.Helper()
	srv, _ := newTestServer(t)
	site := &endorsedSite{files: map[string]string{}}
	site.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := site.files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(b))
	}))
	t.Cleanup(site.Close)
	site.setList(t, "1.0", "body{color:hotpink}")
	srv.cfg.ModListURL = site.URL + "/gobbonet_mod_list.json"
	srv.modHTTP = site.Client()
	return srv, site
}

func (site *endorsedSite) setList(t *testing.T, neonVersion, css string) {
	t.Helper()
	site.files["/neon.css"] = css
	site.files["/spicy.txt"] = "window.spicy=1"
	list := map[string]any{"schema_version": 1, "min_client": "1.7.0", "mods": []any{
		map[string]any{"id": "neon", "name": "Neon", "version": neonVersion, "author": "Elodine",
			"files": []any{map[string]any{"path": "neon.css", "url": site.URL + "/neon.css", "sha256": hexSum(css)}}},
		map[string]any{"id": "spicy", "name": "Spicy", "version": "1", "adult": true,
			"files": []any{map[string]any{"path": "spicy.js", "url": site.URL + "/spicy.txt", "sha256": hexSum("window.spicy=1")}}},
		map[string]any{"id": "nopin", "name": "No pin", "version": "1",
			"files": []any{map[string]any{"path": "x.css", "url": site.URL + "/neon.css"}}},
	}}
	b, _ := json.Marshal(list)
	site.files["/gobbonet_mod_list.json"] = string(b)
}

type modListResp struct {
	CanManage bool     `json:"canManage"`
	Off       bool     `json:"off"`
	Error     string   `json:"error"`
	Source    string   `json:"source"`
	Notes     []string `json:"notes"`
	Mods      []struct {
		ID, Name, Version, State, Installed string
		Adult                               bool
	} `json:"mods"`
}

func getModList(t *testing.T, rec *httptest.ResponseRecorder) modListResp {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mod-list.json: %d %s", rec.Code, rec.Body.String())
	}
	var r modListResp
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestEndorsedListInstallAndUpdate(t *testing.T) {
	srv, site := endorsedServer(t)
	l := getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json", ""))
	if !l.CanManage || l.Source != "remote" || len(l.Mods) != 2 || l.Mods[0].State != "new" || !l.Mods[1].Adult {
		t.Fatalf("list: %+v", l)
	}
	if !strings.Contains(strings.Join(l.Notes, "\n"), "nopin") {
		t.Errorf("the unpinned entry should be left out with a note: %v", l.Notes)
	}

	rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"neon"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"enabled":true`) {
		t.Fatalf("install: %d %s", rec.Code, rec.Body.String())
	}
	mods := listMods(t, pc(t, srv, http.MethodGet, "/mods", ""))
	if len(mods.Mods) != 1 || mods.Mods[0].ID != "neon" || !mods.Mods[0].Enabled {
		t.Fatalf("after install: %+v", mods)
	}
	if got := pc(t, srv, http.MethodGet, "/mods/neon/files/neon.css", ""); got.Body.String() != "body{color:hotpink}" {
		t.Errorf("served %q", got.Body.String())
	}
	if l := getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json", "")); l.Mods[0].State != "installed" || l.Mods[0].Installed != "1.0" {
		t.Errorf("after install the list says %+v", l.Mods[0])
	}

	// Switched off by the user, then a new version is published.
	pc(t, srv, http.MethodPost, "/mods/neon/enable", `{"enabled":false}`)
	site.setList(t, "1.1", "body{color:cyan}")
	l = getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json?refresh=1", ""))
	if l.Mods[0].State != "update" || l.Mods[0].Installed != "1.0" || l.Mods[0].Version != "1.1" {
		t.Fatalf("update offered: %+v", l.Mods[0])
	}
	rec = pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"neon"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"updated":true`) || !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}
	if m := listMods(t, pc(t, srv, http.MethodGet, "/mods", "")); m.Mods[0].Enabled {
		t.Error("an update must keep the user's off switch")
	}
}

func TestEndorsedInstallIsForThisPCOnlyAndChecked(t *testing.T) {
	srv, site := endorsedServer(t)
	// A phone can read the list, told it cannot install...
	if l := getModList(t, lan(t, srv, http.MethodGet, "/mod-list.json", "")); l.CanManage || len(l.Mods) != 2 {
		t.Errorf("LAN list: %+v", l)
	}
	// ...and cannot.
	if rec := lan(t, srv, http.MethodPost, "/mod-list/install", `{"id":"neon"}`); rec.Code != http.StatusForbidden {
		t.Errorf("install from the LAN: %d", rec.Code)
	}
	if rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"nopin"}`); rec.Code != http.StatusNotFound {
		t.Errorf("an unpinned entry is not installable: %d", rec.Code)
	}
	if rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"../x"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("a bad id: %d", rec.Code)
	}
	// The site's file changes after the list was published: refused, one line.
	site.files["/neon.css"] = "body{background:url(//evil)}"
	rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"neon"}`)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "does not match the checksum") {
		t.Errorf("tampered file: %d %s", rec.Code, rec.Body.String())
	}
	if m := listMods(t, pc(t, srv, http.MethodGet, "/mods", "")); len(m.Mods) != 0 {
		t.Errorf("nothing should be installed: %+v", m)
	}
	// A hand-made folder of the same name is never overwritten.
	os.MkdirAll(filepath.Join(srv.cfg.DataDir, "mods", "spicy"), 0o755)
	os.WriteFile(filepath.Join(srv.cfg.DataDir, "mods", "spicy", "mod.json"), []byte(`{"files":[]}`), 0o644)
	if l := getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json", "")); l.Mods[1].State != "taken" {
		t.Errorf("hand-made folder: %+v", l.Mods[1])
	}
	if rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"spicy"}`); rec.Code != http.StatusBadGateway ||
		!strings.Contains(rec.Body.String(), "did not come from the endorsed list") {
		t.Errorf("overwrite: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEndorsedListOffAndUnreachable(t *testing.T) {
	srv, site := endorsedServer(t)
	srv.cfg.ModListURL = ""
	if l := getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json", "")); !l.Off || len(l.Mods) != 0 {
		t.Errorf("off: %+v", l)
	}
	// Reachable once, then gone: the last good copy is shown, and says so.
	srv.cfg.ModListURL = site.URL + "/gobbonet_mod_list.json"
	getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json", ""))
	delete(site.files, "/gobbonet_mod_list.json")
	l := getModList(t, pc(t, srv, http.MethodGet, "/mod-list.json?refresh=1", ""))
	if l.Source != "cache" || len(l.Mods) != 2 {
		t.Errorf("cache: %+v", l)
	}
	// Never reachable, no copy: a plain explanation, not an error page.
	srv2, _ := newTestServer(t)
	srv2.cfg.ModListURL = site.URL + "/never.json"
	srv2.modHTTP = site.Client()
	if l := getModList(t, pc(t, srv2, http.MethodGet, "/mod-list.json", "")); l.Error == "" || len(l.Mods) != 0 {
		t.Errorf("unreachable: %+v", l)
	}
}

func TestEndorsedRoutesRequireAuth(t *testing.T) {
	srv, _ := endorsedServer(t)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret
	if rec := pc(t, srv, http.MethodGet, "/mod-list.json", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("list: %d", rec.Code)
	}
	if rec := pc(t, srv, http.MethodPost, "/mod-list/install", `{"id":"neon"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("install: %d", rec.Code)
	}
}
