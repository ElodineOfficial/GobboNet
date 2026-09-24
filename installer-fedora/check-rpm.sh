#!/usr/bin/env bash
# Check a built GobboNet RPM against what the Fedora package has to be.
#
#   ./check-rpm.sh dist/gobbonet-*.rpm
#
# build-rpm.sh runs this on every package it makes, and removes one that fails
# from dist/. It also runs on its own, against any GobboNet .rpm, on any host
# with rpm, rpm2cpio and cpio -- so a package someone else built can be held to
# the same standard.
#
# WHY IT EXISTS
#
# Every Fedora package this project has shipped or nearly shipped was broken in
# a way that installed cleanly:
#
#   1.7.3-1  /usr/bin/gobbonet ran the server directly, skipping first-run
#            setup and the browser.
#   1.7.4    the setup wizard was never staged; clicking the icon did nothing.
#   1.7.6    (caught before release) hand-written library requirements let
#            OpenSSL 4 satisfy an engine built for OpenSSL 3, so on Fedora 45
#            the engine could not start.
#
# rpmbuild sees none of that, and none of it needs a Fedora machine to catch.
# They are properties of the finished package -- what it requires, what it
# contains, what its files say -- so that is what this checks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

RPM="${1:-}"
[ -n "$RPM" ] && [ -f "$RPM" ] || { echo "usage: $0 <gobbonet.rpm>" >&2; exit 2; }
RPM="$(realpath "$RPM")"
for t in rpm rpm2cpio cpio realpath; do
    command -v "$t" >/dev/null 2>&1 || { echo "ERROR: $t is required" >&2; exit 2; }
done

LIB=/usr/lib64/gobbonet    # the program directory on x86_64 Fedora

problems=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; problems=$((problems + 1)); }
note() { printf '  note  %s\n' "$*"; }
q()    { rpm -qp "$@" "$RPM" 2>/dev/null; }

echo "check-rpm: $(basename "$RPM")"
[ "$(q --qf '%{NAME}')" = "gobbonet" ] || { echo "ERROR: $RPM is not a gobbonet package" >&2; exit 2; }
PKG_VERSION="$(q --qf '%{VERSION}')"
PKG_RELEASE="$(q --qf '%{RELEASE}')"
ARCH="$(q --qf '%{ARCH}')"

[ "$ARCH" = "x86_64" ] && ok "built for x86_64" || bad "built for $ARCH, not x86_64"
if [ -f "$ROOT/VERSION" ]; then
    want="$(tr -d '[:space:]' < "$ROOT/VERSION")"
    [ "$PKG_VERSION" = "$want" ] && ok "Version $PKG_VERSION matches VERSION" \
        || bad "Version is $PKG_VERSION but VERSION says $want"
fi
if rpm -K --nosignature "$RPM" >/dev/null 2>&1; then
    ok "header and payload digests intact"
else
    bad "rpm -K reports damaged digests"
fi

# ---------------------------------------------------------------------------
# 1. Requirements.
#
# The engine's library needs must reach dnf as sonames, because that is the
# only form in which "OpenSSL 3" and "OpenSSL 4" are different things. And
# nothing may require what the package carries itself, or Vulkan, which is
# optional by design.
# ---------------------------------------------------------------------------
REQ="$(q --requires | sed 's/[[:space:]]*$//' | sort -u)"
require() { # ERE, what
    if grep -Eq "$1" <<<"$REQ"; then ok "requires $2"; else bad "does not require $2"; fi
}
refuse() { # ERE, what it means that none matched
    local hit
    hit="$(grep -E "$1" <<<"$REQ" | tr '\n' ' ' || true)"
    if [ -z "$hit" ]; then ok "$2"; else bad "$2 -- found: $hit"; fi
}
require '^libssl\.so\.3\(\)\(64bit\)$'          'libssl.so.3 (Fedora 45+: from openssl3-libs)'
require '^libcrypto\.so\.3\(\)\(64bit\)$'       'libcrypto.so.3'
require '^libgomp\.so\.1\(\)\(64bit\)$'         'libgomp.so.1'
require '^libstdc\+\+\.so\.6\(\)\(64bit\)$'     'libstdc++.so.6'
require '^libgcc_s\.so\.1\(\)\(64bit\)$'        'libgcc_s.so.1'
require '^libc\.so\.6\(GLIBC_[0-9.]+\)\(64bit\)$' 'a symbol-versioned glibc'
require '^python3( |$)'                         'python3 (the setup wizard)'
require '^bash( |$)'                            'bash'
require '^coreutils( |$)'                       'coreutils'
require '^grep( |$)'                            'grep'
require '^xdg-utils( |$)'                       'xdg-utils (opening the browser)'
require '^hicolor-icon-theme( |$)'              'hicolor-icon-theme'
refuse '^(libvulkan|libggml|libllama|libmtmd)' \
    'requires neither Vulkan nor the engine libraries it carries'
