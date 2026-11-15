# 1.8.1 — Version strings and release notes

*The fixes made to the 1.8.0 prerelease ship as 1.8.1. This follows the 1.8.0
bump (`CHANGELOG-1.8.0-version-bump.md`) step for step, and was done with the
Windows installer, which carries the number.*

## Changed

| File | Was | Now |
|---|---|---|
| `VERSION` | `1.8.0` | `1.8.1` |
| `js/01-config.js`, `GOBBONET_UI_VERSION` | `'1.8.0'` | `'1.8.1'` |
| `installer-win/gobbonet.nsi`, `APPVER` | `"1.8.0"` | `"1.8.1"` |
| `installer-win/gobbonet.nsi`, `OutFile` | `GobboNetSetup-1_8_0.exe` | `GobboNetSetup-1_8_1.exe` |
| `installer-win/gobbonet.nsi`, `VIProductVersion` | `"1.8.0.0"` | `"1.8.1.0"` |
| `installer-fedora/FEDORA.md`, the `dnf install` line | `gobbonet-1.8.0-*` | `gobbonet-1.8.1-*` |
| `installer-fedora/gobbonet.spec`, `%changelog` | newest 1.8.0-1 | a 1.8.1-1 entry on top |
| `LINUX-START-HERE.md`, title and both install commands | 1.8.0 | 1.8.1 |
| `docs/BUILDING.md`, the tag example | `v1.8.0` | `v1.8.1` |
| `docs/UPDATES.md` and `scripts/make-update-manifest.sh`, the release examples | `1_8_0`, `v1.8.0` | `1_8_1`, `v1.8.1` |
| `AGENTS.md`, "as of" | 1.8.0 | 1.8.1 |
| `.github/ISSUE_TEMPLATE/bug.yml`, the version placeholder | `1.8.0` | `1.8.1` |
| `default-characters.json`, the Informant's version | 1.8.0 | 1.8.1 |

**Everything else derives from `VERSION`**, as before: the build stamp
`1.8.1-go-<sha>`, the ZIP names (`GobboNet-1_8_1.zip`,
`GobboNet-1_8_1-update.zip`), and the `.deb`, `.rpm` and AppImage names.

**The installer's header art** keeps `v1.8`: it covers the 1.8.x line, so a
patch release does not repaint it.

**The fixes are labelled 1.8.1.** They were written while the release was still
1.8.0, so their changelogs, console checks and the comments that say when
something arrived said 1.8.0. Now:

- `CHANGELOG-1.8.0-{files-button,search-switch,lore-short-entries,openssl3,setup-port,setup-program-files}.md`
  are `CHANGELOG-1.8.1-*.md`, titled 1.8.1;
- `tests/console/1.8.0-{files-button,search-and-lore,setup-port,linux-setup-openssl}.js`
  are `1.8.1-*.js`;
- the "added in" notes those fixes put in the code and docs (the OpenSSL 3
  fallback in the launcher, `engine.sha256`, `build-appimage.sh`, `make-zip.sh`,
  `fetch-openssl3.sh`, the GPU note in Go, `.gitignore`, `BUILDING.md`,
  `TROUBLESHOOTING.md`, `AGENTS.md`; the search switch and short lore entries in
  the page; their tests) say 1.8.1.

Where the text means the release that had the bug ("1.8.0's plain bind", "a
1.8.0 device", "the 1.8.0 AppImage's engine did not load"), it still says 1.8.0,
which is right. So do the notes for everything that arrived in 1.8.0 itself.

**`LINUX-START-HERE.md`** gains a "New in 1.8.1" line after 1.8.0's: the
location screen names this install's program files, setup run again just after
closing does not say the port is in use, and on Fedora 45 and later the AppImage
and the ZIP bring their own OpenSSL 3.

**Release notes:**

- `scripts/PATCH-README.txt` (the ZIP's `PATCH-README.txt`) opens with FIXED IN
  1.8.1: the six fixes (moved from 1.8.0's FIXED list, plus the Files button,
  which was only described under 1.8.0's NEW) and the version. 1.8.0's notes
  follow under GOBBONET 1.8.0, unchanged but for the Informant line, which the
  1.8.1 entry now carries, because 1.8.0 was a prerelease and anyone coming
  from 1.7.9 gets all of it. The update steps name the 1.8.1 files; CHECKING IT
  lists the renamed checks and `1.8.1-version.js`; VALIDATION has the 1.8.1
  Windows installer and says the Linux packages listed are 1.8.0's until
  1.8.1's are built.
- `README.md`: *Recently fixed* gains the Fedora 45 engine, web search on every
  device, and one- or two-word lore entries.
- `installer-win/README.md`: a 1.8.1 section, below.

**The Gobbonet Informant** says 1.8.1 (its desc and first line). Its notes
already carried the Files button and the per-device search switch from those
fixes; it stays within its 1,500-token budget. Anyone who added it before sees
UPDATE on its tile.

## The Windows installer, GobboNetSetup-1_8_1.exe

NSIS 3.12 large strings, the same build as 1.8.0's (`installer-win/README.md`),
staged from the extracted 1.8.1 update ZIP.

- **The toolchain against 1.7.9.** The official `GobboNetSetup-1_7_9.exe` was
  downloaded from the v1.7.9 release and rebuilt from the `v1.7.9` script with
  its own payload (extracted with 7-Zip, file times kept; the art and icon given
  the times recorded in the installer): byte for byte the same file.
- **The installer program:** every section of 1.8.1's stub but the version
  resource is 1.7.9's, so the wizard and its plugins are 1.7.9's very files.
- **The payload** is the ZIP's byte for byte; the file list is 1.7.9's without
  `fileserver.ps1`, plus 1.8.0's six page files.
- **Under Wine 9.0**, page by page beside the official 1.7.9 and 1.8.0: only
  the version marks (header `v1.8`, footer `1.8.1`) and the install's size
  differ. A fresh install; an upgrade over 1.7.9 and one over 1.8.0, each
  keeping a model, the engine and the password, and removing `fileserver.ps1`;
  and an uninstall after an update, which removed the update's leftovers and
  left only the models it was told to keep.
- `tests/console/1.8.1-version.js` against the installed program under Wine.

## The git tag

`TestVersionFileMatchesUpstreamRelease` compares `VERSION` with the nearest
`v*` tag, so in a clone with the release tags it fails until `v1.8.1` is tagged
on the commit released (`docs/BUILDING.md`), as it did for 1.8.0 against
`v1.8`.

## Tests

- `tests/test-version-strings.py`, `tests/test-version-stamp.mjs`,
  `tests/test-linux-start-here.py` and `tests/test-informant.mjs` take the
  version from `VERSION` and hold the installer, the page, the Linux guide and
  the Informant to it.
- `tests/console/1.8.1-version.js`, new: the page, the server and ABOUT say
  1.8.1 and agree; which system, and on Linux whose OpenSSL 3 the engine uses;
  the Informant shipped is 1.8.1's and covers the fixes; then the 1.8.1 fixes a
  page shows (the Files button, web search per device, short lore entries); and
  with `window.GN_UPDATE_CHECK = true`, the update key and CHECK FOR UPDATES.
  `tests/console/1.8.0-version.js` stays, for 1.8.0.
