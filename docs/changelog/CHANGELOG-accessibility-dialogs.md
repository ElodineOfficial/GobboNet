# Accessibility — panels behave as dialogs

## What was happening

CONFIG, CHARS, MODS, DATA, SCHED, ABOUT, ADD A MODEL, SIGNED OUT and LORE
SUMMARY open by adding `open` to their `.modal-backdrop`. Opened from the
keyboard (Enter on the button):

- nothing told a screen reader a panel had opened: no dialog role, no name;
- focus stayed on the button, now behind the panel;
- Tab walked out of the panel into the page underneath, which the panel
  covers: focus was outside the panel on 31 to 38 of 40 presses in Firefox
  and WebKit, and on all 60 in Chromium;
- Esc closed the panel and left focus on the page itself, so the next Tab
  started again from the top;
- ADD A MODEL opens over CONFIG, and Esc there closed CONFIG underneath and
  left the catalogue open on its own.

## The change

One watcher in `js/18-utils.js` ("PANELS ARE DIALOGS", after the hint
tooltips) handles every panel, so no open or close function changed:

- At load, each `.modal` gets `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby` pointing at its `<h2>` (given an id,
  `<backdrop id>-title`, if it has none) and `tabindex="-1"`. `chat.html` is
  untouched.
- A `MutationObserver` on each backdrop's `class` sees `open` come and go.
  On open, focus moves to the panel itself, unless the panel already put it
  inside (the sign-in box focuses its password field). The panel rather than
  its first field: a screen reader says "CONFIG, dialog", the next Tab
  reaches the first control, and a phone doesn't raise its keyboard for
  CONFIG's search box. The panels already glow, so focusing one draws nothing
  new, by mouse or keyboard.
- Focus that's outside the page when a panel opens, in the first-run tour's
  card (the tour opens CONFIG at its "Your phone" stop) or a mod's own panel,
  is left there, and Tab there isn't pulled into the panel. Only focus in the
  page behind (`#app`, or another panel) moves.
- Tab and Shift+Tab wrap inside the panel on top (the open backdrop with the
  highest z-index). Shift+Tab straight after opening, with focus on the panel
  itself, goes to its last control rather than the page behind. WebKit on
  Linux names Shift+Tab's key "Unidentified", so the key's code is checked
  too.
- While a panel is open, what's behind it (`#app`, or CONFIG under ADD A
  MODEL) gets `aria-hidden="true"`, as a browser's own modal dialog hides it.
  `aria-modal` alone didn't do that for NVDA in Edge: it still read the page
  behind, and on a Shift+Tab pressed just after CONFIG opened it moved focus to
  a button there itself. `aria-hidden` rather than `inert`, so code that sends
  focus into the page as a panel closes still can. Only
  what the watcher hid is shown again. One trade: a status line in the page
  (the cast-mismatch strip, when a character is picked in CHARS) isn't read
  out while the panel is open; it's there once the panel closes.
- On close, the page is shown to screen readers again first, then focus
  returns to whatever opened the panel, unless something else has already
  taken it.
- Esc is the page's own handler, unchanged, except in ADD A MODEL: Esc now
  closes just the catalogue (a running download keeps going, as with its
  CLOSE button), focus goes back to BROWSE CATALOGUE, and CONFIG stays open.
  With a "?" tooltip open, the first Esc still closes the tooltip. LORE
  SUMMARY still closes only with its CLOSE button, as its own comment says it
  should.

## Tests

- A headless script (not in this repo) in Chromium, Firefox and WebKit opens
  CONFIG, CHARS, MODS, DATA, SCHED and ABOUT with Enter, checks focus is
  inside, the dialog role and its name, presses Tab 40 to 60 times, then Esc,
  then checks focus is back on the button; and opens ADD A MODEL from CONFIG
  and checks the two Escapes above. Chromium also opens LORE SUMMARY from the
  lore chip and closes it with CLOSE. All pass in each browser; on main none
  do.
- Screenshots: 27 of 27 identical, panels open included; a panel opened with
  the mouse or the keyboard looks as before.
- `tests/test-accessibility-dialogs.mjs` (new): every panel in `chat.html`
  has a heading to be named by, and the watcher's pieces are in place.
- `tests/*.mjs` all pass.
