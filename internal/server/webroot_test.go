package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/static"
	"github.com/ElodineOfficial/GobboNet/internal/version"
	"github.com/ElodineOfficial/GobboNet/internal/webui"
)

/*
These pin the fix for "I replaced the files from the zip and nothing changed".

The defect was never in the stand-down feature; it was that the frontend and the
server were two artifacts a user could update separately, and a stale web/ beside
the binary won the search order silently. So what is asserted here is mostly the
absence of a behaviour: no discovery, no shadowing, and an explanation on screen
when a directory that used to matter no longer does.
*/

// A staged test binary is the normal case; a checkout that never ran
// stage-web.sh is also legal and these tests say which one they need.
func requireStaged(t *testing.T) {
	t.Helper()
	if !webui.Staged() {
		t.Skip("built without staged assets; run ./stage-web.sh")
	}
}

func TestBuiltInFrontendIsServedAndIsComplete(t *testing.T) {
	requireStaged(t)

	// chat.html names every module it loads, and a partial embed is a blank
	// page with console errors rather than a build failure — which is exactly
	// the class of silent breakage this whole change is about. So check the
	// embed against what the page actually asks for, not just that it exists.
	built := webui.Built()
	page, err := fs.ReadFile(built, "chat.html")
	if err != nil {
		t.Fatalf("chat.html missing from the embed: %v", err)
	}
	var want []string
	for _, line := range strings.Split(string(page), "\n") {
		for _, pre := range []string{`src="`, `href="`} {
			i := strings.Index(line, pre)
			if i < 0 {
				continue
			}
			rest := line[i+len(pre):]
			j := strings.IndexByte(rest, '"')
			if j < 0 {
				continue
			}
			ref := rest[:j]
			if strings.HasPrefix(ref, "js/") || strings.HasPrefix(ref, "css/") {
				want = append(want, ref)
			}
		}
	}
	if len(want) < 30 {
		t.Fatalf("only found %d module references in chat.html; the scrape is wrong", len(want))
	}
	for _, ref := range want {
		if _, err := fs.Stat(built, ref); err != nil {
			t.Errorf("chat.html loads %s but it is not in the binary: %v", ref, err)
		}
	}
}

func TestEmptyWebRootMeansTheBuiltInCopy(t *testing.T) {
	requireStaged(t)

	src, err := resolveWeb(config.Config{})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	if src.Missing {
		t.Fatal("a staged build reported no frontend")
	}
	if _, err := fs.Stat(src.FS, "chat.html"); err != nil {
		t.Errorf("chat.html not servable: %v", err)
	}
}

