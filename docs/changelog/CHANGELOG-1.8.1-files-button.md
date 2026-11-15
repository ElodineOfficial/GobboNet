# 1.8.1 — the Files button only when there is something to open

## What was happening

The Files panel's button, 📄 in the top bar, was always there: on the home
screen with no chat open, and in every chat whether or not it had a file. The
count beside it was the only sign of whether pressing it would show anything,
and with no files there was no count, just a button that opened an empty
panel saying "No files in this chat yet".

## The change

The button shows only while the chat on screen has at least one file, or the
panel is open. `_filesShowToggle()` in `js/27-files-panel.js` decides it, from
`_fp.files` (the active chat's list) and `_fp.open`; `filesPanelSync()` calls
it whenever the chat renders, and `toggleFilesPanel()` whenever the panel opens
or closes. `_filesWire()` calls it once at load.

- **Home screen:** no chat, no files, no button (unless the panel is open).
- **A chat with no files:** no button.
- **A chat with files:** the button and its count, as before.
- **Panel open:** the button stays, wherever you go, so the panel can always be
  closed from where it was opened. Closing it in a chat with no files hides it.
- **A reply that writes the chat's first file:** the button appears at the
  next render, with the count, as the count already did. If the panel opens
  by itself for that reply (CONFIG > Files Panel), the button is there with it.
- **Escape** in the panel used to put focus back on the button. When closing
  has just hidden it, focus goes to the message box instead.

`chat.html` starts the button `hidden`, so it does not flash on the home screen
before the first render, and `.files-toggle[hidden] { display: none; }` keeps
it hidden whatever the header's flex layout does.

Words that described the button as always there now say when it appears: the
CONFIG > Files Panel hint (still one sentence), the README, `PATCH-README.txt`,
`AGENTS.md`, and the Gobbonet Informant ("Chats with files show 📄 in the top
bar: it opens the Files panel, with versions."; 1,499 of its 1,500 tokens).
Anyone who added the 1.8.0 Informant is offered UPDATE on the home screen.

## Tests

- `tests/test-files-panel.mjs`, new section "the header button": the real
  module in its fake DOM, through home, a chat without files, a chat with
  files, the panel left open in a chat without files and on the home screen,
  closing it there, Escape's focus, a reply writing the first file, and the
  panel remembered open at load on a wide and a narrow screen. The page
  section checks `chat.html` starts the button hidden and the CSS rule. 15
  new checks; 9 of them fail against 1.8.0 as shipped.
- `tests/console/1.8.1-files-button.js`, a console check: what the page shows
  now, the same cases tried in memory against the page's own code (put back
  afterwards), then HOME and back to the open chat on the real page. Run in
  headless Chrome against a sandboxed server with two chats, one with two
  files and one with none: 13 of 13 from each. Against the 1.8.0 build as
  shipped it reports that the page is older than the fix.
- By hand in headless Chrome, at 1400 and 600 pixels wide: the header in each
  state, and the panel left open while moving to a chat without files and
  closed there.

Not run: Firefox or Safari, and a real model writing a file (the sandbox has
no model; the chats were written into state directly).
