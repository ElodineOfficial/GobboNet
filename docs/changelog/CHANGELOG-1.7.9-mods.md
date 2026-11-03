# 1.7.9 — Mods: one switch each, kept on the PC

*Patch step 13 of 1.7.9, F1: "Multi-mod in the backend". GobboNet builds it
itself; no outside mod is needed.*

## What was happening

- **One blob.** The page's custom stylesheets and scripts were a single object,
  `state.extensions`, with one switch for all of it. There was no way to have
  a theme on and a script off, to install something as one unit, or to see
  what was loaded as "a mod".
- **It travelled with the chats.** The blob lived inside the synced chat state,
  which every paired device can overwrite. Restores and imports switched it
  off first (step 5), but code was still something a device could send
  another.

## The change

**Mods are folders on the PC running GobboNet.**

```
<data_dir>/mods/<id>/mod.json      { "name": "Neon theme", "version": "1.0",
                                     "files": ["theme.css", "extra.js"] }
<data_dir>/mods/<id>/theme.css ...
<data_dir>/mods/mods-state.json    the switches and the load order
```

- **Each mod has its own switch.** The switches live apart from the
  manifests, so replacing a mod's files (an update, or saving My extensions)
  never changes whether it is on.
- **Load order.** Mods load top to bottom as the panel lists them, and within a
  mod in the order its `files` list says. Stylesheets are links, scripts run in
  order (`async = false`).
  - Switching one mod off removes its stylesheets at once and touches nothing
    else.
  - A script already loaded is never added again, so switching another mod does
    not run it twice.
  - A script that has already run stops at the next reload, and the panel says
    so.
- **A folder dropped in by hand starts switched off.** A broken one (no
  `mod.json`, bad JSON, a file missing, a path outside the folder, a link) is
  listed with the reason and cannot be switched on.
- **Remove** sets the folder aside and offers UNDO, like every other delete
  since step 9. It is gone for good at the next start.

**Who may do what.**
- **On the PC GobboNet runs on** you can do everything: add or change mod code,
  switch a mod on, reorder, remove, and the old-extensions migration. This is
  the same `fromThisPC` test the config.toml editor uses: a loopback address,
  a loopback host name, no proxy headers.
- **From any other signed-in device** you can read the list and switch a mod
  **off**.
- **The point:** a mod is code that runs in every browser that opens
  GobboNet. Writing it and turning it on are decided at the PC's keyboard, so a
  phone, a paired device or anyone who learned the password from elsewhere
  cannot put code there. Switching off is never the dangerous direction.

**Code no longer travels in `/state`.** `redactedStateMeta()` always sends an
empty `extensions` list, so nothing a device syncs carries code, and a 1.7.8
device reading the state finds nothing to run.

**The MODS panel.**
- **YOUR MODS** comes first: a switch per mod, its version, description and
  author, where it came from (made in this panel, your extensions from before
  1.7.9, endorsed, or added by hand), ↑ ↓ and Remove, and where the mods
  folder is.
- The stylesheet and script editor below it is now the editor of one mod,
  **My extensions**, with its own switch. Power users keep every knob they had.
- On another device the editor is read-only, and the panel says where mods are
  managed.

## Migration: nothing anyone had is lost

On the first boot of 1.7.9, a browser holding the old blob sends it to the
server and it becomes the mod **My extensions**.
- **Its on/off is kept.** That is safe because a blob in a browser's own
  storage was switched on by that browser's user: anything arriving by restore
  or import is switched off first (`neutralizeUntrustedCode`).
- Each stylesheet and script becomes its own file in the mod (`style-1.css`,
  `script-1.js`). URL entries stay URL entries, and names are kept.
- **Then this browser's copy is emptied**, so the code lives only in the mod.
- **Sending the same blob again** (another browser, a second boot) changes
  nothing. A different blob, such as an old backup imported later, lands
  beside it as "My extensions (2)", switched as it arrived: off, for an import.
- **A device that is not the PC** cannot move it; the server says so. That
  device keeps running its old blob exactly as 1.7.8 did, and the panel says to
  open GobboNet on the PC once.
- **A page opened from `file://`** has no server, so it keeps the 1.7.8
  behaviour.

## Code

- New `internal/mods`: `Store` with `List`, `File`, `SetEnabled`, `Move`,
  `Source`, `WriteSource`, `ImportLegacy`, `Remove`, `Restore` and
  `PurgeRemoved`. The purge runs at start-up and forgets switches of mods that
  are gone.
- New `internal/server/mods.go`: the routes, each with who may call it.
  `GET /mods/<id>/files/<path>` serves only files the manifest lists, and only
  regular files inside the folder.
- `js/19-extensions.js`:
  - `applyExtensions()` keeps its name and now applies mods (`applyMods`);
  - the 1.7.8 injector is kept as `injectLegacyExtensions` for the fallback;
  - new `migrateLegacyExtensions`, `loadMods` and the panel's mod list.
- `js/06-state-sync.js`: `redactedStateMeta` sends no code.
- `chat.html`: the YOUR MODS section, the My extensions label and the button ids.
  `css/11-panels.css`: mod rows.

## Tests

- `internal/mods`, 9 tests:
  - two mods in order, starting off;
  - toggling one leaves the other;
  - the switch survives an update of the files;
  - reordering;
  - every kind of broken mod refused;
  - only listed files served (traversal, links, hidden files, the manifest);
  - My extensions round trip, with old files removed on save;
  - the editor cannot overwrite a hand-made mod;
  - the migration, including re-import and a second set;
  - Remove, UNDO, and the start-up purge.
- `internal/server/mods_test.go`:
  - the list, serving, and the content type;
  - on from this PC only, off from the LAN;
  - every write refused from the LAN (403 with the explanation) and allowed
    from the PC;
  - the migration through the route;
  - sign-in required.
- `tests/test-mods.mjs`, 28 checks of the page half:
  - load order, `async = false`;
  - switching one off without re-running the other's scripts;
  - the migration on the PC, on a phone (blob kept and run) and on `file://`;
  - the panel on the PC and on a phone;
  - SAVE to My extensions;
  - Remove and UNDO;
  - `/state` carrying no code.
- **In Chromium against the real server:**
  - a 1.7.8-style blob in saved state, then a reload: it became My extensions,
    switched on; its script ran once from the mod file; this browser's copy was
    emptied; the server's synced state held an empty list;
  - a hand-made folder showed up switched off.
- `tests/console/1.7.9-step-13.js` passes 15 of 15 on the PC. It makes two
  throwaway mods and checks their order, a move, switching one off, Remove and
  UNDO, and the migration, then removes everything it made. On another device
  it checks the server refuses code from there.
