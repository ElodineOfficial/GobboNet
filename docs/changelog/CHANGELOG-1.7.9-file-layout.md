# 1.7.9 — File layout cleanup

*Patch step 7 of 1.7.9, F9: "File setup cleanup, git is getting messy again."*

## What was happening

The repo root had grown to 47 entries. Mixed in with what users run were:

- build scripts;
- a retired installer design that said "do not ship" on its first line;
- release notes committed as source;
- three files that exist only in git and went stale in 1.7.6:
  - `START-HERE.md`, the 1.7.6 release notes;
  - `SHA256SUMS.txt`, 1.7.6-era checksums;
  - `NO-ENGINE-IN-THIS-ZIP.txt`, which `make-zip.sh` already generates.

`docs/` mixed reference pages with two releases of investigations, roadmaps,
four merged `git format-patch` files and a dump of old test output.

## The change

| Was | Now | Why |
| --- | --- | --- |
| `installer/` (NSIS script, art, a bundled `INetC.dll`, README, build script) | removed | An unreleased design, built by mistake twice. `installer-win/` is the Windows installer. |
| `installer/models.ini`, `installer/gen-catalog.py` | `catalog/` | The catalogue every platform reads, now in a folder named for what it is |
| `stage-web.sh`, `make-zip.sh`, `build-release.sh`, `verify-payload.sh`, `payload.manifest` | `scripts/` | Build tools, not things users run. Each now runs from the repo root whatever directory it is called from. |
| `PATCH-README.txt` | `scripts/PATCH-README.txt` | A release file. `make-zip.sh` puts it at the archive root. |
| `NO-ENGINE-IN-THIS-ZIP.txt`, `START-HERE.md`, `SHA256SUMS.txt` | removed, and in `.gitignore` | Release-only or stale. `PATCH-README.txt` is ignored at the root too, since every extracted zip brings it back. |
| `docs/INVESTIGATION-*.md`, `docs/ROADMAP-*.md`, the two Go migration notes | `docs/archive/` | History, not reference |
| `docs/patches/`, `docs/validation/` | removed | Merged patches and stale test output |

**Kept at the root, on purpose: the Windows runtime.** That means `launch.bat`,
the other `.bat` files, the `.ps1` helpers, `fileserver.ps1`, `chat.html` and
the `gobbonet.exe` location. Windows users update by extracting over their
install. Moved copies would leave the old ones behind at the root, where the
shortcuts and `launch.bat`'s `%~dp0` paths point, and the move could not be
tested from here. The plan called for a `windows/` folder; this is the one
deliberate departure from it.

**The legacy PowerShell server is deprecated.** `launch.bat`'s legacy path and
`fileserver.ps1` both say so when they run, and name 1.8 for its removal. That
path runs only without `gobbonet.exe` or with `GOBBONET_LEGACY_SERVER`.

**Old installs keep finding their catalogue.** `catalog.Discover` looks for
`catalog/models.ini` first and the old `installer/models.ini` last. A zip
extracted over an old folder leaves the old copy behind, and the new one wins.

## Applying it to git

Extracting a zip cannot move or delete files, so the moves and removals come as
a script, `git-apply-1.7.9-layout.sh`, handed over beside the zip:

1. Run it once, from the checkout root, before extracting.
2. Extract the zip over the checkout.
3. Run `git add -A`.

It was run on a fresh clone of the GitHub repository at 1.7.8 (02f6291),
followed by this build's zip. The result matches this tree file for file,
apart from the built binaries.

## Tests

- `tests/test-file-layout.py`, new, pins the layout:
  - nothing retired is back;
  - `catalog/` and `scripts/` exist;
  - each script works from another directory (`stage-web.sh` is run from `/`);
  - the Windows runtime stays at the root;
  - the release-only files are ignored;
  - both deprecation notices are present.
- `internal/catalog`: `TestDiscoverPrefersCatalogOverRetiredInstallerDir`.
- 15 test files updated for the new paths. Tests of the retired `installer/`
  now check that it is gone.
- Every builder run for real from its new place:
  - `scripts/build-release.sh`: 5 platforms;
  - `installer-linux/build-deb.sh`: models.ini from `catalog/`, payload matches
    `scripts/payload.manifest`;
  - `build-appimage.sh`;
  - `installer-fedora/build-rpm.sh`, then `check-rpm.sh`: PASS, "catalogue is
    catalog/models.ini, byte for byte";
  - `installer-win/stage-payload.sh` from the unpacked zip, then `makensis`
    3.09: compiled, 0 warnings;
  - `scripts/make-zip.sh`.
- `docs/BUILDING.md` lost its sections on the retired installer and a stale
  "Go cannot be built here" note. `AGENTS.md`'s file table and
  `docs/README.md` describe the new layout.
