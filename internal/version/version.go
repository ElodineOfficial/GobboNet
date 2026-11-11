// Package version carries the build identity stamped in at link time.
//
// A tester's bug report is only actionable if it says which build produced it,
// so the version is reported in three places: `gobbonet version`, the startup
// banner, and /health-fileserver (which is the one a tester can copy out of a
// browser without a terminal).
package version

import (
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

// Version is the release identity: "<VERSION>-go-<short sha>", e.g.
// "1.5.8-go-afb7e0d". The release half comes from the VERSION file at the repo
// root, which build-release.sh and the package builders read.
//
// That half names the *upstream* release this branch is built on, not a number
// of our own. TestVersionFileMatchesUpstreamRelease holds it to the nearest
// upstream release tag, because it has now gone stale twice on its own.
//
// Overridden at build time:
//
//	go build -ldflags "-X github.com/ElodineOfficial/GobboNet/internal/version.Version=1.5.8-go-abc1234"
//
// The default says "dev" rather than inventing a number, so an unstamped build
// can never be mistaken for a distributed one.
var Version = "dev"

// Stamp carries the build's serial: when the commit it was made from was
// committed, in Unix seconds (`git log -1 --format=%ct`). The build scripts
// set it beside Version (1.8.0, the update button), as
//
//	gobbonet-build[1.8.0-go-abc1234/1793932190]
//
// The serial is what tells two builds of the same release apart in order. A
// hotfix re-published as 1.8.0 carries the same release number as the build
// it fixes, and a short sha does not sort, so the updater (internal/update)
// offers a build of the same release only when its serial is later than this
// one -- never an earlier one, which is the "never go backwards" rule.
//
// The bracketed form, with the build in it, is so that the serial can be read
// out of a program file without running it: `gobbonet update manifest`
// describes a Windows program on Linux that way. The toolchain does not
// record -ldflags in a -trimpath build, so the value has to be findable in
// the file itself.
//
// Empty in an unstamped build; SerialNumber then falls back to the commit time
// the Go toolchain recorded, and to 0 when there is none.
var Stamp = ""

// StampPrefix opens Stamp's value.
const StampPrefix = "gobbonet-build["

// String is the version alone.
func String() string { return Version }

// SerialNumber is the serial in Stamp, when Stamp is about this build; else
// the vcs.time the toolchain embedded; else 0.
func SerialNumber() int64 {
	if build, n, ok := ParseStamp(Stamp); ok && build == Version {
		return n
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return 0
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.time" {
			if t, err := time.Parse(time.RFC3339, setting.Value); err == nil {
				return t.Unix()
			}
		}
	}
	return 0
}

// ParseStamp reads a Stamp value: the build it names and its serial.
func ParseStamp(s string) (build string, serial int64, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(s), StampPrefix)
	if !found || !strings.HasSuffix(rest, "]") {
		return "", 0, false
	}
	rest = strings.TrimSuffix(rest, "]")
	i := strings.LastIndexByte(rest, '/')
	if i <= 0 {
		return "", 0, false
	}
	n, err := strconv.ParseInt(rest[i+1:], 10, 64)
	if err != nil || n <= 0 {
		return "", 0, false
	}
	return rest[:i], n, true
}

// Release is the release half of the version, without the "-go-<sha>" build
// suffix: "1.7.5" out of "1.7.5-go-afb7e0d".
//
// It exists to be compared with the frontend's own stamp (GOBBONET_UI_VERSION
// in js/01-config.js), which carries the release and nothing else. The
// comparison only matters when web_root points at a frontend on disk — the
// built-in copy cannot disagree with the binary holding it — but that is the
// case where the two used to drift silently, so it is worth a check.
//
// The frontend does the same split in _releaseOf(); if one changes, so must the
// other.
func Release() string {
	if i := strings.Index(Version, "-go-"); i > 0 {
		return Version[:i]
	}
	return Version
}

// Full adds the toolchain and platform — the things that differ between the
// binaries handed to different testers, and the first things to check when one
// of them behaves differently from the rest.
func Full() string {
	var b strings.Builder
	b.WriteString(Version)
	b.WriteString(" (")
	b.WriteString(runtime.Version())
	b.WriteString(" ")
	b.WriteString(runtime.GOOS)
	b.WriteString("/")
	b.WriteString(runtime.GOARCH)
	if vcs := vcsRevision(); vcs != "" {
		b.WriteString(" vcs:")
		b.WriteString(vcs)
	}
	b.WriteString(")")
	return b.String()
}

// vcsRevision reads the revision the Go toolchain embedded on its own.
//
// This is a cross-check, not the source of truth: it is stamped from the real
// repository state at build time, so a mismatch with Version means the ldflags
// value was wrong or stale. It also records whether the tree was modified, which
// is exactly what a "works on my machine" build looks like.
func vcsRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	var revision, modified string
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			modified = setting.Value
		}
	}
	if revision == "" {
		return ""
	}
	if len(revision) > 7 {
		revision = revision[:7]
	}
	if modified == "true" {
		revision += "-dirty"
	}
	return revision
}
