# 1.7.4 — The share export is a ZIP, and is called Export for Discord

Replaces the polyglot built for roadmap items 3 and 7. Background and evidence
in [`docs/INVESTIGATION-share-export-format.md`](../INVESTIGATION-share-export-format.md).

## What was wrong

The old export was a `.jpg` with a complete ZIP appended after the
end-of-image marker: a real picture that rendered inline in the channel and
still carried the card.

Rendering inline **is** the re-encode path. Discord's own description of what
it does to an uploaded image is that it runs it *"through our resizing
player"*, and resizing rebuilds the file from decoded pixels — at which point
anything that is not pixel data is not copied across. Not a PNG `tEXt` chunk,
not EXIF, and not an archive glued to the end.

So the property the polyglot was optimising for was the exact mechanism that
destroyed its payload. And it used JPEG, which gets the heaviest processing of
any image type — reports are consistent that PNG is handled less aggressively,
which means the polyglot was *worse on Discord than the PNG export it was meant
to improve on*. It worked perfectly off disk, over LAN and through email, and
lost on the one platform it was named after.

The reported symptom was "export as zip with JPG working backwards", which was
exactly right: the deliverable should have been a zip.

## What it is now

An ordinary ZIP. Not a polyglot renamed — a plain archive with no prefix.

```
archivist.zip
├── card.json        Character Card V3
├── card_v2.json     the same card in V2, for apps that only speak V2
├── assets/icon.jpg  the portrait, as a real entry
└── README.txt
```

- **Not an image**, so no preview pipeline touches it and it travels as a file
  attachment — the path reported to arrive byte-for-byte intact.
- **The portrait is inside**, so opening the zip shows the character. On the
  polyglot the picture sat *outside* the entries, so a "zip" appeared to
  contain no image while the image was right there in the bytes.
- **Still the `.charx` layout**, so renaming imports into any V3-aware app.
  `assets/icon.jpg` is where that spec puts a portrait, which is also why the
  importer finds it with no special case.
- **Smaller**: 7.1 KB against 11.9 KB for the same card, because the portrait
  is stored once and deflated instead of once raw as a prefix.

The button is **EXPORT FOR DISCORD** rather than FOR SHARING, since it is one
specific kind of sharing and the tooltip can then say the thing that decides
whether it works: post it as a **file**, not as an image.

### The cost, stated plainly

The card no longer appears as a picture in the channel. There is no way around
that — being a picture and surviving are the same question with opposite
answers. The README inside the archive and the button tooltip both say to post
the `.png` export alongside if the channel should show the character.

## Import needed no changes

Verified rather than assumed. The dispatcher already looks for a ZIP
end-of-central-directory on any file it does not otherwise recognise, and
`_readCardFromCharx` already looks for `assets/*icon*` as the avatar — both
written for `.charx`, both correct here.

One thing did need adding: **`.zip` in the import picker's `accept` list**.
Without it the file cannot be selected at all. That was missed once already
when `.jpg` was added, so there is now an assertion on it.

## Files already shared still import

`_readCardFromZipTail` still takes the avatar from image bytes in front of an
archive, and `_zipArchiveBytes` still accepts a prefix length. Nothing writes
a prefixed archive any more — the export passes 0 — but anyone who shared a
`.jpg` from an earlier build has files in the wild, and they still open.

Removing the write side would not help them, and would cost the tests that
document how the biased offsets work.

## What pins it

`tests/test-card-share-export.mjs`, **65 assertions**, up from 54.

Section A is new and covers the new shape: starts with a local file header,
sniffs as no kind of image (which is what keeps it off the re-encode path), the
portrait is an entry that comes back out byte-identical, and the charx reader
finds it without being told.

Section A2 is the old section A, kept deliberately, because the prefixed layout
is still *read*.

Verified to bite: downloading as `.jpg` again loses 2 assertions, dropping the
portrait entry loses 1, removing `.zip` from the picker loses 1.

One harness note. `_readCardFromCharx` thumbnails the avatar through a canvas,
which the test context does not have, so the failure was swallowed by its
try/catch and "the portrait was found" looked identical to "there was no
portrait". The thumbnailer is stubbed now, which is what lets section A tell
those apart while section E still checks the genuinely-absent case.
