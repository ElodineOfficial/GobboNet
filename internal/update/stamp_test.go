package update_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/update"
	"github.com/ElodineOfficial/GobboNet/internal/update/updatetest"
)

// buildStamped builds a tiny program stamped the way the build scripts stamp
// GobboNet: the value of version.Stamp, in the program's data.
func buildStamped(t *testing.T, goos, build, serial string) string {
	t.Helper()
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go toolchain on PATH")
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module stamped\n\ngo 1.21\n"), 0o644)
	// The stamp has to be a variable the program uses, or the linker drops it,
	// as it would version.Stamp if nothing read it.
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nimport \"os\"\n\nvar stamp = \"\"\n\nfunc main() { os.Stdout.WriteString(stamp) }\n"), 0o644)
	out := filepath.Join(dir, "prog-"+goos)
	ld := "-s -w -X github.com/ElodineOfficial/GobboNet/internal/version.Version=" + build
	if serial != "" {
		ld += " -X main.stamp=gobbonet-build[" + build + "/" + serial + "]"
	}
	cmd := exec.Command(gobin, "build", "-trimpath", "-ldflags", ld, "-o", out, ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH=amd64", "CGO_ENABLED=0", "GOFLAGS=-mod=mod", "GOTOOLCHAIN=local")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	return out
}

func TestReadStampFile(t *testing.T) {
	exe := buildStamped(t, "windows", "1.8.1-go-bbbbbbb", "2000")
	s, err := update.ReadStampFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if s.Build != "1.8.1-go-bbbbbbb" || s.Version != "1.8.1" || s.Serial != 2000 || s.GOOS != "windows" || s.GOARCH != "amd64" {
		t.Errorf("stamp = %+v", s)
	}
}

func TestBuildManifestReadsTheProgramsThemselves(t *testing.T) {
	win := buildStamped(t, "windows", "1.8.1-go-bbbbbbb", "2000")
	lin := buildStamped(t, "linux", "1.8.1-go-bbbbbbb", "2000")
	read := func(p string) []byte { b, _ := os.ReadFile(p); return b }
	z := updatetest.Zip(map[string][]byte{"GobboNet/gobbonet.exe": read(win), "GobboNet/linux-amd64/gobbonet": read(lin), "GobboNet/README.md": []byte("hi")})
	zipPath := filepath.Join(t.TempDir(), "GobboNet-1_8_1-update.zip")
	os.WriteFile(zipPath, z, 0o644)

	m, err := update.BuildManifest(update.ManifestInput{Targets: []update.TargetInput{
		{Key: "windows-amd64", Asset: zipPath, Member: "GobboNet/gobbonet.exe"},
		{Key: "linux-amd64", Asset: zipPath, Member: "GobboNet/linux-amd64/gobbonet"},
	}, NotesURL: "https://example.com/notes"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "1.8.1" || m.Build != "1.8.1-go-bbbbbbb" || m.Serial != 2000 {
		t.Errorf("manifest identity = %s %s %d", m.Version, m.Build, m.Serial)
	}
	w := m.Targets["windows-amd64"]
	if w.Asset != "GobboNet-1_8_1-update.zip" || w.SHA256 != updatetest.Sum(z) || w.MemberSHA256 != updatetest.Sum(read(win)) {
		t.Errorf("windows target = %+v", w)
	}
	if _, err := update.EncodeManifest(m); err != nil {
		t.Errorf("the manifest does not encode: %v", err)
	}

	// A member built for the wrong platform is refused.
	if _, err := update.BuildManifest(update.ManifestInput{Targets: []update.TargetInput{
		{Key: "linux-amd64", Asset: zipPath, Member: "GobboNet/gobbonet.exe"},
	}}); err == nil || !strings.Contains(err.Error(), "windows") {
		t.Errorf("a windows program as the linux download: %v", err)
	}

	// Two builds in one release are refused.
	other := buildStamped(t, "linux", "1.8.1-go-ccccccc", "2001")
	z2 := updatetest.Zip(map[string][]byte{"GobboNet/gobbonet.exe": read(win), "GobboNet/linux-amd64/gobbonet": read(other)})
	zip2 := filepath.Join(t.TempDir(), "mixed.zip")
	os.WriteFile(zip2, z2, 0o644)
	if _, err := update.BuildManifest(update.ManifestInput{Targets: []update.TargetInput{
		{Key: "windows-amd64", Asset: zip2, Member: "GobboNet/gobbonet.exe"},
		{Key: "linux-amd64", Asset: zip2, Member: "GobboNet/linux-amd64/gobbonet"},
	}}); err == nil || !strings.Contains(err.Error(), "one commit") {
		t.Errorf("mixed builds: %v", err)
	}

	// An unstamped program is refused.
	dev := buildStamped(t, "linux", "dev", "")
	z3 := updatetest.Zip(map[string][]byte{"g": read(dev)})
	zip3 := filepath.Join(t.TempDir(), "dev.zip")
	os.WriteFile(zip3, z3, 0o644)
	if _, err := update.BuildManifest(update.ManifestInput{Targets: []update.TargetInput{
		{Key: "linux-amd64", Asset: zip3, Member: "g"},
	}}); err == nil {
		t.Error("a dev build was described as a release")
	}
}

// GitHub drops a "+" from the name of a file attached to a release, so the
// update file must not name one with it: the check would find no such
// download (1.8.0). The AppImage used to be built as GobboNet-1.8.0+go...;
// build-appimage.sh now leaves the "+" out, and the manifest refuses it.
func TestBuildManifestRefusesANameGitHubWouldChange(t *testing.T) {
	lin := buildStamped(t, "linux", "1.8.1-go-bbbbbbb", "2000")
	stamp := func(string) update.Stamp {
		return update.Stamp{Build: "1.8.1-go-bbbbbbb", Version: "1.8.1", Serial: 2000, GOOS: "linux", GOARCH: "amd64"}
	}
	dir := t.TempDir()
	for _, c := range []struct {
		name string
		ok   bool
	}{
		{"GobboNet-1.8.1+go.bbbbbbb-1-x86_64.AppImage", false},
		{"GobboNet-1.8.1go.bbbbbbb-1-x86_64.AppImage", true},
		{"GobboNet 1.8.1.AppImage", false},
	} {
		p := filepath.Join(dir, c.name)
		b, _ := os.ReadFile(lin)
		os.WriteFile(p, b, 0o755)
		m, err := update.BuildManifest(update.ManifestInput{
			Targets:     []update.TargetInput{{Key: "appimage-amd64", Asset: p}},
			RunAppImage: func(_ context.Context, file string) (update.Stamp, error) { return stamp(file), nil },
		})
		switch {
		case c.ok && err != nil:
			t.Errorf("%s: refused: %v", c.name, err)
		case c.ok && m.Targets["appimage-amd64"].Asset != c.name:
			t.Errorf("%s: the update file names %q", c.name, m.Targets["appimage-amd64"].Asset)
		case !c.ok && err == nil:
			t.Errorf("%s: accepted, though GitHub would list it under another name", c.name)
		case !c.ok && c.name[len(c.name)-9:] == ".AppImage" && strings.Contains(c.name, "+") &&
			!strings.Contains(err.Error(), strings.ReplaceAll(c.name, "+", "")):
			t.Errorf("%s: the refusal does not say what to rename it to: %v", c.name, err)
		}
	}
}
