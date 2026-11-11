# 1.8.0 — The documented build commands work without the executable bit

Roadmap item #2. Follows `CHANGELOG-1.7.7-build-scripts.md`.

## What was happening

1.7.7 made every build script run the others through `bash`/`python3`, so the
build no longer depends on the executable bit. It left the documented commands
alone (`./scripts/make-zip.sh` in AGENTS.md, BUILDING.md and the installer
READMEs), on the grounds that setting the bit would make them work as written,
and asked for a one-time `git update-index --chmod=+x`.

That command was evidently never run. In 1.7.9 the only executable files are
the three that had the bit before 1.7.7 (both `gobbonet-launch` copies and
`catalog/gen-catalog.py`). Every `.sh` is `100644`, so in a fresh clone the
first command the docs give stops with `Permission denied`.

Found along the way: `build-deb.sh` said "run ./make-icon.sh" when the icon is
missing. There is no make-icon.sh anywhere in the tree; the icon is committed.

## The change

- **Every command a person is told to type runs the script through its
  interpreter**: `bash ./scripts/make-zip.sh`, `cd installer-linux && bash
  ./build-deb.sh`, `SKIP_ENGINE_FETCH=1 bash ./build-rpm.sh`, `python3
  ./make-test-model.py`, `bash ../scripts/build-release.sh`. That covers the
  docs (AGENTS.md, CONTRIBUTING.md, docs/BUILDING.md, docs/GO_SERVER.md,
  tests/README.md, the three installer READMEs), the usage comments at the top
  of each script, and the messages scripts print ("Run bash ./build-deb.sh
  first"). It works whatever the file mode is. That is all 62 lines the new
  check finds in 1.7.9, across 17 files.
- **Prose that only names a script** drops the `./` and names it from the repo
  root (`scripts/build-release.sh`), so it is not mistaken for a command.
- **The bit is set again** on the sixteen scripts people run: the five in
  `scripts/`, `build-deb.sh`, `build-appimage.sh`, `package-permissions.sh`,
  `build-rpm.sh`, `check-rpm.sh`, `test-in-fedora.sh`, `stage-payload.sh`, and
  `catalog/gen-mod-list.py`, `gen-remote-catalog.py`, `pin-hashes.py` and
  `installer-fedora/make-test-model.py`. It is in the zip, so it survives
  `unzip` on Linux; extracting on Windows drops it. The docs no longer depend
  on it, so that is fine either way.
- **`build-deb.sh`'s missing-icon message** says the icon is part of the
  repository and how to restore it.
- `gobbonet-setup.py` stays `0644`, as 1.7.7 decided: it is run through
  `python3` and packaged `0644` on purpose.

To keep the bit in the repository, run once in a checkout (Git for Windows
keeps a mode recorded in the index across later commits):

```sh
git update-index --chmod=+x scripts/build-release.sh scripts/go-floor.sh scripts/make-zip.sh scripts/stage-web.sh scripts/verify-payload.sh installer-linux/build-deb.sh installer-linux/build-appimage.sh installer-linux/package-permissions.sh installer-fedora/build-rpm.sh installer-fedora/check-rpm.sh installer-fedora/test-in-fedora.sh installer-win/stage-payload.sh catalog/gen-mod-list.py catalog/gen-remote-catalog.py catalog/pin-hashes.py installer-fedora/make-test-model.py
```

## Tests

`tests/test-build-scripts.py`, two new tests (five in the file):

- **No doc tells people to run a script by its executable bit.** It scans every
  `.md`, `.txt` and `.sh` outside `docs/changelog/`, `docs/archive/` and the
  test files (`tests/README.md` is checked), and flags a `./x.sh`, `../x.sh` or
  `./x.py` unless the word before it is `bash` or `python3`. Changelogs and
  archived notes keep the commands of their day.
- **The check catches what it exists to catch**: ten lines from the 1.7.9 tree
  must be flagged, and eleven forms must not (the `bash` forms, prose without
  `./`, `./gobbonet`).

On the 1.7.9 tree the new check reports 62 lines in 17 files. `tests/test-linux-installer.py`
now expects `cd installer-linux && bash ./build-deb.sh` in BUILDING.md.

`bash -n` passes for every script, as before. `bash ./scripts/make-zip.sh
--no-engine` built the update archive with the bit both set and cleared.
