package main

import (
	"os"
	"path/filepath"
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
	write(filepath.Join(configDir, "config.toml"))
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
