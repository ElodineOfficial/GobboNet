package catalog

// Tests for the remote JSON catalogue.
//
// testdata/live-catalog.json is a verbatim copy of what
// https://goblincorps.com/gobbonet_model_list.json served on 2026-08-29. The
// point of pinning the real bytes is that a schema written from a design doc
// and a schema actually being served are two different things, and only one of
// them is what users hit.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func liveBytes(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "live-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// --- Parsing the real file --------------------------------------------------

func TestParseLiveCatalog(t *testing.T) {
	cat, err := ParseRemote(liveBytes(t), "1.7.0")
	if err != nil {
		t.Fatalf("the live catalogue does not parse: %v", err)
	}
	if len(cat.Entries) != 10 {
		t.Fatalf("got %d entries, want 10", len(cat.Entries))
	}
	if cat.Source != "remote" {
		t.Errorf("source = %q, want remote", cat.Source)
	}
	if cat.Generated == "" {
		t.Error("generated timestamp was dropped")
	}
	if cat.HeadroomGB != 2 {
		t.Errorf("headroom = %d, want 2", cat.HeadroomGB)
	}
	if len(cat.Rungs) != 4 {
		t.Errorf("got %d rungs, want 4", len(cat.Rungs))
	}
	if cat.Default != 2 || cat.CPUOnly != 2 {
		t.Errorf("default/cpu_only = %d/%d, want 2/2", cat.Default, cat.CPUOnly)
	}

	// min_vram_gb -> MinVRAM is the one field whose name differs between the
	// .ini and the JSON, so it is the one most likely to be silently dropped.
	e, ok := cat.Find(8)
	if !ok {
		t.Fatal("entry 8 missing")
	}
	if e.Display != "gpt-oss 20B" || e.MinVRAM != 12 || e.SizeGB != 12 || e.Ctx != 16384 || e.KV != "q8_0" {
		t.Errorf("entry 8 came across wrong: %+v", e)
	}
	if e.DownloadURL() != "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-MXFP4.gguf" {
		t.Errorf("download URL is wrong: %s", e.DownloadURL())
	}

	// Tags survive; the picker will want them.
	two, _ := cat.Find(2)
	if len(two.Tags) != 3 || two.Tags[2] != "cpu-friendly" {
		t.Errorf("tags on entry 2 = %v", two.Tags)
	}
}

// Every sha256 in the live file is null today. That must read as "not
// provided" and leave the downloader on its existing LFS-pointer path, not as
// a parse failure and not as an empty-string hash that fails every comparison.
func TestLiveCatalogHasNoChecksumsYet(t *testing.T) {
	cat, err := ParseRemote(liveBytes(t), "1.7.0")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range cat.Entries {
		if e.SHA256 != "" {
			t.Errorf("entry %d unexpectedly carries a hash (%q) — if the generator "+
				"has started publishing them, the cross-check can now be turned on",
				e.Index, e.SHA256)
		}
	}
}

func TestParseRemoteAcceptsChecksumsWhenPresent(t *testing.T) {
	const good = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	body := `{"schema_version":1,"min_client":"1.0","models":[
		{"index":1,"display":"A","repo":"r/a","file":"a.gguf","sha256":"` + good + `"},
		{"index":2,"display":"B","repo":"r/b","file":"b.gguf","sha256":"NOTAHASH"},
		{"index":3,"display":"C","repo":"r/c","file":"c.gguf","sha256":"` + good[:60] + `"}
	]}`
	cat, err := ParseRemote([]byte(body), "1.7.0")
	if err != nil {
		t.Fatal(err)
	}
	if e, _ := cat.Find(1); e.SHA256 != good {
		t.Errorf("a valid hash was dropped: %q", e.SHA256)
	}
	// A malformed hash is discarded at the boundary rather than kept to cause a
	// confusing "checksum mismatch" against a download that was actually fine.
	if e, _ := cat.Find(2); e.SHA256 != "" {
		t.Errorf("a non-hex hash was kept: %q", e.SHA256)
	}
	if e, _ := cat.Find(3); e.SHA256 != "" {
		t.Errorf("a short hash was kept: %q", e.SHA256)
	}
}

