package server

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	versionpkg "github.com/ElodineOfficial/GobboNet/internal/version"
	"github.com/ElodineOfficial/GobboNet/internal/webui"
)

/*
Where the frontend comes from.

THE RULE, AND WHY IT IS THIS ORDER

	1. web_root, when the config sets it        -- explicit, layered over (2)
	   ...unless it is <exe dir>/web, which older launchers wrote by themselves
	      and which is therefore not a deliberate choice. See 1a.
	2. the copy built into this binary          -- normal releases
	3. chat.html found on disk beside the exe   -- dev checkout only

What matters is what is NOT in that list: discovery when (2) exists. Until
1.7.5 the server searched <exe dir>/web and then <exe dir> on every start, and
web/ won. That is the bug the whole "why doesn't replacing the files work"
report came down to. A user dropped a new zip over an install, which replaced
chat.html, js/ and css/ at the install root and left the old web/ alone, and
the server kept serving the old frontend without a word. Every server-side
feature of the release looked missing, and the release before it looked fine.

So a stale web/ is no longer consulted at all. It is noted at boot instead,
because a directory that used to be the frontend and is now ignored is worth
one line of explanation rather than silence.

Step 3 survives because stage-web.sh's header promises it: a checkout that has
never staged assets still runs from the repo root. It cannot reintroduce the
bug, since it only applies when the binary has no frontend of its own — there
is nothing for a disk copy to shadow.
*/

// webSource is a resolved frontend plus what to say about it at boot.
type webSource struct {
	FS    fs.FS
	Label string
	// Notes are things the user should know but which are not failures: an
	// ignored directory, a version disagreement in an override.
	Notes []string
	// Missing is "there is no frontend anywhere" — an unstaged build with
	// nothing on disk either.
	//
	// Carried rather than returned as an error on purpose. It is only fatal for
	// serving, and New is also how a test harness and the CLI get a Server; a
	// hard failure here would stop `gobbonet check` working on a machine whose
	// assets are somewhere unusual, which is the same reasoning the old
	// auto-detection used. cmd/gobbonet raises it where it is real.
	Missing bool
}

// resolveWeb picks the frontend for a config. The error case is a build with no
// embedded frontend and nothing on disk either, which is a broken install
// rather than a misconfiguration.
func resolveWeb(cfg config.Config) (webSource, error) {
	return resolveWebIn(cfg, exeDir(), workDir())
}

