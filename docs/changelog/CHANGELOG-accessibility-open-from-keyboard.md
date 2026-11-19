# Accessibility — open chats, folders and characters from the keyboard

## What was happening

With the keyboard alone you could pin, rename, export or delete a chat, but
not open one. A thread row is a `<div onclick="switchThread(...)">`, and
divs take no focus, so Tab went from the search box straight to the row's
hidden buttons. The same held for folder headers (open / close), character
and persona cards in CHARS (pick one), and on the home page the character
cards, the group cards (start a group chat) and the preset cards (+ ADD /
UPDATE). A headless audit found 239 such elements across the bench's states
and none of them reachable; with this change, 0.

A second problem sat under the first: the sidebar, the card grids, the
messages and the home page repaint by replacing their HTML, which drops
keyboard focus onto the page. Pinning a chat from the keyboard worked and then
sent focus back to the top, and the home page's 5-second repaint (the one
larckdrakengold found resetting the scroll position) did the same to anyone
on it with the keyboard, every five seconds.

## The change

- A row can't become a `<button>`, because it holds buttons of its own. Its
  name is the way in instead: `.thread-name`, `.folder-name-text` and
  `.card-name` get `role="button" tabindex="0"` (with `aria-current` on the
  open chat, the active character and persona, and `aria-expanded` on a
  folder). The home page cards have no buttons inside, so the whole card is
  the button.
- `js/18-utils.js` (new ACCESSIBILITY section): Enter or Space on a
  `[role="button"][tabindex]` that isn't a real control clicks it, unless
  the element's own key handler already took the key (the lore chip and the
  lore banner have one; without this they opened the inspector twice). The click
  bubbles to the row's own `onclick`, so `switchThread`, `activateCard` and
  the rest are untouched. The sync indicator, which acts on a click, is
  marked the same way.
- `keepFocusAcross(container, paint)` in `js/12-render.js`: notes what had
  focus (its row's `data-thread-id` / `data-folder-id` / `data-card-id`, its
  own id or first two classes, and which of those when several share them, as
  Edit and Copy do, and its position as a fallback), repaints, and focuses the
  new copy. Used by `renderSidebar`, `renderCardGrid`,
  `renderPersonaGrid` (`data-card-id` is new on character and persona rows) and
  `renderMessages()`, for the message rows and the home page; the home page
  keeps its existing rule, only when it was already showing, as the scroll
  fix does. Nothing happens unless focus was inside the container. Putting
  focus back keeps the page's note of whether the last focus came from a click
  (see the focus change), since it isn't a new move. Opening a chat still moves focus to
  the message box, as `switchThread` already did.
- `sameMarkup(container, html)`, beside it: the sidebar and the home page skip
  a repaint whose HTML would build exactly what is already there (compared node
  by node with `isEqualNode`). The home page's 5-second repaint usually changes
  nothing, and putting focus back after every one made NVDA read the focused
  item out again every five seconds.
- In `renderCardGrid` and the persona list the new attributes come before
  `class="card-name"`, because `tests/test-cast-order.mjs` reads names with
  `/card-name">([^<]*)</`.

## Tests

- A headless Chromium script (not in this repo) presses the real keys: open
  a chat, open and close a folder, pin and keep focus, choose a character and
  a persona in CHARS, copy a persona and stay on its Copy button, choose one on
  the home page, stay on a home page card through the 5-second repaint, and sit
  on a chat's name through two repaints that change nothing without a single
  focus event. 9 of 9 pass with this change, 0 of 9 on main. One more passes on both: Enter on the lore chip, which has
  its own key handler, opens the lore inspector once.
- Screenshots before and after: 0 pixels different at rest.
- `tests/test-accessibility.mjs` section A.
- `tests/*.mjs` all pass.
