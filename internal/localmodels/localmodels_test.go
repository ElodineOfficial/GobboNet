package localmodels

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func symlink(t *testing.T, target, at string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, at); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
}

// hfCache lays out what huggingface_hub writes: blobs named by hash, and each
// revision's snapshot holding relative symlinks to them.
func hfCache(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fixture uses POSIX symlinks, as the cache does on Linux and macOS")
	}
	hub := filepath.Join(t.TempDir(), "hub")
	repo := filepath.Join(hub, "models--bartowski--Foo-GGUF")
	write(t, filepath.Join(repo, "blobs", "aaaa"), "weights of foo")
	write(t, filepath.Join(repo, "blobs", "bbbb.incomplete"), "half a download")
	symlink(t, "../../blobs/aaaa", filepath.Join(repo, "snapshots", "rev1", "Foo-Q4_K_M.gguf"))
	symlink(t, "../../blobs/aaaa", filepath.Join(repo, "snapshots", "rev2", "Foo-Q4_K_M.gguf")) // same file, newer revision

	other := filepath.Join(hub, "models--someone--Big-GGUF", "snapshots", "r")
	write(t, filepath.Join(other, "Big-Q8_0-00001-of-00002.gguf"), "part one")
	write(t, filepath.Join(other, "Big-Q8_0-00002-of-00002.gguf"), "part two")
	write(t, filepath.Join(other, "Half-00001-of-00003.gguf"), "only one of three parts")
	write(t, filepath.Join(other, "mmproj-Big-f16.gguf"), "a vision projector")
	write(t, filepath.Join(other, "nomic-embed-text-v1.5.Q8_0.gguf"), "an embedding model")
	write(t, filepath.Join(other, "README.md"), "not a model")
	symlink(t, "/nowhere/at/all.gguf", filepath.Join(other, "Gone.gguf"))
	write(t, filepath.Join(hub, ".locks", "Hidden.gguf"), "in a hidden folder")
	return hub
}

func names(fs []Found) []string {
	var out []string
	for _, f := range fs {
		out = append(out, f.Name)
	}
	return out
}

func TestRootsFollowHuggingFacesOrder(t *testing.T) {
	home := t.TempDir()
	cache := filepath.Join(home, "explicit")
	os.MkdirAll(cache, 0o755)
	os.MkdirAll(filepath.Join(home, ".cache", "huggingface", "hub"), 0o755)
	env := map[string]string{"HF_HUB_CACHE": cache, "HF_HOME": filepath.Join(home, "hfhome")}
	roots := Roots([]string{"~/lmstudio", cache}, true, func(k string) string { return env[k] }, home)

	var got []string
	for _, r := range roots {
		got = append(got, r.Source+"="+strings.TrimPrefix(r.Path, home))
	}
	want := []string{"HF_HUB_CACHE=/explicit", "HF_HOME=/hfhome/hub", "default=/.cache/huggingface/hub", "model_dirs=/lmstudio"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("roots\n got %v\nwant %v (a model_dirs entry that repeats a cache path is listed once)", got, want)
	}
	if !roots[0].Exists || roots[1].Exists || !roots[2].Exists || roots[3].Exists {
		t.Errorf("Exists should say which folders are really there: %+v", roots)
	}
	if off := Roots(nil, false, func(string) string { return cache }, home); len(off) != 0 {
		t.Errorf("scan_hf_cache = false must leave the cache out: %+v", off)
	}
}

func TestScanFindsChatModelsInTheCache(t *testing.T) {
	hub := hfCache(t)
	found, notes := Scan([]Root{{Path: hub, Kind: "hf-cache", Exists: true}}, filepath.Join(t.TempDir(), "models"), Limits{})
	if len(notes) != 0 {
		t.Errorf("unexpected notes: %v", notes)
	}
	got := strings.Join(names(found), " | ")
	if got != "Foo-Q4_K_M.gguf | Big-Q8_0.gguf (2 parts)" {
		t.Fatalf("found %q", got)
	}
	foo, big := found[0], found[1]
	if foo.Repo != "bartowski/Foo-GGUF" || big.Repo != "someone/Big-GGUF" {
		t.Errorf("repos %q %q", foo.Repo, big.Repo)
	}
	if foo.SizeBytes != int64(len("weights of foo")) || big.PartCount != 2 ||
		big.SizeBytes != int64(len("part one")+len("part two")) {
		t.Errorf("sizes or parts wrong: %+v %+v", foo, big)
	}
	if big.File != "Big-Q8_0-00001-of-00002.gguf" {
		t.Errorf("a split model is loaded from its first part, got %q", big.File)
	}
	if foo.State != "new" || len(foo.ID) != 16 {
		t.Errorf("state %q id %q", foo.State, foo.ID)
	}
	// Left out, each for its reason: a revision of the same blob, a split model
	// missing a part, a projector, an embedding model, a dangling link, a
	// hidden folder, a half-finished blob.
	for _, f := range found {
		for _, bad := range []string{"Half", "mmproj", "nomic", "Gone", "Hidden", "incomplete"} {
			if strings.Contains(f.Path, bad) {
				t.Errorf("should not have offered %s", f.Path)
			}
		}
	}
}

