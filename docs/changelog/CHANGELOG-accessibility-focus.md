# Accessibility — keyboard focus you can see

Measured with a headless Chromium walk: press Tab from the top of the page
and compare a screenshot with focus against one without, around the focused
element.

## What was happening

- **Hidden buttons took focus.** Each thread's six buttons (pin, folder, tags,
  export, rename, delete) sit in `.thread-ctrl`, collapsed to zero width until
  hover; the folder buttons and the message actions (copy, edit, reroll, ...)
  are at opacity 0 until hover. Tab still stops on every one of them. In the
  chat view, 86 of the page's 109 Tab stops showed nothing on screen. The
  character cards already had this fixed with `:focus-within` (06-cards.css).
- **Clipped focus.** The thinking fold's summary and code blocks sit inside
  `overflow: hidden` boxes that cut the glow off (Chrome 130+ makes a code
  block that scrolls sideways a Tab stop by itself), and so do the home page's
  scrolling lists around the preset cards. On a range slider the glow sat on a
  4 px track, and a native radio button doesn't draw it at all.
- **Forced colours.** Under Windows high contrast or Firefox's "override the
  colours" setting, the browser drops box-shadows and repaints borders in one
  system colour. Focus is drawn as `box-shadow: var(--glow-cyan)` with
  `outline: none`, so it vanished: with forced colours on, 93 of 109 stops in
  the chat view showed nothing. The range sliders lost their track (it is the
  element's background).

## The change

- `.thread-item`, `.folder-hdr` and `.message` open their hidden buttons when
  one of them has keyboard focus: `:has(:focus-visible)`, so a mouse click
  leaves nothing different behind, and a browser without `:has()` drops the
  rule and behaves as before.
- `css/01-tokens.css`: `.cot-summary`, `.code-block pre` and
  `.landing-preset-card` draw keyboard focus as an inset outline; range,
  radio and checkbox inputs get an outline (with a `.form-group` copy,
  because `.form-group input:focus` in 05-modals.css sets `outline: none` at
  the same weight later on). Keyboard focus only.
- `@media (forced-colors: active)` in `01-tokens.css`: `:focus-visible` gets a
  2 px `Highlight` outline, range inputs get a `CanvasText` edge. Outside that
  mode nothing changes.

## Tests

- Screenshots of the 15 bench states and the 12 1.8 scenes before and after:
  0 pixels different at rest, 27 of 27.
- The Tab walk again, chat view: 86 of 109 stops invisible -> 0 of 122;
  with forced colours 93 of 109 -> 0 of 120 (the walk stops counting at
  120). The home page goes from 92 of 111 to 0, and the group and Files views
  to 0 as well. (More stops after, because chats and folders can be reached
  now; see the next change.) With a panel open, Tab still walks out behind
  it; that is a separate change.
- `tests/test-accessibility.mjs` section B; `tests/*.mjs` all pass.
