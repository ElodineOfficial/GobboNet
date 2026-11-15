# 1.8.1 — the web search switch belongs to each device

## What was happening

Reported: web search ran on a phone (possibly on the PC too) while sending
messages and during lore compression, when it should not have.

The 🔍 switch was `state.searchEnabled`, stored in `/state` with the chats
and synced. Switching it on at one device switched it on for every device
that opened GobboNet afterwards: boot adopts the server's state
(`restoreFromServer(... boot: true)`) and then `js/24-boot.js` set the switch
from it. When a full sync arrived while a page was open, `js/06-state-sync.js`
set the variable but not the button, so the switch was on behind a button
that looked off. Search runs in `sendMessage()` before the prompt is built,
which is where lore compression happens, so on screen the search line and the
compression line arrived together. Compression itself never searches.

Reproduced in two headless Chrome sessions on one server with the 1.8.0
build: the PC switched search on; a phone (Pixel 7 profile) with its own
search key, which never touched 🔍, opened GobboNet, found the switch on and
its button lit, and its next message went to `/search` (the requests were
intercepted and blocked; nothing left the workspace).

A phone with no key never reached the network: `webSearch()` stops without a
key and the message shows "search ON but no API key set", which on that
phone also looked like search firing.

## The change

The switch is the browser's own, like the search key (`settings.apiKey`,
which never leaves it): `localStorage['gobbonet.webSearch']` (`on`/`off`),
read when `js/11-search.js` loads, off when absent or unreadable.
`toggleSearch()` writes only that and the button; `showSearchSwitch()` makes
the button (class, `aria-pressed`, title) say what it is, and is called at
boot and after a full sync.

`state.searchEnabled` stays in the blob but is always false: `applyLoadedState`
sets it false whatever was saved, `buildStateMeta` and the export write false,
and import ignores it. A 1.8.0 device reading this state therefore turns its
own search off rather than on, and a 1.8.0 device that switches it on
changes nothing elsewhere.

After updating, search is off on every device until switched on there.
`PATCH-README.txt` says so. The button's title, the README and the Gobbonet
Informant say the switch is per device (1,496 of the Informant's 1,500
tokens). `AGENTS.md`'s privacy rule names it.

Not changed: scheduled tasks. Each open page runs them, so one with search on
searches from whichever device runs it; that, and that two open devices can
both run the same task, is older and separate.

## Tests

- `tests/test-search-switch.mjs` (new): `js/11-search.js` against a fake
  page and `localStorage` -- off by default, on and off kept in this browser,
  the button following, nothing written to the shared state, unreadable
  storage meaning off. Then the places that used to take the switch from a
  stored copy (load, sync, boot, import, the blob sent to the server) and
  the page and the Informant. 19 checks; against 1.8.0 it stops at the first.
- `tests/test-boot-resume.mjs` and `tests/test-state-handshake.mjs`, which
  run the boot and sync code alone, pass: the boot call is guarded with
  `typeof`, as calls into later modules are.
- Headless Chrome, two sessions on one server, with the fixed build: the PC
  switches on and keeps it across a reload; a phone with a key opened fresh
  while the server's copy said on (as a 1.8.0 PC leaves it) stays off and
  sends nothing to `/search`, through a sync and a reopen; once the phone
  switches on itself it searches. The server's copy reads false afterwards.

Not run: a real phone (Chrome's Pixel 7 profile stood in).
