package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

func TestLaunchSetupDecision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if first, err := launchNeedsSetup(path, false); !first || err != nil {
		t.Fatalf("fresh: %v, %v", first, err)
	}
	if first, err := launchNeedsSetup(path, true); first || err == nil {
		t.Fatalf("explicit missing config must fail: %v, %v", first, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("launch decision must not create config")
	}
	if err := config.WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	if first, err := launchNeedsSetup(path, false); first || err != nil {
		t.Fatalf("existing remote config must not trigger setup: %v, %v", first, err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("existing config was changed")
	}
	if err := os.WriteFile(path, []byte("invalid = ["), 0600); err != nil {
		t.Fatal(err)
	}
	if first, err := launchNeedsSetup(path, false); first || err == nil {
		t.Fatalf("corrupt config must fail without setup: %v, %v", first, err)
	}
}

// A first run that stopped after launch.bat's early password write (#63) has
// a config.toml but no engine. With launch.bat's mark beside it, launch runs
// setup again; without the mark, or once an engine is set, it serves.
func TestLaunchSetupUnfinished(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := config.WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	if err := config.Set(path, "access_secret", "abc:def"); err != nil {
		t.Fatal(err)
	}
	write := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if launchSetupUnfinished(path, dir) {
		t.Fatal("no mark: a config without an engine is remote mode, and must be served")
	}
	write(setupPendingName)
	if launchSetupUnfinished(path, dir) {
		t.Fatal("a mark with no launch.bat beside it must not send launch looking for setup")
	}
	write("launch.bat")
	before, _ := os.ReadFile(path)
	if !launchSetupUnfinished(path, dir) {
		t.Fatal("mark + config with no engine: the first run stopped early, setup must run again")
	}
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Fatal("the decision changed the config")
	}
	exe := filepath.Join(dir, "llama-server.exe")
	write("llama-server.exe")
	if err := config.Set(path, "server_exe", exe); err != nil {
		t.Fatal(err)
	}
	if launchSetupUnfinished(path, dir) {
		t.Fatal("mark + config with an engine (Setup or add a model, stopped): keep serving")
	}
	if launchSetupUnfinished(filepath.Join(dir, "missing.toml"), dir) {
		t.Fatal("an unreadable config is launchNeedsSetup's business, not this one's")
	}
}

func TestLaunchHelp(t *testing.T) {
	if err := cmdLaunch([]string{"--help"}); err != nil {
		t.Fatal(err)
	}
}

// 1.7.9 (PR #15): launch.bat runs as a fixed relative command with the legacy
// switch stripped, whichever door starts it -- first run or --setup.
func TestSetupBatchCommand(t *testing.T) {
	dir := t.TempDir()
	cmd := setupBatchCommand(dir, []string{"PATH=/bin", "GOBBONET_LEGACY_SERVER=1", "gobbonet_legacy_server=1", "KEEP=yes"})
	if got := strings.Join(cmd.Args, " "); got != "cmd.exe /d /c launch.bat" {
		t.Errorf("args = %q, want a fixed relative launch.bat", got)
	}
	if cmd.Dir != dir {
		t.Errorf("dir = %q, want %q", cmd.Dir, dir)
	}
	for _, e := range cmd.Env {
		if strings.HasPrefix(strings.ToUpper(e), "GOBBONET_LEGACY_SERVER=") {
			t.Errorf("legacy switch leaked into launch.bat's environment: %q", e)
		}
	}
	if len(cmd.Env) != 2 {
		t.Errorf("env = %v, want PATH and KEEP only", cmd.Env)
	}
}

// --setup is the Windows questionnaire; elsewhere it says where setup lives
// instead of failing obscurely.
func TestLaunchSetupFlag(t *testing.T) {
	err := cmdLaunch([]string{"--setup"})
	if runtime.GOOS != "windows" {
		if err == nil || !strings.Contains(err.Error(), "gobbonet setup") {
			t.Errorf("--setup off Windows: got %v, want a pointer to gobbonet setup", err)
		}
	}
	if err := cmdLaunch([]string{"extra"}); err == nil || !strings.Contains(err.Error(), "--setup") {
		t.Errorf("stray argument: got %v, want the usage to name --setup", err)
	}
}
