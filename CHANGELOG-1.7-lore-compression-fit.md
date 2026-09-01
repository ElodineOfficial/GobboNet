# v1.7 — Lore compression: fit the prompt instead of refusing it

*The reported symptom was that compression "doesn't fire, it just says values
dropped and try again when you fill up". It is worse than intermittent. On an
ordinary full 4K context the old code sent **zero** compression requests —
confirmed by running the new suite against the untouched tree, not assumed.*

---

## Why it never fired

`summarizeForLore` budgeted the prompt once, filled it, costed the result, and
then decided whether the leftover covered an output ask. Three faults stacked
up in that one pass, and each of them got worse the longer a session ran.

### 1. The feed budget did not pay for the system prompt

```
feedBudget = ctx - headerTokens - LORE_OUTPUT_FLOOR_TOKENS - LORE_CTX_SAFETY_TOKENS
```

`headerTokens` covered the do-not-repeat header and nothing else. Not `sys`
(~250 tokens), not the closing instruction, not the `+16` that `promptTokens`
added afterwards. The feed was then filled against that over-generous figure
and the tokens were spent anyway.

So a feed that filled its budget left roughly **280 tokens less than the floor
it had been budgeted to leave**, `askTokens` landed just under
`LORE_OUTPUT_FLOOR_TOKENS`, and the pass was refused before a request was
built. Any conversation long enough to fill the feed hit this — which is every
conversation that needs compressing. The bug was invisible in exactly the case
that never needed the feature and certain in the case that did.

### 2. Recorded beats were a fixed cost that was never trimmed

The beat log went into the header whole and grew all session. On a small
server window the do-not-repeat block alone could exceed the context, driving
`feedBudget` negative, and no amount of feed trimming could recover it. The
longer you played, the more certain the refusal.

This is the one that made it feel random. Two users on the same context size
got different behaviour depending on how far into a story they were.

### 3. One oversized message was always included regardless of cost

```js
if (chunks.length && feedTokens + cost > feedBudget) { ... break; }
```

The `chunks.length &&` guard let the first (newest) chunk in unconditionally.
A single long paste therefore refused every pass from that point on, and
nothing in the interface connected the two events.

---

## What replaced it

A ladder that trims until it fits, rather than a check on whether it did.
Rungs, cheapest thing to lose first:

1. **Thin the middle of the beat log.** Keeps the first two beats — the
   premise everything later rests on — and the newest three. Same policy the
   `LORE_MAX_CHARS` cap already uses, and for the same reason: the middle is
   the most safely forgotten.
2. **Drop the oldest feed messages.** Already this file's stated policy; an
   older message that misses the window was almost certainly covered by the
   beat written last pass.
3. **Drop the remaining beats.** Risks a repeated beat, which is recoverable.
   Lost history is not.
4. **Shorten the authored lore, keeping its HEAD.** A premise leads with who
   and where.
5. **Clip the last message, keeping its TAIL.** A message ends on its outcome,
   which is what a beat is about.

The head/tail asymmetry in 4 and 5 is deliberate and is the only part of this
that is not obvious from the code.

**Trimming applies to the PROMPT only.** The stored beat log is untouched by
any of it — there is a test for this, because it is the failure mode that
would be worst and quietest.

### A 400 now re-fits and retries once

`estimateTokens` is words × 1.43 and under-counts CJK, code, URLs and long
identifiers, so a prompt costed as affordable can still overflow the server's
real tokeniser. That is an inaccurate estimate, not a full context, and the
two used to be treated identically — one 400 and the batch went on the floor.

The retry re-fits against 60% of the window and sends again, inside the
timeout budget already being held. Only if that is refused do we accept the
loss.

### `noroom` now means what it says

