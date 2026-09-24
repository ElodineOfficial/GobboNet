# GobboNet 1.7.6

Build: 1.7.6-go-nogit.20260924

Full source and Windows/Linux amd64 executables. The Windows installer
(GobboNetSetup-1_7_6.exe), the Debian package
(gobbonet_1.7.6+go.nogit.20260924-1_amd64.deb) and the Fedora package
(gobbonet-1.7.6-1.go.nogit.20260924.fedora.x86_64.rpm) are shipped alongside
this zip.

## Install

- Windows, new install: run GobboNetSetup-1_7_6.exe. It is the 1.7.0
  installer with gobbonet.exe added: same pages, nothing downloaded during
  setup; the first launch fetches llama.cpp and offers the model catalogue.
- Updating an existing install: stop GobboNet, replace gobbonet.exe (Windows)
  or gobbonet / linux-amd64/gobbonet (Linux), start it, and reload any open
  tabs. Configuration, data, engine and models stay as they are; the
  interface updates itself.
- Linux: `sudo apt install ./gobbonet_1.7.6+go.nogit.20260924-1_amd64.deb` (shipped
  alongside), or run from this ZIP; see LINUX-START-HERE.md.
- Fedora: `sudo dnf install ./gobbonet-1.7.6-1.go.nogit.20260924.fedora.x86_64.rpm`
  (shipped alongside). Use dnf, not rpm -i: Fedora 45 refuses unsigned
  packages through rpm, and there dnf also brings in openssl3-libs, which the
  bundled engine needs. See installer-fedora/FEDORA.md.

## What is in 1.7.6

Everything from the CPU/RAM runtime package (PR #60 and the corrective,
launcher, memory-QOL, state-handshake and CPU/RAM runtime updates), plus the
1.7.5 behaviour those updates had lost: device sync (shared / separate
profile / off), replies recovered at startup, dragged chats floating back when
used, the 1.7.5 sidebar arrangement kept, crash recovery that keeps retrying,
launch.bat GPU layers, and the interface updating when the executable is
replaced. Details are in docs/changelog/.

## Building

make-zip.sh builds the executables. The Windows installer is built from
installer-win/ (see installer-win/README.md for staging; NSIS 3.09).
installer-linux/build-deb.sh builds the .deb (see LINUX-START-HERE.md).
installer-fedora/build-rpm.sh builds the .rpm (see installer-fedora/README.md).
installer/ holds a separate, never-shipped installer design.
