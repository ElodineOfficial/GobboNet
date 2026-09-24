#!/usr/bin/env bash
# Test a GobboNet RPM inside a real Fedora userland, without Fedora hardware.
#
#   sudo ./test-in-fedora.sh --root DIR --rpm PKG.rpm --python CPYTHON.tar.gz \
#        [--openssl3-from DIR] [--upgrade-from OLD.rpm] [--keep]
#
#   --root DIR           an extracted Fedora root filesystem. The official ones
#                        are on GitHub, one branch per release:
#                          git clone --depth 1 --branch 45 \
#                              https://github.com/fedora-cloud/docker-brew-fedora f45src
#                          mkdir f45 && tar -xf f45src/x86_64/fedora-*.tar -C f45
#                        It is never modified; every scenario runs in a copy.
#   --rpm PKG.rpm        the package under test (dist/gobbonet-*.rpm)
#   --python TARBALL     a relocatable CPython, standing in for Fedora's python3,
#                        which the minimal root does not have. Match the
#                        release's own: 3.14 for Fedora 43/44, 3.15 for 45+.
#                        https://github.com/astral-sh/python-build-standalone
#                        (the *-x86_64-unknown-linux-gnu-install_only.tar.gz)
#   --openssl3-from DIR  a directory holding libssl.so.3* and libcrypto.so.3*.
#                        Only needed where the root's OpenSSL is 4 (Fedora 45+):
#                        they are packaged as a stand-in for Fedora's
#                        openssl3-libs, which dnf would fetch from the network.
#                        Fedora 44's /usr/lib64 is a good source.
#   --upgrade-from OLD   also test upgrading from an older package (1.7.3-3)
#   --model FILE.gguf    also run GobboNet in local mode with this model, as the
#                        user: the server starts the bundled engine and a chat
#                        request goes through its proxy. Any GGUF works; a tiny
#                        random-weight one is enough (it proves the engine
#                        loads a model and generates, not that it is smart).
#                        Its attention head size must be a multiple of 32,
#                        because GobboNet runs a q8_0 KV cache.
#   --keep               keep the scratch roots for inspection
#
# Runs as root, because it chroots and mounts /dev and /proc. Uses this host's
# rpmbuild to make two TEST-ONLY packages that are installed into the scratch
# roots and never shipped: one providing what every Fedora desktop has
# (python3, xdg-utils, hicolor-icon-theme) and, where needed, the OpenSSL 3
# stand-in. Everything else -- rpm, dnf, glibc, libstdc++, libgomp, OpenSSL,
# the signature policy -- is the Fedora release's own.
#
# What it checks, per scenario:
#
#   install   digests; which requirements the real Fedora rpmdb cannot meet
#             (exactly the desktop packages, plus OpenSSL 3 where the system has
#             moved on); that dnf REFUSES the package when nothing provides
#             OpenSSL 3; an offline `dnf install ./package`; rpm -V; the engine
#             and the command as an ordinary user; the repo's own first-run test
#             (tests/test-linux-onboarding.py) as that user; rpm -V again; with
#             --model, GobboNet in local mode generating through its own proxy;
#             that a web/ written by a root-run server is cleaned up; removal,
#             with the user's data left alone.
#   upgrade   the old package installed and configured the way its launcher left
#             users; an upgrade by dnf; that its web/ is gone, that the config's
#             engine path still runs, and that the server ignores the stale
#             web_root the old launcher wrote.
#
# What it cannot check: SELinux (the chroot has none), a real desktop session,
# GNOME Software, and GPU inference. Those still need Fedora hardware.
set -uo pipefail

ROOTFS="" RPM="" PYTAR="" OSSL3_FROM="" UPGRADE_FROM="" MODEL="" KEEP=0
usage() { sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//; /^set -uo/d'; exit 2; }
while [ $# -gt 0 ]; do
    case "$1" in
        --root)          ROOTFS="${2:-}"; shift 2 ;;
        --rpm)           RPM="${2:-}"; shift 2 ;;
        --python)        PYTAR="${2:-}"; shift 2 ;;
        --openssl3-from) OSSL3_FROM="${2:-}"; shift 2 ;;
        --upgrade-from)  UPGRADE_FROM="${2:-}"; shift 2 ;;
        --model)         MODEL="${2:-}"; shift 2 ;;
        --keep)          KEEP=1; shift ;;
        -h|--help)       usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done
