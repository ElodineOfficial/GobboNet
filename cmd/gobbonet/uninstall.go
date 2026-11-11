package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/autostart"
	"github.com/ElodineOfficial/GobboNet/internal/config"
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

	// A missing config is not a reason to refuse: the whole point is to clean
	// up, and the default locations are known without it.
	dataDir := config.DataDir()
	configDir := config.ConfigDir()
	configFile := ""
	modelDir := filepath.Join(dataDir, "models")

	// Found the way every other command finds it (1.7.9). This read
	// config.Load(*configPath) straight, and with no --config that path is
	// empty: the user's config was never read, so a data_dir chosen in the
	// Linux setup wizard (it always asks) was never looked in. The command
	// removed the config, left every conversation where it was, and said
	// "GobboNet's data is gone, and so are your conversations."
	path, _ := config.Discover(*configPath)
	cfg, err := config.Load(path)
	switch {
	case err == nil, errors.Is(err, config.ErrNotFound):
	default:
		// A config that exists but cannot be read may name a data_dir this
		// command cannot see. Guessing the defaults and reporting success is
		// the mistake above again, so stop and say what to fix.
		return fmt.Errorf("cannot read %s, so the folder your conversations are in is unknown: %v\n"+
			"       Fix that file (gobbonet doctor shows what is wrong), or remove the folder by hand", path, err)
	}
	if err == nil {
		if cfg.DataDir != "" {
			dataDir = cfg.DataDir
			modelDir = filepath.Join(dataDir, "models")
		}
		if cfg.ModelDir != "" {
			modelDir = cfg.ModelDir
		}
		if cfg.Path != "" {
			configDir = filepath.Dir(cfg.Path)
			configFile = cfg.Path
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
	paths := []string{
		filepath.Join(dataDir, "state.json"),
		filepath.Join(dataDir, "state.json.bak"),
		// Added after this list was written, and conversations or their keys
		// just the same: the key that decrypts an encrypted backup, its lock
		// file, and the engine's log. Device-sync profile backups
		// (state-<name>.json) are globbed in below.
		filepath.Join(dataDir, "state.keyring"),
		filepath.Join(dataDir, ".state.lock"),
		filepath.Join(dataDir, "llama-server.log"),
		filepath.Join(dataDir, "embed-server.log"), // 1.8.0, #15
		filepath.Join(dataDir, "setup-complete.json"),
		// The Go server holds jobs in memory, but a tree carried over from the
		// PowerShell lineage may still have the spool on disk.
		filepath.Join(dataDir, ".jobs"),
		// Where the update button keeps a download while it takes the program
		// out (1.8.0, internal/server/update.go). It holds only GobboNet's own
		// .part files, but once made it stays, and kept the data folder from
		// being removed below.
		filepath.Join(dataDir, "update"),
	}
	if profiles, err := filepath.Glob(filepath.Join(dataDir, "state-*.json*")); err == nil {
		paths = append(paths, profiles...)
	}
	// Each MCP server's log (1.8.0, #16).
	if logs, err := filepath.Glob(filepath.Join(dataDir, "mcp-*.log")); err == nil {
		paths = append(paths, logs...)
	}
	for _, p := range paths {
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

	for _, line := range removeConfig(configDir, configFile) {
		fmt.Println(line)
	}

	// --- models: the expensive thing --------------------------------------
	//
	// A models folder GobboNet made for itself may go whole. One the user chose
	// (1.8.0: the Linux setup offers an existing collection, #68) may hold
	// models and files from other apps -- or be their home folder -- so from
	// that only the .gguf files directly in it are ever deleted.
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		exeDir = filepath.Dir(exe)
	}
	own := ownModelsFolder(modelDir, dataDir, configDir, exeDir)
	modelsPresent := false
	if own {
		if entries, err := os.ReadDir(modelDir); err == nil && len(entries) > 0 {
			modelsPresent = true
		}
	} else {
		modelsPresent = len(modelFilesIn(modelDir)) > 0
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
	case own:
		deleteModels = askYesNo(fmt.Sprintf(
			"  Delete the downloaded models in %s too?\n"+
				"  These run to tens of gigabytes and are slow to fetch again. [y/N]: ", modelDir))
	default:
		deleteModels = askYesNo(fmt.Sprintf(
			"  %s is a models folder you chose, and may hold models from other apps.\n"+
				"  Delete the .gguf files directly in it? Nothing else in it, and not the folder. [y/N]: ", modelDir))
	}

	switch {
	case !modelsPresent:
		fmt.Println("  [OK] No downloaded models found.")
	case deleteModels && own:
		if err := os.RemoveAll(modelDir); err != nil {
			fmt.Printf("  [WARN] Could not remove %s: %v\n", modelDir, err)
		} else {
			fmt.Println("  [OK] Models removed.")
		}
	case deleteModels:
		n, failed := 0, 0
		for _, f := range modelFilesIn(modelDir) {
			if err := os.Remove(f); err != nil {
				failed++
				fmt.Printf("  [WARN] Could not remove %s: %v\n", f, err)
			} else {
				n++
			}
		}
		fmt.Printf("  [OK] Removed %d .gguf file(s) from %s; the folder and everything else in it were kept.\n", n, modelDir)
		if failed > 0 {
			deleteModels = false // say below where the rest still are
		}
	default:
		fmt.Printf("  [--] Models kept at %s\n", modelDir)
	}

	// GobboNet's own embedding model, which the Linux setup downloads into
	// <data_dir>/embeddings when asked (since 1.7). It is a part of GobboNet
	// that setup fetched, not one of the user's models, so it goes with the
	// data whatever was said about models; up to 1.8.0 it stayed, and so did
	// the data folder. Only that file and its unfinished download
	// (gobbonet-setup.py's .part), then the folder if that empties it: a
	// data_dir the user chose may hold a folder of that name of their own.
	embedDir := filepath.Join(dataDir, "embeddings")
	if err := os.Remove(filepath.Join(embedDir, config.EmbedModelFile)); err == nil {
		fmt.Printf("  [OK] GobboNet's embedding model removed (%s).\n", config.EmbedModelFile)
	}
	_ = os.Remove(filepath.Join(embedDir, strings.TrimSuffix(config.EmbedModelFile, ".gguf")+".part"))
	_ = os.Remove(embedDir)

	// The Linux launcher writes its log, and since 1.8.0 its engine-choice
	// note (#72), to the default data folder whatever data_dir says. Both go,
	// whichever folder holds the conversations; up to 1.8.0 the log was
	// removed only when data_dir was elsewhere, so in the default folder it
	// kept that folder from being removed.
	def := config.DataDir()
	_ = os.Remove(filepath.Join(def, "launch.log"))
	_ = os.Remove(config.EngineChoicePath())
	// And the log of a first run's setup page, which the launcher makes there
	// with mktemp (setup.XXXXXX). Up to 1.8.0 it was removed only when setup
	// finished, so every first run abandoned or interrupted left one, and
	// kept the folder. Only files of exactly that shape, in GobboNet's own
	// folder.
	if logs, err := filepath.Glob(filepath.Join(def, "setup.??????")); err == nil {
		for _, f := range logs {
			if st, err := os.Lstat(f); err == nil && st.Mode().IsRegular() {
				_ = os.Remove(f)
			}
		}
	}
	// Only removes the directory if it is genuinely empty, so a kept models
	// folder survives intact.
	_ = os.Remove(dataDir)
	if !samePath(def, dataDir) {
		_ = os.Remove(def)
	}

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
	exe, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	appImage := appImageOf(exe, os.Getenv("APPIMAGE"), os.Getenv("APPDIR"))
	for _, line := range removeHint(runtime.GOOS, exe, appImage) {
		fmt.Println(line)
	}
	fmt.Println()
	return nil
}

// removeConfig deletes GobboNet's configuration, and nothing that isn't
// GobboNet's (issue #63).
//
// It used to RemoveAll the folder the config file sat in. That is right for
// the folder GobboNet creates for itself (config.ConfigDir(), ".../gobbonet"),
// and wrong anywhere else. --config and $GOBBONET_CONFIG can point at a file
// in a shared folder, and the last place config discovery looks is
// ./config.toml beside launch.bat -- the install folder, where a relative
// model_dir puts the models. RemoveAll there took the user's other files, or
// the models, silently and before the models question was even asked.
//
// So: GobboNet's own folder still goes whole. Any other folder loses only the
// files GobboNet writes beside a config it is pointed at -- the config file, the
// copy kept by CONFIG's editor (<config>.bak), a perf.toml it wrote (config.PerfPath; checked by content, the name is
// generic) and atomic-write leftovers (".<name>.*.tmp") -- and is removed
// only if that leaves it empty.
func removeConfig(dir, file string) []string {
	if file == "" || samePath(dir, config.ConfigDir()) {
		if err := os.RemoveAll(dir); err != nil {
			return []string{fmt.Sprintf("  [WARN] Could not remove %s: %v", dir, err)}
		}
		return []string{"  [OK] Config and stored password removed."}
	}

	// The copy CONFIG's config.toml editor keeps of the file before a save
	// (config.BackupPath). It holds the password hash too.
	targets := []string{file, config.BackupPath(file)}
	perf := config.PerfPath(file)
	if b, err := os.ReadFile(perf); err == nil && config.IsPerfOverlay(b) {
		targets = append(targets, perf)
	}
	if tmps, err := filepath.Glob(filepath.Join(dir, "."+filepath.Base(file)+".*.tmp")); err == nil {
		targets = append(targets, tmps...)
	}
	var warn []string
	for _, p := range targets {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			warn = append(warn, fmt.Sprintf("  [WARN] Could not remove %s: %v", p, err))
		}
	}
	if len(warn) > 0 {
		return warn
	}
	if os.Remove(dir) == nil {
		return []string{"  [OK] Config and stored password removed."}
	}
	return []string{
		"  [OK] Config and stored password removed: " + file,
		"       Its folder holds other files, so it was left in place.",
	}
}

