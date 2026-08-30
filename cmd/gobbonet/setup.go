package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/jmccardle/gobbonet/internal/catalog"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/setup"
)

// cmdSetup runs the first-run wizard.
//
// The launcher calls this unconditionally on every start, so the common case by
// far is "already done", which must be fast and silent. Only the first launch
// ever gets as far as opening a browser.
func cmdSetup(argv []string) error {
	fs := flag.NewFlagSet("gobbonet setup", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	catalogPath := stringFlag(fs, "catalog", "path to models.ini")
	serverExe := stringFlag(fs, "server-exe", "path to the bundled llama-server")
	noBrowser := fs.Bool("no-browser", false, "print the URL instead of opening a browser")
	force := fs.Bool("force", false, "run setup again even if it already completed")
	status := fs.Bool("status", false, "exit 0 if setup has completed, 1 if not; print nothing")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	// --status lets the launcher ask "is this a first run?" before starting
	// anything, so it can take charge of opening the browser itself. Silent and
	// exit-code only, because its caller is a shell script.
	if *status {
		path, _ := config.Discover(*configPath)
		cfg, err := config.Load(path)
		if err != nil || !setup.Complete(cfg.DataDir) {
			return errSetupIncomplete
		}
		return nil
	}

	// A config has to exist before anything can be written into it. Creating it
	// here rather than erroring keeps the launcher's job to one call: the very
	// first launch on a fresh install has no config at all, and that is the
	// normal case rather than an error.
	path, _ := config.Discover(*configPath)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := config.WriteDefault(path); err != nil {
			return fmt.Errorf("could not create a config at %s: %w", path, err)
		}
	}

	catPath := *catalogPath
	if catPath == "" {
		catPath = catalog.Discover()
	}
	if catPath == "" {
		return fmt.Errorf("no model catalogue found. Pass --catalog /path/to/models.ini")
	}

	res, err := setup.Run(setup.Options{
		ConfigPath:  path,
		CatalogPath: catPath,
		ServerExe:   *serverExe,
		NoBrowser:   *noBrowser,
		Force:       *force,
		Out:         os.Stdout,
	})
	if err != nil {
		return err
	}
	if res.AlreadyComplete {
		fmt.Println("  Setup has already been completed. Run with --force to do it again.")
		return nil
	}
	fmt.Println("  Setup complete.")
	return nil
}

// errSetupIncomplete carries the exit status for --status without printing
// anything. run() turns a non-nil error into exit 1, which is exactly the
// signal a shell `if` needs.
var errSetupIncomplete = errSilent{}

type errSilent struct{}

func (errSilent) Error() string { return "" }
