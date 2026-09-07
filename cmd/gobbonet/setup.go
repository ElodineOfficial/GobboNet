package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/setup"
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
	freshConfig := false
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := config.WriteDefault(path); err != nil {
			return fmt.Errorf("could not create a config at %s: %w", path, err)
		}
		freshConfig = true
	}

	catPath := *catalogPath
	if catPath == "" {
		catPath = catalog.Discover()
	}
	if catPath == "" {
		return fmt.Errorf("no model catalogue found. Pass --catalog /path/to/models.ini")
	}

	// The catalogue above has always had this fallback and the engine had none,
	// which is the whole of SETUP-1. Run standalone — which --help documents as
	// a supported thing to do — `gobbonet setup` saw an empty --server-exe,
	// concluded "this install has no bundled engine", and pushed the user to
	// the remote-server option with a working engine sitting beside the binary.
	//
	// The launcher hides this by passing --server-exe itself, so it only bites
	// people who run setup directly, and anyone whose launcher found no engine
	// to pass: pick_engine() requires the Vulkan build to answer --version, and
	// falls through to a CPU build that is only present when the package was
	// built with BUNDLE_CPU=1.
	//
	// Discovery only, never a write. An explicit --server-exe still wins, and
	// choosing remote in the wizard still leaves server_exe empty.
	exePath := *serverExe
	if exePath == "" {
		exePath = config.DiscoverServerExe()
	}

	// The "already done" marker lives in the data directory, and the config it
	// describes lives in the config directory. Delete ~/.config/gobbonet and the
	// two disagree: a default config gets written a few lines above, the marker
	// still says complete, and setup refuses — leaving a config with no password
	// and an escape hatch (--force) only discoverable by reading --help after
	// being turned away (SETUP-3).
	//
	// A config we just created cannot be one setup configured, whatever the
	// marker says. Treat that as reason enough to run again.
	if freshConfig && !*force {
		fmt.Println("  No config was found, so this looks like a first run.")
	}
	res, err := setup.Run(setup.Options{
		ConfigPath:  path,
		CatalogPath: catPath,
		ServerExe:   exePath,
		NoBrowser:   *noBrowser,
		Force:       *force || freshConfig,
		Out:         os.Stdout,
	})
	if err != nil {
		return err
	}
	if res.AlreadyComplete {
		fmt.Println("  Setup has already been completed. Run with --force to do it again.")
		return nil
	}
	// Setup used to end here, having printed an address but never how to get
	// back to it (SETUP-5). The launcher starts the server itself, so anyone
	// who reached this through a desktop entry needs nothing — but anyone who
	// ran setup by hand was left with a finished install and no next step.
	fmt.Println("  Setup complete.")
	fmt.Println()
	fmt.Println("  To start GobboNet:  gobbonet")
	fmt.Println("  It runs until you stop it with Ctrl+C.")
	return nil
}

// errSetupIncomplete carries the exit status for --status without printing
// anything. run() turns a non-nil error into exit 1, which is exactly the
// signal a shell `if` needs.
var errSetupIncomplete = errSilent{}

// errNotice stops the command without calling it a failure. Some things that
// have to halt are not defects: writing a default config on a machine that has
// never been configured is the expected first run, and reporting it under
// [ERROR] made a normal install read like a broken one (SETUP-4). The exit code
// stays non-zero, because the server genuinely did not start.
type errNotice struct{ msg string }

func (e errNotice) Error() string { return e.msg }

type errSilent struct{}

func (errSilent) Error() string { return "" }
