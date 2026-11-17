# Accessibility — tests

`tests/test-accessibility.mjs` pins the pieces of the keyboard changes so an
edit can't drop one without a test saying so: the row names (chats, folders,
characters, personas) and the home page cards are keyboard buttons, the
Enter/Space handler exists and leaves keys another handler took,
`keepFocusAcross()` wraps the sidebar, character and persona grids,
message and home page repaints, a repaint that changes nothing is skipped
(`sameMarkup()`), the `:has(:focus-visible)` reveals, the inset and slider
outlines, and the forced-colours outline. Static checks on the real
files, in the style of `test-hint-tooltips.mjs`.

20 checks, all pass; `tests/*.mjs` all pass.
