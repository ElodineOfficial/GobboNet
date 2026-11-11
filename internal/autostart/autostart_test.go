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

// The login entry from an AppImage starts the AppImage file, not the launcher
// inside its temporary mount, which is gone once GobboNet closes (1.7.8 to
// 1.8.0 wrote the mount path, so the entry did nothing at the next login).
func TestLauncherFor(t *testing.T) {
	files := map[string]bool{
		"/usr/lib/gobbonet/gobbonet-launch":                   false,
		"/tmp/.mount_GobboX/usr/lib/gobbonet/gobbonet-launch": true,
		"/home/me/GobboNet/linux-amd64/gobbonet-launch":       true,
	}
	isFile := func(p string) bool { return files[p] }
	cases := []struct {
		name, exe, appImage, appDir, path, args string
	}{
		{"an AppImage", "/tmp/.mount_GobboX/usr/lib/gobbonet/gobbonet", "/home/me/Apps/GobboNet.AppImage", "/tmp/.mount_GobboX",
			"/home/me/Apps/GobboNet.AppImage", "--no-browser"},
		{"another AppImage's variables", "/home/me/GobboNet/linux-amd64/gobbonet", "/home/me/Apps/Terminal.AppImage", "/tmp/.mount_Term",
			"/home/me/GobboNet/linux-amd64/gobbonet-launch", "--no-browser"},
		{"the ZIP", "/home/me/GobboNet/linux-amd64/gobbonet", "", "",
			"/home/me/GobboNet/linux-amd64/gobbonet-launch", "--no-browser"},
		{"a source checkout", "/home/me/src/gobbonet", "", "", "/home/me/src/gobbonet", "serve"},
	}
	for _, c := range cases {
		path, args := launcherFor(c.exe, c.appImage, c.appDir, isFile)
		if path != c.path || args != c.args {
			t.Errorf("%s: got %q %q, want %q %q", c.name, path, args, c.path, c.args)
		}
	}
	files["/usr/lib/gobbonet/gobbonet-launch"] = true
	if path, _ := launcherFor("/usr/lib/gobbonet/gobbonet", "", "", isFile); path != "/usr/lib/gobbonet/gobbonet-launch" {
		t.Errorf("the .deb: got %q", path)
	}
	if path, _ := launcherFor("/tmp/.mount_GobboX/usr/lib/gobbonet/gobbonet", "/home/me/G.AppImage", "/tmp/.mount_GobboX", isFile); path != "/home/me/G.AppImage" {
		t.Errorf("an AppImage on a machine that also has the .deb installed: got %q", path)
	}
}

func TestExecIsQuoted(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/lib/gobbonet/gobbonet-launch":      `"/usr/lib/gobbonet/gobbonet-launch"`,
		"/home/me/My Apps/GobboNet 1.8.AppImage": `"/home/me/My Apps/GobboNet 1.8.AppImage"`,
		"/home/me/$odd/\"q\"/`b`/100%/x":         `"/home/me/\$odd/\"q\"/\` + "`b\\`" + `/100%%/x"`,
	} {
		if got := execQuote(in); got != want {
			t.Errorf("execQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestEnableFromAnAppImage(t *testing.T) {
	dir := isolate(t)
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	// The test binary stands in for the one inside the image.
	t.Setenv("APPDIR", filepath.Dir(exe))
	t.Setenv("APPIMAGE", "/home/me/My Apps/GobboNet.AppImage")
	if err := Enable(); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "autostart", "gobbonet.desktop"))
	if !strings.Contains(string(body), "\nExec=\"/home/me/My Apps/GobboNet.AppImage\" --no-browser\n") {
		t.Errorf("the entry does not start the AppImage file:\n%s", body)
	}
}