// The frontend must exist as ordinary files where the program is unpacked.
// Compiling it in fixed the update story and cost auditability; the binary
// writes it back out and serves it from there, so what is on disk IS what is
// served rather than a decorative copy.
func TestTheFrontendIsWrittenOutAndServedFromDisk(t *testing.T) {
	requireStaged(t)

	exe := t.TempDir()
	src, err := resolveWebIn(config.Config{}, exe, exe)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	web := filepath.Join(exe, "web")

	for _, name := range []string{"chat.html", "js/01-config.js", "css/01-tokens.css"} {
		if _, err := os.Stat(filepath.Join(web, filepath.FromSlash(name))); err != nil {
			t.Errorf("%s was not written to disk: %v", name, err)
		}
	}
	if !strings.Contains(src.Label, web) {
		t.Errorf("label = %q, want it to name the directory being served", src.Label)
	}

	// Editable: a change on disk is what the server hands out.
	mine := "<!-- edited by hand -->"
	if err := os.WriteFile(filepath.Join(web, "chat.html"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	src2, err := resolveWebIn(config.Config{}, exe, exe)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	got, err := fs.ReadFile(src2.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(got) != mine {
		t.Error("an edit to the exported file was not served; the files on disk are not the ones in use")
	}
}

// The bookkeeping stamp must not be reachable over HTTP.
func TestTheExportStampIsNotServable(t *testing.T) {
	requireStaged(t)

	exe := t.TempDir()
	src, err := resolveWebIn(config.Config{}, exe, exe)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	if _, ok := static.Resolve(src.FS, "/.gobbonet-ui"); ok {
		t.Error("the export stamp is servable; dot-named internals must not be")
	}
}

// An install directory the export cannot be written into is normal: Program
// Files, a root-owned /usr/lib/gobbonet, a locked-down share. It must degrade to
// serving from the binary and say so, not refuse to start.
//
// The obstruction is a plain FILE named web, rather than a chmod: root ignores
// permission bits, so a chmod-based test skips on exactly the machines most
// likely to run a packaged install. Nothing can turn a file into a directory.
func TestAnUnwritableInstallStillServes(t *testing.T) {
	requireStaged(t)

	exe := t.TempDir()
	if err := os.WriteFile(filepath.Join(exe, "web"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWebIn(config.Config{}, exe, exe)
	if err != nil {
		t.Fatalf("an unwritable install directory must not be fatal: %v", err)
	}
	if _, err := fs.Stat(src.FS, "chat.html"); err != nil {
		t.Errorf("the page must still be served from the binary: %v", err)
	}
	if len(src.Notes) == 0 {
		t.Error("serving from the binary because the folder is read-only should be said out loud")
	}
}

// The regression itself. Before 1.7.5 this directory won and the user's new
// frontend was never served.
func TestStaleWebDirBesideTheBinaryIsNotServed(t *testing.T) {
	requireStaged(t)

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := "<!-- 1.7.3 -->"
	if err := os.WriteFile(filepath.Join(dir, "web", "chat.html"), []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}

	// dir stands in for the directory holding the binary, which is the whole
	// point: passing it in is what lets this test fail if shadowing comes back.
	src, err := resolveWebIn(config.Config{}, dir, dir)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	page, err := fs.ReadFile(src.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(page) == stale {
		t.Fatal("the stale web/ copy was served — the shadowing bug is back")
	}

	// Stronger than "ignored": the leftover is REPLACED on disk. A directory the
	// binary owns cannot go stale, because a stamp it does not recognise makes
	// it rewrite the tree before serving anything out of it.
	onDisk, err := os.ReadFile(filepath.Join(dir, "web", "chat.html"))
	if err != nil {
		t.Fatalf("the stale file should have been rewritten, not removed: %v", err)
	}
	if string(onDisk) == stale {
		t.Fatal("the stale file is still on disk; an old install would keep serving it")
	}
	if len(src.Notes) == 0 {
		t.Error("replacing someone's web/ should be said out loud")
	}
}

// Case 3: a checkout that never staged assets still runs from disk. This is the
// one path where discovery survives, and it survives only because there is no
// built-in copy for a disk copy to shadow.
func TestUnstagedBuildFallsBackToDisk(t *testing.T) {
	if webui.Staged() {
		t.Skip("this binary has a frontend built in; case 3 cannot be reached")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "chat.html"), []byte("page"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := resolveWebIn(config.Config{}, dir, dir)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	if src.Missing {
		t.Fatal("chat.html was on disk and was not found")
	}
}

func TestNoFrontendAnywhereIsReportedAsMissing(t *testing.T) {
	if webui.Staged() {
		t.Skip("this binary has a frontend built in")
	}
	src, err := resolveWebIn(config.Config{}, t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	if !src.Missing {
		t.Error("a build with no frontend and nothing on disk should report Missing")
	}
}

// config.Load must not fill WebRoot in by discovery. This is the other half of
// the fix: if it did, every install with a leftover web/ would have an explicit
// override pointing at it and the rule above would never get a chance.
func TestLoadDoesNotDiscoverAWebRoot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "web", "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("llm_url = \"http://127.0.0.1:11437\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}

	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.WebRoot != "" {
		t.Errorf("web_root = %q; Load must not discover one, or a leftover web/ "+
			"becomes an explicit override", cfg.WebRoot)
	}
}

func TestWebRootOverrideWinsPerFileAndFallsBack(t *testing.T) {
	requireStaged(t)

	dir := t.TempDir()
	mine := "<!-- my own chat.html -->"
	if err := os.WriteFile(filepath.Join(dir, "chat.html"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWeb(config.Config{WebRoot: dir})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	page, err := fs.ReadFile(src.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(page) != mine {
		t.Error("the override's chat.html did not win")
	}
	// The override holds one file. Everything else must still come from the
	// binary, or a one-file mod is a blank page.
	if _, err := fs.Stat(src.FS, "js/15-cards.js"); err != nil {
		t.Errorf("a file absent from the override did not fall back to the built-in copy: %v", err)
	}
}

func TestWebRootOverrideWithADifferentVersionIsReported(t *testing.T) {
	requireStaged(t)

	if version.Release() == "dev" {
		// An unstamped build legitimately differs from everything, and the
		// check skips it for that reason. Stamp one so the note can be tested.
		old := version.Version
		version.Version = "9.9.9-go-test"
		t.Cleanup(func() { version.Version = old })
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o755); err != nil {
		t.Fatal(err)
	}
	js := "const GOBBONET_UI_VERSION = '1.2.3';\n"
	if err := os.WriteFile(filepath.Join(dir, "js", "01-config.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWeb(config.Config{WebRoot: dir})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	if len(src.Notes) == 0 {
		t.Fatal("a frontend from another release was not reported")
	}
	joined := strings.Join(src.Notes, " ")
	if !strings.Contains(joined, "1.2.3") || !strings.Contains(joined, version.Release()) {
		t.Errorf("the note should name both versions; got %q", joined)
	}
}

func TestWebRootOverrideMatchingThisReleaseIsSilent(t *testing.T) {
	requireStaged(t)

	old := version.Version
	version.Version = "4.5.6-go-test"
	t.Cleanup(func() { version.Version = old })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "chat.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "js"), 0o755); err != nil {
		t.Fatal(err)
	}
	js := "const GOBBONET_UI_VERSION = '4.5.6';\n"
	if err := os.WriteFile(filepath.Join(dir, "js", "01-config.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWeb(config.Config{WebRoot: dir})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	if len(src.Notes) != 0 {
		t.Errorf("an override on this release should say nothing; got %q", src.Notes)
	}
}

// A web_root that does not exist is a refusal; one that exists but holds no
// frontend is a note. The difference matters: the first cannot be what anyone
// meant, while the second is indistinguishable from a working install from the
// outside, because layering hands the user a perfectly normal page while their
// setting does nothing.
func TestWebRootThatDoesNotExistIsRefused(t *testing.T) {
	if _, err := resolveWeb(config.Config{WebRoot: filepath.Join(t.TempDir(), "nope")}); err == nil {
		t.Error("a web_root that does not exist should be refused")
	}
}

func TestWebRootWithNoFrontendInItIsReported(t *testing.T) {
	requireStaged(t)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := resolveWeb(config.Config{WebRoot: dir})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	if len(src.Notes) == 0 {
		t.Fatal("a web_root holding no frontend files was accepted silently")
	}
	if !strings.Contains(strings.Join(src.Notes, " "), dir) {
		t.Error("the note should name the directory")
	}
	// Still serves: the built-in copy answers, so the user gets a working app
	// with a warning rather than a dead server.
	if _, err := fs.Stat(src.FS, "chat.html"); err != nil {
		t.Errorf("the page should still be served from the built-in copy: %v", err)
	}
}

// A single-file override must NOT be treated as a wrong path.
func TestPartialWebRootIsNotReportedAsEmpty(t *testing.T) {
	requireStaged(t)

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "css"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "css", "01-tokens.css"), []byte(":root{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := resolveWeb(config.Config{WebRoot: dir})
	if err != nil {
		t.Fatalf("resolveWeb: %v", err)
	}
	for _, n := range src.Notes {
		if strings.Contains(n, "holds none of") {
			t.Errorf("a css-only override was reported as holding no frontend: %q", n)
		}
	}
}

func TestStampReadsTheFrontendVersion(t *testing.T) {
	requireStaged(t)
	if got := webui.Stamp(webui.Built()); got == "" {
		t.Error("could not read GOBBONET_UI_VERSION out of the embedded frontend")
	}
}

// Every Linux install carries `web_root = <install>/web`, because the launcher
// used to write it on every start. Honouring it would hand those users the old
// frontend forever — the same bug, through the one setting that is meant to be
// a deliberate choice.
func TestLegacyAutoWrittenWebRootIsIgnored(t *testing.T) {
	requireStaged(t)

	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	if err := os.MkdirAll(web, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := "<!-- the 1.7.3 page -->"
	if err := os.WriteFile(filepath.Join(web, "chat.html"), []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWebIn(config.Config{WebRoot: web}, dir, dir)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	page, err := fs.ReadFile(src.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(page) == stale {
		t.Fatal("the launcher's auto-written web_root was honoured; those users would " +
			"never see a new frontend again")
	}
	if len(src.Notes) == 0 || !strings.Contains(strings.Join(src.Notes, " "), "ignoring web_root") {
		t.Errorf("ignoring a setting has to be said out loud; notes = %q", src.Notes)
	}
}

// ...but only that exact path. Somewhere else is a real choice and is obeyed.
func TestADeliberateWebRootElsewhereIsStillObeyed(t *testing.T) {
	requireStaged(t)

	exe := t.TempDir()
	mods := filepath.Join(t.TempDir(), "my-theme")
	if err := os.MkdirAll(mods, 0o755); err != nil {
		t.Fatal(err)
	}
	mine := "<!-- mine -->"
	if err := os.WriteFile(filepath.Join(mods, "chat.html"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWebIn(config.Config{WebRoot: mods}, exe, exe)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	page, err := fs.ReadFile(src.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(page) != mine {
		t.Error("a web_root the user chose was not honoured")
	}
}

// A web/ directory named by web_root but NOT beside the binary is also a real
// choice — the rule is about the path the launcher wrote, not the name "web".
func TestAWebDirectoryElsewhereIsNotMistakenForTheLegacyOne(t *testing.T) {
	requireStaged(t)

	exe := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "web")
	if err := os.MkdirAll(elsewhere, 0o755); err != nil {
		t.Fatal(err)
	}
	mine := "<!-- also mine -->"
	if err := os.WriteFile(filepath.Join(elsewhere, "chat.html"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := resolveWebIn(config.Config{WebRoot: elsewhere}, exe, exe)
	if err != nil {
		t.Fatalf("resolveWebIn: %v", err)
	}
	page, err := fs.ReadFile(src.FS, "chat.html")
	if err != nil {
		t.Fatalf("chat.html: %v", err)
	}
	if string(page) != mine {
		t.Error("a web/ directory outside the install folder was wrongly ignored")
	}
}