// --- Validation -------------------------------------------------------------

func TestParseRemoteRefusesUnknownSchema(t *testing.T) {
	body := `{"schema_version":99,"models":[{"index":1,"repo":"r/a","file":"a.gguf"}]}`
	if _, err := ParseRemote([]byte(body), "1.7.0"); err == nil {
		t.Fatal("a schema_version this build does not know was accepted")
	}
}

func TestParseRemoteRefusesMalformedJSON(t *testing.T) {
	if _, err := ParseRemote([]byte("{not json"), "1.7.0"); err == nil {
		t.Fatal("malformed JSON was accepted")
	}
}

// A bad entry costs that entry, not the catalogue. A partial list still lets
// someone download a model.
func TestParseRemoteDropsBadEntriesAndKeepsTheRest(t *testing.T) {
	body := `{"schema_version":1,"models":[
		{"index":1,"display":"Good","repo":"r/a","file":"a.gguf","size_gb":1},
		{"index":2,"display":"No repo","file":"b.gguf"},
		{"index":3,"display":"No file","repo":"r/c"},
		{"index":0,"display":"No index","repo":"r/d","file":"d.gguf"},
		{"index":4,"display":"Also good","repo":"r/e","file":"e.gguf","size_gb":2}
	]}`
	cat, err := ParseRemote([]byte(body), "1.7.0")
	if err != nil {
		t.Fatalf("one bad row killed the whole catalogue: %v", err)
	}
	if len(cat.Entries) != 2 {
		t.Fatalf("got %d entries, want 2 (the two usable ones)", len(cat.Entries))
	}
	if _, ok := cat.Find(1); !ok {
		t.Error("the good entry before the bad ones was lost")
	}
	if _, ok := cat.Find(4); !ok {
		t.Error("the good entry after the bad ones was lost")
	}
}

func TestParseRemoteRejectsCatalogWithNoUsableEntries(t *testing.T) {
	body := `{"schema_version":1,"models":[{"index":1,"display":"broken"}]}`
	if _, err := ParseRemote([]byte(body), "1.7.0"); err == nil {
		t.Fatal("a catalogue with nothing downloadable was accepted")
	}
}

func TestParseRemoteDropsDuplicateIndices(t *testing.T) {
	body := `{"schema_version":1,"models":[
		{"index":1,"display":"First","repo":"r/a","file":"a.gguf"},
		{"index":1,"display":"Second","repo":"r/b","file":"b.gguf"}
	]}`
	cat, err := ParseRemote([]byte(body), "1.7.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Entries) != 1 {
		t.Fatalf("got %d entries, want 1 — a duplicate index makes Find ambiguous", len(cat.Entries))
	}
	if e, _ := cat.Find(1); e.Display != "First" {
		t.Errorf("kept %q, want the first occurrence", e.Display)
	}
}

// --- min_client -------------------------------------------------------------

func TestMinClientGate(t *testing.T) {
	cases := []struct {
		have, want string
		ok         bool
		why        string
	}{
		{"1.7.0", "1.7.0", true, "exact match"},
		{"1.8.0", "1.7.0", true, "newer client"},
		{"1.6", "1.7.0", false, "older client bails"},
		{"1.6-go-abc1234", "1.7.0", false, "release suffix is ignored, still older"},
		{"1.7-go-abc1234", "1.7.0", true, "1.7 satisfies 1.7.0"},
		{"dev", "1.7.0", true, "an unstamped dev build must not lock itself out"},
		{"1.6", "", true, "no minimum stated imposes none"},
		{"1.10", "1.9", true, "components compare numerically, not as strings"},
	}
	for _, c := range cases {
		if got := versionAtLeast(c.have, c.want); got != c.ok {
			t.Errorf("versionAtLeast(%q, %q) = %v, want %v — %s", c.have, c.want, got, c.ok, c.why)
		}
	}
}

