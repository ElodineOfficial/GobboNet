# GobboNet RPM spec — the Fedora counterpart to installer-linux/build-deb.sh.
#
# Everything here is a translation of a decision already made and documented on
# the Debian side; where the two package formats disagree the reason is noted
# rather than left to be rediscovered.
#
# Build with installer-fedora/build-rpm.sh, which fills in Version, Release and
# the staged tree, and then checks the result with check-rpm.sh. Do not run
# rpmbuild against this by hand and expect a sane result: the spec deliberately
# does not fetch anything, and refuses to parse without the builder's defines.

%{!?gn_version:%{error:gobbonet.spec is built by installer-fedora/build-rpm.sh, which defines gn_version, gn_release and gn_llama_build. Run that instead of rpmbuild.}}

# ---------------------------------------------------------------------------
# Build-host independence.
#
# The package must come out the same whether it is built on Fedora or on
# anything else with rpmbuild. Every macro below is one whose default differs
# between hosts, and each difference has already shipped or nearly shipped as a
# bug, so they are pinned here rather than inherited.
# ---------------------------------------------------------------------------

# GobboNet ships prebuilt binaries -- our Go server and upstream's llama.cpp --
# so there is nothing to extract debug symbols FROM in the usual sense, and an
# empty debuginfo subpackage fails the build outright.
%global debug_package %{nil}

# Leave the payload exactly as staged: no brp-strip, no shebang mangling, no
# byte-compiling. Everything in it is already in its shipped form. The Go
# binary is built stripped (-s -w) by build-release.sh. The llama.cpp files are
# the pinned upstream build, and stripping them would make the package's engine
# differ from the archive engine.sha256 verifies and from the one in the .deb.
# And the launcher and wizard are the .deb's byte for byte: brp-mangle-shebangs
# would rewrite the launcher's #!/usr/bin/env line, and byte-compiling would add
# a __pycache__/ that payload.manifest does not list. check-rpm.sh checks both.
%global __os_install_post %{nil}

# Unversioned doc and licence directories: /usr/share/doc/gobbonet, which is
# Fedora's rule and what 1.7.3-3 shipped. rpm's own default is name-version, so
# an rpm built off-Fedora put FEDORA.md in /usr/share/doc/gobbonet-1.7.6 -- a
# path no Fedora package uses, and one that moves on every release.
%global _docdir_fmt %%{NAME}

# No /usr/lib/.build-id links. They exist to pair binaries with debuginfo
# packages, and there are none (above). Fedora also treats an ELF file with no
# build-id as a fatal error while making them; this switches that machinery off
# instead of relying on every upstream binary to carry one.
%global _build_id_links none

# zstd, as Fedora's own packages use. rpm on other hosts still defaults to
# gzip -9 -- measured on 1.7.6, 35 MB instead of 20 MB for byte-identical
# contents.
%global _binary_payload w19.zstdio

# ---------------------------------------------------------------------------
# Dependencies: generated from the engine, not written by hand.
#
# The bundled llama.cpp is an Ubuntu build, and what it needs from the system
# is exactly what its ELF files say they need. rpm reads that and writes the
# requirements itself, down to the symbol version -- libssl.so.3()(64bit),
# libc.so.6(GLIBC_2.34)(64bit), libstdc++.so.6(GLIBCXX_3.4.30)(64bit) and so on.
#
# Until 1.7.6 every one of those was filtered out and replaced by package names
# written here by hand (openssl-libs >= 3.0, glibc >= 2.34, ...). That held
# until Fedora 45, which moved to OpenSSL 4: the library became libssl.so.4,
# openssl-libs 4.0 still satisfied ">= 3.0", and dnf installed an engine that
# could not start -- "error while loading shared libraries: libssl.so.3".
# Fedora 45 does carry OpenSSL 3, as the compat package openssl3-libs, but dnf
# only installs it for a package that asks for libssl.so.3 by name. Now this one
# does. And if a later Fedora stops shipping it, dnf refuses to install GobboNet
# with a message naming the missing library, instead of installing something
# that silently has no engine.
#
# Two things are still filtered, for the reasons they always were:
#
#   libvulkan.so.1 -- Vulkan is optional. ggml loads its backends through a
#       registry, so without a Vulkan loader the Vulkan backend drops out and
#       the CPU backends beside it run. Recommended below, never required.
#   the engine's own libraries (libggml*, libllama*, libmtmd*) -- they live in
#       the private directory and are found through the engine's $ORIGIN
#       RUNPATH. Nothing on the system provides them, so requiring them would
#       make the package uninstallable.
%global __requires_exclude ^(libvulkan|libggml|libllama|libmtmd)

