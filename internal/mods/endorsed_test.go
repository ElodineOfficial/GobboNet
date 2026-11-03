package mods

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// site serves files by path; hits counts requests.
type site struct {
	*httptest.Server
	files map[string]string
	hits  atomic.Int32
}

func newSite(t *testing.T, files map[string]string) *site {
	t.Helper()
	st := &site{files: files}
	st.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st.hits.Add(1)
		body, ok := st.files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(body))
	}))
	t.Cleanup(st.Close)
	return st
}

func neonEntry(base, version, css, js string) ListEntry {
	return ListEntry{ID: "neon", Name: "Neon", Version: version, Author: "Elodine",
		Files: []ListFile{
			{Path: "neon.css", URL: base + "/neon.css", SHA256: sum(css)},
			// The site hands scripts out as .txt; the path says what it is here.
			{Path: "js/neon.js", URL: base + "/neon.txt", SHA256: sum(js)},
		}}
}

func listJSON(t *testing.T, entries ...ListEntry) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"schema_version": 1, "min_client": "1.7.0", "mods": entries})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseListKeepsGoodEntriesAndSaysWhyOthersAreLeftOut(t *testing.T) {
	good := neonEntry("https://x", "1.0", "a", "b")
	noSha := neonEntry("https://x", "1.0", "a", "b")
	noSha.ID, noSha.Files[0].SHA256 = "no-sha", ""
	http1 := neonEntry("http://x", "1.0", "a", "b")
	http1.ID = "plain-http"
	escape := neonEntry("https://x", "1.0", "a", "b")
	escape.ID, escape.Files[0].Path = "escape", "../../evil.css"
	exe := neonEntry("https://x", "1.0", "a", "b")
	exe.ID, exe.Files[0].Path = "exe", "run.exe"
	future := neonEntry("https://x", "1.0", "a", "b")
	future.ID, future.MinClient = "future", "9.0.0"
	char := ListEntry{ID: "a-character", Type: "character", Name: "Gob", Version: "1"}
	l, notes, err := ParseList(listJSON(t, good, noSha, http1, escape, exe, future, char, good), "1.7.9")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range l.Mods {
		got = append(got, e.ID)
	}
	if strings.Join(got, ",") != "neon,future" {
		t.Fatalf("kept %v", got)
	}
	if l.Mods[1].Problem == "" {
		t.Error("a mod for a newer GobboNet is listed with the reason it cannot install")
	}
	all := strings.Join(notes, "\n")
	for _, want := range []string{`"no-sha"`, "SHA-256", `"plain-http"`, "https", `"escape"`, `"exe"`, "second \"neon\"", "not mods"} {
		if !strings.Contains(all, want) {
			t.Errorf("notes should mention %s:\n%s", want, all)
		}
	}
	if _, _, err := ParseList([]byte(`{"schema_version":2,"mods":[]}`), "1.7.9"); err == nil {
		t.Error("a list in a newer format must be refused, not misread")
	}
	if _, _, err := ParseList([]byte(`{"schema_version":1,"min_client":"2.0.0","mods":[]}`), "1.7.9"); err == nil {
		t.Error("a list for a newer GobboNet must be refused")
	}
}

func TestInstallChecksEveryFileThenSwitchesOnOnce(t *testing.T) {
	css, js := "body{color:hotpink}", "window.neon=1"
	st := newSite(t, map[string]string{"/neon.css": css, "/neon.txt": js})
	s := Open(t.TempDir())
	e := neonEntry(st.URL, "1.0", css, js)

	res, err := s.Install(e, "https://list", st.Client())
	if err != nil || res.Updated || !res.Enabled {
		t.Fatalf("%+v %v", res, err)
	}
	m, err := s.Get("neon")
	if err != nil || m.Error != "" || !m.Enabled || m.Origin != "endorsed" || m.Source != "https://list" || len(m.Files) != 2 {
		t.Fatalf("installed mod: %+v %v", m, err)
	}
	if b, _ := os.ReadFile(filepath.Join(s.Dir(), "neon", "js", "neon.js")); string(b) != js {
		t.Errorf("the .txt the site serves should be saved as js/neon.js, got %q", b)
	}
	if m.Files[1].Type != "js" {
		t.Errorf("file type %q", m.Files[1].Type)
	}
	if v, ok := s.InstalledFrom("neon"); !ok || v != "1.0" {
		t.Errorf("InstalledFrom %q %v", v, ok)
	}

	// The user switches it off; an update keeps it off.
	if err := s.SetEnabled("neon", false); err != nil {
		t.Fatal(err)
	}
	css2 := "body{color:cyan}"
	st.files["/neon.css"] = css2
	res, err = s.Install(neonEntry(st.URL, "1.1", css2, js), "https://list", st.Client())
	if err != nil || !res.Updated || res.From != "1.0" || res.Enabled {
		t.Fatalf("update: %+v %v", res, err)
	}
	if m, _ := s.Get("neon"); m.Enabled || m.Version != "1.1" {
		t.Errorf("the update must keep the user's off switch: %+v", m)
	}
	if b, _ := os.ReadFile(filepath.Join(s.Dir(), "neon", "neon.css")); string(b) != css2 {
		t.Errorf("update not applied: %q", b)
	}
	// The old version was set aside like a Remove, and goes at the next start.
	if old, _ := filepath.Glob(filepath.Join(s.Dir(), removedDir, "neon@*")); len(old) != 1 {
		t.Errorf("old version set aside: %v", old)
	}
}

