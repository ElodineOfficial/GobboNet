package mods

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func put(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func ids(l []Mod) string {
	var s []string
	for _, m := range l {
		s = append(s, m.ID)
	}
	return strings.Join(s, ",")
}

// Two hand-made mods: "b-theme" (order 10) and "a-tools" (order 50, two files).
func twoMods(t *testing.T) *Store {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "a-tools", "mod.json"), `{"id":"a-tools","name":"Tools","version":"2.0","order":50,"files":["tools.css",{"path":"js/tools.js","name":"Tools script"}]}`)
	put(t, filepath.Join(dir, "a-tools", "tools.css"), "body{}")
	put(t, filepath.Join(dir, "a-tools", "js", "tools.js"), "window.tools=1")
	put(t, filepath.Join(dir, "b-theme", "mod.json"), `{"name":"Theme","order":10,"files":["theme.css"]}`)
	put(t, filepath.Join(dir, "b-theme", "theme.css"), ":root{}")
	return Open(dir)
}

func TestTwoModsLoadInOrderAndStartOff(t *testing.T) {
	s := twoMods(t)
	l := s.List()
	if ids(l) != "b-theme,a-tools" {
		t.Fatalf("load order %s, want b-theme (order 10) then a-tools (order 50)", ids(l))
	}
	if l[0].Enabled || l[1].Enabled {
		t.Error("a mod dropped in by hand must start switched off")
	}
	tools := l[1]
	if tools.Name != "Tools" || tools.Version != "2.0" || len(tools.Files) != 2 ||
		tools.Files[0].Type != "css" || tools.Files[1].Type != "js" || tools.Files[1].Path != "js/tools.js" {
		t.Errorf("manifest read wrong: %+v", tools.Manifest)
	}
	if l[0].ID != "b-theme" || l[0].Error != "" {
		t.Errorf("a manifest without an id takes the folder's: %+v", l[0])
	}
	if tools.Hash == "" || tools.Position != 1 {
		t.Errorf("hash %q position %d", tools.Hash, tools.Position)
	}
}

func TestTogglingOneLeavesTheOther(t *testing.T) {
	s := twoMods(t)
	if err := s.SetEnabled("a-tools", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabled("b-theme", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEnabled("a-tools", false); err != nil {
		t.Fatal(err)
	}
	l := s.List()
	if l[0].ID != "b-theme" || !l[0].Enabled || l[1].Enabled {
		t.Errorf("switching a-tools off changed b-theme: %+v", l)
	}
	// The switch outlives an update of the mod's files.
	put(t, filepath.Join(s.Dir(), "b-theme", "mod.json"), `{"name":"Theme v2","order":10,"files":["theme.css"]}`)
	if m, _ := s.Get("b-theme"); !m.Enabled || m.Name != "Theme v2" {
		t.Errorf("an update must keep the user's switch: %+v", m)
	}
	if err := s.SetEnabled("nope", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown mod: %v", err)
	}
}

func TestMoveChangesTheOrder(t *testing.T) {
	s := twoMods(t)
	if err := s.Move("a-tools", -1); err != nil {
		t.Fatal(err)
	}
	if ids(s.List()) != "a-tools,b-theme" {
		t.Errorf("after moving a-tools up: %s", ids(s.List()))
	}
	put(t, filepath.Join(s.Dir(), "c-new", "mod.json"), `{"files":[]}`)
	if ids(s.List()) != "a-tools,b-theme,c-new" {
		t.Errorf("a new mod goes after the arranged ones: %s", ids(s.List()))
	}
	s.Move("c-new", -5)
	if ids(s.List()) != "c-new,a-tools,b-theme" {
		t.Errorf("moving past the top stops at the top: %s", ids(s.List()))
	}
}

func TestBrokenModsAreListedButCannotBeSwitchedOn(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "no-manifest", "x.css"), "")
	put(t, filepath.Join(dir, "bad-json", "mod.json"), "{nope")
	put(t, filepath.Join(dir, "escape", "mod.json"), `{"files":["../a-tools/tools.css"]}`)
	put(t, filepath.Join(dir, "missing", "mod.json"), `{"files":["gone.js"]}`)
	put(t, filepath.Join(dir, "wrong-id", "mod.json"), `{"id":"other","files":[]}`)
	put(t, filepath.Join(dir, "Bad Name", "mod.json"), `{"files":[]}`)
	put(t, filepath.Join(dir, "hidden-file", "mod.json"), `{"files":[".secret.js"]}`)
	put(t, filepath.Join(dir, "hidden-file", ".secret.js"), "x")
	put(t, filepath.Join(dir, "url-no-type", "mod.json"), `{"files":[{"url":"https://example.com/x"}]}`)
	put(t, filepath.Join(dir, ".removed", "old", "mod.json"), `{"files":[]}`)
	if runtime.GOOS != "windows" {
		put(t, filepath.Join(dir, "linky", "mod.json"), `{"files":["l.js"]}`)
		os.Symlink("/etc/passwd", filepath.Join(dir, "linky", "l.js"))
	}
	s := Open(dir)
	for _, m := range s.List() {
		if m.Error == "" {
			t.Errorf("%s should be broken", m.ID)
		}
		if err := s.SetEnabled(m.ID, true); err == nil {
			t.Errorf("%s: a broken mod was switched on", m.ID)
		}
		if m.ID == "old" {
			t.Error("the .removed folder is not a mod")
		}
	}
}

