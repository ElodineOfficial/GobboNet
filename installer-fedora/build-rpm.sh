#!/usr/bin/env bash
# Build the Fedora RPM. The counterpart to installer-linux/build-deb.sh, and
# deliberately the same shape so the two can be read side by side.
#
#   ./build-rpm.sh                       fetch (or reuse) the pinned engine, build
#   SKIP_ENGINE_FETCH=1 ./build-rpm.sh   never download: use the engine archive
#                                        already in vendor/ (still hash-checked)
#   REUSE_DEB=/path/to.deb ./build-rpm.sh
#                                        take the engine out of an existing .deb
#                                        instead of downloading it again
#   GOBBONET_BIN=/path/to/gobbonet ./build-rpm.sh
#                                        the linux/amd64 server to package
#   BUNDLE_CPU_ENGINE=1 ./build-rpm.sh   also ship the CPU-only engine
#   RPM_REVISION=2 ./build-rpm.sh        a packaging-only rebuild of one release
#   DIST=.fc45 ./build-rpm.sh            tag a specific Fedora release
#   RPM_SIGN_KEY=<gpg key id> ./build-rpm.sh
#                                        sign the package (off by default)
#
# What this does NOT do is compile anything. The Go binary comes from
# ../build-release.sh, exactly as the .deb expects, because a package that
# silently rebuilds its own payload can ship something the maintainer never
# tested. What it DOES do, before and after rpmbuild, is check: the engine
# against its pin, the binary against VERSION, the staged tree against
# payload.manifest, and the finished package against check-rpm.sh. A package
# that fails any of them is not left in dist/.
set -euo pipefail

# A package is a public artifact. Nothing staged here may inherit a private
# umask: 1.7.3's first .deb shipped a root-owned 0700 directory that way, and
# the rpm copies directory modes straight out of the staged tree.
umask 022

cd "$(dirname "$0")"
HERE="$(pwd)"
ROOT="$(cd .. && pwd)"
VENDOR="$HERE/vendor"
STAGE="$HERE/stage"
OUT="$HERE/dist"
TOPDIR="$HERE/rpmbuild"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Tools. Named up front, with the package that provides each, rather than
# discovered half way through a build.
# ---------------------------------------------------------------------------
need_tool() { # tool, fedora package, debian package
    command -v "$1" >/dev/null 2>&1 || fail "$1 is required.
       Fedora:        sudo dnf install $2
       Debian/Ubuntu: sudo apt install $3"
}
need_tool rpmbuild rpm-build rpm
need_tool rpm2cpio rpm       rpm2cpio
need_tool cpio     cpio      cpio
need_tool file     file      file
need_tool tar      tar       tar
need_tool realpath coreutils coreutils

# ---------------------------------------------------------------------------
# Version, from the same VERSION file build-release.sh and build-deb.sh use, so
# the package and the binary cannot disagree about what release this is.
# ---------------------------------------------------------------------------
[ -f "$ROOT/VERSION" ] || fail "$ROOT/VERSION is missing"
RELEASE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$RELEASE" ] || fail "$ROOT/VERSION is empty"

# ---------------------------------------------------------------------------
# The engine pin. Read from engine.sha256 exactly as build-deb.sh reads it, so
# the .deb, the .rpm and the .exe carrying one version number carry one engine.
#
# This used to hardcode LLAMA_BUILD=b10456 and only grep the hash out of the
# pin file. Bumping the pin would then have fetched the OLD archive and checked
# it against the NEW hash -- a failure, at least, but one that named neither
# cause -- and with the pin file absent it verified nothing at all.
#
# The env var is captured BEFORE sourcing, because the pin file assigns
# LLAMA_BUILD unconditionally and would otherwise silently override a one-off
# build someone asked for on the command line. (A one-off build still has to
# match a pinned hash, so in practice it means editing engine.sha256.)
# ---------------------------------------------------------------------------
[ -f "$ROOT/engine.sha256" ] || fail "engine.sha256 is missing from $ROOT.
       The engine pin is not optional: it is the only thing that says which
       llama.cpp this package carries."
