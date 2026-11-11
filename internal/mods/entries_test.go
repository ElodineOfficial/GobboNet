package mods

import (
	"errors"
	"testing"
)

// 1.8.0, from Larck Drakengold's 4db2469: each My extensions entry has its own
// switch, on top of the mod's.

func boolp(b bool) *bool { return &b }

func entryFiles(t *testing.T, s *Store, id string) map[string]bool {
	t.Helper()
	m, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, f := range m.Files {
		key := f.Path + f.URL
		if f.Enabled == nil {
			t.Fatalf("%s has no switch in the list", key)
		}
		out[key] = *f.Enabled
	}
	return out
}

func TestEachEditorEntryHasItsOwnSwitch(t *testing.T) {
	s := Open(t.TempDir())
	src := Source{Name: "My extensions",
		Styles:  []Entry{{Name: "Both", URL: "https://cdn.example/a.css", Raw: "a{}"}, {Name: "Dark", Raw: "b{}"}},
		Scripts: []Entry{{Name: "Hello", Raw: "window.h=1"}}}
	if err := s.WriteSource(MyExtensionsID, src, "", boolp(true)); err != nil {
		t.Fatal(err)
	}
	for f, on := range entryFiles(t, s, MyExtensionsID) {
		if !on {
			t.Errorf("a new entry starts off: %s", f)
		}
	}

	// One entry is its URL and its text together: both go off.
	if err := s.SetEntryEnabled(MyExtensionsID, "css", 0, false); err != nil {
		t.Fatal(err)
	}
	got := entryFiles(t, s, MyExtensionsID)
	if got["https://cdn.example/a.css"] || got["style-1.css"] || !got["style-2.css"] || !got["script-1.js"] {
		t.Errorf("switching entry 0 off: %v", got)
	}
	if m, _ := s.Get(MyExtensionsID); !m.Enabled {
		t.Error("an entry switch moved the mod's own switch")
	}

	read, _ := s.Source(MyExtensionsID)
	if len(read.Styles) != 2 || *read.Styles[0].Enabled || !*read.Styles[1].Enabled ||
		read.Styles[0].URL != "https://cdn.example/a.css" || read.Styles[0].Raw != "a{}" {
		t.Fatalf("the editor reads back one entry per entry, with its switch: %+v", read.Styles)
	}
	if read.Styles[0].Index == nil || *read.Styles[0].Index != 0 || *read.Styles[1].Index != 1 || *read.Scripts[0].Index != 0 {
		t.Errorf("each entry says where it is saved: %+v", read)
	}

	// SAVE writes the switches the editor sends.
	read.Styles[0].Enabled = boolp(true)
	read.Scripts[0].Enabled = boolp(false)
	if err := s.WriteSource(MyExtensionsID, read, "", nil); err != nil {
		t.Fatal(err)
	}
	got = entryFiles(t, s, MyExtensionsID)
	if !got["style-1.css"] || !got["https://cdn.example/a.css"] || got["script-1.js"] {
		t.Errorf("after SAVE: %v", got)
	}
}

func TestAnEntrySwitchOnlyFindsARealEntry(t *testing.T) {
	s := twoMods(t)
	if err := s.WriteSource(MyExtensionsID, Source{Styles: []Entry{{Raw: "a{}"}}}, "", nil); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id, kind string
		index    int
	}{
		{MyExtensionsID, "css", 1},  // no such entry
		{MyExtensionsID, "css", -1}, // nonsense
		{MyExtensionsID, "asset", 0},
		{MyExtensionsID, "js", 0}, // no scripts at all
		{"a-tools", "css", 0},     // a hand-made mod has no editor entries
		{"nope", "css", 0},
	} {
		if err := s.SetEntryEnabled(c.id, c.kind, c.index, false); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s %s %d: got %v, want ErrNotFound", c.id, c.kind, c.index, err)
		}
	}
}

// An entry with a name and nothing else is saved as no file at all, so the
// entries after it keep their saved numbers and the editor's positions differ.
// The editor switches by the number Source reports, never by position.
func TestTheSavedNumberSurvivesAnEntryThatWroteNothing(t *testing.T) {
	s := Open(t.TempDir())
	src := Source{Styles: []Entry{{Name: "just a name"}, {Name: "Real", Raw: "r{}"}}}
	if err := s.WriteSource(MyExtensionsID, src, "", nil); err != nil {
		t.Fatal(err)
	}
	read, _ := s.Source(MyExtensionsID)
	if len(read.Styles) != 1 || read.Styles[0].Name != "Real" || read.Styles[0].Index == nil || *read.Styles[0].Index != 1 {
		t.Fatalf("read back: %+v", read.Styles)
	}
	if err := s.SetEntryEnabled(MyExtensionsID, "css", *read.Styles[0].Index, false); err != nil {
		t.Errorf("switching by the reported number: %v", err)
	}
	if err := s.SetEntryEnabled(MyExtensionsID, "css", 0, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("position 0 is the entry that saved nothing: got %v", err)
	}
}

// Importing a set that differs from the My extensions already there lands it
// beside, as before -- and keeps its entries' switches. The comparison that
// decides "the same set" used to clear them in place, on the caller's copy.
func TestAnImportUnderANewNameKeepsItsSwitches(t *testing.T) {
	s := Open(t.TempDir())
	if _, _, err := s.ImportLegacy(Source{Styles: []Entry{{Raw: "first{}"}}}, true); err != nil {
		t.Fatal(err)
	}
	other := Source{Styles: []Entry{{Name: "Off", Raw: "off{}", Enabled: boolp(false)}, {Name: "On", Raw: "on{}"}}}
	id, created, err := s.ImportLegacy(other, true)
	if err != nil || !created || id != "my-extensions-2" {
		t.Fatalf("%q %v %v", id, created, err)
	}
	read, _ := s.Source(id)
	if len(read.Styles) != 2 || *read.Styles[0].Enabled || !*read.Styles[1].Enabled {
		t.Errorf("the switches did not survive the import: %+v", read.Styles)
	}
	// And the same set again is still recognised, whatever its switches say.
	other.Styles[0].Enabled = boolp(true)
	if id2, created, _ := s.ImportLegacy(other, true); created || id2 != id {
		t.Errorf("re-import made a copy: %q %v", id2, created)
	}
}

func TestEntrySwitchesGoWithTheirMod(t *testing.T) {
	s := Open(t.TempDir())
	if err := s.WriteSource(MyExtensionsID, Source{Styles: []Entry{{Raw: "a{}"}}}, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEntryEnabled(MyExtensionsID, "css", 0, false); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(MyExtensionsID); err != nil {
		t.Fatal(err)
	}
	s.PurgeRemoved()
	if st := s.readState(); st.EntryEnabled[MyExtensionsID] != nil {
		t.Errorf("a purged mod's entry switches stayed in mods-state.json: %v", st.EntryEnabled)
	}
}
