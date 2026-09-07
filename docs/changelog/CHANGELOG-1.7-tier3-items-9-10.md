# v1.7 — items 9 and 10

Round 5. Items 1–8 are in the tree and untouched. Line numbers are against
that tree (`9ea6bf1` in the local review repo).

| Patch | Item | Files | Net |
|---|---|---|---|
| `0001-…` | 9 — reorder cards and personas | 5 + test | +182 / −2 |
| `0002-…` | 10 — per-message character identity | 6 + test | +135 / −20 |

Branched separately off the same baseline, so either can be taken without
the other; the tree ships both applied. Items 4, 6, 7 and 8's harnesses still
pass (29 + 14 shown; the item 4 and 6 suites are inside those two files).

Test totals on the integrated tree: **42 + 52 + 10 new, 29 + 14 carried over
= 147 assertions, 0 failures.**

---

## Item 9 — reorder character cards and personas

### The roadmap's argument for an `order` field is backwards

The roadmap put this in tier 3 as "schema change plus migration", and leaned
toward an explicit `order` field on the grounds that it *"survives
merge-imports cleanly"*. Checked, and it's the reverse.

Import merges by id and **appends** (`js/21-data.js:107`). So exporting cards
ranked 0,1,2 into a profile that already holds cards ranked 0,1,2 produces two
of each rank, and sorting that interleaves the imported roster through your
own — every third character a stranger. Avoiding it means renumbering the
incoming cards to sit after the existing ones, which is exactly what appending
to an array already does, for free. The field buys a backfill, a collision
rule, and a sort on every read path, to arrive at the same list.

**So: array position is the order. No schema change, no migration.** Which
means item 9 isn't a tier 3 item, and the "do 9 and 10 together, same
migration shape" pairing only half holds — item 10 genuinely is a schema
change, this isn't.

Two things confirmed before committing to that:

- **Order already round-trips.** `characterCards` and `personaCards` persist
  whole inside the meta record (`js/05-persistence.js:570`) and ride the same
  blob to `/state`. Threads needed `threadOrder` (`:567`) only because the IDB
  `threads` store is keyed by id and *loses* array order on reload. Cards were
  never moved to a keyed store. If they ever are, the answer is the same six
  lines `threadOrder` uses — noted in the code rather than pre-built.
- **The `[0]` fallback is fine.** Nine sites read it: `getActiveCard`,
  `getActivePersona`, the four delete paths, two import paths. None of them
  means "the built-in default" — they all mean "some card, deterministically".
  Under user ordering they resolve to the user's *top* card, which is a better
  answer than the oldest one. All nine left alone.

### Two places I diverged from the obvious implementation

**The arrows are a column left of the avatar, not two more buttons in
`.card-actions`.** That row is Edit / Copy / Del and already wraps on a narrow
phone — there's a comment block in `css/11-panels.css` that exists *because*
two extra buttons broke it last time. A stacked pair costs ~22px of row width
instead of ~90px, and up/down reads better vertically anyway.

**A move doesn't re-render the grid.** `renderCardGrid()` replaces the button
that was just clicked, and the row under a stationary cursor becomes the row
that got displaced — so clicking ▲ twice without moving the mouse moves a card
up and then straight back down. `moveCastEntry()` slices the array, then moves
the live node to match, and restores focus to the arrow that travelled with
it. The array stays the source of truth: if the DOM has drifted from it for
any reason, it bails to a full render rather than guessing.

Test D is the guard on that — it asserts the in-place move produces identical
row order *and* identical end-cap disabled states to a full re-render, so the
two paths can't silently diverge.

### Free side effect

The landing page character list renders from the same array
(`js/13-dashboard.js:45`), so reordering in CAST reorders it too.

### Left deliberately broken

`.card-actions` is `opacity: 0` until hover and keys off viewport width, not
pointer type — so on a touchscreen laptop Edit / Copy / Del are hover-gated
with no hover to give them. That predates this change and isn't item 9. The
new `.card-move` column is covered for that case (`css/11-panels.css`, inside
the existing `pointer: coarse` block) and the gap is flagged in a comment
rather than widening the diff.

