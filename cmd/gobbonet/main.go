// Command gobbonet serves the chat UI, proxies to llama.cpp, and — in local
// mode — supervises the llama-server process.
//
// This replaces launch.bat's runtime half. The setup half (hardware probe, model
// download) stays in the launcher scripts for now; those are one-time
// interactive flows, not drift-prone hot paths.
//
//	gobbonet                          serve using the discovered config
//	gobbonet serve --config PATH      serve using a specific config
//	gobbonet set-password             set or change the access password
//	gobbonet check                    probe the upstream and report what it says
//	gobbonet config get KEY           read one setting (for launcher scripts)
//	gobbonet config set KEY VALUE     write one setting, comments preserved
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/jmccardle/gobbonet/internal/auth"
	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/mock"
	"github.com/jmccardle/gobbonet/internal/models"
	"github.com/jmccardle/gobbonet/internal/server"
	"github.com/jmccardle/gobbonet/internal/supervisor"
	"github.com/jmccardle/gobbonet/internal/version"
	"golang.org/x/term"
)

const banner = `
 ====================================================
      GOBBONET - LOCAL AI CHAT
      Powered by llama.cpp
      PRIVACY: FULLY OFFLINE - ZERO TELEMETRY
 ====================================================
`

const passwordIntro = `
 ====================================================
  SET YOUR ACCESS PASSWORD  (first-time setup)

  This password protects the chat from anyone else on
  your network. You'll enter it once here, then type
  it in your browser the first time you connect.

  It is stored only as an Argon2id hash -- not as
  plain text -- and never leaves this machine.
 ====================================================
`

