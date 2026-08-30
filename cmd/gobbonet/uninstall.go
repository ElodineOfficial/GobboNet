package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/jmccardle/gobbonet/internal/autostart"
	"github.com/jmccardle/gobbonet/internal/config"
	"golang.org/x/term"
)

// `apt remove` deliberately does not touch home directories, and it is right
// not to: a root maintainer script cannot safely decide to delete files out of
// every home on the machine. That leaves the user's own data — conversations,
// config, and gigabytes of models — sitting there after they asked for the
// software to be gone.
//
// This is the command that clears it, run as the user who owns it. The policy
// is the Windows uninstaller's, kept deliberately identical:
//
//   - Conversations and the job spool go without asking. Leaving someone's
//     private chats on disk after an uninstall is not a convenience. The NSIS
//     uninstaller learned this the hard way: it left state behind, and a
//     reinstall found it and synced it straight back.
//   - Models prompt. They are tens of gigabytes, slow to fetch, and the user's
//     property.
//   - Browser storage gets mentioned, because no uninstaller can reach it.
func cmdUninstall(argv []string) error {
	fs := flag.NewFlagSet("gobbonet uninstall", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	keepModels := fs.Bool("keep-models", false, "keep downloaded models")
	removeModels := fs.Bool("remove-models", false, "remove downloaded models without asking")
	yes := fs.Bool("yes", false, "do not prompt; implies keeping models unless -remove-models")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if *keepModels && *removeModels {
		return fmt.Errorf("--keep-models and --remove-models contradict each other")
	}

	// A missing or unreadable config is not a reason to refuse: the whole point
	// is to clean up, and the default locations are known without it.
	dataDir := config.DataDir()
	configDir := config.ConfigDir()
	modelDir := filepath.Join(dataDir, "models")

	if cfg, err := config.Load(*configPath); err == nil {
		if cfg.DataDir != "" {
			dataDir = cfg.DataDir
			modelDir = filepath.Join(dataDir, "models")
		}
		if cfg.ModelDir != "" {
			modelDir = cfg.ModelDir
		}
		if cfg.Path != "" {
			configDir = filepath.Dir(cfg.Path)
		}
	}

	fmt.Println()
	fmt.Println("  Removing GobboNet's user data.")
	fmt.Println()
	fmt.Println("    config:        ", configDir)
	fmt.Println("    conversations: ", dataDir)
	fmt.Println("    models:        ", modelDir)
	fmt.Println()

	// --- the parts that go without asking ---------------------------------
	removed := 0
	for _, p := range []string{
		filepath.Join(dataDir, "state.json"),
		filepath.Join(dataDir, "state.json.bak"),
		filepath.Join(dataDir, "setup-complete.json"),
		// The Go server holds jobs in memory, but a tree carried over from the
		// PowerShell lineage may still have the spool on disk.
		filepath.Join(dataDir, ".jobs"),
	} {
		if err := os.RemoveAll(p); err == nil {
			if _, statErr := os.Stat(p); statErr != nil {
				removed++
			}
		}
	}
	fmt.Printf("  [OK] Conversations and job spool removed (%d paths).\n", removed)

	// The login entry lives outside the config directory, so removing that
	// directory would leave it behind — pointing at a binary that is about to
	// be removed, failing silently at every login from then on.
	if autostart.Enabled() {
		if err := autostart.Disable(); err != nil {
			fmt.Printf("  [WARN] Could not remove the login entry: %v\n", err)
		} else {
			fmt.Println("  [OK] Login entry removed.")
		}
	}

	if err := os.RemoveAll(configDir); err != nil {
		fmt.Printf("  [WARN] Could not remove %s: %v\n", configDir, err)
	} else {
		fmt.Println("  [OK] Config and stored password removed.")
	}

	// --- models: the expensive thing --------------------------------------
	modelsPresent := false
	if entries, err := os.ReadDir(modelDir); err == nil && len(entries) > 0 {
		modelsPresent = true
	}

	deleteModels := false
	switch {
	case !modelsPresent:
	case *removeModels:
		deleteModels = true
	case *keepModels:
		deleteModels = false
	case *yes:
		// Unattended and nobody said which way: keep. Deleting gigabytes the
		// user never agreed to lose is the one mistake here that cannot be
		// undone by running the command again.
		deleteModels = false
	default:
		deleteModels = askYesNo(fmt.Sprintf(
			"  Delete the downloaded models in %s too?\n"+
				"  These run to tens of gigabytes and are slow to fetch again. [y/N]: ", modelDir))
	}

	switch {
	case !modelsPresent:
		fmt.Println("  [OK] No downloaded models found.")
	case deleteModels:
		if err := os.RemoveAll(modelDir); err != nil {
			fmt.Printf("  [WARN] Could not remove %s: %v\n", modelDir, err)
		} else {
			fmt.Println("  [OK] Models removed.")
		}
	default:
		fmt.Printf("  [--] Models kept at %s\n", modelDir)
	}

	// Only removes the directory if it is genuinely empty, so a kept models
	// folder survives intact.
	_ = os.Remove(dataDir)

	fmt.Println()
	fmt.Println("  GobboNet's data is gone, and so are your conversations.")
	if modelsPresent && !deleteModels {
		fmt.Printf("  Your models were left where they were: %s\n", modelDir)
	}
	fmt.Println()
	fmt.Println("  One copy remains that no uninstaller can reach: the browser's own")
	fmt.Println("  storage for this site. Clear it from the browser that opened the chat,")
	fmt.Println("  under site data for the address you used.")
	fmt.Println()
	// This command clears user data; something else owns the program files.
	// Naming apt on Windows -- where the NSIS uninstaller invokes this -- sent
	// people looking for a package manager that is not there.
	if runtime.GOOS == "windows" {
		fmt.Println("  The program files themselves belong to the uninstaller:")
		fmt.Println("  Settings > Apps > GobboNet > Uninstall.")
	} else {
		fmt.Println("  The program files themselves are the package manager's:  sudo apt remove gobbonet")
	}
	fmt.Println()
	return nil
}

func askYesNo(prompt string) bool {
	// No terminal means nobody to ask, and the safe answer for something this
	// large and this irreversible is no.
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Println("  (no terminal to ask on — keeping models; use --remove-models to delete them)")
		return false
	}
	fmt.Print(prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}
