package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/engine"
)

// cmdEngine is `gobbonet engine install|status`.
//
// It exists because launch.bat's STEP 1 could download the engine and this
// program could not — and since launch.bat now hands over to this program
// before STEP 1 runs, that gap became a capability a Windows ZIP user simply
// lost. See internal/engine.
func cmdEngine(argv []string) error {
	fs := flag.NewFlagSet("engine", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	dir := stringFlag(fs, "dir", "where to install (default: llama-cpp beside this program)")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	sub := "status"
	if fs.NArg() > 0 {
		sub = fs.Arg(0)
	}

	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	wd, _ := os.Getwd()

	target := *dir
	if target == "" {
		base := exeDir
		if base == "" {
			base = wd
		}
		target = filepath.Join(base, "llama-cpp")
	}

	switch sub {
	case "status":
		if exe := engine.Installed(target); exe != "" {
			fmt.Printf(" [OK] engine installed: %s\n", exe)
			return nil
		}
		fmt.Printf(" [*]  no llama.cpp engine in %s\n", target)
		fmt.Println("      Install the pinned build with:  gobbonet engine install")
		return errSilent{}

	case "install":
		if exe := engine.Installed(target); exe != "" {
			fmt.Printf(" [OK] engine already installed: %s\n", exe)
			return setServerExe(*configPath, exe)
		}
		pin, err := engine.DiscoverPin(exeDir, wd)
		if err != nil {
			return fmt.Errorf("%w\n"+
				"    engine.sha256 pins the llama.cpp build and its checksum. Without it\n"+
				"    a download could not be verified, so this refuses rather than\n"+
				"    fetching something it cannot vouch for.", err)
		}
		fmt.Printf(" [..] llama.cpp %s\n", pin.Build)
		exe, err := engine.Install(pin, target, func(msg string) {
			fmt.Printf(" [..] %s\n", msg)
		})
		if err != nil {
			return err
		}
		return setServerExe(*configPath, exe)

	default:
		return fmt.Errorf("unknown engine command %q (try: install, status)", sub)
	}
}

// setServerExe records the engine in the config, so the next plain `gobbonet`
// starts it. Installing something the server then cannot find would be a job
// half done.
func setServerExe(flagPath, exe string) error {
	path, _ := config.Discover(flagPath)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := config.WriteDefault(path); err != nil {
			return fmt.Errorf("could not create a config at %s: %w", path, err)
		}
	}
	if err := config.Set(path, "server_exe", exe); err != nil {
		return fmt.Errorf("engine installed, but %s could not be updated: %w", path, err)
	}
	fmt.Printf(" [OK] server_exe recorded in %s\n", path)
	return nil
}
