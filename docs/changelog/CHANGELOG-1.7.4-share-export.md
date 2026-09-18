# 1.7.4 — Character card export that survives being posted

Roadmap items 3 and 7, which are the same item: *"export via other options
besides images"* and *"an ADDITIONAL option you can just label [For Discord
Sharing] … JPG that is also a ZIP"*. One export closes both.

## The problem

The V3 PNG export keeps the card in `tEXt` chunks. That is the de-facto
interchange format and it is the right default — SillyTavern, Chub, RisuAI and
Agnai all read it.

Chunks are metadata, and metadata is the first thing a chat platform discards
when it processes an upload. The failure mode is the nasty kind: the picture
arrives looking perfectly fine, and the card inside it is gone. Nothing warns
anyone. The person who posted it finds out when someone else tries to import
it, which may be days later.

## The fix, and why it is shaped this way

An additional export that puts the card somewhere that is **not metadata**: a
complete ZIP archive appended after the image data. One file, two formats.

It works because of two facts that hold independently of each other:

- A JPEG decoder stops at the end-of-image marker and ignores everything after
  it, so the file is an ordinary picture that renders anywhere.
- A ZIP reader locates the archive by scanning **backwards** from the end of
  the file for the end-of-central-directory record, so an archive at the tail
  of a larger file is found exactly like one at the start. This is the same
  mechanism that makes self-extracting archives work.

### The offsets are biased, and that is the whole trick

`cat image.jpg archive.zip > out.jpg` produces a file whose every recorded
offset — the central directory's position, and each entry's local header — is
short by the length of the image.

Info-ZIP and Python's `zipfile` detect that and correct for it. **The reader in
`js/16-card-io.js` does not**, because it uses the recorded offset as an
absolute index. So the naive build produces a file that half the world can open
and GobboNet itself cannot — the one consumer that matters most.

`_zipArchiveBytes(files, prefixLen)` therefore writes the offsets already
biased by the prefix length. The combined file is then a spec-correct ZIP whose
offsets are true from byte zero, and it opens in everything with no special
cases anywhere, including our own importer unchanged.

Verified in real tools, not just in the test harness:

| Tool | Naive concatenation | As shipped |
|---|---|---|
| GobboNet's own reader | **fails outright** | reads |
| `unzip -t` | `warning: 724 extra bytes at beginning or within zipfile` | `No errors detected` |
| Python `zipfile` | works (silently corrects) | works |
| `file(1)` / PIL | JPEG | JPEG |

### The archive is a `.charx`

`card.json` at the root, exactly the layout the V3 spec already defines and
that `_readCardFromCharx` already reads. Renaming the export to `.charx` makes
it importable by any V3-aware app. The container is not a private invention
that only GobboNet understands.

Contents:

- `card.json` — Character Card V3
- `card_v2.json` — the same character in V2, for apps that only speak V2
- `README.txt` — plain ASCII, for whoever renames the file to `.zip` and opens
  it in Notepad. The person who needs that instruction is exactly the person
  who cannot read this changelog.

### What is deliberately *not* in the archive

The portrait. The file **is** the portrait, and duplicating it inside the
archive glued to it would roughly double the size of something headed for a
platform with an upload limit. On import, `_readCardFromZipTail` takes the
avatar from the image bytes in front of the archive — so the avatar the
recipient gets is exactly the picture the sharer saw.

### Compression

Deflate via `CompressionStream` where the browser has it, and **only if it
actually helps** — an already-compressed payload usually deflates *larger*.
Stored entries otherwise, which is a valid ZIP entry everywhere, so the export
still works on a runtime with no `CompressionStream` at all.

## The honest limit

If a platform genuinely **re-encodes** the image rather than stripping its
metadata, the appended archive goes with it. Nothing survives a re-encode —
not chunks, not a tail archive, not EXIF.

What this buys is every case short of that, plus a file the recipient can
rename to `.zip` and open by hand with no tooling. It is strictly more
recoverable than a PNG carrying chunks, and never less. Worth knowing when
testing: downloading an attachment usually yields the original bytes, while
right-click → *Copy image* on a preview yields a re-encode. If the format ever
stops working somewhere, that is the first thing to check.

## Changes

**`js/16-card-io.js`**

- `_findZipEocd()` — the backwards EOCD scan, factored out of
  `_readZipDirectory` so "is this a ZIP?" and "read this ZIP" cannot disagree.
- `_imageMimeFromMagic()`, `_readCardFromZipTail()` — import side.
- `_dosDateTime()`, `_deflateRaw()`, `_zipArchiveBytes()` — the ZIP writer.
- `_cardPortraitDataUrl()` — extracted from `_cardImagePngBytes` so both
  exports render the portrait through one path. JPEG has no alpha, so the
  opaque variant lays down the app's surface colour first; without it a
  transparent avatar encodes as black speckle.
- `_liveCardSnapshot()`, `_cardFileStem()` — extracted from `exportCardAsV3`,
  now shared, so the two exports cannot drift about what is being exported.
- `exportCardForDiscord()`.

**`chat.html`** — a FOR SHARING button beside EXPORT V3, and `.jpg` / `.jpeg`
added to the import picker's `accept` list. Without that second part the file
could not even be selected for import.

**`css/05-modals.css`** — `flex-wrap: wrap` on `.modal-actions`. Five buttons
in that row would otherwise run off the side of a phone.

## Import stays as it is

Every existing path is untouched: `.charx`, `.png` and `.json` reach exactly
the code they always did. The only change is to the unknown-extension branch,
which now checks for a tail archive **before** falling back to decoding the
file as JSON text. That branch previously ended in
`Embedded card data is not valid JSON` for a `.jpg`, so nothing that used to
work has changed behaviour — a case that only ever failed now succeeds.

## What pins it

`tests/test-card-share-export.mjs`, **46 assertions**, driving the real
`_zipArchiveBytes`, `_findZipEocd`, `_readZipDirectory`, `_readZipEntry` and
`_readCardFromCharx` over a real (if small) JPEG embedded in the file. No DOM
and no install step: everything under test is byte manipulation, and the parts
that need a canvas are checked by source guard instead.

- **A** — the image half: SOI magic, the image bytes in front of the archive
  byte-for-byte unchanged, EOI exactly where the archive starts.
- **B** — the archive half: all three entries listed, `card.json` parses,
  newlines and tabs byte-exact, non-ASCII tags (`café`, `日本語`, an emoji)
  intact through UTF-8.
- **C** — the offsets. Every recorded local-header offset lands on a real
  local-header signature within the whole file; the naive build is asserted to
  **fail**; and `prefixLen: 0` still produces an ordinary standalone ZIP.
- **D** — both storage methods round-trip, plus an empty entry, plus CRC-32
  against the standard check value for `123456789` (`0xCBF43926`) since that
  routine is shared with the PNG chunk writer.
- **E** — the import path, including that an archive without `card.json` is
  rejected by name rather than importing an empty character, and that an
  ordinary JPEG reports no EOCD.
- **F** — wiring, including that the V3 PNG export still exists, still has its
  own button, and still writes both the `ccv3` and `chara` chunks. This is an
  additional option, not a replacement, and the test says so.

One test premise was wrong on the first run and worth recording: the
"incompressible" fixture was `(i * 2654435761) >>> 24`, which has a short
period that deflate eats, so the stored-entry assertion was quietly testing
nothing. It is an xorshift stream now, which deflate grows from 2048 to 2053
bytes.

## Not changed

Version strings still say 1.7.3 — items 8 and 12. The V3 PNG export is
untouched and remains the default for sharing anywhere that does not mangle
uploads.
