# 1.7.9 — UNDO for deletions

*Patch step 9 of 1.7.9, F8: "UNDO".*

## What was happening

A deleted chat, message, character or folder was gone the moment the button was
pressed. Some deletes asked "are you sure?" first and some did not, and the
ones that asked trained people to click through the question. A slip on the
small × next to a chat in the sidebar cost the whole conversation.

## The change

**Delete now, take it back for 10 seconds.** A delete happens straight away,
and a toast at the bottom of the screen says what went ("Deleted chat
"Tavern night"") with an **UNDO** button and a bar that runs down over 10
seconds. UNDO, or **Ctrl+Z** (Cmd+Z on a Mac), puts the thing back where it
was. Ctrl+Z inside a text box is left alone, so it still undoes typing.

It covers every single-item delete:

| Delete | UNDO puts back |
| --- | --- |
| A chat | the chat, in its place in the list, open again if it was open |
| A message | the message, in its place |
| A folder | the folder, with the chats it held (unless you filed them elsewhere since) |
| A tag on a chat | the tag, in its place |
| A character (editor or list) | the character, in its place; active again if it was |
| A memory file on a character | the file, in the editor if it is still open, otherwise on the saved character |
| A persona (editor or list) | the persona, in its place; active again if it was |
| A macro | the macro (it no longer asks "are you sure") |
| A scheduled message | the schedule |
| A stylesheet or script entry in MODS | the entry, in the unsaved panel |
| A server backup in DATA | the backup (it no longer asks "are you sure") |

**One at a time.** A second delete makes the first one final, and the toast is
for the newest. This keeps the model simple to explain and keeps UNDO from
reaching back through a pile of changes.

**Bulk deletes keep their confirm.** "Clear all extensions" and PURGE ALL still
ask first, because they are not undoable in one step and are never a slip.

## What waits until the window closes

Anything that cannot be taken back waits for the delete to become final:

- **A chat's record in browser storage.** A normal save only writes the chats
  that still exist, so the stored record has to be removed separately. That
  removal now happens when the window closes. A tab that crashes during the
  window simply brings the chat back on the next load.
- **A server backup's DELETE request.** Until the window closes, the backup is
  only hidden from the list. The server is never asked during the window.
- **A character's card-code scratch space.** Dropped on commit, so UNDO brings
  it back with the character. Deleting from the character list never dropped
  it at all before; it does now, on commit.
- **The push to your other devices.** While a delete is waiting, sync is held,
  so another device never sees a delete that was then undone. A push asked for
  in the meantime goes as soon as the window closes or UNDO is pressed.

Leaving the page for good (closing the tab, navigating away) makes a pending
delete final before the last save and push, so a close never leaves your
devices disagreeing. Closing or saving the MODS panel makes a removed entry
final first, because the entry lived only in that panel's draft.

## Privacy and safety

- The toast shows names as text, never as markup: a chat named like an HTML tag
  is displayed, not run.
- Nothing new is stored or sent. UNDO holds the deleted item in memory for 10
  seconds and nowhere else.
- The toast is announced to screen readers (`role="status"`), the button is
  keyboard-reachable, and the countdown bar is hidden for people who ask for
  reduced motion.

## Code

- `js/18-utils.js`, UNDO block: `undoable({ label, undo, commit })`,
  `commitPendingUndo()`, `undoLast()`, `undoHoldsSync()`, the toast, and the
  Ctrl/Cmd+Z handler.
- `js/06-state-sync.js`: `flushStateSync` holds the push while a delete is
  pending; `flushBeforeExit` commits it first when the page is going away.
- Each delete path snapshots what it removes and offers UNDO:
  `js/09-threads.js`, `js/10-chat.js`, `js/12-render.js`, `js/15-cards.js`,
  `js/17-personas.js`, `js/19-extensions.js`, `js/20-macros.js`,
  `js/21-data.js`, `js/22-scheduler.js`.
- `css/13-components.css`: `#undo-toast`.

## Tests

- `tests/test-undo.mjs`, new, 57 checks:
  - the real UNDO block, run with a fake clock: undo restores and saves; the
    window commits by itself at 10 s; a second delete commits the first; the
    first window's timer cannot fire twice; sync is held then released;
    Ctrl+Z is ignored in text fields and on Ctrl+Shift+Z; an UNDO that throws
    still clears;
  - all 13 delete functions offer UNDO and ask no confirm;
  - the IndexedDB removal and the backup DELETE happen only on commit; the
    sync hold and the exit commit are in place; bulk deletes keep their
    confirm.

  It caught the character editor's DELETE, which had been left without UNDO.
- `tests/test-memory-files.mjs` checks that UNDO puts a removed memory file
  back in its place.
- `tests/console/1.7.9-step-9.js`, in the browser, passes 39 of 39 on an empty
  profile and on one with chats, a folder and an open conversation:
  - every delete above, on throwaway items it makes itself;
  - both the UNDO button and Ctrl+Z, and Ctrl+Z in the message box;
  - the 10-second window running out;
  - the chat staying in IndexedDB during the window;
  - a name with markup shown as text;
  - one-at-a-time.

  It removes every probe afterwards and checks your chats, characters, personas,
  macros, schedules and extensions match what they were. On 1.7.8 it fails at
  once: the page has no UNDO.
- Looked at in a headless browser at 1280×900 and 390×844 (phone).

## Revised after review: where UNDO is, and where it asks instead

Elodine's call after step 15:

- **Kept:** messages, chats, characters, personas, memory files, mods and
  extension entries, macros, folders and server backups.
- **PURGE now offers UNDO as well.**
  - All four purges still ask "are you sure" first, because they clear a whole
    kind of data at once. The question now says UNDO follows, not "cannot be
    undone".
  - The wipe itself still happens at once. The stored records are destroyed,
    not hidden, so a purge cannot be left half-done by the page closing during
    the window.
  - UNDO puts the previous state back and saves it in full, which rewrites
    every conversation record. PURGE ALL also puts back what the wipe took
    from browser storage outside the state: the sync marker and the recovery
    copy.
  - Other devices hear of a purge only when it is final.
- **Removing a tag or a scheduled message asks first instead**, with no UNDO.
  In 1.7.8 they were removed with no question at all.

`tests/test-undo.mjs`:
- the two that ask first are checked to ask before deleting anything;
- the four purges are checked to ask, wipe at once, and offer UNDO that
  restores every field;
- the step 9 console block checks "Cancel" and "OK" on a tag and "Cancel" on a
  schedule, and times the 10-second window on a message delete instead of a
  tag.

## Also fixed: chats coming back after closing the page

Found while testing PURGE with UNDO. It is older than 1.7.9: 1.7.8 does it after
a purge too.

**What happened.** Delete or purge several chats, then reload or close the
page in the next few seconds, and on the next load all but one came back from
the server's copy.

**Why.**
- When the page is closing, it sends what changed to the server in the
  background, and deleted chats are told to the server one at a time.
- Each delete waited for the answer to the one before it, but the page is gone
  before any answer comes. Only the first delete ever left.
- A final delete also waited out the usual two-second delay before going to the
  server, which made the window bigger.

**Fixed.**
- When the page is closing, every DELETE now starts at once
  (`pushChangedConversations`, `js/06-state-sync.js`).
- When an UNDO window ends, the change goes to the server straight away
  (`_undoRelease`, `js/18-utils.js`).

**Checked in Chromium against the real server.** After PURGE THREADS, the page
was reloaded at 1, 3, 6, 10.2 and 11 seconds, inside the UNDO window and just
after it. Every time the chats stayed gone. Before the fix, reloading inside the
window brought back 2 of 3 or 4 of 5.

**Tests.** `tests/test-device-sync.mjs` simulates a closing page, where no
answer ever comes back. It checks that all three deletes go out, not just the
first; that check fails on the old code.
