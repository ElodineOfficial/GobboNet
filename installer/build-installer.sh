#!/usr/bin/env bash
#
# Build the Windows installer.
#
#   ./build-installer.sh                       use dist/ from build-release.sh
#   LLAMA_CPP=/path/to/llama ./build-installer.sh
#
# Stages a payload folder, regenerates the model catalogue from launch.bat,
# then runs makensis over it.
#
# Everything this script checks for is checked BEFORE makensis runs. An
# installer that compiles but ships without llama.cpp, or with a catalogue
# that has drifted from launch.bat, is worse than one that failed to build:
# it fails on a stranger's PC instead of on ours.

set -euo pipefail
cd "$(dirname "$0")"

PAYLOAD="$(pwd)/payload"
ROOT="$(cd .. && pwd)"

command -v makensis >/dev/null 2>&1 || {
    echo "ERROR: makensis not found. Install it with:" >&2
    echo "         sudo apt-get install nsis" >&2
    exit 1
}

# Elodine built 1.3 with NSIS 3.09. Version differences across 3.x are small,
# but a mismatch means the installer we hand back is not byte-comparable with
# one they build, which makes a diff-based review harder than it needs to be.
# Distro packages append their own suffix (Debian reports 3.08-3+deb12u1),
# so compare only the upstream major.minor.
NSIS_VER="$(makensis -VERSION 2>/dev/null | sed 's/^v//; s/^\([0-9]*\.[0-9]*\).*/\1/')"
if [ "$NSIS_VER" != "3.09" ]; then
    echo "NOTE: building with NSIS $NSIS_VER; Elodine's 1.3 used 3.09." >&2
fi

#--------------------------------------------------------------------
# Version. Matches build-release.sh's scheme so a tester's report names
# the same build for the server and the installer that carried it.
#--------------------------------------------------------------------
[ -f "$ROOT/VERSION" ] || { echo "ERROR: $ROOT/VERSION is missing" >&2; exit 1; }
RELEASE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$RELEASE" ] || { echo "ERROR: $ROOT/VERSION is empty" >&2; exit 1; }
SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
if [ -n "$(cd "$ROOT" && git status --porcelain)" ]; then
    SHA="$SHA-dirty"
    echo "WARNING: building from a modified tree; stamping $SHA" >&2
fi
VERSION="$RELEASE-go-$SHA"
# VIProductVersion demands exactly four numeric components. Pad rather than
# append ".0.0": a three-part RELEASE like 1.5.1 would otherwise produce
# "1.5.1.0.0" and makensis aborts with "invalid VIProductVersion format".
IFS=. read -r _v1 _v2 _v3 _v4 <<EOF
$RELEASE
EOF
VERSION_QUAD="${_v1:-0}.${_v2:-0}.${_v3:-0}.${_v4:-0}"

#--------------------------------------------------------------------
# Regenerate the catalogue. Always, not just when missing -- the whole
# point of generating it is that it cannot silently lag launch.bat.
#--------------------------------------------------------------------
./gen-catalog.py "$ROOT/launch.bat" models.ini

#--------------------------------------------------------------------
# Stage payload
#--------------------------------------------------------------------
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"

# gobbonet.exe -- newest windows/amd64 build produced by build-release.sh
GOBBONET_EXE="${GOBBONET_EXE:-}"
if [ -z "$GOBBONET_EXE" ]; then
    GOBBONET_EXE="$(find "$ROOT/dist" -name 'gobbonet.exe' -print 2>/dev/null | head -1 || true)"
fi
if [ -z "$GOBBONET_EXE" ] || [ ! -f "$GOBBONET_EXE" ]; then
    echo "ERROR: no gobbonet.exe found." >&2
    echo "       Run ../build-release.sh first, or set GOBBONET_EXE=/path/to/gobbonet.exe" >&2
    echo "       (build-release.sh archives its output, so you may need to unzip" >&2
    echo "        dist/<version>/gobbonet-<version>-windows-amd64.zip)" >&2
    exit 1
