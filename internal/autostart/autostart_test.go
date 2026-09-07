package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

func TestDisabledByDefault(t *testing.T) {
	isolate(t)
	if Enabled() {
		t.Error("a fresh install reports autostart already on")
	}
}

func TestEnableThenDisable(t *testing.T) {
	dir := isolate(t)
	if err := Enable(); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	p := filepath.Join(dir, "autostart", "gobbonet.desktop")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("no entry at %s: %v", p, err)
	}
	if !Enabled() {
		t.Error("Enabled() is false right after Enable()")
	}

	body, _ := os.ReadFile(p)
	text := string(body)
	for _, want := range []string{
		"[Desktop Entry]", "Type=Application", "Name=GobboNet",
		"Terminal=false", "X-GNOME-Autostart-enabled=true",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("entry is missing %q:\n%s", want, text)
		}
	}
	// A browser opening by itself at every login would be a reason to
	// uninstall the program.
	if !strings.Contains(text, "--no-browser") && !strings.Contains(text, " serve") {
		t.Errorf("the login entry does not suppress the browser:\n%s", text)
	}

	if err := Disable(); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if Enabled() {
		t.Error("Enabled() is true after Disable()")
	}
}

// Both directions have to be safe to repeat: the wizard writes whichever the
// user picked on every finish, including a repeat finish.
func TestEnableAndDisableAreIdempotent(t *testing.T) {
	isolate(t)
	for i := 0; i < 3; i++ {
		if err := Enable(); err != nil {
			t.Fatalf("Enable %d: %v", i, err)
		}
	}
	if !Enabled() {
		t.Error("not enabled after repeated Enable")
	}
	for i := 0; i < 3; i++ {
		if err := Disable(); err != nil {
			t.Fatalf("Disable %d: %v", i, err)
		}
	}
	if Enabled() {
		t.Error("still enabled after repeated Disable")
	}
}

// GNOME Tweaks and similar panels switch an entry off by rewriting this key
// rather than deleting the file. Reporting "on" for something the user has
// turned off would make the wizard's checkbox lie.
func TestDesktopDisabledKeyIsHonoured(t *testing.T) {
	dir := isolate(t)
	if err := Enable(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "autostart", "gobbonet.desktop")
	body, _ := os.ReadFile(p)
	patched := strings.Replace(string(body),
		"X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false", 1)
	if err := os.WriteFile(p, []byte(patched), 0o644); err != nil {
		t.Fatal(err)
	}
	if Enabled() {
		t.Error("an entry switched off by the desktop still reports as on")
	}
}

func TestSetAppliesABoolean(t *testing.T) {
	isolate(t)
	if err := Set(true); err != nil || !Enabled() {
		t.Errorf("Set(true): err=%v enabled=%v", err, Enabled())
	}
	if err := Set(false); err != nil || Enabled() {
		t.Errorf("Set(false): err=%v enabled=%v", err, Enabled())
	}
}

func TestRespectsXDGConfigHome(t *testing.T) {
	dir := isolate(t)
	want := filepath.Join(dir, "autostart")
	if Dir() != want {
		t.Errorf("Dir() = %q, want %q", Dir(), want)
	}
}
