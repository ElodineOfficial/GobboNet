#!/usr/bin/env bash
# Build the Fedora RPM. The counterpart to installer-linux/build-deb.sh, and
# deliberately the same shape so the two can be read side by side.
#
#   ./build-rpm.sh                      fetch the engine, build the package
#   SKIP_ENGINE_FETCH=1 ./build-rpm.sh  use whatever is already in vendor/
#   REUSE_DEB=/path/to.deb ./build-rpm.sh
#                                       take the engine out of an existing .deb
#                                       instead of downloading it again
#   BUNDLE_CPU_ENGINE=1 ./build-rpm.sh  also ship the CPU-only engine
#   DIST=.fc42 ./build-rpm.sh           target a specific Fedora release
#
# What this does NOT do is compile anything. The Go binary comes from
# ../build-release.sh, exactly as the .deb expects, because a package that
# silently rebuilds its own payload can ship something the maintainer never
# tested.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
VENDOR="$(pwd)/vendor"
STAGE="$(pwd)/stage"
OUT="$(pwd)/dist"
TOPDIR="$(pwd)/rpmbuild"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Engine. Same pinned build as the .deb, from the same place, checked against
# the same file. Bumping LLAMA_BUILD means updating installer-linux/engine.sha256
# in the same commit -- that is the point of pinning.
# ---------------------------------------------------------------------------
LLAMA_BUILD="${LLAMA_BUILD:-b10456}"
LLAMA_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}"
GPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz"
CPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"
BUNDLE_CPU="${BUNDLE_CPU_ENGINE:-0}"
REUSE_DEB="${REUSE_DEB:-}"

# ---------------------------------------------------------------------------
# Version, from the same VERSION file build-release.sh and build-deb.sh use, so
# the package and the binary cannot disagree about what release this is.
# ---------------------------------------------------------------------------
[ -f "$ROOT/VERSION" ] || fail "$ROOT/VERSION is missing"
RELEASE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$RELEASE" ] || fail "$ROOT/VERSION is empty"

# The RPM Release field is the packaging revision, not the upstream version.
# The build id goes there so two RPMs of the same GobboNet release built from
# different commits sort correctly and are told apart on sight.
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
else
    SHA="nogit.$(date -u +%Y%m%d)"
    say "WARNING: no git metadata in $ROOT; stamping $SHA"
fi
# '-' is not legal in an RPM Release field; '~' and '+' are not either. Dots are.
PKG_RELEASE="1.go.${SHA//-/.}"
DIST="${DIST:-.fc42}"

# ---------------------------------------------------------------------------
# The Go binary. Built by ../build-release.sh, never here.
# ---------------------------------------------------------------------------
GOBBONET_BIN="${GOBBONET_BIN:-}"
if [ -z "$GOBBONET_BIN" ]; then
    GOBBONET_BIN="$(find "$ROOT/dist" -name 'gobbonet' -type f -print 2>/dev/null | head -1 || true)"
fi
[ -n "$GOBBONET_BIN" ] && [ -f "$GOBBONET_BIN" ] || fail \
"linux/amd64 gobbonet binary not found.
       Run ../build-release.sh first, or set GOBBONET_BIN=/path/to/gobbonet"

case "$(file -b "$GOBBONET_BIN" 2>/dev/null)" in
    *"ELF 64-bit"*x86-64*) ;;
    *) fail "$GOBBONET_BIN is not a linux/amd64 ELF binary" ;;
esac

# ---------------------------------------------------------------------------
# Engine into vendor/
# ---------------------------------------------------------------------------
mkdir -p "$VENDOR"
if [ -n "$REUSE_DEB" ]; then
    # Lifting the engine out of a .deb we already built is exact and offline.
    # It is the same upstream asset, already unpacked and already verified when
    # that package was made.
    [ -f "$REUSE_DEB" ] || fail "REUSE_DEB=$REUSE_DEB does not exist"
    say "engine: extracting from $(basename "$REUSE_DEB")"
    rm -rf "$VENDOR/llama-cpp" && mkdir -p "$VENDOR/llama-cpp"
    tmp="$(mktemp -d)"
    dpkg-deb -x "$REUSE_DEB" "$tmp" 2>/dev/null || fail "could not unpack $REUSE_DEB"
    [ -d "$tmp/usr/lib/gobbonet/llama-cpp" ] || fail "no llama-cpp in $REUSE_DEB"
    cp -a "$tmp/usr/lib/gobbonet/llama-cpp/." "$VENDOR/llama-cpp/"
    [ -d "$tmp/usr/lib/gobbonet/llama-cpp-cpu" ] && [ "$BUNDLE_CPU" = "1" ] && {
        rm -rf "$VENDOR/llama-cpp-cpu" && mkdir -p "$VENDOR/llama-cpp-cpu"
        cp -a "$tmp/usr/lib/gobbonet/llama-cpp-cpu/." "$VENDOR/llama-cpp-cpu/"
    }
    rm -rf "$tmp"
elif [ "${SKIP_ENGINE_FETCH:-0}" = "1" ]; then
    say "engine: using vendor/ as-is (SKIP_ENGINE_FETCH=1)"
