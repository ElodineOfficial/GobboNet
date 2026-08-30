# v1.7 — items 7 and 8

Round 4. Items 1–6 are in the tree and untouched. Line numbers are against
that tree (`d0fb003` in the local review repo).

| Patch | Item | Files | Net |
|---|---|---|---|
| `0001-…` | 7 — per-card lore compression model | 6 | +150 / −4 |
| `0002-…` | 8 — sticky character card | 1 | +62 / −4 |

---

## First: what I got wrong on item 7, and the correction

I built this as a free-text endpoint URL. That was wrong, and I want to be
precise about how, because the failure wasn't a typo.

The roadmap posed this as an open design question and then answered it
itself: *"pointing at a second endpoint... is more honest. That makes this
partly a config feature — 'compression endpoint URL + model name'."* I
treated that as settled. When I then noticed the field could carry
conversation text off the machine, I treated it as a **disclosure** problem —
amber privacy badge, warning copy, a console line per pass — rather than as
evidence the design was wrong.

That was the actual error. A product whose entire premise is that nothing
leaves the machine doesn't need a better warning label on a hole; it needs no
hole. Building the warning felt like diligence and was really me negotiating
with the requirement. The correct response to "this violates the core
promise" is to delete it, not to annotate it.

Reverted in full: no URL field, no `loreEndpoint`, no off-box detection, and
`updatePrivacyBadge()` is back to its original unconditional form. Verified
by grep — there is no URL anywhere in the lore path.

## Item 7 — per-card lore compression model

A dropdown of the GGUFs in the models folder, read from `models-list.json`,
the same file the header picker uses. Anything the user drops in that folder
appears on the next open. Blank by default, so every existing card keeps
compressing on the chat model exactly as before.

Sits directly beneath the Lore System option in the card editor, as asked.

### Mechanism: borrow the server for a pass, then give it back

I checked whether the project already had a second chat-capable instance, per
your "if it did, cool; if not, don't". It does not:

- **The embed server** (`launch.bat:423-465`) is a second local llama-server
  with a small downloaded model — but it runs `--embeddings --pooling mean`,
  so it cannot do chat completions.
- **`launch.bat:1511-1519`** runs the chat server with `--parallel 1`
  *deliberately*: the comment names "lore summarization + chat completion" as
  the two differently-shaped requests whose slot churn invalidates cached
  prefixes and forces a ~27s re-prefill. That is your serialisation, written
  down, on purpose.

So there is no second instance and this does not add one. llama.cpp holds one
model at a time, which leaves exactly one honest option: borrow the server
for the pass, then hand it back. What makes that viable is the thing you
pointed out — compression already blocks the turn, so nothing else is trying
to use the model while we have it.

The swap protocol already exists for the header dropdown. I factored it out
of `onHeaderModelChange` into `swapToModelFile()` (`js/02-model.js`) rather
than duplicating it, and it holds `_swapInFlight` for the duration so a
user-initiated header swap can't race a compression pass into two
llama-servers fighting for a port.

**The cost is two model loads per pass and it is not hideable**, so the
editor says so in amber rather than burying it. Default avoids it entirely.
This is the power-user path, and the copy is written for someone who already
knows what a GGUF is.

### Failure policy

Ordered by what hurts the user least — this is the part worth reviewing:

| Failure | Behaviour |
|---|---|
| Can't load the chosen model | Compress on the chat model anyway. `js/08-rag.js:750` has **already** marked those messages archived, so bailing would lose them outright. A worse summary is strictly better than amnesia. |
| Compression itself fails | Item 4's handling applies unchanged — gap marker, amber banner. The `finally` block still returns the model. |
| **Can't give the model back** | Loud. Console error, error toast naming both models with no auto-dismiss, and `_loreLastKind='failed'` so item 4's banner fires. Silently leaving the summariser loaded would make every later turn sound wrong with no stated cause. |

A model named on a card but missing from the folder stays in the dropdown
marked `(not in the models folder)` rather than resetting to default —
quietly changing which model summarises someone's story is worse than showing
them a stale name they can fix.

### Verification

`test-lore-model.mjs` drives the real `compressWithCardModel`. **29
assertions.** The happy path is the least interesting part:

| # | Scenario | Result |
|---|---|---|
| 1 | No model chosen | zero swaps, unchanged |
| 2 | Different model chosen | borrow → compress → return; the **summariser** produced the beat |
| 3 | Chosen model already loaded | no pointless swap |
| 4 | Borrow fails | compresses on the chat model, **no gap marker** — messages kept |
| 5 | Compression throws mid-borrow | model still comes back |
| 6 | Give-back fails | toast + banner naming both models and how to fix it |
| 7 | `file://` mode | no swap attempted, compression still runs |
| 8 | Legacy cards | no swap |