// resolveWebIn is resolveWeb with the two directories it would otherwise read
// from the process passed in instead.
//
// They are parameters because the rule being enforced is about those exact
// directories — "a web/ beside the binary must not be served" — and a test that
// cannot choose them cannot exercise the rule. The first attempt at these tests
// passed with the old shadowing behaviour deliberately restored, because
// os.Executable() inside a test binary points at a build directory in /tmp and
// the stale web/ the test had just created was never anywhere near it. A test
// that cannot fail is worse than no test: it reports that the bug is fixed.
func resolveWebIn(cfg config.Config, exe, work string) (webSource, error) {
	// 1a. A web_root that older launchers wrote by themselves is not a choice,
	// and must not be honoured as one.
	//
	// installer-linux/gobbonet-launch used to run `config set web_root
	// $PREFIX/web` on every launch where the key was empty, because back then
	// the frontend was a directory beside the binary and the server had to be
	// pointed at it. Every Linux install therefore carries that line. Left
	// alone, it would pin those users to the old on-disk frontend forever --
	// the exact bug this release removes, arriving through the one setting that
	// is supposed to be deliberate.
	//
	// The launcher clears it now, but not everything launches through the
	// launcher (a systemd unit running `gobbonet serve`, say), so the server
	// recognises it too. Narrowly: only the precise path the launcher wrote,
	// <exe dir>/web. A modder's directory anywhere else is their business.
	if cfg.WebRoot != "" && exe != "" &&
		filepath.Clean(cfg.WebRoot) == filepath.Join(exe, "web") {
		src := webSource{FS: webui.Built(), Label: "built into this program"}
		src.Notes = append(src.Notes, fmt.Sprintf(
			"ignoring web_root = %s. Older versions of the launcher wrote that line "+
				"automatically, when the chat page was a folder next to the program. It now "+
				"ships inside the program itself, and honouring an old line would serve you "+
				"the previous version's page forever. Delete the line from your config to "+
				"silence this. If you did mean to run your own edited copy, move it to a "+
				"different folder and point web_root there.", cfg.WebRoot))
		return src, nil
	}

	// 1. An explicit override.
	if cfg.WebRoot != "" {
		over, err := webui.Overlay(cfg.WebRoot)
		if err != nil {
			return webSource{}, fmt.Errorf("web_root %s: %w", cfg.WebRoot, err)
		}
		src := webSource{
			FS:    over,
			Label: cfg.WebRoot + " (web_root override; missing files come from the built-in copy)",
		}
		// An override does NOT have to hold a whole frontend — layering over the
		// built-in copy is the point, so a one-file mod is a supported thing to
		// have. But a directory with nothing the frontend uses in it is almost
		// always a wrong path, and because of that same layering the page would
		// look perfectly normal while the setting did nothing at all. Said, not
		// refused: a mod setting should never be the reason a server won't boot.
		if !holdsFrontendFiles(cfg.WebRoot) {
			src.Notes = append(src.Notes, fmt.Sprintf(
				"web_root points at %s, which holds none of the chat interface's files "+
					"(no chat.html, js/ or css/). Nothing is being overridden and the page "+
					"you get is the one built into this program. Check the path.",
				cfg.WebRoot))
		}
		// An override is the one arrangement that can still put a frontend and
		// a server out of step, so it is the one arrangement that gets checked.
		if stamp := webui.Stamp(over); stamp != "" && versionpkg.Release() != "" &&
			stamp != versionpkg.Release() && versionpkg.Release() != "dev" {
			src.Notes = append(src.Notes, fmt.Sprintf(
				"web_root holds a %s frontend but this server is %s. That override is "+
					"now the page you get, so anything added on either side since may be "+
					"missing. Remove web_root from the config to use the copy built into "+
					"this program.", stamp, versionpkg.Release()))
		}
		return src, nil
	}

	// 2. The copy inside the binary, written out beside it and served from
	// there: what every release does.
	//
	// The binary owns that directory. It stamps it with its own version and
	// rewrites the whole tree whenever the stamp does not match, so a leftover
	// from an older install is REPLACED rather than trusted -- which is the
	// precise inversion of the bug this replaced, where a found directory won.
	//
	// Why write it at all: an install that does not contain the interface it is
	// serving cannot be read, edited or audited. See webui.Export.
	if webui.Staged() {
		return builtInSource(exe), nil
	}

	// 3. A checkout that never ran stage-web.sh.
	dir := discoverWebDir(exe, work)
	if dir == "" {
		return webSource{
			FS:      webui.Built(),
			Label:   "none found",
			Missing: true,
		}, nil
	}
	over, err := webui.Overlay(dir)
	if err != nil {
		return webSource{}, fmt.Errorf("web root %s: %w", dir, err)
	}
	return webSource{
		FS:    over,
		Label: dir + " (unstaged build; run ./stage-web.sh to build the frontend in)",
	}, nil
}

