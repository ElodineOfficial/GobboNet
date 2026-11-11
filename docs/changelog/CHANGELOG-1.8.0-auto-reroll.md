# 1.8.0 — Auto Reroll

A per-character feature: a reply that uses one of the character's off-limits
words is stopped and written again.

## Why

Banned Phrases (1.7.8, issue #51) pushes words down through `logit_bias`
before they are written. It works on the model's tokens, so a word still gets
through in another form, split into other pieces, under a mild strength, or
as a phrase stopped only at its rarest word. Real classifier-free guidance,
which would do better, is blocked on the pinned engine (roadmap #1). Auto
Reroll reads the reply itself, so it catches what the bias lets through.

## The change

**The card editor's new Auto Reroll box**, below the sampler presets:

- a switch, off by default for every card, old and new;
- **Off-limits words**, one per line;
- **Tries**, 1 to 10, default 3: how many more times a reply may be written;
- **ADD MY BANNED PHRASES**, which adds the Banned Phrases list to this one;
- a line saying what it will do with what is in the editor.

**Banned Phrases points to it.** Under its CHECK readout, a line says logit
bias does not stop every word yet and that Auto Reroll is its best supplement,
with **GO TO AUTO REROLL**; its `?` says the same and mentions ADD MY BANNED
PHRASES. Logit bias itself is unchanged.

**What is checked.** The part of the reply you read, as it streams. The
model's reasoning, whether the server sends it separately or inline in
`<think>` tags, is never checked, and neither is anything before this reply.

**Matching.** Whole words, in any case: `nod` does not catch `nodded`. A `*`
at either end stands for any run of letters, so `chuckl*` catches chuckle,
chuckled and chuckling. A phrase matches across any spaces or line breaks. A
line that starts or ends with punctuation is matched as written, so a line
holding only an em dash catches every em dash. Straight and curly apostrophes
match each other. A word at the very end of the text so far is not counted
until the next character shows where it ends: `smirk` may yet become
`smirks`.

**What happens on a hit.** The reply stops there, through the same path the
Stop button and the smart limit use, so both the detached job and the direct
stream end, and it is generated again from the start, from the same prompt.
The toast says which word it used and which try this is. The last try is
never stopped early: if it still uses a word, it is kept whole. A word only
the end of the reply could settle, or text the thinking parser hands to the
reply only when it finishes, is caught then, and the reply is written again
the same way.

**Shown on the reply.** The header shows ↻ and how many times it was written
again, with the words in its tooltip; ↻ kept, in magenta, when a word stayed.
Each reroll variant keeps its own.

**When it does not reroll:**

- a reply that ran one of the card's tools: a reroll would run the tool again,
  so it is kept and marked;
- Temperature 0: every try would be the same reply, so replies are checked and
  marked, never written again, and the editor says so;
- the Stop button, or the runtime limit: the turn ends there, and no reroll
  starts after it, even one about to;
- a reply that failed;
- a reply that finished while GobboNet's page was closed, which is folded in
  when the page comes back rather than generated again.

It applies to sending, rerolling and scheduled messages, and an auto-continue
chain carries on through it.

**Shared cards** carry the list, the switch and the tries in
`extensions.gobbonet.autoReroll`. An imported list is capped at what the
editor accepts (200 lines of 100 characters) and its tries held to 1 to 10.
Nothing in it runs code.

Docs: README.md's feature list, AGENTS.md, and the About panel's Fine
control line.

## Tests

- `tests/test-auto-reroll.mjs` (new), running the real matcher, stream
  feeder, reroll loop and `stopGeneration` against a scripted model fed the
  same SSE lines llama-server sends: matching (whole words, `*`, phrases,
  apostrophes, punctuation, case, the end-of-stream hold-back); a clean reply
  is one request and unmarked; a hit stops the stream where the word appears,
  the next try starts with a live abort controller, and the reply is the
  second try alone, marked; every try a hit keeps the last whole; a word that
  ends the reply, a word cut between chunks, a phrase word by word; reasoning
  in its own field and inline `<think>` is never checked; Stop pressed, Stop
  pressed between a hit and the next try, Temperature 0, switched off, an
  empty list and a tool call never reroll; nothing of the check is left on
  the message to be saved; the badge with hostile synced values; the editor's
  note and ADD MY BANNED PHRASES; the pointer from Banned Phrases; shared
  cards.
- `tests/test-card-tools.mjs`: sending and rerolling go through Auto Reroll,
  which runs every try through the tool loop. `tests/test-runtime-resources.mjs`:
  the feeder's two new hooks.

The new tests fail on the round-9 tree.
