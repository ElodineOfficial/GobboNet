// Package autostart manages the per-user "start GobboNet when I log in" entry.
//
// Worth noting what this is NOT mirroring: the Windows installer has no startup
// entry at all. It writes no Run key and drops no shortcut in the Startup
// folder — it only offers "Launch GobboNet" on the finish page, which runs
// once. So this is a Linux addition rather than parity work, and it is opt-in
// for the same reason the LAN question is: a chat server that silently begins
// listening at every login is not something to switch on for someone.
//
// It is written per-user under XDG_CONFIG_HOME, never by the package. A root
// maintainer script cannot put a file in every home directory, and
// /etc/xdg/autostart would enable it for every account on the machine —
// including ones that never asked and never ran setup.
package autostart

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const entryName = "gobbonet.desktop"

// Dir is the XDG autostart directory for the current user.
func Dir() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "autostart")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return filepath.Join(home, ".config", "autostart")
}

// Path is the full path of the autostart entry.
func Path() string { return filepath.Join(Dir(), entryName) }

// Enabled reports whether the entry exists and has not been switched off by a
// desktop settings panel. GNOME's Tweaks and similar tools disable an entry by
// rewriting this key rather than deleting the file, so a plain existence check
// would report "on" for something the user has turned off.
func Enabled() bool {
	body, err := os.ReadFile(Path())
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "X-GNOME-Autostart-enabled=false") {
			return false
		}
	}
	return true
}

// LauncherPath finds the desktop launcher to run at login.
//
// The launcher rather than `gobbonet serve` directly, because starting the
// server is only part of the job: the engine still has to be chosen, and the
// launcher is the thing that knows how. --no-browser is what makes this
// tolerable at login — a browser window opening by itself every time you sign
// in would be a good reason to uninstall the program.
func LauncherPath() string {
	candidates := []string{"/usr/lib/gobbonet/gobbonet-launch"}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "gobbonet-launch"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	// No packaged launcher — a source checkout. `serve` alone still works
	// because setup has already run by the time anyone enables this.
	if exe, err := os.Executable(); err == nil {
		return exe + " serve"
	}
	return "gobbonet serve"
}

// Enable writes the autostart entry.
func Enable() error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return fmt.Errorf("could not create %s: %w", Dir(), err)
	}
	exec := LauncherPath()
	if !strings.HasSuffix(exec, " serve") {
		exec += " --no-browser"
	}
	body := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Version=1.0\n" +
		"Name=GobboNet\n" +
		"Comment=Start the GobboNet server at login\n" +
		"Exec=" + exec + "\n" +
		"Terminal=false\n" +
		"X-GNOME-Autostart-enabled=true\n" +
		"NoDisplay=true\n"
	if err := os.WriteFile(Path(), []byte(body), 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", Path(), err)
	}
	return nil
}

// Disable removes the entry. Removing a file that is not there is success, so
// that `--disable` is safe to run twice and safe to run on a fresh install.
func Disable() error {
	if err := os.Remove(Path()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("could not remove %s: %w", Path(), err)
	}
	return nil
}

// Set applies a boolean, which is what the wizard's checkbox needs.
func Set(on bool) error {
	if on {
		return Enable()
	}
	return Disable()
}
