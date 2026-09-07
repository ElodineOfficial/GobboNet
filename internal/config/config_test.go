package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A non-empty server_exe pointing at nothing must be fatal.
//
// The old behaviour turned one typo into a server that ran happily in remote
// mode, proxied to a loopback port nothing listened on, and reported
// "status":"ok" from the very endpoint you would use to work out why.
func TestModeDetection(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "llama-server")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("empty server_exe is remote", func(t *testing.T) {
		cfg := Config{ServerExe: ""}
		mode, err := cfg.Mode()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mode != ModeRemote {
			t.Errorf("mode: got %q, want remote", mode)
		}
	})

	t.Run("existing server_exe is local", func(t *testing.T) {
		cfg := Config{ServerExe: exe}
		mode, err := cfg.Mode()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mode != ModeLocal {
			t.Errorf("mode: got %q, want local", mode)
		}
	})

	t.Run("missing server_exe is fatal", func(t *testing.T) {
		cfg := Config{ServerExe: filepath.Join(dir, "typo-llama-server")}
		if _, err := cfg.Mode(); err == nil {
			t.Fatal("a server_exe pointing at a missing file was silently accepted")
		}
	})

	t.Run("model_dir does not affect mode", func(t *testing.T) {
		// "Do I supervise the process" and "where do I enumerate models" are
		// unrelated questions; a local install with an empty models directory
		// on first boot must still be local mode.
		cfg := Config{ServerExe: exe, ModelDir: filepath.Join(dir, "no-such-dir")}
		mode, err := cfg.Mode()
		if err != nil {
			t.Fatalf("a missing model_dir must not break mode detection: %v", err)
		}
		if mode != ModeLocal {
			t.Errorf("mode: got %q, want local", mode)
		}
	})
}

// An unknown key is nearly always a typo, and silently ignoring it means the
// setting the user thought they changed never took effect.
func TestLoadRejectsUnknownKeys(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nlisten_prot = 9999\n")
	_, err := Load(path)
	if err == nil {
		t.Fatal("an unknown config key was accepted")
	}
	if !strings.Contains(err.Error(), "listen_prot") {
		t.Errorf("the error should name the offending key, got: %v", err)
	}
}

func TestLoadMissingFile(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "absent.toml"))
	if err != ErrNotFound {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

// `config set` must not destroy the comments — they are the documentation.
func TestSetPreservesComments(t *testing.T) {
	path := writeConfig(t, DefaultTOML)

	if err := Set(path, "llm_url", "http://192.168.1.100:8080"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)

	if !strings.Contains(body, `llm_url = "http://192.168.1.100:8080"`) {
		t.Error("the new value was not written")
	}
	if strings.Contains(body, `llm_url = "http://127.0.0.1:11434"`) {
		t.Error("the old value is still present -- Set appended instead of replacing")
	}
	if !strings.Contains(body, "GOBBONET - LOCAL AI CHAT") {
		t.Error("the header comment block was destroyed")
	}
	if !strings.Contains(body, "# --- Listener") {
		t.Error("section comments were destroyed")
	}

	// The result must still parse, and round-trip through Get.
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("the file no longer parses after Set: %v", err)
	}
	got, err := cfg.Get("llm_url")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://192.168.1.100:8080" {
		t.Errorf("Get after Set: got %q", got)
	}
}