// holdsFrontendFiles reports whether a directory contains anything the frontend
// is made of. Deliberately generous: any one of these is enough, because a
// partial override is legitimate and only an entirely unrelated directory is
// worth remarking on.
func holdsFrontendFiles(dir string) bool {
	for _, name := range []string{"chat.html", "js", "css", "default-characters.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// exeDir and workDir are the two directories resolveWeb would look in, isolated
// so resolveWebIn can be handed different ones by a test. Both return "" on
// failure, which every caller treats as "nothing there".
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

func workDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return wd
}

// builtInSource exports the frontend beside the binary and serves it from
// there, falling back to serving straight out of the binary when the directory
// cannot be written -- a root-owned /usr/lib/gobbonet or Program Files, which is
// normal and must not stop the server.
func builtInSource(exe string) webSource {
	// The tree records the BUILD that wrote it, as Export's doc says, not only
	// the release number: a release has several builds, and one that finds a
	// tree written by another build must replace it or an update never reaches
	// the page. Release() here let every 1.7.5 build keep serving whichever
	// 1.7.5 interface was written first.
	version := versionpkg.Version
	if exe == "" {
		return webSource{FS: webui.Built(), Label: "built into this program"}
	}
	dir := filepath.Join(exe, "web")

	if webui.NeedsExport(dir, version) {
		previous := webui.ExportedVersion(dir)
		n, err := webui.Export(dir, version)
		if err != nil {
			return webSource{
				FS:    webui.Built(),
				Label: "built into this program",
				Notes: []string{fmt.Sprintf(
					"could not write the interface to %s (%v), so it is being served "+
						"straight out of the program file. Everything works; the files "+
						"are just not on disk to read. This is normal for an install in a "+
						"system folder.", dir, err)},
			}
		}
		src := diskSource(dir, version, exe)
		switch {
		case previous == "":
			src.Notes = append(src.Notes, fmt.Sprintf(
				"wrote the chat interface to %s (%d files) so you can read and edit it. "+
					"Edits show up on reload.", dir, n))
		default:
			// A version change replaces the tree, which is how an update reaches
			// the interface -- and it is also how someone's edits disappear, so
			// it is said out loud rather than done quietly.
			src.Notes = append(src.Notes, fmt.Sprintf(
				"refreshed %s from %s to %s (%d files). Any edits you made there have "+
					"been replaced -- that is how an update reaches the interface. To "+
					"keep edits across updates, copy them elsewhere and set web_root to "+
					"that folder.", dir, previous, version, n))
		}
		return src
	}
	return diskSource(dir, version, exe)
}

// diskSource serves an exported tree, layered over the binary so a file someone
// deletes still resolves instead of 404ing.
func diskSource(dir, version, exe string) webSource {
	over, err := webui.Overlay(dir)
	if err != nil {
		return webSource{
			FS:    webui.Built(),
			Label: "built into this program",
			Notes: []string{fmt.Sprintf("could not open %s (%v); serving from the program file.", dir, err)},
		}
	}
	return webSource{FS: over, Label: dir + " (written by this program; edit and reload)"}
}

// strayWebDirBeside finds a web/ directory left behind in dir by an install that
// predates the embedded frontend. Reported, never served.
func strayWebDirBeside(dir string) (string, bool) {
	if dir == "" {
		return "", false
	}
	web := filepath.Join(dir, "web")
	if _, err := os.Stat(filepath.Join(web, "chat.html")); err == nil {
		return web, true
	}
	return "", false
}

// discoverWebDir is the old detectWebRoot, kept for case 3 only.
func discoverWebDir(exe, work string) string {
	var candidates []string
	for _, d := range []string{exe, work} {
		if d != "" {
			candidates = append(candidates, filepath.Join(d, "web"), d)
		}
	}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, "chat.html")); err == nil {
			return c
		}
	}
	return ""
}

// WebSource describes the frontend in one line, for the startup banner.
func (s *Server) WebSource() string { return s.webSrc.Label }

// WebNotes are the non-fatal things worth printing under it.
func (s *Server) WebNotes() []string { return s.webSrc.Notes }

// WebMissing reports that there is no frontend to serve. Fatal for `serve`,
// irrelevant to everything else — see webSource.Missing.
func (s *Server) WebMissing() bool { return s.webSrc.Missing }

// ErrNoWebAssets is what `serve` reports when WebMissing is true. Phrased for
// whoever is looking at it: a user sees this only if a release was built wrong,
// so it says that plainly instead of asking them to go hunting.
var ErrNoWebAssets = errors.New(
	"this build has no chat interface in it, and none was found on disk.\n" +
		"    A release build should never say this — it means the build skipped\n" +
		"    stage-web.sh. Run ./stage-web.sh and rebuild, or point web_root at a\n" +
		"    directory that holds chat.html.")