// The live catalogue declares min_client 1.7.0, so a build stamped from the
// VERSION file in this tree has to clear it.
//
// This reads VERSION rather than a literal on purpose. It was written when
// VERSION said 1.6 and the gate was closed, and it documented that as expected
// — which meant the test went on passing while the feature was inert in every
// stamped build, and only a human reading the changelog would have known. A
// test that reads the same file the build scripts read fails when that is true
// again.
func TestLiveCatalogAgainstCurrentVersionFile(t *testing.T) {
	body, err := os.ReadFile("../../VERSION")
	if err != nil {
		t.Fatalf("read VERSION: %v", err)
	}
	release := strings.TrimSpace(string(body))
	if release == "" {
		t.Fatal("VERSION is empty")
	}

	// The shape build-release.sh actually stamps.
	stamped := release + "-go-abc1234"
	if _, err := ParseRemote(liveBytes(t), stamped); err != nil {
		t.Fatalf("a build stamped %q cannot read the live catalogue: %v\n"+
			"Every release from this tree would silently fall back to the bundled\n"+
			"list. Bump VERSION, or lower min_client in the served file.", stamped, err)
	}

	// And the gate still has to bite, or it is not a gate.
	if _, err := ParseRemote(liveBytes(t), "1.6-go-abc1234"); err == nil {
		t.Error("a 1.6 build was allowed to adopt a catalogue marked min_client 1.7.0")
	}
}

// --- Fetch precedence -------------------------------------------------------

func writeIni(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.ini")
	body := "[recommend]\r\ncpu_only=1\r\ndefault=1\r\n\r\n" +
		"[1]\r\ndisplay=Bundled Model\r\nrepo=r/bundled\r\nfile=bundled.gguf\r\nsize_gb=1\r\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFetchPrefersFreshRemote(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	cat, notes, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: t.TempDir(),
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("%v (notes: %v)", err, notes)
	}
	if cat.Source != "remote" {
		t.Errorf("source = %q, want remote", cat.Source)
	}
	if len(cat.Entries) != 10 {
		t.Errorf("got %d entries, want the remote list's 10", len(cat.Entries))
	}
}

// The whole point of the fallback chain: an unreachable endpoint costs the
// remote list, not the feature.
func TestFetchFallsBackToBundledWhenEndpointIsDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer srv.Close()

	cat, notes, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: t.TempDir(),
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("%v (notes: %v)", err, notes)
	}
	if cat.Source != "bundled" {
		t.Errorf("source = %q, want bundled", cat.Source)
	}
	if e, ok := cat.Find(1); !ok || e.Display != "Bundled Model" {
		t.Error("did not fall back to the shipped list")
	}
}