_env_llama_build="${LLAMA_BUILD:-}"
# shellcheck disable=SC1091
. "$ROOT/engine.sha256"
LLAMA_BUILD="${_env_llama_build:-${LLAMA_BUILD:-}}"
[ -n "$LLAMA_BUILD" ] || fail "engine.sha256 does not name a LLAMA_BUILD"
LLAMA_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}"
GPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz"
CPU_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"
GPU_SHA256="${GPU_SHA256:-}"
CPU_SHA256="${CPU_SHA256:-}"
BUNDLE_CPU="${BUNDLE_CPU_ENGINE:-0}"
REUSE_DEB="${REUSE_DEB:-}"

# ---------------------------------------------------------------------------
# The Go binary. Built by ../build-release.sh, never here.
#
# Looked for in this order: GOBBONET_BIN; this release's linux/amd64 build in
# ../dist; the release binary the ZIP ships at linux-amd64/gobbonet. Whichever
# it is must SAY it is this release -- a stale binary in the tree is exactly
# how 1.7.4 once shipped a 1.7.3 server.
# ---------------------------------------------------------------------------
GOBBONET_BIN="${GOBBONET_BIN:-}"
if [ -z "$GOBBONET_BIN" ]; then
    GOBBONET_BIN="$(find "$ROOT/dist" -type f -name gobbonet -path "*$RELEASE-go-*linux-amd64*" \
                        -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
fi
if [ -z "$GOBBONET_BIN" ] && [ -f "$ROOT/linux-amd64/gobbonet" ]; then
    GOBBONET_BIN="$ROOT/linux-amd64/gobbonet"
fi
[ -n "$GOBBONET_BIN" ] && [ -f "$GOBBONET_BIN" ] || fail \
"no linux/amd64 gobbonet binary found.
       Run ../build-release.sh first, or set GOBBONET_BIN=/path/to/gobbonet"

case "$(file -b "$GOBBONET_BIN" 2>/dev/null)" in
    *"ELF 64-bit"*x86-64*) ;;
    *) fail "$GOBBONET_BIN is not a linux/amd64 ELF binary" ;;
esac

# `gobbonet version` has no side effects -- it writes nothing, anywhere -- so it
# is safe to ask the binary what it is.
BIN_VERSION="$("$GOBBONET_BIN" version 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
[ -n "$BIN_VERSION" ] || fail "could not run '$GOBBONET_BIN version'.
       The binary has to be runnable on this build host so the package can
       confirm which release it is carrying."
case "$BIN_VERSION" in
    "$RELEASE-go-"?*) ;;
    *) fail "$GOBBONET_BIN reports $BIN_VERSION, but VERSION says $RELEASE.
       Rebuild it with ../build-release.sh, or point GOBBONET_BIN at the right one." ;;
esac
say "binary: $GOBBONET_BIN ($BIN_VERSION)"

# ---------------------------------------------------------------------------
# Release: <revision>.go.<build id>
#
# RPM's Version is the upstream version and must stay clean, so the build id
# goes in Release. It is taken from the BINARY -- the part after "<VERSION>-go-"
# in its own version string -- not from git or from today's date. The package
# is a wrapper around that binary, and its name should name the build inside
# it: a nogit build from the 24th packaged on the 25th is still .20260924, and
# a package built from a checkout whose HEAD moved on still names the commit
# the binary was built from.
#
# RPM_REVISION counts packaging-only rebuilds of one release, like
# DEB_REVISION, and resets to 1 when VERSION moves. Anything that is not legal
# in an RPM Release field becomes a dot.
# ---------------------------------------------------------------------------
BUILD_ID="${BIN_VERSION#"$RELEASE-go-"}"
RPM_REVISION="${RPM_REVISION:-1}"
case "$RPM_REVISION" in
    ''|*[!0-9]*) fail "RPM_REVISION must be a positive integer, got '$RPM_REVISION'" ;;
