#!/usr/bin/env bash
#
# Assemble the hand-out ZIP -- the archive most people actually update from.
#
#   bash ./scripts/make-zip.sh                build dist/GobboNet-<version>.zip
#   bash ./scripts/make-zip.sh --no-engine    same, without the bundled llama.cpp engine
#   bash ./scripts/make-zip.sh --allow-dirty  stamp -dirty instead of refusing
#
# WHY THIS EXISTS
#
# It did not, and that was the bug. The ZIP was assembled by hand, and the hand
# that assembled it could not put a Windows server in it, because `*.exe` is
# gitignored and there was no step that built one. So the archive contained
# exactly one compiled server: linux-amd64/gobbonet.
#
# Which meant that for every Windows user -- most of them -- the download could
# not update the server half of the app AT ALL. They replaced the files, the
# chat page changed, and every server-side feature of the release stayed
# missing, because the only program that could provide it was not in the box.
# The panel then told them their gobbonet binary was out of date. It was right,
# and there was nothing they could do about it.
#
# So the archive is built by a script, the script builds the binaries, and it
# REFUSES to produce an archive with a platform missing. Same rule as
# payload.manifest, for the same reason: a list that can silently disagree with
# what shipped is not a list.
#
# WHAT IT DELIBERATELY DOES NOT DO
#
# It does not bundle a llama.cpp engine for Windows. The Windows engine is a
# ~300 MB vendor drop that the installer fetches and the ZIP never carried; the
# first-run setup downloads it. Only the Linux runtime here has one, because it
# was already committed under linux-amd64/.
#
# --no-engine
#
# The Linux engine is ~122 MB on disk and about two thirds of the finished
# archive, and it changes only when engine.sha256 is bumped -- which is rarely,
# and never in the same breath as a code change. --no-engine leaves it out, for
# the case the full archive is for: an UPDATE, dropped over an install that
# already has the engine sitting there. It is not a first install; the launcher
# will not find an engine and will offer to fetch one.
set -euo pipefail

# scripts/ lives one level below the repo root; everything below runs from the root.
cd "$(dirname "$0")/.."

WITH_ENGINE=1
ALLOW_DIRTY=0
for arg in "$@"; do
    case "$arg" in
        --no-engine)   WITH_ENGINE=0 ;;
        --allow-dirty) ALLOW_DIRTY=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

[ -f VERSION ] || { echo "ERROR: VERSION is missing" >&2; exit 1; }
RELEASE="$(tr -d '[:space:]' < VERSION)"
[ -n "$RELEASE" ] || { echo "ERROR: VERSION is empty" >&2; exit 1; }

GO="${GO:-go}"
command -v "$GO" >/dev/null 2>&1 || {
    for c in "$HOME/Downloads/go/bin/go" /usr/local/go/bin/go; do
        [ -x "$c" ] && GO="$c" && break
    done
}
command -v "$GO" >/dev/null 2>&1 || { echo "ERROR: no go toolchain; set GO=/path/to/go" >&2; exit 1; }
# Not older than the Go the last release was built with (scripts/go-floor.sh).
bash ./scripts/go-floor.sh "$GO"

# The build stamp. A report is only actionable if it names a build, and a build
# is only nameable if the name describes the code inside it.
if git rev-parse --short HEAD >/dev/null 2>&1; then
    SHA="$(git rev-parse --short HEAD)"
    if [ -n "$(git status --porcelain)" ]; then
        if [ "$ALLOW_DIRTY" -eq 1 ]; then
            SHA="$SHA-dirty"
            echo "WARNING: building from a modified tree; stamping $SHA"
        else
            echo "ERROR: working tree has uncommitted changes." >&2
            echo "       A build stamped $RELEASE-go-$SHA would not match what is in it." >&2
            echo "       Commit first, or re-run with --allow-dirty." >&2
            exit 1
        fi
    fi
