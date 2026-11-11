package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 1.8.0: the bundled catalogue is pinned throughout, and a live list that is
// older than the release borrows those pins instead of showing the models
// UNVERIFIED.

func TestTheLiveListBorrowsBundledPins(t *testing.T) {
	bundled, err := Load(bundledINI)
	if err != nil {
		t.Skip("catalog/models.ini not present")
	}
	llama, ok := bundled.Find(2)
	if !ok || llama.SHA256 == "" {
		t.Fatalf("the bundled Llama 3.2 3B is not pinned: %+v", llama)
	}
	theirs := strings.Repeat("ab", 32)
	live := &Catalog{Entries: []Entry{
		{Index: 2, Repo: llama.Repo, File: llama.File},                  // unpinned: borrows
		{Index: 3, Repo: "someone/else", File: llama.File},              // same name, other repo: not the same file
		{Index: 4, Repo: llama.Repo, File: llama.File, SHA256: theirs},  // the live list's own pin stays
		{Index: 5, Repo: "r/new", File: "not-in-the-bundled-list.gguf"}, // nothing to borrow
	}}
	if n := borrowPins(live, bundled); n != 1 {
		t.Errorf("filled %d, want 1", n)
	}
	if !live.Entries[0].Verified() || live.Entries[0].SHA256 != llama.SHA256 {
		t.Errorf("an unpinned live entry did not take the bundled pin: %+v", live.Entries[0])
	}
	if live.Entries[1].Verified() {
		t.Errorf("a file from another repo was given this repo's pin: %+v", live.Entries[1])
	}
	if live.Entries[2].SHA256 != theirs {
		t.Errorf("a live pin was replaced: %+v", live.Entries[2])
	}
	if live.Entries[3].Verified() {
		t.Errorf("a model the bundled list does not have was pinned: %+v", live.Entries[3])
	}
}

// The case that was reported: the served list still has two pins, this
// release ships sixteen. The cached copy of the served list comes out of
// Fetch with every model the bundled list knows pinned, and the notes say so.
func TestFetchFillsPinsFromTheBundledList(t *testing.T) {
	bundled, err := Load(bundledINI)
	if err != nil {
		t.Skip("catalog/models.ini not present")
	}
	served := map[string]any{"schema_version": 1, "min_client": "1.7.0", "models": []map[string]any{}}
	var models []map[string]any
	for _, e := range bundled.Entries {
		m := map[string]any{"index": e.Index, "display": e.Display, "repo": e.Repo, "file": e.File,
			"size_gb": e.SizeGB, "min_vram_gb": e.MinVRAM, "ctx": e.Ctx, "sha256": nil}
		if e.Index == 13 { // Nemo was one of the two pinned in the served list
			m["sha256"] = e.SHA256
		}
		models = append(models, m)
	}
	served["models"] = models
	body, _ := json.Marshal(served)
	dir := t.TempDir()
	cache, _ := json.Marshal(cacheFile{FetchedAt: time.Now(), Body: string(body)})
	if err := os.WriteFile(filepath.Join(dir, cacheName), cache, 0o600); err != nil {
		t.Fatal(err)
	}
	c, notes, err := Fetch(Options{Enabled: false, CacheDir: dir, ClientVersion: "1.8.0", BundledPath: bundledINI})
	if err != nil {
		t.Fatal(err)
	}
	if c.Source != "cache" {
		t.Fatalf("source %q, want the cached served list", c.Source)
	}
	for _, e := range c.Entries {
		if !e.Verified() {
			t.Errorf("%s is still unverified", e.File)
		}
	}
	want := len(bundled.Entries) - 1
	if !strings.Contains(strings.Join(notes, "\n"), "SHA-256 pin for "+itoa(want)+" model(s)") {
		t.Errorf("notes: %v", notes)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
