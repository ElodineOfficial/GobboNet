# GobboNet RPM spec — the Fedora counterpart to installer-linux/build-deb.sh.
#
# Everything here is a translation of a decision already made and documented on
# the Debian side; where the two package formats disagree the reason is noted
# rather than left to be rediscovered.
#
# Build with installer-fedora/build-rpm.sh, which fills in Version, Release and
# the staged tree. Do not run rpmbuild against this by hand and expect a sane
# result: the spec deliberately does not fetch anything.

# GobboNet ships prebuilt binaries -- our Go server and upstream's llama.cpp --
# so there is nothing to extract debug symbols FROM in the usual sense, and an
# empty debuginfo subpackage fails the build outright.
%global debug_package %{nil}

# Do not strip. The Go binary carries its build metadata in a section that
# `gobbonet version` and `debug/buildinfo` read; brp-strip removes it, which
# turns a supportable binary into one that cannot say what it is. The llama.cpp
# .so files are upstream's and are not ours to modify either.
%global __os_install_post %{nil}

# Bundled libraries must not be advertised system-wide. Without this the package
# would Provide libggml-base.so()(64bit) and friends, and an unrelated package
# could resolve its dependency against a copy of llama.cpp living inside
# GobboNet's private directory -- which would then vanish when GobboNet is
# removed. Fedora's bundling guidelines require this filter.
%global __provides_exclude_from ^%{_libdir}/gobbonet/.*\\.so.*$

# The bundled engine's own NEEDED entries are filtered too, so libvulkan does
# not become a hard dependency. It genuinely is not one: pick_engine() in
# gobbonet-launch probes the GPU build, and falls back to the CPU build or to
# a plain error if Vulkan is missing. Making it Requires: would refuse to
# install on a machine GobboNet runs on perfectly well.
%global __requires_exclude_from ^%{_libdir}/gobbonet/llama-cpp(-cpu)?/.*$

Name:           gobbonet
Version:        %{gn_version}
Release:        %{gn_release}%{?dist}
Summary:        Local chat for local models. No account, no API key, no telemetry

# LICENSE says "either version 3 of the License, or (at your option) any later
# version", which is -or-later, not the bare AGPL-3.0.
License:        AGPL-3.0-or-later
URL:            https://github.com/ElodineOfficial/GobboNet

# x86_64 only, because the bundled llama.cpp build is. An aarch64 package would
# need its own engine asset; refusing here is better than installing something
# with no engine that can run.
ExclusiveArch:  x86_64

# Sources are staged by build-rpm.sh rather than fetched, so BuildArch content
# arrives ready. Nothing is compiled at rpmbuild time.
Source0:        gobbonet-payload.tar.gz

# No BuildRequires. Nothing is compiled here, and coreutils/tar/sed are on
# Fedora's default buildroot exception list -- the guidelines say not to
# require them explicitly.

# xdg-utils is used by gobbonet-launch to open the browser. Hard requirement:
# without it a graphical install has no way to show the user the chat.
Requires:       xdg-utils

# Weak dependencies, matching the Debian Recommends line for line.
#   vulkan-loader        = Debian libvulkan1
#   mesa-vulkan-drivers  = Debian mesa-vulkan-drivers | vulkan-driver
# Neither is required: the CPU engine works without them, slower.
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
install has something to run without a second download. Models are not bundled;
GobboNet downloads them on request into the user's own data directory.

Configuration and conversations live under the invoking user's ~/.config and
~/.local/share, created on first launch by that user. Nothing in this package
writes to a home directory during installation.

%prep
%setup -q -c -n gobbonet-payload

%build
# Nothing to build. The Go binary is produced by build-release.sh and the engine
# comes from upstream's release assets; both are staged by build-rpm.sh.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{_libdir}/gobbonet
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/256x256/apps

cp -a usr/lib/gobbonet/. %{buildroot}%{_libdir}/gobbonet/

# The Debian package puts everything under /usr/lib/gobbonet. On Fedora,
# architecture-specific content belongs in %%{_libdir} -- /usr/lib64 here -- so
# the two hardcoded paths are rewritten to match rather than shipping a
# Debian-shaped tree on a Fedora system. Both files are the only places the
# prefix appears; gobbonet-launch derives everything else from PREFIX.
sed -i 's|^PREFIX="/usr/lib/gobbonet"|PREFIX="%{_libdir}/gobbonet"|' \
    %{buildroot}%{_libdir}/gobbonet/gobbonet-launch
grep -q '^PREFIX="%{_libdir}/gobbonet"' %{buildroot}%{_libdir}/gobbonet/gobbonet-launch \
    || { echo "ERROR: PREFIX rewrite missed in gobbonet-launch" >&2; exit 1; }

install -m 0644 usr/share/applications/gobbonet.desktop \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop
sed -i 's|^Exec=/usr/lib/gobbonet/gobbonet-launch|Exec=%{_libdir}/gobbonet/gobbonet-launch|' \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop
grep -q '^Exec=%{_libdir}/gobbonet/gobbonet-launch' \
    %{buildroot}%{_datadir}/applications/gobbonet.desktop \
    || { echo "ERROR: Exec rewrite missed in gobbonet.desktop" >&2; exit 1; }

install -m 0644 usr/share/icons/hicolor/256x256/apps/gobbonet.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/gobbonet.png
# README and LICENSE are NOT installed by hand. %%license and %%doc in %%files
# place them, and on Fedora _docdir_fmt is %%{name}, so a manual copy into
# %%{_datadir}/doc/gobbonet lands on the exact path %%doc uses and the build
# fails on duplicate files. Built on a non-Fedora host the docdir is versioned
# and the collision hides -- which is the worst version of this bug, because it
# only appears on the distro the package is for.

# /usr/bin/gobbonet is a symlink to the real binary, same as the deb, so the
# command is on PATH without putting the whole private directory there.
ln -sf %{_libdir}/gobbonet/gobbonet %{buildroot}%{_bindir}/gobbonet

chmod 0755 %{buildroot}%{_libdir}/gobbonet/gobbonet
chmod 0755 %{buildroot}%{_libdir}/gobbonet/gobbonet-launch
find %{buildroot}%{_libdir}/gobbonet/llama-cpp -type f -name 'llama-*' -exec chmod 0755 {} \; 2>/dev/null || :

%post
# Same two cache refreshes the Debian postinst does, for the same reason: the
# menu entry and its icon may otherwise not appear until the next login, which
# reads to the user as a failed install.
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

# Deliberately absent, exactly as on Debian: nothing writes into a user's home.
# This runs as root, so a config created here would be root-owned in whichever
# home it guessed at, and the user who then set their own password could not
# write to it. First launch creates it, as the user. `gobbonet setup` does it.
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
%license usr/share/doc/gobbonet/copyright
%doc usr/share/doc/gobbonet/README.md
%{_bindir}/gobbonet
%dir %{_libdir}/gobbonet
%{_libdir}/gobbonet/*
%{_datadir}/applications/gobbonet.desktop
%{_datadir}/icons/hicolor/256x256/apps/gobbonet.png

%changelog
* Tue Sep 08 2026 Elodine <https://github.com/ElodineOfficial> - 1.7.3-1
- First Fedora package. Contents match the 1.7.3 .deb.
- Upstream model list in remote mode (#47, #48, #27).
- Ranked LAN addresses in the launcher banner; doctor gains a LAN section.
- Confirmation-prompt and path-sanitiser fixes from PR #30.