else
    # No git: the convention the shipped 1.7.4 binary already used.
    SHA="nogit.$(date +%Y%m%d)"
    echo "note: not a git checkout; stamping $SHA"
fi

VERSION="$RELEASE-go-$SHA"
# The serial: when HEAD was committed, in Unix seconds (1.8.0). It is what
# orders two builds of one release, so the update button can offer a hotfix
# re-published as the same version and never an earlier build
# (internal/update). Stamped as gobbonet-build[<version>/<serial>] so that
# `gobbonet update manifest` can read it out of the program file
# (internal/version/version.go). Without git it is left out; such a build is
# offered any later build of its release.
SERIAL="$(git log -1 --format=%ct 2>/dev/null || true)"
LDFLAGS="-s -w -X github.com/ElodineOfficial/GobboNet/internal/version.Version=$VERSION"
if [ -n "$SERIAL" ]; then
    LDFLAGS="$LDFLAGS -X github.com/ElodineOfficial/GobboNet/internal/version.Stamp=gobbonet-build[$VERSION/$SERIAL]"
fi

# A build with no update signing key can say a newer release exists but
# installs nothing (docs/UPDATES.md). Fine for a test build; a release meant
# to update itself later needs the maintainer's key in the file first.
if ! grep -q '^ed25519 ' internal/update/trusted-keys.txt 2>/dev/null; then
    echo "WARNING: internal/update/trusted-keys.txt has no key: this build's UPDATE NOW will"
    echo "         install nothing. See docs/UPDATES.md before building a release."
fi

# The frontend is compiled INTO each binary, so staging is an input to the build
# and has to happen before it. A binary built without this has no chat page.
# Through bash, not ./ -- see build-release.sh.
bash ./scripts/stage-web.sh
[ -f internal/webui/assets/chat.html ] || {
    echo "ERROR: stage-web.sh produced no chat.html; the binaries would have no UI" >&2
    exit 1
}

#-----------------------------------------------------------------------------
# What the archive must contain. Every line is checked after assembly.
#
#   path              required file
#   path/             required directory
#   ?path             optional
#-----------------------------------------------------------------------------
MANIFEST='
gobbonet.exe
gobbonet
repair-windows-shortcuts.ps1
launch.bat
chat.html
VERSION
engine.sha256
README.md
TROUBLESHOOTING.md
LINUX-START-HERE.md
js/
css/
docs/
tests/
internal/
cmd/
linux-amd64/gobbonet
linux-amd64/gobbonet-launch
linux-amd64/gobbonet-setup.py
linux-amd64/wizard.html
linux-amd64/models.ini
internal/webui/assets/chat.html
catalog/models.ini
scripts/
.github/
PATCH-README.txt
'

# The engine is required in a full archive and must be absent from an update
# one -- "maybe present" is the ambiguity the manifest exists to remove.
if [ "$WITH_ENGINE" -eq 1 ]; then
    MANIFEST="$MANIFEST
linux-amd64/llama-cpp/"
fi

# The engine in a full archive must be the pinned Vulkan build:
# llama-<LLAMA_BUILD>-bin-ubuntu-vulkan-x64.tar.gz, checked against GPU_SHA256
# in engine.sha256. gobbonet-launch
# treats linux-amd64/llama-cpp as the GPU engine; upstream's CPU-only archive
# has the same files minus libggml-vulkan.so, starts just as well, and runs
# every model on the processor with nothing to say so. A 1.7.9 test build went
# out that way (CHANGELOG-1.7.9-linux-installer.md). build-deb.sh refuses the
# same thing for the package.
if [ "$WITH_ENGINE" -eq 1 ]; then
    eng="linux-amd64/llama-cpp"
    [ -f "$eng/llama-server" ] || { echo "ERROR: $eng/llama-server is missing; unpack the pinned Vulkan engine there, or build with --no-engine" >&2; exit 1; }
    if ! ls "$eng"/libggml-vulkan.so* >/dev/null 2>&1; then
        echo "ERROR: $eng has no libggml-vulkan.so: it is the CPU-only llama.cpp build." >&2
        echo "       A full ZIP carries the Vulkan build, which still runs on the CPU when" >&2
        echo "       there is no Vulkan driver. Unpack llama-<LLAMA_BUILD>-bin-ubuntu-vulkan-x64.tar.gz," >&2
        echo "       checked against GPU_SHA256 in engine.sha256, into $eng." >&2
        exit 1
    fi