die() { echo "ERROR: $*" >&2; exit 2; }
[ "$(id -u)" = 0 ] || die "run as root: this chroots and mounts /dev and /proc"
[ -f "${ROOTFS:-/nonexistent}/etc/fedora-release" ] || die "--root must be an extracted Fedora root filesystem"
[ -f "$RPM" ] || die "--rpm must name the package to test"
[ -f "$PYTAR" ] || die "--python must name a relocatable CPython tarball"
[ -z "$UPGRADE_FROM" ] || [ -f "$UPGRADE_FROM" ] || die "--upgrade-from $UPGRADE_FROM does not exist"
[ -z "$MODEL" ] || [ -f "$MODEL" ] || die "--model $MODEL does not exist"
for t in rpmbuild chroot mount rpm; do command -v "$t" >/dev/null 2>&1 || die "$t is required"; done
ROOTFS="$(realpath "$ROOTFS")"; RPM="$(realpath "$RPM")"; PYTAR="$(realpath "$PYTAR")"
[ -z "$UPGRADE_FROM" ] || UPGRADE_FROM="$(realpath "$UPGRADE_FROM")"
[ -z "$MODEL" ] || MODEL="$(realpath "$MODEL")"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ONBOARDING="$ROOT/tests/test-linux-onboarding.py"
[ -f "$ONBOARDING" ] || die "$ONBOARDING is missing"

LIB=/usr/lib64/gobbonet
PKG="$(basename "$RPM")"
EVR="$(rpm -qp --qf '%{VERSION}-%{RELEASE}' "$RPM" 2>/dev/null)"
LLAMA_NUM="$(rpm -qp --provides "$RPM" 2>/dev/null | sed -n 's/^bundled(llama\.cpp) = b//p')"
RELEASE_NAME="$(cat "$ROOTFS/etc/fedora-release")"
TESTER_UID=4242