// A file that is served but does not validate must not be adopted, and must
// not poison the cache either.
func TestFetchDoesNotAdoptOrCacheAnInvalidCatalog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"schema_version":99,"models":[]}`))
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	cat, _, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: cacheDir,
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cat.Source != "bundled" {
		t.Errorf("source = %q, want bundled", cat.Source)
	}
	if _, err := os.Stat(filepath.Join(cacheDir, cacheName)); !os.IsNotExist(err) {
		t.Error("a catalogue that failed validation was written to the cache")
	}
}

func TestFetchUsesCacheWhenEndpointIsDown(t *testing.T) {
	cacheDir := t.TempDir()
	if err := writeCache(cacheDir, &cacheFile{
		FetchedAt: time.Now().Add(-48 * time.Hour), // old enough to try the network
		Body:      string(liveBytes(t)),
	}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	cat, notes, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: cacheDir,
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("%v (notes: %v)", err, notes)
	}
	if cat.Source != "cache" {
		t.Errorf("source = %q, want cache — the cached remote list beats the shipped one", cat.Source)
	}
	if len(cat.Entries) != 10 {
		t.Errorf("got %d entries, want the cached list's 10", len(cat.Entries))
	}
}

// A young cache is served without asking again. Catalogue changes are measured
// in weeks; re-fetching every launch spends the user's network to learn nothing.
func TestFetchSkipsNetworkWhileCacheIsYoung(t *testing.T) {
	cacheDir := t.TempDir()
	if err := writeCache(cacheDir, &cacheFile{
		FetchedAt: time.Now().Add(-1 * time.Hour),
		Body:      string(liveBytes(t)),
	}); err != nil {
		t.Fatal(err)
	}

	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	cat, _, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: cacheDir,
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if hits != 0 {
		t.Errorf("made %d requests with a one-hour-old cache; want 0", hits)
	}
	if cat.Source != "cache" {
		t.Errorf("source = %q, want cache", cat.Source)
	}
}

// Disabled means disabled: no request is made at all, not a request that is
// then ignored.
func TestFetchMakesNoRequestWhenDisabled(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	cat, _, err := Fetch(Options{
		URL: srv.URL, Enabled: false, CacheDir: t.TempDir(),
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if hits != 0 {
		t.Errorf("made %d requests with the fetch switched off; want 0", hits)
	}
	if cat.Source != "bundled" {
		t.Errorf("source = %q, want bundled", cat.Source)
	}
}

// --- Privacy ----------------------------------------------------------------

// The request must carry nothing that identifies the machine or its hardware.
// Sending VRAM to get a tailored list would be a hardware fingerprint; the
// whole file is fetched and filtered locally instead.
func TestFetchSendsNothingIdentifying(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	if _, _, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: t.TempDir(),
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	}); err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("no request was made")
	}
	if got.Method != http.MethodGet {
		t.Errorf("method = %s, want GET", got.Method)
	}
	if q := got.URL.RawQuery; q != "" {
		t.Errorf("query string = %q, want empty — no parameters of any kind", q)
	}
	if len(got.Cookies()) != 0 {
		t.Errorf("sent %d cookies, want none", len(got.Cookies()))
	}
	if ua := got.Header.Get("User-Agent"); ua != "GobboNet" {
		t.Errorf("User-Agent = %q; it must not carry a version or anything machine-specific", ua)
	}
	for _, h := range []string{"Authorization", "X-Forwarded-For", "From"} {
		if v := got.Header.Get(h); v != "" {
			t.Errorf("sent %s: %q", h, v)
		}
	}
}

// --- Conditional GET --------------------------------------------------------

func TestFetchSendsValidatorsAndHandlesNotModified(t *testing.T) {
	cacheDir := t.TempDir()
	if err := writeCache(cacheDir, &cacheFile{
		FetchedAt: time.Now().Add(-48 * time.Hour),
		ETag:      `"v1"`,
		Body:      string(liveBytes(t)),
	}); err != nil {
		t.Fatal(err)
	}

	var sentETag string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sentETag = r.Header.Get("If-None-Match")
		w.WriteHeader(http.StatusNotModified)
	}))
	defer srv.Close()

	cat, notes, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: cacheDir,
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("%v (notes: %v)", err, notes)
	}
	if sentETag != `"v1"` {
		t.Errorf("If-None-Match = %q, want the cached ETag", sentETag)
	}
	if cat.Source != "cache" {
		t.Errorf("source = %q; a 304 should serve the cached copy", cat.Source)
	}

	// The cache timestamp must be refreshed, or a server that always answers
	// 304 makes us ask again on every single run.
	c, err := readCache(cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(c.FetchedAt) > time.Minute {
		t.Error("a 304 did not refresh the cache timestamp")
	}
}

func TestCacheSurvivesARoundTrip(t *testing.T) {
	dir := t.TempDir()
	in := &cacheFile{FetchedAt: time.Now().Truncate(time.Second), ETag: `"x"`, Body: `{"a":1}`}
	if err := writeCache(dir, in); err != nil {
		t.Fatal(err)
	}
	out, err := readCache(dir)
	if err != nil {
		t.Fatal(err)
	}
	if out.Body != in.Body || out.ETag != in.ETag || !out.FetchedAt.Equal(in.FetchedAt) {
		t.Errorf("round trip changed the cache: %+v -> %+v", in, out)
	}
	// And no .tmp is left behind.
	if _, err := os.Stat(filepath.Join(dir, cacheName+".tmp")); !os.IsNotExist(err) {
		t.Error("the temporary write file was left on disk")
	}
}

func TestCorruptCacheIsIgnoredNotFatal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, cacheName), []byte("{truncated"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	cat, _, err := Fetch(Options{
		URL: srv.URL, Enabled: true, CacheDir: dir,
		BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("a corrupt cache file broke the whole chain: %v", err)
	}
	if cat.Source != "bundled" {
		t.Errorf("source = %q, want bundled", cat.Source)
	}
}

// Belt and braces: the cache envelope is plain JSON someone may need to read.
func TestCacheFileIsReadableJSON(t *testing.T) {
	dir := t.TempDir()
	if err := writeCache(dir, &cacheFile{FetchedAt: time.Now(), Body: "{}"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, cacheName))
	if err != nil {
		t.Fatal(err)
	}
	var any map[string]interface{}
	if err := json.Unmarshal(b, &any); err != nil {
		t.Fatalf("the cache is not readable JSON: %v", err)
	}
}

// --- Force ------------------------------------------------------------------

// A user who opens the add-a-model modal is asking for the live list. The 24
// hour cache is right for a background resolution and wrong for a click: it
// meant reconnecting after an offline launch still showed the bundled list.
func TestForceBypassesTheAgeCheck(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	dir := t.TempDir()
	opts := Options{URL: srv.URL, Enabled: true, CacheDir: dir, ClientVersion: "1.7.0"}

	if _, _, err := Fetch(opts); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if hits != 1 {
		t.Fatalf("after the first fetch the endpoint was hit %d times, want 1", hits)
	}

	// Same minute, no Force: the cache answers and nothing goes out.
	if _, _, err := Fetch(opts); err != nil {
		t.Fatalf("cached fetch: %v", err)
	}
	if hits != 1 {
		t.Errorf("a fresh cache still hit the endpoint %d times, want 1", hits)
	}

	opts.Force = true
	cat, _, err := Fetch(opts)
	if err != nil {
		t.Fatalf("forced fetch: %v", err)
	}
	if hits != 2 {
		t.Errorf("Force did not reach the endpoint: %d hits, want 2", hits)
	}
	if cat.Source != "remote" {
		t.Errorf("source = %q, want remote", cat.Source)
	}
}

// Off means no request. Force is a user asking for a refresh, not permission to
// override a setting they turned off.
func TestForceStillRespectsDisabled(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	cat, _, err := Fetch(Options{
		URL: srv.URL, Enabled: false, Force: true,
		CacheDir: t.TempDir(), BundledPath: writeIni(t), ClientVersion: "1.7.0",
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if hits != 0 {
		t.Errorf("the endpoint was contacted %d times with the fetch switched off", hits)
	}
	if cat.Source != "bundled" {
		t.Errorf("source = %q, want bundled", cat.Source)
	}
}

// Force skips the age check, not the conditional GET. An unchanged catalogue
// should still cost a header exchange rather than a transfer.
func TestForceStillSendsValidators(t *testing.T) {
	var lastIfNoneMatch string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastIfNoneMatch = r.Header.Get("If-None-Match")
		if lastIfNoneMatch != "" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Write(liveBytes(t))
	}))
	defer srv.Close()

	dir := t.TempDir()
	opts := Options{URL: srv.URL, Enabled: true, CacheDir: dir, ClientVersion: "1.7.0"}
	if _, _, err := Fetch(opts); err != nil {
		t.Fatalf("first fetch: %v", err)
	}

	opts.Force = true
	cat, _, err := Fetch(opts)
	if err != nil {
		t.Fatalf("forced fetch: %v", err)
	}
	if lastIfNoneMatch != `"v1"` {
		t.Errorf("If-None-Match = %q, want the stored ETag", lastIfNoneMatch)
	}
	// A 304 falls through to the cached copy, which still has to parse.
	if cat == nil || len(cat.Entries) == 0 {
		t.Error("a 304 left no catalogue; the cached body should have answered")
	}
}