const minPasswordLength = 6

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "\n [ERROR] %v\n", err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	command := "serve"
	if len(argv) > 0 && !strings.HasPrefix(argv[0], "-") {
		command = argv[0]
		argv = argv[1:]
	}

	switch command {
	case "serve":
		return cmdServe(argv)
	case "set-password":
		return cmdSetPassword(argv)
	case "check":
		return cmdCheck(argv)
	case "config":
		return cmdConfig(argv)
	case "mock":
		return cmdMock(argv)
	case "version", "-v", "--version":
		fmt.Println(version.Full())
		return nil
	case "help", "-h", "--help":
		usage()
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func usage() {
	fmt.Print(`gobbonet - local AI chat server

  gobbonet [serve] [--config PATH] [--no-auth] [--host H] [--port N]
  gobbonet set-password [--config PATH]
  gobbonet check [--config PATH]
  gobbonet mock list|run [--config PATH] [story_id]
  gobbonet config get [--config PATH] <key>
  gobbonet config set [--config PATH] <key> <value>
  gobbonet config keys
  gobbonet version
`)
}

// loadConfig runs the discovery and parse steps shared by every subcommand.
//
// A missing config is not an error to work around: the file is written with its
// documentation, the user is told where it is, and we stop. Carrying on with
// in-memory defaults would leave nothing to edit and no record of what the
// server actually did.
func loadConfig(flagPath string) (config.Config, error) {
	path, explicit := config.Discover(flagPath)

	cfg, err := config.Load(path)
	if errors.Is(err, config.ErrNotFound) {
		if explicit {
			return cfg, fmt.Errorf("no config file at %s", path)
		}
		if writeErr := config.WriteDefault(path); writeErr != nil {
			return cfg, fmt.Errorf("could not write a default config to %s: %w", path, writeErr)
		}
		return cfg, fmt.Errorf("no config file found, so a commented default was written to:\n"+
			"      %s\n\n"+
			"    Review it -- in particular llm_url and server_exe -- then run gobbonet again", path)
	}
	return cfg, err
}

func isLoopbackHost(host string) bool {
	if host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func stringFlag(fs *flag.FlagSet, name, usage string) *string {
	return fs.String(name, "", usage)
}

// --- serve -----------------------------------------------------------------

func cmdServe(argv []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	host := stringFlag(fs, "host", "override listen_host")
	llmURL := stringFlag(fs, "llm-url", "override llm_url")
	port := fs.Int("port", 0, "override listen_port")
	noAuth := fs.Bool("no-auth", false, "disable the password gate (only sensible on loopback)")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if err := cfg.Runnable(); err != nil {
		return err
	}
	if *host != "" {
		cfg.ListenHost = *host
	}
	if *port != 0 {
		cfg.ListenPort = *port
	}
	if *llmURL != "" {
		cfg.LLMURL = *llmURL
	}
	if *noAuth {
		if !isLoopbackHost(cfg.ListenHost) {
			return fmt.Errorf("--no-auth is only permitted on loopback addresses (got host %q)", cfg.ListenHost)
		}
		cfg.RequireAuth = false
	} else {
		cfg.RequireAuth = true
	}

	// Mode is resolved before anything else starts, because a misconfigured
	// server_exe must stop the launch rather than silently demote us to remote
	// mode and proxy into a void.
	mode, err := cfg.Mode()
	if err != nil {
		return err
	}

	// perf.toml overlays the config file's tuning. Serving is the only command
	// that cares: `config get ctx_size` must keep reporting the file that
	// `config set ctx_size` writes.
	if err := cfg.ApplyPerf(); err != nil {
		return err
	}

	fmt.Print(banner)
	fmt.Printf(" [OK] version: %s\n", version.Full())

	if cfg.RequireAuth {
		if err := ensurePassword(&cfg); err != nil {
			return err
		}
	} else {
		fmt.Println(" [*] WARNING: --no-auth is set. Anyone who can reach this port has full access.")
	}

	// Serving is the one command that genuinely needs the web assets, so this is
	// where a missing web root becomes an error.
	if cfg.WebRoot == "" {
		return fmt.Errorf("could not find chat.html next to the binary or in the current directory\n" +
			"    Set web_root in the config file to the directory holding it")
	}
	if _, err := os.Stat(filepath.Join(cfg.WebRoot, "chat.html")); err != nil {
		return fmt.Errorf("chat.html not found in %s", cfg.WebRoot)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("could not create data directory %s: %w", cfg.DataDir, err)
	}

	var sup *supervisor.Supervisor
	if mode == config.ModeLocal {
		sup, err = supervisor.New(supervisor.Options{
			ServerExe: cfg.ServerExe,
			ModelDir:  cfg.ModelDir,
			LLMURL:    cfg.LLMURL,
			APIKey:    cfg.LLMAPIKey,
			Tuning: supervisor.Tuning{
				CtxSize:     cfg.CtxSize,
				GPULayers:   cfg.GPULayers,
				KVCacheType: cfg.KVCacheType,
			},
			LogFile:          cfg.LogFile(),
			ChatTemplateName: cfg.ChatTemplateName,
			ChatTemplateFile: cfg.ChatTemplateFile,
		})
		if err != nil {
			return err
		}
	}

	srv, err := server.New(cfg, mode, sup)
	if err != nil {
		return err
	}
	defer srv.Shutdown()

	fmt.Printf(" [OK] mode: %s\n", mode)
	fmt.Printf(" [OK] llama.cpp upstream: %s\n", cfg.LLMURL)
	fmt.Printf(" [OK] config: %s\n", cfg.Path)
	if cfg.PerfOverridden {
		// Say it at startup, not only in the settings panel. A model that fails
		// to load because of a context size someone set weeks ago is otherwise
		// a mystery with no visible cause.
		fmt.Printf(" [OK] tuning override: ctx=%d gpu_layers=%d kv=%s (%s; delete it for %d/%d/%s)\n",
			cfg.CtxSize, cfg.GPULayers, cfg.KVCacheType, config.PerfPath(cfg.Path),
			cfg.AutoCtxSize, cfg.AutoGPULayers, cfg.AutoKVCacheType)
	}

	if sup != nil {
		fmt.Printf(" [..] starting llama-server from %s\n", cfg.ServerExe)
		if err := sup.Boot(""); err != nil {
			// Not fatal. The UI still loads and reports the problem, and the
			// user can pick a different model from the dropdown — which is more
			// useful than exiting and making them read a log.
			fmt.Printf(" [!]  llama-server did not start: %v\n", err)
		} else {
			fmt.Printf(" [OK] model loaded: %s\n", sup.CurrentFile())
		}
	} else {
		if props, err := srv.Info().FetchProps(); err != nil {
			fmt.Println(" [*]  upstream is not answering yet -- the UI will report it until it does.")
		} else {
			rec := models.IdentifyProps(props)
			fmt.Printf(" [OK] model: %s (family=%s, thinking=%s)\n", rec.Name, rec.Family, rec.ThinkingFormat)
		}
	}

	// Bind before the banner. A port that is already taken is the single most
	// common startup failure and it used to print underneath "[OK] serving on
	// ...", which reads as a server that started and then broke.
	listener, err := srv.Listen()
	if err != nil {
		return portInUseError(cfg, err)
	}

	address := cfg.ListenHost
	if address == "0.0.0.0" || address == "::" {
		address = server.LANIP()
	}
	fmt.Println()
	fmt.Printf(" [OK] serving on http://%s:%d/\n", address, cfg.ListenPort)
	if cfg.ListenHost == "0.0.0.0" || cfg.ListenHost == "::" {
		fmt.Printf("      this machine:  http://127.0.0.1:%d/\n", cfg.ListenPort)
		fmt.Printf("      phone / LAN:   http://%s:%d/\n", address, cfg.ListenPort)
	}
	fmt.Printf(" [OK] data dir: %s\n", cfg.DataDir)
	fmt.Println()
	fmt.Println(" Press Ctrl+C to stop.")
	fmt.Println()

	// Stop the managed llama-server on Ctrl+C. Without this the child keeps the
	// GPU allocated after we exit.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Println("\n [..] shutting down")
		srv.Shutdown()
		os.Exit(0)
	}()

	return srv.Serve(listener)
}

// portInUseError explains a bind failure in the terms the two support reports
// it actually generates are phrased in.
//
// "Custom ports do not work" and "I rebooted and it fixed itself" are the same
// event: something already held the port. Usually it is a gobbonet from an
// earlier run — closing a terminal window does not always stop it, and a reboot
// clears it, which is why rebooting appears to fix a configuration that was
// never wrong. launch.bat learned to say this in 1.6.0 (and names the holding
// PID, which needs Get-NetTCPConnection and has no portable equivalent here).
//
// Anything that is not an in-use error is returned unchanged: inventing an
// explanation for a permission or bad-address failure would send the reader
// after the wrong thing.
func portInUseError(cfg config.Config, err error) error {
	if !isAddrInUse(err) {
		return err
	}
	return fmt.Errorf(`port %d is already in use, so nothing was started.

  If you were already running GobboNet, that copy still holds the port --
  closing its window does not always stop it. End it (or reboot) and try
  again; it is also still serving, so the browser tab you have open works.

  If something else owns the port, give this one a different number:
      gobbonet config set listen_port 9067      (writes %s)
      GOBBONET_LISTEN_PORT=9067 gobbonet serve  (just this run)

  Original error: %w`, cfg.ListenPort, cfg.Path, err)
}

// isAddrInUse reports whether err is "that port is taken".
//
// syscall.EADDRINUSE alone is not enough: on Windows the failure arrives as
// WSAEADDRINUSE (10048), a different Errno that does not compare equal to it,
// and WSAEACCES (10013) is what an exclusive-use binding produces.
func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch uintptr(errno) {
		case 10048, 10013:
			return true
		}
	}
	return false
}

