# Accessibility — file buttons can be reached from the keyboard

## What was happening

IMPORT CARD (CAST), every "Browse file..." (a character's avatar and
background, a persona's and a group's avatar), the four imports in DATA
(Threads, Characters, Personas, Full Backup) and a mod's file button in MODS
are `<label>`s around an `<input type="file" style="display:none">`. A click
on the label opens the file picker, but neither the label nor the hidden input
can take focus, so Tab went straight past all ten and there was no way to
import a card, a backup or a picture without a mouse.

## The change

- The ten labels (nine in `chat.html`, one in the MODS entry template in
  `js/19-extensions.js`) get `tabindex="0" role="button"`: Tab stops on them,
  a screen reader calls them buttons, and they show the page's usual
  `:focus-visible` glow.
- `js/18-utils.js`, after the panels' watcher: Enter or Space on a
  `label[role="button"]` clicks the label, which opens the picker as a mouse
  click does. A key another handler has already taken (`defaultPrevented`) is
  left alone.
- Nothing visible changes at rest; the hidden inputs and their `onchange`
  handlers are untouched.

## Tests

- A headless script (not in this repo) in Chromium, Firefox and WebKit opens
  CAST and DATA from the keyboard, Tabs to IMPORT CARD and to DATA's first
  import, and presses Enter on one and Space on the other: each opens the file
  picker once (caught before it shows). On main Tab never reaches either.
- `tests/test-accessibility-dialogs.mjs`, section C: every label around a file
  input in `chat.html` and `js/19-extensions.js` can take focus as a button,
  and the key handler is in place.
- `tests/*.mjs` all pass.