func TestOnlyListedFilesAreServed(t *testing.T) {
	s := twoMods(t)
	put(t, filepath.Join(s.Dir(), "a-tools", "notes.txt"), "not listed")
	if p, err := s.File("a-tools", "js/tools.js"); err != nil || !strings.HasSuffix(filepath.ToSlash(p), "a-tools/js/tools.js") {
		t.Errorf("listed file: %q %v", p, err)
	}
	for _, bad := range []string{"notes.txt", "mod.json", "../b-theme/theme.css", "/etc/passwd", "js/../tools.css/..", "js\\tools.js", ""} {
		if _, err := s.File("a-tools", bad); err == nil {
			t.Errorf("served %q", bad)
		}
	}
	if _, err := s.File("../a-tools", "tools.css"); err == nil {
		t.Error("an id with .. was accepted")
	}
}

func TestMyExtensionsEditorRoundTrip(t *testing.T) {
	s := Open(t.TempDir())
	on := true
	src := Source{Name: "My extensions",
		Styles:  []Entry{{Name: "Dark", Raw: ":root{--x:1}"}, {Name: "Remote", URL: "https://cdn.example/t.css"}},
		Scripts: []Entry{{Name: "Hello", Raw: "window.hello=1"}, {Name: "empty"}}}
	if err := s.WriteSource(MyExtensionsID, src, "", &on); err != nil {
		t.Fatal(err)
	}
	m, err := s.Get(MyExtensionsID)
	if err != nil || !m.Enabled || m.Origin != "editor" || len(m.Files) != 3 {
		t.Fatalf("%+v %v", m, err)
	}
	got, _ := s.Source(MyExtensionsID)
	if len(got.Styles) != 2 || got.Styles[0].Raw != ":root{--x:1}" || got.Styles[1].URL != "https://cdn.example/t.css" ||
		len(got.Scripts) != 1 || got.Scripts[0].Name != "Hello" {
		t.Errorf("round trip: %+v", got)
	}
	// Saving again with less removes the old files; the switch is untouched.
	if err := s.WriteSource(MyExtensionsID, Source{Name: "My extensions", Scripts: []Entry{{Raw: "1"}}}, "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(), MyExtensionsID, "style-1.css")); err == nil {
		t.Error("a stylesheet removed in the editor was left on disk")
	}
	if m, _ := s.Get(MyExtensionsID); !m.Enabled {
		t.Error("saving switched it off")
	}
	if err := s.WriteSource(MyExtensionsID, Source{Styles: []Entry{{URL: "javascript:alert(1)"}}}, "", nil); err == nil {
		t.Error("a non-http URL was accepted")
	}
}

func TestTheEditorCannotOverwriteAHandMadeMod(t *testing.T) {
	s := twoMods(t)
	if err := s.WriteSource("a-tools", Source{Styles: []Entry{{Raw: "x"}}}, "", nil); !errors.Is(err, ErrNotEditable) {
		t.Errorf("got %v", err)
	}
}

func TestTheOldExtensionsBecomeMyExtensions(t *testing.T) {
	s := Open(t.TempDir())
	legacy := Source{Styles: []Entry{{Name: "Theme", Raw: "body{color:red}"}, {Name: "blank"}}, Scripts: []Entry{{URL: "https://example.com/x.js"}}}
	id, created, err := s.ImportLegacy(legacy, true)
	if err != nil || !created || id != MyExtensionsID {
		t.Fatalf("%q %v %v", id, created, err)
	}
	m, _ := s.Get(id)
	if m.Name != "My extensions" || !m.Enabled || m.Origin != "legacy" || len(m.Files) != 2 {
		t.Errorf("migrated mod: %+v", m)
	}
	// The same blob again (another device, a second boot) changes nothing.
	if id2, created, _ := s.ImportLegacy(legacy, true); created || id2 != MyExtensionsID {
		t.Errorf("re-import made a copy: %q %v", id2, created)
	}
	// Different content lands beside it, switched as it was (off here).
	other := Source{Styles: []Entry{{Raw: "p{}"}}}
	id3, created, _ := s.ImportLegacy(other, false)
	if !created || id3 != "my-extensions-2" {
		t.Fatalf("second set: %q %v", id3, created)
	}
	if m, _ := s.Get(id3); m.Name != "My extensions (2)" || m.Enabled {
		t.Errorf("%+v", m)
	}
	if id4, created, _ := s.ImportLegacy(Source{Styles: []Entry{{Name: "only a name"}}}, true); id4 != "" || created {
		t.Error("an empty blob should import nothing")
	}
}

func TestRemoveRestoreAndPurge(t *testing.T) {
	s := twoMods(t)
	s.SetEnabled("a-tools", true)
	if err := s.Remove("a-tools"); err != nil {
		t.Fatal(err)
	}
	if ids(s.List()) != "b-theme" {
		t.Errorf("after remove: %s", ids(s.List()))
	}
	if err := s.Restore("a-tools"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.Get("a-tools"); !m.Enabled {
		t.Error("UNDO should bring it back as it was, switched on")
	}
	s.Remove("a-tools")
	s.PurgeRemoved()
	if err := s.Restore("a-tools"); !errors.Is(err, ErrNothingToUndo) {
		t.Errorf("after the purge there is nothing to put back: %v", err)
	}
	if st := s.readState(); len(st.Enabled) != 0 || strings.Contains(strings.Join(st.Order, ","), "a-tools") {
		t.Errorf("the purge should forget a-tools' switch and place: %+v", st)
	}
}