// --- set-password ----------------------------------------------------------

func cmdSetPassword(argv []string) error {
	fs := flag.NewFlagSet("set-password", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	return promptAndStorePassword(&cfg)
}

// ensurePassword makes sure a usable password exists before the server starts.
func ensurePassword(cfg *config.Config) error {
	if auth.SecretConfigured(cfg.AccessSecret) {
		return nil
	}
	if cfg.AccessSecret != "" {
		return fmt.Errorf("access_secret in %s is malformed. Run: gobbonet set-password", cfg.Path)
	}
	// No TTY means systemd, cron or a container: there is nobody to prompt, and
	// starting without a password would silently expose the server.
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("no password is set and there is no terminal to prompt on.\n"+
			"    Run 'gobbonet set-password' interactively, or start with --no-auth if\n"+
			"    this server is bound to loopback only. Config: %s", cfg.Path)
	}
	return promptAndStorePassword(cfg)
}

func promptAndStorePassword(cfg *config.Config) error {
	fmt.Print(passwordIntro)

	for {
		first, err := readPassword("  Enter a password: ")
		if err != nil {
			return err
		}
		if len(first) < minPasswordLength {
			fmt.Printf("  Too short -- use at least %d characters.\n", minPasswordLength)
			continue
		}
		second, err := readPassword("  Confirm password: ")
		if err != nil {
			return err
		}
		if first != second {
			fmt.Println("  Passwords did not match -- try again.")
			continue
		}

		secret, err := auth.NewSecret(first)
		if err != nil {
			return err
		}
		if err := config.Set(cfg.Path, "access_secret", secret); err != nil {
			return fmt.Errorf("could not save the password to %s: %w", cfg.Path, err)
		}
		cfg.AccessSecret = secret
		fmt.Println("  [OK] Password set.")
		fmt.Println()
		return nil
	}
}

