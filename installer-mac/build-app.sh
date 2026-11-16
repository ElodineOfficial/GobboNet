#!/usr/bin/env bash
# Build the unsigned GobboNet.app ZIP for macOS.
#
#   bash ./installer-mac/build-app.sh [output-directory]
#   bash ./installer-mac/build-app.sh --allow-dirty [output-directory]

set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say()  { printf '  %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || fail "the Mac app builder must run on macOS"
command -v go >/dev/null 2>&1 || fail "go was not found"
command -v git >/dev/null 2>&1 || fail "git was not found"
command -v ditto >/dev/null 2>&1 || fail "ditto was not found"
command -v plutil >/dev/null 2>&1 || fail "plutil was not found"

ALLOW_DIRTY=0
if [ "${1:-}" = "--allow-dirty" ]; then
    ALLOW_DIRTY=1
    shift
fi
OUT="${1:-dist}"
case "$OUT" in
    "") fail "the output directory is empty" ;;
esac
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"

RELEASE="$(tr -d '[:space:]' < VERSION)"
[ -n "$RELEASE" ] || fail "VERSION is empty"
SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
    [ "$ALLOW_DIRTY" -eq 1 ] || fail "the working tree is dirty; commit it or use --allow-dirty for a private test build"
    SHA="$SHA-dirty"
fi
VERSION="$RELEASE-go-$SHA"
SERIAL="$(git log -1 --format=%ct)"
LDFLAGS="-s -w -X github.com/ElodineOfficial/GobboNet/internal/version.Version=$VERSION -X github.com/ElodineOfficial/GobboNet/internal/version.Stamp=gobbonet-build[$VERSION/$SERIAL]"

case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=amd64 ;;
    *) fail "unsupported Mac architecture: $(uname -m)" ;;
esac

ZIP="$OUT/GobboNet-$VERSION-macOS-$ARCH.zip"
[ ! -e "$ZIP" ] || fail "$ZIP already exists; move it aside before rebuilding"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gobbonet-mac.XXXXXX")"
cleanup() { rm -R "$STAGE"; }
trap cleanup EXIT
ROOT="$STAGE/GobboNet-$VERSION-macOS-$ARCH"
APP="$ROOT/GobboNet.app"
MACOS="$APP/Contents/MacOS"
mkdir -p "$MACOS"

bash ./scripts/go-floor.sh go
bash ./scripts/stage-web.sh
CGO_ENABLED=0 GOOS=darwin GOARCH="$ARCH" go build -trimpath -ldflags "$LDFLAGS" -o "$MACOS/gobbonet-bin" ./cmd/gobbonet
cp installer-mac/GobboNet "$MACOS/GobboNet"
cp engine.sha256 "$MACOS/engine.sha256"
cp catalog/models.ini "$MACOS/models.ini"
cp docs/MAC-START-HERE.md "$ROOT/MAC-START-HERE.md"
chmod 0755 "$MACOS/GobboNet" "$MACOS/gobbonet-bin"
chmod 0644 "$MACOS/engine.sha256" "$MACOS/models.ini" "$ROOT/MAC-START-HERE.md"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>GobboNet</string>
  <key>CFBundleExecutable</key><string>GobboNet</string>
  <key>CFBundleIdentifier</key><string>com.elodine.gobbonet</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>GobboNet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$RELEASE</string>
  <key>CFBundleVersion</key><string>$SERIAL</string>
</dict></plist>
EOF
chmod 0644 "$APP/Contents/Info.plist"

plutil -lint "$APP/Contents/Info.plist" >/dev/null
VERIFY_CONFIG="$STAGE/verify-config"
VERIFY_DATA="$STAGE/verify-data"
mkdir -p "$VERIFY_CONFIG" "$VERIFY_DATA"
XDG_CONFIG_HOME="$VERIFY_CONFIG" XDG_DATA_HOME="$VERIFY_DATA" \
    "$MACOS/gobbonet-bin" version | grep -F "$VERSION" >/dev/null \
    || fail "the binary does not carry the package version"
XDG_CONFIG_HOME="$VERIFY_CONFIG" XDG_DATA_HOME="$VERIFY_DATA" \
    "$MACOS/gobbonet-bin" engine --dir "$STAGE/no-engine" status >/dev/null 2>&1 \
    && fail "engine status found an engine in an empty folder"

ditto -c -k --sequesterRsrc --keepParent "$ROOT" "$ZIP"
unzip -tq "$ZIP" >/dev/null || fail "the ZIP does not pass unzip's integrity check"
unzip -Z1 "$ZIP" | grep -qx "GobboNet-$VERSION-macOS-$ARCH/GobboNet.app/Contents/MacOS/gobbonet-bin" \
    || fail "the ZIP is missing the GobboNet binary"

say "built $(basename "$ZIP")"
say "unsigned and not notarized; see MAC-START-HERE.md"
say "SHA-256: $(shasum -a 256 "$ZIP" | awk '{print $1}')"
