package config

import (
	"os"
	"path/filepath"
	"testing"
)

// SETUP-1: a fresh Linux install has no server_exe in config, HealServerExe
// declines to look because empty means remote mode, and `gobbonet setup` had no
// fallback of its own — so every first run reported "this install has no bundled
// engine" with the engine sitting beside the binary.
//
// These pin the split: discovery answers "did this install ship an engine?"
// without touching config, and healing keeps refusing to overwrite a deliberate
// empty.
func TestDiscoverServerExeFindsBundledEngine(t *testing.T) {
	dir := t.TempDir()
	// The Debian layout: /usr/lib/gobbonet/llama-cpp/llama-server, beside the
	// binary rather than under the working directory.
	engine := filepath.Join(dir, "llama-cpp", serverExeName())
	if err := os.MkdirAll(filepath.Dir(engine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// DiscoverServerExe searches beside the executable and the working
	// directory; chdir is the portable way to exercise it in a test.
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	got := DiscoverServerExe()
	if got == "" {
		t.Fatal("found nothing; this is the SETUP-1 symptom")
	}
	if filepath.Base(got) != serverExeName() {
		t.Errorf("found %q, which is not an engine", got)
	}
}

// The Debian package's CPU-only build is the sole engine on a machine where the
// Vulkan one was not bundled. Missing it there means the same wrong answer.
func TestDiscoverServerExeFindsCPUFallback(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "llama-cpp-cpu", serverExeName())
	if err := os.MkdirAll(filepath.Dir(engine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	if got := DiscoverServerExe(); got == "" {
		t.Fatal("did not find the CPU engine")
	}
}

func TestDiscoverServerExeReportsNothingWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	// The binary running this test lives elsewhere, and a Go test binary has no
	// llama-cpp beside it, so an empty temp dir should turn up nothing.
	if got := DiscoverServerExe(); got != "" {
		t.Errorf("invented an engine at %q", got)
	}
}

// Empty is not a broken path, it is how remote mode is spelled — the Windows
// installer runs `config set server_exe ""` to select it. Healing must keep
// leaving it alone even now that discovery exists.
func TestHealServerExeStillIgnoresDeliberateRemoteMode(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "llama-cpp", serverExeName())
	if err := os.MkdirAll(filepath.Dir(engine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	c := &Config{ServerExe: ""}
	if _, healed := c.HealServerExe(); healed {
		t.Error("healed an empty server_exe; that silently cancels remote mode")
	}
	if c.ServerExe != "" {
		t.Errorf("server_exe was overwritten with %q", c.ServerExe)
	}
}

// The case healing is actually for: a path that was set and has since moved.
func TestHealServerExeStillRepairsABrokenPath(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "llama-cpp", serverExeName())
	if err := os.MkdirAll(filepath.Dir(engine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	c := &Config{ServerExe: filepath.Join(dir, "gone", "llama-server")}
	from, healed := c.HealServerExe()
	if !healed {
		t.Fatal("did not repair a path pointing at a missing file")
	}
	if from == "" || c.ServerExe == from {
		t.Errorf("healed from %q to %q", from, c.ServerExe)
	}
}