func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("could not read password: %w", err)
	}
	return string(raw), nil
}

// --- check -----------------------------------------------------------------

func cmdCheck(argv []string) error {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if err := cfg.Runnable(); err != nil {
		return err
	}
	mode, err := cfg.Mode()
	if err != nil {
		return err
	}

	fmt.Printf(" [..] mode:   %s\n", mode)
	fmt.Printf(" [..] config: %s\n", cfg.Path)
	fmt.Printf(" [..] probing %s ...\n", cfg.LLMURL)

	info := models.NewInfo(cfg.LLMURL, cfg.LLMAPIKey, cfg.ModelDir, mode == config.ModeLocal)
	props, err := info.FetchProps()
	if err != nil {
		fmt.Printf(" [ERROR] no response from %s: %v\n", cfg.LLMURL, err)
		fmt.Println("         Start llama-server there, or fix llm_url in the config.")
		return fmt.Errorf("upstream unreachable")
	}

	rec := info.Current(true)
	fmt.Printf(" [OK]  build:     %s\n", props.BuildInfo)
	fmt.Printf(" [OK]  model:     %s\n", rec.Name)
	fmt.Printf("       file:      %s\n", rec.File)
	fmt.Printf("       family:    %s   id: %s\n", rec.Family, rec.ID)
	fmt.Printf("       thinking:  %s\n", rec.ThinkingFormat)
	fmt.Printf("       max ctx:   %d\n", rec.MaxCtx)

	if cfg.ModelDirUsable() {
		local := models.ScanDir(cfg.ModelDir)
		fmt.Printf(" [OK]  %d local GGUF(s) in %s\n", len(local), cfg.ModelDir)
	}
	return nil
}

// --- config ----------------------------------------------------------------

func cmdConfig(argv []string) error {
	if len(argv) == 0 {
		return errors.New("usage: gobbonet config get|set|keys <args>")
	}

	// --config is accepted here for the same reason serve, check and
	// set-password accept it: a launcher that pins an explicit config path must
	// be able to read and write that same file. Without it, `config set` would
	// silently edit the *discovered* config instead — a different file from the
	// one the very next `serve --config` is about to read.
	sub := argv[0]
	rest, configPath, err := extractConfigFlag(argv[1:])
	if err != nil {
		return err
	}

	switch sub {
	case "keys":
		for _, key := range config.Keys() {
			fmt.Println(key)
		}
		return nil

	case "get":
		if len(rest) < 1 {
			return errors.New("usage: gobbonet config get [--config PATH] <key>")
		}
		cfg, err := loadConfig(configPath)
		if err != nil {
			return err
		}
		value, err := cfg.Get(rest[0])
		if err != nil {
			return err
		}
		fmt.Println(value)
		return nil

	case "set":
		if len(rest) < 2 {
			return errors.New("usage: gobbonet config set [--config PATH] <key> <value>")
		}
		path := configPath
		if path == "" {
			path, _ = config.Discover("")
		}
		if _, err := os.Stat(path); err != nil {
			if err := config.WriteDefault(path); err != nil {
				return fmt.Errorf("could not create %s: %w", path, err)
			}
		}
		if err := config.Set(path, rest[0], strings.Join(rest[1:], " ")); err != nil {
			return err
		}
		return nil

	default:
		return fmt.Errorf("unknown config subcommand %q", sub)
	}
}

