# 1.7.4 — Export one thread, or one character

Roadmap item 9: *"Individual thread and character export"*.

The DATA modal's export buttons were all-or-nothing, which is the wrong shape
for the two things people actually want to move: one conversation, and one
character.

- **Every thread row** gets a ⇩ control beside pin / folder / tag / rename.
- **Every character in the CAST grid** gets a **Save** button beside Edit /
  Copy / Del.

## A thread export carries its cast

This is the part that makes the file useful rather than merely valid.

A thread references its characters by id, and since the cast work each
**message** can carry its own `cardId` / `personaId` — that's what lets a
thread which changed hands halfway through still show the right name and avatar
against each turn. Export the thread alone, import it somewhere else, and every
one of those turns renders as whoever happens to be active there: precisely the
confusion `makeCastResolver()` exists to prevent, reintroduced by the file
format.

So `exportThread` walks `thread.cardId`, `thread.personaId`, **and every
message**, and bundles the characters and personas it finds. Only those — a
character who never appeared in this conversation isn't included, so exporting
one chat doesn't quietly hand over your whole roster.

On import they merge by id like anything else, so a recipient who already owns
that character keeps their own copy, edits and all. Nothing is overwritten.

## Why the envelope is the bulk one

Both exports write the same wrapper the bulk exports write, with one element in
the array:

```json
{ "gobbonet_export": "threads", "version": 1, "exported": …,
  "threads": [ … ], "characterCards": [ … ], "personaCards": [ … ] }
```

That's not laziness. It means the existing **Threads…** and **Characters…**
import buttons read these files with no special case, and import already merges
by id — so a single-item file is just a smaller merge. There's no second import
path to keep in step, and no version negotiation between builds.

The one import change is additive: the threads branch now also merges
`characterCards` / `personaCards` when they're present. Files written by every
build before this one have no such keys and take exactly the path they always
did.

## Two character exports, and both stay

They answer different questions and the tooltips say which is which.

| | |
|---|---|
| **EXPORT V3 / FOR SHARING** (card editor) | *Portable.* A Character Card V3 that every other frontend reads. Lossy by construction — system prompt, scenario and example messages all land in `description`, because that's what the spec has room for. |
| **Save** (CAST grid) | *Lossless.* The card exactly as it is: card code, lore, storybook, sampler overrides. A round trip through it changes nothing. |

## Untrusted code

Bundled cards go through `neutralizeUntrustedCode` on the way in, the same as
the character import and the full restore: the code is kept, the run flag is
cleared, and the status line says so. Without that, wrapping a card inside a
thread export would have been a way around the rule.

## What pins it

`tests/test-single-export.mjs`, **48 assertions**, driving the real
`exportThread`, `exportCharacter` and `importData` with `downloadJSON`
captured.

The fixture is built so the easy implementation fails it: the thread's cast is
**not** the whole roster, and the thread changed hands — the Archivist opened
it, the Courier answered later and appears *only* on a message. An export that
looked at `thread.cardId` alone would miss the Courier entirely, and section A
says so by name.

Section C is the round trip that justifies reusing the bulk envelope: export
from one install, import into another through the real `importData`, then
assert that **every message which names a character can find it**. C2 covers
the recipient who already owns the character with their own edits, and
re-importing the same file twice.

Five guarantees were verified to fail without their fix:

| Reverted | Assertions lost |
|---|---|
| Thread export bundles nothing | 11 |
| Cast ids read from the thread but not its messages | 8 |
| Import ignores the bundled cast | 4 |
| Bundled cards skip neutralisation | 2 |
| Export doesn't stop the row's click | 1 |

Two things worth recording from building it:

- The first version of the test stubbed `neutralizeUntrustedCode` against a
  field called `cardCodeEnabled`. The real field is `customCodeEnabled`, so the
  stub was modelling a rule that doesn't exist and would have passed even if
  nothing were neutralised. It uses the real names now.
- Removing the bundle made the suite *throw* on the first missing key rather
  than report, which hid every later failure. The reads are guarded, so a
  regression now prints the full list of what broke.

## Not changed

Version strings still say 1.7.3 — items 8 and 12, which are next.

The bulk Threads / Characters / Personas / Full Backup exports are untouched,
including the fact that the bulk thread export bundles nothing. There's a test
asserting that, because "single exports bundle their cast" is easy to
generalise into "all exports do", and the bulk file is already a complete
snapshot where a second copy of every card would be noise.
