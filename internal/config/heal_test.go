package config

import (
	"os"
	"path/filepath"
	"testing"
)

// The scenario these cover is the support report this release exists for: an
// absolute server_exe written by the installer, pointing at an install
// directory that no longer exists, turning every subsequent start into a fatal
// error the user could not locate.

func TestHealServerExeLeavesGoodPathsAlone(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "llama-server")
	if err := os.WriteFile(real, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := &Config{ServerExe: real}
	if from, healed := cfg.HealServerExe(); healed {
		t.Errorf("healed a path that was fine (from %q)", from)
	}
	if cfg.ServerExe != real {
		t.Errorf("server_exe changed: got %q, want %q", cfg.ServerExe, real)
	}
}

func TestHealServerExeIgnoresRemoteMode(t *testing.T) {
	// An empty server_exe is a deliberate statement -- remote mode -- and must
	// never be filled in by a repair. Adopting a stray binary here would turn a
	// working remote install into a local one that supervises something the
	// user did not ask for.
	cfg := &Config{ServerExe: ""}
	if _, healed := cfg.HealServerExe(); healed {
		t.Error("healed an empty server_exe; remote mode must be left alone")
	}
	if cfg.ServerExe != "" {
		t.Errorf("server_exe was filled in: %q", cfg.ServerExe)
	}
}

func TestHealServerExeFindsBinaryBesideUs(t *testing.T) {
	// HealServerExe looks beside the running binary and in the working
	// directory. The test binary's own directory is not writable in every
	// environment, so drive it through the working-directory branch.
	dir := t.TempDir()
	engine := filepath.Join(dir, "llama-cpp")
	if err := os.MkdirAll(engine, 0o755); err != nil {
		t.Fatal(err)
	}
	found := filepath.Join(engine, serverExeName())
	if err := os.WriteFile(found, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	stale := filepath.Join(dir, "gone", "1.6", serverExeName())
	cfg := &Config{ServerExe: stale}
	from, healed := cfg.HealServerExe()
	if !healed {
		t.Fatalf("did not heal; server_exe is still %q", cfg.ServerExe)
	}
	if from != stale {
		t.Errorf("reported old path %q, want %q", from, stale)
	}
	// EvalSymlinks on macOS turns /var into /private/var, so compare the
	// resolved forms rather than the literal strings.
	gotResolved, _ := filepath.EvalSymlinks(cfg.ServerExe)
	wantResolved, _ := filepath.EvalSymlinks(found)
	if gotResolved != wantResolved {
		t.Errorf("healed to %q, want %q", cfg.ServerExe, found)
	}

	// And the whole point: Mode() must now succeed rather than being fatal.
	mode, err := cfg.Mode()
	if err != nil {
		t.Fatalf("Mode() still fatal after healing: %v", err)
	}
	if mode != ModeLocal {
		t.Errorf("mode: got %v, want %v", mode, ModeLocal)
	}
}

func TestHealServerExeGivesUpWhenNothingIsThere(t *testing.T) {
	// No candidate anywhere means the fatal error is still the right answer.
	// Inventing a path here would trade a clear error for a confusing one.
	dir := t.TempDir()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	stale := filepath.Join(dir, "nowhere", serverExeName())
	cfg := &Config{ServerExe: stale}
	if _, healed := cfg.HealServerExe(); healed {
		t.Errorf("claimed to heal with no candidate present: %q", cfg.ServerExe)
	}
	if _, err := cfg.Mode(); err == nil {
		t.Error("Mode() should still be fatal when there is nothing to run")
	}
}

func TestHealServerExeRejectsDirectories(t *testing.T) {
	// A directory named llama-server is not a binary. Mode() already refuses
	// one; the repair must not hand it a fresh one.
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "llama-cpp", serverExeName()), 0o755); err != nil {
		t.Fatal(err)
	}
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	cfg := &Config{ServerExe: filepath.Join(dir, "gone", serverExeName())}
	if _, healed := cfg.HealServerExe(); healed {
		t.Errorf("adopted a directory as the engine: %q", cfg.ServerExe)
	}
}

func TestPortFileRoundTrip(t *testing.T) {
	// The sidecar has to survive the trailing newline it is written with,
	// because launch.bat and setup-lan.bat both parse it as digits only.
	path := PortFilePath()
	if path == "" {
		t.Skip("cannot locate the test binary")
	}
	if _, err := os.Stat(filepath.Dir(path)); err != nil {
		t.Skip("binary directory is unavailable")
	}

	existing, hadExisting := os.ReadFile(path)
	t.Cleanup(func() {
		if hadExisting == nil {
			os.WriteFile(path, existing, 0o644)
		} else {
			os.Remove(path)
		}
	})

	if err := WritePortFile(9066); err != nil {
		t.Skipf("binary directory is not writable: %v", err)
	}
	if got := ReadPortFile(); got != 9066 {
		t.Errorf("round trip: got %d, want 9066", got)
	}

	// Garbage must read as "no opinion", not as a port number.
	if err := os.WriteFile(path, []byte("not a port\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ReadPortFile(); got != 0 {
		t.Errorf("unparseable sidecar: got %d, want 0", got)
	}
}
