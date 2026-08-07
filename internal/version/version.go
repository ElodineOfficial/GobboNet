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

// Version is the release identity, e.g. "1.3-go-cba7af9".
//
// Overridden at build time:
//
//	go build -ldflags "-X github.com/jmccardle/gobbonet/internal/version.Version=1.3-go-abc1234"
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
