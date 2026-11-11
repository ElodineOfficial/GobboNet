# 1.8.0 — Version strings, release notes and the update key

*Roadmap item #6. It follows the 1.7.9 bump (`CHANGELOG-1.7.9-version-bump.md`)
step for step, and was done with the Windows installer, which carries the
number.*

## Changed

| File | Was | Now |
|---|---|---|
| `VERSION` | `1.7.9` | `1.8.0` |
| `js/01-config.js`, `GOBBONET_UI_VERSION` | `'1.7.9'` | `'1.8.0'` |
| `installer-win/gobbonet.nsi`, `APPVER` | `"1.7.9"` | `"1.8.0"` |
| `installer-win/gobbonet.nsi`, `OutFile` | `GobboNetSetup-1_7_9.exe` | `GobboNetSetup-1_8_0.exe` |
| `installer-win/gobbonet.nsi`, `VIProductVersion` | `"1.7.9.0"` | `"1.8.0.0"` |
| `installer-fedora/FEDORA.md`, the `dnf install` line | `gobbonet-1.7.9-*` | `gobbonet-1.8.0-*` |
| `installer-fedora/gobbonet.spec`, `%changelog` | newest 1.7.9-1 | a 1.8.0-1 entry on top |
| `LINUX-START-HERE.md`, title and both install commands | 1.7.9 | 1.8.0 |
| `docs/BUILDING.md`, the tag example | `v1.7.9` | `v1.8.0` |
| `AGENTS.md`, "as of" | 1.7.9 | 1.8.0 |
| `.github/ISSUE_TEMPLATE/bug.yml`, the version placeholder | `1.7.9` | `1.8.0` |

**Everything else derives from `VERSION`:** the build stamp, `1.8.0-go-<sha>`,
via `make-zip.sh` and `build-release.sh`; the ZIP's name, `GobboNet-1_8_0.zip`
and `GobboNet-1_8_0-update.zip`; `build-deb.sh`, `build-appimage.sh`,
`build-rpm.sh` and the spec's `%{gn_version}`.

**`LINUX-START-HERE.md`** besides the number: its "New in" lines are in
release order again (the setup-folders round had put 1.8.0's above 1.7.9's),
and 1.8.0's names the embedding server, the GPU menu and PRIME offload,
`gobbonet doctor`'s engine note and `open_browser`. Two sentences that 1.8.0
made untrue are corrected: the AppImage "never checks for updates" (it looks
when CHECK FOR UPDATES is pressed, and the button can replace it), and
Updating now says the button does it for the ZIP and the AppImage, while a
`.deb` or `.rpm` is updated with the new package.

**Release notes:**

- `scripts/PATCH-README.txt`, which ships in the ZIP as `PATCH-README.txt`, is
  the 1.8.0 release notes: new, fixed and changed; how to update on Windows
  (the installer, or the ZIP, which leaves `fileserver.ps1` for you to delete)
  and on Linux; the one `git rm` a 1.7.9 checkout needs; the console checks;
  and what was validated, filled in as each installer is built.
- `README.md`:
  - *Recently fixed* gains the model-load reason (#67), setup's empty models
    folder (#68) and the unused NVIDIA card (#72);
  - *Upcoming changes* marks the Files panel, Auto Reroll and group chats as
    shipped;
  - the feature list gains tools from a character's code, MCP servers, model
    links, the GPU menu, the load-failure reason and CHECK FILE, starting
    without a new tab, and an Updates section;
  - "Did you install with GobboNetSetup.exe?" says CHECK FOR UPDATES works
    there too.
- The Fedora spec's entry and the README are careful about MCP: this release
  sets servers up and checks their tools (round 9); characters calling them
  in a chat is the next MCP step, and nothing here says otherwise.

**The Gobbonet Informant** (`default-characters.json`) is rewritten for 1.8.0:
the version, and notes for the Files panel, group chats' bar, Auto Reroll,
Model for this character and Model Switching, card tools, the GPU menu, a
failed load and CHECK FILE, When GobboNet Starts, MCP Servers, the switch on
each entry in My extensions, ABOUT's update button, and update checks under
PRIVACY. To fit its budget (1,500 tokens with its personality, by the app's
own estimate), older notes are said in fewer words; nothing it covered is
dropped, and every on-screen name and CONFIG path it gives is checked against
the page. It is 1,498 tokens and 5,799 characters. Anyone who added it before
sees UPDATE on its tile.

**Credits:** `CONTRIBUTORS.md` already names everyone whose issue, PR or
commit is in 1.8.0; nothing to add.

## The update signing key

The maintainer asked for the key to be made here. `gobbonet update keygen`
made it on 2026-11-10; its public line is the one key in
`internal/update/trusted-keys.txt`, so 1.8.0 builds can install releases signed
with it. The private key was handed to the maintainer as a file and is not in
the repository, the ZIP or the installer (`*.key` is gitignored, and
`make-update-manifest.sh` refuses a key inside the checkout). Before it was
relied on, a throwaway test checked that the private key's public half is the
built-in key, that a file it signs verifies, and that a changed file does not.

Because it was made outside the maintainer's own machine, `docs/UPDATES.md`'s
"Changing the key" is the way to move to one made there, whenever that matters:
add the new line beside this one, ship a release carrying both, sign with the
new key from then on.

## The git tag

`TestVersionFileMatchesUpstreamRelease` compares `VERSION` with the nearest
`v*` tag. A clone with the release tags fetched now fails it, as it is meant
to, until `v1.8.0` is tagged on the commit released (`docs/BUILDING.md`); a
tree with no tags skips it and says so.

## Before release, on a PC that can reach HuggingFace

`python3 catalog/pin-hashes.py --check --require-all`, which re-reads every
catalogue pin (`CHANGELOG-1.8.0-catalog-pins.md`). HuggingFace could not be
reached from where this was done.

## Tests

- `tests/test-version-strings.py` holds the installer literals, `FEDORA.md`,
  the spec's newest changelog entry and the bug form to `VERSION`.
- `tests/test-version-stamp.mjs` holds the page's stamp to `VERSION`.
- `tests/test-linux-start-here.py` holds the Linux guide's title and install
  globs to `VERSION`.
- `tests/test-informant.mjs` now takes the version from `VERSION` (it was a
  literal `1.7.9`, which would have failed every bump after this one), and
  holds the notes to each 1.8.0 feature by its on-screen names, as it does for
  1.7.9's.
- `internal/update`'s `TestTrustedKeysFileParses` reads the new key line.
- `tests/console/1.8.0-version.js`: in the browser, the page, the server and
  ABOUT say 1.8.0 and agree, the shipped Informant is 1.8.0's and whether
  yours is; with `window.GN_UPDATE_CHECK = true` it also asks, as CHECK FOR
  UPDATES does, and checks the signing key is built in. Against this build:
  7 of 7, and the key present.
