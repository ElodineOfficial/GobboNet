#!/usr/bin/env bash
#
# Build GobboNet as an AppImage, from the .deb (issue #53).
#
#   bash ./build-deb.sh && bash ./build-appimage.sh  the newest dist/gobbonet_*_amd64.deb
#   bash ./build-appimage.sh path/to/gobbonet_<version>_amd64.deb
#   SKIP_RUNTIME_FETCH=1 bash ./build-appimage.sh    use the runtime already in vendor/
#
# Needs squashfs-tools with zstd (`mksquashfs`), python3, and dpkg-deb or
# ar + tar to unpack the .deb.
#
# An AppImage is one file: a small runtime program followed by a squashfs image
# of a folder, the AppDir. Running it mounts the image and starts AppDir/AppRun.
# The AppDir here is the .deb's own files, unpacked, so the AppImage carries
# byte for byte what the package installs into /usr/lib/gobbonet -- the same
# binary, engine, launcher and catalogue -- and nothing the package does not.
#
# The approach is Deven-Eve's from issue #53: an AppImage made from the
# official .deb, tested on CachyOS with KDE Plasma. Two things differ:
#
#   - No appimagetool. The image is made with mksquashfs and joined to the
#     runtime with cat. The runtime is downloaded once and pinned by SHA-256,
#     like the engine, so every byte of the result is either built here or
#     pinned. appimagetool is itself an AppImage that fetches a runtime of its
#     own at build time, which is one more unpinned download than this needs.
#   - No update information. An AppImage can carry an address it checks for
#     newer versions at; this one carries none, and the build checks that.
#     GobboNet makes no connection nobody asked for, and its AppImage doesn't
#     either.
#
# Like build-deb.sh, everything is checked before the image is written. An
# AppImage that builds but has no working engine fails on someone else's
# machine instead of on ours.

set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
VENDOR="$(pwd)/vendor"
STAGE="$(pwd)/stage-appimage"
OUT="$(pwd)/dist"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# The runtime: AppImage's static type 2 runtime, which mounts the image with
# its own FUSE code (only `fusermount` is needed on the user's machine) and
# makes no network connection of its own.
#
# Pinned to a dated release, not "continuous", which upstream replaces in
# place. The hash below was recorded from the 20251108 release download and
# checked against its detached signature (runtime-x86_64.sig), which verifies
# with signing-pubkey.asc from the type2-runtime repository at that tag:
#
#   570C 77AC EA40 C0F1 B758  902C BF96 CCA5 6490 F695
#   AppImage type 2 runtime <type2-runtime@appimage.org>
#
# Moving to another release means changing both values in the same commit,
# after the same check. A tag without a hash is refused, not trusted.
# ---------------------------------------------------------------------------
RUNTIME_TAG="${APPIMAGE_RUNTIME_TAG:-20251108}"
if [ -n "${APPIMAGE_RUNTIME_TAG:-}" ] && [ -z "${APPIMAGE_RUNTIME_SHA256:-}" ]; then
    fail "APPIMAGE_RUNTIME_TAG=$RUNTIME_TAG was given without APPIMAGE_RUNTIME_SHA256.
       Verify that release's runtime-x86_64, then pass its hash too."
fi
RUNTIME_SHA256="${APPIMAGE_RUNTIME_SHA256:-2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d}"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/${RUNTIME_TAG}/runtime-x86_64"
RUNTIME="$VENDOR/appimage-runtime-${RUNTIME_TAG}-x86_64"

# ---------------------------------------------------------------------------
# Tools, checked up front so a missing one is named rather than discovered.
# ---------------------------------------------------------------------------
command -v mksquashfs >/dev/null 2>&1 || fail "mksquashfs not found.
       Install squashfs-tools:  sudo apt install squashfs-tools
                                sudo dnf install squashfs-tools
                                sudo pacman -S squashfs-tools"
command -v python3 >/dev/null 2>&1 || fail "python3 not found."
if ! command -v dpkg-deb >/dev/null 2>&1; then
    command -v ar >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 \
        || fail "neither dpkg-deb nor ar + tar is available to unpack the .deb."
fi

# The runtime reads zlib and zstd images only; an xz one builds fine and then
# fails to mount with "please check your FUSE setup", which points the user at
# the wrong problem entirely. So the image is zstd, and a mksquashfs built
# without it is refused here.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
mkdir "$probe/d"
mksquashfs "$probe/d" "$probe/p.sqfs" -comp zstd -noappend -quiet >/dev/null 2>&1 \
    || fail "this mksquashfs cannot write zstd images, and the AppImage runtime
       reads only zlib and zstd. Install a squashfs-tools built with zstd."

# ---------------------------------------------------------------------------
# The .deb.
# ---------------------------------------------------------------------------
DEB="${1:-}"
if [ -z "$DEB" ]; then
    # shellcheck disable=SC2012  # names are ours: gobbonet_<version>_amd64.deb
    DEB="$(ls -t "$OUT"/gobbonet_*_amd64.deb 2>/dev/null | head -1 || true)"
