# 1.7.9 — the Windows installer

## What was asked

The maintainer: the 1.7.9 Windows installer "needs to work just like the
installer for 1.7.8, it just needs to be updated."

## The change

`installer-win/gobbonet.nsi` is 1.7.8's script with:

- `APPVER` 1.7.9 (and so `OutFile` and `VIProductVersion`), from the version
  bump;
- three new payload files: `js/25-tutorial.js`, `css/18-config-sections.css`
  and `css/19-tour.css` (the tour and the CONFIG sections). The `File` lines
  take `js\*.js` and `css\*.css`, so the script did not need to name them;
- **Setup or add a model** runs `gobbonet.exe launch --setup` instead of
  `launch.bat` (PR #15), so closing that window ends the embedding server too;
- the Access Password page's minimum is 8, matching 1.7.9's default for a new
  password. The password-setting change had already raised the check to
  `${If} $3 < 8` ("Use at least 8 characters."), but the label above the box
  still said "Six characters minimum". It now says "Eight characters minimum."
  `tests/test-password-minimum.py` checks that the label and the check agree.

The pages are 1.7.8's, in the same order: Welcome, Destination, Access
Password, Network Port, Install, One Thing Before You Start, Finish. Nothing
is downloaded during setup; the first launch runs `launch.bat`'s first-run
setup as before.

## How it was built

NSIS 3.12, the large-strings build (`NSIS_MAX_STRLEN=8192`; `-HDRINFO`: "Size
of each section is 32792 bytes"), the same as 1.7.8. It was built from the NSIS
`v312` tag with MinGW-w64 GCC (Ubuntu's `gcc-mingw-w64-i686`), which needs no
patches. 1.7.8 used llvm-mingw with `nsis-3.12-llvm-mingw.patch`; llvm-mingw
could not be downloaded where this was built. The command is in
`installer-win/README.md`. makensis printed no warnings.

The payload was staged from the extracted `GobboNet-1_7_9.zip` with
`stage-payload.sh`.

## How it was checked

- **Payload:** the 61 files staged (17 at the top, 25 in `js`, 19 in `css`)
  are byte-for-byte the ones in the zip (`PURGE.md` from `docs/PURGE.md`,
  `models.ini` from `catalog/models.ini`), and every `File` line resolves.
  The icon comes from `installer-win/art/`, as before.
- **Compiled script against 1.7.8:** 1.7.8's `gobbonet.nsi` was compiled with
  the same makensis. Both installers were decompressed and their instructions
  listed with their strings (a small NSIS 3 decoder written from
  `Source/exehead/fileform.h`). The string tables were lined up, and jumps
  were mapped across the three inserted instructions. 1.7.8 has 1220
  instructions and 1.7.9 has 1223. Apart from the three file extractions,
  they differ in exactly six places:
  1. the window title, GobboNet 1.7.8 → 1.7.9;
  2. the password label, Six → Eight characters minimum;
  3. the minimum check, 6 → 8;
  4. its message, "Use at least six characters." → "Use at least 8 characters.";
  5. the Setup or add a model shortcut, `launch.bat` → `gobbonet.exe launch --setup`;
  6. the uninstaller's offset in the data, which moves because the payload
     grew.
- **Uninstaller:** its 463 instructions are identical to 1.7.8's.
- **Tests:** `test-windows-installer.py`, `test-windows-staging.py`,
  `test-windows-launch.py`, `test-password-minimum.py` and
  `test-version-strings.py` pass.

## Not done here

- The installer was not run on Windows. There is no Windows machine here.
- It is not code-signed, the same as 1.7.8, so SmartScreen will warn on
  first run.
- It was not compared with the official `GobboNetSetup-1_7_8.exe`, which
  could not be downloaded here. It was compared with 1.7.8's script compiled
  by the same makensis.

## Rebuilt after the .deb (gobbonet uninstall)

Testing the `.deb` found that `gobbonet uninstall` never read the user's
config, so it missed a changed `data_dir`
(`CHANGELOG-1.7.9-linux-installer.md`). The uninstaller here runs
`gobbonet.exe uninstall --yes --keep-models`, so the fix reaches Windows
through `gobbonet.exe`. The installer was rebuilt from the new ZIP. Its
script is unchanged. Of its 61 files, only `gobbonet.exe` differs from the
build tested first, and the decoded comparison with 1.7.8 is the same as
above.

## Rebuilt with Go 1.25.14, and compared with the official 1.7.8

The first 1.7.9 builds used Go 1.25.0. 1.7.8's `gobbonet.exe` was built with
1.25.14, and so is this one (`CHANGELOG-1.7.9-fedora-installer.md`). The
installer's script is unchanged, and of its 61 files only `gobbonet.exe`
differs from the build tested on Windows.

The official `GobboNetSetup-1_7_8.exe` could be downloaded by now, and 7-Zip
unpacks it. Its file list and 1.7.9's differ by the three new page files. The
files that changed are this release's, plus NSIS's `System.dll`,
`nsDialogs.dll` and `nsExec.dll`. Those plugins are compiled with NSIS
itself: 1.7.8's with llvm-mingw, this one's with MinGW-w64 GCC.
`engine.sha256` changed in one comment line (the old `installer/` path); its
pins are 1.7.8's.