# And nothing in the private directory is offered to the rest of the system.
# Without this the package would Provide libggml-base.so()(64bit) and friends,
# and an unrelated package could resolve its dependency against a copy of
# llama.cpp living inside GobboNet's directory -- which would then vanish when
# GobboNet is removed. Fedora's bundling guidelines require this filter.
%global __provides_exclude_from ^%{_libdir}/gobbonet/

Name:           gobbonet
Version:        %{gn_version}
Release:        %{gn_release}%{?dist}
Summary:        Local AI chat with guided desktop setup

# GobboNet itself is AGPL-3.0-or-later: LICENSE says "either version 3 of the
# License, or (at your option) any later version". The rest is what is compiled
# into or shipped beside it: llama.cpp (MIT, its licence installed alongside);
# and in the Go binary, golang.org/x/{crypto,exp,sync,sys,term} and the Go
# runtime (BSD-3-Clause), modern-go/{concurrent,reflect2} (Apache-2.0),
# BurntSushi/toml, gguf-parser-go, httpretty, json-iterator, ringbuffer (MIT).
# That list is `go version -m gobbonet`, checked against each module's LICENSE.
License:        AGPL-3.0-or-later AND Apache-2.0 AND BSD-3-Clause AND MIT
URL:            https://github.com/ElodineOfficial/GobboNet

# x86_64 only, because the bundled llama.cpp build is. An aarch64 package would
# need its own engine asset; refusing here is better than installing something
# with no engine that can run.
ExclusiveArch:  x86_64

# Sources are staged by build-rpm.sh rather than fetched, so the content
# arrives ready. Nothing is compiled at rpmbuild time.
Source0:        gobbonet-payload.tar.gz

# No BuildRequires. Nothing is compiled here, and coreutils/tar/sed are on
# Fedora's default buildroot exception list -- the guidelines say not to
# require them explicitly.

# The guided launcher is a bash script that runs a python3 setup wizard, the
# same runtime the Debian package declares (python3 (>= 3.8), bash, coreutils).
# grep too: the launcher reads the wizard's address out of its log with it.
# Debian never needs to say so because grep is Essential there; Fedora has no
# such class, so it is stated.
Requires:       bash
Requires:       coreutils
Requires:       grep
Requires:       python3 >= 3.8

# xdg-utils opens the browser. Hard requirement: without it a graphical install
# has no way to show the user the chat.
Requires:       xdg-utils

# The icon goes into the hicolor theme, whose directories that package owns.
Requires:       hicolor-icon-theme

# Weak dependencies, matching the Debian Recommends line for line.
#   vulkan-loader        = Debian libvulkan1
#   mesa-vulkan-drivers  = Debian mesa-vulkan-drivers | vulkan-driver
# Neither is required: the CPU backends work without them, slower.
Recommends:     vulkan-loader
Recommends:     mesa-vulkan-drivers
Recommends:     curl
Recommends:     zenity

# Fedora asks that bundled code be declared so a security response can find it.
Provides:       bundled(llama.cpp) = %{gn_llama_build}

%description
GobboNet is a local chat interface for local language models. It runs entirely
on this machine: no account, no API key, no telemetry, and no network calls for
inference.

The package bundles a llama.cpp engine build (%{gn_llama_build}) so that a fresh
install has something to run without a second download. It uses Vulkan when a
driver is present and the CPU otherwise. Models are not bundled; GobboNet
downloads them on request into the user's own data directory.

Configuration and conversations live under the invoking user's ~/.config and
~/.local/share, created on first launch by that user. Nothing in this package
writes to a home directory during installation.

%prep
%setup -q -c -n gobbonet-payload

%build
# Nothing to build. The Go binary is produced by build-release.sh and the engine
# comes from upstream's release assets; both are staged by build-rpm.sh.

%install
mkdir -p %{buildroot}%{_libdir}/gobbonet
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/256x256/apps

cp -a usr/lib/gobbonet/. %{buildroot}%{_libdir}/gobbonet/

