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
	if err := fs.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("launch accepts only --config and --setup")
	}
	if *setup {
		if runtime.GOOS != "windows" {
			return errors.New("launch --setup is the Windows setup; on Linux and macOS run gobbonet setup")
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return runSetupBatch(filepath.Dir(exe))
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
		return runSetupBatch(filepath.Dir(exe))
	}
	return cmdServe([]string{"--config", path, "--open"})
}

// setupBatchCommand is the launch.bat invocation, kept apart from running it
// so its shape (fixed relative command, legacy-server switch stripped) can be
// tested on any platform.
func setupBatchCommand(dir string, environ []string) *exec.Cmd {
	// A fixed relative command avoids cmd.exe quoting an installation path.
	cmd := exec.Command("cmd.exe", "/d", "/c", "launch.bat")
	cmd.Dir = dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Normal launch always uses Go. The explicit batch entry remains available
	// to users who deliberately choose the legacy server.
	for _, env := range environ {
		key, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(key, "GOBBONET_LEGACY_SERVER") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	return cmd
}

// runSetupBatch runs launch.bat and ties everything it starts to this
// process (1.7.9, PR #15).
//
// launch.bat starts the embedding server with `start /min`, then runs
// gobbonet.exe in the foreground until it stops, so this process lives exactly
// as long as GobboNet does. Closing the console window used to end this
// process and gobbonet.exe but leave the embedding server running, holding its
// port and memory until the next reboot. In the job, the kernel ends the whole
// tree whenever this process dies, however it dies.
func runSetupBatch(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, "launch.bat")); err != nil {
		return fmt.Errorf("first-run setup is missing: reinstall the full GobboNet package: %w", err)
	}
	cmd := setupBatchCommand(dir, os.Environ())
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
