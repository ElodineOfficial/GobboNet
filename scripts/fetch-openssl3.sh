#!/usr/bin/env bash
# OpenSSL 3 for the AppImage and the ZIP, for systems that have none (1.8.1).
#
#   bash ./scripts/fetch-openssl3.sh <dest> [cache-dir]
#   bash ./scripts/fetch-openssl3.sh linux-amd64/openssl3      before make-zip.sh
#
# llama.cpp's engine needs libssl.so.3 and libcrypto.so.3. Fedora 45 and later
# ship OpenSSL 4 and keep 3 as a separate package; the .rpm depends on it, but
# an AppImage or a ZIP cannot install anything, so there the engine did not
# load. These two carry the libraries in openssl3/, and gobbonet-launch puts
# that folder on the library path only when the system's dynamic loader cannot
# find its own -- the system's copy, kept current by its package manager,
# always wins.
#
# The libraries come from one pinned Ubuntu 22.04 package, the system the
# pinned engine is built on (engine.sha256 says how the pin was checked). The
# package is downloaded once into the cache (installer-linux/vendor by
# default), checked against OPENSSL3_DEB_SHA256, and unpacked; each library is
# then checked against its own pin, so <dest> holds exactly the pinned files:
#
#   libssl.so.3, libcrypto.so.3   the libraries
#   LICENSE.txt                   OpenSSL's licence (Apache 2.0), from the
#                                 openssl-3.0.2 tag (installer-linux/openssl3-LICENSE.txt)
#   COPYRIGHT                     the package's copyright file
#   SOURCE.txt                    which package, from where, with which hashes
#
# OPENSSL3_DEB_URL in the environment fetches the same file from elsewhere (a
# mirror, if Ubuntu has moved a superseded build out of its pool); the hash is
# checked all the same. Each script here runs from the repo root wherever it is
# called from.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:?usage: fetch-openssl3.sh <dest> [cache-dir]}"
CACHE="${2:-installer-linux/vendor}"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f engine.sha256 ] || fail "engine.sha256 is missing"
URL_OVERRIDE="${OPENSSL3_DEB_URL:-}"
# shellcheck disable=SC1091
. ./engine.sha256
[ -n "$URL_OVERRIDE" ] && OPENSSL3_DEB_URL="$URL_OVERRIDE"
for v in OPENSSL3_DEB OPENSSL3_DEB_URL OPENSSL3_DEB_SHA256 LIBSSL3_SHA256 LIBCRYPTO3_SHA256; do
    [ -n "${!v:-}" ] || fail "engine.sha256 has no $v"
done
LICENSE_SRC="installer-linux/openssl3-LICENSE.txt"
[ -f "$LICENSE_SRC" ] || fail "$LICENSE_SRC is missing"

sha() { sha256sum "$1" | cut -d' ' -f1; }

mkdir -p "$CACHE"
DEB="$CACHE/$OPENSSL3_DEB"
if [ ! -f "$DEB" ] || [ "$(sha "$DEB")" != "$OPENSSL3_DEB_SHA256" ]; then
    rm -f "$DEB"
    echo "  fetching $OPENSSL3_DEB"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$DEB.part" "$OPENSSL3_DEB_URL" || fail "could not download $OPENSSL3_DEB_URL"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$DEB.part" "$OPENSSL3_DEB_URL" || fail "could not download $OPENSSL3_DEB_URL"
    else
        fail "neither curl nor wget is available to download $OPENSSL3_DEB"
    fi
    got="$(sha "$DEB.part")"
    [ "$got" = "$OPENSSL3_DEB_SHA256" ] || { rm -f "$DEB.part"; fail "SHA-256 mismatch for $OPENSSL3_DEB
       expected $OPENSSL3_DEB_SHA256
       got      $got
       Either the pin in engine.sha256 is stale or the download is not what it says."; }
    mv "$DEB.part" "$DEB"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$DEB" "$WORK/x"
else
    # Not every builder is Debian: a .deb is an ar archive of control.tar.*
    # and data.tar.*, and tar picks the decompressor from the contents.
    command -v ar >/dev/null 2>&1 || fail "neither dpkg-deb nor ar + tar is available to unpack $OPENSSL3_DEB"
    mkdir -p "$WORK/ar" "$WORK/x"
    deb_abs="$(readlink -f "$DEB")"
    (cd "$WORK/ar" && ar x "$deb_abs")
    if [ -e "$WORK/ar/data.tar.zst" ] && ! command -v zstd >/dev/null 2>&1; then
        fail "$OPENSSL3_DEB is zstd-compressed, and zstd is not installed (or install dpkg)"
    fi
    tar -xf "$WORK/ar"/data.tar.* -C "$WORK/x"
fi
SRC="$WORK/x/usr/lib/x86_64-linux-gnu"
[ -f "$SRC/libssl.so.3" ] && [ -f "$SRC/libcrypto.so.3" ] || fail "$OPENSSL3_DEB has no libssl.so.3 and libcrypto.so.3"
[ "$(sha "$SRC/libssl.so.3")" = "$LIBSSL3_SHA256" ] || fail "libssl.so.3 in $OPENSSL3_DEB does not match LIBSSL3_SHA256"
[ "$(sha "$SRC/libcrypto.so.3")" = "$LIBCRYPTO3_SHA256" ] || fail "libcrypto.so.3 in $OPENSSL3_DEB does not match LIBCRYPTO3_SHA256"

rm -rf "$DEST"
mkdir -p "$DEST"
install -m 0644 "$SRC/libssl.so.3" "$SRC/libcrypto.so.3" "$DEST/"
install -m 0644 "$LICENSE_SRC" "$DEST/LICENSE.txt"
install -m 0644 "$WORK/x/usr/share/doc/libssl3/copyright" "$DEST/COPYRIGHT"
VER="${OPENSSL3_DEB#libssl3_}"; VER="${VER%_amd64.deb}"
cat > "$DEST/SOURCE.txt" <<EOF
OpenSSL 3, for an engine on a system without it.

GobboNet's launcher uses these two libraries only when this system's dynamic
loader cannot find its own libssl.so.3 and libcrypto.so.3 (Fedora 45 and later
ship OpenSSL 4; openssl3-libs is OpenSSL 3 for them). Installing your
distribution's OpenSSL 3 makes GobboNet use that instead.

package:        $OPENSSL3_DEB (Ubuntu 22.04, OpenSSL $VER)
from:           $OPENSSL3_DEB_URL
package sha256: $OPENSSL3_DEB_SHA256
libssl.so.3     $LIBSSL3_SHA256
libcrypto.so.3  $LIBCRYPTO3_SHA256
licence:        Apache License 2.0 (LICENSE.txt); the package's copyright file is COPYRIGHT.
EOF
chmod 0644 "$DEST/SOURCE.txt"
echo "  openssl3: $OPENSSL3_DEB -> $DEST (libssl.so.3, libcrypto.so.3; SHA-256 verified)"