func TestABadChecksumInstallsNothing(t *testing.T) {
	css, js := "body{}", "window.ok=1"
	st := newSite(t, map[string]string{"/neon.css": css, "/neon.txt": "window.evil=1"})
	s := Open(t.TempDir())
	_, err := s.Install(neonEntry(st.URL, "1.0", css, js), "https://list", st.Client())
	if !errors.Is(err, ErrChecksum) || !strings.Contains(err.Error(), "js/neon.js") || !strings.Contains(err.Error(), "nothing was installed") {
		t.Fatalf("got %v", err)
	}
	if len(s.List()) != 0 {
		t.Error("a mod with one bad file must not be installed at all")
	}
	if left, _ := filepath.Glob(filepath.Join(s.Dir(), ".installing-*")); len(left) != 0 {
		t.Errorf("download folder left behind: %v", left)
	}
	// A bad update leaves the good version exactly where it was.
	st.files["/neon.txt"] = js
	if _, err := s.Install(neonEntry(st.URL, "1.0", css, js), "https://list", st.Client()); err != nil {
		t.Fatal(err)
	}
	st.files["/neon.txt"] = "window.evil=2"
	if _, err := s.Install(neonEntry(st.URL, "1.1", css, js), "https://list", st.Client()); !errors.Is(err, ErrChecksum) {
		t.Fatalf("got %v", err)
	}
	if m, _ := s.Get("neon"); m.Version != "1.0" || !m.Enabled {
		t.Errorf("a refused update must not touch the installed mod: %+v", m)
	}
}

func TestInstallNeverOverwritesAModFromElsewhere(t *testing.T) {
	css, js := "a", "b"
	st := newSite(t, map[string]string{"/neon.css": css, "/neon.txt": js})
	s := Open(t.TempDir())
	put(t, filepath.Join(s.Dir(), "neon", "mod.json"), `{"name":"My own neon","files":["x.css"]}`)
	put(t, filepath.Join(s.Dir(), "neon", "x.css"), "mine")
	if _, err := s.Install(neonEntry(st.URL, "1.0", css, js), "https://list", st.Client()); !errors.Is(err, ErrNotFromList) {
		t.Fatalf("got %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(s.Dir(), "neon", "x.css")); string(b) != "mine" {
		t.Error("a hand-made mod was overwritten")
	}
	if _, ok := s.InstalledFrom("neon"); ok {
		t.Error("InstalledFrom should report the folder as someone else's")
	}
	if v, ok := s.InstalledFrom("absent"); !ok || v != "" {
		t.Errorf("absent: %q %v", v, ok)
	}
}

func TestInstallRefusesOversizeAndMissingFiles(t *testing.T) {
	st := newSite(t, map[string]string{"/neon.css": strings.Repeat("x", maxModFileSize+1)})
	s := Open(t.TempDir())
	e := neonEntry(st.URL, "1.0", "", "")
	if _, err := s.Install(e, "", st.Client()); err == nil || !strings.Contains(err.Error(), "larger") {
		t.Errorf("oversize: %v", err)
	}
	st.files["/neon.css"] = ""
	if _, err := s.Install(e, "", st.Client()); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("missing file: %v", err)
	}
	if len(s.List()) != 0 {
		t.Error("nothing should be installed")
	}
}

func TestFetchListFallsBackToTheLastGoodCopy(t *testing.T) {
	body := listJSON(t, neonEntry("https://x", "1.0", "a", "b"))
	st := newSite(t, map[string]string{"/list.json": string(body)})
	dir := t.TempDir()
	o := FetchOptions{URL: st.URL + "/list.json", CacheDir: dir, ClientVersion: "1.7.9", Client: st.Client()}
	l, _, err := FetchList(o)
	if err != nil || l.Source != "remote" || len(l.Mods) != 1 {
		t.Fatalf("%+v %v", l, err)
	}
	delete(st.files, "/list.json")
	l, notes, err := FetchList(o)
	if err != nil || l.Source != "cache" || len(l.Mods) != 1 {
		t.Fatalf("cache: %+v %v", l, err)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "as it was on") {
		t.Errorf("notes: %v", notes)
	}
	// A cache for another URL is not used for this one.
	o.URL = st.URL + "/other.json"
	if _, _, err := FetchList(o); err == nil {
		t.Error("another list's cache was shown")
	}
	if l, notes, err := FetchList(FetchOptions{}); l != nil || err != nil || len(notes) != 1 {
		t.Errorf("switched off: %v %v %v", l, notes, err)
	}
}

func TestPurgeClearsAnInterruptedInstall(t *testing.T) {
	s := Open(t.TempDir())
	put(t, filepath.Join(s.Dir(), ".installing-neon-123", "neon.css"), "half")
	if len(s.List()) != 0 {
		t.Error("an install in progress is not a mod")
	}
	s.PurgeRemoved()
	if left, _ := filepath.Glob(filepath.Join(s.Dir(), ".installing-*")); len(left) != 0 {
		t.Errorf("left: %v", left)
	}
}

// The sample list shipped in docs/mods-example, made by catalog/gen-mod-list.py
// from the example mod beside it, is one this parser accepts, and its pins
// match the files. tests/test-gen-mod-list.py checks the other direction.
func TestTheShippedSampleListParses(t *testing.T) {
	dir := filepath.Join("..", "..", "docs", "mods-example")
	body, err := os.ReadFile(filepath.Join(dir, "gobbonet_mod_list.sample.json"))
	if err != nil {
		t.Fatal(err)
	}
	l, notes, err := ParseList(body, "1.7.9")
	if err != nil || len(notes) != 0 || len(l.Mods) != 1 || l.Mods[0].ID != "hello-gobbo" {
		t.Fatalf("%+v %v %v", l, notes, err)
	}
	for _, f := range l.Mods[0].Files {
		b, err := os.ReadFile(filepath.Join(dir, "hello-gobbo", f.Path))
		if err != nil || sum(string(b)) != f.SHA256 {
			t.Errorf("%s: pin does not match the example file (%v)", f.Path, err)
		}
	}
}
