#!/usr/bin/env bash
#
# Build gobbonet.deb.
#
#   ./build-deb.sh                        use dist/ from ../build-release.sh
#   GOBBONET_BIN=/path/to/gobbonet ./build-deb.sh
#   SKIP_ENGINE_FETCH=1 ./build-deb.sh    use whatever is already in vendor/
#
# Everything this script checks is checked BEFORE dpkg-deb runs. A package that
# builds but ships without a working engine is worse than one that failed to
# build: it fails on a stranger's machine instead of on ours, and the failure
# arrives as "the model won't load" rather than "the installer is broken".
#
# This is the Linux sibling of installer/build-installer.sh and keeps the same
# discipline: pinned engine, guarded payload, generated catalogue, version
# stamped from the same VERSION file.

set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
VENDOR="$(pwd)/vendor"
STAGE="$(pwd)/stage"
OUT="$(pwd)/dist"

# ---------------------------------------------------------------------------
# The engine.
#
# The Vulkan build is bundled. The CPU-only build is NOT, by default, and that
# is a deliberate departure from the original plan — which called for shipping
# both so that a machine with no Vulkan driver still worked.
#
# The goal was right; the means turned out to be redundant. Upstream's two
# Linux archives were compared file by file: 51 of their 52 files are
# byte-identical, the CPU archive is a strict subset, and the only meaningful
# difference is libggml-vulkan.so. The Vulkan archive already carries all
# fifteen libggml-cpu-*.so backends.
#
# Verified rather than assumed: with libvulkan.so.1 removed from the system,
# libggml-vulkan.so fails to load exactly as expected and llama-server from the
# Vulkan bundle still starts and exits 0. ggml dlopens its backends through a
# registry, so a missing Vulkan driver drops that one backend and falls through
# to the CPU ones sitting beside it.
#
# So the Vulkan bundle alone "works everywhere instead of usually" — at ~92 MB
# instead of ~133 MB, with no behaviour lost. Set BUNDLE_CPU_ENGINE=1 to ship
# both anyway.
#
# On the filenames: confirmed against the live releases page. Linux assets are
# .tar.gz — only the Windows ones are .zip — and the CPU asset is
# "-bin-ubuntu-x64", not "-bin-ubuntu-cpu-x64". The two platforms do not use
# the same naming scheme.
#
# Bumping LLAMA_BUILD means updating engine.sha256 in the same commit. That is
# the point of pinning: a deliberate change, not a silent fetch of whatever is
# current today.
# ---------------------------------------------------------------------------
LLAMA_BUILD="${LLAMA_BUILD:-b10456}"
LLAMA_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}"
BUNDLE_CPU="${BUNDLE_CPU_ENGINE:-0}"

GPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz"
CPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"

GPU_SHA256="${GPU_SHA256:-}"
CPU_SHA256="${CPU_SHA256:-}"
[ -f engine.sha256 ] && . ./engine.sha256

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Version, from the same VERSION file build-release.sh uses, so the package and
# the binary inside it name the same build.
#
# 1.6+go.<sha>-1 is valid Debian versioning and sorts correctly: '+' outranks
# nothing, and the -1 is the Debian revision.
# ---------------------------------------------------------------------------
[ -f "$ROOT/VERSION" ] || fail "$ROOT/VERSION is missing"
RELEASE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$RELEASE" ] || fail "$ROOT/VERSION is empty"

SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
if [ -n "$(cd "$ROOT" && git status --porcelain)" ]; then
    SHA="$SHA-dirty"
    echo "WARNING: building from a modified tree; stamping $SHA" >&2
fi
DEB_VERSION="${RELEASE}+go.${SHA}-1"

# ---------------------------------------------------------------------------
# The Go binary. Built by ../build-release.sh, which refuses a dirty tree and
# stamps the version with the commit sha.
# ---------------------------------------------------------------------------
GOBBONET_BIN="${GOBBONET_BIN:-}"
if [ -z "$GOBBONET_BIN" ]; then
    GOBBONET_BIN="$(find "$ROOT/dist" -type f -name gobbonet -path '*linux-amd64*' -print 2>/dev/null | head -1 || true)"
fi
[ -n "$GOBBONET_BIN" ] && [ -f "$GOBBONET_BIN" ] || fail \
"no linux/amd64 gobbonet binary found.
       Run ../build-release.sh first, or set GOBBONET_BIN=/path/to/gobbonet
       (build-release.sh archives its output, so you may need to unpack
        dist/<version>/gobbonet-<version>-linux-amd64.tar.gz)"

