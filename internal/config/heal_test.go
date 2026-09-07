package config

import (
	"os"
	"path/filepath"
	"runtime"
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
	// Exercised against a temp path rather than the real sidecar location, so
	// the format stays under test on every platform. It used to go through
	// WritePortFile/ReadPortFile and skip whenever the binary's directory was
	// not writable — which is every Linux run, and now every non-Windows run,
	// leaving the parser covered nowhere.
	//
	// The sidecar has to survive the trailing newline it is written with,
	// because launch.bat and setup-lan.bat both parse it as digits only.
	path := filepath.Join(t.TempDir(), ".gobbonet-port")

	if err := writePortFileTo(path, 9066); err != nil {
		t.Fatal(err)
	}
	if got := readPortFileAt(path); got != 9066 {
		t.Errorf("round trip: got %d, want 9066", got)
	}

	// Garbage must read as "no opinion", not as a port number.
	if err := os.WriteFile(path, []byte("not a port\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readPortFileAt(path); got != 0 {
		t.Errorf("unparseable sidecar: got %d, want 0", got)
	}

	// A missing file is the same "no opinion", not an error the caller has to
	// distinguish. doctor leans on this to mean "nothing recorded yet".
	if got := readPortFileAt(filepath.Join(t.TempDir(), "absent")); got != 0 {
		t.Errorf("absent sidecar: got %d, want 0", got)
	}
}

// TestPortFileIsWindowsOnly pins NEW-1.
//
// The sidecar exists to feed setup-lan.bat and launch.bat. Neither ships
// outside Windows, and the Linux launcher deliberately reads listen_port
// instead (gobbonet-launch:187). Writing it anyway put a permission warning on
// every Linux launch for a file nothing on the platform would ever read.
//
// The assertion that matters most is that WritePortFile reports success: main.go
// prints a warning on a non-nil error, so spelling "this platform has no
// sidecar" as an error would put the warning straight back.
func TestPortFileIsWindowsOnly(t *testing.T) {
	windows := runtime.GOOS == "windows"

	if got := PortFileSupported(); got != windows {
		t.Errorf("PortFileSupported() = %v on %s, want %v", got, runtime.GOOS, windows)
	}

	if err := WritePortFile(9066); err != nil && !windows {
		t.Errorf("WritePortFile returned %v; a no-op platform must report success", err)
	}

	if windows {
		return
	}

	if got := PortFilePath(); got != "" {
		t.Errorf("PortFilePath() = %q, want empty off Windows", got)
	}
	if got := ReadPortFile(); got != 0 {
		t.Errorf("ReadPortFile() = %d, want 0 off Windows", got)
	}
	// Reported as "nothing to write", not as a failure to write.
	ok, err := PortFileWritable()
	if ok {
		t.Error("PortFileWritable() = true off Windows, where there is no sidecar")
	}
	if err != nil {
		t.Errorf("PortFileWritable() error = %v; absence is not a fault", err)
	}
}

// TestDirWritable pins the NEW-2 half. doctor can only tell "not written yet"
// apart from "can never be written" if the answer comes from attempting a
// write: mode bits are not enough, because ACLs, read-only mounts and
// container filesystems all deny writes the bits appear to permit.
//
// It must also leave nothing behind. This runs against the install directory
// on a machine someone is already troubleshooting, and a diagnostic that
// litters there is its own bug report.
func TestDirWritable(t *testing.T) {
	dir := t.TempDir()

	before, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := dirWritable(dir)
	if !ok || err != nil {
		t.Fatalf("dirWritable on a fresh temp dir: ok=%v err=%v", ok, err)
	}
	after, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("probe left %d entries behind", len(after)-len(before))
	}

	// A directory that does not exist is not writable, and says why.
	if ok, err := dirWritable(filepath.Join(dir, "absent")); ok || err == nil {
		t.Errorf("dirWritable on a missing directory: ok=%v err=%v", ok, err)
	}

}

// TestDirWritableRefusesReadOnly covers the case the report actually hit:
// /usr/lib/gobbonet is root-owned with no group or other write bit, so a
// normal user can never write there and doctor must not imply otherwise.
//
// Separate from TestDirWritable because it can only run unprivileged, and
// folding it in would report the whole thing as skipped under root — hiding
// that the assertions above did run.
func TestDirWritableRefusesReadOnly(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the mode bits this asserts")
	}
	readonly := filepath.Join(t.TempDir(), "readonly")
	if err := os.Mkdir(readonly, 0o500); err != nil {
		t.Fatal(err)
	}
	if ok, err := dirWritable(readonly); ok || err == nil {
		t.Errorf("dirWritable on a read-only directory: ok=%v err=%v", ok, err)
	}
}