SCRATCH="$(mktemp -d /var/tmp/gobbonet-fedora-test.XXXXXX)"
ROOTS=()
cleanup() {
    local r
    for r in "${ROOTS[@]:-}"; do
        [ -n "$r" ] || continue
        umount "$r/proc" 2>/dev/null
        umount "$r/dev" 2>/dev/null
    done
    if [ "$KEEP" = 1 ]; then echo "scratch kept: $SCRATCH"; else rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT

passes=0 fails=0
pass() { printf '  PASS  %s\n' "$*"; passes=$((passes + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
info() { printf '  ....  %s\n' "$*"; }
indent() { sed 's/^/          | /'; }

# ---------------------------------------------------------------------------
# TEST-ONLY packages, built here and installed only into scratch roots.
# ---------------------------------------------------------------------------
PYVER="$(tar -tzf "$PYTAR" | grep -m1 -oE 'python3\.[0-9]+' | sed 's/python//')"
[ -n "$PYVER" ] || die "cannot tell which Python $PYTAR contains"

build_stub() { # name, spec text
    local top="$SCRATCH/stub-$1"
    mkdir -p "$top"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
    printf '%s\n' "$2" > "$top/SPECS/$1.spec"
    rpmbuild -bb --define "_topdir $top" "$top/SPECS/$1.spec" > "$top/build.log" 2>&1 \
        || { cat "$top/build.log" >&2; die "could not build the test package $1"; }
    find "$top/RPMS" -name '*.rpm' -print -quit
}

DESKTOP_STUB="$(build_stub gobbonet-test-desktop "Name: gobbonet-test-desktop
Version: 1
Release: 1
Summary: TEST ONLY - stands in for packages every Fedora desktop already has
License: MIT
BuildArch: noarch
Provides: python3 = $PYVER
Provides: xdg-utils = 1.2.1
Provides: hicolor-icon-theme = 0.18
%description
Test scaffolding for installer-fedora/test-in-fedora.sh. Never shipped.
%files")"

OSSL3_STUB=""
if [ -n "$OSSL3_FROM" ]; then
    ls "$OSSL3_FROM"/libssl.so.3.* "$OSSL3_FROM"/libcrypto.so.3.* >/dev/null 2>&1 \
        || die "--openssl3-from $OSSL3_FROM holds no libssl.so.3.* and libcrypto.so.3.*"
    OSSL3_STUB="$(build_stub gobbonet-test-openssl3 "Name: gobbonet-test-openssl3
Version: 3
Release: 1
Summary: TEST ONLY - OpenSSL 3 libraries standing in for Fedora's openssl3-libs
License: Apache-2.0
Provides: openssl3-libs = 3
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
%description
Test scaffolding for installer-fedora/test-in-fedora.sh. Never shipped.
%install
mkdir -p %{buildroot}/usr/lib64
cp -a $(realpath "$OSSL3_FROM")/libssl.so.3* $(realpath "$OSSL3_FROM")/libcrypto.so.3* %{buildroot}/usr/lib64/
%files
/usr/lib64/libssl.so.3*
/usr/lib64/libcrypto.so.3*")"
fi

# ---------------------------------------------------------------------------
# Scratch roots.
# ---------------------------------------------------------------------------
R=""
new_root() { # scenario name
    R="$SCRATCH/root-$1"
    cp -a "$ROOTFS" "$R"
    ROOTS+=("$R")
    mount --bind /dev "$R/dev" && mount -t proc proc "$R/proc" || die "could not mount /dev and /proc in $R"
    tar -xzf "$PYTAR" -C "$R/opt"                     # -> /opt/python
    ln -sf /opt/python/bin/python3 "$R/usr/bin/python3"
    mkdir -p "$R/tmp/pkgs"
    cp "$RPM" "$DESKTOP_STUB" "$R/tmp/pkgs/"
    [ -z "$OSSL3_STUB" ]   || cp "$OSSL3_STUB" "$R/tmp/pkgs/"
    [ -z "$UPGRADE_FROM" ] || cp "$UPGRADE_FROM" "$R/tmp/pkgs/"
    [ -z "$MODEL" ]        || cp "$MODEL" "$R/tmp/pkgs/test-model.gguf"
    chroot "$R" useradd -m -u "$TESTER_UID" tester >/dev/null 2>&1 || die "useradd failed in $R"
}
in_root()   { chroot "$R" "$@"; }
as_tester() {
    chroot --userspec="$TESTER_UID:$TESTER_UID" "$R" /usr/bin/env -i \
        HOME=/home/tester USER=tester LOGNAME=tester LANG=C.UTF-8 \
        PATH=/usr/local/bin:/usr/bin:/bin "$@"
}
# dnf with no repositories at all: everything it installs is a file named on
# its command line, which is exactly the documented way in.
dnf_offline() {
    in_root dnf5 -y --setopt=reposdir=/nonexistent --setopt=cachedir=/tmp/dnfcache \
        --setopt=install_weak_deps=True "$@"
}
free_port() { in_root python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

OSSL4=0
chroot "$ROOTFS" rpm -q --whatprovides 'libssl.so.3()(64bit)' >/dev/null 2>&1 || OSSL4=1

echo "== $RELEASE_NAME: $(chroot "$ROOTFS" rpm --version), $(chroot "$ROOTFS" rpm -q openssl-libs), signature policy: $(chroot "$ROOTFS" rpm --eval '%_pkgverify_level')"
echo "   testing $PKG with Python $PYVER"

# ===========================================================================
# Scenario 1: fresh install, first run, removal
# ===========================================================================
echo
echo "-- fresh install"
new_root install

if in_root rpm -K --nosignature "/tmp/pkgs/$PKG" >/dev/null 2>&1; then
    pass "digests verify with Fedora's rpm"
else
    fail "digests do not verify: $(in_root rpm -K --nosignature "/tmp/pkgs/$PKG" 2>&1)"
fi

# The requirements the real Fedora rpmdb cannot meet must be exactly the
# desktop packages -- plus OpenSSL 3, and only its four sonames, where the
# system OpenSSL is 4. Anything else unmet is a requirement Fedora does not
# satisfy the way we assumed.
unmet="$(in_root rpm -i --test --nosignature "/tmp/pkgs/$PKG" 2>&1 \
         | sed -n 's/^[[:space:]]*\(.*\) is needed by .*/\1/p' | sort)"
expected="hicolor-icon-theme
python3 >= 3.8
xdg-utils"
if [ "$OSSL4" = 1 ]; then
    expected="$(printf '%s\n%s\n' "$expected" 'libcrypto.so.3()(64bit)
libcrypto.so.3(OPENSSL_3.0.0)(64bit)
libssl.so.3()(64bit)
libssl.so.3(OPENSSL_3.0.0)(64bit)' | sort)"
fi
if [ "$unmet" = "$expected" ]; then
    if [ "$OSSL4" = 1 ]; then
        pass "unmet requirements are the desktop packages and OpenSSL 3's four sonames, nothing else"
    else
        pass "unmet requirements are only the desktop packages; glibc, libstdc++, libgomp, OpenSSL all resolve"
    fi
else
    fail "unexpected unmet requirements:"; diff <(echo "$expected") <(echo "$unmet") | indent
fi

# --nodeps: rpm checks signatures when the transaction runs, which is after the
# dependency check, so with desktop packages missing it would never get there.
# Captured first: rpm exits 1 when it refuses, and under pipefail that would
# hide the very message being looked for.
sig_out="$(in_root rpm -i --test --nodeps "/tmp/pkgs/$PKG" 2>&1)"
if grep -q 'no signature' <<<"$sig_out"; then
    info "rpm -i refuses this unsigned package here (signature enforcement is on)"
else
    info "rpm -i accepts unsigned packages here"
fi

if out="$(dnf_offline install "/tmp/pkgs/$(basename "$DESKTOP_STUB")" 2>&1)"; then
    info "installed the test-only desktop stand-in (python3, xdg-utils, hicolor-icon-theme)"
else
    fail "could not install the desktop stand-in"; echo "$out" | tail -5 | indent
fi

if [ "$OSSL4" = 1 ]; then
    # The whole point of generated requirements: with nothing offering OpenSSL
    # 3, dnf must refuse, naming it -- not install an engine that cannot start.
    if out="$(dnf_offline install "/tmp/pkgs/$PKG" 2>&1)"; then
        fail "dnf installed the package with no OpenSSL 3 available"
        in_root rpm -e --nodeps gobbonet >/dev/null 2>&1
    elif grep -q 'libssl\.so\.3' <<<"$out"; then
        pass "with no OpenSSL 3 provider, dnf refuses and names libssl.so.3"
        grep -m1 'libssl\.so\.3' <<<"$out" | sed 's/^ *//' | indent
    else
        fail "dnf refused, but not over OpenSSL 3:"; echo "$out" | tail -5 | indent
    fi
fi

install_set=("/tmp/pkgs/$PKG")
installed=0
if [ "$OSSL4" = 1 ] && [ -z "$OSSL3_STUB" ]; then
    info "OpenSSL 4 system and no --openssl3-from: stopping before install"
else
    [ -z "$OSSL3_STUB" ] || [ "$OSSL4" = 0 ] || install_set+=("/tmp/pkgs/$(basename "$OSSL3_STUB")")
    if out="$(dnf_offline install "${install_set[@]}" 2>&1)"; then
        installed=1
        pass "dnf install ./$PKG$([ ${#install_set[@]} -gt 1 ] && echo ' (+ the OpenSSL 3 stand-in)')"
        grep -i 'skipped openpgp' <<<"$out" | indent
        if grep -qiE 'scriptlet.*(fail|error)|error:' <<<"$out"; then
            fail "dnf reported a scriptlet problem"; grep -iE 'scriptlet|error' <<<"$out" | indent
        fi
    else
        fail "dnf install failed"; echo "$out" | tail -8 | indent
    fi
fi

if [ "$installed" = 1 ]; then
    v="$(in_root rpm -V gobbonet 2>&1)"
    [ -z "$v" ] && pass "rpm -V: every installed file matches the package" || { fail "rpm -V:"; echo "$v" | indent; }

    out="$(as_tester "$LIB/llama-cpp/llama-server" --version 2>&1)"
    if grep -q "build $LLAMA_NUM" <<<"$out"; then
        pass "bundled engine starts as an ordinary user (build $LLAMA_NUM)"
    else
        fail "bundled engine does not start:"; echo "$out" | tail -3 | indent
    fi

    out="$(as_tester gobbonet version 2>&1)"
    case "$out" in
        "${EVR%%-*}-go-"*) pass "'gobbonet version' through /usr/bin/gobbonet: $out" ;;
        *) fail "'gobbonet version' said: $out" ;;
    esac

    # The repo's own first-run test: launcher, setup wizard, password, port,
    # local/remote backend, LAN and not, repeat launch -- run against the
    # INSTALLED package, as an ordinary user, with Fedora's libraries.
    mkdir -p "$R/home/tester/gn/tests"
    cp "$ONBOARDING" "$R/home/tester/gn/tests/"
    chroot "$R" chown -R tester:tester /home/tester/gn
    out="$(timeout 600 chroot --userspec="$TESTER_UID:$TESTER_UID" "$R" /usr/bin/env -i \
            HOME=/home/tester USER=tester LOGNAME=tester LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
            GOBBONET_TEST_PREFIX="$LIB" python3 /home/tester/gn/tests/test-linux-onboarding.py 2>&1)"
    n="$(grep -c '^PASS:' <<<"$out" || true)"
    if [ "$n" = 2 ]; then
        pass "first-run setup, as an ordinary user, local and LAN (tests/test-linux-onboarding.py)"
    else
        fail "tests/test-linux-onboarding.py:"; echo "$out" | tail -15 | indent
    fi

    v="$(in_root rpm -V gobbonet 2>&1)"
    [ -z "$v" ] && pass "rpm -V after first run: nothing in the package was modified" \
        || { fail "rpm -V after first run:"; echo "$v" | indent; }

    # The onboarding test never starts the engine -- it proves setup, then
    # switches to a remote backend. This does: GobboNet in local mode, as the
    # user, its own supervisor starting the bundled engine on a model, and a
    # chat request through its own proxy. On Fedora 45 that is the step that
    # needs OpenSSL 3; everything before it passes without.
    if [ -n "$MODEL" ]; then
        as_tester mkdir -p /home/tester/.local/share/gobbonet/models
        as_tester cp /tmp/pkgs/test-model.gguf /home/tester/.local/share/gobbonet/models/test-model.gguf
        port="$(free_port)"
        as_tester gobbonet config set server_exe "$LIB/llama-cpp/llama-server" >/dev/null 2>&1
        as_tester gobbonet config set listen_port "$port" >/dev/null 2>&1
        (as_tester timeout 180 gobbonet serve --no-auth --host 127.0.0.1 --port "$port" \
            --model test-model.gguf > "$R/tmp/local-serve.log" 2>&1 &)
        health=""
        for _ in $(seq 1 240); do
            health="$(in_root curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/llm/health" 2>/dev/null || true)"
            [ "$health" = 200 ] && break
            sleep 0.5
        done
        reply="$(in_root curl -s "http://127.0.0.1:$port/llm/v1/chat/completions" \
                    -H 'Content-Type: application/json' \
                    -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":8,"temperature":0}' 2>/dev/null || true)"
        pkill -f "gobbonet serve --no-auth --host 127.0.0.1 --port $port" 2>/dev/null
        for _ in $(seq 1 40); do pgrep -f "$R$LIB/llama-cpp/llama-server|^$LIB/llama-cpp/llama-server" >/dev/null || break; sleep 0.25; done
        tokens="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["usage"]["completion_tokens"])' "$reply" 2>/dev/null || true)"
        if [ "$health" = 200 ] && [ "${tokens:-0}" -gt 0 ] 2>/dev/null; then
            pass "local mode: GobboNet started the engine on a model and answered a chat ($tokens tokens)"
        else
            fail "local mode: engine health ${health:-none}, reply: ${reply:-none}"
            grep -E '\[!\]|error|libssl' "$R/tmp/local-serve.log" | head -5 | indent
        fi
    fi

    # A root-run server writes its page into the program directory -- the
    # `sudo gobbonet` mistake. That export must not outlive the package.
    port="$(free_port)"
    in_root mkdir -p /root/gn-test
    # serve refuses to start without a config file; `config set` makes one,
    # which is what `sudo gobbonet`'s setup would have done.
    in_root "$LIB/gobbonet" config set --config /root/gn-test/config.toml listen_port "$port" >/dev/null 2>&1
    (in_root timeout 20 "$LIB/gobbonet" serve --no-auth --host 127.0.0.1 --port "$port" \
        --config /root/gn-test/config.toml > "$R/tmp/root-serve.log" 2>&1 &)
    for _ in $(seq 1 60); do [ -f "$R$LIB/web/.gobbonet-ui" ] && break; sleep 0.25; done
    pkill -f "$LIB/gobbonet serve --no-auth --host 127.0.0.1 --port $port" 2>/dev/null
    sleep 0.5
    if [ -f "$R$LIB/web/.gobbonet-ui" ]; then
        info "a server run as root wrote $LIB/web ($(find "$R$LIB/web" -type f | wc -l) files, owned by no package)"
    else
        info "the root-run server did not export (see below); simulating its export"
        tail -5 "$R/tmp/root-serve.log" | indent
        mkdir -p "$R$LIB/web" && echo "version=test" > "$R$LIB/web/.gobbonet-ui" && touch "$R$LIB/web/chat.html"
    fi

    as_tester mkdir -p /home/tester/.local/share/gobbonet
    as_tester touch /home/tester/.local/share/gobbonet/keep-me
    out="$(dnf_offline remove gobbonet 2>&1)" || { fail "dnf remove failed"; echo "$out" | tail -5 | indent; }
    notices="$(grep -c "program files are gone" <<<"$out" || true)"
    [ "$notices" = 1 ] && pass "removal prints its notice exactly once" || fail "removal notice printed $notices times"
    if [ ! -e "$R$LIB" ] && [ ! -e "$R/usr/bin/gobbonet" ] && [ ! -e "$R/usr/share/applications/gobbonet.desktop" ]; then
        pass "removal leaves nothing behind, including the root-run server's web/"
    else
        fail "left behind after removal:"; ls -la "$R$LIB" "$R/usr/bin/gobbonet" 2>&1 | indent
    fi
    [ -f "$R/home/tester/.local/share/gobbonet/keep-me" ] && pass "the user's data is untouched by removal" \
        || fail "removal touched the user's data"
fi

# ===========================================================================
# Scenario 2: upgrade from an older package
# ===========================================================================
if [ -n "$UPGRADE_FROM" ]; then
    OLD="$(basename "$UPGRADE_FROM")"
    echo
    echo "-- upgrade from $OLD"
    new_root upgrade
    dnf_offline install "/tmp/pkgs/$(basename "$DESKTOP_STUB")" >/dev/null 2>&1
    if out="$(in_root rpm -i --nosignature "/tmp/pkgs/$OLD" 2>&1)"; then
        info "installed $OLD"
        if as_tester "$LIB/llama-cpp/llama-server" --version >/dev/null 2>&1; then
            info "its engine starts here"
        else
            info "its engine does NOT start here: $(as_tester "$LIB/llama-cpp/llama-server" --version 2>&1 | head -1)"
        fi
        # What the old launcher left in every user's config: the engine path
        # setup recorded, and web_root pointing at the packaged web/ -- which
        # the upgrade deletes.
        as_tester "$LIB/gobbonet" config set server_exe "$LIB/llama-cpp/llama-server" >/dev/null 2>&1
        as_tester "$LIB/gobbonet" config set web_root "$LIB/web" >/dev/null 2>&1

        upgrade_set=("/tmp/pkgs/$PKG")
        [ -z "$OSSL3_STUB" ] || [ "$OSSL4" = 0 ] || upgrade_set+=("/tmp/pkgs/$(basename "$OSSL3_STUB")")
        if [ "$OSSL4" = 1 ] && [ -z "$OSSL3_STUB" ]; then
            info "OpenSSL 4 system and no --openssl3-from: skipping the upgrade itself"
        elif out="$(dnf_offline install "${upgrade_set[@]}" 2>&1)"; then
            now="$(in_root rpm -q gobbonet)"
            [ "$now" = "gobbonet-$EVR.x86_64" ] && pass "dnf upgraded to $now" || fail "after upgrade: $now"
            [ ! -e "$R$LIB/web" ] && pass "the old package's web/ is gone" || fail "$LIB/web survived the upgrade"
            v="$(in_root rpm -V gobbonet 2>&1)"
            [ -z "$v" ] && pass "rpm -V clean after upgrade" || { fail "rpm -V after upgrade:"; echo "$v" | indent; }
            stray="$(cd "$R" && find ".$LIB" -mindepth 1 | sed 's|^\.||' | while read -r f; do in_root rpm -qf "$f" >/dev/null 2>&1 || echo "$f"; done)"
            [ -z "$stray" ] && pass "every file under $LIB belongs to the new package" \
                || { fail "files under $LIB that no package owns:"; echo "$stray" | head | indent; }
            [ "$(readlink -f "$R/usr/bin/gobbonet" | sed "s|^$R||")" = "$LIB/gobbonet-launch" ] \
                && pass "/usr/bin/gobbonet still runs the guided launcher" || fail "/usr/bin/gobbonet does not reach the launcher"

            exe="$(as_tester gobbonet config get server_exe 2>/dev/null)"
            if grep -q "build $LLAMA_NUM" <<<"$(as_tester "$exe" --version 2>&1)"; then
                pass "the engine path in the existing config still runs: $exe"
            else
                fail "the existing config's engine path does not run: $exe"
            fi

            # The server must ignore the web_root the old launcher wrote -- the
            # directory is gone and honouring it would serve nothing.
            as_tester gobbonet config set server_exe "" >/dev/null 2>&1
            port="$(free_port)"
            (as_tester timeout 20 gobbonet serve --no-auth --host 127.0.0.1 --port "$port" > "$R/tmp/upgrade-serve.log" 2>&1 &)
            code=""
            for _ in $(seq 1 60); do
                code="$(in_root curl -s -o /tmp/index.html -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
                [ "$code" = 200 ] && break
                sleep 0.25
            done
            pkill -f "gobbonet serve --no-auth --host 127.0.0.1 --port $port" 2>/dev/null
            sleep 0.5
            if grep -q "ignoring web_root = $LIB/web" "$R/tmp/upgrade-serve.log" \
               && grep -q 'chat interface: built into this program' "$R/tmp/upgrade-serve.log"; then
                pass "the server ignores the stale web_root and serves its built-in page"
            else
                fail "the server did not report ignoring the stale web_root:"; indent < "$R/tmp/upgrade-serve.log"
            fi
            if [ "$code" = 200 ] && grep -qi '<html' "$R/tmp/index.html" 2>/dev/null; then
                pass "the chat page is served after the upgrade (HTTP 200)"
            else
                fail "the chat page was not served after the upgrade (HTTP ${code:-none})"
            fi
        else
            fail "dnf could not upgrade $OLD:"; echo "$out" | tail -8 | indent
        fi
    else
        fail "could not install $OLD:"; echo "$out" | tail -5 | indent
    fi
fi

echo
echo "== $RELEASE_NAME: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