Items 4 (35 assertions) and 6 (18) still pass.

---

## Item 8 — sticky character card

### Roadmap correction: not greenfield

The roadmap says *"js/15-cards.js has no dblclick handler and no
backdrop-dismiss logic at all."* It only looked in that file. The dismiss
lived in **`js/22-scheduler.js:216`**:

```js
document.getElementById('char-modal').addEventListener('click', (e) => {
  if (e.target.id === 'char-modal') closeCharacters();
});
```

That is precisely the handler the roadmap's own "Watch for" paragraph warns
must be removed or double-click never arrives — the first click closes it.
Replaced, not added alongside. The other five modals keep single-click
dismiss; only the character modal is sticky.

### Detection: not `matchMedia('(pointer: coarse)')`

The roadmap specifies that query, and its stated goal is "a touchscreen
laptop should behave like touch". Those two things conflict.
`(pointer: coarse)` reports the **primary** pointer, so a touchscreen laptop
with a trackpad reports `fine` and would get mouse behaviour for finger taps
— the exact device the requirement calls out. `(any-pointer: coarse)` has the
mirror fault: true for a laptop with a touchscreen nobody uses, which would
then refuse to close by mouse.

Neither query can be right, because the question isn't about the device. It's
about the interaction. `pointerdown` carries the `pointerType` of the actual
touch or click, so a finger and a mouse **on the same machine** each get the
right behaviour with no guessing. The media query survives only as a backstop
for a device with no fine pointer at all, in case a `dblclick` somehow
arrives from a double-tap.

### One addition beyond the spec

`closeCharacters()` saves nothing, and `openCharacters()` (`js/15-cards.js:78-84`)
rebuilds the list view — so closing mid-edit **silently discards a
half-written character**. That is what "sticky" is protecting against.

Escape was still a one-key path to the same loss, and it's easy to hit by
accident in a long textarea (dismissing an autocomplete, leaving a find bar).
Escape now skips the character modal *only while an editor is open*; the list
view still closes on Escape, and the other five modals are untouched.

Two lines plus a helper. Drop that hunk if you'd rather Escape stayed uniform.

### Verification

`test-char-modal.mjs` executes the real handlers in a minimal fake DOM.
**14 assertions**, all passing:

| Device | Interaction | Result |
|---|---|---|
| Desktop mouse | single click backdrop | does nothing |
| Desktop mouse | double click backdrop | closes |
| Desktop mouse | double click *inside* | does nothing (word selection) |
| Phone / tablet | tap backdrop | does nothing |
| Phone / tablet | double-tap backdrop | does nothing |
| **Touchscreen laptop** | double-**tap** (finger) | does nothing |
| **Touchscreen laptop** | double-**click** (mouse) | closes |
| **Touchscreen laptop** | mouse then finger, one session | closes, then doesn't |
| Escape, list view | — | closes (and all other modals) |
| Escape, editing | — | character modal survives; others still close |

---

## What still needs a human at a real machine

**Item 7** wants one real compression pass with a second model selected. The
harness proves the borrow/return sequence and every failure branch, but not
that `/swap-model` behaves well when called twice in quick succession from
inside a blocked turn. Specifically worth watching:

1. Pick a small GGUF as the compression model on a card, chat until
   compression fires, and confirm the header dropdown ends up showing your
   **chat** model again, not the summariser.
2. Confirm the lore chip / banner shows a real beat, not a gap marker.
3. Kill the file server mid-pass to exercise the give-back failure, and check
   the toast actually names both models.

The 180s swap poll plus the 45s compression timeout means a worst case around
six minutes of blocked turn on a large chat model. That is inherent to
one-model-at-a-time, and the editor warns about it, but it is worth feeling
once before deciding it's acceptable.

**Item 8** needs a real phone for the close button, per the roadmap's own
risk note, and ideally a touchscreen laptop for the mixed-pointer case. There
is always an exit — the editor keeps its own Cancel button and
`char-close-row` is shown in list view — but that is worth confirming with a
thumb rather than a test.

## Still not done: the `::`-in-a-block fix

Unchanged from the last round. 53 sites, and the best spam candidate
(`launch.bat:2401`, in `:http_alive`, called from the health-monitor loop)
contains `>=` in its comment text, so a mechanical `::`→`rem` conversion would
create a redirection to a file named `=`. Wants its own item and one run on
real Windows.