file "$GOBBONET_BIN" | grep -q 'ELF 64-bit' || fail "$GOBBONET_BIN is not an ELF binary."

# ---------------------------------------------------------------------------
# Fetch and verify the engines.
# ---------------------------------------------------------------------------
fetch_engine() {
    local asset="$1" want="$2" dest="$3"
    local tarball="$VENDOR/$asset"

    mkdir -p "$VENDOR"
    if [ ! -f "$tarball" ]; then
        [ "${SKIP_ENGINE_FETCH:-0}" = "1" ] && fail "$tarball is missing and SKIP_ENGINE_FETCH=1"
        say "fetching $asset"
        curl -fL --retry 3 -o "$tarball.part" "$LLAMA_BASE/$asset" \
            || fail "could not download $asset from $LLAMA_BASE"
        mv "$tarball.part" "$tarball"
    fi

    local got
    got="$(sha256sum "$tarball" | cut -d' ' -f1)"
    if [ -z "$want" ]; then
        fail "no pinned SHA-256 for $asset.
       Verify it against the release page, then record it in
       installer-linux/engine.sha256:
           ${asset%%-bin-*}... actual hash was:
           $got"
    fi
    [ "$got" = "$want" ] || fail "SHA-256 mismatch for $asset
       expected: $want
       actual:   $got
       Refusing to build. Either the download is corrupt or the pin is stale."

    rm -rf "$dest"; mkdir -p "$dest"
    tar xzf "$tarball" -C "$dest" --strip-components=1 2>/dev/null \
        || tar xzf "$tarball" -C "$dest"
    # Upstream has moved the binaries between build/bin/ and the archive root
    # across releases, so find llama-server rather than assuming its depth.
    local found
    found="$(find "$dest" -type f -name llama-server -print -quit)"
    [ -n "$found" ] || fail "no llama-server inside $asset"
    if [ "$(dirname "$found")" != "$dest" ]; then
        cp -a "$(dirname "$found")/." "$dest/"
    fi
    chmod +x "$dest/llama-server" 2>/dev/null || true
}

say "engine build: $LLAMA_BUILD"
fetch_engine "$GPU_ASSET" "$GPU_SHA256" "$VENDOR/llama-cpp"
if [ "$BUNDLE_CPU" = "1" ]; then
    say "BUNDLE_CPU_ENGINE=1 — also bundling the CPU-only archive"
    fetch_engine "$CPU_ASSET" "$CPU_SHA256" "$VENDOR/llama-cpp-cpu"
fi

# ---------------------------------------------------------------------------
# The payload guard.
#
# installer/build-installer.sh refuses to ship a CPU-only engine as if it were
# the GPU one. This is the same idea for a different failure: without it a
# package can ship with a stub engine and nothing catches it until a user tries
# to load a model.
#
# NOTE ON THE SIZE THRESHOLD. The obvious check — "llama-server must be several
# megabytes" — is wrong against current upstream builds and would reject a
# perfectly good engine. Upstream moved from a monolithic static binary to a
# shared-library layout: llama-server is now a ~17 KB launcher stub and the
# engine lives in libllama-server-impl.so, libllama.so and the libggml-*.so
# backends. So the stub is checked for being an ELF rather than a script, and
# the multi-megabyte test is applied to the library that actually carries the
# engine.
# ---------------------------------------------------------------------------
guard_engine() {
    local dir="$1" label="$2"
    local stub="$dir/llama-server"

    [ -f "$stub" ] || fail "$label: $stub is missing."
    file "$stub" | grep -q 'ELF 64-bit' \
        || fail "$label: $stub is not an ELF binary — it looks like $(file -b "$stub").
       A shell wrapper here means the archive did not unpack as expected."

    # Where the engine actually is.
    local impl
    impl="$(find "$dir" -maxdepth 1 -name 'libllama-server-impl.so*' -o -maxdepth 1 -name 'libllama.so*' \
            | head -1)"
    [ -n "$impl" ] || fail "$label: no libllama*.so beside llama-server — this is not a real engine."

    local size
    size="$(stat -c %s "$impl")"
    [ "$size" -ge 1000000 ] \
        || fail "$label: $(basename "$impl") is only $((size / 1024)) KB.
       The real engine library is megabytes; this is a stub, and a package built
       from it would ship an engine that cannot run models."

    # Total mass, which is the number that actually tracks "did the engine make
    # it in" once the payload is spread across fifty shared objects.
    local total
    total="$(du -sm "$dir" | cut -f1)"
    [ "$total" -ge 25 ] \
        || fail "$label: the whole engine directory is only ${total} MB, which is far
       too small. Expect ~40 MB CPU-only and ~90 MB with the Vulkan backend."

    say "$label: ELF stub + $(basename "$impl") $((size / 1024 / 1024)) MB, ${total} MB total — ok"
}
guard_engine "$VENDOR/llama-cpp" "GPU engine"
[ "$BUNDLE_CPU" = "1" ] && guard_engine "$VENDOR/llama-cpp-cpu" "CPU engine"

