# 1.7.4 — The lore summary is editable

Roadmap item 11, *"Fully editable lore [mod is solid, needs to be a feature]"*.
Promoted from the user mod, which was the right shape and works — the EDIT
button, the textarea, `setThreadLore` + `saveState()`. Thanks for handing that
over; it saved the design work.

Two things changed on the way in, and one of them is why this needed to be a
feature rather than the mod with the file moved.

## The race the mod could not have seen

A compression pass reads the current summary, hands it to a model, and
`await`s. On a local model that is seconds, not milliseconds. Then it writes
the result back:

```js
summary = await compressWithCardModel(summary, toArchive, …);
setThreadLore(thread, summary);          // ← whatever the user just typed
```

While lore was read-only that was safe, because nothing else could write. The
moment it is editable, a user can open the inspector and rewrite the summary
*inside that window* — and the pass then replaces their text with something
derived from the version they were replacing. Silently. No error, no marker,
and the pass log would show a `before`/`after` pair that looks perfectly
ordinary.

`mergeLoreAfterPass()` in `js/07-prompt.js` now sits between the pass and the
store. It compares what the pass **started from** against what is **actually
stored now**:

- **They agree** — nothing happened underneath; write normally.
- **They differ, and the pass appended** — beats are appended rather than
  rewritten, so the new material is the tail of the result past its own
  starting point. That tail moves onto the user's text instead. The edit
  survives *and* the beat is kept.
- **They differ, and the pass rewrote** — the `LORE_MAX_CHARS` trim cuts the
  front off, so the result does not always start with what it began with. The
  beat cannot be separated out, so the human's text wins and the beat is
  dropped. That costs one auto-generated sentence; the alternative costs
  someone the paragraph they just wrote. The archived messages are unaffected
  either way — they are marked `archived`, not deleted.

Collisions are recorded on the pass log (`editedDuringPass`, `beatDropped`)
rather than left to be discovered, because a row whose `after` does not follow
from its `before` otherwise reads as the pass misbehaving.

## The panel keeps its evidence

The mod replaced `#lore-inspect-body` wholesale with a textarea. That also
removed the size-across-passes table and the failure notes — which are exactly
what someone needs in front of them while deciding what to correct. "This beat
is wrong" is usually a conclusion drawn *from* the growth curve.

`openLoreInspector` takes a mode now and renders the summary region as either a
`<pre>` or a `<textarea>`, keeping everything below it in both. One renderer,
two modes.

## Real buttons

SAVE and CANCEL are their own controls rather than COPY SUMMARY relabelled.
Borrowing a button means putting it back, which means re-creating its original
handler from memory:

```js
// the mod's restore path
copyButton.onclick = function () { copyLoreSummary(this); };
```

That is a copy of `copyLoreSummary`'s call signature which is correct only
until `copyLoreSummary` changes, and which fails silently when it does. The
feature hides COPY SUMMARY while editing and shows it again afterwards, so
nothing is ever reconstructed.

No `MutationObserver` either. The mod watched `document.body` to find the modal
because a mod cannot edit `chat.html`; the buttons are simply in the markup.

## Two additions

**An unsaved-changes guard**, the same rule the character editor got in item 2:
CANCEL and CLOSE ask before discarding, and only when there is something to
discard. CLOSE is the only other way out of this modal — unlike the character
editor, nothing here dismisses on Escape or a backdrop click — so that is the
whole surface.

**A budget meter.** The editor shows characters against `LORE_MAX_CHARS`
(2400) and flags an over-budget edit, because the next pass trims from the
**front** on a sentence boundary. An oversized edit therefore loses its
opening, not its tail, which is the least obvious possible outcome. Better to
say so before it is saved.

The panel's own description also no longer claims the log is "never rewritten",
because that stopped being true.

## What pins it

`tests/test-lore-editing.mjs`, **61 assertions**.

Section A is the merge, and it covers what a naive implementation gets wrong:
an edit made during a pass surviving *with* the pass's beat, the unsplittable
case keeping the human text, and clearing the summary to empty counting as a
real edit rather than reading as "no change".

Verified to bite: neutralising the dirty check loses 5 assertions, and writing
the summary directly instead of through the merge loses the wiring guard.

One note on the harness. The first slice of the editor source accidentally
swallowed `openLoreInspector` itself, whose function declaration then shadowed
the test's stub — so the panel renderer ran for real against a fake DOM and no
textarea ever existed. The slice stops short of it now, and says why.

## Not changed

`thread.lore` remains the storage, `getThreadLore` / `setThreadLore` remain the
accessors, and the compression pass is otherwise untouched. A card's *authored*
lore (`startingLore`) is a different thing living on the card and edited in the
character editor; this is the generated per-thread summary only.