esac
PKG_RELEASE="${RPM_REVISION}.go.$(printf '%s' "$BUILD_ID" | tr -c 'A-Za-z0-9.' '.')"
# .fedora, as 1.7.3-3 shipped: one package for every current Fedora release,
# since nothing in it is built against a particular one.
DIST="${DIST-.fedora}"
case "$DIST" in
    ''|.[A-Za-z0-9]*) ;;
    *) fail "DIST must be empty or start with a dot (.fedora, .fc45), got '$DIST'" ;;
esac

# ---------------------------------------------------------------------------
# Engine into vendor/. Same fetch, same verification, same guards as the .deb.
# ---------------------------------------------------------------------------
fetch_engine() { # asset, pinned sha256, destination
    local asset="$1" want="$2" dest="$3"
    local tarball="$VENDOR/$asset"

    mkdir -p "$VENDOR"
    if [ ! -f "$tarball" ]; then
        [ "${SKIP_ENGINE_FETCH:-0}" = "1" ] && fail "$tarball is missing and SKIP_ENGINE_FETCH=1.
       Put the archive there, or drop SKIP_ENGINE_FETCH to download it."
        command -v curl >/dev/null 2>&1 || fail "curl is needed to download $asset"
        say "engine: fetching $asset"
        curl -fL --retry 3 -o "$tarball.part" "$LLAMA_BASE/$asset" \
            || { rm -f "$tarball.part"; fail "could not download $asset from $LLAMA_BASE"; }
        mv "$tarball.part" "$tarball"
    fi

    # Verified on every build, cached or not. A cached archive is exactly the
    # thing nobody looks at again.
    [ -n "$want" ] || fail "no pinned SHA-256 for $asset in engine.sha256"
    local got
    got="$(sha256sum "$tarball" | cut -d' ' -f1)"
    [ "$got" = "$want" ] || fail "SHA-256 mismatch for $asset
       expected: $want
       actual:   $got
       Either the pin in engine.sha256 is stale or the download is not what it
       claims to be. Do not paper over this."
    say "engine: $asset sha256 verified against engine.sha256"

    # Upstream has moved the binaries between build/bin/ and the archive root
    # across releases, so find llama-server rather than assuming its depth.
    rm -rf "$dest"; mkdir -p "$dest"
    tar xzf "$tarball" -C "$dest" --strip-components=1 2>/dev/null || true
    if [ -z "$(find "$dest" -type f -name llama-server -print -quit)" ]; then
        rm -rf "$dest"; mkdir -p "$dest"
        tar xzf "$tarball" -C "$dest"
    fi
    local found
    found="$(find "$dest" -type f -name llama-server -print -quit)"
    [ -n "$found" ] || fail "no llama-server inside $asset"
    if [ "$(dirname "$found")" != "$dest" ]; then
        cp -a "$(dirname "$found")/." "$dest/"
    fi
}

GPU_SOURCE=""
CPU_SOURCE=""
if [ -n "$REUSE_DEB" ]; then
    # Lifting the engine out of a .deb we already built is exact and offline:
    # the same upstream archive, unpacked and verified when that package was
    # made. Its ENGINE.txt says which build it is, and has to say this one.
    [ -f "$REUSE_DEB" ] || fail "REUSE_DEB=$REUSE_DEB does not exist"
    need_tool dpkg-deb dpkg dpkg
    say "engine: extracting from $(basename "$REUSE_DEB")"
    debtmp="$(mktemp -d)"
    trap 'rm -rf "$debtmp"' EXIT
    dpkg-deb -x "$REUSE_DEB" "$debtmp" 2>/dev/null || fail "could not unpack $REUSE_DEB"
    [ -d "$debtmp/usr/lib/gobbonet/llama-cpp" ] || fail "no llama-cpp in $REUSE_DEB"
    if [ -f "$debtmp/usr/lib/gobbonet/llama-cpp/ENGINE.txt" ]; then
        grep -q "^llama.cpp build: *$LLAMA_BUILD\$" "$debtmp/usr/lib/gobbonet/llama-cpp/ENGINE.txt" \
            || fail "$(basename "$REUSE_DEB") carries a different engine than the $LLAMA_BUILD pin:
$(sed 's/^/         /' "$debtmp/usr/lib/gobbonet/llama-cpp/ENGINE.txt")"
    else
        say "WARNING: $(basename "$REUSE_DEB") predates ENGINE.txt; its engine build cannot be confirmed"
    fi
    mkdir -p "$VENDOR"
    rm -rf "$VENDOR/llama-cpp" "$VENDOR/llama-cpp-cpu"
    cp -a "$debtmp/usr/lib/gobbonet/llama-cpp" "$VENDOR/llama-cpp"
    rm -f "$VENDOR/llama-cpp/ENGINE.txt"   # rewritten below, for this package
    if [ "$BUNDLE_CPU" = "1" ]; then
        [ -d "$debtmp/usr/lib/gobbonet/llama-cpp-cpu" ] \
            || fail "BUNDLE_CPU_ENGINE=1, but $(basename "$REUSE_DEB") has no CPU engine"
        cp -a "$debtmp/usr/lib/gobbonet/llama-cpp-cpu" "$VENDOR/llama-cpp-cpu"
        rm -f "$VENDOR/llama-cpp-cpu/ENGINE.txt"
    fi
    rm -rf "$debtmp"
    trap - EXIT
    GPU_SOURCE="lifted from $(basename "$REUSE_DEB")"
    CPU_SOURCE="$GPU_SOURCE"
else
    fetch_engine "$GPU_ASSET" "$GPU_SHA256" "$VENDOR/llama-cpp"
    GPU_SOURCE="sha256 $GPU_SHA256, verified against engine.sha256"
    if [ "$BUNDLE_CPU" = "1" ]; then
        fetch_engine "$CPU_ASSET" "$CPU_SHA256" "$VENDOR/llama-cpp-cpu"
        CPU_SOURCE="sha256 $CPU_SHA256, verified against engine.sha256"
    else
        # A CPU engine left in vendor/ by an earlier BUNDLE_CPU_ENGINE=1 build is
        # not an instruction to ship one.
        rm -rf "$VENDOR/llama-cpp-cpu"
    fi
fi

# ---------------------------------------------------------------------------
# Engine guards, the same three the .deb applies. A package can otherwise ship
# with a stub engine, and nothing notices until a user tries to load a model.
#
# llama-server is a ~17 KB launcher stub in current upstream builds; the engine
# itself is libllama-server-impl.so, libllama.so and the libggml-*.so backends.
# So the stub is checked for being an ELF rather than a script, and the size
# test is applied to the library that actually carries the engine.
# ---------------------------------------------------------------------------
guard_engine() { # dir, label
    local dir="$1" label="$2"
    local stub="$dir/llama-server"
    [ -f "$stub" ] || fail "$label: $stub is missing."
    file "$stub" | grep -q 'ELF 64-bit' \
        || fail "$label: $stub is not an ELF binary -- it looks like $(file -b "$stub")."
    local impl
    impl="$(find "$dir" -maxdepth 1 \( -name 'libllama-server-impl.so*' -o -name 'libllama.so*' \) \
            -type f -print -quit)"
    [ -n "$impl" ] || fail "$label: no libllama*.so beside llama-server -- this is not a real engine."
    local size
    size="$(stat -c %s "$impl")"
    [ "$size" -ge 1000000 ] || fail "$label: $(basename "$impl") is only $((size / 1024)) KB, a stub."
    local total
    total="$(du -sm "$dir" | cut -f1)"
    [ "$total" -ge 25 ] || fail "$label: the engine directory is only ${total} MB; expect ~40 MB
       CPU-only and ~90 MB with the Vulkan backend."
    say "$label: ELF stub + $(basename "$impl") $((size / 1024 / 1024)) MB, ${total} MB total -- ok"
}
guard_engine "$VENDOR/llama-cpp" "GPU engine"
if [ "$BUNDLE_CPU" = "1" ]; then
    guard_engine "$VENDOR/llama-cpp-cpu" "CPU engine"
