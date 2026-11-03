# 1.7.9 — Endorsed mods, installed with one click

*Patch step 14 of 1.7.9, F6: goblincorps.com hosts the list, and Elodine
endorses each mod individually.*

## What was missing

Step 13 made mods real units: a folder, a switch, a place in the load order.
Getting one still meant finding it, downloading its files and putting them in
the right folder by hand. There was no way to tell a mod Elodine had looked at
from any script on the internet, and no way to hear about a new version.

## The change

**ENDORSED MODS**, a section of the MODS panel under YOUR MODS:

- **BROWSE ENDORSED MODS** asks GobboNet for the list at
  `https://goblincorps.com/gobbonet_mod_list.json`. Each mod shows its version,
  author and description, a link to more about it, and one button:
  - **INSTALL** for a mod you do not have;
  - **UPDATE**, with "you have v…", when the list has a different version;
  - **INSTALLED** when you have this one;
  - unavailable, with the reason, when a folder of that name is already in your
    mods folder and did not come from the list, or the mod needs a newer GobboNet.
- **OPEN THE EXTRAS PAGE** goes to goblincorps.com/gobbonet_extras.
- **18+.** A mod marked `adult` is covered, and the list says how many are. "I
  AM 18 OR OLDER, SHOW THEM" uncovers them, remembered in that browser only
  (`localStorage`, `gobbonet.mods.adultOk`); HIDE 18+ MODS covers them again.
- **REFRESH** fetches the list again; otherwise it is kept for ten minutes.

**Install is checked, all or nothing.**
- Every file in the list carries a SHA-256. A list entry without one is left
  out, with a note in the log.
- INSTALL downloads every file into a hidden folder, checks each against its
  pin, and only then puts the mod in place. One mismatch, and the panel says in
  one line which file did not match and that nothing was installed.
- An update sets the old version aside like a Remove (gone at the next start).
  A refused update leaves the installed version exactly as it was.
- **The switch is the user's.** A new install is switched on once. An update
  keeps the switch exactly as it was: an endorsed mod you switched off stays off.
- A folder of the same name that you made yourself is never overwritten.
- Installing is for the PC GobboNet runs on, like everything else that can
  make code run (`fromThisPC`). Another device can browse the list.

**A broken mod switches itself off.** This covers every mod, not just endorsed
ones.
- If a mod's own file cannot be loaded, or its script throws while it first
  runs, the mod's files are taken off the page and it is switched off on the
  server (switching off is allowed from any device).
- A notice in the corner says which mod and why, with OPEN MODS, SWITCH BACK ON
  (on the PC) and DISMISS.
- An error later, from something the script set up, does not switch it off.
- A URL entry that cannot be fetched is logged and left on: that is usually the
  network, not the mod.

**`?nomods`.** Adding `?nomods` to the address loads no mods on that page load,
so a mod that breaks the page can still be switched off from MODS.

**Privacy.** Nothing is fetched until BROWSE is clicked, and then by GobboNet
on the PC, not the browser: a plain GET with nothing identifying. A mod's files
are fetched only on INSTALL. The last good list is kept in the data folder and
shown, with its date, when the site cannot be reached. `mod_list_url` in
config.toml points it at another list; empty switches it off.

## For the site

- `docs/ENDORSED-MODS.md`: the format, and how to publish it.
- `catalog/gen-mod-list.py` builds the list from a folder of mod folders and
  pins every file. `--js-as-txt` gives scripts a `.txt` URL for a host that will
  not serve `.js`; GobboNet saves them as `.js`. `--check` fails if a file
  changed after the list was made.
- `docs/mods-example/hello-gobbo` is a small test mod, and
  `gobbonet_mod_list.sample.json` beside it is the list built from it.
- The list format has a `type` field. Only `mod` is installed in 1.7.9; other
  types (characters, prompts) are skipped with a note, so they can go on the
  same list later without breaking 1.7.9.

## Code

- `internal/mods/endorsed.go`: `ParseList`, `FetchList` (live, then the saved
  copy), `Store.Install`, `Store.InstalledFrom`. `Manifest` gains `Source`.
  `PurgeRemoved` also clears an install interrupted by a crash.
- `internal/server/modlist.go`: `GET /mod-list.json[?refresh=1]` and
  `POST /mod-list/install {id}`.
- One `mods.Store` per server (`modStore()`), so its lock covers every request.
  In step 13 each request opened its own.
- `internal/config`: `mod_list_url`, documented in the file template.
- `js/19-extensions.js`: `browseEndorsedMods`, `renderEndorsedList`,
  `installEndorsedMod`, the 18+ cover, `modFailed` and `showModNotice`, and
  `modsSafeMode`.
- `chat.html`: the ENDORSED MODS section. `css/11-panels.css`: its rows, the
  18+ cover, badges and `#mod-notice`.

## Tests

- `internal/mods/endorsed_test.go`, 8 tests:
  - the parser keeps good entries and says why it left each other one out
    (no pin, plain http, a path out of the folder, an .exe, a duplicate, a
    non-mod type), and refuses a list in a newer format or for a newer GobboNet;
  - install checks every file, saves a `.txt` as `.js`, and switches on once;
  - an update keeps the off switch;
  - one bad checksum installs nothing, and a refused update leaves the old
    version in place;
  - a hand-made folder is never overwritten;
  - oversize and missing files are refused;
  - the saved copy is used when the site is down, and only for the same URL;
  - an interrupted install is cleaned up;
  - the shipped sample list parses, and its pins match the example files.
- `internal/server/modlist_test.go`, against a TLS test site:
  - list, install, INSTALLED, UPDATE keeping the switch;
  - install from the LAN refused (403);
  - an unpinned entry and a bad id refused;
  - a file tampered with after publishing refused, with nothing installed;
  - a hand-made folder marked and left alone;
  - the list switched off, the saved copy, and never reachable;
  - sign-in required.
- `tests/test-mods.mjs`, now 59 checks (sections E and F are new):
  - nothing fetched until BROWSE, which then becomes REFRESH;
  - each button state;
  - the 18+ cover, remembered;
  - INSTALL, UPDATE keeping the switch, and a refusal;
  - a phone, a list switched off, a saved copy, `file://`;
  - a script that throws, or a file that will not load, switches its mod off,
    with the notice;
  - later errors and URL failures do not;
  - `?nomods`.
- `tests/test-gen-mod-list.py`: pins and fields, `--check` catching a changed
  file, every refusal, and the shipped sample matching its example.
- **In Chromium, against the real server and a local HTTPS site:**
  - BROWSE showed two mods and covered the 18+ one;
  - Hello Gobbo installed, its script ran once and its stylesheet applied;
  - a mod that throws switched itself off with the notice;
  - a new version was offered after REFRESH and its update kept the off switch;
  - a file changed on the site after the list was made was refused, with
    nothing installed;
  - after a reload the off mods did not run;
  - `?nomods` loaded nothing.
- `tests/console/1.7.9-step-14.js`, 14 checks on the PC.
