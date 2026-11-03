package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Roadmap 1.7.7: the Add a Model window's buckets, as agreed with the
// maintainer on 2026-10-12. Keyed by file, as the catalogue is.
var agreedBuckets = map[string][]string{
	"google_gemma-4-E4B-it-Q4_K_M.gguf":               {"jack-of-all-trades"},
	"Llama-3.2-3B-Instruct-Q8_0.gguf":                 {"jack-of-all-trades"},
	"Mistral-7B-Instruct-v0.3-Q6_K.gguf":              {"roleplay"},
	"Qwen_Qwen3.5-9B-Q4_K_M.gguf":                     {"coding"},
	"google_gemma-4-26B-A4B-it-Q4_K_S.gguf":           {"roleplay", "jack-of-all-trades"},
	"Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf":                {"coding", "jack-of-all-trades"},
	"deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q8_0.gguf": {"coding"},
	"gpt-oss-20b-MXFP4.gguf":                          {"coding", "jack-of-all-trades"},
	"c4ai-command-r7b-12-2024-Q6_K.gguf":              {"jack-of-all-trades"},
	"c4ai-command-r-08-2024-Q4_K_S.gguf":              {"roleplay"},
	// Added in 1.7.9 (F2), one per gap in the tiers.
	"Llama-3.2-1B-Instruct-Q8_0.gguf":                           {"jack-of-all-trades"},
	"Mistral-Nemo-Instruct-2407-Q4_K_M.gguf":                    {"roleplay"},
	"phi-4-Q4_K_M.gguf":                                         {"coding", "jack-of-all-trades"},
	"mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf": {"roleplay", "jack-of-all-trades"},
	"google_gemma-4-31B-it-Q4_K_M.gguf":                         {"roleplay", "jack-of-all-trades"},
	"Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf":                  {"coding"},
}

var bundledINI = filepath.Join("..", "..", "catalog", "models.ini")

func TestParseTags(t *testing.T) {
	got := parseTags(" Coding, roleplay ,,coding, JACK-of-all-trades ")
	if want := []string{"coding", "roleplay", "jack-of-all-trades"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if parseTags("") != nil {
		t.Error("empty tags should be nil")
	}
}

func TestBundledListCarriesTheAgreedBuckets(t *testing.T) {
	c, err := Load(bundledINI)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Entries) != len(agreedBuckets) {
		t.Fatalf("%d entries, want %d", len(c.Entries), len(agreedBuckets))
	}
	for _, e := range c.Entries {
		if got, want := e.BucketTags(), agreedBuckets[e.File]; !reflect.DeepEqual(got, want) {
			t.Errorf("%s: buckets %v, want %v", e.Display, got, want)
		}
	}
}

// The live list as published today has no bucket tags; until it does, each
// model borrows the bundled copy's, matched by file.
func TestTheLiveListBorrowsBuckets(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "live-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	live, err := ParseRemote(body, "1.7.7")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range live.Entries {
		if len(e.BucketTags()) != 0 {
			t.Fatalf("the test copy of the live list already has buckets; this test needs one without")
		}
	}
	bundled, err := Load(bundledINI)
	if err != nil {
		t.Fatal(err)
	}
	if n := borrowBuckets(live, bundled); n != 10 {
		t.Errorf("filled %d, want 10", n)
	}
	for _, e := range live.Entries {
		if got, want := e.BucketTags(), agreedBuckets[e.File]; !reflect.DeepEqual(got, want) {
			t.Errorf("%s: buckets %v, want %v", e.Display, got, want)
		}
		if !contains(e.Tags, "general") && e.Display != "DeepSeek-R1 8B" {
			t.Errorf("%s lost its own tags: %v", e.Display, e.Tags)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Wherever the live list has an opinion, it wins.
func TestALiveBucketIsKept(t *testing.T) {
	live := &Catalog{Entries: []Entry{
		{File: "a.gguf", Tags: []string{"general", "roleplay"}},
		{File: "b.gguf", Tags: []string{"general"}},
		{File: "c.gguf"},
	}}
	bundled := &Catalog{Entries: []Entry{
		{File: "a.gguf", Tags: []string{"coding"}},
		{File: "b.gguf", Tags: []string{"coding"}},
	}}
	if n := borrowBuckets(live, bundled); n != 1 {
		t.Errorf("filled %d, want 1", n)
	}
	if got := live.Entries[0].BucketTags(); !reflect.DeepEqual(got, []string{"roleplay"}) {
		t.Errorf("a: %v, want the live list's own roleplay", got)
	}
	if got := live.Entries[1].BucketTags(); !reflect.DeepEqual(got, []string{"coding"}) {
		t.Errorf("b: %v", got)
	}
	if got := live.Entries[2].BucketTags(); got != nil {
		t.Errorf("c, in neither list: %v", got)
	}
	if bundled.Entries[0].Tags[0] != "coding" || len(bundled.Entries[1].Tags) != 1 {
		t.Error("the bundled list was changed by lending")
	}
}

// Through Fetch: a cached live list comes back with its buckets filled, and
// the notes say where they came from.
func TestFetchFillsBucketsFromTheBundledList(t *testing.T) {
	dir := t.TempDir()
	body, _ := os.ReadFile(filepath.Join("testdata", "live-catalog.json"))
	cache, _ := json.Marshal(cacheFile{FetchedAt: time.Now(), Body: string(body)})
	if err := os.WriteFile(filepath.Join(dir, cacheName), cache, 0o600); err != nil {
		t.Fatal(err)
	}
	c, notes, err := Fetch(Options{Enabled: false, CacheDir: dir, ClientVersion: "1.7.7", BundledPath: bundledINI})
	if err != nil {
		t.Fatal(err)
	}
	if c.Source != "cache" {
		t.Fatalf("source %s", c.Source)
	}
	for _, e := range c.Entries {
		if len(e.BucketTags()) == 0 {
			t.Errorf("%s has no bucket", e.Display)
		}
	}
	if !strings.Contains(strings.Join(notes, "\n"), "buckets for 10 model(s) from the bundled list") {
		t.Errorf("notes: %v", notes)
	}
}
