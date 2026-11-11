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

// 1.7.9 (PR #15): launch.bat runs as a fixed relative command with the old
// legacy-server switch stripped, whichever door starts it -- first run or
// --setup. 1.8.0 removed that server; the switch is still kept out.
func TestSetupBatchCommand(t *testing.T) {
	dir := t.TempDir()
	cmd := setupBatchCommand(dir, []string{"PATH=/bin", "GOBBONET_LEGACY_SERVER=1", "gobbonet_legacy_server=1", "KEEP=yes"}, false)
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

// open_browser (1.8.0, PR #58). A configured launch -- the Start menu and
// desktop shortcuts -- always passed --open before; now the key decides, and
// --no-browser beats it.
func TestLaunchServeFollowsOpenBrowser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := config.WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	has := func(args []string) bool {
		for _, a := range args {
			if a == "--open" {
				return true
			}
		}
		return false
	}
	if args := launchServeArgs(path, false); !has(args) {
		t.Errorf("default config: %v, want --open (the default is true)", args)
	}
	if args := launchServeArgs(path, true); has(args) {
		t.Errorf("--no-browser with the key true: %v, want no --open", args)
	}
	if err := config.Set(path, "open_browser", "false"); err != nil {
		t.Fatal(err)
	}
	if args := launchServeArgs(path, false); has(args) {
		t.Errorf("open_browser = false: %v, want no --open", args)
	}
	if args := launchServeArgs(path, false); len(args) != 2 || args[0] != "--config" || args[1] != path {
		t.Errorf("args = %v, want just --config %s", args, path)
	}
	// An unreadable config keeps the old behaviour; serve reports the problem.
	if args := launchServeArgs(filepath.Join(t.TempDir(), "missing.toml"), false); !has(args) {
		t.Errorf("unreadable config: %v, want --open as before", args)
	}
}

// launch --setup --no-browser reaches launch.bat as GOBBONET_OPEN_BROWSER=false,
// which beats open_browser there. An inherited value never does.
func TestSetupBatchCarriesNoBrowser(t *testing.T) {
	env := []string{"PATH=/bin", "GOBBONET_OPEN_BROWSER=true", "gobbonet_open_browser=false"}
	count := func(cmdEnv []string) (n int, last string) {
		for _, e := range cmdEnv {
			if strings.HasPrefix(strings.ToUpper(e), "GOBBONET_OPEN_BROWSER=") {
				n++
				last = e
			}
		}
		return n, last
	}
	if n, _ := count(setupBatchCommand(t.TempDir(), env, false).Env); n != 0 {
		t.Errorf("without --no-browser, an inherited GOBBONET_OPEN_BROWSER reached launch.bat")
	}
	if n, last := count(setupBatchCommand(t.TempDir(), env, true).Env); n != 1 || last != "GOBBONET_OPEN_BROWSER=false" {
		t.Errorf("with --no-browser: %d value(s), last %q; want exactly GOBBONET_OPEN_BROWSER=false", n, last)
	}
}

func TestLaunchAcceptsNoBrowser(t *testing.T) {
	err := cmdLaunch([]string{"--no-browser", "extra"})
	if err == nil || !strings.Contains(err.Error(), "--no-browser") {
		t.Errorf("got %v, want the usage error to name --no-browser", err)
	}
}

func TestOpenBrowserDefaultsOnAndIsDocumented(t *testing.T) {
	if !config.Default().OpenBrowser {
		t.Error("open_browser must default to true: every launcher opened the browser before 1.8.0")
	}
	if !strings.Contains(config.DefaultTOML, "\nopen_browser = true\n") {
		t.Error("the generated config.toml does not carry open_browser = true")
	}
}
