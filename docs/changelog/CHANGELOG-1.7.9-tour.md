# 1.7.9 — An optional first-run tour

*Patch step 11 of 1.7.9, F4: "Optional first-run tutorial".*

## What was happening

A new user landed on GOBBONET_HQ with no idea where anything was. The page
assumed you already knew that characters live in CHARS, that a chat starts
with + NEW_THREAD, that the header menu swaps models, that your phone is
set up in CONFIG, and that a character called the Gobbonet Informant is there
to answer questions about GobboNet itself.

## The change

**Six stops, one sentence each, each a spotlight on the real control:**

| # | Stop | Points at |
| --- | --- | --- |
| 1 | Pick a character | CHARS |
| 2 | Send a message | the message box, or + NEW_THREAD on the home screen where there is no box yet |
| 3 | Choose a model | the model menu in the header |
| 4 | Settings | CONFIG |
| 5 | Your phone | Phone & Other Devices, with CONFIG opened to it |
| 6 | Getting help | the Gobbonet Informant's + ADD on the home screen, or the home button from inside a chat |

The help stop reads the profile. If the Informant is already added, it says
to pick it in CHARS. If `default-characters.json` no longer offers it, it
points at TROUBLESHOOTING.md and the Discord link in ABOUT instead.

**Optional, and asked once.**
- A fresh profile gets one small card: "New to GobboNet?", with **Show me
  around** and **Skip**.
- Either answer is remembered. So is taking the tour, so closing the tab
  half-way does not ask again.
- A profile that already has a conversation of its own is never offered it.
  **Upgrading from 1.7.8 interrupts nobody.**
- The offer waits for the first sync and for any open panel or sign-in to
  clear, so it never lands on top of something else.
- **CONFIG → Basics → Tour → SHOW ME AROUND** replays it at any time. Its
  visible line says that starting it closes CONFIG without saving. An unsaved
  config.toml still asks first, and if you refuse, the tour does not start.

**Every knob where power users can reach it.** "Seen" is a setting,
`tourSeen`, so it syncs. It also works as a server preset: put this in
config.toml and new devices are never offered the tour (they can still
replay it from CONFIG):

```toml
[ui]
tour_seen = true
```

**Keyboard and screen readers.**
- The card is a modal dialog, and focus stays inside it.
- → / ← move between stops. Esc ends the tour, including the CONFIG panel
  it opened.
- Each stop is announced ("Step 2 of 6: …").
- Focus goes back to where it was when the tour ends.
- The spotlight does not animate for people who ask for reduced motion.

**A look, not a click-through.** The shade takes every click, so nothing
changes behind the tour. The sidebar (on a phone) and CONFIG are opened for
the stops that need them, then closed again.

## Private

The tour is one file, `js/25-tutorial.js`, plus `css/19-tour.css`. It fetches
nothing, uses no browser storage and builds its card with `textContent`. The
only thing it records is `state.settings.tourSeen`.

## Built to survive F3-style moves

Each stop names `data-tour="..."` attributes, never a CSS class or a position:
`characters`, `new-chat`, `message`, `model`, `config`, `phone`, `help`,
`home`. A stop lists fallbacks in order.
- A control the page re-renders under the tour (a sync arriving, say) is found
  again by name.
- A stop whose targets are all missing still shows, centred, rather than
  vanishing.
- The spotlight is clipped to the panel a control sits in, so a tall box in
  CONFIG is not outlined past CONFIG's edge.

## Also fixed: "syncing…" on a new profile

On a profile with no conversations and nothing on the server, the sidebar
said "⟳ syncing…" from the first load and never stopped. 1.7.8 does this too.
By design, nothing is uploaded until the first conversation exists: an empty
device must not create the backup, and the first upload carries the settings
with it. The indicator now says "○ sync idle" until then, and "✓ synced" after.

One consequence for the tour: before anyone has chatted, a Skip on one device
has not reached the server yet, so a second device would ask once more. After
the first chat, the second device gets the chats too, so it is not a fresh
profile and is never asked.

## Code

- New: `js/25-tutorial.js` (TOUR, loaded after `24-boot.js` and waiting on
  `window.GobboNet.ready`) and `css/19-tour.css`.
- `chat.html`: `data-tour` on seven controls, the Tour box in CONFIG → Basics,
  the script and stylesheet tags.
- `js/13-dashboard.js`: `data-tour="help"` on the home screen's DEFAULT
  CHARACTERS section.
- `js/04-state.js`: `tourSeen: false` in `DEFAULT_SETTINGS`.
- `js/06-state-sync.js`: `ensureSyncLedger` sets the status to idle when there
  is nothing to seed.
- The installer copies `js\*.js` and `css\*.css`, and `stage-web.sh` stages
  them, so nothing else changed.

## Tests

- `tests/test-tutorial.mjs`, new, 53 checks:
  - every target exists exactly once, and targets are found only by
    `data-tour`;
  - the six promised stops, in order, with their fallbacks;
  - every line in every variant is one sentence;
  - when it is offered, run for real: fresh only, never after "seen", never
    to a profile with a conversation, never over a panel or the sign-in;
  - private: no network, no storage, no markup, and one setting written;
  - the replay box, capture-phase keys, the focus trap and reduced motion.
- `tests/test-sync-initialization.mjs` gained the empty-profile case. It fails
  on the old code.
- `test-config-sections.mjs` now lists the Tour box as the one 1.7.9
  addition to CONFIG's inventory. `test-lan-panel.mjs` ignores `data-tour`
  when it pins the box's style.
- `tests/console/1.7.9-step-11.js`, in the browser, passes 22 of 22 on the home
  screen at desktop width and inside a chat at phone width:
  - the offer, Skip, and all six stops with spotlights;
  - the arrow keys, Tab, Esc, and that clicks are blocked;
  - CONFIG opened and closed by the phone stop;
  - the replay button;
  - nothing outside GobboNet contacted.

  It puts "seen" back afterwards. On 1.7.8 it fails at once: the page has no
  tour.
- Scenarios in a headless browser against a real server:
  - a fresh profile is offered the tour;
  - a profile with a conversation is not;
  - a synced second device is not;
  - `[ui] tour_seen = true` turns the offer off;
  - the indicator goes idle, then synced.
- Looked at every stop at 1280×860 and 390×844.