// ownModelsFolder reports whether dir is a models folder GobboNet made for
// itself: "models" inside the data folder, beside the config, or beside the
// program (the Windows install folder, a portable ZIP). Uninstall may delete
// such a folder whole. Any other folder was chosen by someone and is not
// GobboNet's to remove (1.8.0, #68).
func ownModelsFolder(dir, dataDir, configDir, exeDir string) bool {
	for _, base := range []string{dataDir, configDir, exeDir} {
		if base != "" && samePath(dir, filepath.Join(base, "models")) {
			return true
		}
	}
	return false
}

// modelFilesIn lists the .gguf files (and GobboNet's .gguf.part leftovers)
// directly in dir: files and links, never folders, never anything deeper.
// That is all uninstall ever deletes from a models folder someone chose.
func modelFilesIn(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if !strings.HasSuffix(name, ".gguf") && !strings.HasSuffix(name, ".gguf.part") {
			continue
		}
		if e.Type().IsRegular() || e.Type()&os.ModeSymlink != 0 {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out
}

// samePath compares two directory paths after cleaning them, ignoring case
// on Windows, where the file system does.
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if aa, err := filepath.Abs(a); err == nil {
		a = aa
	}
	if bb, err := filepath.Abs(b); err == nil {
		b = bb
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// removeHint says what removes the program files, which this command leaves to
// whatever installed them. It goes by where the running binary is, because
// that is what decides it -- not the distribution: a ZIP unpacked on Fedora is
// still a ZIP.
//
// It used to name apt everywhere but Windows, so the Fedora package's users
// were told to run a command their system does not have. 1.7.6 deferred the fix
// to the next binary (CHANGELOG-1.7.6-fedora-rpm.md, "Still outstanding") and
// put the dnf command in FEDORA.md meanwhile. Naming apt on Windows -- where
// the NSIS uninstaller invokes this -- had already sent people looking for a
// package manager that is not there.
func removeHint(goos, exe, appImage string) []string {
	switch {
	// Checked first: from an AppImage the binary sits in a temporary mount,
	// /tmp/.mount_<random>/usr/lib/gobbonet, which would otherwise read as a
	// ZIP folder -- one that is read-only and gone the moment GobboNet exits.
	case appImage != "":
		return []string{
			"  GobboNet is running from an AppImage, and that one file is the whole program:",
			"  delete " + appImage,
			"  If an AppImage manager added it to your menu, remove it there as well.",
		}
	case goos == "windows":
		return []string{
			"  The program files themselves belong to the uninstaller:",
			"  Settings > Apps > GobboNet > Uninstall.",
		}
	// The .rpm's program directory (%{_libdir}/gobbonet in gobbonet.spec).
	case strings.HasPrefix(exe, "/usr/lib64/gobbonet/"):
		return []string{"  The program files themselves are the package manager's:  sudo dnf remove gobbonet"}
	// The .deb's (installer-linux/build-deb.sh).
	case strings.HasPrefix(exe, "/usr/lib/gobbonet/"):
		return []string{"  The program files themselves are the package manager's:  sudo apt remove gobbonet"}
	}
	// A portable ZIP, or a build run from anywhere else: nothing installed it,
	// so the folder it runs from is the program.
	lines := []string{
		"  Nothing installed the program files, so removing them is up to you:",
		"  delete the folder you unpacked GobboNet into.",
	}
	if exe != "" {
		lines = append(lines, "  This program is in "+filepath.Dir(exe))
	}
	return lines
}

// appImageOf returns the .AppImage file this binary is running from, or "".
//
// The AppImage runtime sets APPIMAGE (the file) and APPDIR (where it mounted
// it) for the program it starts (issue #53). Every child inherits both, so a
// terminal that is itself an AppImage hands its own to anything started from
// it; the binary has to be inside APPDIR for APPIMAGE to be about GobboNet.
func appImageOf(exe, appImage, appDir string) string {
	if appImage == "" || appDir == "" || exe == "" {
		return ""
	}
	rel, err := filepath.Rel(filepath.Clean(appDir), filepath.Clean(exe))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return appImage
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
