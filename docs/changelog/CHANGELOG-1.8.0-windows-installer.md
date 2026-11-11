# 1.8.0 — the Windows installer

## What was asked

The maintainer: "You use the LAST installer as a visual guide [gobbonet 1.7.9
is perfect to pull for this]. Windows for instance has an entirely different
installer than Linux including visuals. And quite frankly we want them to work
the same way we just need them updated given this latest zip. So we'll go
through one by one. Let's start with the windows exe."

## The change

`installer-win/gobbonet.nsi` is 1.7.9's script with:

- `APPVER` 1.8.0 (and so `OutFile` and `VIProductVersion`), from the version
  bump (`CHANGELOG-1.8.0-version-bump.md`);
- `fileserver.ps1` no longer installed, and a stale copy deleted (round 6,
  already in the script);
- **the uninstaller deletes what the update button leaves** beside the
  program: `gobbonet.exe.old` or `gobbonet.exe.old-<n>` (the program it
  replaced, kept until GobboNet next starts) and `gobbonet.new.exe` (a new
  program whose checks never finished). These are the names
  `internal/update/install.go` gives them. Uninstalling after an update and
  before a restart otherwise left them, so the folder stayed;
- the header comment on the art corrected: it said a `make-branding.py`
  generates the bitmaps, and there is no such script.

`installer-win/art/modern-header.bmp` says **v1.8**. The 7 was repainted as an
8 in place, 20 pixels in the digit's box, in the shades the 1 beside it uses;
the rest of the file is unchanged. `installer-win/README.md` (art/) has the
pixel grid for the next repaint. The sidebar art and the icon are 1.7.9's.

The payload is the 1.8.0 ZIP's: 66 files, 1.7.9's 61 without `fileserver.ps1`,
plus `js/26-mcp.js`, `js/27-files-panel.js`, `js/28-update.js`,
`js/29-groups.js`, `css/20-files-panel.css` and `css/21-groups.css`, which
the `js\*.js` and `css\*.css` lines take in without naming them.

**`gobbonet uninstall`**, which the uninstaller runs, removes two things more
(`cmd/gobbonet/uninstall.go`):

- `<data_dir>/update`, where the update button keeps a download while it takes
  the program out. Once made it stays, and it kept the data folder from being
  removed, on every platform;
- on Linux, `launch.log` and `engine-choice` (1.8.0, #72) in the default data
  folder, whichever folder holds the conversations. `launch.log` used to be
  removed only when `data_dir` was elsewhere, so in the default folder it kept
  that folder too. Windows writes neither.

## How it was built

NSIS 3.12, the large-strings build, from the NSIS `v312` tag (e3f6040), with
Ubuntu 24.04's `gcc-mingw-w64-i686` (13.2.0-6ubuntu1+26.1) and SCons 4.5.2, by
the command in `installer-win/README.md`. `makensis -HDRINFO`: "Size of each
section is 32792 bytes". makensis printed no warnings.

**It reproduces the official 1.7.9 exactly.** The official
`GobboNetSetup-1_7_9.exe` was downloaded from the v1.7.9 release and unpacked
with 7-Zip. Its `$PLUGINSDIR` plugins (`System.dll`, `nsDialogs.dll`,
`nsExec.dll`) differ from this build's only in their link times (the PE
header's TimeDateStamp and the export table's copy of it), and its stub
differs only in the stub's link time. With those four link times set to
1.7.9's, the `v1.7.9` script compiled with the official installer's own
payload (file times kept) is **byte-identical** to the official file
(SHA-256 `ef488aac404bf226759d608ba87990babc28ed631d7560b937b9297eaa62c46e`).
So the script in the repository is what shipped, and so is this way of
building it.

**1.8.0 was compiled with that same NSIS,** link times included, so its stub
and plugins are the very files 1.7.9 shipped. The payload was staged from the
extracted 1.8.0 update ZIP with `stage-payload.sh`.

## How it was checked

- **Payload:** the 66 files, extracted from the built installer by 7-Zip, are
  byte-for-byte the ZIP's (`PURGE.md` from `docs/PURGE.md`, `models.ini` from
  `catalog/models.ini`); `gobbonet.ico` is the art one.
