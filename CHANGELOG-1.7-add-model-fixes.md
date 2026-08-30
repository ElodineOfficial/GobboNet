# v1.7 — Add a Model: bug hunt and fixes

*Items 2 and 3 shipped the remote catalogue and the modal that consumes it. This
change makes the workflow actually run on a real install. Two of the findings
meant the feature was dead on Windows before the user clicked anything.*

---

## The two that made it dead on arrival

### 1. Every stamped build refused the live catalogue

`VERSION` said `1.6`. The served catalogue declares `min_client: "1.7.0"`. A
release build reports `1.6-go-<sha>`, fails the gate, and falls back — correctly,
per spec, but it means no shipped build ever saw the live list.

`VERSION` is now `1.7`.

The test that was supposed to guard this was written to *document* the closed
gate rather than fail on it, with the version numbers as literals. It passed
happily while the feature was inert. `TestLiveCatalogAgainstCurrentVersionFile`
now reads the `VERSION` file — the same file the build scripts read — stamps it
the way `build-release.sh` does, and requires the live catalogue to accept it. It
still asserts a 1.6 build is refused, or it would not be a gate.

**One thing to do on your side:** `TestVersionFileMatchesUpstreamRelease` holds
`VERSION` to the nearest `v*` git tag. With `VERSION` at `1.7` and no `v1.7` tag
it will error. It skips when there are no tags, so an exported tree passes. Tag
`v1.7` and it goes quiet. That test has caught real drift twice and was left
alone deliberately.

### 2. `models.ini` was never installed on Windows or in the portable build

`catalog.Discover()` looks for `models.ini` beside the executable. Nothing ever
put one there.

- `gobbonet.nsi` extracted it to `$PLUGINSDIR` in `.onInit` for the installer's
  own model page. NSIS deletes `$PLUGINSDIR` when the installer exits.
- `build-installer.sh` never copied it into `$PAYLOAD`.
- `build-release.sh` staged `web/`, the binary and a README, and nothing else.

Only the `.deb` shipped it, to `/usr/lib/gobbonet/models.ini`.

Combined with finding 1: remote refused, no cache on a first run, no bundled
file. `/catalog.json` answered 503 and the modal was empty. On Windows, always.

It worked in development because a build stamped `dev` skips the `min_client`
check on purpose, and `installer/models.ini` is discoverable from a checkout's
working directory. Both of the things that made it testable were also the things
that hid this.

- `gobbonet.nsi` installs `models.ini` to `$INSTDIR` in `SecMain`, from the same
  compile-time source `ReserveFile` already names, and the uninstaller removes
  it.
- `build-release.sh` stages it beside the binary, and refuses to build without
  it rather than producing an archive that loses the feature offline.

---

## The one that broke model loading

The download handler wrote the new model's `ctx` and `kv` to `config.toml` and
never told `s.tuning` or the supervisor. Compare `perf.go`, which writes and then
calls `s.sup.SetTuning(t)`.

Three separate faults in one block:

1. **The swap used the wrong settings.** Click *Switch to it now* and
   llama-server respawned on the *previous* model's context window and KV type.
   The values just saved applied only after a full restart. Going from a small
   model to a large one, that means a 22 GB model launched under a 32768 window:
   VRAM exhausted, load fails, rollback. It reads as a bad download.
2. **It moved settings for a model that was not running.** The write landed at
   download *start*. Download B while chatting on A, never switch, restart later,
   and A came up with B's context window.
3. **A failed download still moved them.** The write was before the transfer
   finished.

Both `config.Set` calls are gone from the download path. `handleSwapModel` now
wraps `/swap-model`: it resolves the incoming file against the catalogue and
publishes that model's tuning before delegating to the supervisor unchanged.
Published *before* `Swap()` dispatches its goroutine, so `start()` reads it with
no window to race.

This fixes more than the modal. Picking a catalogue model out of the header
dropdown had the same bug by a different route.

`tuning.setAuto` moves the `config.toml` baseline — which is the right layer for
a published per-model value, and the thing `/perf` reset restores to — and only
puts it in force when `perf.toml` is not overriding. A user who set a context
size in the panel keeps it. `GPULayers` is untouched: the catalogue has no
opinion on it and the hardware probe's answer is about the card.

Only an **already resolved** catalogue is consulted. Resolving one can mean a
five second fetch, and that does not belong in front of a model swap for someone
who never opened the modal. Unresolved means this does nothing, which is what the
code did before.