refuse '^(openssl-libs|openssl3-libs|glibc|libstdc\+\+|libgomp|libgcc)( |$)' \
    'no hand-written library packages (those let OpenSSL 4 stand in for OpenSSL 3)'

floor="$(grep -oE '^libc\.so\.6\(GLIBC_[0-9.]+\)' <<<"$REQ" | grep -oE '[0-9]+(\.[0-9]+)+' | sort -V | tail -1 || true)"
note "glibc floor from the engine: ${floor:-unknown}"

REC="$(q --recommends)"
for r in vulkan-loader mesa-vulkan-drivers; do
    grep -qx "$r" <<<"$REC" && ok "recommends $r" || bad "does not recommend $r"
done

# ---------------------------------------------------------------------------
# 2. What it offers the rest of the system: nothing but itself.
# ---------------------------------------------------------------------------
PROV="$(q --provides)"
if grep -q '\.so' <<<"$PROV"; then
    bad "offers shared libraries to the system: $(grep '\.so' <<<"$PROV" | tr '\n' ' ')"
else
    ok "offers no shared libraries to the system"
fi
LLAMA_BUILD="$(sed -n 's/^bundled(llama\.cpp) = //p' <<<"$PROV")"
[ -n "$LLAMA_BUILD" ] && ok "declares bundled(llama.cpp) = $LLAMA_BUILD" \
    || bad "does not declare bundled(llama.cpp)"

# ---------------------------------------------------------------------------
# 3. Files, and their modes.
# ---------------------------------------------------------------------------
FILES="$(q --qf '[%{FILEMODES:perms} %{FILEUSERNAME}:%{FILEGROUPNAME} %{FILENAMES}\n]')"
has() { awk -v p="$1" '$3 == p { f = 1 } END { exit !f }' <<<"$FILES"; }

missing=()
for p in \
    /usr/bin/gobbonet \
    "$LIB/gobbonet" "$LIB/gobbonet-launch" "$LIB/gobbonet-setup.py" "$LIB/wizard.html" \
    "$LIB/models.ini" "$LIB/llama-cpp/llama-server" "$LIB/llama-cpp/libggml-vulkan.so" \
    "$LIB/llama-cpp/ENGINE.txt" \
    /usr/share/applications/gobbonet.desktop \
    /usr/share/icons/hicolor/256x256/apps/gobbonet.png \
    /usr/share/doc/gobbonet/FEDORA.md \
    /usr/share/licenses/gobbonet/LICENSE \
    /usr/share/licenses/gobbonet/LICENSE.llama-cpp
do
    has "$p" || missing+=("$p")