# The Linux equivalent of the Windows ggml-vulkan.dll guard file.
if ! ls "$VENDOR/llama-cpp"/libggml-vulkan.so* >/dev/null 2>&1; then
    fail "the GPU engine has no libggml-vulkan.so, so it is a CPU-only build.
       A package built from it would ignore gpu_layers entirely and run every
       model on the processor, with nothing to say so."
fi
say "GPU engine carries libggml-vulkan.so — ok"

# ---------------------------------------------------------------------------
# The libc6 floor, read from the engines themselves.
#
# The Go binary is static and does not care, but the engine links against
# glibc. Getting this right means the package manager refuses to install on a
# too-old system with a clear message, rather than the user hitting an
# unexplained runtime failure later.
# ---------------------------------------------------------------------------
glibc_floor() {
    objdump -T "$VENDOR/llama-cpp/llama-server" "$VENDOR/llama-cpp-cpu/llama-server" 2>/dev/null \
        | grep -o 'GLIBC_[0-9]\+\.[0-9]\+\(\.[0-9]\+\)\?' \
        | sed 's/GLIBC_//' | sort -V | tail -1
}
LIBC_MIN="$(glibc_floor)"
[ -n "$LIBC_MIN" ] || LIBC_MIN="2.35"
say "libc6 floor from the engine binaries: $LIBC_MIN"

# ---------------------------------------------------------------------------
# Catalogue and web assets, regenerated rather than trusted.
# ---------------------------------------------------------------------------
if [ -x "$ROOT/installer/gen-catalog.py" ] && [ -f "$ROOT/launch.bat" ]; then
    "$ROOT/installer/gen-catalog.py" "$ROOT/launch.bat" "$ROOT/installer/models.ini"
fi
[ -f "$ROOT/installer/models.ini" ] || fail "installer/models.ini is missing"
"$ROOT/stage-web.sh" >/dev/null
[ -d "$ROOT/web" ] || fail "stage-web.sh produced no web/ directory"

# ---------------------------------------------------------------------------
# Stage the tree.
#
# Program files are read-only and system-owned — the same role Program Files
# plays on Windows. Config, models, password and conversations all live in the
# user's own space and are created on first launch, by the user.
# ---------------------------------------------------------------------------
rm -rf "$STAGE"
install -d -m 0755 "$STAGE/DEBIAN"
install -d -m 0755 "$STAGE/usr/lib/gobbonet"
install -d -m 0755 "$STAGE/usr/bin"
install -d -m 0755 "$STAGE/usr/share/applications"
install -d -m 0755 "$STAGE/usr/share/icons/hicolor/256x256/apps"
install -d -m 0755 "$STAGE/usr/share/doc/gobbonet"

install -m 0755 "$GOBBONET_BIN"        "$STAGE/usr/lib/gobbonet/gobbonet"
install -m 0755 gobbonet-launch        "$STAGE/usr/lib/gobbonet/gobbonet-launch"
install -m 0644 "$ROOT/installer/models.ini" "$STAGE/usr/lib/gobbonet/models.ini"
cp -r "$ROOT/web"                      "$STAGE/usr/lib/gobbonet/web"
cp -r "$VENDOR/llama-cpp"              "$STAGE/usr/lib/gobbonet/llama-cpp"
chmod -R a+rX                          "$STAGE/usr/lib/gobbonet"
chmod 0755 "$STAGE/usr/lib/gobbonet/llama-cpp/llama-server"
if [ "$BUNDLE_CPU" = "1" ]; then
    cp -r "$VENDOR/llama-cpp-cpu" "$STAGE/usr/lib/gobbonet/llama-cpp-cpu"
    chmod -R a+rX "$STAGE/usr/lib/gobbonet/llama-cpp-cpu"
    chmod 0755 "$STAGE/usr/lib/gobbonet/llama-cpp-cpu/llama-server"