fi

echo "building $VERSION with $($GO version)"

build_one() {
    local goos="$1" goarch="$2" out="$3"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        "$GO" build -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/gobbonet
    printf '  %-16s %s\n' "$goos/$goarch" "$(du -h "$out" | cut -f1)"
}

# The two servers the archive carries. Windows at the root, beside launch.bat,
# because it is the file a Windows user is told to double-click -- and because
# launch.bat looks for it there to hand over to.
build_one windows amd64 gobbonet.exe
build_one linux   amd64 linux-amd64/gobbonet
chmod 0755 gobbonet.exe linux-amd64/gobbonet

# A web/ directory beside the binary is what the old layout shipped, and the
# server now reports one as ignored. Leaving a stale copy in the archive would
# set that warning off on a brand-new extract.
if [ -d linux-amd64/web ]; then
    echo "  removing linux-amd64/web (the chat page is in the binary now)"
    rm -rf linux-amd64/web
fi

DIST="dist"
mkdir -p "$DIST"
SUFFIX=""
[ "$WITH_ENGINE" -eq 0 ] && SUFFIX="-update"
ARCHIVE="$DIST/GobboNet-$(printf '%s' "$RELEASE" | tr '.' '_')$SUFFIX.zip"
STAGE="$(mktemp -d "$DIST/stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# Copied rather than zipped in place, so the archive contains a named top-level
# folder. Extracting a flat archive over a user's home directory is a mess, and
# "keep the folder exactly as it comes out of the ZIP" is already the
# instruction in the README.
TOP="$STAGE/GobboNet"
mkdir -p "$TOP"

copy_in() {
    local rel="$1"
    [ -e "$rel" ] || return 0
    mkdir -p "$TOP/$(dirname "$rel")"
    cp -a "$rel" "$TOP/$(dirname "$rel")/"
}

# No top-level `gobbonet` in this list, on purpose. It used to be here, and
# nothing built it: the archive took whatever file of that name was lying in
# the tree -- a leftover `go build`, of any age -- and the stamp check below
# only ever looked at linux-amd64/gobbonet. It is installed from
# installer-linux/gobbonet-zip-entry just after this loop instead.
for rel in \
    gobbonet.exe launch.bat setup-lan.bat teardown-lan.bat \
    "Repair Windows shortcuts.bat" repair-windows-shortcuts.ps1 \
    stop-gobbonet.bat hardware-probe.ps1 hw-recommend.ps1 identify-model.ps1 \
    chat.html default-characters.json gobbonet.ico manifest.webmanifest VERSION \
    README.md TROUBLESHOOTING.md SECURITY.md LINUX-START-HERE.md LICENSE AGENTS.md \
    CONTRIBUTORS.md CONTRIBUTING.md .github \
    go.mod go.sum scripts engine.sha256 .gitignore catalog \
    js css icons docs tests cmd internal installer-win installer-linux \
    installer-fedora linux-amd64
do
    copy_in "$rel"
done

