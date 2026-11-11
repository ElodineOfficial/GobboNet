// Package update finds a newer GobboNet on GitHub and installs it (1.8.0):
// the CHECK FOR UPDATES and UPDATE NOW buttons in ABOUT.
//
// WHAT IT TRUSTS. A release is only ever installed from a signed update file,
// gobbonet-update.json, attached to a GitHub release beside its
// signature, gobbonet-update.json.sig. The signature is ed25519 and the public
// keys that may make one are built into this program (trusted-keys.txt). The
// update file names the archive to fetch and pins its SHA-256 and size, and the
// SHA-256 and size of the program file inside it; nothing that fails any of
// those checks is kept. So getting a program onto someone's PC through this
// takes the maintainer's private key, not just the GitHub account: an upload
// to the releases page by anyone else is refused, and so is a file changed on
// the way.
//
// NEVER BACKWARDS. A build may only be replaced by one with a later release
// number, or by a later build of the same release (a hotfix: same number, a
// later commit). "Later" for the second is the commit time stamped into each
// build (version.Serial), because the short sha in "1.8.0-go-abc1234" does not
// sort. An older release is never offered, whatever its date, and neither is
// the build already running.
//
// NOTHING HAPPENS ON ITS OWN. The release list is asked for only when someone
// presses CHECK FOR UPDATES, as a plain GET that carries nothing about the
// install -- the version comparison happens here, not on GitHub's side.
package update

import (
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// Build identifies one build: its release number, its full stamp, and its
// serial (version.Serial).
type Build struct {
	// Version is the release number alone: "1.8.0".
	Version string `json:"version"`
	// Build is the full stamp: "1.8.0-go-abc1234".
	Build string `json:"build"`
	// Serial is the build's commit time in Unix seconds; 0 when unknown.
	Serial int64 `json:"serial"`
}

// Current is the build that is running.
func Current() Build {
	return Build{Version: version.Release(), Build: version.String(), Serial: version.SerialNumber()}
}

// maxBaseParts bounds a release number. Ours have three parts; four leaves
// room, and a bound stops a hostile string being a long number of zeros.
const maxBaseParts = 4

// ParseBase reads a release number such as "1.8.0" or "v1.8.0". Every part
// must be a plain number. A suffix after a dash or a plus ("1.7.6-Hotfix",
// "1.8.0-go-abc1234") is ignored, so a tag and a build stamp both parse to the
// release they name.
func ParseBase(s string) ([]int, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "V")
	if i := strings.IndexAny(s, "-+ "); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return nil, false
	}
	parts := strings.Split(s, ".")
	if len(parts) > maxBaseParts {
		return nil, false
	}
	out := make([]int, len(parts))
	for i, p := range parts {
		if p == "" || len(p) > 6 {
			return nil, false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return nil, false
			}
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// CompareBase orders two release numbers: -1, 0 or 1. Missing parts count as
// zero, so 1.8 and 1.8.0 are the same release.
func CompareBase(a, b []int) int {
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		switch {
		case x < y:
			return -1
		case x > y:
			return 1
		}
	}
	return 0
}

// Updatable reports whether a build can be compared with a release at all. An
// unstamped "dev" build cannot: it has no release number, and replacing a
// developer's own build with a download is never what they meant.
func (b Build) Updatable() bool {
	if b.Build == "" || b.Build == "dev" {
		return false
	}
	_, ok := ParseBase(b.Version)
	return ok
}

// Newer is the rule the request for this feature set: cand may replace cur
// only if it is a later release, or the same release built from a later
// commit. Never an older release, never the same build again.
func Newer(cur, cand Build) bool {
	cb, ok := ParseBase(cur.Version)
	if !ok || !cur.Updatable() {
		return false
	}
	nb, ok := ParseBase(cand.Version)
	if !ok || cand.Build == "" {
		return false
	}
	switch CompareBase(nb, cb) {
	case 1:
		return true
	case -1:
		return false
	}
	// The same release: only a hotfix, which is a later commit. A serial of 0
	// is "unknown" and is never later than anything.
	return cand.Serial > 0 && cand.Serial > cur.Serial && cand.Build != cur.Build
}

// Better orders two candidates: the later release, then the later serial.
func Better(a, b Build) bool {
	ab, _ := ParseBase(a.Version)
	bb, _ := ParseBase(b.Version)
	if c := CompareBase(ab, bb); c != 0 {
		return c > 0
	}
	return a.Serial > b.Serial
}

// Hotfix reports whether cand is a later build of cur's own release.
func Hotfix(cur, cand Build) bool {
	cb, ok1 := ParseBase(cur.Version)
	nb, ok2 := ParseBase(cand.Version)
	return ok1 && ok2 && CompareBase(cb, nb) == 0
}
