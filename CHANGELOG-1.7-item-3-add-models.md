# v1.7 — Item 3: Add models from inside GobboNet

*Roadmap item 3, "Model picker overhaul". Item 2 (remote catalogue) is **not**
in this change — see "What is deliberately not here" at the bottom.*

---

## What this does

A **BROWSE CATALOGUE** button in the config panel opens a modal listing the
download catalogue. Pick one, and GobboNet downloads it into your models folder,
verifies it, and the header dropdown picks it up on its own. Optionally switch to
it immediately.

Before this, adding a model meant re-running the installer or placing a `.gguf`
by hand — the dead end behind issue #12.

---

## The thing that made this small

**A complete, careful downloader already existed**, walled inside the first-run
wizard: `.part` file, atomic rename, streaming SHA-256 against HuggingFace's LFS
pointer, a size floor for when an error page arrives as a clean 200, live
progress, one download at a time, error text written for humans.

None of it was rebuilt. It was **lifted out of `package setup`** so the running
server can call it too. That is the difference between "build a download manager"
and "move a type and add three routes."

The move was verified as a move: `Run()` and `progressWriter` were diffed against
the originals with comments stripped and came out byte-identical. The checksum
policy, the size floor and the error strings were arrived at against real
upstream failures and are load-bearing exactly as they are.

---

## Changes

### New — `internal/modelfetch`

| Was | Now |
|---|---|
| `setup.download` | `modelfetch.Download` |
| `setup.downloadStatus` | `modelfetch.Status` |
| `setup.newDownload` | `modelfetch.New` |
| `setup.modelSizeFloor` | `modelfetch.SizeFloor` |
| `setup.freeBytes` | `modelfetch.FreeBytes` |

`internal/setup` now calls the moved code; `internal/setup/freespace_{unix,windows}.go`
are deleted. One implementation, two callers.

`Entry()` is the only added method — a caller needs to read back which entry it
asked for, to record that model's `ctx`/`kv` tuning.

One comment was corrected rather than moved verbatim.
`freespace_windows.go` said it existed "to keep the build honest rather than to
carry weight," because only the Linux/macOS wizard reached it. The settings-panel
download calls it on every platform, so that note was now actively wrong.

### New — `catalog.Discover()` (`internal/catalog/discover.go`)

`findCatalog()` moved out of `cmd/gobbonet/setup.go`. The server needs the same
search order, and two copies of a lookup order diverge the moment a packaging
path changes. `cmd/gobbonet` now calls it; its local `filepath` import went away
with it.

### New — three routes (`internal/server/models.go`)

```
GET  /catalog.json      the parsed catalogue + free space + what is installed
POST /model-download    start one   (body: {"index": N})
GET  /model-download    poll progress
```

All three sit **after the auth gate** in `server.go`'s switch. That placement is
load-bearing: this is the one route pair that writes files to disk and makes
outbound requests, and GobboNet can be bound to the LAN. Unauthenticated,
`/model-download` would let any device that can reach the port fill the disk.
There is a test asserting all three return 401 without a session.

The catalogue projection **drops `repo`**. The client submits an index and the
server resolves it, so nothing the page sends can name an arbitrary URL to fetch
or an arbitrary path to write.

`internal/models.Info.Installed()` was exported so the modal can mark models the
user already has. It shares `scanCached` rather than listing the directory again,
so both answers come from one cache and cannot disagree.

The catalogue loads lazily and caches its failure: **a missing `models.ini`
disables one modal rather than stopping the server.** Chat works fine without a
download list. `/catalog.json` answers 503 and `/health-fileserver` keeps working
— there is a test for exactly that.

### New — the modal (`chat.html`, `js/02-model.js`, `css/13-components.css`)

Placed **immediately above Privacy Status, below every other control**, as
specified. Privacy Status stays last. The button is not a setting: `openSettings()`
does not populate it and `saveSettings()` does not read it. No existing element ID
was added, renamed or touched.

The client lives in `js/02-model.js` — which already owns "models list, hot-swap"
— rather than a new numbered module, because load order is a contract and
`24-boot.js` is last.

**Progress is polled, not streamed.** The wizard polls every 700ms and it works;
the same shape here is proven and boring. No SSE, no websocket.

**Nothing invalidates the installed-model list, because nothing has to.**
`scanCached()` keys on the model directory's mtime *and* entry count, and renaming
a `.part` into place changes both.

---

## Two bugs found by tests, and fixed

**1. The disk check ran before the one-at-a-time check.** Free space *falls* while
a large model lands, so a second click could be refused with "not enough space"
when the honest answer was "a download is already running." The concurrency check
now runs first. `begin()` still re-checks under its own lock — that is what closes
the race; the reordering is about which message the user gets. Test:
`TestModelDownloadReportsRunningBeforeDiskSpace`.

**2. The "already running" explanation was written to the log line, then
overwritten by the next poll tick 700ms later.** The user never read it. It now
goes to a dedicated note element the poll loop does not touch, with a test
asserting it survives a tick.

---

## Verify

**Server** — `go build ./...` and `go vet ./...` clean. `go test ./...` passes
except `TestJobLifecycleAgainstDeadUpstream`, which **fails identically on the
untouched v1.7-item-1 tree** — it is a pre-existing race where the test reads job
status before the goroutine records the error. Not from this work.

12 new Go tests (`internal/server/models_test.go`): catalogue shape and the field
names the modal reads, `repo` absence, installed marking, 503 without a catalogue,
health surviving that, unknown index, bad JSON, wrong method, one-at-a-time,
ordering, disk guard, and the auth gate on all three routes.

**Client** — `node test-model-catalog.mjs`, 28 assertions, all passing. Runs the
real functions out of `js/02-model.js` against a stub DOM and a mock fetch:
hostile display names stay literal text, the wire carries an index and never a URL
or filename, installed models are not re-offered, a download in flight is adopted
rather than duplicated, failure shows the server's message and offers no swap,
success **offers** the swap instead of taking it, a 503 is explained, and `file://`
hides the button with a reason.

**`stage-web.sh` passes** — its module-count check reconciles against `chat.html`.

**Still needs a human at a real install:** the actual multi-gigabyte download.
Everything around it is covered, but the transfer itself reaches HuggingFace and
was deliberately not mocked. Worth walking: download the smallest entry, confirm
progress moves, the file lands in `cfg.ModelDir`, and it appears in the header
dropdown with no reload. Then point an entry at a wrong URL and confirm the
checksum failure deletes the `.part` and reports it.

---

## What is deliberately not here

Per the item's scope boundary: no resumable downloads, no parallel downloads, no
deleting installed models, no custom-URL or HuggingFace-search field, no
per-model settings UI. Each is a separate decision and none blocks adding a model.

**Item 2 is not in this change.** The catalogue is still read from the local
`installer/models.ini`. Item 2 changes *where the catalogue comes from* — remote,
with the local file as fallback — and the UI will not change at all, because both
paths hand back the same `catalog.Entry` values.

---

## Open, for Elodine

- **Resumability.** The scope boundary already answers this ("not in this item"),
  so v1.7 downloads do not resume across a restart. Flagging it because the doc
  asked for it to be a decision rather than an accident. `.part` files are on
  disk, so v1.8 could.
- **Item 2's sub-6GB gap still blocks the recommend resolver** — add a ~2 GB
  entry, apply the headroom check to `default` and fall to CPU-only, or warn
  explicitly. The roadmap is explicit that the implementing AI should not pick it.
- **The endpoint URL** is taken as `https://goblincorps.com/gobbonet_model_list.json`
  on your word. Nothing in this change uses it yet.