# The Linux ZIP's front door. LINUX-START-HERE.md tells ZIP users to run
# `./gobbonet`; this makes that the launcher -- setup page, then chat -- exactly
# as the packages' `gobbonet` command is, instead of the bare server, which on a
# first run only said "review config.toml". A text file, so unlike a binary it
# cannot go stale. Roadmap 1.7.7 #14.
# The release notes are a release file, not source (1.7.9): they live in
# scripts/ and are copied to the archive's root, where people look for them.
# The scripts/ copy stays in the archive too, so a checkout updated from the
# zip receives the new notes; the root copy is gitignored.
[ -f scripts/PATCH-README.txt ] || { echo "ERROR: scripts/PATCH-README.txt is missing" >&2; exit 1; }
cp scripts/PATCH-README.txt "$TOP/PATCH-README.txt"

ZIP_ENTRY="installer-linux/gobbonet-zip-entry"
[ -f "$ZIP_ENTRY" ] || { echo "ERROR: $ZIP_ENTRY is missing" >&2; exit 1; }
cp "$ZIP_ENTRY" "$TOP/gobbonet"
chmod 0755 "$TOP/gobbonet"

# Build leftovers must not travel. dist/ inside dist/ is the obvious one; the
# rest are things a local build or a test run drops in the tree.
# Build scratch must not travel. The installer directories are copied wholesale,
# and a local package build drops dist/, stage/, vendor/ and payload/ into them
# -- each carrying its own full copy of the 122 MB llama.cpp engine. The first
# archive built after a test deb build came out at 136 MB instead of 51 MB, with
# the engine in it three times.
#
# Pruned by NAME anywhere under the staged tree rather than by a list of known
# paths, so a builder that invents a new scratch directory does not quietly put
# it back. rpmbuild/ is installer-fedora's: the payload tarball, the unpacked
# build tree and the built package, the engine in each of them. stage-appimage/
# is build-appimage.sh's AppDir, the engine again.
rm -rf "$TOP/dist" "$TOP/linux-amd64/web" "$TOP/web"
for scratch in dist stage stage-appimage vendor payload rpmbuild; do
    find "$TOP" -mindepth 2 -type d -name "$scratch" -prune -exec rm -rf {} + 2>/dev/null || true
done
find "$TOP" -name 'GobboNetSetup-*.exe' -delete 2>/dev/null || true
# Parenthesised: without the brackets find reads `-name '*.deb' -o
# \( -name '*.rpm' -delete \)`, and every .deb stayed in the archive.
find "$TOP" \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -delete 2>/dev/null || true

if [ "$WITH_ENGINE" -eq 0 ]; then
    rm -rf "$TOP/linux-amd64/llama-cpp" "$TOP/linux-amd64/llama-cpp-cpu"
    # Say so inside the archive, not only in the filename. Someone who extracts
    # this over an empty folder and gets no engine deserves to find out from a
    # file rather than from a failed launch.
    cat > "$TOP/NO-ENGINE-IN-THIS-ZIP.txt" <<NOTE
This archive is an UPDATE. It leaves out the bundled llama.cpp engine
(linux-amd64/llama-cpp), which has not changed in this release.

Updating an existing install:
  Windows   close GobboNet and extract the complete update over the existing
            application folder. Keep config, engine, models and history.
            Run Repair Windows shortcuts.bat, then Launch GobboNet from the
            Start menu. Re-pin older taskbar shortcuts if necessary.
  Linux     replace the linux-amd64 folder. Your existing llama-cpp folder
            stays where it is; this archive does not overwrite it.

Installing for the first time: use the full archive instead
(GobboNet-*.zip without "-update"), or let the first-run setup download an
engine for you.
NOTE
fi
find "$TOP" -name '*.staging.*' -prune -exec rm -rf {} + 2>/dev/null || true
find "$TOP" -name '.gobbonet-*' -delete 2>/dev/null || true

#-----------------------------------------------------------------------------
# Check the staged tree against the manifest BEFORE zipping it. This is the
# whole point of the file: the last archive shipped without a Windows server and
# nothing noticed until a user asked why updating did not work.
#-----------------------------------------------------------------------------
missing=()
while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    opt=0
    case "$line" in \?*) opt=1; line="${line#\?}" ;; esac
    case "$line" in
        */) [ -d "$TOP/${line%/}" ] || [ "$opt" = 1 ] || missing+=("${line} (directory)") ;;
        *)  [ -e "$TOP/$line" ]     || [ "$opt" = 1 ] || missing+=("$line") ;;
    esac
