package version

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// upstreamTagRe is the release-tag shape upstream uses: v1.5.8, v1.5, v1.0.
var upstreamTagRe = regexp.MustCompile(`^v[0-9]+(\.[0-9]+)*$`)

// The release half of our version must name the upstream release this branch is
// built on.
//
// This is not hypothetical. The literals were separate once and drifted to 1.3
// and 1.4 while the tree carried upstream's 1.5.1 frontend; consolidating them
// into VERSION fixed two literals disagreeing with each other but not VERSION
// disagreeing with upstream, and it went stale again at 1.5.1 while the tree
// carried 1.5.8. Both times the number was wrong everywhere it is reported --
// `gobbonet version`, the startup banner, /health-fileserver -- and nothing
// said so.
//
// The upstream tag is the check rather than the source because it needs a
// repository with tags fetched, which a release build cannot assume. VERSION
// stays the thing the build scripts read; this is what stops it lying.
func TestVersionFileMatchesUpstreamRelease(t *testing.T) {
	declared := versionFile(t)

	tag, err := nearestUpstreamTag()
	if err != nil {
		// An environment fact, not a defect: a shallow clone or an export has
		// no tags to compare against. Say which check did not run rather than
		// passing quietly.
		t.Skipf("cannot identify the upstream release: %v (VERSION says %q, unverified)", err, declared)
	}

	if want := strings.TrimPrefix(tag, "v"); declared != want {
		t.Errorf("VERSION is %q but the nearest upstream release tag is %s.\n"+
			"Every build stamped from this tree reports %s-go-<sha>, which names a\n"+
			"release it is not built from. Set VERSION to %s, or explain the gap here.",
			declared, tag, declared, want)
	}
}

// A build that is not stamped must say "dev" rather than a number, so it cannot
// be mistaken for one that was handed to someone.
func TestUnstampedBuildIsNotANumber(t *testing.T) {
	if Version != "dev" {
		t.Skipf("this build was stamped %q; nothing to check", Version)
	}
	if String() != "dev" {
		t.Errorf("String() = %q, want %q", String(), "dev")
	}
}

// versionFile reads VERSION from the repository root.
func versionFile(t *testing.T) string {
	t.Helper()

	body, err := os.ReadFile("../../VERSION")
	if err != nil {
		t.Fatalf("read VERSION: %v", err)
	}
	declared := strings.TrimSpace(string(body))
	if declared == "" {
		t.Fatal("VERSION is empty; build-release.sh refuses to build from this")
	}
	return declared
}

// nearestUpstreamTag is the newest release tag reachable from HEAD.
//
// --abbrev=0 asks for the tag name alone, and --match keeps our own build tags
// (1.3-go-ea58be5 and friends) out of the answer -- they carry a sha and would
// make this compare a build identity against a release number.
func nearestUpstreamTag() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "describe", "--tags", "--abbrev=0",
		"--match", "v[0-9]*", "HEAD").Output()
	if err != nil {
		return "", err
	}
	tag := strings.TrimSpace(string(out))
	if !upstreamTagRe.MatchString(tag) {
		return "", errNotARelease(tag)
	}
	return tag, nil
}

type errNotARelease string

func (e errNotARelease) Error() string {
	return "nearest tag " + string(e) + " is not a release tag"
}
