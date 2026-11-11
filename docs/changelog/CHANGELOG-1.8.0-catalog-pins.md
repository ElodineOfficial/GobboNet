# 1.8.0 — every catalogue model is pinned

Suggested by users: "needs to upload catalog/gobbonet_model_list.json. Only
Nemo and Gemma 31B have pinned checksums so far."

## What was happening

Two of the sixteen catalogue models had a SHA-256 pin. The other fourteen
downloaded checked only against HuggingFace's own record at download time,
and Add a Model marked them UNVERIFIED and asked twice. And
`catalog/gobbonet_model_list.json`, the live list served from goblincorps.com
that clients prefer over the bundled one, was regenerated only when someone
remembered to run `gen-remote-catalog.py` after pinning, then uploaded by hand.

## The change

**All sixteen are pinned** (`launch.bat`, regenerated into `catalog/models.ini`,
`linux-amd64/models.ini` and `catalog/gobbonet_model_list.json`). The values are
HuggingFace's LFS pointers for each file on `main`, read on the maintainer's
PC and put in through `catalog/pin-hashes.py` unchanged. The two existing pins
matched them exactly. The pointers' sizes were not part of what was read, so
`python3 catalog/pin-hashes.py --check --require-all` on a PC that can reach
HuggingFace is the check to run before release: it re-reads every pointer,
compares hash and size, and exits 1 on any mismatch or unpinned entry.

**A live list older than the release borrows its pins**
(`internal/catalog/pins.go`). The client takes the live list over the bundled
one, so until the new list is uploaded every client would still have shown
fourteen models UNVERIFIED. Like the bucket tags and MoE allowances before it,
an entry the live list leaves unpinned takes the bundled pin for the same repo
and file; a pin the live list has is never replaced, since it is the newer
record. The catalogue notes say how many were borrowed.

**`pin-hashes.py` keeps the upload file current.** After pinning it regenerates
`gobbonet_model_list.json` too, and says to upload it.
`gen-remote-catalog.py` leaves the file untouched when only the timestamp would
change. `--save-pointers FILE` writes every pointer it read, in the format
`GOBBONET_PIN_FIXTURE` reads, for a PC that can reach HuggingFace but is not
where the catalogue is edited. `--check --require-all` fails while any model is
unpinned.

**Still the maintainer's step**: upload `catalog/gobbonet_model_list.json` to
`https://goblincorps.com/gobbonet_model_list.json`.

## Tests

- `tests/test-pin-hashes.py`: the working copy goes back to the 1.7.9 state
  (two pins) so pinning is still exercised; pinning rewrites the live list and
  says to upload it; `--no-regen` leaves it alone; an unchanged list keeps its
  date; saved pointers pin through the same script; `--require-all` fails while
  any model is unpinned. New in `Committed`: every catalogue model in
  `launch.bat` is pinned, the live list carries the pins, and no two models
  share one.
- `internal/catalog/pins_test.go` (new): an unpinned live entry takes the
  bundled pin; a same-named file in another repo does not; a live pin stays; a
  model the bundled list lacks stays unpinned. A cached served list with one
  pin comes out of `Fetch` fully pinned, and the notes say how many were
  borrowed.