done <<EOF
$MANIFEST
EOF

if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: the staged archive is missing things it must contain:" >&2
    for m in "${missing[@]}"; do echo "         $m" >&2; done
    echo "       Refusing to build it. An archive that is missing a platform's" >&2
    echo "       server cannot update that platform, and the last one to ship" >&2
    echo "       that way took a bug report to discover." >&2
    exit 1
fi

# Both servers must report the release being built. A stale prebuilt binary in
# the tree is exactly how 1.7.4 shipped a 1.7.3 server (roadmap item 12).
stamped="$("$TOP/linux-amd64/gobbonet" version 2>/dev/null | head -1 || true)"
case "$stamped" in
    "$VERSION"*) : ;;
    *) echo "ERROR: linux-amd64/gobbonet reports '$stamped', not '$VERSION'" >&2; exit 1 ;;
esac

# The top-level `gobbonet` must be the ZIP entry, byte for byte -- not a binary
# that wandered in. Checked here, after assembly, for the same reason as the
# stamp above: the last time this file was wrong, nothing looked.
cmp -s "$TOP/gobbonet" "$ZIP_ENTRY" && [ -x "$TOP/gobbonet" ] || {
    echo "ERROR: the archive's top-level gobbonet is not $ZIP_ENTRY (or is not executable)" >&2
    exit 1
}

# And the page inside it must match the VERSION file, or the two halves that
# were just unified are out of step again.
ui="$(grep -o "GOBBONET_UI_VERSION = '[^']*'" "$TOP/js/01-config.js" | head -1 | sed "s/.*'\\(.*\\)'/\\1/")"
[ "$ui" = "$RELEASE" ] || {
    echo "ERROR: the frontend stamp is '$ui' but VERSION is '$RELEASE'" >&2
    echo "       js/01-config.js and VERSION must agree; tests/test-version-stamp.mjs pins this." >&2
    exit 1
}

# A size ceiling. The archive is dominated by one llama.cpp engine (~122 MB
# uncompressed, ~35 MB in the zip) plus two ~10 MB servers, so anything much
# past this means a second copy of the engine got in -- which is exactly what
# happened the first time, from a leftover package-build directory.
staged_mb=$(du -sm "$TOP" | cut -f1)
CEILING_MB="${GOBBONET_ZIP_CEILING_MB:-320}"
if [ "$staged_mb" -gt "$CEILING_MB" ]; then
    echo "ERROR: the staged tree is ${staged_mb} MB, over the ${CEILING_MB} MB ceiling." >&2
    echo "       That usually means build scratch got in. The biggest directories:" >&2
    du -sm "$TOP"/* "$TOP"/*/* 2>/dev/null | sort -rn | head -8 | sed 's/^/         /' >&2
    echo "       Raise GOBBONET_ZIP_CEILING_MB only if the growth is deliberate." >&2
    exit 1
fi

rm -f "$ARCHIVE"
(cd "$STAGE" && zip -qr "$OLDPWD/$ARCHIVE" GobboNet)

echo
echo "  $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"
echo "  version:  $VERSION"
echo "  servers:  gobbonet.exe (windows/amd64), linux-amd64/gobbonet (linux/amd64)"
echo "  linux:    ./gobbonet -> linux-amd64/gobbonet-launch (setup, then chat)"
if [ "$WITH_ENGINE" -eq 0 ]; then
    echo "  engine:   NOT included -- this is an update archive"
else
    echo "  engine:   bundled (linux-amd64/llama-cpp)"
fi
echo
echo "  Other platforms (linux/arm64, darwin) come from scripts/build-release.sh."