fi
cp "$GOBBONET_EXE" "$PAYLOAD/gobbonet.exe"

# llama.cpp -- bundled, not downloaded. See the header comment in gobbonet.nsi.
# Deliberately not $ROOT/vendor: a "vendor" directory at a Go module root is
# reserved by the toolchain, and putting non-Go files there breaks go build.
LLAMA_CPP="${LLAMA_CPP:-$(pwd)/vendor/llama-cpp}"
if [ ! -f "$LLAMA_CPP/llama-server.exe" ]; then
    echo "ERROR: llama-server.exe not found under $LLAMA_CPP" >&2
    echo "       Download the Windows build and extract it there:" >&2
    echo "         https://github.com/ggml-org/llama.cpp/releases" >&2
    echo "         (the asset ending in -bin-win-vulkan-x64.zip)" >&2
    echo "       Or point at it:  LLAMA_CPP=/path/to/llama-cpp $0" >&2
    exit 1
fi
# Is it the GPU build? launch.bat pins the -bin-win-vulkan-x64 asset, and the
# installer sets gpu_layers 99 on the strength of it. The CPU-only asset has the
# same filenames minus one DLL, so bundling it by accident produces an install
# that works, offers the same models, and runs every one of them on the CPU --
# no error anywhere, just a machine that takes a minute to answer.
#
# The engine is fetched by hand into vendor/, so this WILL be got wrong
# eventually; asking here costs nothing. LLAMA_BACKEND=cpu is the deliberate
# opt-out, for a CPU-only installer built on purpose.
LLAMA_BACKEND="${LLAMA_BACKEND:-vulkan}"
if [ "$LLAMA_BACKEND" = "vulkan" ] && [ ! -f "$LLAMA_CPP/ggml-vulkan.dll" ]; then
    echo "ERROR: $LLAMA_CPP has no ggml-vulkan.dll, so it is the CPU-only build." >&2
    echo "       An installer built from it would ignore gpu_layers entirely and" >&2
    echo "       run every model on the processor, with nothing to say so." >&2
    echo "       Fetch the asset ending -bin-win-vulkan-x64.zip from" >&2
    echo "         https://github.com/ggml-org/llama.cpp/releases" >&2
    echo "       and extract it over $LLAMA_CPP," >&2
    echo "       or pass LLAMA_BACKEND=cpu to build a CPU-only installer on purpose." >&2
    exit 1
fi

mkdir -p "$PAYLOAD/llama-cpp"
cp -r "$LLAMA_CPP/." "$PAYLOAD/llama-cpp/"
echo "  engine:   $LLAMA_CPP ($LLAMA_BACKEND)"

# Web assets. web/ is generated from the repo-root frontend rather than
# committed -- see stage-web.sh -- so assemble it fresh rather than trusting
# whatever a previous run left behind.
"$ROOT/stage-web.sh"
cp -r "$ROOT/web" "$PAYLOAD/web"

# Scripts kept from the Windows lineage. launch.bat still owns adding further
# models; hardware-probe.ps1 is called by the installer's probe page.
for f in launch.bat setup-lan.bat teardown-lan.bat stop-gobbonet.bat hardware-probe.ps1 identify-model.ps1 fileserver.ps1; do
    [ -f "$ROOT/$f" ] || { echo "ERROR: $f missing from $ROOT" >&2; exit 1; }
    cp "$ROOT/$f" "$PAYLOAD/$f"
done

cp art/gobbonet.ico "$PAYLOAD/gobbonet.ico"

#--------------------------------------------------------------------
echo "building GobboNetSetup-$VERSION.exe"
makensis -V2 \
    -DVERSION="$VERSION" \
    -DVERSION_QUAD="$VERSION_QUAD" \
    -DPAYLOAD="$PAYLOAD" \
    gobbonet.nsi

echo
ls -lh "GobboNetSetup-$VERSION.exe"
