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
# Same fallback as installer-linux/build-deb.sh, and for the same reason: a
# distributed source tree has no .git, and this used to abort the whole build
# with "not a git repository" before anything was produced (PKG-5). The commit
# is provenance, not a prerequisite.
if SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null)" && [ -n "$SHA" ]; then
    if [ -n "$(cd "$ROOT" && git status --porcelain 2>/dev/null)" ]; then
        SHA="$SHA-dirty"
        echo "WARNING: building from a modified tree; stamping $SHA" >&2
    fi
else
    # A date, not a stand-in hash: "nogit" says honestly that the source could
    # not be identified, where a fabricated hash would claim it had been.
    SHA="nogit.$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y%m%d 2>/dev/null || date -u +%Y%m%d)"
    echo "WARNING: no git metadata in $ROOT; stamping $SHA" >&2
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

# ---------------------------------------------------------------------------
# llama.cpp.
#
# Fetched and hash-checked against the shared pin at the repo root, the same
# one build-deb.sh and build-rpm.sh read. Until 1.7.4 this side had NO pin: it
# bundled whatever was sitting in vendor/, with a look for ggml-vulkan.dll as
# the only check. An .exe and a .deb carrying the same version number could
# therefore contain different engines, and nothing anywhere recorded which --
# which is exactly the question you want answered when one platform reproduces
# a bug and the other does not.
#
# Deliberately not $ROOT/vendor: a "vendor" directory at a Go module root is
# reserved by the toolchain, and putting non-Go files there breaks go build.
# ---------------------------------------------------------------------------
_env_llama_build="${LLAMA_BUILD:-}"
[ -f "$ROOT/engine.sha256" ] && . "$ROOT/engine.sha256"
LLAMA_BUILD="${_env_llama_build:-${LLAMA_BUILD:-b10456}}"
WIN_GPU_SHA256="${WIN_GPU_SHA256:-}"
LLAMA_ASSET="llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}"

VENDOR="$(pwd)/vendor"
LLAMA_CPP="${LLAMA_CPP:-$VENDOR/llama-cpp}"

# Only fetch when pointing at the default vendor location. Someone who passed
# LLAMA_CPP=/somewhere has said which engine they mean, and downloading over
# the top of it would be the opposite of what they asked for.
if [ "$LLAMA_CPP" = "$VENDOR/llama-cpp" ]; then
    mkdir -p "$VENDOR"
    ARCHIVE="$VENDOR/$LLAMA_ASSET"
    if [ ! -f "$ARCHIVE" ]; then
        [ "${SKIP_ENGINE_FETCH:-0}" = "1" ] && {
            echo "ERROR: $LLAMA_ASSET is missing and SKIP_ENGINE_FETCH=1" >&2
            exit 1
        }
        echo "  fetching $LLAMA_ASSET"
        curl -fL --retry 3 -o "$ARCHIVE.part" "$LLAMA_URL" || {
            echo "ERROR: could not download $LLAMA_ASSET" >&2
            echo "       $LLAMA_URL" >&2
            exit 1
        }
        mv "$ARCHIVE.part" "$ARCHIVE"
    fi

    GOT="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
    if [ -z "$WIN_GPU_SHA256" ]; then
        echo "ERROR: no pinned SHA-256 for $LLAMA_ASSET." >&2
        echo "       Verify it against the release page, then record it in" >&2
        echo "       engine.sha256 at the repo root as WIN_GPU_SHA256." >&2
        echo "       The hash of what was just downloaded is:" >&2
        echo "         $GOT" >&2
        exit 1
    fi
    if [ "$GOT" != "$WIN_GPU_SHA256" ]; then
        echo "ERROR: SHA-256 mismatch for $LLAMA_ASSET" >&2
        echo "       expected $WIN_GPU_SHA256" >&2
        echo "       got      $GOT" >&2
        echo "       Either the pin is stale or the download is not what it claims." >&2
        echo "       Delete $ARCHIVE and retry before changing the pin." >&2
        exit 1
    fi

    # Re-extract every time. A directory left over from a previous build could
    # be a different engine entirely, and the hash above only speaks for the
    # archive.
    rm -rf "$LLAMA_CPP"
    mkdir -p "$LLAMA_CPP"
    unzip -q -o "$ARCHIVE" -d "$LLAMA_CPP"
    ENGINE_VERIFIED="yes (sha256 matches the pin)"
else
    # A hand-placed engine cannot be hashed against an archive nobody kept, so
    # say so rather than implying a check that did not happen.
    ENGINE_VERIFIED="NO -- LLAMA_CPP was set by hand, so the pin was not applied"
fi

if [ ! -f "$LLAMA_CPP/llama-server.exe" ]; then
    echo "ERROR: llama-server.exe not found under $LLAMA_CPP" >&2
    echo "       Download the Windows build and extract it there:" >&2
    echo "         $LLAMA_URL" >&2
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

# A marker that survives installation. Until now the bundled engine was
# anonymous once installed: no file on a user's disk said which llama.cpp build
# it was, so "which engine are you on?" had no answer short of hashing DLLs.
cat > "$PAYLOAD/llama-cpp/ENGINE.txt" <<ENGINEEOF
llama.cpp build: $LLAMA_BUILD
asset:           $LLAMA_ASSET
backend:         $LLAMA_BACKEND
pinned hash:     ${WIN_GPU_SHA256:-none}
verified:        $ENGINE_VERIFIED
bundled by:      GobboNet $VERSION
ENGINEEOF

echo "  engine:   $LLAMA_BUILD ($LLAMA_BACKEND) -- $ENGINE_VERIFIED"

# No web assets in the payload. The chat page is compiled into gobbonet.exe
# (internal/webui), so it arrives with the binary -- which is the point: the
# installer can no longer put a frontend and a server out of step, and neither
# can a user replacing files afterwards. build-release.sh runs stage-web.sh
# before building the .exe this script bundles.

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
