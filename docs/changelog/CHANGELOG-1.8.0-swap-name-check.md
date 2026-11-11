# 1.8.0 — A model name is a file in the models folder, and nothing else

Roadmap item #4 (found while planning #52). Security.

## What was happening

`POST /swap-model` takes `{"file": "<name>"}` from any signed-in device.
`Supervisor.Swap()` joined that name onto the models folder with
`filepath.Join`, checked that something regular existed there, and started
llama-server on it. Nothing checked the name, so `../elsewhere/x.gguf`, an
absolute path, or any file at all (not only a `.gguf`) was loaded from wherever
it pointed. The refusal also answered with the models folder's full path.

Only signed-in devices could call it, so this was not open to the network. But
#52 (a model per character) will pass names that arrive in imported cards and
synced chats, which is exactly the input this must not trust.

Found while checking the same thing elsewhere: **the model catalogue has the
same gap.** A catalogue entry's `file` becomes the download's name in the
models folder (`modelfetch`, `filepath.Join(dir, entry.File)`), and neither
loader checked it beyond "not empty". The remote list comes over the network
(`model_catalog_url`), so an entry with `file: ../x.gguf` would have written its
download outside the folder. Mod installs already had a path check
(`cleanRel` in `internal/mods`); models did not.

## The change

- **`models.CheckFileName(name)`** (`internal/models/name.go`), the one rule:
  a plain file name ending in `.gguf` (any case), with no `/` or `\` on any
  OS, no `:` (a Windows drive or an NTFS alternate stream), no control
  characters, not `.` or `..`, at most 255 bytes. Every model GobboNet lists
  already passes: `ScanDir` reads the folder one level deep, and USE IT links
  found models in under their own base name.
- **`Supervisor.Swap()`** checks it before touching the disk. A refusal is 400
  with "not a model file name: send just the file's name in the models folder,
  ending in .gguf"; a missing file is "model "x.gguf" not found in the models
  folder". Neither names a path; the server log has the details. Links inside
  the folder still work.
- **Both catalogue loaders** (`catalog.Load` for `models.ini`,
  `catalog.ParseRemote` for the remote list) skip an entry whose file fails the
  check, log it, and keep the rest, as they already do for an entry with no
  repo.
- **`modelfetch.Download.Run()`** checks again before any request, as a
  second lock: whatever builds an entry, nothing is written outside the folder.

Not changed: the model given at startup (`--model`, from `launch.bat` and the
Linux launcher) comes from this PC's own command line.

### Found on the way: `.gitignore` hid the new file

`.gitignore`'s bare `models/` line (meant for model downloads) also matched
`internal/models/`, so `name.go` and its test were ignored. The zip carries them
regardless, but the `git add -A` that follows extracting it over a checkout
would have dropped them, and the commit would not have built. This had happened
before: `fb9d56c Restore missing internal/models source files`.
`!internal/models/` now exempts the Go package; model folders anywhere else are
still ignored, and `*.gguf` everywhere. `tests/test-file-layout.py` now fails
if any source file in a checkout is hidden by `.gitignore`.

## Tests

All new, and each fails on 1.7.9:

- `internal/models/name_test.go`: 6 names that must pass (including a split
  model's first part and `.GGUF`), 20 that must not.
- `internal/supervisor/swap_name_test.go`: ten escaping or non-model names
  are refused with the phase still idle and no path in the error; a missing
  file names no path; `real.gguf`, and a symlink in the folder pointing
  outside it, still get past the checks.
- `internal/server/conformance_test.go`, `TestSwapRefusesNamesOutsideTheModelsFolder`:
  the same through the real `/swap-model` route on a local-mode server: 400,
  phase `error`, no path in the message, `/swap-status` still idle.
- `internal/catalog/file_name_test.go`: seven bad file names dropped from
  `models.ini` and from the remote list, the good entries kept.
- `internal/modelfetch/download_test.go`,
  `TestAFileNameOutsideTheModelsFolderIsNeverWritten`: a verified download
  named `../escaped.gguf` is refused before any request; on 1.7.9 it was
  written to `<root>/escaped.gguf`.

Live check: `tests/console/1.8.0-round-2.js` sends refused names to
`/swap-model` on a running install and checks that nothing changes. Run here
against a local-mode server with a stand-in engine: 12 of 12 on this build, and
a normal swap to another model in the folder still loads. Against the 1.7.9
server on the same setup it reports 11 failures: it answered 202 to
`../zz-outside.gguf` and loaded that file from outside the models folder.

Not run here: a real model swap with an engine (by hand: pick a model in the
model menu; it still loads), and Windows paths on Windows (the checks are the
same code on every OS, and the backslash and colon cases are tested on Linux).