fi
[ -n "$DEB" ] && [ -f "$DEB" ] || fail "no .deb to build from.
       Run bash ./build-deb.sh first, or name one:  bash ./build-appimage.sh path/to/gobbonet_X_amd64.deb"
DEB="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"
say "from $(basename "$DEB")"

rm -rf "$STAGE"
APPDIR="$STAGE/GobboNet.AppDir"
mkdir -p "$APPDIR"
if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$DEB" "$APPDIR"
    CONTROL="$(dpkg-deb -f "$DEB")"
else
    # The portable route, for building on a distribution without dpkg (the
    # issue was built on CachyOS). A .deb is an ar archive of control.tar.*
    # and data.tar.*; tar picks the decompressor from the contents.
    mkdir "$STAGE/deb"
    (cd "$STAGE/deb" && ar x "$DEB")
    tar -xf "$STAGE/deb"/data.tar.* -C "$APPDIR"
    tar -xf "$STAGE/deb"/control.tar.* -C "$STAGE/deb" ./control 2>/dev/null \
        || tar -xf "$STAGE/deb"/control.tar.* -C "$STAGE/deb" control
    CONTROL="$(cat "$STAGE/deb/control")"
fi
VERSION="$(printf '%s\n' "$CONTROL" | sed -n 's/^Version: *//p')"
LIBC_MIN="$(printf '%s\n' "$CONTROL" | sed -n 's/^Depends:.*libc6 (>= \([0-9.]*\)).*/\1/p')"
[ -n "$VERSION" ] || fail "could not read the version from $(basename "$DEB")"
say "version: $VERSION"

LIB="$APPDIR/usr/lib/gobbonet"

# ---------------------------------------------------------------------------
# The payload: the same list both Linux packages are held to, and the same
# engine checks build-deb.sh makes, so a .deb that slipped past them -- or one
# from somewhere else -- is caught here instead of in a stranger's launch.log.
# ---------------------------------------------------------------------------
bash "$ROOT/scripts/verify-payload.sh" "$LIB" "AppImage payload"
[ -f "$LIB/llama-cpp/llama-server" ] && file "$LIB/llama-cpp/llama-server" | grep -q 'ELF 64-bit' \
    || fail "the .deb has no llama-server ELF in usr/lib/gobbonet/llama-cpp."
ls "$LIB/llama-cpp"/libggml-vulkan.so* >/dev/null 2>&1 \
    || fail "the .deb's engine has no libggml-vulkan.so, so it is a CPU-only build."
PAYLOAD_MB="$(du -sm "$LIB" | cut -f1)"
[ "$PAYLOAD_MB" -ge 60 ] || fail "usr/lib/gobbonet is only ${PAYLOAD_MB} MB; the engine did not make it in."
say "payload: ${PAYLOAD_MB} MB, engine present -- ok"

# ---------------------------------------------------------------------------
# The AppDir's own files: the entry point, the menu entry and the icon. An
# AppImage manager (Gear Lever, AppImageLauncher) reads the .desktop and icon
# at the top of the AppDir to add GobboNet to the menu, and points Exec at the
# .AppImage file itself -- so Exec is a bare name here, as the format asks.
# ---------------------------------------------------------------------------
install -m 0755 AppRun "$APPDIR/AppRun"
sed -e 's|^Exec=.*|Exec=gobbonet|' "$APPDIR/usr/share/applications/gobbonet.desktop" \
    > "$APPDIR/gobbonet.desktop"
printf 'X-AppImage-Version=%s\n' "$VERSION" >> "$APPDIR/gobbonet.desktop"
chmod 0644 "$APPDIR/gobbonet.desktop"
grep -qx 'Exec=gobbonet' "$APPDIR/gobbonet.desktop" || fail "could not set Exec in the AppImage's .desktop"
install -m 0644 "$APPDIR/usr/share/icons/hicolor/256x256/apps/gobbonet.png" "$APPDIR/gobbonet.png"
ln -sf gobbonet.png "$APPDIR/.DirIcon"
if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$APPDIR/gobbonet.desktop" || fail "the AppImage's .desktop does not validate"
fi
# The .deb's /usr/bin/gobbonet is an absolute link to /usr/lib/gobbonet. Inside
# an image that names the host's copy -- an installed .deb, if there is one, or
# nothing -- so it is made relative, to the launcher beside it in the image.
[ -L "$APPDIR/usr/bin/gobbonet" ] || fail "the .deb has no usr/bin/gobbonet link"
ln -sfn ../lib/gobbonet/gobbonet-launch "$APPDIR/usr/bin/gobbonet"
[ -f "$APPDIR/usr/bin/gobbonet" ] || fail "usr/bin/gobbonet does not resolve inside the AppDir"
if find "$APPDIR" -type l -lname '/*' | grep -q .; then
    fail "absolute links in the AppDir, which would point at the host:
$(find "$APPDIR" -type l -lname '/*' -printf '         %P -> %l\n')"
fi
# The Debian control scripts did not come along (dpkg-deb -x leaves them out,
# and so does the ar route), but say so rather than assume it.
[ ! -e "$APPDIR/DEBIAN" ] || fail "DEBIAN/ found in the AppDir"

# ---------------------------------------------------------------------------
# Fetch and verify the runtime.
# ---------------------------------------------------------------------------
mkdir -p "$VENDOR"
if [ ! -f "$RUNTIME" ]; then
    [ "${SKIP_RUNTIME_FETCH:-0}" = "1" ] && fail "$RUNTIME is missing and SKIP_RUNTIME_FETCH=1"
    say "fetching the AppImage runtime ($RUNTIME_TAG)"
    curl -fL --retry 3 -o "$RUNTIME.part" "$RUNTIME_URL" || fail "could not download $RUNTIME_URL"
    mv "$RUNTIME.part" "$RUNTIME"
fi
got="$(sha256sum "$RUNTIME" | cut -d' ' -f1)"
[ "$got" = "$RUNTIME_SHA256" ] || fail "SHA-256 mismatch for the AppImage runtime ($RUNTIME_TAG)
       expected: $RUNTIME_SHA256
       actual:   $got
       Refusing to build. Either the download is corrupt or the pin is stale."
say "runtime $RUNTIME_TAG: SHA-256 matches the pin -- ok"

# ---------------------------------------------------------------------------
# Build. SOURCE_DATE_EPOCH, when set, is honoured by mksquashfs for every
# timestamp in the image, so a reproducible build stays one.
# ---------------------------------------------------------------------------
mkdir -p "$OUT"
# Named for the package it was made from, without the "+" (1.8.0). GitHub
# drops a "+" from the name of a file attached to a release -- 1.7.9's went up
# as GobboNet-1.7.9go.nogit.20261102-1-x86_64.AppImage -- and the update file
# (scripts/make-update-manifest.sh) names the AppImage as the release lists
# it, so it is built under that name: the one users download, and the one the
# update button looks for.
NAME_VERSION="$(printf '%s' "$VERSION" | tr -d '+')"
APPIMAGE="$OUT/GobboNet-${NAME_VERSION}-x86_64.AppImage"
SQFS="$STAGE/image.sqfs"
mksquashfs "$APPDIR" "$SQFS" -comp zstd -all-root -noappend -no-xattrs -quiet >/dev/null
rm -f "$APPIMAGE"
cat "$RUNTIME" "$SQFS" > "$APPIMAGE.part"
chmod 0755 "$APPIMAGE.part"
mv "$APPIMAGE.part" "$APPIMAGE"

# ---------------------------------------------------------------------------
# The result, checked from the file itself:
#   - it is a type 2 AppImage (the magic bytes AI\x02 at offset 8);
#   - the runtime part is exactly the pinned runtime;
#   - .upd_info and .sha256_sig are empty: no update address, no signature
#     claimed.
# ---------------------------------------------------------------------------
python3 - "$APPIMAGE" "$RUNTIME" <<'PYEOF' || fail "the AppImage failed its checks (above)"
import struct, sys
image, runtime = sys.argv[1], sys.argv[2]
data = open(image, 'rb').read()
rt = open(runtime, 'rb').read()
problems = []
if data[8:11] != b'AI\x02':
    problems.append('no type 2 AppImage magic at offset 8')
if data[:len(rt)] != rt:
    problems.append('the runtime part is not the pinned runtime')
# ELF64 section headers, to find .upd_info and .sha256_sig by name.
shoff, = struct.unpack_from('<Q', data, 0x28)
shentsize, shnum, shstrndx = struct.unpack_from('<HHH', data, 0x3A)
def section(i):
    name, _, _, _, off, size = struct.unpack_from('<IIQQQQ', data, shoff + i * shentsize)
    return name, off, size
_, stroff, _ = section(shstrndx)
found = {}
for i in range(shnum):
    name, off, size = section(i)
    end = data.index(b'\0', stroff + name)
    found[data[stroff + name:end].decode()] = data[off:off + size]
for name in ('.upd_info', '.sha256_sig'):
    if name not in found:
        problems.append('no %s section in the runtime' % name)
    elif found[name].strip(b'\0'):
        problems.append('%s is not empty: %r' % (name, found[name].strip(b'\0')[:80]))
for p in problems:
    print('  ' + p, file=sys.stderr)
sys.exit(1 if problems else 0)
PYEOF
say "type 2 AppImage, pinned runtime, no update information -- ok"

echo
say "built $(basename "$APPIMAGE")"
say "  $(( $(stat -c %s "$APPIMAGE") / 1024 / 1024 )) MB"
say "  needs: x86_64 Linux, glibc ${LIBC_MIN:-2.34} or newer, bash, fusermount,"
say "         and python3 for the first-run setup"
echo
sha256sum "$APPIMAGE"
