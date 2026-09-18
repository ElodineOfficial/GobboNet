# 1.7.4 — ABOUT tells you which build you are on

Roadmap item 8: *"About section needs to stay updated with the current version
string [users need the simplest way to identify WHAT version they're on so that
I can troubleshoot!!!]"*.

## Two problems, and the second is the worse one

**ABOUT contained no version at all.** It described the stack — model, runtime,
frontend, server, storage, licence — and never said which release you were
looking at.

**And the one string in the app that claimed to identify the frontend was
wrong.** `CHAT_HTML_BUILD` in `js/01-config.js` read
`'1.6.0-no-encoded-payload'` through the whole of 1.7.x. It was stale by two
minor releases, it was logged to the console on every page load, and nothing
noticed. That is what a constant which is only correct when someone remembers
eventually does, and it is exactly the failure mode the word *stay* in this
roadmap item is about.

## ABOUT now reports two numbers

Not one, and the difference is the most useful thing in the panel.

| | |
|---|---|
| **Server** | What the binary is. Stamped at link time from the `VERSION` file, read live from `/health-fileserver`. |
| **Page** | Which copy of the frontend **this browser actually executed**. Baked into `js/01-config.js` and travelling with the script itself. |

They answer different questions, and when they disagree the reason is almost
always a cached frontend — at which point the server cheerfully reports the new
release while the user is looking at last week's code. That is
indistinguishable from a real regression unless something says so out loud, so
now something does:

> This page is from 1.7.3 but the server is 1.7.4. Your browser is almost
> certainly holding a cached copy of the frontend — hard-refresh
> (Ctrl+Shift+R, or Cmd+Shift+R) before reporting anything, because a stale
> page behaves exactly like a broken release.

A `dev` server build is not flagged, because an unstamped local build
legitimately differs from everything.

The panel paints from what it already knows *before* it asks the server, so it
is never blank — which matters most for the user whose server is the thing that
is broken. The build block is first in the panel, because it is what the panel
gets opened for.

## The mechanism behind "stays updated"

`tests/test-version-stamp.mjs` asserts `GOBBONET_UI_VERSION` equals the
`VERSION` file, exactly. Bump one without the other and the suite fails.

That is the whole difference between this and what was there before. A note
asking someone to remember is what produced `1.6.0-no-encoded-payload`; a test
is what stops the next one. Item 12 bumps both, and this is what will catch it
if it bumps only one.

## COPY BUILD INFO

*"The simplest way to identify what version they're on"* is one button that
produces something pasteable:

```
GobboNet build info
  page:    1.7.3
  server:  1.7.3-go-abc1234
  mode:    managed
  llama:   reachable
  model:   Qwen2.5 7B Instruct
  storage: idb
  sync:    phone
  opened:  http, over the network
  browser: Mozilla/5.0 …
```

`sync` is in there because item 4 made it vary per device — "my chats are
missing" has a completely different answer depending on whether that device is
on its own profile.

**The address is deliberately not included.** The useful fact is "reached over
the network" rather than "same machine"; the actual LAN address adds nothing to
a bug report and this should not quietly make it easy to paste a home network
address into a public channel.

The clipboard call falls back to `execCommand` when it rejects — reaching this
over plain http from a phone on the LAN is the normal way to use the app, and
`navigator.clipboard` refuses outside a secure context. A copy button that
silently does nothing is worse than no copy button.

## Changes

- **`js/01-config.js`** — `CHAT_HTML_BUILD` → `GOBBONET_UI_VERSION`, correct,
  and with a comment explaining why a test guards it.
- **`chat.html`** — the build block, first in the ABOUT panel.
- **`js/22-scheduler.js`** — `renderAboutBuild`, `aboutDiagnosticsText`,
  `copyAboutDiagnostics`; `openAbout` paints then refreshes.
- **`css/13-components.css`** — styling. The warning uses the existing
  `var(--orange, #ff9500)` that `css/15-lore-view.css` already uses, rather
  than the second near-identical warm accent I first reached for.

## What pins it

`tests/test-version-stamp.mjs`, **42 assertions**. Verified to bite: changing
the page stamp without the `VERSION` file fails section A.

Covered beyond the stamp: the mismatch warning naming both numbers and saying
what to do, `dev` not being flagged, an unreachable server still reporting the
half that needs no network, `file://` saying so plainly, the diagnostics
contents, the address being absent, and the clipboard fallback.

One assertion was too blunt on the first run: it checked the string
`no-encoded-payload` appeared nowhere in `js/01-config.js`, which failed on the
comment that explains the whole problem. It checks the value is not *assigned*
now — the comment is the point.

## Not changed

Version strings still say 1.7.3 everywhere, including the two this touched.
That is item 12, next — and doing it in this order is deliberate: the ABOUT
panel now exists to be tested against a version change, rather than being
written and bumped in the same breath where a bug in it would be invisible.