fi

# So the command works from a terminal too.
ln -sf /usr/lib/gobbonet/gobbonet "$STAGE/usr/bin/gobbonet"

install -m 0644 gobbonet.desktop "$STAGE/usr/share/applications/gobbonet.desktop"
if [ -f icon/gobbonet-256.png ]; then
    install -m 0644 icon/gobbonet-256.png \
        "$STAGE/usr/share/icons/hicolor/256x256/apps/gobbonet.png"
else
    fail "icon/gobbonet-256.png is missing — run ./make-icon.sh"
fi

install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/gobbonet/copyright"
install -m 0644 README.md       "$STAGE/usr/share/doc/gobbonet/README.md"

install -m 0755 postinst "$STAGE/DEBIAN/postinst"
install -m 0755 postrm   "$STAGE/DEBIAN/postrm"

INSTALLED_KB="$(du -sk "$STAGE" | cut -f1)"

# The description has to describe what actually shipped. A package that claims
# an engine it does not carry is the same class of error the payload guard
# exists to prevent, just written in prose instead of bytes.
if [ "$BUNDLE_CPU" = "1" ]; then
    ENGINE_BLURB=" in both Vulkan-accelerated and CPU-only
 builds, and picks whichever works on your hardware."
else
    ENGINE_BLURB=" with Vulkan acceleration, falling back to
 the CPU backends it also carries when no Vulkan driver is present."
fi

cat > "$STAGE/DEBIAN/control" <<EOF
Package: gobbonet
Version: $DEB_VERSION
Section: net
Priority: optional
Architecture: amd64
Maintainer: Elodine <https://github.com/ElodineOfficial>
Installed-Size: $INSTALLED_KB
Depends: libc6 (>= $LIBC_MIN), xdg-utils
Recommends: libvulkan1, mesa-vulkan-drivers | vulkan-driver, curl, zenity
Homepage: https://github.com/ElodineOfficial/GobboNet
Description: Local AI chat for local models
 GobboNet is a chat front end for language models running on your own
 machine. No account, no API key, no telemetry, no corpo middleman —
 what you type stays on the machine you type it on.
 .
 This package bundles the llama.cpp engine$ENGINE_BLURB Models are
 downloaded on first run from a catalogue; nothing is fetched without
 asking.
 .
 Config, conversations and models live in your own home directory and are
 left alone when the package is removed. Use "gobbonet uninstall" to clear
 them.
EOF

# ---------------------------------------------------------------------------
mkdir -p "$OUT"
DEB="$OUT/gobbonet_${DEB_VERSION}_amd64.deb"
rm -f "$DEB"

# Root-owned program files without needing to be root to build.
if command -v fakeroot >/dev/null 2>&1; then
    fakeroot dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null
else
    dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null
fi

# ---------------------------------------------------------------------------
# Last guard: size. ~35 MB is the engines. ~3.5 MB means they did not make it
# in, whatever the checks above thought.
# ---------------------------------------------------------------------------
# Guard on the INSTALLED size, not the compressed one.
#
# Compressed size is a bad signal here and the first version of this check got
# it wrong: libggml-vulkan.so is 52 MB of SPIR-V shader bytecode that gzips to
# under 16 MB, so a complete 101 MB payload produces a ~20 MB .deb. Guarding on
# that number rejects good packages. Installed size is deterministic.
INSTALLED_MB=$(( INSTALLED_KB / 1024 ))
DEB_MB=$(( $(stat -c %s "$DEB") / 1024 / 1024 ))
FLOOR=60
[ "$BUNDLE_CPU" = "1" ] && FLOOR=95
if [ "$INSTALLED_MB" -lt "$FLOOR" ]; then
    fail "the package installs only ${INSTALLED_MB} MB, and should install at least
       ${FLOOR} MB. That means the engine did not make it into the payload,
       whatever the checks above concluded."
fi

echo
say "built $(basename "$DEB")"
say "  ${DEB_MB} MB compressed, ${INSTALLED_MB} MB installed"
say "  version: $DEB_VERSION"
say "  libc6 floor: $LIBC_MIN"
echo
sha256sum "$DEB"
