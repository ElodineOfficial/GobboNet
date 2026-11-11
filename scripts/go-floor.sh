#!/usr/bin/env bash
# The oldest Go a release may be built with.  bash scripts/go-floor.sh <go command>
#
# Go's patch releases are mostly security fixes, many in net/http and crypto,
# which the server uses directly. 1.7.8 was built with go1.25.14. The first 1.7.9
# builds used go1.25.0, the toolchain the build machine happened to have, and
# nothing said so: 1.7.9 would have shipped fourteen patch releases behind the
# release before it (CHANGELOG-1.7.9-fedora-installer.md).
#
# Raise GO_FLOOR when a release is built with a newer Go; never lower it. A
# newer minor line (go1.26, go1.27) passes.
set -euo pipefail
GO_FLOOR="go1.25.14"

GO="${1:-go}"
have="$("$GO" env GOVERSION 2>/dev/null || true)"
[ -n "$have" ] || { echo "ERROR: could not ask $GO for its version" >&2; exit 1; }
have="${have%% *}"            # go1.25.14, or go1.27.0 X:... from a dev build

# Compare go1.A.B with go1.C.D numerically; a release candidate (go1.26rc1)
# counts as the release before it.
ver() { local v="${1#go}"; v="${v%%[!0-9.]*}"; IFS=. read -r a b c <<<"$v"; printf '%d %d %d' "${a:-0}" "${b:-0}" "${c:-0}"; }
read -r ha hb hc <<<"$(ver "$have")"
read -r fa fb fc <<<"$(ver "$GO_FLOOR")"
if (( ha < fa || (ha == fa && (hb < fb || (hb == fb && hc < fc))) )); then
    echo "ERROR: $have is older than $GO_FLOOR, the Go the last release was built with." >&2
    echo "       Its missing patch releases are mostly security fixes. Install $GO_FLOOR" >&2
    echo "       or newer (go.dev/dl, or build it from github.com/golang/go at that tag)," >&2
    echo "       or set GO=/path/to/that/go." >&2
    exit 1
fi
echo "  go:       $have (floor $GO_FLOOR)"
