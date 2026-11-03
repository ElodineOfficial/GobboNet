package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Windows uninstaller runs `gobbonet uninstall --yes --keep-models` so the
// Go server's user data goes with the program, as the PowerShell server's chat
// file always did. Everything that holds conversations -- including device-sync
// profile backups and the key to an encrypted backup -- must go; models are the
// installer's own question and must stay; nothing unrelated may be touched.
func TestUninstallRemovesEveryConversationFileAndKeepsModels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("GOBBONET_CONFIG", "")
	dataDir := filepath.Join(home, "data", "gobbonet")
	configDir := filepath.Join(home, "config", "gobbonet")

	write := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gone := []string{
		"state.json", "state.json.bak", "state.keyring", ".state.lock",
		"llama-server.log", "setup-complete.json", ".jobs/job.json",
		"state-phone.json", "state-phone.json.bak", "state-work.json",
	}
	for _, name := range gone {
		write(filepath.Join(dataDir, name))
	}
	// A real config: since 1.7.9 the command reads the one it finds, and "x"
	// is not TOML.
	write(filepath.Join(configDir, "config.toml"))
	if err := os.WriteFile(filepath.Join(configDir, "config.toml"), []byte("listen_port = 9066\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(configDir, "startup-error.log"))
	kept := []string{"models/model.gguf", "notes-the-user-made.txt"}
	for _, name := range kept {
		write(filepath.Join(dataDir, name))
	}

	if err := cmdUninstall([]string{"--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}

	for _, name := range append(gone, ".jobs") {
		if _, err := os.Stat(filepath.Join(dataDir, name)); err == nil {
			t.Errorf("left behind: %s", name)
		}
	}
	if _, err := os.Stat(configDir); err == nil {
		t.Error("config folder (settings, stored password, startup log) left behind")
	}
	for _, name := range kept {
		if _, err := os.Stat(filepath.Join(dataDir, name)); err != nil {
			t.Errorf("removed something it must keep: %s", name)
		}
	}
}

// The closing line names whatever removes the program files: dnf for the
// .rpm, apt for the .deb, Windows' own uninstaller there, and the folder itself
// for a ZIP. It named apt on every non-Windows system until 1.7.7, Fedora
// included (CHANGELOG-1.7.6-fedora-rpm.md, "Still outstanding").
func TestRemoveHintFollowsTheInstall(t *testing.T) {
	cases := []struct {
		goos, exe, want, wantNot string
	}{
		{"linux", "/usr/lib64/gobbonet/gobbonet", "sudo dnf remove gobbonet", "apt"},
		{"linux", "/usr/lib/gobbonet/gobbonet", "sudo apt remove gobbonet", "dnf"},
		{"windows", `C:\Users\a\AppData\Local\GobboNet\gobbonet.exe`, "Settings > Apps > GobboNet > Uninstall", "sudo"},
		{"linux", "/home/a/Downloads/GobboNet/linux-amd64/gobbonet", "/home/a/Downloads/GobboNet/linux-amd64", "sudo"},
		{"linux", "", "delete the folder you unpacked GobboNet into", "sudo"},
		// Prefixes, not substrings: a ZIP unpacked somewhere whose path merely
		// contains the packaged directory's name is still a ZIP.
		{"linux", "/home/a/usr/lib64/gobbonet/gobbonet", "delete the folder", "sudo"},
	}
	for _, c := range cases {
		got := strings.Join(removeHint(c.goos, c.exe, ""), "\n")
		if !strings.Contains(got, c.want) || strings.Contains(got, c.wantNot) {
			t.Errorf("removeHint(%q, %q) =\n%s\nwant it to contain %q and not %q", c.goos, c.exe, got, c.want, c.wantNot)
		}
	}
}

// Issue #53: from an AppImage the binary is in a temporary read-only mount,
// and the thing to delete is the .AppImage file.
func TestRemoveHintNamesTheAppImage(t *testing.T) {
	const file = "/home/a/Applications/GobboNet-1.7.7-x86_64.AppImage"
	const mount = "/tmp/.mount_GobboNaB3dEf"
	exe := mount + "/usr/lib/gobbonet/gobbonet"

	got := strings.Join(removeHint("linux", exe, appImageOf(exe, file, mount)), "\n")
	if !strings.Contains(got, "delete "+file) || strings.Contains(got, ".mount_") || strings.Contains(got, "sudo") {
		t.Errorf("from the AppImage:\n%s", got)
	}

	// APPIMAGE and APPDIR are inherited by every child of an AppImage. A
	// GobboNet started from a terminal that is itself an AppImage is not
	// running from that terminal's file.
	for name, c := range map[string]struct{ exe, appImage, appDir string }{
		"a .deb run from an AppImage terminal": {"/usr/lib/gobbonet/gobbonet", "/opt/Term.AppImage", "/tmp/.mount_TermXyZ"},
		"a ZIP run from an AppImage terminal":  {"/home/a/GobboNet/linux-amd64/gobbonet", "/opt/Term.AppImage", "/tmp/.mount_TermXyZ"},
		"a sibling mount with a shared prefix": {"/tmp/.mount_TermXyZ2/usr/lib/gobbonet/gobbonet", "/opt/Term.AppImage", "/tmp/.mount_TermXyZ"},
		"APPDIR without APPIMAGE":              {exe, "", mount},
		"APPIMAGE without APPDIR":              {exe, file, ""},
		"the mount itself":                     {mount, file, mount},
	} {
		if got := appImageOf(c.exe, c.appImage, c.appDir); got != "" {
			t.Errorf("%s: appImageOf = %q, want \"\"", name, got)
		}
	}
	got = strings.Join(removeHint("linux", "/usr/lib/gobbonet/gobbonet",
		appImageOf("/usr/lib/gobbonet/gobbonet", "/opt/Term.AppImage", "/tmp/.mount_TermXyZ")), "\n")
	if !strings.Contains(got, "sudo apt remove gobbonet") {
		t.Errorf("a .deb under an AppImage terminal:\n%s", got)
	}
}

// uninstallEnv points HOME and the XDG dirs into a temp tree and returns a
// helper that writes a file (creating its folder).
func uninstallEnv(t *testing.T) (home string, write func(path, body string)) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("GOBBONET_CONFIG", "")
	write = func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home, write
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

// Issue #63: --config pointing into a shared folder used to RemoveAll that
// folder. Only GobboNet's files may go.
func TestUninstallLeavesASharedConfigFolderAlone(t *testing.T) {
	home, write := uninstallEnv(t)
	shared := filepath.Join(home, "Dropbox", "settings")
	cfg := filepath.Join(shared, "config.toml")
	write(cfg, "listen_port = 9066\n")
	write(filepath.Join(shared, "perf.toml"), "# Runtime tuning overrides, written by the settings panel.\n#\nctx_size = 8192\n")
	write(filepath.Join(shared, ".config.toml.123456.tmp"), "half-written")
	// The copy CONFIG's config.toml editor keeps; it holds the password hash.
	write(filepath.Join(shared, "config.toml.bak"), "listen_port = 9066\naccess_secret = \"x\"\n")
	write(filepath.Join(shared, "tax-return-2025.pdf"), "the user's")
	write(filepath.Join(shared, "other-app.toml"), "the user's")

	if err := cmdUninstall([]string{"--config", cfg, "--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	for _, gone := range []string{"config.toml", "config.toml.bak", "perf.toml", ".config.toml.123456.tmp"} {
		if exists(filepath.Join(shared, gone)) {
			t.Errorf("GobboNet's %s was left behind", gone)
		}
	}
	for _, kept := range []string{"tax-return-2025.pdf", "other-app.toml"} {
		if !exists(filepath.Join(shared, kept)) {
			t.Errorf("deleted the user's %s from a folder GobboNet does not own", kept)
		}
	}
}

// perf.toml is a generic name. One GobboNet did not write survives.
func TestUninstallKeepsAForeignPerfToml(t *testing.T) {
	home, write := uninstallEnv(t)
	shared := filepath.Join(home, "projects")
	cfg := filepath.Join(shared, "config.toml")
	write(cfg, "listen_port = 9066\n")
	write(filepath.Join(shared, "perf.toml"), "[benchmark]\nruns = 3\n")
	if err := cmdUninstall([]string{"--config", cfg, "--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(cfg) {
		t.Error("config.toml left behind")
	}
	if !exists(filepath.Join(shared, "perf.toml")) {
		t.Error("deleted a perf.toml GobboNet did not write")
	}
}

// The last place config discovery looks is ./config.toml beside launch.bat:
// the install folder, where a relative model_dir puts the models. RemoveAll
// there used to take the program and the models before the models question
// was asked; --keep-models could not save them.
func TestUninstallInInstallFolderKeepsModelsAndProgram(t *testing.T) {
	home, write := uninstallEnv(t)
	install := filepath.Join(home, "AppData", "Local", "GobboNet")
	cfg := filepath.Join(install, "config.toml")
	write(cfg, "model_dir = \"./models\"\n")
	write(filepath.Join(install, "models", "Qwen3.5-9B.gguf"), "weights")
	write(filepath.Join(install, "launch.bat"), "@echo off")
	write(filepath.Join(install, "gobbonet.exe"), "MZ")

	if err := cmdUninstall([]string{"--config", cfg, "--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(cfg) {
		t.Error("config.toml left behind")
	}
	for _, kept := range []string{"models/Qwen3.5-9B.gguf", "launch.bat", "gobbonet.exe"} {
		if !exists(filepath.Join(install, kept)) {
			t.Errorf("--keep-models uninstall deleted %s from the install folder", kept)
		}
	}
}

// A pointed-at folder that only held GobboNet's files is tidied away.
func TestUninstallRemovesAPointedAtFolderLeftEmpty(t *testing.T) {
	home, write := uninstallEnv(t)
	dir := filepath.Join(home, "gn-config")
	cfg := filepath.Join(dir, "my-gobbonet.toml")
	write(cfg, "listen_port = 9066\n")
	if err := cmdUninstall([]string{"--config", cfg, "--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(dir) {
		t.Error("an emptied config folder was left behind")
	}
}

// 1.7.9: with no --config the command never read the user's config. The Linux
// setup wizard always asks where data goes and writes data_dir; the command
// looked in the default folder instead, removed the config, left every
// conversation in the chosen folder, and said they were gone. Found by
// installing the .deb and uninstalling as a user (CHANGELOG-1.7.9-linux-installer.md).
func TestUninstallFindsTheConfigAndItsDataDir(t *testing.T) {
	home, write := uninstallEnv(t)
	chosen := filepath.Join(home, "Gobbo Data") // a space, as the test user had
	configDir := filepath.Join(home, "config", "gobbonet")
	write(filepath.Join(configDir, "config.toml"),
		"listen_port = 9066\ndata_dir = \""+filepath.ToSlash(chosen)+"\"\n")
	for _, name := range []string{"state.json", ".state.lock", "setup-complete.json", "llama-server.log", "state-phone.json"} {
		write(filepath.Join(chosen, name), "x")
	}
	write(filepath.Join(chosen, "models", "model.gguf"), "x")
	defaultData := filepath.Join(home, "data", "gobbonet")
	write(filepath.Join(defaultData, "launch.log"), "x") // the Linux launcher's log stays in the default folder

	if err := cmdUninstall([]string{"--yes", "--keep-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	for _, name := range []string{"state.json", ".state.lock", "setup-complete.json", "llama-server.log", "state-phone.json"} {
		if exists(filepath.Join(chosen, name)) {
			t.Errorf("left behind in the chosen data folder: %s", name)
		}
	}
	if !exists(filepath.Join(chosen, "models", "model.gguf")) {
		t.Error("--keep-models removed the model")
	}
	if exists(configDir) {
		t.Error("config folder left behind")
	}
	if exists(defaultData) {
		t.Error("the launcher's log folder was left behind")
	}
}

func TestUninstallRemovesTheChosenFolderWhenItEmpties(t *testing.T) {
	home, write := uninstallEnv(t)
	chosen := filepath.Join(home, "Gobbo Data")
	write(filepath.Join(home, "config", "gobbonet", "config.toml"),
		"data_dir = \""+filepath.ToSlash(chosen)+"\"\n")
	write(filepath.Join(chosen, "state.json"), "x")
	write(filepath.Join(chosen, "models", "model.gguf"), "x")
	if err := cmdUninstall([]string{"--yes", "--remove-models"}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(chosen) {
		t.Error("the chosen data folder, emptied, was left behind")
	}
}

// A config that is there but cannot be read could name a data_dir the command
// cannot see. It stops and says so, and removes nothing, rather than clearing
// the default folders and reporting the conversations gone.
func TestUninstallStopsOnAnUnreadableConfig(t *testing.T) {
	home, write := uninstallEnv(t)
	configDir := filepath.Join(home, "config", "gobbonet")
	write(filepath.Join(configDir, "config.toml"), "data_dir = [this is not toml\n")
	write(filepath.Join(home, "data", "gobbonet", "state.json"), "x")
	err := cmdUninstall([]string{"--yes", "--keep-models"})
	if err == nil || !strings.Contains(err.Error(), "conversations are in is unknown") {
		t.Fatalf("want a refusal naming the problem, got %v", err)
	}
	if !exists(filepath.Join(configDir, "config.toml")) || !exists(filepath.Join(home, "data", "gobbonet", "state.json")) {
		t.Error("removed files after refusing")
	}
}