// A commented-out documented default should be uncommented by Set, not
// duplicated below it.
func TestSetUncommentsDefault(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n# web_root = \"\"\n")

	if err := Set(path, "web_root", "/srv/web"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	body := string(raw)

	if strings.Count(body, "web_root") != 1 {
		t.Errorf("web_root appears %d times, want 1:\n%s", strings.Count(body, "web_root"), body)
	}
	if !strings.Contains(body, `web_root = "/srv/web"`) {
		t.Errorf("value not written:\n%s", body)
	}
}

func TestSetAppendsMissingKey(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	if err := Set(path, "listen_port", "9090"); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenPort != 9090 {
		t.Errorf("listen_port: got %d, want 9090", cfg.ListenPort)
	}
}

// A bad value must be refused before the file is touched, or `config set` can
// leave behind a config the server cannot start from.
func TestSetValidatesBeforeWriting(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nlisten_port = 8080\n")
	before, _ := os.ReadFile(path)

	if err := Set(path, "listen_port", "not-a-number"); err == nil {
		t.Fatal("a non-numeric port was accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("the file was modified despite the value being rejected")
	}
}

func TestSetRejectsUnknownKey(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	if err := Set(path, "nonsense_key", "x"); err == nil {
		t.Error("an unknown key was accepted by Set")
	}
}

// Relative paths are interpreted against the config file's directory, so a
// config living next to launch.bat behaves the way the Windows tree always did.
func TestRelativePathsResolveAgainstConfigDir(t *testing.T) {
	dir := t.TempDir()
	webRoot := filepath.Join(dir, "web")
	if err := os.MkdirAll(webRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "config.toml")
	body := "llm_url = \"http://x:1\"\nmodel_dir = \"./models\"\nweb_root = \"./web\"\ndata_dir = \"./data\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelDir != filepath.Join(dir, "models") {
		t.Errorf("model_dir: got %q, want %q", cfg.ModelDir, filepath.Join(dir, "models"))
	}
	if cfg.WebRoot != webRoot {
		t.Errorf("web_root: got %q, want %q", cfg.WebRoot, webRoot)
	}
}

func TestNormaliseBaseURL(t *testing.T) {
	cases := map[string]string{
		"192.168.1.5:8080":         "http://192.168.1.5:8080",
		"http://x:1/":              "http://x:1",
		"https://host.example.com": "https://host.example.com",
		"":                         "",
	}
	for in, want := range cases {
		if got := normaliseBaseURL(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

// XDG separation: config is not data. Putting config under ~/.local/share was
// the bug this replaces.
func TestXDGDirectoriesAreSeparate(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/cfg")
	t.Setenv("XDG_DATA_HOME", "/tmp/data")

	if got, want := ConfigDir(), "/tmp/cfg/gobbonet"; got != want {
		t.Errorf("ConfigDir: got %q, want %q", got, want)
	}
	if got, want := DataDir(), "/tmp/data/gobbonet"; got != want {
		t.Errorf("DataDir: got %q, want %q", got, want)
	}
	if ConfigDir() == DataDir() {
		t.Error("config and data directories must not be the same")
	}
}

// The default file must actually parse as the defaults it documents, or the
// generated config and the in-memory defaults have drifted.
func TestDefaultTOMLMatchesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The file holds access_secret and llm_api_key.
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("permissions: got %o, want 600", perm)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("the generated default config does not parse: %v", err)
	}

	want := Default()
	if cfg.LLMURL != want.LLMURL {
		t.Errorf("llm_url: file says %q, Default() says %q", cfg.LLMURL, want.LLMURL)
	}
	if cfg.ListenPort != want.ListenPort {
		t.Errorf("listen_port: file says %d, Default() says %d", cfg.ListenPort, want.ListenPort)
	}
	if cfg.CtxSize != want.CtxSize {
		t.Errorf("ctx_size: file says %d, Default() says %d", cfg.CtxSize, want.CtxSize)
	}
	if cfg.KVCacheType != want.KVCacheType {
		t.Errorf("kv_cache_type: file says %q, Default() says %q", cfg.KVCacheType, want.KVCacheType)
	}
	if cfg.SessionTTLHours != want.SessionTTLHours {
		t.Errorf("session_ttl_hours: file says %d, Default() says %d", cfg.SessionTTLHours, want.SessionTTLHours)
	}
	if cfg.JobMaxConcurrent != want.JobMaxConcurrent {
		t.Errorf("job_max_concurrent: file says %d, Default() says %d", cfg.JobMaxConcurrent, want.JobMaxConcurrent)
	}
}

func TestHostAllowed(t *testing.T) {
	cfg := Config{AllowedHosts: []string{"gobbonet.example.com"}}

	allowed := []string{
		"127.0.0.1:8080",
		"192.168.1.50:8080",
		"10.0.0.4",
		"[::1]:8080",
		"localhost:8080",
		"localhost",
		"desktop.local:8080",
		"gobbonet.example.com",
		"GOBBONET.EXAMPLE.COM", // Host comparison is case-insensitive
	}
	for _, host := range allowed {
		if !cfg.HostAllowed(host) {
			t.Errorf("host %q was rejected but should be allowed", host)
		}
	}

	// Rebinding needs a name; an unknown one must not reach us.
	rejected := []string{"attacker.example.com", "evil.com:8080", ""}
	for _, host := range rejected {
		if cfg.HostAllowed(host) {
			t.Errorf("host %q was allowed but should be rejected", host)
		}
	}
}

func TestEnvOverridesFile(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://from-file:1\"\nlisten_port = 8080\n")

	t.Setenv("GOBBONET_LLM_URL", "http://from-env:2")
	t.Setenv("GOBBONET_LISTEN_PORT", "9999")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMURL != "http://from-env:2" {
		t.Errorf("llm_url: got %q, want the environment value", cfg.LLMURL)
	}
	if cfg.ListenPort != 9999 {
		t.Errorf("listen_port: got %d, want 9999", cfg.ListenPort)
	}
}

// The GEMMA_* names fileserver.ps1 read still work, so an existing Windows-side
// setup carries over without being re-entered.
func TestLegacyEnvNamesStillWork(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://from-file:1\"\n")
	t.Setenv("GEMMA_LLM_URL", "http://legacy:3")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMURL != "http://legacy:3" {
		t.Errorf("llm_url: got %q, want the legacy environment value", cfg.LLMURL)
	}
}

// A key file keeps the secret out of a config the launchers rewrite.
func TestAPIKeyFileWins(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "apikey")
	if err := os.WriteFile(keyPath, []byte("  sk-from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "config.toml")
	body := "llm_url = \"http://x:1\"\nllm_api_key = \"inline\"\nllm_api_key_file = \"./apikey\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMAPIKey != "sk-from-file" {
		t.Errorf("llm_api_key: got %q, want the trimmed file contents", cfg.LLMAPIKey)
	}
}

// A key file the user named but that isn't readable must stop startup: silently
// going out unauthenticated would fail confusingly much later.
// A missing llm_api_key_file must stop the server starting, but must NOT stop
// the config being read. Launcher scripts call `gobbonet config get`, and a
// broken key path is no reason they cannot ask for the port — or repair the
// setting with `config set`.
func TestMissingAPIKeyFileIsFatalToServeButNotToRead(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nllm_api_key_file = \"/nonexistent/key\"\n")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load must succeed so `config get` keeps working: %v", err)
	}
	if cfg.LLMURL != "http://x:1" {
		t.Errorf("the rest of the config did not survive: llm_url = %q", cfg.LLMURL)
	}
	if err := cfg.Runnable(); err == nil {
		t.Error("a missing llm_api_key_file was silently ignored; serve would run unauthenticated")
	} else if !strings.Contains(err.Error(), "/nonexistent/key") {
		t.Errorf("error should name the missing file, got %v", err)
	}
	// It must never be mistaken for a usable key.
	if cfg.LLMAPIKey != "" {
		t.Errorf("LLMAPIKey should stay empty, got %q", cfg.LLMAPIKey)
	}
}

