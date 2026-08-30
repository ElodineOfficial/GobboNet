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
	"strings"
)

// Version is the release identity: "<VERSION>-go-<short sha>", e.g.
// "1.5.8-go-afb7e0d". The release half comes from the VERSION file at the repo
// root, which build-release.sh and installer/build-installer.sh both read.
//
// That half names the *upstream* release this branch is built on, not a number
// of our own. TestVersionFileMatchesUpstreamRelease holds it to the nearest
// upstream release tag, because it has now gone stale twice on its own.
//
// Overridden at build time:
//
//	go build -ldflags "-X github.com/jmccardle/gobbonet/internal/version.Version=1.5.8-go-abc1234"
//
// The default says "dev" rather than inventing a number, so an unstamped build
// can never be mistaken for a distributed one.
var Version = "dev"

// String is the version alone.
func String() string { return Version }

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