It fires only when everything shrinkable has been shrunk and the window still
cannot hold the instructions plus a floor-sized reply — a genuinely too-small
context rather than a full one. The message says so and names the fix (raise
the server's context size) instead of implying the user should keep chatting
and hope.

The hard-trim policy behind it is unchanged: archived messages stay archived, a
gap marker goes into the lore, and the turn goes through.

---

## The second half: compression that was skipped entirely

`buildContextMessages` walks back from the tail accumulating
`RECENT_RESERVE_FACTOR` of the budget as untouchable, then archives oldest-first
from what is left. When the reserve covered the *whole* live window,
`firstArchivable` landed on 0, `toArchive` came back empty, and the function did
**nothing** — no archive, no fold, no note.

That happens when fixed overhead is eating the budget rather than the
conversation being long: a big storybook, a long authored lore, a fat writing
style. The hard trim further down then quietly shifted those same messages out
of the payload to make the request fit. The model got a hole it could not see
and would confabulate across, and the user got no record that anything had
gone.

When the live window alone is over `budget` — the physical ceiling, not the
soft trigger — the oldest messages are now folded anyway. They are leaving the
context either way; the only question is whether they leave as a summarised
beat or as silence. Floor of two verbatim messages so the model always has the
exchange it is replying to, and it stops as soon as it is back under the
ceiling rather than clearing the board.

---

## Add a Model: held off, deliberately

The download path is bugged and is being fixed in a separate patch. Until then
it is gated behind one flag:

```js
let MODEL_CATALOG_ENABLED = false;   // js/02-model.js
```

The button stays **visible** and reads `NOT WORKING YET`, disabled, with the
reason underneath and the manual way in — drop the `.gguf` into the models
folder and pick it from the header dropdown. Hiding it would have made a known
fault look like a missing feature.

The hold is checked **before** `IS_SERVED`, so a served user is not told "this
needs a server" for a fault that is ours.

Nothing else was touched. The modal, the catalogue fetch, the progress polling
and the swap are all intact — **the fix patch flips the flag and the feature
comes back whole.** There is a test for that too: the working path is asserted
with the flag lifted, so it cannot rot while it is switched off.

`applyModelCatalogAvailability()` also lost an early `return` that made it
one-way — it could only ever turn the button off, never restore it. That is
what makes lifting the hold safe.

---

## Verify

`node test-lore-compression.mjs` — **44 assertions**, new file. Drives the real
`summarizeForLore` against a stubbed server. Every case is one that previously
came back `noroom`:

- a full 4K context with a 20-message batch,
- a beat log that has grown all session (asserts the opening beats and the
  newest survive, the middle is thinned, and **storage keeps what the prompt
  gave up**),
- one 6000-word pasted message (clipped, not dropped),
- a card with a 3000-word authored lore (head kept),
- a server that 400s anyway (re-fit, retry, smaller, still fits),
- a genuinely 700-token window (still refuses, still writes the gap, still
  names the fix),
- a roomy 32K context (unchanged: full 2048 ask, nothing trimmed),
- `SKIP` still a clean no-op rather than a gap,
- no `/props` (falls back to the card limit and fits *that*).

**The suite was run against the unmodified tree first.** Case 1 fails there
with `sent 0` and `kind: noroom`. A test that passes on the broken code proves
nothing, and this file exists because the original bug hid behind exactly that.

`node test-model-catalog.mjs` — **68 assertions**, up from 53. The 15 new ones
cover both sides of the hold: the button disabled and labelled with the reason
and the workaround, the hold beating `file://` so our fault is not reported as
a server problem, the modal refusing to open, and the working path still
correct with the flag lifted.

Full client suite: **538 passing, 0 failing** across nine files. No Go changed.

One existing assertion was rewritten. It checked that the unavailable note was
*untouched* in served mode (`style.display === undefined`) rather than *not
shown* — testing the implementation instead of the behaviour. It now asserts
the note is not displayed, whichever way that is achieved.

---

## Still open

**`RECENT_RESERVE_FACTOR` and `RESPONSE_RESERVE_FACTOR` can overlap badly on
small contexts.** At 4K, the reserve is ~790 tokens of trailing verbatim talk
and the response reserve another ~720, against a 3686 budget. That is survivable
now that compression actually fires, but the safety net above is doing more work
than it should on small windows. Worth a look when the tuning is next revisited
— it wants its own change, with its own tests.

**A pass that trims still records `ok`.** `_loreLastOutcome` gets the outcome,
and the trim detail goes to `console.warn`, but the lore inspector has no way to
show "this beat was written from a clipped view of the batch". Not wrong, just
less than the inspector could be.
