package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/procjob"
)

// launch is the desktop entry point. Serving an existing configuration must
// never re-run the batch questionnaire or rewrite the user's settings.
func cmdLaunch(argv []string) error {
	fs := flag.NewFlagSet("gobbonet launch", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	// --setup is what the "Setup or add a model" shortcut runs (1.7.9). It is
	// launch.bat's questionnaire on purpose, even on a configured install, but
	// started from here so it gets the same kill-on-close job as a first run:
	// the shortcut used to run launch.bat directly, outside any job.
	setup := fs.Bool("setup", false, "run engine and model setup (Windows), even when GobboNet is configured")
	// open_browser in config.toml decides whether a tab opens (1.8.0, PR #58);
	// this flag beats it for one run, as `gobbonet setup --no-browser` and the
	// Linux launcher's --no-browser already did.
	noBrowser := fs.Bool("no-browser", false, "do not open a browser, whatever open_browser in config.toml says")
	if err := fs.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("launch accepts only --config, --setup and --no-browser")
	}
	if *setup {
		if runtime.GOOS != "windows" {
			return errors.New("launch --setup is the Windows setup; on Linux and macOS run gobbonet setup")
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return runSetupBatch(filepath.Dir(exe), *noBrowser)
	}
	path, explicit := config.Discover(*configPath)
	first, err := launchNeedsSetup(path, explicit)
	if err != nil {
		return err
	}
	if !first && !explicit && runtime.GOOS == "windows" {
		if exe, err := os.Executable(); err == nil {
			first = launchSetupUnfinished(path, filepath.Dir(exe))
		}
	}
	if first {
		if runtime.GOOS != "windows" {
			return errors.New("run gobbonet setup before launching")
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return runSetupBatch(filepath.Dir(exe), *noBrowser)
	}
	return cmdServe(launchServeArgs(path, *noBrowser))
}

// launchServeArgs is the serve command a configured launch runs. It always
// passed --open until 1.8.0; now open_browser decides, and --no-browser beats
// it. A config that cannot be read keeps the old behaviour -- serve is about to
// say what is wrong with it anyway.
func launchServeArgs(path string, noBrowser bool) []string {
	args := []string{"--config", path}
	if noBrowser {
		return args
	}
	if cfg, err := config.Load(path); err == nil && !cfg.OpenBrowser {
		fmt.Println(" [..] Not opening a browser (open_browser = false in config.toml); the address is printed below.")
		return args
	}
	return append(args, "--open")
}

// setupBatchCommand is the launch.bat invocation, kept apart from running it
// so its shape (fixed relative command, stale switches stripped) can be
// tested on any platform.
//
// noBrowser is `launch --no-browser`. launch.bat reads open_browser itself at
// its hand-over to gobbonet.exe; GOBBONET_OPEN_BROWSER=false tells it the flag
// was given, and wins over the file. An inherited value is dropped either
// way, so only this run's flag can set it.
func setupBatchCommand(dir string, environ []string, noBrowser bool) *exec.Cmd {
	// A fixed relative command avoids cmd.exe quoting an installation path.
	cmd := exec.Command("cmd.exe", "/d", "/c", "launch.bat")
	cmd.Dir = dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// GOBBONET_LEGACY_SERVER chose the PowerShell server up to 1.7.9. That
	// server is gone (1.8.0) and launch.bat only says the switch is ignored, so
	// a value left in the environment is dropped rather than printed every run.
	for _, env := range environ {
		key, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(key, "GOBBONET_LEGACY_SERVER") && !strings.EqualFold(key, "GOBBONET_OPEN_BROWSER") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	if noBrowser {
		cmd.Env = append(cmd.Env, "GOBBONET_OPEN_BROWSER=false")
	}
	return cmd
}

// runSetupBatch runs launch.bat and ties everything it starts to this
// process (1.7.9, PR #15).
//
// launch.bat runs gobbonet.exe in the foreground until it stops, so this
// process lives exactly as long as GobboNet does. Up to 1.7.9 it also started
// the embedding server with `start /min`, and closing the console window used
// to end this process and gobbonet.exe but leave that server running, holding
// its port and memory until the next reboot. Since 1.8.0 gobbonet.exe starts
// the embedding server itself, in its own job (internal/supervisor/embed.go);
// this job stays as the backstop for anything launch.bat starts. In it, the
// kernel ends the whole tree whenever this process dies, however it dies.
func runSetupBatch(dir string, noBrowser bool) error {
	if _, err := os.Stat(filepath.Join(dir, "launch.bat")); err != nil {
		return fmt.Errorf("first-run setup is missing: reinstall the full GobboNet package: %w", err)
	}
	cmd := setupBatchCommand(dir, os.Environ(), noBrowser)
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := procjob.TieToLifetime(cmd); err != nil {
		// A backstop, not a gate: setup still runs, it just cannot promise
		// cleanup after an abnormal exit. Say so where it can be read.
		fmt.Fprintf(os.Stderr, " [*] Background processes may outlive this window if it is closed: %v\n", err)
	}
	return cmd.Wait()
}

// setupPendingName is the mark launch.bat leaves beside itself from the moment
// it hands the password to gobbonet.exe -- early, so that a first run which
// stops does not ask for a second password (#63) -- until it reaches :launch.
// That early write creates config.toml, and launchNeedsSetup serves any
// config.toml it finds.
const setupPendingName = ".gobbonet-setup-pending"

// launchSetupUnfinished reports whether launch.bat started setup in dir and
// stopped before the end, leaving a config that names no engine: what a first
// run closed during its download or model menu leaves behind. Serving that
// would open a chat with nothing behind it and never offer setup again, so
// launch runs setup instead.
//
// Both conditions, not the mark alone: "Setup or add a model" runs launch.bat
// on a working install too, and stopping that leaves the mark beside a config
// whose engine is set. That install carries on serving.
func launchSetupUnfinished(path, dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, setupPendingName)); err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, "launch.bat")); err != nil {
		return false
	}
	cfg, err := config.Load(path)
	if err != nil {
		return false
	}
	return cfg.ServerExe == ""
}

func launchNeedsSetup(path string, explicit bool) (bool, error) {
	_, err := config.Load(path)
	if errors.Is(err, config.ErrNotFound) && !explicit {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("cannot launch with configuration %s: %w", path, err)
	}
	return false, nil
}