# The Debian package puts everything under /usr/lib/gobbonet. On Fedora,
# architecture-specific content belongs in %%{_libdir} -- /usr/lib64 here. That
# is also where 1.7.3-3 put it, and it must stay there: every existing user's
# config names %%{_libdir}/gobbonet/llama-cpp/llama-server as its engine.
#
# gobbonet-launch needs no rewrite for that. It resolves its own location:
#
#     PREFIX="$(dirname "$(readlink -f "$0")")"
#
# so it lands on /usr/lib64/gobbonet by itself, and everything else it uses --
# the binary, the engine, the catalogue -- hangs off PREFIX.
#
# There WAS a rewrite here, from when that line was a hardcoded
# PREFIX="/usr/lib/gobbonet", with a grep guarding that the rewrite had
# landed. The launcher changed to self-locating and the rewrite was left
# behind: the sed then matched nothing, the guard fired, and %install exited 1.
# The guard was doing its job. What it guarded no longer existed, and it was
# the only thing stopping this package from building at all.
#
# The desktop entry is a different matter and IS rewritten below -- a .desktop
# Exec line cannot resolve anything for itself.

install -m 0644 usr/share/applications/gobbonet.desktop \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop
sed -i 's|^Exec=/usr/lib/gobbonet/gobbonet-launch|Exec=%{_libdir}/gobbonet/gobbonet-launch|' \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop
grep -q '^Exec=%{_libdir}/gobbonet/gobbonet-launch' \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop \
    || { echo "ERROR: Exec rewrite missed in gobbonet.desktop" >&2; exit 1; }

# The setup wizard is the Debian one. Two of its lines name Debian specifics
# and are rewritten here, then checked, exactly as Fedora revision 3 shipped
# them: the program-files path, and the firewall command -- Fedora uses
# firewalld, and a UFW command would be advice for a tool that is not there.
sed -i \
    -e "s|The Debian package manages program files in /usr/lib/gobbonet\.|The Fedora package manages program files in %{_libdir}/gobbonet.|" \
    -e "s|'If you use UFW: sudo ufw allow ' + Number(\$('web-port').value) + '/tcp'|'For your trusted network zone: sudo firewall-cmd --permanent --add-port=' + Number(\$('web-port').value) + '/tcp \&\& sudo firewall-cmd --reload'|" \
    %{buildroot}%{_libdir}/gobbonet/wizard.html
grep -q 'The Fedora package manages program files in %{_libdir}/gobbonet' \
    %{buildroot}%{_libdir}/gobbonet/wizard.html \
    || { echo "ERROR: program-files path rewrite missed in wizard.html" >&2; exit 1; }
grep -q 'sudo firewall-cmd --permanent --add-port=' \
    %{buildroot}%{_libdir}/gobbonet/wizard.html \
    || { echo "ERROR: firewalld rewrite missed in wizard.html" >&2; exit 1; }
! grep -q 'ufw allow' %{buildroot}%{_libdir}/gobbonet/wizard.html \
    || { echo "ERROR: wizard.html still shows a UFW command" >&2; exit 1; }

install -m 0644 usr/share/icons/hicolor/256x256/apps/gobbonet.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/gobbonet.png
# README and the licences are NOT installed by hand. %%license and %%doc in
# %%files place them, and a manual copy into the same directory lands on the
# exact path %%doc uses and fails the build on duplicate files.

# /usr/bin/gobbonet is a link to the guided LAUNCHER, same as the deb, so the
# command is on PATH without putting the whole private directory there. Not to
# the Go binary: that skips first-run setup and the browser launch -- the
# "command bypassing setup/browser launch" bug Debian revision 3 fixed.
#
# Relative, so it resolves the same inside a chroot, an image build or an
# ostree deployment as on the running system. The launcher follows it with
# readlink -f either way.
ln -s "$(realpath -m --relative-to=%{_bindir} %{_libdir}/gobbonet/gobbonet-launch)" \
    %{buildroot}%{_bindir}/gobbonet
[ "$(readlink -f %{buildroot}%{_bindir}/gobbonet)" = "%{buildroot}%{_libdir}/gobbonet/gobbonet-launch" ] \
    || { echo "ERROR: /usr/bin/gobbonet does not resolve to the launcher" >&2; exit 1; }

chmod 0755 %{buildroot}%{_libdir}/gobbonet/gobbonet
chmod 0755 %{buildroot}%{_libdir}/gobbonet/gobbonet-launch
find %{buildroot}%{_libdir}/gobbonet/llama-cpp -type f -name 'llama-*' -exec chmod 0755 {} \; 2>/dev/null || :

