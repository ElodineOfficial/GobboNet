# 1.7.9 — CONFIG in sections, with search

*Patch step 10 of 1.7.9, F3: "Some visual cleanup by sorting features". 1.7.8
cut the notes down to one sentence and a "?". This step sorts what is left.*

## What was happening

CONFIG was one long page of 17 boxes in the order they were added. Avatar size
sat beside the llama.cpp cache type, and the phone address was between GPU
layers and a config-file editor. A new user had to scroll past every power-user
knob to find the three settings they wanted. A power user had to remember
where each knob was.

## The change

**Five sections, each with a heading and a one-line description:**

| Section | Holds |
| --- | --- |
| **Basics** | Avatar Size, Reply Delivery, the note that names and colours live on your persona card |
| **Characters & Chat** | Character Editor, Auto-Continue, the web search key, Remote Images In Cards |
| **Model & Performance** | Add a Model, Performance (llama.cpp tuning), Idle Stand-Down, the runtime limit |
| **Devices & Network** | Phone & Other Devices, Network access (custom hostnames) |
| **Advanced** | Prompt Order, the Lore Compression time limit, the config.toml editor |

Privacy Status stays last, outside the sections, always shown.

- **Advanced starts closed.** It is a `<details>`, and whether it is open is
  remembered on this device, because it is a per-viewer convenience. Storage
  that throws (a private window, say) is tolerated, and Advanced then starts
  closed each time.
- **A search box at the top** finds a setting by any word of its title, its
  note or its "?" text, across every section. Sections with no match are
  hidden. Typing opens Advanced while a match is inside it and closes it again
  when the box is cleared. That is not saved as a choice. Esc clears the box;
  a second Esc closes CONFIG as before. The result is announced ("3 settings
  match.", or that nothing does).
- **Nothing was removed or renamed.** All 17 boxes moved byte for byte. All 71
  element ids and 28 labels CONFIG had in 1.7.8 are still there, exactly once.
  Every setting saves exactly as before: `openSettings` and `saveSettings` are
  untouched apart from one line that sets up the sections.
- **Search hides with a class, not `style.display`,** so it cannot fight the
  boxes that show or hide themselves, such as Config File and Add a Model.

New: `css/18-config-sections.css`, and the CONFIG SECTIONS & SEARCH block in
`js/15-cards.js` (`initConfigSections`, `filterConfig`, `configBlocks`). The
installer copies `css\*.css`, so nothing else needed changing.

## Tests

- `tests/test-config-sections.mjs`, new:
  - the 1.7.8 inventory (71 ids, 28 labels) is present exactly once, and the
    only new ids are `cfg-*`;
  - the five sections are in order, and each box is in its section;
  - Advanced starts closed, and Privacy Status is last;
  - the search wiring, storage tolerance, and class-based hiding.

  It passes 41 of 41 on this page and fails 31 on 1.7.8's.
- Three existing tests sliced a box "up to the next box", and the next box has
  changed. Each now slices to its own end and asserts its new section:
  `test-config-file-panel.mjs`, `test-prompt-order.mjs`, `test-lan-panel.mjs`.
- `tests/console/1.7.9-step-10.js`, in the browser, passes 15 of 15:
  - five sections in order; settings still present;
  - Advanced as last left;
  - "stand-down" finds one box; "config.toml" opens Advanced; "?" text is
    searched; no match says so;
  - Esc clears without closing; Advanced goes back; searching saves nothing;
    opening by hand is remembered.

  It closes CONFIG without saving and puts the remembered state back.
- Looked at in a headless browser at 1280×900 and 390×844 (phone): headings,
  the pinned search box, a search result, and Advanced closed.
