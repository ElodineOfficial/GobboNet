# 1.7.4 — Auto-scroll is a choice now, and stops dumping you at the top

Roadmap item 5: *"Make smart scrolling optional"*.

## Why three settings and not a checkbox

"Smart" is a guess about intent, and a guess can be wrong in two opposite
directions.

It can **hold on too long** — a reply drags the viewport around while you're
trying to read something further up.

It can also **let go too easily**. The mobile unfollow fires on *any* touch on
the message area during generation. That was deliberate, and it fixed a real
problem: the per-chunk scroll used to slam the viewport back down faster than a
thumb could drag the 32px clear, so stopping the scroll on a phone was a fight
you usually lost. The cost is that a tap to dismiss the keyboard, or to select
some text, also stops a follow you wanted.

A checkbox only addresses one of those. So: one setting, three values, under
**CONFIG → Reply Delivery**.

| | |
|---|---|
| **Follow, but let go** | *Default.* Exactly what the app has always done. |
| **Always follow** | Stays glued to the newest text. Scrolling up or touching doesn't stop it. |
| **Don't follow** | The view never moves on its own. The jump-to-latest button is the way down. |

Everything user-**initiated** still scrolls in every mode. Sending a message and
not being shown it isn't a scrolling preference, it's a broken app. Same for
switching threads, rerolling, and tapping the jump button.

`autoScrollMode()` is the only place the setting is read. An absent value (an
install that predates the option) and a nonsense one both resolve to `smart` —
doing that in one place is the difference between one rule and four chances to
get it wrong.

## The bug this turned up

`renderMessages()` rebuilds the thread with `innerHTML`, which resets
`scrollTop` to 0. `settleScrollAfterGeneration` already knew that and handled
the following case: capture the follow state *before* the rebuild, then force a
scroll to the bottom afterwards so the transient pin-flip can't cancel it.

For the **not-following** case it did nothing at all — and the comment said it
was leaving the user "where they're reading".

It wasn't. The rebuild had already moved them. `scrollTop` was 0, so anyone who
scrolled up to read history while a reply finished got dumped at the **top of
the thread**. Survivable while it required scrolling up mid-stream. With
"Don't follow" it would have fired on *every single generation*, which is how
it got noticed.

So the settle now restores the position instead of ignoring it:

- `captureScrollAnchor()` is taken before the rebuild and measures **distance
  from the bottom**, not `scrollTop`. Everything that changes in the rebuild
  changes at the *end* of the thread — the markdown is reparsed, code blocks
  and math settle, tool envelopes unwrap — so measuring from the bottom keeps
  the same text under your eye. Measuring from the top would slide it by
  however much the tail grew.
- `restoreScrollAnchor()` puts it back, behind a double `requestAnimationFrame`
  for the same reason `scrollToBottom` uses one: `<details>` blocks, images and
  math don't have their final height until after layout.

One call site had a related problem: it read the follow state *after*
`renderMessages()`, so it was reading the already-clobbered value. It captures
before the rebuild now, like the other two.

## The other thing that would have felt broken

In "Don't follow" the viewport never moves, so **no scroll event ever fires**,
so `scrollPinnedToBottom` stays stuck at whatever it was when the reply started
— usually `true`, because sending a message scrolls you to the bottom.

The jump-to-latest button shows only when `!scrollPinnedToBottom`. Read
literally, that means the button would stay hidden for the entire reply: no
auto-scroll *and* no way down. That isn't "optional", it's broken.

The pin doesn't mean the same thing in every mode, so it isn't consulted the
same way in every mode. In `off`, distance below the fold decides on its own.
In `always` the viewport is glued to the bottom, so there's never anywhere to
jump to and the button stays hidden.

## Changes

- **`js/04-state.js`** — `autoScroll: 'smart'`.
- **`js/14-scroll.js`** — `AUTO_SCROLL_MODES`, `autoScrollMode()`; mode-aware
  `autoScrollToBottom`, pin tracking, touch unfollow, `updateFollowButton`,
  `settleScrollAfterGeneration`; new `captureScrollAnchor` /
  `restoreScrollAnchor`.
- **`js/10-chat.js`** — all three settle sites capture the anchor before the
  rebuild.
- **`chat.html`**, **`css/13-components.css`**, **`js/15-cards.js`** — the
  picker, styled like the device-sync rows from item 4, and its wiring.

`always` uses a forced `scrollToBottom()` with no `respectPin`. Re-checking the
pin two frames later is exactly the letting-go that mode exists to prevent.
Saving `always` also re-pins immediately, so the change takes effect on the
next chunk rather than waiting for a scroll event that never comes if the user
is sitting still.

## What pins it

`tests/test-scroll-modes.mjs`, **68 assertions**, driving the real functions
against a fake scroll container whose `scrollTop` clamps the way a real one
does — several assertions are about exactly that clamping, and a fake that
stored whatever it was handed would pass tests a browser would fail.

Five guarantees were verified to fail without their fix:

| Reverted | Assertions lost |
|---|---|
| Default resolves to something other than `smart` | 11 |
| `off` doesn't gate the streaming tick | 2 |
| FAB reads the raw pin in `off` | 1 |
| Settle ignores the anchor (the top-jump bug) | 4 |
| A settle site captures after the rebuild | 1 |

Two failures on the first run were artifacts of the harness, not the code, and
both are worth recording because they describe real behaviour:
`updateFollowButton` treats a thread-id change as freshly-pinned, so its
*first* call in a fresh context always re-pins. In the app that call happens
during render, long before any gesture. The tests prime it on purpose now, and
say why.

## Not changed

Version strings still say 1.7.3 — items 8 and 12.

For anyone who doesn't touch the setting, streaming behaves exactly as it did,
with one exception that is a fix rather than a change: finishing a reply while
scrolled up now leaves you where you were reading instead of at the top of the
thread.