fi
ls "$VENDOR/llama-cpp"/libggml-vulkan.so* >/dev/null 2>&1 || fail \
"the GPU engine has no libggml-vulkan.so, so it is a CPU-only build.
       A package built from it would ignore gpu_layers entirely and run every
       model on the processor, with nothing to say so."
[ -f "$VENDOR/llama-cpp/LICENSE" ] || fail "the engine archive has no LICENSE; llama.cpp's licence must ship with it"

# No frontend staging here. It is compiled into the gobbonet binary this script
# is handed (internal/webui), so it arrives with the binary and the two cannot
# drift. build-release.sh runs stage-web.sh before it builds.

# ---------------------------------------------------------------------------
# Payload tree, laid out the way the .deb lays it out. The spec relocates
# /usr/lib to %{_libdir} at install time; keeping the staged tree identical to
# Debian's means one layout to reason about, not two.
# ---------------------------------------------------------------------------
say "staging payload"
rm -rf "$STAGE"
install -d -m 0755 \
    "$STAGE/usr/lib/gobbonet" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps" \
    "$STAGE/usr/share/doc/gobbonet"

install -m 0755 "$GOBBONET_BIN" "$STAGE/usr/lib/gobbonet/gobbonet"
# Shared with the .deb rather than forked: one launcher, one wizard, one set of
# bugs. The spec rewrites the wizard's two Debian-specific lines.
install -m 0755 "$ROOT/installer-linux/gobbonet-launch"   "$STAGE/usr/lib/gobbonet/gobbonet-launch"
install -m 0644 "$ROOT/installer-linux/gobbonet-setup.py" "$STAGE/usr/lib/gobbonet/gobbonet-setup.py"
install -m 0644 "$ROOT/installer-linux/wizard.html"       "$STAGE/usr/lib/gobbonet/wizard.html"
install -m 0644 "$ROOT/installer/models.ini"              "$STAGE/usr/lib/gobbonet/models.ini"
cp -a "$VENDOR/llama-cpp" "$STAGE/usr/lib/gobbonet/llama-cpp"
if [ "$BUNDLE_CPU" = "1" ]; then
    cp -a "$VENDOR/llama-cpp-cpu" "$STAGE/usr/lib/gobbonet/llama-cpp-cpu"
fi

# The same marker the .deb and the Windows payload carry. Without it the
# bundled engine is anonymous once installed, and "which engine are you on?"
# has no answer short of hashing shared objects.
write_engine_marker() { # dir, asset, backend description, provenance
    cat > "$1/ENGINE.txt" <<ENGINEEOF
llama.cpp build: $LLAMA_BUILD
asset:           $2
backend:         $3
source:          $4
bundled by:      GobboNet $RELEASE-$PKG_RELEASE$DIST (rpm)
ENGINEEOF
}
write_engine_marker "$STAGE/usr/lib/gobbonet/llama-cpp" "$GPU_ASSET" \
    "vulkan (with the CPU backends it also carries)" "$GPU_SOURCE"
if [ "$BUNDLE_CPU" = "1" ]; then
    write_engine_marker "$STAGE/usr/lib/gobbonet/llama-cpp-cpu" "$CPU_ASSET" "cpu" "$CPU_SOURCE"
fi

install -m 0644 "$ROOT/installer-linux/gobbonet.desktop" "$STAGE/usr/share/applications/gobbonet.desktop"
install -m 0644 "$ROOT/installer-linux/icon/gobbonet-256.png" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps/gobbonet.png"
install -m 0644 "$HERE/FEDORA.md"            "$STAGE/usr/share/doc/gobbonet/FEDORA.md"
install -m 0644 "$ROOT/LICENSE"              "$STAGE/usr/share/doc/gobbonet/LICENSE"
install -m 0644 "$VENDOR/llama-cpp/LICENSE"  "$STAGE/usr/share/doc/gobbonet/LICENSE.llama-cpp"

# Public modes, whatever the archive or the checkout had: directories 0755,
# every file readable by everyone and writable by no one but its owner,
# executable bits kept where upstream set them. check-rpm.sh then proves the
# finished package came out that way.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod u+rw,go+r,go-w {} +
chmod 0755 "$STAGE/usr/lib/gobbonet/gobbonet" "$STAGE/usr/lib/gobbonet/gobbonet-launch" \
           "$STAGE/usr/lib/gobbonet/llama-cpp/llama-server"

