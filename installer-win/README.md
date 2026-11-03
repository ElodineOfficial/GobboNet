# Windows installer

**This is the Windows installer.** Build releases from here, not from
`installer/`; see "Not to be confused with `installer/`" below.

This is the script that built `GobboNetSetup-1_7_0.exe` and everything before
it. It installs the batch/PowerShell path — `launch.bat` and `fileserver.ps1` —
and, since 1.7.6, the Go binary.

```sh
./scripts/make-zip.sh                                  # dist/GobboNet-<ver>.zip
unzip -q dist/GobboNet-*.zip -d /tmp/gn
installer-win/stage-payload.sh /tmp/gn/GobboNet   # -> ../staging, from the ZIP
cd installer-win && makensis gobbonet.nsi      # NSIS 3.12, large strings
```

Only `!define APPVER` changes between releases. `OutFile` and
`VIProductVersion` track it.

## Building it: which NSIS, and how to check the result

**NSIS 3.12, the large-strings build** (`NSIS_MAX_STRLEN=8192`). That is what
compiled the 1.7.7 installer: its stub is NSIS 3.12's, and its compiled script
has 8192-character string slots. A standard build (1024) changes how long a
string the installer can hold. A different version changes the installer
engine. Neither is a change this script asked for. Check with `makensis
-HDRINFO`: "Size of each section is 32792 bytes" is the large-strings build.

**Stage from the ZIP.** `stage-payload.sh` reads its file list from this
script's `File "${APPSRC}\..."` lines, so the two cannot drift, and staging
from the unpacked ZIP puts the same bytes in the installer as in the ZIP
beside it. `tests/test-windows-staging.py` holds it to that.

**Compare with the last release.** 7-Zip lists and extracts an NSIS
installer, so the payloads can be compared file by file. The compiled script
can be compared too: decompress the header and list each instruction with its
strings. Done for 1.7.8 against the official 1.7.7, as recorded in
`docs/changelog/CHANGELOG-1.7.8-windows-installer-build.md`, the instruction
lists of the installer and the uninstaller differ by exactly this script's
diff since `v1.7.7`, and nothing else.

Done again for 1.7.9 against 1.7.8, compiled with the same makensis: the
instruction lists differ in the title, the password label and its minimum (8),
the "Setup or add a model" shortcut, and three new payload files; the
uninstaller's list is identical. See
`docs/changelog/CHANGELOG-1.7.9-windows-installer.md`.

On Linux, makensis and the Windows stubs build from the NSIS source (tag
`v312`) with SCons, either way:

- **MinGW-w64 GCC** (`gcc-mingw-w64-i686`, NSIS's own documented cross
  toolchain), no patches. This built 1.7.9's installer:

  ```sh
  scons -j1 XGCC_W32_PREFIX=i686-w64-mingw32- NSIS_MAX_STRLEN=8192 \
    NSIS_CONFIG_CONST_DATA_PATH=no VERSION=3.12 SKIPTESTS=all \
    SKIPUTILS="Library/RegTool,MakeLangId,Makensisw,NSIS Menu,SubStart,VPatch/Source/GenPat,zip2exe" \
    PREFIX=$HOME/nsis install
  NSISDIR=$HOME/nsis $HOME/nsis/makensis gobbonet.nsi
  ```

  Use `-j1`: a parallel build races on the docs directory. Keep the UIs
  (don't `SKIPUTILS=all`), or `modern.exe` is missing.
- **llvm-mingw** (clang), with `nsis-3.12-llvm-mingw.patch`, which built 1.7.8:
  lld has no linker scripts or `--exclude-libs`, and clang needs C linkage on
  NSIS's own `memset`/`memcpy` and has no `.func`. The 1.7.8 changelog has
  how that result was checked against the official 1.7.7.

Both give NSIS 3.12's installer engine with 8192-character strings; only the
compiler of the stub differs.

## 1.7.6: the same installer, plus gobbonet.exe

Same pages, same first-run flow (`launch.bat` fetches llama.cpp and offers the
model catalogue on first launch); nothing is downloaded during setup. Three
additions, all forced by shipping the Go server:

- **`gobbonet.exe` is installed.** `launch.bat` hands the server role to it
  when present. `fileserver.ps1` alone has no per-conversation sync routes, so
  1.7.6's chat backup and device sync would fail without it.
- **GobboNet is stopped before files are replaced or removed**
  (`stop-gobbonet.bat /quiet`), because a running `gobbonet.exe` holds its own
  file open.
- **Uninstall runs `gobbonet uninstall --yes --keep-models`**, which removes
  the conversations and settings the Go server keeps in the user profile, then
  deletes `gobbonet.exe` and the `web\` folder it writes. Models are still the
  uninstaller's own question.

Staging for a build: copy into `../staging` the files the script lists
(`launch.bat`, the other `.bat`/`.ps1` helpers, `chat.html`,
`default-characters.json`, `LICENSE`, `TROUBLESHOOTING.md`, `SECURITY.md`,
`js/`, `css/`), plus:

- `gobbonet.exe` from `make-zip.sh`;
- `PURGE.md` from `docs/PURGE.md`. It moved there in 1.7.2, but the install
  keeps it at the root, where `TROUBLESHOOTING.md` points;
- `models.ini` from `catalog/models.ini` (1.7.7);
- `engine.sha256` from the repo root (1.7.8). `launch.bat` reads its
  llama.cpp pin from it, and `gobbonet engine install` needs it beside the
  program.

## 1.7.7: the same pages again

The maintainer's direction: the installer acts the way it did in 1.7.5. The
pages are the ones this script has always had:

1. Welcome
2. Destination
3. Access Password (or "Skip - ask me on first run instead")
4. Network Port (9066)
5. Install. It copies files only and downloads nothing.
6. One Thing Before You Start, the Windows Defender notice
7. Finish: [x] Launch GobboNet, [ ] Set up phone access over the LAN

*Launch GobboNet* runs `gobbonet.exe launch` (below). On a new install there
are no settings yet, so it opens `launch.bat` in its console window. That
window fetches llama.cpp, detects the hardware and offers the model list, then
hands over to `gobbonet.exe` and opens the browser.

One addition: **`models.ini` is installed.**

- *Add a Model* in CONFIG falls back to it when goblincorps.com can't be
  reached.
- Its *Coding*, *Roleplay* and *Jack of all trades* buttons take each model's
  type from it until the live list carries the tags.

Without it, an installed copy had no list offline, and the type buttons
matched nothing. See `docs/changelog/CHANGELOG-1.7.7-windows-installer.md`.

## 1.7.8: the 1.7.6 hotfix's shortcuts

The 1.7.6 hotfix (patch 3) made the main shortcuts start GobboNet directly,
and shipped that in its own installer build; 1.7.7 carried the application
side over first. This script now matches it:

- **GobboNet** (Start menu and desktop) and the new **Launch GobboNet** run
  `gobbonet.exe launch`. It serves the saved settings straight away and opens
  the browser. With no settings yet it runs `launch.bat`'s first-run setup.
  So does a first run that stopped before its end and left no engine set:
  `launch.bat` keeps a `.gobbonet-setup-pending` mark until it finishes.
- **Setup or add a model** runs `gobbonet.exe launch --setup`, which runs
  `launch.bat`: the engine download, hardware check and model menu. Going
  through `gobbonet.exe` puts it in a kill-on-close job, so closing the window
  also ends the embedding server it started (1.7.9, PR #15).
- The finish page's *Launch GobboNet* runs the same command as the shortcuts,
  in the same folder.
- Every link is recreated on each install, so updating over an older version
  re-points links that ran `launch.bat`. The uninstaller removes the two new
  links, without which it could not remove the Start menu folder.
- **GobboNet LAN Setup** is unchanged, still flagged *Run as administrator*.

ZIP installs get the same links from `Repair Windows shortcuts.bat`. See
`docs/changelog/CHANGELOG-1.7.6-windows-launch.md` and
`docs/changelog/CHANGELOG-1.7.8-hotfix-installers.md`.
`tests/test-windows-launch.py` holds both scripts to it.

## Not to be confused with `installer/`

`installer/gobbonet.nsi` is a different, unreleased script for a Go-server
Windows install: it adds backend, GPU-probe and model-download pages, bundles
`gobbonet.exe` and llama.cpp, and downloads a model during setup behind an
`inetc /BANNER` popup. Build from **this** directory unless you are
deliberately working on that one.

It was built by mistake twice: for 1.7.4, and for the first 1.7.7 test build.
Both times it replaced this installer's flow with one the maintainer did not
want. `tests/test-windows-installer.py` now holds this script to its pages and
`docs/BUILDING.md` to naming it.

## art/

`art/modern-header.bmp` carries the version as painted pixels — `v1.7` covers
the whole 1.7.x line. It is not generated, so it does not follow `APPVER`; on a
minor bump the bitmap has to be repainted or the wizard shows the old number
while every other surface shows the new one. The copy under `installer/art/`
was stale at `v1.3` for exactly this reason and has been replaced with the
shipped one.
