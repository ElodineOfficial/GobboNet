# 1.7.4 — Sticky character editor: optional, and no longer silent

Roadmap item 2, filed as *"Better sticky cards [allow swap on confirmation or
notice?], optional sticky"*. The bracket with the question mark is the right
instinct, and the answer turns out to be **both** — they apply to different
situations, and separating them is what makes the feature work.

## What sticky was

v1.7 item 8 made the CAST modal refuse to close on a single backdrop click,
and refuse Escape while an editor was open. The reason is sound and unchanged:
`closeCharacters()` saves nothing and `openCharacters()` rebuilds the list
view, so a half-written character is simply gone.

It was doing that job with one rule, and the one rule was wrong in three
places.

**It refused everything, whether or not anything was at stake.** Opening a card
to read it and clicking away was blocked exactly as hard as clicking away from
three paragraphs of unsaved personality. All cost, no benefit.

**It refused silently.** The click did not close the modal and did not say
why. A no-op is indistinguishable from a broken window, and on a phone — where
the close row is hidden while an editor is open, and CANCEL / SAVE are at the
bottom of a very long form — a user could tap the backdrop repeatedly with no
feedback at all. It is also why nobody ever found the double-click: nothing
anywhere mentioned it.

**And it had a hole the UI pointed at.** The backdrop and Escape were both
refused to protect unsaved edits, and then `cancelCardEdit()` discarded them
without asking. `cancelPersonaEdit()` did the same. The protection was
airtight everywhere except the button labelled Cancel, sitting next to SAVE at
the bottom of the form the user was being kept inside.

## Two rules instead of one

**Sticky** decides whether a *casual gesture* may dismiss — a single backdrop
click, or Escape. It is a user setting, because whether a stray click should
cost you the modal is taste.

**The guard** decides whether *any* dismissal may destroy work. It is not a
setting, because silently losing a half-written character is not taste. It
only speaks up when the editor actually has unsaved changes.

Splitting them answers the roadmap's question without having to choose. When
there is nothing to lose there is no confirm and no friction. When there is,
you are asked. And a user who turns sticky off gets a modal that behaves like
every other one without also signing up to lose work.

### The setting

`state.settings.stickyCards`, default `true`, with a CONFIG toggle beside
Reply Delivery — both are "how the UI behaves" rather than "how the model
behaves".

Read as `!== false` in the settings panel and tested as `=== false` in the
dismiss rule, never as a truthy test. A settings blob saved before this option
existed has no key at all; a truthy test would read that as "not sticky" and
switch **every existing install** to click-to-dismiss on upgrade. There is a
test for this specifically, because it is the kind of thing that looks fine in
review and only shows up in someone else's lost work.

### The guard

`charDismissGuard()` sits on every dismissal path: the backdrop, Escape, and
both Cancel buttons. It compares the editor against a fingerprint taken when
the editor opened, and only calls `confirm()` if they differ.

The fingerprint is **generic** — every `input`, `textarea` and `select` inside
the open editor, read by id — rather than a hand-written list of the
thirty-six fields the card editor currently has. A hand-written list goes
stale the next time a field is added, and it goes stale *silently*: the new
field stops counting as unsaved work, which is the one failure this whole
mechanism exists to prevent. Reading the DOM means a field added tomorrow is
protected the day it lands, with no second place to remember.

File inputs are skipped. Their `.value` is a synthetic `C:\fakepath\…` string
that says nothing about the data, and picking a file writes the real value
into the text field beside it — which *is* captured, so counting both would
only double-count.

The snapshot is taken **after** the fields are populated, so "clean" means
"exactly as loaded". A card the user just created and has not typed into is
clean, and backing out of it costs no confirm — which preserves the existing
nicety where an untouched new card is deleted on Cancel.

### The notice

`_charNotice()` says why a dismissal was refused and how to actually leave.
The wording is chosen from the **interaction**, not the device, for exactly the
reason the dismiss rule is: a touchscreen laptop has to tell a finger and a
mouse different things, and only the pointer knows which one just arrived.

| Situation | What it says |
|---|---|
| Mouse, list view | Double-click the backdrop to close. |
| Touch, list view | Tap CLOSE below to leave. |
| Mouse, editing | Still editing — double-click here to leave, or use CANCEL / SAVE. |
| Touch, editing | Still editing — use CANCEL or SAVE below to leave. |

It is `position: fixed`, not absolute. The modal is the scroll container and
the card editor is long, so an absolutely-positioned notice would appear
wherever the user happened not to be looking. Pinned to the viewport it is in
the same place every time, near the thumb on a phone. `pointer-events: none`,
so it is never in the way of the click that follows, and the movement (not the
message) is dropped under `prefers-reduced-motion`.

## Behaviour table

| | Sticky ON (default) | Sticky OFF |
|---|---|---|
| Single backdrop click | refused + notice | closes (guarded) |
| Double-click backdrop, mouse | closes (guarded) | closes on the first click |
| Tap / double-tap backdrop, touch | refused + notice | closes (guarded) |
| Escape, list view | closes | closes |
| Escape, editing | refused + notice | closes (guarded) |
| CLOSE / CANCEL buttons | always available, guarded | same |
| Click inside the modal | never closes | never closes |

## A detail worth knowing about

A real double-click delivers `click`, `click`, `dblclick` — in that order, to
the same element. Adding a `click` handler beside the existing `dblclick` one
means both now fire for the same gesture. With sticky off, the first click
closes the modal and the remaining two events must not run the guard again
over something already closed; with sticky on, the notice from the two clicks
must not be left hanging over a modal that the `dblclick` is about to close.

Both are handled (`dblclick` returns early when sticky is off; the close path
clears the notice first), and both are tested with the full three-event
sequence rather than a lone synthetic `dblclick`.

## What pins it

`tests/test-char-modal.mjs`, **65 assertions**, up from 14.

The original 14 are unchanged and still in section A. That matters: with the
editor clean and sticky on, every answer in the v1.7 device/pointer/target
matrix must be exactly what it was, because the guard is invisible when there
is nothing to guard. If any of those moved, this change broke something.

Sections B–F add the notice wording per pointer type, sticky off across mouse
and touch, the absent-key upgrade path, the dirty-state matrix (checkbox,
file input, undone edit, stale snapshot, no snapshot), the guard's
independence from the sticky setting, and static guards on the call sites in
`js/15-cards.js` and `js/17-personas.js`.

Each of the four parts was verified to fail without its fix, by reverting them
one at a time in a scratch tree:

| Reverted | Assertions lost |
|---|---|
| Sticky always on (setting ignored) | 12 |
| Guard always passes | 11 |
| Refusals silent again | 4 |
| Cancel skips the guard | 1 |

The fingerprint was also run against the **real** `chat.html` markup under
jsdom rather than only the fake DOM: all 36 counted fields in the card editor
and all 8 in the persona editor register as unsaved work individually, and
both editors read clean immediately after opening.

That run turned up a real bug the fake DOM could not have: the confirm said
*"discard unsaved changes to this character"* when the thing being discarded
was a persona. The noun now follows the open editor, and both fallbacks are
tested.

## Staging

`js/`, `css/` and `chat.html` all changed, so `linux-amd64/web/` was re-staged
with `stage-web.sh`. Skipping that means the running app serves the old files
and nothing reports a problem.

## Not changed

Version strings still say 1.7.3 — items 8 and 12.

The other five modals keep single-click dismissal and are untouched, as
before. `deleteCard()` and `deletePersona()` still have their own
confirmations and do not go through this guard; they are a different question
("delete this thing") from the one the guard asks ("throw away what you just
typed").