# Before anything is packaged. A mismatch here is a package that would install
# and not work, and finding that out at build time costs nothing.
"$ROOT/verify-payload.sh" "$STAGE/usr/lib/gobbonet" "rpm payload"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
rm -rf "$TOPDIR" && mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
tar --owner=0 --group=0 --numeric-owner -czf "$TOPDIR/SOURCES/gobbonet-payload.tar.gz" -C "$STAGE" usr
cp "$HERE/gobbonet.spec" "$TOPDIR/SPECS/"

defines=(
    --define "_topdir $TOPDIR"
    --define "gn_version $RELEASE"
    --define "gn_release $PKG_RELEASE"
    --define "gn_llama_build $LLAMA_BUILD"
)
if [ -n "$DIST" ]; then
    defines+=(--define "dist $DIST")
else
    defines+=(--define "dist %{nil}")
fi
# Reproducible builds: with SOURCE_DATE_EPOCH set, the package's build time and
# file times come from it rather than from the clock.
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
    defines+=(--define "use_source_date_epoch_as_buildtime 1"
              --define "clamp_mtime_to_source_date_epoch 1")
fi

say "building rpm ${RELEASE}-${PKG_RELEASE}${DIST}"
rpmbuild -bb "${defines[@]}" "$TOPDIR/SPECS/gobbonet.spec" > "$TOPDIR/build.log" 2>&1 \
    || { tail -30 "$TOPDIR/build.log" >&2; fail "rpmbuild failed (full log: $TOPDIR/build.log)"; }

BUILT="$(find "$TOPDIR/RPMS" -name '*.rpm' -print -quit)"
[ -n "$BUILT" ] || fail "rpmbuild produced no package"
mkdir -p "$OUT"
RPM="$OUT/$(basename "$BUILT")"
cp "$BUILT" "$RPM"

# ---------------------------------------------------------------------------
# Optional signing. Off unless asked for.
#
# Fedora 45 turned on rpm's signature enforcement: `rpm -i` refuses an unsigned
# package there. `dnf install ./gobbonet-*.rpm`, the documented way in, does not
# -- dnf skips OpenPGP checks for a file named on its command line -- so an
# unsigned package installs on every current Fedora. Signing is for anyone who
# wants `rpm -i` to work too; users then import the public key once with
# `sudo rpm --import`.
# ---------------------------------------------------------------------------
if [ -n "${RPM_SIGN_KEY:-}" ]; then
    command -v rpmsign >/dev/null 2>&1 || fail "RPM_SIGN_KEY is set but rpmsign is missing
       Fedora: sudo dnf install rpm-sign    Debian/Ubuntu: sudo apt install rpm"
    say "signing with key $RPM_SIGN_KEY"
    rpmsign --addsign --define "_gpg_name $RPM_SIGN_KEY" "$RPM" >/dev/null \
        || { rm -f "$RPM"; fail "rpmsign failed; nothing left in dist/"; }
fi

# ---------------------------------------------------------------------------
# The contract. A package that fails it is removed from dist/: something that
# builds but would install broken must not sit there looking shippable.
# ---------------------------------------------------------------------------
echo
if ! "$HERE/check-rpm.sh" "$RPM"; then
    rm -f "$RPM"
    fail "the package does not meet check-rpm.sh; it was removed from dist/.
       The rejected build is still at $BUILT for inspection."
fi

echo
say "built:   $RPM"
say "version: ${RELEASE}-${PKG_RELEASE}${DIST}"
say "engine:  $LLAMA_BUILD"
say "size:    $(( $(stat -c %s "$RPM") / 1024 / 1024 )) MB"
echo
sha256sum "$RPM" | sed 's|  .*/|  |'
echo
say "Install with:  sudo dnf install ./$(basename "$RPM")"
say "(dnf, not rpm -i: Fedora 45 and later refuse unsigned packages through rpm -i)"