- **Compiled script against the official 1.7.9.** Both were decompressed and
  their instructions listed (a small NSIS 3 decoder written from
  `Source/exehead/fileform.h`). Parameters were compared by meaning: a string
  by its text wherever it is in the table, a jump by the instruction it lands
  on through the alignment of the two lists, a file's date and data offset
  left out. Checked first on the official 1.7.9 against its byte-identical
  rebuild, which reports nothing.
  - **Installer:** 1,223 instructions become 1,229. The differences are the
    title (GobboNet 1.7.9 → 1.8.0), `DisplayVersion` (1.7.9 → 1.8.0),
    `fileserver.ps1` deleted instead of installed, and the six new page files.
    Every jump lands on the instruction it did in 1.7.9.
  - **Uninstaller:** 463 instructions become 466, the three update-leftover
    deletes.
  - **Strings:** the two string tables differ only in the version strings
    (with the branding line), `fileserver.ps1`, the six file names and the
    three leftover paths. Every page text is 1.7.9's.
  - **Stub:** 8 bytes differ, all in the version resource (1.7.9 → 1.8.0).
- **Under Wine 9.0**, on a virtual display, both installers run in fresh
  prefixes, every page captured and compared with 1.7.9's pixel for pixel:
  - **Welcome:** differs only in the title's version.
  - **Destination, Access Password, Network Port, One Thing Before You Start:**
    only in the header's v1.8 and the branding line. Destination also shows
    "Space required" 14.6 MB (13.2 MB for 1.7.9), and the space free.
  - **Finish:** identical.
  - **Uninstaller:** welcome and finish identical, confirm only in the
    version marks.
  - **A fresh install:** the 66 files byte-for-byte the ZIP's, the six
    shortcuts with their targets, arguments and folder (GobboNet LAN Setup
    flagged Run as administrator), the uninstall registry entry with
    `DisplayVersion` 1.8.0, `.gobbonet-port` 9066.
  - **An upgrade over the installed 1.7.9**, password skipped: every file
    1.8.0's, `fileserver.ps1` deleted, a model, an engine folder and a stored
    password kept, the uninstaller replaced by 1.8.0's.
  - **An uninstall after an update**, with `gobbonet.exe.old`,
    `gobbonet.exe.old-<n>`, `gobbonet.new.exe` beside the program and an
    `update` folder in the data folder: 1.8.0's uninstaller leaves nothing,
    neither folder nor registry key nor shortcut. 1.7.9's, given the same
    files, left the install folder holding the three and the data folder
    holding `update`.
- **Tests:** `test-windows-installer.py` (new: the update leftovers are
  removed, after GobboNet is stopped and before the folder is), the uninstall
  tests in `cmd/gobbonet/uninstall_test.go` (new: the data folder goes after
  an update), and `test-windows-staging.py`, `test-windows-launch.py`,
  `test-password-minimum.py`, `test-version-strings.py`.

## Found, and left for the maintainer's call

- **`.gobbonet-lan`.** `setup-lan.bat` writes it, with a comment saying the
  uninstaller reads it to decide whether to offer the elevated teardown. No
  uninstaller has read it: the shipped 1.7.9 is byte-identical to its script,
  which never names it. It is not deleted either, so after LAN setup an
  uninstall leaves the folder holding it (1.7.9 too). The firewall rules are
  left, as the uninstaller's last comment says.
- **The mods folder.** `gobbonet uninstall` keeps `<data_dir>/mods`, as 1.7.9
  did, so the data folder stays for anyone with a mod. That may be deliberate
  (it is their code); nothing here says either way.
- **The finish page's text,** under Wine, is cut off after three lines by the
  two checkboxes. It is the same in 1.7.9, and could not be checked on
  Windows.
- **Linux only, for the Linux rounds:** GobboNet's own embedding model in
  `<data_dir>/embeddings` is not removed by `gobbonet uninstall`. Fixed in
  the .deb round (`CHANGELOG-1.8.0-linux-installer.md`).

## Not done here

- **Run on Windows.** Wine is not Windows: no visual style (the pages are
  drawn classic, and the same for both versions), no PowerShell (so the
  password store and `stop-gobbonet.bat`'s PowerShell half did not run; the
  installer carried on as it should), no SmartScreen or Defender. Like every
  release before it, the installer is not code-signed, so SmartScreen will
  ask.
- **Launch GobboNet** on the finish page, and the shortcuts, were not
  started: they run `gobbonet.exe launch`, whose first run downloads the
  engine. Their targets and arguments were read out of the shortcut files.
