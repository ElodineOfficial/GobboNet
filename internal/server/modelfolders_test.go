package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

// /model-folders (1.8.0, issue #68): CONFIG > Model Folders. model_dir,
// model_dirs and scan_hf_cache, read from and saved to config.toml, from this
// PC only.

func modelFoldersServer(t *testing.T) (*Server, config.Config) {
	t.Helper()
	srv, cfg := newTestServer(t)
	// The file says what the server is running with, so nothing is pending.
	body := "llm_url = \"http://127.0.0.1:1\"\n" +
		"data_dir = " + strconv.Quote(cfg.DataDir) + "\n" +
		"model_dir = " + strconv.Quote(cfg.ModelDir) + "\n"
	if err := os.WriteFile(cfg.Path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return srv, cfg
}

func folders(t *testing.T, body []byte) modelFoldersView {
	t.Helper()
	var v modelFoldersView
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, body)
	}
	return v
}

func TestModelFoldersShowsConfigTomlOnThisPC(t *testing.T) {
	srv, cfg := modelFoldersServer(t)
	rec := cfReq{method: http.MethodGet, path: "/model-folders", remote: local}.do(srv)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET from this PC: %d %s", rec.Code, rec.Body.String())
	}
	v := folders(t, rec.Body.Bytes())
	if !v.Editable || v.ModelDir != cfg.ModelDir || len(v.ModelDirs) != 0 || !v.ScanHFCache || v.RestartNeeded {
		t.Errorf("GET = %+v", v)
	}
	if !strings.Contains(rec.Body.String(), `"model_dirs":[]`) {
		t.Errorf("an empty list must come back as [], not null: %s", rec.Body.String())
	}
}

// A phone gets no paths, and cannot save.
func TestModelFoldersAreThisPCOnly(t *testing.T) {
	srv, cfg := modelFoldersServer(t)
	before, _ := os.ReadFile(cfg.Path)
	rec := cfReq{method: http.MethodGet, path: "/model-folders", remote: "192.0.2.7:4000"}.do(srv)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET from a phone: %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), cfg.ModelDir) || strings.Contains(rec.Body.String(), cfg.DataDir) {
		t.Errorf("a phone was sent this PC's folders: %s", rec.Body.String())
	}
	if v := folders(t, rec.Body.Bytes()); v.Editable || !strings.Contains(v.Reason, "only be changed from the PC") {
		t.Errorf("phone GET = %+v", v)
	}
	for _, c := range []cfReq{
		{method: http.MethodPost, path: "/model-folders", remote: "192.0.2.7:4000", body: `{"scan_hf_cache":false}`},
		// A loopback connection forwarded by a proxy on this PC is not this PC.
		{method: http.MethodPost, path: "/model-folders", remote: local, body: `{"scan_hf_cache":false}`,
			headers: map[string]string{"X-Forwarded-For": "203.0.113.9"}},
		// A page on another site, from this PC's own browser.
		{method: http.MethodPost, path: "/model-folders", remote: local, origin: "https://elsewhere.example", body: `{"scan_hf_cache":false}`},
		{method: http.MethodPost, path: "/model-folders", remote: local, fetchSite: "cross-site", body: `{"scan_hf_cache":false}`},
		// A save must say it comes from GobboNet's page, as the Config File editor's does.
		{method: http.MethodPost, path: "/model-folders", remote: local, body: `{"scan_hf_cache":false}`},
	} {
		if rec := c.do(srv); rec.Code != http.StatusForbidden {
			t.Errorf("%+v: %d, want 403", c, rec.Code)
		}
	}
	if after, _ := os.ReadFile(cfg.Path); string(after) != string(before) {
		t.Errorf("a refused save changed config.toml:\n%s", after)
	}
}