func TestScanSkipsTheModelsFolderAndKnowsWhatIsLinked(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "models")
	write(t, filepath.Join(modelDir, "Already-Here.gguf"), "x")
	extra := filepath.Join(dir, "elsewhere")
	write(t, filepath.Join(extra, "Mine.gguf"), "mine")
	write(t, filepath.Join(extra, "Clash.gguf"), "the found one")
	write(t, filepath.Join(modelDir, "Clash.gguf"), "a different file with the same name")

	// The models folder sits inside a scanned root; it is not offered back.
	roots := []Root{{Path: dir, Kind: "folder", Exists: true}}
	found, _ := Scan(roots, modelDir, Limits{})
	byName := map[string]Found{}
	for _, f := range found {
		byName[f.Name] = f
	}
	if _, ok := byName["Already-Here.gguf"]; ok {
		t.Error("a model already in the models folder was offered again")
	}
	if byName["Mine.gguf"].State != "new" || byName["Clash.gguf"].State != "name-taken" {
		t.Errorf("states: %+v", byName)
	}

	how, err := Link(byName["Mine.gguf"], modelDir)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && how != "symlink" {
		t.Errorf("linked by %q, want a symlink here", how)
	}
	if b, err := os.ReadFile(filepath.Join(modelDir, "Mine.gguf")); err != nil || string(b) != "mine" {
		t.Fatalf("the link does not read as the model: %q %v", b, err)
	}
	if st, _ := os.Stat(filepath.Join(extra, "Mine.gguf")); st == nil {
		t.Fatal("linking must leave the original where it was")
	}
	found, _ = Scan(roots, modelDir, Limits{})
	for _, f := range found {
		if f.Name == "Mine.gguf" && f.State != "linked" {
			t.Errorf("after linking, state is %q", f.State)
		}
	}
	if how, err := Link(byName["Mine.gguf"], modelDir); err != nil || how != "already linked" {
		t.Errorf("linking twice should be harmless: %q %v", how, err)
	}
	if _, err := Link(byName["Clash.gguf"], modelDir); !errors.Is(err, ErrNameTaken) {
		t.Errorf("a name clash must refuse, not overwrite: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(modelDir, "Clash.gguf")); string(b) != "a different file with the same name" {
		t.Error("the file already in the models folder was touched")
	}
}

func TestLinkingASplitModelLinksEveryPartOrNone(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "models")
	src := filepath.Join(dir, "src")
	write(t, filepath.Join(src, "M-00001-of-00003.gguf"), "1")
	write(t, filepath.Join(src, "M-00002-of-00003.gguf"), "2")
	write(t, filepath.Join(src, "M-00003-of-00003.gguf"), "3")
	found, _ := Scan([]Root{{Path: src, Kind: "folder", Exists: true}}, modelDir, Limits{})
	if len(found) != 1 || found[0].PartCount != 3 {
		t.Fatalf("found %+v", found)
	}
	// Part 3's name is taken by something else: nothing may be left behind.
	write(t, filepath.Join(modelDir, "M-00003-of-00003.gguf"), "not ours")
	if _, err := Link(found[0], modelDir); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("want a name clash, got %v", err)
	}
	for _, p := range []string{"M-00001-of-00003.gguf", "M-00002-of-00003.gguf"} {
		if _, err := os.Lstat(filepath.Join(modelDir, p)); err == nil {
			t.Errorf("%s was left behind after a failed link", p)
		}
	}
	os.Remove(filepath.Join(modelDir, "M-00003-of-00003.gguf"))
	if _, err := Link(found[0], modelDir); err != nil {
		t.Fatal(err)
	}
	for i, p := range []string{"M-00001-of-00003.gguf", "M-00002-of-00003.gguf", "M-00003-of-00003.gguf"} {
		if b, err := os.ReadFile(filepath.Join(modelDir, p)); err != nil || string(b) != string(rune('1'+i)) {
			t.Errorf("%s: %q %v", p, b, err)
		}
	}
}

func TestABroadFolderIsCutShortAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 50; i++ {
		write(t, filepath.Join(dir, "d", string(rune('a'+i%26))+strings.Repeat("x", i/26), "n.txt"), "x")
	}
	_, notes := Scan([]Root{{Path: dir, Kind: "folder", Exists: true}}, "", Limits{MaxEntries: 20})
	if len(notes) != 1 || !strings.Contains(notes[0], "Stopped looking") {
		t.Errorf("notes %v", notes)
	}
	start := time.Now()
	Scan([]Root{{Path: dir, Kind: "folder", Exists: true}}, "", Limits{MaxTime: time.Nanosecond})
	if time.Since(start) > time.Second {
		t.Error("the time limit did not stop the walk")
	}
}

func TestDepthIsBounded(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a", "Shallow.gguf"), "x")
	write(t, filepath.Join(dir, "a", "b", "c", "d", "e", "f", "g", "Deep.gguf"), "x")
	found, _ := Scan([]Root{{Path: dir, Kind: "folder", Exists: true}}, "", Limits{})
	if got := strings.Join(names(found), ","); got != "Shallow.gguf" {
		t.Errorf("found %q; seven folders down is past the limit", got)
	}
}

func TestIDsAreStableAndDistinct(t *testing.T) {
	if ID("/a/b.gguf") != ID("/a/b.gguf") || ID("/a/b.gguf") == ID("/a/c.gguf") {
		t.Error("IDs must be stable per path and differ between paths")
	}
}
