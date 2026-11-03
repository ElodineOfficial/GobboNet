package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/auth"
)

type localList struct {
	Roots []struct {
		Path, Kind, Source string
		Exists             bool
	} `json:"roots"`
	Found []struct {
		ID, Name, File, Repo, Kind, State, Where string
		Parts                                    int
		SizeGB                                   float64
	} `json:"found"`
	Notes    []string `json:"notes"`
	ModelDir string   `json:"modelDir"`
}

func getLocal(t *testing.T, srv *Server) localList {
	t.Helper()
	rec := do(t, srv, http.MethodGet, "/local-models.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /local-models.json: %d %s", rec.Code, rec.Body.String())
	}
	var out localList
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A HuggingFace cache and a model_dirs folder, each with one model.
func localFixture(t *testing.T, srv *Server) (hubFile, extraFile string) {
	t.Helper()
	dir := t.TempDir()
	hub := filepath.Join(dir, "hub")
	snap := filepath.Join(hub, "models--bartowski--Tiny-GGUF", "snapshots", "rev")
	extra := filepath.Join(dir, "lmstudio", "pub", "Thing-GGUF")
	for _, d := range []string{snap, extra} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	hubFile = filepath.Join(snap, "Tiny-Q4_K_M.gguf")
	extraFile = filepath.Join(extra, "Thing-Q8_0.gguf")
	os.WriteFile(hubFile, []byte("tiny weights"), 0o644)
	os.WriteFile(extraFile, []byte("thing weights"), 0o644)
	t.Setenv("HF_HUB_CACHE", hub)
	t.Setenv("HF_HOME", "")
	t.Setenv("HOME", filepath.Join(dir, "home")) // keep the real ~/.cache out of it
	srv.cfg.ScanHFCache = true
	srv.cfg.ModelDirs = []string{filepath.Join(dir, "lmstudio")}
	return hubFile, extraFile
}

func TestLocalModelsListsTheCacheAndModelDirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("HOME is not where Windows looks for the profile")
	}
	srv, _ := newTestServer(t)
	localFixture(t, srv)

	got := getLocal(t, srv)
	var found []string
	for _, f := range got.Found {
		found = append(found, f.Kind+":"+f.Repo+":"+f.File+":"+f.State)
	}
	want := "hf-cache:bartowski/Tiny-GGUF:Tiny-Q4_K_M.gguf:new folder::Thing-Q8_0.gguf:new"
	if strings.Join(found, " ") != want {
		t.Errorf("found\n got %v\nwant %s", found, want)
	}
	if len(got.Roots) != 3 || got.Roots[0].Source != "HF_HUB_CACHE" || got.Roots[2].Source != "model_dirs" {
		t.Errorf("roots: %+v", got.Roots)
	}

	srv.cfg.ScanHFCache = false
	got = getLocal(t, srv)
	if len(got.Found) != 1 || got.Found[0].File != "Thing-Q8_0.gguf" {
		t.Errorf("with scan_hf_cache = false only model_dirs is read: %+v", got.Found)
	}
}

func TestLinkingAFoundModelPutsItInTheDropdown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("HOME is not where Windows looks for the profile")
	}
	srv, cfg := newTestServer(t)
	hubFile, _ := localFixture(t, srv)
	_ = cfg

	list := getLocal(t, srv)
	var id string
	for _, f := range list.Found {
		if f.File == "Tiny-Q4_K_M.gguf" {
			id = f.ID
		}
	}
	if id == "" {
		t.Fatal("fixture model not found")
	}

	// Only an ID the scan handed out is accepted; a path is not an ID.
	for _, bad := range []string{`{"id":"0000000000000000"}`, `{"id":"` + hubFile + `"}`, `{"path":"` + hubFile + `"}`} {
		rec := do(t, srv, http.MethodPost, "/local-models/link", strings.NewReader(bad))
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 404 or 400", bad, rec.Code)
		}
	}

	rec := do(t, srv, http.MethodPost, "/local-models/link", strings.NewReader(`{"id":"`+id+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("link: %d %s", rec.Code, rec.Body.String())
	}
	dest := filepath.Join(srv.modelDir(), "Tiny-Q4_K_M.gguf")
	if b, err := os.ReadFile(dest); err != nil || string(b) != "tiny weights" {
		t.Fatalf("the models folder does not hold the model: %q %v", b, err)
	}
	if fi, _ := os.Lstat(dest); fi == nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("expected a symlink, not a copy")
	}
	if _, err := os.Stat(hubFile); err != nil {
		t.Error("the original was moved")
	}

	rec = do(t, srv, http.MethodGet, "/models-list.json", nil)
	if !strings.Contains(rec.Body.String(), "Tiny-Q4_K_M.gguf") {
		t.Errorf("the dropdown list does not show the linked model: %s", rec.Body.String())
	}
	for _, f := range getLocal(t, srv).Found {
		if f.File == "Tiny-Q4_K_M.gguf" && f.State != "linked" {
			t.Errorf("after linking, state is %q", f.State)
		}
	}
}

func TestLocalModelRoutesRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t)
	localFixture(t, srv)
	secret, err := auth.NewSecret("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.RequireAuth = true
	srv.secret = secret
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/local-models.json", ""},
		{http.MethodPost, "/local-models/link", `{"id":"x"}`},
	} {
		rec := do(t, srv, tc.method, tc.path, strings.NewReader(tc.body))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401 -- it lists paths on this machine and writes to the models folder",
				tc.method, tc.path, rec.Code)
		}
	}
	entries, _ := os.ReadDir(srv.modelDir())
	if len(entries) != 0 {
		t.Error("an unauthenticated request wrote to the models folder")
	}
}
