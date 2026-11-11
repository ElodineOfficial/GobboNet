# 1.8.0 — a switch for each entry in My extensions

From Larck Drakengold's commit 4db2469 ("fixed mod list enable toggles for
1.7.9"), suggested by users. Brought onto 1.8.0 with the fixes below; the
commit's Go, JS and CSS changes are kept as written apart from those.

## What was happening

My extensions, the mod the MODS panel's editor writes, had one switch for the
whole set. Turning off one stylesheet or script that misbehaved meant removing
it, or switching off every other entry with it.

## The change

**Each entry has an Enabled switch** beside its name. It works like the mod
switches above it: it takes effect at once, without SAVE, and leaves the rest
of the draft alone. A phone can switch an entry off; only the PC GobboNet runs
on can switch one on, the same rule as for a mod. An entry not saved yet keeps
its switch in the draft, says so, and SAVE writes it.

- **Server**: `POST /mods/<id>/entry-enable {kind, index, enabled}` for
  editor-made mods (`internal/server/mods.go`). Switches live in
  `mods-state.json` beside the mod switches (`entryEnabled`), keyed by kind and
  the entry's saved number; mod.json records each file's `entryIndex`, so an
  entry's URL and its text switch together. `/mods` reports each file's
  `enabled`; the page does not load a file whose entry is off. Removing a mod
  and purging it drops its entry switches too.
- **Page**: the switch in each entry's head (`js/19-extensions.js`), its style
  (`css/13-components.css`), and the read-only panel on a phone leaves it
  usable (`css/11-panels.css`). On a page with no server (file://), or a device
  still running its old blob, it switches this browser's saved copy.

## Fixed while bringing it over

- **The wrong entry could be switched.** The page addressed an entry by its
  position in the list, the server by the number it was saved under. They
  differ as soon as an entry with only a name (no URL, no text) sits before
  others, because it is saved as nothing: switching the next one answered
  "no such entry", or would have hit its neighbour. `Source` now reports each
  entry's saved `index`, and the page switches by that.
- **An import could lose its switches.** Deciding whether a set of old
  extensions was already imported compared them with their switches cleared
  — in place, on the caller's copy — so a set that then had to be saved as
  "My extensions (2)" was saved with every entry on. It compares copies now,
  and leaves saved numbers out of the comparison too, so a re-import is still
  recognised.
- **On file://, a switch saved the whole draft.** It replaced the saved copy
  with the editor's draft, unsaved edits included. It now changes only the
  saved entry's switch.
- **Another website could switch code on, on an install with no password.**
  Found reviewing the new route, and true of every mods route that can make
  code run (1.7.9 F1): "this PC only" checks where the browser is, and another
  website open in a browser on this PC is on this PC too. With a password its
  request has no session cookie (SameSite=Lax) and stops at the auth gate;
  with none there is no gate. Writing My extensions, switching a mod or an
  entry on, moving, removing, restoring, importing and installing an endorsed
  mod now also require GobboNet's own page (`sameOriginStrict`, as the
  config.toml editor does). Tools with no Origin, such as curl on the PC, still
  work. Switching off is unchanged, since it is never the dangerous direction.

## Tests

- `internal/mods/entries_test.go` (new): every entry starts on; switching one
  entry turns off its URL and its file together and nothing else, not the
  mod's own switch; `Source` reads back each entry's switch and saved number,
  and SAVE writes them; a switch only finds a real editor entry (no such index,
  negative, another kind, a hand-made mod, no such mod); the saved number
  survives an entry that wrote nothing; an import under a new name keeps its
  switches and a re-import with different switches is still recognised;
  purging a mod drops its entry switches.
- `internal/server/mods_entries_test.go` (new): a phone can switch an entry off
  but not on, the PC can; `/mods` and `/source` report switches and numbers;
  404 for a missing entry or kind, 400 for a bad body, 405 for GET. Every
  code-enabling mods route refuses a request from another site (Origin from
  elsewhere, `Sec-Fetch-Site: cross-site`, `Origin: null`) and leaves nothing
  behind; GobboNet's own page and a request with no Origin pass; switching off
  from another site still works.
- `tests/test-mods.mjs`, section G (new): an off entry's file is not loaded; the
  panel shows a switch per entry set from the server; a switch sends the saved
  number, not the position, takes effect at once and saves nothing else; a
  refused switch goes back and says why; a new entry asks nothing of the server
  and SAVE carries its switch; on a phone an off entry cannot be switched on
  and an on one can be switched off; on file:// only the saved entry changes.

The new tests fail on the round-6 tree, and the fixes' tests fail on the
commit as it was.