%post
# Same two cache refreshes the Debian postinst does, for the same reason: the
# menu entry and its icon may otherwise not appear until the next login, which
# reads to the user as a failed install. Current Fedora also refreshes both
# through file triggers; running them here as well costs nothing and covers
# anything that does not.
#
# RPM's $1 is a COUNT, not a Debian-style action word: 1 on first install, 2 or
# more on upgrade. Both want the refresh, so there is no case split here -- the
# Debian version only looks like it has one because dpkg tells it about aborts.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q %{_datadir}/applications || :
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f -t %{_datadir}/icons/hicolor || :
fi

# A web/ the SERVER wrote into the program directory. It exports its built-in
# page beside the binary whenever that directory is writable -- which, for a
# packaged install, means only when someone ran GobboNet as root (`sudo
# gobbonet` is the usual way). Nothing owns what it wrote, so it would outlive
# the package; and on an upgrade it describes the previous version. Removed
# only when it carries the server's own stamp, so nothing that is not the
# server's export is ever touched.
if [ -f %{_libdir}/gobbonet/web/.gobbonet-ui ]; then
    rm -rf %{_libdir}/gobbonet/web
fi

# Deliberately absent, exactly as on Debian: nothing writes into a user's home.
# This runs as root, so a config created here would be root-owned in whichever
# home it guessed at, and the user who then set their own password could not
# write to it. First launch creates it, as the user. `gobbonet setup` does it.
:

%preun
# On removal only ($1 = 0; an upgrade is 1), the same stamped export as above,
# so rpm can remove %%{_libdir}/gobbonet instead of leaving it behind non-empty.
if [ "$1" = "0" ] && [ -f %{_libdir}/gobbonet/web/.gobbonet-ui ]; then
    rm -rf %{_libdir}/gobbonet/web
fi
:

%postun
# $1 here is the number of copies LEFT: 0 on a real removal, 1 on the removal
# half of an upgrade. Refresh either way -- an upgrade may have changed the
# desktop entry.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q %{_datadir}/applications || :
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f -t %{_datadir}/icons/hicolor || :
fi

# The notice prints on removal only, never on an upgrade. This is the RPM
# equivalent of the Debian PKG-1 fix: dpkg runs postrm twice on a purge and the
# second copy told the user to reinstall in order to delete files, at the exact
# moment they had asked for everything to be gone. Here the equivalent mistake
# would be printing it during every upgrade, so the test is $1 = 0.
if [ "$1" = "0" ]; then
    echo ""
    echo "  GobboNet's program files are gone."
    echo ""
    echo "  Your conversations, config and downloaded models were left alone —"
    echo "  a package script running as root should not delete files out of"
    echo "  home directories."
    echo ""
    echo "  To remove those too, reinstall and run:  gobbonet uninstall"
    echo "    --keep-models / --remove-models / --yes are all accepted."
    echo ""
fi
:

%files
%license usr/share/doc/gobbonet/LICENSE
%license usr/share/doc/gobbonet/LICENSE.llama-cpp
%doc usr/share/doc/gobbonet/FEDORA.md
%{_bindir}/gobbonet
%dir %{_libdir}/gobbonet
%{_libdir}/gobbonet/*
%{_datadir}/applications/gobbonet.desktop
%{_datadir}/icons/hicolor/256x256/apps/gobbonet.png

%changelog
* Thu Sep 24 2026 GobboNet - 1.7.6-1
- 1.7.6. The chat page is compiled into the server, so there is no web/.
- Fedora 45 and later: requirements are generated from the engine's own
  library needs, so dnf installs openssl3-libs where OpenSSL 4 is the default.
  The hand-written "openssl-libs >= 3.0" this replaces was satisfied by
  OpenSSL 4 and installed an engine that could not start.
- Build-host independent: unversioned doc and licence directories, no
  build-id links and a zstd payload are pinned here, not inherited.
- /usr/bin/gobbonet runs the guided launcher (now a relative link), the wizard
  names /usr/lib64 and firewalld, FEDORA.md is the doc, llama.cpp's licence
  ships beside GobboNet's, and the License field lists what is bundled.
- A web/ a root-run server wrote into the program directory is removed on
  upgrade and on removal instead of being left behind.

* Tue Sep 08 2026 GobboNet - 1.7.3-3
- Fedora RPM using the working Debian revision 3 runtime and guided launcher.
- Include wizard dependencies, private engine libraries and firewalld guidance.

* Tue Sep 08 2026 Elodine <https://github.com/ElodineOfficial> - 1.7.3-1
- First Fedora package. Contents match the 1.7.3 .deb.
- Upstream model list in remote mode (#47, #48, #27).
- Ranked LAN addresses in the launcher banner; doctor gains a LAN section.
- Confirmation-prompt and path-sanitiser fixes from PR #30.
