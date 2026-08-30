#!/usr/bin/env bash
#
# Cross-compile gobbonet for every platform we hand to testers and bundle each
# binary with the web assets it needs.
#
#   ./build-release.sh              build dist/ for all platforms
#   ./build-release.sh --allow-dirty  build anyway with an uncommitted tree
#
# The version is "<RELEASE>-go-<short sha>". A tester's report is only
# actionable if it names a build, and a build is only nameable if the sha
# actually describes the code inside it -- hence the clean-tree check below.

set -euo pipefail

cd "$(dirname "$0")"

# Single source of truth, shared with installer/build-installer.sh. These were
# separate literals once and drifted to 1.3 and 1.4 while the tree carried
# upstream's 1.5.1 frontend -- so a tester's report named a build that did not
# describe what they were running, which is the exact failure the sha stamping
# below exists to prevent.
[ -f VERSION ] || { echo "ERROR: VERSION file is missing" >&2; exit 1; }
RELEASE="$(tr -d '[:space:]' < VERSION)"
[ -n "$RELEASE" ] || { echo "ERROR: VERSION file is empty" >&2; exit 1; }

# Checked here rather than at the copy below so the failure names the cause.
# An archive that silently shipped without it still runs -- it just loses the
# Add a Model modal the moment the machine is offline, which is a bug report
# from a user rather than an error from the build.
[ -f installer/models.ini ] || {
    echo "ERROR: installer/models.ini is missing" >&2
    echo "       Run installer/gen-catalog.py launch.bat installer/models.ini first." >&2
    exit 1
}

GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
    for candidate in "$HOME/Downloads/go/bin/go" /usr/local/go/bin/go; do
        [ -x "$candidate" ] && GO="$candidate" && break
    done
fi
command -v "$GO" >/dev/null 2>&1 || { echo "no go toolchain found; set GO=/path/to/go" >&2; exit 1; }

ALLOW_DIRTY=0
[ "${1:-}" = "--allow-dirty" ] && ALLOW_DIRTY=1

SHA="$(git rev-parse --short HEAD)"

# A dirty tree means the binary contains code the sha does not describe. That is
# worse than useless on a build handed to someone else: they report a bug
# against a commit that does not contain it, and it cannot be reproduced.
if [ -n "$(git status --porcelain)" ]; then
    if [ "$ALLOW_DIRTY" -eq 0 ]; then
        echo "ERROR: working tree has uncommitted changes." >&2
        echo "       A build stamped $RELEASE-go-$SHA would not match what is in it." >&2
        echo "       Commit first, or re-run with --allow-dirty to stamp it -dirty." >&2
        git status --short >&2
        exit 1
    fi
    SHA="$SHA-dirty"
    echo "WARNING: building from a modified tree; stamping $SHA"
fi

VERSION="$RELEASE-go-$SHA"
LDFLAGS="-s -w -X github.com/jmccardle/gobbonet/internal/version.Version=$VERSION"

DIST="dist/$VERSION"
rm -rf "$DIST"
mkdir -p "$DIST"

# The web assets ship with every platform. web/ is generated from the repo-root
# frontend rather than committed -- see stage-web.sh for why -- so assemble it
# fresh here instead of trusting whatever a previous run left behind.
./stage-web.sh

echo "building $VERSION with $($GO version)"
echo

for target in linux/amd64 linux/arm64 windows/amd64 darwin/arm64 darwin/amd64; do
    GOOS="${target%/*}"
    GOARCH="${target#*/}"
    name="gobbonet"
    [ "$GOOS" = "windows" ] && name="gobbonet.exe"

    stage="$DIST/gobbonet-$VERSION-$GOOS-$GOARCH"
    mkdir -p "$stage"
    cp -r web "$stage/web"
    cp GO_SERVER.md "$stage/README.md"

    # The fallback model catalogue. catalog.Discover() looks beside the binary,
    # which is exactly where a portable unzip puts it. Without this the Add a
    # Model modal has nothing to fall back to when the remote catalogue cannot
    # be reached, and answers 503 on an offline machine.
    cp installer/models.ini "$stage/models.ini"

    CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
        "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$stage/$name" ./cmd/gobbonet

    # Archive in the form each platform's users can open without extra tools.
    if [ "$GOOS" = "windows" ]; then
        (cd "$DIST" && zip -qr "$(basename "$stage").zip" "$(basename "$stage")")
        archive="$(basename "$stage").zip"
    else
        (cd "$DIST" && tar czf "$(basename "$stage").tar.gz" "$(basename "$stage")")
        archive="$(basename "$stage").tar.gz"
    fi
    rm -rf "$stage"
    printf '  %-28s %s\n' "$GOOS/$GOARCH" "$(du -h "$DIST/$archive" | cut -f1)"
done

(cd "$DIST" && sha256sum ./*.tar.gz ./*.zip > SHA256SUMS 2>/dev/null || true)

echo
echo "$DIST:"
ls -1 "$DIST"
echo
echo "verify the stamp:  ./dist/$VERSION/... -> gobbonet version"
