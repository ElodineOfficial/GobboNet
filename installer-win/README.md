# Windows installer

**This is the Windows installer.** Build releases from here, not from
`installer/`; see "Not to be confused with `installer/`" below.

This is the script that built `GobboNetSetup-1_7_0.exe` and everything before
it. It installs `launch.bat`, the first-run questions, and the Go binary it hands
over to (since 1.7.6). Since 1.8.0 it no longer installs `fileserver.ps1`, the
PowerShell server, and deletes the copy an older install left.

```sh
bash ./scripts/make-zip.sh                             # dist/GobboNet-<ver>.zip
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

For 1.8.0, against the official `GobboNetSetup-1_7_9.exe` itself. First the
toolchain: the `v1.7.9` script, compiled with the official installer's own
payload (extracted by 7-Zip, file times kept), gives a file **byte-identical
to the official one** once the stub and the three plugins carry 1.7.9's link
times. They are the same compiler's output (MinGW-w64 GCC from Ubuntu 24.04),
and those link times are the only bytes in which they differ. Then the 1.8.0
build, made with that same NSIS: see "1.8.0" below.

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

- **`gobbonet.exe` is installed.** `launch.bat` hands the server role to it.
  Up to 1.7.9 `fileserver.ps1` was the fallback without it, and it had no
  per-conversation sync routes, so chat backup and device sync needed the Go
  binary from 1.7.6 on. Since 1.8.0 it is the only server.
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
  ends everything it started (1.7.9, PR #15). Since 1.8.0 `launch.bat` only
  downloads the embedding model; `gobbonet.exe` starts the embedding server.
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

## 1.8.0: the same installer, for the 1.8.0 payload

Pages, texts, colours, password and port handling, shortcuts, registry entries,
folder and compression are 1.7.9's. What changed:

- **`APPVER` 1.8.0**, and with it `OutFile` and `VIProductVersion`, from the
  version bump.
- **The header says `v1.8`** (`art/modern-header.bmp`; see art/ below).
- **The payload:** `fileserver.ps1` is gone and a stale copy is deleted on
  install (round 6, `CHANGELOG-1.8.0-legacy-removal.md`); six new page files
  (`js/26` to `js/29`, `css/20` and `css/21`) arrive through the `js\*.js` and
  `css\*.css` lines.
- **The uninstaller removes what the update button leaves** beside the
  program: `gobbonet.exe.old` (or `gobbonet.exe.old-<n>`), kept until GobboNet
  next starts, and `gobbonet.new.exe`, a new program whose checks never
  finished. Without that, uninstalling after an update and before a restart
  left the folder behind. `gobbonet uninstall`, which the uninstaller runs,
  likewise removes the update's download folder in the data folder.

**How it was built:** NSIS 3.12 large strings as above, with the stub
(`Stubs/lzma_solid-x86-unicode`) and `System.dll`, `nsDialogs.dll` and
`nsExec.dll` given 1.7.9's link times, so the installer engine and its plugins
are the very files 1.7.9 shipped. Staged from the extracted 1.8.0 update ZIP.

**How it was checked** (`CHANGELOG-1.8.0-windows-installer.md` has the
details):

- the 66 payload files are byte-for-byte the ZIP's; the file list is 1.7.9's
  without `fileserver.ps1`, plus the six page files;
- decoded and lined up against the official 1.7.9, the installer's 1,229
  instructions differ from 1.7.9's 1,223 only in the title and
  `DisplayVersion`, the `fileserver.ps1` line and the six files; the
  uninstaller's 466 differ from 463 only in the three update leftovers; every
  jump lands where 1.7.9's does; the string tables differ only in those, and
  the stub only in its version resource;
- run under Wine 9.0 beside the official 1.7.9: every page, screenshot by
  screenshot, differs only in the version marks and the size of the install;
  a fresh install, an upgrade over 1.7.9 (models, engine and password kept,
  `fileserver.ps1` deleted) and an uninstall after an update, which leaves
  nothing behind where 1.7.9's left the folder.

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

`art/modern-header.bmp` carries the version as painted pixels — `v1.8` covers
the whole 1.8.x line. It is not generated, so it does not follow `APPVER`; on a
minor bump the bitmap has to be repainted or the wizard shows the old number
while every other surface shows the new one.

How 1.8.0's was repainted, for the next one: `v1.` is DejaVu Sans Mono at 8
pixels, colour `#56801E` on `#0D0E12`, starting at x=53, y=33. The digit was
painted by hand, heavier than the font's own (whose 8 at this size blurs into
a 0). The `7` was cleared to the background (x 66-72, y 32-39, plain
background otherwise) and an `8` painted in its 5×6 box at x=67, y=33, in the
three shades the `1` beside it uses: `#56801E`, `#42601B`, `#222E15`. Rows,
top to bottom, with 9, 7, 3 for those shades:

```
79997
9...9
39993
9...9
9...9
79997
```

Only those 20 pixels changed; the file was patched in place, so the rest of
it is byte-for-byte 1.7's. The copy under `installer/art/`
was stale at `v1.3` for exactly this reason and has been replaced with the
shipped one.
