# v1.7 — Item 2: Remote model catalogue

*Builds on item 3, which shipped the modal that consumes this. The workflow is
now end to end: **Add a Model → fetch the live list → pick → download**.*

---

## Two things you need to know before shipping this

### 1. `min_client` is `1.7.0`. The `VERSION` file still says `1.6`.

The live catalogue declares `"min_client": "1.7.0"`. A stamped release build of
this tree reports `1.6-go-<sha>`. **It will therefore refuse the live catalogue
and fall back to the bundled list** — correctly, per the spec, but it means the
feature is inert until `VERSION` is bumped to `1.7`.

Nothing was worked around to hide this. `TestLiveCatalogAgainstCurrentVersionFile`
asserts both halves: a 1.6 build refuses it, a 1.7 build accepts it. Bump
`VERSION` and the gate opens on its own.

One deliberate exception: a build stamped `dev` (the unstamped default) **skips**
the check rather than failing it. A dev build that locks itself out of the live
catalogue makes the feature impossible to work on, and `min_client` is a courtesy
for old released clients, not a security control — nothing about the catalogue is
trusted on the strength of it.

### 2. Every `sha256` in the live catalogue is `null`.

The `_readme` in the served file says the field exists so the client has an
expected hash "that did not come from the download host itself" — the two-source
cross-check that closes the authenticity gap `catalog.go` documents. **That
cross-check cannot do anything yet**, because there is no second hash to compare
against. `gen-remote-catalog.py` needs to actually populate the field.

The client handles this correctly rather than pretending: null reads as "not
provided" and the downloader stays on its existing LFS-pointer path, which is
what shipped before. `TestLiveCatalogHasNoChecksumsYet` documents the current
state and will fail loudly once you start publishing hashes — at which point the
cross-check can be turned on as its own change.

A malformed hash is dropped at the parse boundary rather than kept, so a typo in
the catalogue cannot produce a confusing "checksum mismatch" against a download
that was actually fine.

---

## What changed

Built against the **real bytes** from `https://goblincorps.com/gobbonet_model_list.json`,
fetched 2026-08-29 and pinned at `internal/catalog/testdata/live-catalog.json`.
A schema written from a design doc and a schema actually being served are two
different things, and only one of them is what users hit. They matched, but the
tests now run against the served file rather than a paraphrase of it.

### Precedence

```
fresh remote  ->  cached remote  ->  bundled models.ini
```

Every step down is a normal outcome, not an error path. A fetch failure costs the
live list, never the feature — offline installs, a down endpoint, and a user who
switched the fetch off all end up with a working list and a working download.

### Validation, and what each failure costs

| Problem | Result |
|---|---|
| Unknown `schema_version` | whole file refused, fall back |
| Malformed JSON | whole file refused, fall back |
| Client older than `min_client` | whole file refused, fall back |
| One entry missing `repo`/`file`/`index` | **that entry dropped, rest kept** |
| Duplicate `index` | first wins, later dropped |
| No usable entries at all | whole file refused, fall back |
| Malformed `sha256` | that hash dropped, entry kept |

A file that fails validation is **not written to the cache** — a bad catalogue
must not poison the next run.

### Caching

Cached in `DataDir` as a plain, readable JSON envelope holding the raw body plus
`ETag`/`Last-Modified`. Written with write-and-rename, so a crash mid-write cannot
leave a truncated cache that then fails on every subsequent run. A corrupt cache
is ignored, not fatal.

Served without asking again for 24 hours. Catalogue changes are measured in weeks;
re-fetching every launch spends the user's network to learn nothing. Beyond that
it is a conditional GET, and a `304` re-stamps the cache so a server that always
answers `304` does not make us ask on every run.

### Privacy

The roadmap's constraints, each with a test:

- **Plain GET.** No query parameters, no cookies, no `Authorization`, nothing
  identifying. `TestFetchSendsNothingIdentifying` asserts all of it.
- **No hardware is sent.** The whole ~5 KB file is fetched and filtered locally.
  Asking a server what fits your GPU would be a hardware fingerprint.
