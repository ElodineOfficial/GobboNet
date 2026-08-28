package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePerf(t *testing.T, configPath, body string) string {
	t.Helper()
	path := PerfPath(configPath)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The whole point of the two-layer design: config.toml is the hardware-detected
// baseline and must survive being overridden, because reset restores it.
func TestApplyPerfKeepsTheBaseline(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nctx_size = 8192\ngpu_layers = 20\nkv_cache_type = \"q4_0\"\n")
	writePerf(t, path, "ctx_size = 32768\n")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// Load alone must not overlay: it backs `config get`, which has to keep
	// reporting the file `config set` writes.
	if cfg.CtxSize != 8192 {
		t.Errorf("Load applied the overlay: ctx_size %d, want the file's 8192", cfg.CtxSize)
	}

	if err := cfg.ApplyPerf(); err != nil {
		t.Fatal(err)
	}
	if cfg.CtxSize != 32768 {
		t.Errorf("live ctx_size: got %d, want the override 32768", cfg.CtxSize)
	}
	if cfg.AutoCtxSize != 8192 {
		t.Errorf("baseline ctx_size: got %d, want 8192", cfg.AutoCtxSize)
	}
	// Untouched keys fall through to the baseline rather than to the compiled
	// defaults, which is what makes a one-line perf.toml safe to hand-write.
	if cfg.GPULayers != 20 || cfg.KVCacheType != "q4_0" {
		t.Errorf("unset overlay keys did not fall through: gpu=%d kv=%s, want 20/q4_0",
			cfg.GPULayers, cfg.KVCacheType)
	}
	if !cfg.PerfOverridden {
		t.Error("PerfOverridden: got false, want true")
	}
}

func TestApplyPerfWithNoOverlay(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nctx_size = 8192\n")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.ApplyPerf(); err != nil {
		t.Fatalf("a missing perf.toml is the normal state, not an error: %v", err)
	}
	if cfg.PerfOverridden {
		t.Error("PerfOverridden with no file: got true, want false")
	}
	if cfg.CtxSize != cfg.AutoCtxSize {
		t.Errorf("with no overlay the live and baseline values must agree: %d vs %d",
			cfg.CtxSize, cfg.AutoCtxSize)
	}
}

// gpu_layers = 0 is pure CPU — a real choice on a machine whose GPU is busy —
// and has to be distinguishable from "not set", or it could never be selected.
func TestApplyPerfZeroGPULayers(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\ngpu_layers = 99\n")
	writePerf(t, path, "gpu_layers = 0\n")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.ApplyPerf(); err != nil {
		t.Fatal(err)
	}
	if cfg.GPULayers != 0 {
		t.Errorf("gpu_layers: got %d, want 0 (CPU-only was requested)", cfg.GPULayers)
	}
	if cfg.AutoGPULayers != 99 {
		t.Errorf("baseline gpu_layers: got %d, want 99", cfg.AutoGPULayers)
	}
}

// This file is written by the server, which validates before writing, so a bad
// one means somebody hand-edited it. Refusing to start and naming the value
// beats silently serving a context size they did not choose.
func TestApplyPerfRefusesGarbage(t *testing.T) {
	for _, tc := range []struct{ name, body, wantIn string }{
		{"ctx_size below the floor", "ctx_size = 16\n", "ctx_size"},
		{"gpu_layers past the cap", "gpu_layers = 5000\n", "gpu_layers"},
		{"unknown kv_cache_type", "kv_cache_type = \"q2_k\"\n", "kv_cache_type"},
		{"a key that belongs elsewhere", "llm_url = \"http://x:1\"\n", "unknown setting"},
		{"not TOML at all", "ctx_size = = 8192\n", "parse"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, "llm_url = \"http://x:1\"\n")
			perfPath := writePerf(t, path, tc.body)

			cfg, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			err = cfg.ApplyPerf()
			if err == nil {
				t.Fatalf("ApplyPerf accepted %q", tc.body)
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("error does not mention %q: %v", tc.wantIn, err)
			}
			// The message has to say which file and what to do about it, or the
			// user is left with a server that will not start and no next step.
			if !strings.Contains(err.Error(), perfPath) {
				t.Errorf("error does not name %s: %v", perfPath, err)
			}
		})
	}
}

// What SavePerf writes, LoadPerf must read back — including the comment header,
// which is the only documentation someone who finds this file on disk gets.
func TestSavePerfRoundTrips(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	perfPath := PerfPath(path)

	if err := SavePerf(perfPath, 8192, 0, "f16"); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(perfPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "#") {
		t.Error("perf.toml has no explanatory header")
	}
	if !strings.Contains(string(raw), "config.toml") {
		t.Error("perf.toml does not say what it overrides")
	}

	p, exists, err := LoadPerf(perfPath)
	if err != nil || !exists {
		t.Fatalf("reading back what we wrote: exists=%v err=%v", exists, err)
	}
	ctx, gpu, kv := p.Apply(16384, 99, "q8_0")
	if ctx != 8192 || gpu != 0 || kv != "f16" {
		t.Errorf("round trip: got %d/%d/%s, want 8192/0/f16", ctx, gpu, kv)
	}
}

func TestSavePerfRejectsBadValues(t *testing.T) {
	perfPath := filepath.Join(t.TempDir(), "perf.toml")

	if err := SavePerf(perfPath, 16, 99, "q8_0"); err == nil {
		t.Error("SavePerf accepted an out-of-range ctx_size")
	}
	if _, err := os.Stat(perfPath); !os.IsNotExist(err) {
		t.Errorf("a rejected save wrote the file anyway (err=%v)", err)
	}
}

// Reset on a machine that never had an override is not a failure — the caller
// asked for "no override in force" and that is already the case.
func TestClearPerfIsIdempotent(t *testing.T) {
	perfPath := filepath.Join(t.TempDir(), "perf.toml")

	if err := ClearPerf(perfPath); err != nil {
		t.Errorf("clearing a file that was never there: %v", err)
	}
	if err := SavePerf(perfPath, 8192, 99, "q8_0"); err != nil {
		t.Fatal(err)
	}
	if err := ClearPerf(perfPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(perfPath); !os.IsNotExist(err) {
		t.Errorf("perf.toml survived ClearPerf (err=%v)", err)
	}
}

// perf.toml sits next to the config it overrides, so a portable one-folder
// install keeps both by the binary and an XDG install keeps both in
// ~/.config/gobbonet.
func TestPerfPathIsBesideTheConfig(t *testing.T) {
	got := PerfPath(filepath.Join("/opt", "gobbonet", "config.toml"))
	want := filepath.Join("/opt", "gobbonet", "perf.toml")
	if got != want {
		t.Errorf("PerfPath: got %s, want %s", got, want)
	}
}
