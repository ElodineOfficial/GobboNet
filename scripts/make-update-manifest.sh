#!/usr/bin/env bash
#
# Make the two files a GitHub release needs for ABOUT > UPDATE NOW (1.8.0):
#
#   dist/gobbonet-update.json       which build this is, and the SHA-256 of
#                                   each download and of the program in it
#   dist/gobbonet-update.json.sig   its ed25519 signature
#
#   bash ./scripts/make-update-manifest.sh --key PATH
#        [--zip dist/GobboNet-1_8_0-update.zip]
#        [--appimage installer-linux/dist/GobboNet-<version>-x86_64.AppImage]
#        [--notes "one or two sentences"] [--notes-file FILE] [--notes-url URL]
#
# Run it after scripts/make-zip.sh, from the same commit, with the private key
# `gobbonet update keygen` made. docs/UPDATES.md has the whole procedure.
#
# The version, build and serial in the update file are read out of the
# programs inside the ZIP, not typed in, so the file cannot describe a build
# other than the one it points at. Every program must carry the same stamp;
# a ZIP assembled from two builds is refused.
#
# Then attach to the GitHub release, beside each other: the ZIP (and the
# AppImage, if given), gobbonet-update.json and gobbonet-update.json.sig. The
# names must stay as they are -- the update file names the ZIP, and GobboNet
# looks for the other two by name.
set -euo pipefail

cd "$(dirname "$0")/.."

KEY=""
ZIP=""
APPIMAGE=""
NOTES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --key)        KEY="$2"; shift 2 ;;
        --zip)        ZIP="$2"; shift 2 ;;
        --appimage)   APPIMAGE="$2"; shift 2 ;;
        --notes)      NOTES+=(--notes "$2"); shift 2 ;;
        --notes-file) NOTES+=(--notes-file "$2"); shift 2 ;;
        --notes-url)  NOTES+=(--notes-url "$2"); shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$KEY" ] || { echo "ERROR: --key PATH is required (the private key from gobbonet update keygen)" >&2; exit 2; }
[ -f "$KEY" ] || { echo "ERROR: no key file at $KEY" >&2; exit 1; }

# A private key inside the checkout is one `git add -A` from being public.
case "$(cd "$(dirname "$KEY")" && pwd)/" in
    "$(pwd)/"*) echo "ERROR: $KEY is inside this repository. Keep the signing key outside it." >&2; exit 1 ;;
esac

RELEASE="$(tr -d '[:space:]' < VERSION)"
UNDERSCORED="$(printf '%s' "$RELEASE" | tr '.' '_')"
if [ -z "$ZIP" ]; then
    for c in "dist/GobboNet-$UNDERSCORED-update.zip" "dist/GobboNet-$UNDERSCORED.zip"; do
        [ -f "$c" ] && ZIP="$c" && break
    done
fi
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "ERROR: no ZIP found; run scripts/make-zip.sh first, or pass --zip" >&2; exit 1; }

GO="${GO:-go}"
command -v "$GO" >/dev/null 2>&1 || {
    for c in "$HOME/Downloads/go/bin/go" /usr/local/go/bin/go; do
        [ -x "$c" ] && GO="$c" && break
    done
}
command -v "$GO" >/dev/null 2>&1 || { echo "ERROR: no go toolchain; set GO=/path/to/go" >&2; exit 1; }

TOOL="$(mktemp -d)/gobbonet-tool"
trap 'rm -rf "$(dirname "$TOOL")"' EXIT
CGO_ENABLED=0 "$GO" build -o "$TOOL" ./cmd/gobbonet

OUT="dist/gobbonet-update.json"
mkdir -p dist
ARGS=(--out "$OUT"
      --target "windows-amd64=$ZIP" --member "windows-amd64=GobboNet/gobbonet.exe"
      --target "linux-amd64=$ZIP"   --member "linux-amd64=GobboNet/linux-amd64/gobbonet")
if [ -n "$APPIMAGE" ]; then
    [ -f "$APPIMAGE" ] || { echo "ERROR: no AppImage at $APPIMAGE" >&2; exit 1; }
    ARGS+=(--target "appimage-amd64=$APPIMAGE")
fi
"$TOOL" update manifest "${ARGS[@]}" ${NOTES[@]+"${NOTES[@]}"}
"$TOOL" update sign --key "$KEY" "$OUT"
"$TOOL" update verify "$OUT"

echo
echo "Attach these to the GitHub release, keeping the names:"
echo "  $ZIP"
[ -n "$APPIMAGE" ] && echo "  $APPIMAGE"
echo "  $OUT"
echo "  $OUT.sig"