func TestModelFoldersSaveWritesConfigTomlForTheNextStart(t *testing.T) {
	srv, cfg := modelFoldersServer(t)
	chosen := filepath.Join(filepath.Dir(cfg.Path), "My Models")
	body, _ := json.Marshal(map[string]any{
		"model_dir":     "  " + chosen + string(filepath.Separator) + "  ",
		"model_dirs":    []string{"/mnt/other app/models", "", "~/lm-studio", "/mnt/other app/models"},
		"scan_hf_cache": false,
	})
	rec := cfReq{method: http.MethodPost, path: "/model-folders", remote: local, origin: "http://127.0.0.1:8080", body: string(body)}.do(srv)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	v := folders(t, rec.Body.Bytes())
	if !v.Saved || !v.RestartNeeded || v.ModelDir != chosen {
		t.Errorf("answer = %+v, want saved, a restart pending, model_dir %s", v, chosen)
	}
	st, err := os.Stat(chosen)
	if err != nil || !st.IsDir() {
		t.Fatalf("the new models folder was not created: %v", err)
	}
	if st.Mode().Perm() != 0o700 {
		t.Errorf("new models folder is %v, want 0700 as setup makes it", st.Mode().Perm())
	}
	if left, _ := filepath.Glob(filepath.Join(chosen, ".gobbonet-write-test-*")); len(left) != 0 {
		t.Errorf("the write test left %v behind", left)
	}
	onDisk, err := config.Load(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.ModelDir != chosen || onDisk.ScanHFCache ||
		strings.Join(onDisk.ModelDirs, "|") != "/mnt/other app/models|~/lm-studio" {
		t.Errorf("config.toml now has model_dir=%q model_dirs=%q scan_hf_cache=%v", onDisk.ModelDir, onDisk.ModelDirs, onDisk.ScanHFCache)
	}
	if srv.modelDir() != cfg.ModelDir {
		t.Error("the running server switched models folder under a loaded model; it should wait for the next start")
	}

	// The same again changes nothing, and the file is not rewritten.
	before, _ := os.ReadFile(cfg.Path)
	rec = cfReq{method: http.MethodPost, path: "/model-folders", remote: local, origin: "http://127.0.0.1:8080", body: string(body)}.do(srv)
	if v := folders(t, rec.Body.Bytes()); rec.Code != http.StatusOK || v.Saved {
		t.Errorf("an unchanged save: %d %+v", rec.Code, v)
	}
	if after, _ := os.ReadFile(cfg.Path); string(after) != string(before) {
		t.Error("an unchanged save rewrote config.toml")
	}
}

func TestModelFoldersRefusesBadFoldersAndWritesNothing(t *testing.T) {
	srv, cfg := modelFoldersServer(t)
	aFile := filepath.Join(filepath.Dir(cfg.Path), "not-a-folder")
	os.WriteFile(aFile, []byte("x"), 0o600)
	many := make([]string, maxModelDirs+1)
	for i := range many {
		many[i] = "/m/" + strconv.Itoa(i)
	}
	manyJSON, _ := json.Marshal(map[string]any{"model_dirs": many})
	aFileJSON, _ := json.Marshal(map[string]any{"model_dir": aFile})
	before, _ := os.ReadFile(cfg.Path)
	for _, body := range []string{
		`not json`,
		`{"model_dir":"models"}`,
		`{"model_dir":""}`,
		`{"model_dir":"/tmp/a\u0007b"}`,
		string(aFileJSON),
		`{"model_dirs":["relative/folder"]}`,
		`{"model_dirs":["/ok", "/bad\nline"]}`,
		string(manyJSON),
		// One bad part stops the good parts too.
		`{"scan_hf_cache":false,"model_dirs":["nope"]}`,
	} {
		rec := cfReq{method: http.MethodPost, path: "/model-folders", remote: local, origin: "http://127.0.0.1:8080", body: body}.do(srv)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s: %d %s, want 400", body, rec.Code, rec.Body.String())
		}
	}
	if after, _ := os.ReadFile(cfg.Path); string(after) != string(before) {
		t.Errorf("a refused save changed config.toml:\n%s", after)
	}
	if rec := (cfReq{method: http.MethodDelete, path: "/model-folders", remote: local}).do(srv); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE: %d, want 405", rec.Code)
	}
}

func TestModelFoldersRefusesAFolderItCannotWrite(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	srv, cfg := modelFoldersServer(t)
	locked := filepath.Join(filepath.Dir(cfg.Path), "locked")
	os.Mkdir(locked, 0o500)
	t.Cleanup(func() { os.Chmod(locked, 0o700) })
	body, _ := json.Marshal(map[string]any{"model_dir": locked})
	rec := cfReq{method: http.MethodPost, path: "/model-folders", remote: local, origin: "http://127.0.0.1:8080", body: string(body)}.do(srv)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "cannot write to") {
		t.Errorf("POST a read-only folder: %d %s", rec.Code, rec.Body.String())
	}
}

func TestModelFoldersSaysWhenAnEnvironmentVariableWins(t *testing.T) {
	srv, _ := modelFoldersServer(t)
	t.Setenv("GOBBONET_MODEL_DIR", "/elsewhere")
	rec := cfReq{method: http.MethodGet, path: "/model-folders", remote: local}.do(srv)
	if v := folders(t, rec.Body.Bytes()); v.EnvOverride != "GOBBONET_MODEL_DIR" {
		t.Errorf("env_override = %q", v.EnvOverride)
	}
}
