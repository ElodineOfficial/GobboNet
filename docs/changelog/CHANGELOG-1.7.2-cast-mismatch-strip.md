# v1.7.2 — who is about to answer

*Closes #19.*

---

## What was reported

> When a user switches agents (e.g., from "Assistant" to "CodeGoblin") and
> returns to a previous chat, the displayed agent icon corresponds to the
> currently selected agent, not the one used during the original conversation.

---

## That half was already fixed

`makeCastResolver()` in `js/09-threads.js` resolves the character **per
message**, with a documented fallback: the message's own `cardId`, then the
thread's, then a tombstone name if the card has since been deleted, then the
active card for threads old enough to carry none of the above.

`tests/test-cast-identity.mjs` covers it in 52 assertions, and its first case is
this report verbatim — a thread started under CodeGoblin, viewed while Assistant
is selected — asserting the assistant turn keeps CodeGoblin's name, avatar *and*
dialogue colour.

The fix went wider than the report, too. The same two variables feed the speaker
name, the assistant text and dialogue colours, and `{{char}}` expansion inside
the message body, so the original bug did not merely change the face on old
replies: it renamed the speaker and rewrote dialogue written before that
character existed.

Re-checked here rather than assumed. The surfaces that test does not cover are
clean — the sidebar carries no character identity at all, and the landing roster
renders each card's own avatar. Two message-creation sites that looked unstamped
turned out to be deliberate: one is the resume-after-reload sweep, blank on
purpose because it replays jobs across arbitrary threads and `getActiveCard()`
there is whoever is selected now; the other builds the array sent to the model,
not thread history.

---

## The half that was left

`switchThread()` deliberately does not touch `activeCardId`, and nothing on
screen said so. Opening a CodeGoblin thread while Assistant is selected showed
CodeGoblin on every old reply — correct — and then answered as Assistant, in
Assistant's colours, with the reply itself being the first sign.

The history had been made honest. The next message was still a surprise.

That is not a defect in the fix. Threads that change hands are supported on
purpose, and `test-cast-identity.mjs` has a case for one. It is the same
confusion the report describes, moved from past messages to future ones.

---

## Fix

A strip above the composer, shown only when the character about to reply is not
the one that replied last:

> ● Replying as **Assistant** — this thread was last answered by
> **CodeGoblin**. `[Switch]`

**Measured against the last assistant turn, not `thread.cardId`.** A thread that
genuinely changed hands ten messages ago has been Assistant's for ten messages;
comparing against the thread's original owner would nag about a decision the
user has already made and finished making. What is worth interrupting for is a
reply that is about to differ from the one before it.

**Silent by default**, which is the part that decides whether this is useful or
just another permanent strip competing for attention. Nothing is shown when
there is no thread, when no assistant turn exists yet to differ from, when the
last speaker is the active card, or — importantly — when the last speaker cannot
be identified at all. A legacy thread carries no stamp and its author is
genuinely unknown; guessing would put this strip on every old conversation in
the app.

**Reports, does not act.** The button offers `activateCard()`; it does not fire
on its own. The alternative — having `switchThread()` re-activate the thread's
character — was rejected: it changes global state as a side effect of
navigation, and it would fight anyone deliberately continuing a thread with
someone else.

A deleted character is still named, using the same tombstone the message
bubbles use, but gets no button, since there is nothing to switch to.

---

## Files changed

| File | Change |
|---|---|
| `chat.html` | The `cast-mismatch` slot, above `context-info` |
| `js/13-dashboard.js` | `updateCastMismatch()`; `updateInputState()` hides the strip with the composer |
| `js/12-render.js` | Called from `render()` |
| `css/04-chat.css` | Strip and button styling |
| `css/10-responsive.css` | Tightened for narrow screens |
| `tests/test-cast-mismatch.mjs` | New — 22 assertions |

Cyan rather than the auto-continue bar's magenta, sitting next to it: that bar
means "something is happening on its own", this one means "read this before you
press send".

---

## Verification

22 new assertions covering when it speaks, when it stays quiet, the
last-speaker-not-thread-owner rule in both directions, the deleted-card case, and
escaping — a character name is user-supplied text landing in `innerHTML`.

Both realistic regressions confirmed caught: comparing against `thread.cardId`
instead of the last speaker fails two cases, and dropping `escapeHtml` fails two
more. Restoring passes.

The existing `test-cast-identity.mjs` still passes all 52. All 10 `.mjs` suites,
every `js/*.js` parsing, `stage-web.sh` staging a complete web root, and the Go
suite are green.

What still needs a browser: how the strip actually looks, and that it wraps
sensibly on a phone at 380px. The logic is tested; the appearance is not.