### Verification

`test-cast-order.mjs` — **42 assertions**. The fake DOM's `innerHTML` setter
parses the generated markup back into nodes, so the tests drive the grid by
finding the arrow in the rendered HTML and evaluating its *actual* `onclick`
attribute. A wrong argument order or a broken attribute fails here rather than
in a browser.

| # | Scenario | Result |
|---|---|---|
| A | move up / down | array spliced, DOM follows, saved once |
| B | both ends, unknown id | no-op, and **no state write** |
| C | walking a card to the top | end-caps recomputed each move |
| D | in-place move vs full re-render | byte-identical order and caps |
| E | DOM drifted from state | bails to full render, drift discarded |
| F | focus | stays on the arrow; hands to its partner at an end |
| G | list of one | no column rendered at all |
| H | personas | same engine, and the two grids don't disturb each other |
| I | empty / single persona roster | early return, no arrows |
| J | hostile id and name | attribute not broken out of, still reorders |
| K | assumption guard | import still appends; both arrays still persist whole |

K is a source-level assertion rather than a behavioural one. It's cheap
insurance: the whole design rests on merge-import appending, and if someone
later changes it to interleave, this is where it gets noticed.

---

## Item 10 — the agent icon shows the character that produced the message

Issue #19. The roadmap's diagnosis is correct as written and confirmed at
`js/13-dashboard.js:154`.

### The bug is wider than the icon

The reported symptom is the avatar, but `card` and `persona` were resolved
once for the whole message list and then fed **four** things, not one:

| Fed | Consequence of switching characters |
|---|---|
| `renderAvatar(card.avatar, …)` | the reported bug |
| `roleLabel` | every historical reply is **renamed** |
| `aiTextColor` / `aiDialogColor` | the prose is **recoloured** |
| `translateTemplates(…, cardName, …)` | `{{char}}` is **rewritten** inside dialogue that predates that character |

So an old thread didn't just wear the wrong face — it was renamed, recoloured,
and had its `{{char}}` references retconned. All four resolve per message now.

The same bug exists on the persona side, from the same two lines. It's fixed
too. That half is separable if you'd rather scope this to issue #19 as filed —
it's `personaId`/`personaName`, `personaFor()`, and the two user-turn stamps.

### Resolution order

`makeCastResolver()` (`js/09-threads.js`), built once per render:

1. `m.cardId` — stamped on assistant turns from here on
2. `thread.cardId` — stamped at creation, inherited by forks
3. `thread.cardName` — tombstone; see below
4. `getActiveCard()` — legacy threads, unchanged behaviour

### One addition beyond the spec: the tombstone

With cardId alone, deleting a character re-creates issue #19 for every thread
that used it — the lookup fails and the history falls through to whoever is
active now. Deleting characters isn't rare.

`thread.cardName` is one string per thread, written at creation, read **only**
when the id no longer resolves. A deleted character's threads keep their name
with a neutral avatar instead of being redressed. Card lookup by id still wins
when it succeeds, so renaming a character still propagates through history the
way it does today.

It is not per-message and never will be: an avatar can be a base64 data URL,
and a name per message on a long thread is storage bloat for a corner case.
The corner it doesn't cover: rename a card *and then* delete it, and the
tombstone shows the pre-rename name. Drop this hunk if you'd rather not carry
a denormalised name — it's one line in `createThread` and one branch in the
resolver.

### Migration

Nothing is backfilled, per the roadmap. Which character produced a pre-1.7
message is information the app never recorded, so any value invented now would
be a guess presented as fact — and the most available guess, the active card,
is precisely the wrong answer issue #19 is about. Unstamped threads take rung
4 and render exactly as they do today. The decision is written at the
migration site (`js/05-persistence.js:291`) so nobody adds a well-meaning
backfill later.

No persistence changes were needed: `cleanThread` spreads the thread and only
strips underscore-prefixed runtime fields, so the stamps ride along.

### Stamp sites

`injectGreeting`, `sendMessage` (user + assistant), the regenerate path, the
reroll path (re-stamped — new text, current card), and the scheduler's
injected turn.

