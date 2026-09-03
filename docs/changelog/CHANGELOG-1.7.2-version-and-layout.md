# v1.7.2 — version bump and a tidier repo root

Housekeeping. No behaviour changes.

---

## Version

`VERSION` was still `1.7` while the tree had moved on. It is now `1.7.2`.

That file is the single source: `build-release.sh`,
`installer/build-installer.sh` and `installer-linux/build-deb.sh` all read it,
stamp `<VERSION>-go-<sha>` into the binary via ldflags, and the result is what
`gobbonet version`, the startup banner and `/health-fileserver` report. Nothing
else hardcodes a version — checked, and there was nothing to find.

`TestVersionFileMatchesUpstreamRelease` compares `VERSION` against the nearest
git tag and skips when there is no tag to compare against, which is the case in
an export. **On a real clone it will fail until `v1.7.2` is tagged** — that is
the test doing its job, not a defect.

---

## Repo root

The folder opened on 57 files, 29 of them markdown. Someone told to run the
launcher had to find `launch.bat` among twenty changelogs.

Nothing was deleted and nothing runtime moved.

| Was | Now |
|---|---|
| 19 × `CHANGELOG-1.7-*.md` | `docs/changelog/` |
| `INDEX.md`, `GO_SERVER.md`, `GO_CONFIG_SPLIT.md`, `GO_MIGRATION_INVENTORY.md`, `RAG_INFO.md`, `PURGE.md` | `docs/` |
| 9 × `test-*.mjs`, `test-launch-gpu-detect.py` | `tests/` |
| `math-preview.html`, `render-preview.html` | `tests/preview/` |
| `patches/` | `docs/patches/` |

**22 files and 8 directories at the root, down from 57 files.** Four markdown
files remain there instead of 29.

### What stayed, and why

Each of these is pointed at by name from somewhere:

| File | Pointed at by |
|---|---|
| `README.md` | `installer-linux/build-deb.sh` installs it as package documentation |
| `LICENSE` | installed as the `.deb` copyright file |
| `TROUBLESHOOTING.md`, `SECURITY.md` | `launch.bat` tells users to read them, so they must be where a user will look |
| `AGENTS.md` | conventionally found at the root |
| `launch.bat`, `setup-lan.bat`, `teardown-lan.bat`, `stop-gobbonet.bat`, `hardware-probe.ps1`, `identify-model.ps1`, `fileserver.ps1` | copied into the installer payload by name |
| `chat.html`, `default-characters.json`, `gobbonet.ico`, `js/`, `css/` | `stage-web.sh` requires them at the root and refuses to stage without them |
| `VERSION`, `stage-web.sh`, `build-release.sh`, `go.mod`, `go.sum`, `.gitignore` | build entry points |

### References updated in the same pass

Moving a file is the easy half. These pointed at the old locations:

- **`build-release.sh`** ships `GO_SERVER.md` as the README inside release
  bundles → now `docs/GO_SERVER.md`.
- **The 9 `.mjs` suites** resolved the frontend from their own directory
  (`new URL('.', import.meta.url)`). From `tests/` that resolves to the wrong
  place, so each now climbs out with `'..'`. They read the real files from
  `js/`, so a silent break here would have meant testing nothing.
- **`test-launch-gpu-detect.py`** read `launch.bat` from the working directory.
  It now resolves from its own path and works from anywhere.
- **The preview pages** load the real `css/` and `js/` rather than copies, so
  they cannot drift from what ships. Their six links became `../../`.
- **`js/18-utils.js`** names `test-math-render.mjs` in a comment explaining why
  an unknown fence language is left untouched; now says `tests/`.

### New

`docs/README.md` and `tests/README.md` index what is in each folder and say how
to run things. The root `README.md` gained a "Where everything lives" section,
since that is where someone will look first.

---

## One judgement call worth reversing if you disagree

`patches/` → `docs/patches/`. It holds `git format-patch` output from earlier
work on the LaTeX renderer. Nothing references it, the code is merged, and the
reasoning is already in the changelog — so it reads as history rather than
something you run, which is why it moved under `docs/`.

It was not cluttering the root the way the loose files were, though, so this is
the one move made on taste rather than necessity. `mv docs/patches patches`
puts it back.

---

## Verification

Moves are cheap to get wrong and quiet about it, so:

- **Both installer payload assemblies dry-run clean.** Every file
  `installer/build-installer.sh` and `installer-linux/build-deb.sh` name is
  still where they expect it.
- **`stage-web.sh` runs and stages a complete web root** — it cross-checks the
  number of `js`/`css` files against what `chat.html` references and refuses on
  a mismatch, so a green run means the frontend is intact.
- **All 9 `.mjs` suites pass from `tests/` and from the repo root**, confirming
  the path fix is working rather than accidentally passing from one directory.
- **`test-launch-gpu-detect.py` passes from both** working directories.
- **16 relative markdown links across every `.md` in the tree resolve.**
- **No stale references**: every moved filename was searched for across `.go`,
  `.sh`, `.nsi`, `.ps1`, `.bat`, `.py`, `.html` and `.js`, and the only hits are
  the updated ones.
- `go build`, `go vet`, all 11 Go packages, the batch linter, and byte-identical
  `installer/models.ini` — all unchanged.
