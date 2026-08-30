package server

// Tests for /catalog.json and /model-download — the add-a-model modal's
// server side.
//
// The download itself is not exercised here: it reaches HuggingFace, and a test
// that needs the network is a test that fails on a train. internal/modelfetch
// carries that logic unchanged from the wizard, where setup_test.go already
// covers it. What is new, and what these check, is everything around it — the
// catalogue projection, index resolution, the one-at-a-time policy, the free
// space guard, and the auth gate.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/modelfetch"
	"github.com/jmccardle/gobbonet/internal/supervisor"
)

// testCatalog is a two-entry models.ini in the layout gen-catalog.py writes,
// CRLF included, since that is what catalog.Load is built to read.
const testCatalog = "[catalog]\r\ncount=2\r\n\r\n" +
	"[recommend]\r\ncpu_only=2\r\ndefault=2\r\n\r\n" +
	"[1]\r\ndisplay=Big Model\r\nrepo=someone/Big-GGUF\r\nfile=big.gguf\r\n" +
	"size_gb=16\r\nmin_vram=16\r\nctx=16384\r\nkv=q8_0\r\n\r\n" +
	"[2]\r\ndisplay=Small Model\r\nrepo=someone/Small-GGUF\r\nfile=small.gguf\r\n" +
	"size_gb=3.4\r\nmin_vram=4\r\nctx=32768\r\nkv=f16\r\n"

// withCatalog installs a parsed catalogue directly, bypassing Discover(). The
// search order looks beside the binary, which in a test is the go test cache —
// not somewhere to be writing models.ini files.
func withCatalog(t *testing.T, srv *Server) *catalog.Catalog {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.ini")
	if err := os.WriteFile(path, []byte(testCatalog), 0o644); err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(path)
	if err != nil {
		t.Fatalf("test catalogue does not parse: %v", err)
	}
	srv.catMu.Lock()
	srv.cat, srv.catErr = cat, nil
	srv.catMu.Unlock()
	return cat
}

// --- /catalog.json ----------------------------------------------------------