**One path is deliberately left unstamped.** `finalizeJobIntoThread` recreates
a reply whose message was deleted mid-flight. Both its callers are the
resume-after-reload sweep, which replays jobs across arbitrary threads, so
`getActiveCard()` there is whatever is selected now — quite possibly for a
different conversation. Blank falls through to `thread.cardId`, which is at
least the right thread. Commented at the site and asserted in the tests.

### Verification

`test-cast-identity.mjs` — **52 assertions**, driving the real resolver,
`createThread` and `forkAt`.

| # | Scenario | Result |
|---|---|---|
| A | issue #19's exact setup | old thread keeps its face, name and colours |
| B | all four fallback rungs | each resolves to the right one |
| C | thread that switched cards mid-conversation | each turn renders as its own author |
| D | personas | same matrix; card and persona resolve independently |
| E | empty persona roster | falls to `DEFAULT_PERSONA` |
| F | `createThread` | stamps all four; later switches don't retroact |
| G | `forkAt` | inherits from the **source**, not the active card |
| H | render path | source guard that it actually calls the resolver |
| I | every send path | source guard on all six stamps + the one omission |
| J | persistence | stamps survive `cleanThread` and a JSON round-trip |

H and I are source-level. The `renderMessages` map callback is ~200 lines
deep in a function needing `parseMarkdown`, `safeCssColor` and a real DOM;
extracting it would have meant testing a copy rather than the shipped code.
Guarding that the shipped code calls the tested resolver — and that the old
list-level variables are *gone* — is the honest version of that test.

---

---

## The two items together

They touch card identity from opposite ends — item 9 makes array position
user-controlled, item 10 resolves identity by id — so
`test-items-9-10-together.mjs` covers the seam neither item's own harness sees.
**10 assertions.** Cherry-picked cleanly onto one branch; the file sets are
disjoint and there were no conflicts.

Reordering the roster does not re-attribute any existing message. Stamped
threads resolve by id and are immune to both reordering and a dangling
`activeCardId`.

**One behaviour change worth knowing about.** Item 9 made
`characterCards[0]` the user's *top* card rather than the oldest one, and item
10's last fallback rung is `getActiveCard()`, which reads `[0]` when
`activeCardId` dangles. So for a legacy thread with no stamps, viewed while the
active card id points at something deleted, reordering the roster changes which
character that thread appears to be. That is the pre-existing `[0]` fallback
behaving as designed — the user's top card is a better answer than the oldest
one — but it is a change, and it's asserted rather than left to be discovered.
Anything stamped (i.e. anything created from 1.7 on) is unaffected.

---

## What still needs a human at a real machine

**Item 9** needs a thumb. The arrows are 26px on `pointer: coarse` and sit
left of a 50px avatar in a 200px-tall scrolling grid; that reads fine in the
box model and I can't feel it. Specifically:

1. Reorder a roster of six on a phone and confirm the row doesn't scroll out
   from under your thumb as it moves.
2. Confirm the arrows are visible at all on a touchscreen laptop at desktop
   width — that path goes through the `pointer: coarse` block in
   `css/11-panels.css`, not the width query.
3. Confirm the grid's `max-height: 200px` scroll doesn't jump when a row moves
   past the visible edge. Nothing scrolls it deliberately; `focus()` is called
   with `preventScroll: true` precisely so the browser doesn't.

**Item 10** wants the roadmap's own verify run against real data:

1. Thread with card A, messages, switch to B, reopen. Avatar **and name and
   colours** must show A.
2. New thread under B shows B.
3. A pre-fix thread still renders without error — this is the one to check
   against a real pre-1.7 backup rather than a synthetic one.
4. Delete a character that has threads, then open one. It should say that
   character's name with a letter avatar, not the active card's.

## Still not done: the `::`-in-a-block fix

Unchanged from the last two rounds. 53 sites, and the best spam candidate
(`launch.bat:2401`, in `:http_alive`, called from the health-monitor loop)
contains `>=` in its comment text, so a mechanical `::`→`rem` conversion would
create a redirection to a file named `=`. Wants its own item and one run on
real Windows.
