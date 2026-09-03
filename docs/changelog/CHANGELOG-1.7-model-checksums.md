# v1.7 — Model checksums that actually verify something

*Addresses PR #8 ("Pin the SHA-256 of the engine zip and the embedding model").
The launcher half of that PR is already in 1.7. The equivalent gap on the Go
side was still open, and it was larger.*

---

## What was already done

`launch.bat` in 1.7 ships both of PR #8's pins filled in:

```
set "LLAMA_PIN_SHA256=1aff5b81...43d44"
set "EMBED_PIN_SHA256=3e243421...4c3b7"
```

along with the confirmation prompt before extracting an unpinned engine zip.
Nothing to do there. The NSIS installer bundles the engine rather than fetching
it, so it has no equivalent exposure, and `installer-linux/engine.sha256` pins
both llama.cpp builds already.

## What was not

The Go server downloads models, and its verification had a hole that was
documented, designed around, and then never connected.

`catalog.Entry` carries a `SHA256` field. Its comment explains exactly why it
matters:

> Its value is that it does NOT come from the download host: the weights and
> their LFS pointer both come from HuggingFace, so verifying one against the
> other proves transfer integrity but not authenticity. A hash from a second
> host means two parties would have to agree in order to lie.

`remote.go` parses that field from the catalogue, lower-cases it, length-checks
it, and stores it on the entry.

**`modelfetch` never read it.** The downloader consulted only the LFS pointer —
the hash HuggingFace publishes for a file HuggingFace serves. So the
authenticity check the design describes was wired to a dead end, and anyone
publishing a hash in their catalogue would have had it silently ignored.

That mattered more than it looks, because a self-reported hash catches a
truncated download and nothing else. If the host is compromised, or a
TLS-intercepting proxy sits in the path, the file and the hash it is checked
against both come from the same place.

## What changed

**The catalogue pin is now authoritative**, and the two sources are cross-checked:

| Catalogue pin | HF pointer | Result |
|---|---|---|
| present | present, agrees | verified, reported as confirmed by both |
| present | present, **disagrees** | **refused before downloading a byte** |
| present | missing | verified against the pin, not described as corroborated |
| missing | present | verified against the pointer, exactly as before |
| missing | missing | size floor only, unless `require_checksum` is on |

Disagreement stops the download rather than picking a winner. One of the two is
wrong, and fetching several gigabytes to compare against a hash already known to
be disputed achieves nothing. Preferring the pin quietly would be worse: it
would hide a catalogue that has drifted from the file it describes. The message
prints both values and names the file, so whoever maintains the catalogue knows
which side to fix.

Mismatch messages now name the source that disagreed and print both hashes,
rather than saying only that something did not match.

## New options

Two, and both exist for running a catalogue of your own.

### `sha256=` in `models.ini`

The bundled catalogue is a file the operator controls — shipped by the
installer, or hand-edited for a private or air-gapped set of models. A hash
written there is a genuinely independent pin, so `models.ini` entries now accept
one:

```ini
[1]
display=Llama 3.2 3B Instruct
repo=bartowski/Llama-3.2-3B-Instruct-GGUF
file=Llama-3.2-3B-Instruct-Q8_0.gguf
sha256=3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7
```

Optional, and absent stays the default everywhere. Uppercase and surrounding
whitespace are normalised, so a pasted digest is not read as a mismatch. A
malformed value is dropped **and logged** — silently ignoring a broken security
control leaves an operator believing a download is pinned when it is not, which
is worse than not offering the field.

`installer/gen-catalog.py` carries a `DL_SHA256` through from `launch.bat` when
one is set, and refuses to generate a catalogue containing a malformed hash.

### `require_checksum` in `config.toml`

```toml
require_checksum = false
```

When on, a download that no source can vouch for is refused instead of falling
back to the size floor.

**Off by default, and that is a compatibility decision rather than a preference.**
The shipped `models.ini` carries no hashes and the live catalogue publishes
`null` for every entry, so defaulting it on would refuse every download on a
stock install. It is stated explicitly in `Default()` rather than left to the
zero value, so flipping it later is a visible edit.

Turn it on once you run a catalogue with a `sha256` on every entry — at that
point a missing hash means the catalogue is wrong, and you want to hear about it
rather than download anyway.

Settable the usual ways:

```sh
gobbonet config set require_checksum true
```

The key registry is reflection-driven, so it appeared in `gobbonet config keys`
without being registered anywhere.

## Tests

`internal/modelfetch/download_test.go` — the package had **no test files at all**
before this, so the download path, including its existing checksum handling, was
entirely unverified.

- `TestTamperedDownloadIsRejected` is the property everything here exists for.
  The catalogue pins one hash and the host serves different bytes, with the
  pointer still reporting the *real* hash — metadata that agrees with the
  catalogue, content that does not. Nothing reaches the models directory, and
  the `.part` file is cleaned up.
- `TestVerifiedDownloadIsKept` is the counterpart, without which the check would
  be indistinguishable from refusing everything.
- `TestDisagreementRefusesBeforeDownloading` asserts the message names both
  hashes and the file.
- `TestPinSurvivesAnUnreachablePointer` keeps an upstream outage from silently
  downgrading a pinned download to an unverified one.
- `TestPinIsCaseAndSpaceInsensitive`, `TestPointerUsedWhenNoPin`,
  `TestAgreementIsReportedAsConfirmed`, and the two `require_checksum` cases.

`internal/catalog/catalog_test.go` gains `TestIniCarriesASHA256Pin`, covering
normalisation and the malformed-pin drop — including that a bad hash removes the
hash and not the whole model.

Two test-only seams were added to `Download`: a host override, so the suite does
not depend on HuggingFace's uptime, and a size-floor override, since a test
cannot serve a gigabyte to clear the real one. Both are unset in every shipping
path.

## Not changed

- `launch.bat`, which was already pinned.
- The NSIS installer, which bundles the engine rather than downloading it.
- `installer-linux/engine.sha256`, already pinned for both builds.
- Default behaviour for a stock install: with no pins published anywhere yet, the
  LFS pointer still does the verifying, exactly as before.