- **User-Agent is `GobboNet`** — a name, no version. Not unique to a person, but
  a fingerprinting surface for no benefit a static file's log needs.
- **Go fetches, not the browser.** The page talks only to localhost, which keeps
  the third-party origin out of the document.
- **Switchable off**, and off means *no request is made* rather than a request
  that is ignored. `TestFetchMakesNoRequestWhenDisabled`.
- **5 second timeout.**

### Documentation — the privacy claim changed, so it was corrected

The app told users search was the only thing touching the internet. That is now
false, and leaving it would be the third inconsistent statement PR #16 already
flags.

- **`chat.html` Privacy Status** now names both things that can reach the
  internet, and how to switch this one off.
- **`README.md`** line 174 said web search was "the *one* feature that needs the
  internet". Rewritten, with the catalogue described plainly next to it.
- **`config.toml`** ships a commented block explaining exactly what is sent.

### Settings

```toml
model_catalog_remote = true
model_catalog_url = "https://goblincorps.com/gobbonet_model_list.json"
```

A plain `bool`, not a `*bool`: `Load` seeds from `Default()` before decoding, so
an absent key keeps the default and an explicit `false` still wins — and a pointer
would have broken `config set`, whose `formatValue` quotes anything that is not a
plain Int, Bool or Slice. There is a test for the round trip through `config set`.

### The modal now says where the list came from

A user staring at a stale catalogue needs to know it is the shipped one rather
than the live one, and it makes a bug report actionable without asking anyone to
read logs. `/catalog.json` carries `source`, `generated` and the provenance notes;
the server logs the same at resolution.

### Fields carried but not yet consumed

`Entry` gained `SHA256`, `ChatTemplate`, `UseJinja`, `Tags`, `Notes`; `Catalog`
gained `HeadroomGB` and `Rungs`. All are parsed and available. `chat_template` /
`use_jinja` are what issue #20 (Cydonia 24B) needs somewhere to live.

---

## What is deliberately NOT here

**The headroom rule and the recommendation resolver.** `headroom_gb` and `rungs`
are parsed and carried, but nothing consumes them, because that work is blocked on
a decision the roadmap is explicit the implementing AI must not make:

> The ladder bottoms out at 6 GB. A card below that falls through every rung to
> `default`, which is Llama 3.2 3B with `min_vram_gb: 4` — so a 4 GB card gets a
> recommendation with **zero** slack and no headroom check, the same shape as #23
> at the bottom of the ladder. Options: add a ~2 GB entry, apply the headroom check
> to `default` and fall to CPU-only when it fails, or warn explicitly. **Pick one
> before implementing.**

Once that is answered the resolver is small, and the data it needs is already
parsed and tested.

**Issue #23's hotfix** is also untouched — it wants specific new rung threshold
numbers, which is the same product decision.

**Catalogue signing.** The roadmap leaves this to you and leans toward the
two-source cross-check for v1.7 with signing in v1.8. That is what this
implements — except the cross-check has no data yet, per note 2 above.

---

## Verify

`go build ./...` and `go vet ./...` clean. `go test ./...` passes except
`TestJobLifecycleAgainstDeadUpstream`, which **fails identically on the untouched
v1.7-item-1 tree** — a pre-existing race where the test reads job status before the
goroutine records the error.

**28 catalogue tests**, including parsing the real served file, the min_client gate
across eight version shapes, every validation rule above, all four precedence
paths, the privacy assertions, conditional GET with 304 handling, and cache
corruption.

**3 config tests**: defaults, switching off, and `config set` round trip.

**31 client tests** (`node test-model-catalog.mjs`), up from 28 — the three new
ones cover provenance display.

**Still needs a human at a real install:** a live fetch against the real endpoint
from a real machine, and the actual multi-gigabyte download. Both were left
unmocked deliberately. Worth walking: open Add a Model with the endpoint reachable
and confirm the live list appears; block the domain in your hosts file and confirm
it falls back and says so; then download the smallest entry end to end.

**And bump `VERSION` to `1.7` before shipping**, or every stamped build quietly
takes the fallback path.
