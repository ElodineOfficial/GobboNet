# Gobbonet frontend — module index

> Upstream v1.5 split the single-file frontend into `chat.html` (a 950-line
> shell) plus `js/01..24` and `css/01..15`. **No build step, no module system:**
> plain `<script>` tags sharing globals, so load order is load-bearing.

## What happened to this file

It used to index `chat.html` by line number — `renderMessages()` at 7848, and so
on. Every one of those numbers died with the split, and a structural index that
has to be hand-maintained against a moving file is wrong again within a release.

It is not replaced by a new set of line numbers. Each module's own header
records the range it came from, so the table below translates any stale line
reference — in an old commit message, a review comment, or the rest of these
docs — into the file that now holds it. For finding a symbol, `grep -rn` across
`js/` is both faster and always correct.

## Old `chat.html` line → module

Ranges are from the pre-split monolith (~12,289 lines; the `<head>` and layout
shell below line 1394 stayed in `chat.html`).

| Module | Was `chat.html` lines | Lines now |
|---|---|---|
| `js/01-config.js` | 1394–1558 | 170 |
| `js/02-model.js` | 1559–2019 | 614 |
| `js/03-generation.js` | 2020–3134 | 1122 |
| `js/04-state.js` | 3135–3352 | 307 |
| `js/05-persistence.js` | 3353–4014 | 667 |
| `js/06-state-sync.js` | 4015–4863 | 854 |
| `js/07-prompt.js` | 4864–5499 | 839 |
| `js/08-rag.js` | 5500–6419 | 967 |
| `js/09-threads.js` | 6420–6876 | 462 |
| `js/10-chat.js` | 6877–7848 | 1050 |
| `js/11-search.js` | 7849–8065 | 222 |
| `js/12-render.js` | 8066–8534 | 475 |
| `js/13-dashboard.js` | 8535–9138 | 803 |
| `js/14-scroll.js` | 9139–9481 | 350 |
| `js/15-cards.js` | 9482–9803 | 379 |
| `js/16-card-io.js` | 9804–10515 | 743 |
| `js/17-personas.js` | 10516–10767 | 257 |
| `js/18-utils.js` | 10768–11310 | 591 |
| `js/19-extensions.js` | 11311–11554 | 249 |
| `js/20-macros.js` | 11555–11702 | 153 |
| `js/21-data.js` | 11703–11915 | 218 |
| `js/22-scheduler.js` | 11916–12143 | 233 |
| `js/23-card-code.js` | — | 313 |
| `js/24-boot.js` | 12144–12289 | 154 |

## Stylesheets

`css/01-tokens.css` `02-layout` `03-threads` `04-chat` `05-modals` `06-cards`
`07-message-extras` `08-pickers` `09-dashboard` `10-responsive` `11-panels`
`12-organisation` `13-components` `14-card-code` `15-lore-view` — 3,846 lines
total, split out of the former 2,943-line `style.css` plus the inline `<style>`
block. Load order matters here too: `01-tokens.css` defines the custom
properties every later sheet reads.

## Load-order hazards

- `js/01-config.js` must load first (globals every other module reads) and
  `js/24-boot.js` last (it wires listeners and kicks off the first render).
- `js/23-card-code.js` is the only hand-written module — the other 23 were
  mechanically extracted, which is why their headers carry line ranges.
- Adding a module means editing `chat.html`'s `<script>` list. `stage-web.sh`
  refuses to build a web root whose file count disagrees with what `chat.html`
  actually references, so a forgotten tag fails the build instead of producing
  a blank page with console errors.

## Where the server fits

The Go server serves these as static files from its web root and adds nothing to
them — no templating, no injection, no bundling. `web/` is assembled by
`stage-web.sh`; edit the files at the repo root, never the copies under `web/`.
