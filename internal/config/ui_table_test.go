package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// [ui] is a table, and `config get`/`config set` deal in single scalar values
// for the launcher scripts. Listing it as a key would advertise a command that
// cannot work.
func TestKeysSkipsTableFields(t *testing.T) {
	for _, k := range Keys() {
		if k == "ui" {
			t.Fatal("Keys() lists the [ui] table as a settable scalar key")
		}
	}
	// The scalar keys must all still be there.
	var seen int
	for _, k := range Keys() {
		if k == "llm_url" || k == "listen_port" || k == "data_dir" {
			seen++
		}
	}
	if seen != 3 {
		t.Errorf("expected the ordinary scalar keys to survive, found %d of 3", seen)
	}
}

func TestUITableParses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gobbonet.toml")
	body := `
llm_url = "http://127.0.0.1:8080"

[ui]
stream_replies = false
auto_scroll = "off"
token_limit = 8192
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.UI == nil {
		t.Fatal("[ui] table did not parse")
	}
	if cfg.UI["auto_scroll"] != "off" {
		t.Errorf("auto_scroll: got %v", cfg.UI["auto_scroll"])
	}
	if cfg.UI["stream_replies"] != false {
		t.Errorf("stream_replies: got %v", cfg.UI["stream_replies"])
	}
	// The server half must be unaffected by the presence of a [ui] table.
	if cfg.LLMURL != "http://127.0.0.1:8080" {
		t.Errorf("llm_url: got %q", cfg.LLMURL)
	}
}

// A config with no [ui] section is the common case and must stay valid.
func TestNoUITableIsFine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gobbonet.toml")
	if err := os.WriteFile(path, []byte("llm_url = \"http://127.0.0.1:8080\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.UI) != 0 {
		t.Errorf("expected no presets, got %v", cfg.UI)
	}
}

// The file the setup scripts write is where most people will first see this.
func TestDefaultTemplateDocumentsUI(t *testing.T) {
	if !strings.Contains(DefaultTOML, "[ui]") {
		t.Error("the written template does not mention the [ui] section")
	}
	// It must point at the generated list rather than listing keys itself --
	// a hand-written list in a comment is one that goes stale.
	if !strings.Contains(DefaultTOML, "SERVER PRESETS") {
		t.Error("the template does not point at the panel that lists the keys")
	}
}

// `config set` writes ROOT-level keys, and a file with a [ui] table at the
// bottom is now the normal shape. Appending at EOF puts the line inside that
// table: TOML reads it back as ui.<key>, the real key keeps its old value, and
// the command reports success. The launcher scripts drive this, so a silently
// ineffective write is a machine that comes up on the wrong port with nothing
// in any log.
func TestSetWritesAboveTables(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gobbonet.toml")
	body := `llm_url = "http://127.0.0.1:8080"

# Presets for the chat page.
[ui]
auto_scroll = "off"
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	// A key that is not in the file at all -- the append path.
	if err := Set(path, "listen_port", "9999"); err != nil {
		t.Fatalf("set: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if cfg.ListenPort != 9999 {
		t.Errorf("listen_port: got %d, want 9999 — the write landed in a table", cfg.ListenPort)
	}
	if _, stray := cfg.UI["listen_port"]; stray {
		t.Errorf("listen_port leaked into the [ui] table: %v", cfg.UI)
	}
	if cfg.UI["auto_scroll"] != "off" {
		t.Errorf("the [ui] table was disturbed: %v", cfg.UI)
	}

	// The comment introducing the table has to stay with the table.
	out, _ := os.ReadFile(path)
	text := string(out)
	iComment := strings.Index(text, "# Presets for the chat page.")
	iPort := strings.Index(text, "listen_port")
	if iPort < 0 || iComment < 0 || iPort > iComment {
		t.Errorf("the new key was not placed above the table's comment block:\n%s", text)
	}

	// And an existing root key is still replaced in place, not duplicated.
	if err := Set(path, "llm_url", "http://10.0.0.5:8080"); err != nil {
		t.Fatalf("set existing: %v", err)
	}
	out, _ = os.ReadFile(path)
	if n := strings.Count(string(out), "llm_url"); n != 1 {
		t.Errorf("llm_url appears %d times, want 1:\n%s", n, out)
	}
	cfg, _ = Load(path)
	if cfg.LLMURL != "http://10.0.0.5:8080" {
		t.Errorf("llm_url: got %q", cfg.LLMURL)
	}
}

// A file with no tables at all must keep behaving exactly as it did.
func TestSetStillAppendsWhenThereAreNoTables(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gobbonet.toml")
	if err := os.WriteFile(path, []byte("llm_url = \"http://127.0.0.1:8080\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Set(path, "listen_port", "9999"); err != nil {
		t.Fatalf("set: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if cfg.ListenPort != 9999 {
		t.Errorf("listen_port: got %d, want 9999", cfg.ListenPort)
	}
}