// A key file that IS present is read, trimmed, and wins over the inline value.
func TestAPIKeyFileWinsOverInlineKey(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "key")
	if err := os.WriteFile(keyPath, []byte("  file-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := writeConfig(t, "llm_api_key = \"inline-key\"\nllm_api_key_file = \""+keyPath+"\"\n")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Runnable(); err != nil {
		t.Fatalf("a readable key file must not be an error: %v", err)
	}
	if cfg.LLMAPIKey != "file-key" {
		t.Errorf("want trimmed file-key, got %q", cfg.LLMAPIKey)
	}
}

// The XDG split: nothing large may default into the config directory.
func TestModelDirDefaultsIntoDataDirNotConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))

	cfgDir := filepath.Join(home, "cfg", "gobbonet")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cfgDir, "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	wantModels := filepath.Join(home, "data", "gobbonet", "models")
	if cfg.ModelDir != wantModels {
		t.Errorf("model_dir = %q, want %q — GGUFs must not land in the config dir", cfg.ModelDir, wantModels)
	}
	if strings.HasPrefix(cfg.ModelDir, cfgDir) {
		t.Errorf("model_dir %q is inside the config dir %q", cfg.ModelDir, cfgDir)
	}
	if strings.HasPrefix(cfg.StatePath(), cfgDir) {
		t.Errorf("state %q is inside the config dir %q", cfg.StatePath(), cfgDir)
	}
	if strings.HasPrefix(cfg.LogFile(), cfgDir) {
		t.Errorf("log %q is inside the config dir %q", cfg.LogFile(), cfgDir)
	}
}

