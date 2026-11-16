package engine

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

/*
The engine downloader launch.bat had and this program did not.

The hash policy is the thing to hold: a mismatch must be fatal and must leave
nothing behind, because an unverifiable engine is precisely the one a user would
then run. launch.bat refused; so does this.

Everything here serves the archive from a local httptest server. A test that
reaches GitHub is a test that fails on a train.
*/

// fakeArchive builds a zip shaped like upstream's: everything under build/bin/.
func fakeArchive(t *testing.T) []byte {
	t.Helper()
	if runtime.GOOS == "darwin" {
		return fakeTarArchive(t)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	name := "llama-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	for path, body := range map[string]string{
		"build/bin/" + name:      "#!/bin/sh\necho llama\n",
		"build/bin/libggml.so":   "ELF",
		"build/bin/LICENSE":      "MIT",
		"build/bin/ggml-base.so": "ELF",
	} {
		w, err := zw.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func fakeTarArchive(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	files := map[string]string{
		"llama-b10456/llama-server":         "#!/bin/sh\necho llama\n",
		"llama-b10456/libggml.0.20.0.dylib": "Mach-O",
		"llama-b10456/LICENSE":              "MIT",
	}
	for name, body := range files {
		mode := int64(0o644)
		if strings.HasSuffix(name, "llama-server") || strings.HasSuffix(name, ".dylib") {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.WriteHeader(&tar.Header{
		Name: "llama-b10456/libggml.0.dylib", Linkname: "libggml.0.20.0.dylib",
		Mode: 0o777, Typeflag: tar.TypeSymlink,
	}); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{
		Name: "llama-b10456/libggml.dylib", Linkname: "libggml.0.dylib",
		Mode: 0o777, Typeflag: tar.TypeSymlink,
	}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func serve(t *testing.T, body []byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	old := releaseBase
	releaseBase = srv.URL
	t.Cleanup(func() { releaseBase = old })
	return srv.URL
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func writePin(t *testing.T, dir, body string) string {
	t.Helper()
	p := filepath.Join(dir, "engine.sha256")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func pinFor(t *testing.T, dir string, archive []byte) Pin {
	t.Helper()
	s := sum(archive)
	// Every hash key, so the pin parses on whichever platform the test runs on.
	writePin(t, dir, "LLAMA_BUILD=b10456\nGPU_SHA256="+s+"\nWIN_GPU_SHA256="+s+
		"\nDARWIN_ARM64_SHA256="+s+"\nDARWIN_AMD64_SHA256="+s+"\nCPU_SHA256="+s+"\n")
	pin, err := ParsePin(filepath.Join(dir, "engine.sha256"))
	if err != nil {
		t.Fatalf("ParsePin: %v", err)
	}
	return pin
}

func TestParsePinReadsTheSharedFile(t *testing.T) {
	dir := t.TempDir()
	writePin(t, dir, `# a comment
LLAMA_BUILD=b10456
GPU_SHA256=AABBCC
WIN_GPU_SHA256=DDEEFF
DARWIN_ARM64_SHA256=112233
DARWIN_AMD64_SHA256=445566
`)
	pin, err := ParsePin(filepath.Join(dir, "engine.sha256"))
	if err != nil {
		t.Fatalf("ParsePin: %v", err)
	}
	if pin.Build != "b10456" {
		t.Errorf("build = %q", pin.Build)
	}
	if !strings.Contains(pin.Asset, "b10456") {
		t.Errorf("asset %q does not name the build", pin.Asset)
	}
	// Lower-cased, because the comparison later is against a hex digest.
	if pin.SHA256 != strings.ToLower(pin.SHA256) {
		t.Errorf("hash not normalised: %q", pin.SHA256)
	}
	if !strings.HasPrefix(pin.URL, releaseBase) {
		t.Errorf("url %q is not on the release base", pin.URL)
	}
}

// A pin with no hash for this platform must refuse, not download something it
// cannot check. That refusal is the whole reason the file exists.
func TestParsePinRefusesWithoutAHashForThisPlatform(t *testing.T) {
	dir := t.TempDir()
	writePin(t, dir, "LLAMA_BUILD=b10456\n")
	if _, err := ParsePin(filepath.Join(dir, "engine.sha256")); err == nil {
		t.Error("a pin with no checksum was accepted")
	}
}

func TestParsePinRefusesWithoutABuild(t *testing.T) {
	dir := t.TempDir()
	writePin(t, dir, "GPU_SHA256=abc\nWIN_GPU_SHA256=abc\n")
	if _, err := ParsePin(filepath.Join(dir, "engine.sha256")); err == nil {
		t.Error("a pin with no LLAMA_BUILD was accepted")
	}
}

func TestInstallVerifiesAndFlattens(t *testing.T) {
	archive := fakeArchive(t)
	serve(t, archive)
	pinDir := t.TempDir()
	pin := pinFor(t, pinDir, archive)

	dest := filepath.Join(t.TempDir(), "llama-cpp")
	exe, err := Install(pin, dest, nil)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}

	// Flattened out of build/bin/, which is where every server_exe points.
	if filepath.Dir(exe) != dest {
		t.Errorf("llama-server landed at %s, want directly in %s", exe, dest)
	}
	wantFiles := []string{"libggml.so", "LICENSE"}
	if runtime.GOOS == "darwin" {
		wantFiles = []string{"libggml.0.20.0.dylib", "libggml.0.dylib", "libggml.dylib", "LICENSE"}
	}
	for _, name := range wantFiles {
		if _, err := os.Stat(filepath.Join(dest, name)); err != nil {
			t.Errorf("%s was not extracted: %v", name, err)
		}
	}
	if runtime.GOOS == "darwin" {
		got, err := os.Readlink(filepath.Join(dest, "libggml.dylib"))
		if err != nil || got != "libggml.0.dylib" {
			t.Errorf("dylib symlink = %q, %v", got, err)
		}
	}
	// The archive is a build artifact, not something to leave lying around.
	if _, err := os.Stat(filepath.Join(dest, pin.Asset)); err == nil {
		t.Error("the downloaded archive was left behind")
	}
	// Which build this is, recorded, or it is anonymous once installed.
	note, err := os.ReadFile(filepath.Join(dest, "ENGINE.txt"))
	if err != nil {
		t.Fatalf("ENGINE.txt missing: %v", err)
	}
	if !strings.Contains(string(note), pin.Build) {
		t.Error("ENGINE.txt does not name the build")
	}
}

// The policy that matters most.
func TestInstallRefusesATamperedDownload(t *testing.T) {
	archive := fakeArchive(t)
	serve(t, archive)
	pinDir := t.TempDir()
	pin := pinFor(t, pinDir, archive)
	// The pin now describes something other than what the server will send.
	pin.SHA256 = sum([]byte("a different archive entirely"))

	dest := filepath.Join(t.TempDir(), "llama-cpp")
	_, err := Install(pin, dest, nil)
	if err == nil {
		t.Fatal("a download that did not match the pin was accepted")
	}
	if !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Errorf("the error should name the mismatch: %v", err)
	}
	// Nothing installed, and no half-downloaded file left to be picked up by a
	// later run that might trust it.
	if Installed(dest) != "" {
		t.Error("an engine was installed from an archive that failed its checksum")
	}
	entries, _ := os.ReadDir(dest)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".part") {
			t.Errorf("a partial download was left behind: %s", e.Name())
		}
	}
}

func TestInstallReportsAnHTTPFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	old := releaseBase
	releaseBase = srv.URL
	t.Cleanup(func() { releaseBase = old })

	pin := Pin{Build: "b1", Asset: "a.zip", SHA256: "00", URL: srv.URL + "/a.zip"}
	dest := filepath.Join(t.TempDir(), "llama-cpp")
	if _, err := Install(pin, dest, nil); err == nil {
		t.Error("a 404 was treated as a successful download")
	}
}

func TestInstalledFindsOnlyARealFile(t *testing.T) {
	dir := t.TempDir()
	if Installed(dir) != "" {
		t.Error("reported an engine in an empty directory")
	}
	name := "llama-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	// A directory of that name is not an engine.
	if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
		t.Fatal(err)
	}
	if Installed(dir) != "" {
		t.Error("a directory was mistaken for the engine binary")
	}
}

// An entry named ../../x must not escape the destination, even though the
// archive's hash was checked first: the name is still data from a file fetched
// over the network.
func TestUnzipRefusesToEscapeTheDestination(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("../escaped.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("nope"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	parent := t.TempDir()
	dest := filepath.Join(parent, "llama-cpp")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(parent, "evil.zip")
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := unzip(archive, dest); err != nil {
		t.Fatalf("unzip: %v", err)
	}
	if _, err := os.Stat(filepath.Join(parent, "escaped.txt")); err == nil {
		t.Fatal("a zip entry wrote outside the destination directory")
	}
}

func TestDiscoverPinLooksBesideTheProgramThenTheWorkingDirectory(t *testing.T) {
	exe, wd := t.TempDir(), t.TempDir()
	if _, err := DiscoverPin(exe, wd); err == nil {
		t.Error("found a pin where there is none")
	}
	writePin(t, wd, "LLAMA_BUILD=b1\nGPU_SHA256=aa\nWIN_GPU_SHA256=aa\nDARWIN_ARM64_SHA256=aa\nDARWIN_AMD64_SHA256=aa\n")
	pin, err := DiscoverPin(exe, wd)
	if err != nil {
		t.Fatalf("DiscoverPin: %v", err)
	}
	if pin.Build != "b1" {
		t.Errorf("build = %q", pin.Build)
	}
}

func TestUntarGzipRefusesUnsafeSymlinks(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{
		Name: "build/libbad.dylib", Linkname: "../outside", Mode: 0o777, Typeflag: tar.TypeSymlink,
	}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "bad.tar.gz")
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := untarGzip(archive, t.TempDir()); err == nil || !strings.Contains(err.Error(), "unsafe symlink") {
		t.Fatalf("unsafe symlink error = %v", err)
	}
}

func TestUntarGzipRefusesUnsafeMemberPaths(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("outside")
	if err := tw.WriteHeader(&tar.Header{Name: "../outside", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "bad-path.tar.gz")
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := untarGzip(archive, t.TempDir()); err == nil || !strings.Contains(err.Error(), "unsafe path") {
		t.Fatalf("unsafe path error = %v", err)
	}
}

// The shipped pin must parse on the platforms the project builds for. This is
// the one test that reads the real file, because a pin that this code cannot
// read is a downloader that cannot run.
func TestTheShippedPinParses(t *testing.T) {
	pin, err := ParsePin(filepath.Join("..", "..", "engine.sha256"))
	if err != nil {
		t.Fatalf("the repo's own engine.sha256 does not parse: %v", err)
	}
	if pin.Build == "" || pin.SHA256 == "" {
		t.Errorf("incomplete pin: %+v", pin)
	}
	if len(pin.SHA256) != 64 {
		t.Errorf("hash is not a sha256 digest: %q", pin.SHA256)
	}
}