Out-of-range `ctx` and unknown `kv_cache_type` are dropped with a log line. A
catalogue is editable on disk and arrives over the network; a window the panel
would refuse does not get a private door in through here.

---

## The rest

**The list was resolved once per process.** Open the modal offline, reconnect a
minute later, and you kept the bundled list until GobboNet was restarted.
`/catalog.json?refresh=1` drops the memoised resolution, and the modal asks for
it on every open. `catalog.Options.Force` skips the fetch's 24 hour age check
while keeping the conditional GET, so an unchanged catalogue still costs a header
exchange rather than a transfer. Rate-limited to once a minute: four opens on a
dead network cost one timeout, not four. `Enabled: false` still wins — off has to
mean no request at all.

**The 503 explained nothing.** `catNotes` was assigned only on the success path,
so when every source failed the notes saying *why* went to the log and nowhere
else, and the user got the generic "no catalogue available". They are now held
whatever happens, returned with the 503, and rendered as bullets under the
headline.

**A finished download was reported forever.** `downloads.current` was never
cleared, so every later open of the modal reacted to a transfer from a session
the user had left — writing into a hidden panel and starting a second
`loadModelCatalog()` that raced the one already in flight. `POST /model-download`
takes `{"clear": true}`, sent when the modal closes; a running download is
refused and keeps going. The open-time poll now ignores terminal states entirely.

**Nothing said where the file went.** A completed download now says it is in the
models folder and in the header dropdown, and that restarting picks it up too. A
failed swap leads with the fact that the download itself was fine, then offers the
dropdown or a restart — restarting reloads the backend from config, which is
exactly what the swap was going to do.

**The button still said "Placeholder — not finished yet."**

**Every `test-*.mjs` hardcoded `/home/claude/work/GobboNet`.** They only ran on
one machine's directory layout. All seven now derive their root from
`import.meta.url`.

---

## Verify

`go build ./...` and `go vet ./...` clean. `go test ./...` passes except
`TestJobLifecycleAgainstDeadUpstream`, which **fails identically on the untouched
tree** — confirmed by running it there, not assumed. It is the pre-existing race
where the test reads job status before the goroutine records the error.

**13 new Go tests.** Catalogue tuning: applied for the model being swapped to,
persisted to `config.toml`, `perf.toml` still wins, GPU layers left alone, an
unknown model changes nothing, a swap does not resolve the catalogue, and
out-of-range values are refused. Download side effects: starting one leaves the
running model's settings and `config.toml` byte-identical. Clear: forgets a
finished download, refuses a running one, works with no catalogue at all.
Refresh: drops a memoised failure. And the 503 carries its notes.

Two of those tests were initially written against `big.gguf`, whose 16384 / q8_0
is exactly what `config.Default()` seeds — so a write and no write read back the
same and the test passed for the wrong reason. They use `small.gguf` (32768 /
f16) now. Worth knowing if you add more.

**3 new catalogue tests** for `Force`: it bypasses the age check, it still
respects `Enabled: false`, and it still sends `If-None-Match`.

**Client:** `node test-model-catalog.mjs`, **53 assertions**, up from 31. The 22
new ones cover the refresh parameter, the 503 notes rendering as text and not
markup, the silent poll ignoring terminal states while still adopting a running
one, the clear-on-close (and not attempting it under `file://`), and both new
completion messages.

**Still needs a human at a real install.** Unchanged from before: the actual
multi-gigabyte transfer reaches HuggingFace and is deliberately unmocked. Worth
walking now that the packaging is fixed:

1. Install on Windows and confirm `models.ini` is next to `gobbonet.exe`.
2. Open Add a Model with the endpoint reachable — the list should be live.
3. Block `goblincorps.com` in your hosts file, reopen, and confirm it says it is
   showing the shipped list rather than failing.
4. Download the smallest entry, then *Switch to it now*, and check the startup
   line reports that model's context size rather than the previous one's. That is
   the fix that is hardest to see and easiest to regress.

---

## Still open

**`sha256` is `null` for every entry**, so the two-source cross-check
`catalog.go` documents still cannot do anything. `gen-remote-catalog.py` needs to
populate it; `TestLiveCatalogHasNoChecksumsYet` will fail loudly when you start,
which is the signal to turn the check on as its own change.

**The served `_readme` says the file lives at `gobbonet_model_list`** with no
extension. `.json` is what resolves. A one-line fix in the generator.

**The headroom rule and the recommendation resolver** are still blocked on the
product decision items 2 and 3 both flagged. Nothing here touches it.