// extractConfigFlag pulls --config/-config (in both "--config PATH" and
// "--config=PATH" forms) out of the argument list, leaving the positional
// key/value arguments behind. Hand-rolled rather than flag.FlagSet because the
// positionals come *after* the subcommand name, which FlagSet will not parse.
func extractConfigFlag(argv []string) (rest []string, path string, err error) {
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--config" || arg == "-config":
			if i+1 >= len(argv) {
				return nil, "", errors.New("--config needs a path")
			}
			path = argv[i+1]
			i++
		case strings.HasPrefix(arg, "--config="):
			path = strings.TrimPrefix(arg, "--config=")
		case strings.HasPrefix(arg, "-config="):
			path = strings.TrimPrefix(arg, "-config=")
		default:
			rest = append(rest, arg)
		}
	}
	return rest, path, nil
}

// --- mock ------------------------------------------------------------------

func cmdMock(argv []string) error {
	if len(argv) == 0 {
		return errors.New("usage: gobbonet mock list|run [--config PATH] [story_id]")
	}

	sub := argv[0]
	rest, configPath, err := extractConfigFlag(argv[1:])
	if err != nil {
		return err
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		path, _ := config.Discover(configPath)
		if loadedCfg, loadErr := config.Load(path); loadErr == nil {
			cfg = loadedCfg
		} else {
			return err
		}
	}

	engine := mock.NewEngine(cfg.StoriesDir, cfg.LLMURL, cfg.LLMAPIKey)

	switch sub {
	case "list":
		stories, err := engine.DiscoverStories()
		if err != nil {
			return err
		}
		fmt.Printf(" [OK] discovered %d user stor(ies) in %s\n", len(stories), cfg.StoriesDir)
		for _, s := range stories {
			fmt.Printf("   - %s (%s) — %d step(s)\n", s.ID, s.Name, len(s.Steps))
			if s.Description != "" {
				fmt.Printf("     %s\n", s.Description)
			}
		}
		return nil

	case "run":
		stories, err := engine.DiscoverStories()
		if err != nil {
			return err
		}
		targetStoryID := ""
		if len(rest) > 0 {
			targetStoryID = rest[0]
		}

		var toRun []mock.Story
		for _, s := range stories {
			if targetStoryID == "" || s.ID == targetStoryID || s.Path == targetStoryID {
				toRun = append(toRun, s)
			}
		}
		if len(toRun) == 0 {
			if targetStoryID != "" {
				return fmt.Errorf("story %q not found", targetStoryID)
			}
			fmt.Printf(" [*] no stories found in %s\n", cfg.StoriesDir)
			return nil
		}

		fmt.Printf(" [..] running %d stor(ies) against %s ...\n", len(toRun), cfg.LLMURL)
		failedCount := 0
		for _, s := range toRun {
			fmt.Printf(" [..] story: %s (%s)\n", s.ID, s.Name)
			res, err := engine.RunStory(context.Background(), s)
			if err != nil {
				fmt.Printf(" [!]  error running %s: %v\n", s.ID, err)
				failedCount++
				continue
			}
			if res.Status == "passed" {
				fmt.Printf(" [OK] passed (%v)\n", res.Duration)
			} else {
				fmt.Printf(" [FAIL] failed (%v)\n", res.Duration)
				for _, step := range res.StepResults {
					if !step.Passed {
						fmt.Printf("      step %d: %s\n", step.StepIndex, strings.Join(step.Errors, "; "))
					}
				}
				failedCount++
			}
		}

		if failedCount > 0 {
			return fmt.Errorf("%d/%d stories failed", failedCount, len(toRun))
		}
		fmt.Printf(" [OK] all %d stories passed!\n", len(toRun))
		return nil

	default:
		return fmt.Errorf("unknown mock subcommand %q (expected list or run)", sub)
	}
}
