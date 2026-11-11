# 1.8.0 — Setup asks for a data folder and a models folder

Issue #68 (5Kwords). Roadmap item #8.

## What was happening

The Linux setup (the .deb, the .rpm, the AppImage and the ZIP all run
`installer-linux/gobbonet-setup.py` and `wizard.html`) asked for one "Data and
model folder" and then always stored `model_dir = <that folder>/models`.
Someone who pointed it at the folder their models were already in got an empty
`models` folder inside it, and a model menu with nothing in it. The wizard
never said it had walked past a folder of GGUFs.

After setup, the models folder and the extra folders to look in
(`model_dir`, `model_dirs`, `scan_hf_cache`) could only be changed by editing
`config.toml`.

## The change

**Install location asks for two folders.** "Data folder" (chats and
GobboNet's own files: logs, the optional embeddings model) and "Models folder".
The models folder starts as `<data folder>/models` and follows the data folder
as it is typed, until the models folder itself is typed into; from then on it
is left alone. A models folder chosen on an earlier run is kept.

- **The models folder says what is in it** as it is typed: "3 GGUF models
  found here. They will be in the model menu.", "This folder will be
  created.", or "Use a full path". A new `/api/scan?path=` answers with counts
  only, never file names, and only to the page on 127.0.0.1 (the same Host
  check as every other setup GET). It counts what the model menu would list:
  any-case `.gguf`, the first part of a split model only, no vision projector,
  links whose target is there; at the top of the folder and one folder down,
  skipping hidden folders, capped at 5000 entries and 200 subfolders.
- **A data folder that already holds GGUF models offers a choice**, the
  common case pre-selected: "Use this folder for models (4 found)" or "Keep
  GobboNet's models in a models subfolder".
- **`/api/location` takes `{data, models}`** and stores `model_dir` exactly
  as chosen, with no `/models` added. Both folders are created 0700 if they
  are missing and write-tested (downloads land in the models folder); nothing
  already in them is touched. A folder it cannot write is refused by name. The
  answer carries `models_found` and `models_in_subfolders`. The old `{path}`
  form still means `<path>/models`.
- **Models one folder down** (a collection sorted into folders by maker) are
  not in the model menu, which lists the top of the models folder. Setup adds
  that folder to `model_dirs`, so they are offered under Add a Model > Found
  on this computer and linked in with one click, and the finish step's
  "Download a model, or put your GGUF in ..." guard accepts them. If the user
  then picks another models folder, setup takes back the entry it added;
  `model_dirs` entries the user had are never removed.
- The model step's note ("Existing GGUF models belong in: ...") also says how
  many are already there, so "I already have one" is the obvious button.

**`config set` and `config get` can carry a list item with a space in it.**
List keys were written space-separated, so `model_dirs` with
`/home/me/My Models` became two folders, `My` and `Models`. `config set` now
also takes a JSON array (`config set model_dirs '["/home/me/My Models"]'`),
refusing control characters, which TOML could not read back; words still
work. `config get --json KEY` prints the value as JSON. The setup uses both.

**CONFIG > Model & Performance > Model Folders**, under Add a Model: the
models folder, the extra folders to look in (one per line) and "Also look in
the HuggingFace cache". A new `/model-folders` route reads and writes
`config.toml`.

- **This PC only**, like the Config File editor (`fromThisPC`, and a save
  must be same-origin with an Origin header). These decide where GobboNet
  writes files and which of this PC's folders it reads. Another device is told
  where to change them and is sent no paths.
- **Saved for the next start**, on its own button (SAVE FOR NEXT START),
  never by SAVE: the model menu, the engine and downloads hold the models
  folder from start-up. The box says when a saved change is still waiting for
  a restart, and when `GOBBONET_MODEL_DIR` is set and wins over it.
- Everything is checked before anything is written: a full path (or `~/`), a
  folder and not a file, no control characters, at most 32 extra folders. A
  new models folder is created 0700 and write-tested, as in setup. Extra
  folders need not exist: a drive unplugged today is still worth looking in.

**Uninstall never empties a folder the user chose.** `gobbonet uninstall`
used to `RemoveAll` the models folder when asked to delete models. With setup
able to point `model_dir` at a collection — or a home folder — that would have
deleted everything in it. Now only GobboNet's own models folder
(`models` under the data folder, the config folder or the program folder) is
removed whole. Any other models folder loses only the `.gguf` and `.gguf.part`
files directly in it, and the question says so: "...is a models folder you
chose, and may hold models from other apps. Delete the .gguf files directly in
it? Nothing else in it, and not the folder." The answer still defaults to No.

PURGE ALL is the page's own data and never reaches the server; no server
code deletes a file in the models folder (a test holds both).

Docs: LINUX-START-HERE.md.

Not changed: the Go wizard (`gobbonet setup` on its own,
`internal/setup/wizard.html`) has no location step to mirror. It is reached
on Linux through the setup above, which chooses the folders and then starts
it, and on Windows the installer chooses the folder. It keeps using
`model_dir` as configured. The Windows installer's single folder stays.

## Tests

- `tests/test-setup-folders.py` (new): runs `gobbonet-setup.py` for real,
  beside a freshly built `gobbonet`, against throwaway HOME and XDG folders. The
  scan counts (and refuses another Host); `model_dir` stored exactly as
  chosen; `model_dirs` gained, kept and taken back; the 0700 creates; the write
  test leaves nothing behind; `{path}` compatibility; refusals; a read-only
  folder refused (when not run as root); the finish guard with an empty folder
  and with a collection one folder down. Fails on 1.7.9's setup server.
- `tests/test-linux-installer.py`: the two labelled fields, the found-models
  choice with the use-it option pre-selected, the models folder following the
  data folder until typed into, and `put('model_dir', models)` with no
  `/models` added.
- `tests/test-model-folders-panel.mjs` (new): loading, another device, an
  older server, a page from a file, saving one folder per line, a refused
  save, the markup, and the PURGE ALL guard.
- `internal/server/modelfolders_test.go` (new): GET on this PC; a phone, a
  forwarded request, a cross-site page and a save without Origin refused, with
  no paths sent; a save written to `config.toml` and the folder made 0700, the
  running server unchanged; an unchanged save does not rewrite the file; bad
  folders refused with nothing written; a read-only folder; the environment
  variable note.
- `internal/config/list_set_test.go` (new): a JSON array round-trips with
  spaces, quotes and backslashes; words still split; a broken array is
  refused before writing; `GetJSON`.
- `cmd/gobbonet/uninstall_test.go`: a chosen folder loses only its top-level
  GGUFs (links removed, their targets kept); kept without `--remove-models`;
  a home folder chosen for models keeps everything else; GobboNet's own folder
  still goes whole; `ownModelsFolder`.
- `tests/test-config-sections.mjs`: the new ids and labels, and the box in
  Model & Performance.
- `tests/console/1.8.0-round-3.js`: on the PC, the box shows `config.toml`,
  an unchanged save writes nothing, bad folders are refused and nothing
  changes; on another device, no paths are sent and a save is refused.
- In a browser (Playwright, not committed): the location step against the real
  setup server, the choice, the notes, Enter to save, a reload keeping the
  chosen folder, a relative path refused.

## Fixed later, in the .deb round

The found-models choice also counted the data folder's own `models`
subfolder, so a data folder whose only models were there was offered for
models itself, pre-selected. `CHANGELOG-1.8.0-linux-installer.md` has it and
the fix; `tests/test-wizard-location.mjs` runs the page's code.