else
    fetch_engine() { # asset destdir
        local asset="$1" dest="$2" tmp
        tmp="$(mktemp -d)"
        say "engine: fetching $asset"
        curl -fsSL -o "$tmp/$asset" "$LLAMA_BASE/$asset" || fail "download failed: $asset"
        if [ -f "$ROOT/installer-linux/engine.sha256" ]; then
            local want got key
            key=$([ "$dest" = "$VENDOR/llama-cpp" ] && echo GPU_SHA256 || echo CPU_SHA256)
            want="$(grep "^$key=" "$ROOT/installer-linux/engine.sha256" | cut -d= -f2)"
            got="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
            [ "$want" = "$got" ] || fail \
"engine hash mismatch for $asset
       expected $want
       got      $got
       Either the pin in installer-linux/engine.sha256 is stale or the
       download is not what it claims to be. Do not paper over this."
            say "engine: sha256 verified against installer-linux/engine.sha256"
        fi
        rm -rf "$dest" && mkdir -p "$dest"
        tar xzf "$tmp/$asset" -C "$dest" --strip-components=1 2>/dev/null \
            || tar xzf "$tmp/$asset" -C "$dest"
        rm -rf "$tmp"
    }
    fetch_engine "$GPU_ASSET" "$VENDOR/llama-cpp"
    [ "$BUNDLE_CPU" = "1" ] && fetch_engine "$CPU_ASSET" "$VENDOR/llama-cpp-cpu"
fi

[ -x "$VENDOR/llama-cpp/llama-server" ] || [ -f "$VENDOR/llama-cpp/llama-server" ] \
    || fail "no llama-server under $VENDOR/llama-cpp"

# ---------------------------------------------------------------------------
# Frontend. stage-web.sh is the single source for what the browser gets, shared
# with the Windows installer, so the two front ends cannot drift.
# ---------------------------------------------------------------------------
say "staging web payload"
( cd "$ROOT" && ./stage-web.sh >/dev/null ) || fail "stage-web.sh failed"
[ -d "$ROOT/web" ] || fail "stage-web.sh produced no web/"

# ---------------------------------------------------------------------------
# Payload tree, laid out the way the .deb lays it out. The spec relocates
# /usr/lib to %{_libdir} at install time; keeping the staged tree identical to
# Debian's means one layout to reason about, not two.
# ---------------------------------------------------------------------------
say "staging payload"
rm -rf "$STAGE" && mkdir -p \
    "$STAGE/usr/lib/gobbonet" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps" \
    "$STAGE/usr/share/doc/gobbonet"

install -m 0755 "$GOBBONET_BIN"            "$STAGE/usr/lib/gobbonet/gobbonet"
# Shared with the .deb rather than forked: one launcher, one set of bugs.
# The spec rewrites its PREFIX line for %{_libdir} at install time.
install -m 0755 "$ROOT/installer-linux/gobbonet-launch" "$STAGE/usr/lib/gobbonet/gobbonet-launch"
install -m 0644 "$ROOT/installer/models.ini" "$STAGE/usr/lib/gobbonet/models.ini"
cp -a "$ROOT/web"                          "$STAGE/usr/lib/gobbonet/web"
cp -a "$VENDOR/llama-cpp"                  "$STAGE/usr/lib/gobbonet/llama-cpp"
[ -d "$VENDOR/llama-cpp-cpu" ] && cp -a "$VENDOR/llama-cpp-cpu" "$STAGE/usr/lib/gobbonet/llama-cpp-cpu"

install -m 0644 "$ROOT/installer-linux/gobbonet.desktop" "$STAGE/usr/share/applications/gobbonet.desktop"
install -m 0644 "$ROOT/installer-linux/icon/gobbonet-256.png" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps/gobbonet.png"
install -m 0644 "$ROOT/README.md"  "$STAGE/usr/share/doc/gobbonet/README.md"
install -m 0644 "$ROOT/LICENSE"    "$STAGE/usr/share/doc/gobbonet/copyright"

rm -rf "$ROOT/web"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
rm -rf "$TOPDIR" && mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
tar czf "$TOPDIR/SOURCES/gobbonet-payload.tar.gz" -C "$STAGE" usr
cp gobbonet.spec "$TOPDIR/SPECS/"

mkdir -p "$OUT"
# Payload compression is pinned rather than inherited. Fedora's rpm defaults to
# zstd, but rpm on other hosts still defaults to gzip -9 -- which on this payload
# is 40 MB instead of 24 MB for byte-identical contents. Pinning means the
# package does not change size depending on where it was built.
say "building rpm ${RELEASE}-${PKG_RELEASE}${DIST}"
rpmbuild -bb \
    --define "_topdir $TOPDIR" \
    --define "gn_version $RELEASE" \
    --define "gn_release $PKG_RELEASE" \
    --define "gn_llama_build $LLAMA_BUILD" \
    --define "dist $DIST" \
    --define "_build_id_links none" \
    --define "_binary_payload w19.zstdio" \
    "$TOPDIR/SPECS/gobbonet.spec" > "$TOPDIR/build.log" 2>&1 \
    || { tail -30 "$TOPDIR/build.log" >&2; fail "rpmbuild failed (full log: $TOPDIR/build.log)"; }

RPM="$(find "$TOPDIR/RPMS" -name '*.rpm' -print | head -1)"
[ -n "$RPM" ] || fail "rpmbuild produced no package"
cp "$RPM" "$OUT/"

echo
say "built: $OUT/$(basename "$RPM")"
say "version: ${RELEASE}-${PKG_RELEASE}${DIST}"
say "engine:  $LLAMA_BUILD"
echo
say "Install with:  sudo dnf install $OUT/$(basename "$RPM")"