func TestCatalogJSONShape(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	rec := do(t, srv, http.MethodGet, "/catalog.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)

	models, ok := body["models"].([]any)
	if !ok {
		t.Fatalf("models is not a list: %#v", body["models"])
	}
	if len(models) != 2 {
		t.Fatalf("got %d models, want 2", len(models))
	}

	// The modal reads these by name; renaming one breaks it silently.
	first := models[0].(map[string]any)
	for _, key := range []string{"index", "display", "file", "sizeGB", "minVRAM", "ctx", "installed"} {
		if _, ok := first[key]; !ok {
			t.Errorf("catalogue entry is missing %q: %#v", key, first)
		}
	}
	// repo must not be here. The client submits an index and the server resolves
	// it, so the download target is never something the browser names.
	if _, leaked := first["repo"]; leaked {
		t.Error("catalogue entry exposes repo; the client should only ever send an index")
	}

	if body["default"] != float64(2) {
		t.Errorf("default = %v, want 2", body["default"])
	}
	if _, ok := body["freeGB"]; !ok {
		t.Error("freeGB missing; the modal warns on low disk with it")
	}
}

// A model already in the model directory is marked installed, so the modal can
// say so rather than offering a 16 GB re-download of a file the user has.
func TestCatalogMarksInstalledModels(t *testing.T) {
	srv, cfg := newTestServer(t)
	withCatalog(t, srv)

	if err := os.MkdirAll(cfg.ModelDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.ModelDir, "small.gguf"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := decode(t, do(t, srv, http.MethodGet, "/catalog.json", nil))
	for _, m := range body["models"].([]any) {
		e := m.(map[string]any)
		want := e["file"] == "small.gguf"
		if e["installed"] != want {
			t.Errorf("%v: installed = %v, want %v", e["file"], e["installed"], want)
		}
	}
}

// No models.ini is not a server error. Chat works without a download list, so
// the feature reports itself unavailable and everything else carries on.
func TestCatalogUnavailableIsNotFatal(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.catMu.Lock()
	srv.catErr = os.ErrNotExist
	srv.catMu.Unlock()

	rec := do(t, srv, http.MethodGet, "/catalog.json", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", rec.Code)
	}
	// The rest of the server is still fine.
	if health := do(t, srv, http.MethodGet, "/health-fileserver", nil); health.Code != http.StatusOK {
		t.Errorf("health is %d with no catalogue; a missing models.ini must not take the server down", health.Code)
	}
}

// --- /model-download --------------------------------------------------------

func TestModelDownloadIdleBeforeAnyRequest(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	rec := do(t, srv, http.MethodGet, "/model-download", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if state := decode(t, rec)["state"]; state != "idle" {
		t.Errorf("state = %v, want idle", state)
	}
}

func TestModelDownloadRejectsUnknownIndex(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"index":99}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if srv.downloads.status().State != "idle" {
		t.Error("a rejected index started a download anyway")
	}
}

func TestModelDownloadRejectsBadJSON(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader("not json"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestModelDownloadRejectsOtherMethods(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	rec := do(t, srv, http.MethodDelete, "/model-download", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d, want 405", rec.Code)
	}
}

// The wizard's one-at-a-time policy, carried over. A second POST while a
// download is running reports the running one instead of starting another —
// two concurrent multi-gigabyte transfers race for the line and the disk, and
// the modal has one progress bar.
func TestModelDownloadOneAtATime(t *testing.T) {
	srv, cfg := newTestServer(t)
	cat := withCatalog(t, srv)

	entry, ok := cat.Find(2)
	if !ok {
		t.Fatal("test catalogue lost entry 2")
	}
	// Seed a running download without touching the network: begin() is the
	// concurrency gate, and what matters is that it refuses the second caller.
	first := modelfetch.New(entry, cfg.ModelDir)
	srv.downloads.mu.Lock()
	srv.downloads.current = first
	srv.downloads.mu.Unlock()

	// Ask for entry 2 as well: small enough to clear the disk guard anywhere, so
	// what this test observes is the concurrency policy and not a space refusal.
	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"index":2}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Started bool              `json:"started"`
		Status  modelfetch.Status `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Started {
		t.Error("started a second download while one was running")
	}
	if out.Status.Display != "Small Model" {
		t.Errorf("reported %q; should report the download actually running", out.Status.Display)
	}
	srv.downloads.mu.Lock()
	same := srv.downloads.current == first
	srv.downloads.mu.Unlock()
	if !same {
		t.Error("the running download was replaced by the second request")
	}
}

// Free space is checked before a byte moves. A 16 GB download that dies at 15
// costs the user far more than one dialog does.
func TestModelDownloadRefusesWhenDiskIsTooSmall(t *testing.T) {
	srv, cfg := newTestServer(t)
	withCatalog(t, srv)

	free := modelfetch.FreeBytes(cfg.ModelDir)
	if free == 0 {
		t.Skip("cannot measure free space here; the guard treats that as do-not-block")
	}
	// Entry 1 is 16 GB and needs 17 with headroom. Only meaningful if the disk
	// under the test really is smaller than that.
	if free > 17*(1<<30) {
		t.Skip("this disk has room for the 16 GB entry, so the guard should not fire")
	}

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"index":1}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "free") {
		t.Errorf("the message should tell the user it is about disk space: %s", rec.Body.String())
	}
	if srv.downloads.status().State != "idle" {
		t.Error("started a download that was refused for disk space")
	}
}

// A download in flight answers "one is already running" even when the model
// asked for would not fit on disk. Order matters here: free space falls while a
// large model lands, so checking space first can refuse the second click with a
// disk message when the real reason is the running download.
func TestModelDownloadReportsRunningBeforeDiskSpace(t *testing.T) {
	srv, cfg := newTestServer(t)
	cat := withCatalog(t, srv)

	small, _ := cat.Find(2)
	srv.downloads.mu.Lock()
	srv.downloads.current = modelfetch.New(small, cfg.ModelDir)
	srv.downloads.mu.Unlock()

	// Entry 1 is 16 GB. On a disk with room for it this asserts nothing useful.
	if free := modelfetch.FreeBytes(cfg.ModelDir); free == 0 || free > 17*(1<<30) {
		t.Skip("needs a disk too small for the 16 GB entry for the two answers to differ")
	}

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"index":1}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 — a running download should be reported, not a disk error: %s",
			rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Free some space") {
		t.Error("answered with a disk-space error while a download was already running")
	}
}

// --- Auth -------------------------------------------------------------------

// These two routes write files to disk and make outbound requests, and this
// server can be bound to the LAN. Unauthenticated, /model-download lets any
// device that can reach the port fill the disk.
func TestModelRoutesRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret

	for _, tc := range []struct {
		method, path, body string
	}{
		{http.MethodGet, "/catalog.json", ""},
		{http.MethodGet, "/model-download", ""},
		{http.MethodPost, "/model-download", `{"index":1}`},
	} {
		var body *strings.Reader
		if tc.body != "" {
			body = strings.NewReader(tc.body)
		} else {
			body = strings.NewReader("")
		}
		rec := do(t, srv, tc.method, tc.path, body)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401 — this route must not be reachable unauthenticated",
				tc.method, tc.path, rec.Code)
		}
	}

	if srv.downloads.status().State != "idle" {
		t.Fatal("an unauthenticated request started a download")
	}
}

// --- Catalogue tuning at swap time -------------------------------------------
//
// The bug these cover: the download handler wrote the new model's ctx/kv to
// config.toml at download START and never told s.tuning or the supervisor. So
// the swap the modal offers respawned llama-server on the PREVIOUS model's
// settings, and a download the user never switched to moved the settings of the
// model they were still running. Both are now done at swap time, for the model
// actually being launched.

func TestSwapAppliesTheCatalogueTuningForThatModel(t *testing.T) {
	srv, cfg := newTestServer(t)
	withCatalog(t, srv)

	// Something else's settings are in force to start with.
	srv.applyTuning(supervisor.Tuning{CtxSize: 4096, GPULayers: 99, KVCacheType: "f16"}, false)

	// small.gguf is ctx=32768 kv=f16 in testCatalog. Chosen over big.gguf,
	// which is 16384 / q8_0 -- exactly what config.Default() seeds, so the
	// persistence check below would read back the same whether anything was
	// written or not.
	srv.applyCatalogTuning("small.gguf")

	current, _, _ := srv.tuning.get()
	if current.CtxSize != 32768 {
		t.Errorf("ctx in force = %d, want 32768 (Small Model's)", current.CtxSize)
	}
	if current.KVCacheType != "f16" {
		t.Errorf("kv in force = %q, want f16", current.KVCacheType)
	}
	// The catalogue has no opinion on GPU layers and must not invent one.
	if current.GPULayers != 99 {
		t.Errorf("gpu_layers = %d, want 99 left alone", current.GPULayers)
	}

	// And it persists, so a restart lands on the same settings.
	saved, err := config.Load(cfg.Path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if saved.CtxSize != 32768 || saved.KVCacheType != "f16" {
		t.Errorf("config.toml has ctx=%d kv=%s, want 32768/f16",
			saved.CtxSize, saved.KVCacheType)
	}
}

// perf.toml is what the user typed in the panel. A catalogue entry moves the
// baseline underneath it and must not quietly overrule it.
func TestCatalogueTuningDoesNotOverrideAUserSetting(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	srv.applyTuning(supervisor.Tuning{CtxSize: 8192, GPULayers: 0, KVCacheType: "q4_0"}, true)
	srv.applyCatalogTuning("small.gguf")

	current, auto, overridden := srv.tuning.get()
	if !overridden {
		t.Error("the override was dropped")
	}
	if current.CtxSize != 8192 || current.KVCacheType != "q4_0" {
		t.Errorf("in force = ctx %d kv %s, want the user's 8192/q4_0 untouched",
			current.CtxSize, current.KVCacheType)
	}
	// The baseline still moves, so /perf reset returns to the model's own
	// numbers rather than the previous model's.
	if auto.CtxSize != 32768 || auto.KVCacheType != "f16" {
		t.Errorf("baseline = ctx %d kv %s, want 32768/f16", auto.CtxSize, auto.KVCacheType)
	}
}

// A GGUF the user dropped in by hand is not in the catalogue and has no
// published tuning. Whatever is in force stays in force.
func TestSwapToAnUnknownModelChangesNothing(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	before := supervisor.Tuning{CtxSize: 4096, GPULayers: 99, KVCacheType: "f16"}
	srv.applyTuning(before, false)
	srv.applyCatalogTuning("something-someone-downloaded.gguf")

	if current, _, _ := srv.tuning.get(); current != before {
		t.Errorf("tuning changed to %+v for a model not in the catalogue", current)
	}
}

// Resolving the catalogue can mean a five second network fetch. That does not
// belong in front of a model swap for a user who never opened the modal.
func TestSwapDoesNotResolveTheCatalogue(t *testing.T) {
	srv, _ := newTestServer(t)
	// Deliberately no withCatalog: nothing is resolved.

	before := supervisor.Tuning{CtxSize: 4096, GPULayers: 99, KVCacheType: "f16"}
	srv.applyTuning(before, false)
	srv.applyCatalogTuning("big.gguf")

	if current, _, _ := srv.tuning.get(); current != before {
		t.Errorf("tuning changed to %+v with no catalogue in hand", current)
	}
	srv.catMu.Lock()
	resolved := srv.cat != nil
	srv.catMu.Unlock()
	if resolved {
		t.Error("a swap resolved the catalogue; that is a network fetch in the swap path")
	}
}

// A catalogue is editable on disk and arrives over the network. A window the
// panel would refuse does not get a private door in through here.
func TestCatalogueTuningRejectsValuesThePanelWouldRefuse(t *testing.T) {
	srv, _ := newTestServer(t)
	cat := withCatalog(t, srv)

	cat.Entries[0].Ctx = 99999999   // past MaxCtxSize
	cat.Entries[0].KV = "q3_wobble" // not a real quantisation

	before := supervisor.Tuning{CtxSize: 4096, GPULayers: 99, KVCacheType: "f16"}
	srv.applyTuning(before, false)
	srv.applyCatalogTuning("big.gguf")

	if current, _, _ := srv.tuning.get(); current != before {
		t.Errorf("tuning became %+v from an out-of-range catalogue entry", current)
	}
}

// The write used to land at download start, which moved the settings of the
// model still running for a download the user might never switch to — and did
// it even when the download then failed.
func TestStartingADownloadDoesNotTouchTheRunningModelsSettings(t *testing.T) {
	srv, cfg := newTestServer(t)
	cat := withCatalog(t, srv)

	// Two adjustments so this tests the side effects and nothing else.
	//
	// The size comes down because the disk guard would otherwise refuse 16 GB
	// on a small build machine, and a refusal never reached the code under
	// test — it has to actually start for "starting it changed nothing" to
	// mean anything.
	//
	// The model directory is pointed inside a regular file, so Run() fails on
	// its first line, at MkdirAll, and the goroutine never reaches
	// HuggingFace. A unit test that needs the network is a test that fails on
	// a train.
	// Index 2 is Small Model, ctx 32768 / f16. Index 1 would look like a pass
	// whatever the code did: Big Model is 16384 / q8_0, which is exactly what
	// config.Default() seeds, so a write and no write read back the same.
	cat.Entries[1].SizeGB = 0.001
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv.cfg.ModelDir = filepath.Join(blocked, "models")

	before := supervisor.Tuning{CtxSize: 4096, GPULayers: 99, KVCacheType: "f16"}
	srv.applyTuning(before, false)

	configBefore, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"index":2}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if started := decode(t, rec)["started"]; started != true {
		t.Fatalf("started = %v; the download has to begin for this test to mean anything", started)
	}

	if current, _, _ := srv.tuning.get(); current != before {
		t.Errorf("starting a download changed the running model's tuning to %+v", current)
	}
	configAfter, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(configAfter) != string(configBefore) {
		t.Errorf("starting a download rewrote config.toml:\n--- before ---\n%s\n--- after ---\n%s",
			configBefore, configAfter)
	}
	saved, err := config.Load(cfg.Path)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if saved.CtxSize == 32768 || saved.KVCacheType == "f16" {
		t.Errorf("config carries Small Model's ctx=%d kv=%s after merely downloading it",
			saved.CtxSize, saved.KVCacheType)
	}
}

// --- Clearing a finished download --------------------------------------------

func TestClearForgetsAFinishedDownload(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	// Run() against a models directory that cannot be created fails on its
	// first line and lands in "error", which is terminal. That reaches the
	// state through the same public path a real failure takes, rather than
	// reaching into modelfetch to fake one.
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	dl := modelfetch.New(catalog.Entry{Display: "Big Model", File: "big.gguf"},
		filepath.Join(blocked, "models"))
	dl.Run()
	if st := dl.Status(); st.State != "error" {
		t.Fatalf("setup: download state is %q, want a terminal error", st.State)
	}

	srv.downloads.mu.Lock()
	srv.downloads.current = dl
	srv.downloads.mu.Unlock()

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"clear":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if cleared := decode(t, rec)["cleared"]; cleared != true {
		t.Errorf("cleared = %v, want true", cleared)
	}
	if st := srv.downloads.status(); st.State != "idle" {
		t.Errorf("state after clear = %q, want idle", st.State)
	}
}

// Clearing must not be able to abandon a transfer in flight.
func TestClearRefusesWhileADownloadIsRunning(t *testing.T) {
	srv, _ := newTestServer(t)
	withCatalog(t, srv)

	srv.downloads.mu.Lock()
	srv.downloads.current = modelfetch.New(catalog.Entry{Display: "Big Model", File: "big.gguf"}, t.TempDir())
	srv.downloads.mu.Unlock()

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"clear":true}`))
	if cleared := decode(t, rec)["cleared"]; cleared != false {
		t.Errorf("cleared = %v, want false while running", cleared)
	}
	if st := srv.downloads.status(); st.State != "running" {
		t.Errorf("state = %q, want the download left running", st.State)
	}
}

// Closing the modal must not be able to trigger a catalogue fetch.
func TestClearWorksWithNoCatalogue(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.catMu.Lock()
	srv.catErr = os.ErrNotExist
	srv.catMu.Unlock()

	rec := do(t, srv, http.MethodPost, "/model-download", strings.NewReader(`{"clear":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d with no catalogue, want 200: clearing is not a catalogue operation", rec.Code)
	}
}

// --- Refresh ------------------------------------------------------------------

// The resolution was memoised for the life of the process, so a user who opened
// the modal offline kept the bundled list until GobboNet was restarted.
func TestRefreshDropsAMemoisedFailure(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.catMu.Lock()
	srv.catErr = os.ErrNotExist
	srv.catMu.Unlock()

	if rec := do(t, srv, http.MethodGet, "/catalog.json", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("without refresh: got %d, want the cached 503", rec.Code)
	}

	srv.refreshCatalog()
	srv.catMu.Lock()
	stillCached := srv.catErr != nil
	srv.catMu.Unlock()
	if stillCached {
		t.Error("refresh left the failure cached; the modal would never recover without a restart")
	}
}

// "The model catalogue is not available." on its own is not actionable. The
// notes name the step that failed, and used to be dropped on exactly this path.
func TestUnavailableCatalogueExplainsItself(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.catMu.Lock()
	srv.catErr = os.ErrNotExist
	srv.catNotes = []string{
		"could not reach the catalogue: no such host",
		"using the model list that shipped with GobboNet",
	}
	srv.catMu.Unlock()

	body := decode(t, do(t, srv, http.MethodGet, "/catalog.json", nil))
	notes, ok := body["notes"].([]any)
	if !ok || len(notes) != 2 {
		t.Fatalf("notes = %v, want the two provenance lines", body["notes"])
	}
	if body["detail"] == nil || body["detail"] == "" {
		t.Error("detail is empty; the underlying error is the other half of the answer")
	}
}