// A portable install opts back in to a one-folder layout with a relative path,
// which resolves against the config file rather than the XDG data dir.
func TestRelativeModelDirResolvesAgainstConfigDir(t *testing.T) {
	path := writeConfig(t, "model_dir = \"./models\"\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(path), "models")
	if cfg.ModelDir != want {
		t.Errorf("model_dir = %q, want %q", cfg.ModelDir, want)
	}
}

// `config set` must not cannibalise the documentation. DefaultTOML carries
// indented examples inside prose blocks that look exactly like assignments.
func TestSetLeavesIndentedProseExamplesAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Present ONLY as an indented example, never as a real assignment.
	const prose = `#   llm_api_key_file = "/path/to/key"`
	if !strings.Contains(string(before), prose) {
		t.Skip("DefaultTOML no longer carries this prose example")
	}

	if err := Set(path, "llm_api_key_file", "/etc/gobbonet.key"); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(after), prose) {
		t.Error("Set ate the documentation example instead of appending a setting")
	}
	if !strings.Contains(string(after), `llm_api_key_file = "/etc/gobbonet.key"`) {
		t.Error("Set did not write the value")
	}
}

// Setting a commented-out default uncomments it in place — exactly once.
func TestSetUncommentsDefaultWithoutDuplicating(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	if err := Set(path, "model_dir", "/srv/models"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	active := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "model_dir") {
			active++
		}
	}
	if active != 1 {
		t.Errorf("want exactly 1 active model_dir assignment, got %d\n%s", active, raw)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelDir != "/srv/models" {
		t.Errorf("model_dir = %q", cfg.ModelDir)
	}
}

// --- Model catalogue --------------------------------------------------------

// The fetch is on by default, and an absent key must keep it on rather than
// reading as false. Load seeds from Default() before decoding, which is what
// makes a plain bool safe here.
func TestModelCatalogDefaults(t *testing.T) {
	d := Default()
	if !d.ModelCatalogRemote {
		t.Error("the catalogue fetch should default to on")
	}
	if d.ModelCatalogURL == "" {
		t.Error("no default catalogue URL")
	}

	path := writeConfig(t, "llm_url = \"http://127.0.0.1:11437\"\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ModelCatalogRemote {
		t.Error("a config that does not mention the catalogue switched it off")
	}
	if cfg.ModelCatalogURL != d.ModelCatalogURL {
		t.Errorf("url = %q, want the default %q", cfg.ModelCatalogURL, d.ModelCatalogURL)
	}
}

// Turning it off has to actually stick — this is a privacy control, and a
// setting that silently reverts is worse than not offering it.
func TestModelCatalogCanBeSwitchedOff(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://127.0.0.1:11437\"\nmodel_catalog_remote = false\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelCatalogRemote {
		t.Fatal("model_catalog_remote = false did not take effect")
	}
}

// `config set` has to handle both keys: the bool must be written unquoted and
// the URL quoted, or the file stops parsing.
func TestConfigSetHandlesCatalogKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	if err := Set(path, "model_catalog_remote", "false"); err != nil {
		t.Fatalf("set model_catalog_remote: %v", err)
	}
	if err := Set(path, "model_catalog_url", "https://example.test/list.json"); err != nil {
		t.Fatalf("set model_catalog_url: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("the config no longer parses after config set: %v", err)
	}
	if cfg.ModelCatalogRemote {
		t.Error("model_catalog_remote did not round-trip")
	}
	if cfg.ModelCatalogURL != "https://example.test/list.json" {
		t.Errorf("url = %q", cfg.ModelCatalogURL)
	}
}