done
if [ ${#missing[@]} -eq 0 ]; then
    ok "ships the launcher, wizard, catalogue, engine, desktop entry, icon, doc and licences"
else
    for p in "${missing[@]}"; do bad "does not ship $p"; done
fi

forbid_path() { # ERE on the path, what it means that none matched
    local hit
    hit="$(awk '{ print $3 }' <<<"$FILES" | grep -E "$1" | head -3 | tr '\n' ' ' || true)"
    if [ -z "$hit" ]; then ok "$2"; else bad "$2 -- found: $hit"; fi
}
forbid_path '^/usr/lib/gobbonet(/|$)'             'nothing under the Debian path /usr/lib/gobbonet'
forbid_path "^$LIB/web(/|\$)"                      'no web/ (the chat page has been inside the binary since 1.7.5)'
forbid_path '^/usr/share/(doc|licenses)/gobbonet-' 'doc and licence directories are unversioned, as on Fedora'
forbid_path '^/usr/lib/\.build-id(/|$)'            'no build-id links'

# /usr/bin/gobbonet must reach the guided launcher, never the server directly.
# Resolved lexically (-s), so the build host's own directory layout cannot
# change the answer.
target="$(q --qf '[%{FILENAMES} %{FILELINKTOS}\n]' | awk '$1 == "/usr/bin/gobbonet" { print $2 }')"
case "$target" in
    "") resolved="" ;;
    /*) resolved="$(realpath -ms "$target")" ;;
    *)  resolved="$(realpath -ms "/usr/bin/$target")" ;;
esac
[ "$resolved" = "$LIB/gobbonet-launch" ] \
    && ok "/usr/bin/gobbonet -> $target (the guided launcher)" \
    || bad "/usr/bin/gobbonet points at '${target:-nothing}', not $LIB/gobbonet-launch"

mode_problems="$(awk '
    $2 != "root:root" { print "not root-owned: " $3; next }
    substr($1, 1, 1) == "d" && $1 != "drwxr-xr-x" { print "directory " $1 ": " $3; next }
    substr($1, 1, 1) == "-" && (substr($1, 8, 1) != "r" || substr($1, 6, 1) == "w" || substr($1, 9, 1) == "w") \
        { print "file " $1 ": " $3 }
' <<<"$FILES" | head -5 || true)"
[ -z "$mode_problems" ] \
    && ok "root-owned; directories 0755; every file world-readable and owner-writable only" \
    || bad "modes: $(tr '\n' ';' <<<"$mode_problems")"
for e in "$LIB/gobbonet" "$LIB/gobbonet-launch" "$LIB/llama-cpp/llama-server"; do
    awk -v p="$e" '$3 == p && $1 == "-rwxr-xr-x" { f = 1 } END { exit !f }' <<<"$FILES" \
        || bad "$e is not -rwxr-xr-x"
done

floor_mb=60
has "$LIB/llama-cpp-cpu" && floor_mb=95
size_mb=$(( $(q --qf '%{SIZE}') / 1024 / 1024 ))
[ "$size_mb" -ge "$floor_mb" ] \
    && ok "installs ${size_mb} MB (at least ${floor_mb} MB means the engine is really in it)" \
    || bad "installs only ${size_mb} MB; with the engine it must be at least ${floor_mb} MB"

SCRIPTS="$(q --scripts)"
if grep -Eq '/home/|\$HOME|~/' <<<"$SCRIPTS"; then
    bad "a scriptlet refers to home directories; scriptlets run as root and must not"
else
    ok "no scriptlet goes near a home directory"
fi

# ---------------------------------------------------------------------------
# 4. What the files say. Unpacked, not trusted from the file list.
# ---------------------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! (cd "$TMP" && rpm2cpio "$RPM" | cpio -idm --quiet --no-absolute-filenames 2>/dev/null); then
    bad "could not unpack the payload"
fi

DESKTOP="$TMP/usr/share/applications/gobbonet.desktop"
if [ -f "$DESKTOP" ]; then
    grep -qx "Exec=$LIB/gobbonet-launch" "$DESKTOP" \
        && ok "desktop entry runs $LIB/gobbonet-launch" \
        || bad "desktop entry does not run $LIB/gobbonet-launch: $(grep '^Exec=' "$DESKTOP")"
    if command -v desktop-file-validate >/dev/null 2>&1; then
        if out="$(desktop-file-validate "$DESKTOP" 2>&1)"; then
            ok "desktop entry passes desktop-file-validate"
            [ -z "$out" ] || note "desktop-file-validate: $(sed "s|$DESKTOP: ||" <<<"$out" | tr '\n' ' ')"
        else
            bad "desktop-file-validate: $(tr '\n' ' ' <<<"$out")"
        fi
    else
        note "desktop-file-validate is not installed; the desktop entry was not validated"
    fi
fi

WIZARD="$TMP$LIB/wizard.html"
if [ -f "$WIZARD" ]; then
    grep -q "The Fedora package manages program files in $LIB\." "$WIZARD" \
        && ok "wizard names $LIB" || bad "wizard does not name $LIB"
    grep -q 'sudo firewall-cmd --permanent --add-port=' "$WIZARD" \
        && ok "wizard gives the firewalld command" || bad "wizard does not give the firewalld command"
    if grep -q 'ufw allow\|/usr/lib/gobbonet' "$WIZARD"; then
        bad "wizard still shows a Debian path or a UFW command"
    else
        ok "wizard shows no Debian path and no UFW command"
    fi
fi

ENGINE_TXT="$TMP$LIB/llama-cpp/ENGINE.txt"
if [ -f "$ENGINE_TXT" ] && [ -n "$LLAMA_BUILD" ]; then
    grep -q "^llama.cpp build: *$LLAMA_BUILD\$" "$ENGINE_TXT" \
        && ok "ENGINE.txt names $LLAMA_BUILD, as bundled(llama.cpp) does" \
        || bad "ENGINE.txt disagrees with bundled(llama.cpp) = $LLAMA_BUILD"
fi

BIN="$TMP$LIB/gobbonet"
bin_version="$("$BIN" version 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
if [ -z "$bin_version" ]; then
    note "the packaged binary could not be run here; its version was not checked"
else
    case "$bin_version" in
        "$PKG_VERSION-go-"?*) ok "binary reports $bin_version" ;;
        *) bad "binary reports $bin_version, but the package Version is $PKG_VERSION" ;;
    esac
    build_id="$(printf '%s' "${bin_version#"$PKG_VERSION-go-"}" | tr -c 'A-Za-z0-9.' '.')"
    case "$PKG_RELEASE." in
        *".go.$build_id."*) ok "Release $PKG_RELEASE names the binary's build" ;;
        *) bad "Release $PKG_RELEASE does not name the binary's build ($build_id)" ;;
    esac
fi

# Inside a source tree, the package must carry the tree's own files: one
# launcher and one wizard for both Linux packages, and the payload the shared
# manifest describes.
if [ -f "$ROOT/installer-linux/gobbonet-launch" ]; then
    same() { # packaged, tree, what
        if cmp -s "$1" "$2"; then ok "$3"; else bad "$3 -- the packaged copy differs"; fi
    }
    same "$TMP$LIB/gobbonet-launch"   "$ROOT/installer-linux/gobbonet-launch"   "launcher is installer-linux/gobbonet-launch, byte for byte"
    same "$TMP$LIB/gobbonet-setup.py" "$ROOT/installer-linux/gobbonet-setup.py" "setup wizard is installer-linux/gobbonet-setup.py, byte for byte"
    same "$TMP$LIB/models.ini"        "$ROOT/installer/models.ini"              "catalogue is installer/models.ini, byte for byte"
    changed="$(diff "$ROOT/installer-linux/wizard.html" "$WIZARD" 2>/dev/null | grep -c '^[<>]' || true)"
    [ "$changed" = 4 ] \
        && ok "wizard.html differs from installer-linux/ in exactly its two Fedora lines" \
        || bad "wizard.html differs from installer-linux/ in $changed changed lines, expected 4 (2 out, 2 in)"
    if [ -x "$ROOT/verify-payload.sh" ]; then
        if report="$("$ROOT/verify-payload.sh" "$TMP$LIB" "packaged payload" 2>&1)"; then
            ok "packaged payload matches payload.manifest"
        else
            bad "packaged payload does not match payload.manifest: $(tr -s ' \n' ' ' <<<"$report")"
        fi
    fi
else
    note "not run from a GobboNet tree; skipped the comparisons against one"
fi

# ---------------------------------------------------------------------------
# Signature: reported, not required. See build-rpm.sh for why.
# ---------------------------------------------------------------------------
# Captured first: rpm -Kv exits non-zero for a key it does not know, and under
# pipefail that would hide a match grep had found.
sig_report="$(rpm -Kv "$RPM" 2>&1 || true)"
if grep -qiE 'key id|signature.*: *(ok|nokey)' <<<"$sig_report"; then
    note "signed"
else
    note "unsigned -- install with 'sudo dnf install ./$(basename "$RPM")'; Fedora 45+ refuses unsigned packages through rpm -i"
fi

echo
if [ "$problems" -eq 0 ]; then
    echo "check-rpm: PASS"
else
    echo "check-rpm: $problems problem(s)"
    exit 1
fi
