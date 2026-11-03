# Investigation — the share export should be a ZIP, not a JPG

You were right, and I built the wrong thing. This is what the evidence says,
why the choice I made is specifically the worst one for Discord, and what to do
instead.

## What Discord actually does

Discord has never documented this, so everything below is third-party
observation — but the reports converge, and Discord's own public statement is
the important one.

Asked about EXIF handling, Discord's account said they strip some data and
**"run the images through our resizing player"**.

That phrase is the whole problem. *Resizing* means *re-encoding*, and
re-encoding rebuilds the file from decoded pixels. Anything that is not pixel
data — a PNG `tEXt` chunk, EXIF, or **a ZIP archive appended after the
end-of-image marker** — does not survive being rebuilt. It is not stripped by a
rule that could be worked around; it simply never gets copied into the new
file.

Three things follow, and they line up with what your users are reporting:

| upload path | what happens |
|---|---|
| **Image uploaded inline** (drag-drop, paste, image picker) | goes through the resizing pipeline; trailing data gone |
| **JPEG specifically** | the most aggressively processed of the image types |
| **File attachment** (paperclip / "send as file", non-image extension) | reported preserved **byte-for-byte** |

There is also a nuance worth knowing: PNG is processed *less consistently* than
JPEG. So the original premise behind this feature — "Discord strips metadata,
so PNG cards don't survive" — is only partly right. PNG cards survive more
often than JPEGs do.

## So my implementation picked the worst possible option

I built a **JPG with a ZIP appended**, on the reasoning that it would render
inline in the channel and still carry the card.

Both halves of that are wrong in the same way. Rendering inline *is* the
re-encode path. The property I was optimising for is the exact mechanism that
destroys the payload — and I chose JPEG, which gets the heaviest processing of
any format Discord handles.

A `.jpg` polyglot on Discord is therefore close to a guaranteed loss. It works
perfectly off disk, over LAN, through email, and on anything that treats an
upload as a file. It loses on the one platform the feature is named after.

## The proposal: a real `.zip`

Not a polyglot renamed. A plain, ordinary ZIP archive:

```
archivist.zip
├── card.json        Character Card V3
├── card_v2.json     the same card in V2, for apps that only speak V2
├── assets/icon.jpg  the portrait, as a real file
└── README.txt       what this is and how to open it
```

Why this is better on every axis that matters:

- **It is not an image**, so no preview pipeline touches it. It goes down the
  file-attachment path, which is the one reported to survive byte-for-byte.
- **The portrait is inside the archive**, so opening the zip shows the
  character. On the polyglot the picture was outside the entries — a "zip" that
  appeared to contain no image even though the image was sitting right there in
  the bytes.
- **It is already the `.charx` layout**, so renaming it to `.charx` imports it
  into any V3-aware app. That was true before and stays true.
- **It is smaller.** The portrait is stored once and deflated, instead of once
  raw as the prefix. On a test card: 6.5 KB versus 11.9 KB.

### It needs no import changes

Verified against the current tree, not assumed. A plain zip with the portrait
inside it imports today:

```
plain zip: 6581 bytes (portrait 9463 inside it)
starts with PK: true
imports today?  name: Archivist | avatar found: yes
```

The dispatcher already looks for a ZIP end-of-central-directory on any file it
does not otherwise recognise, and `_readCardFromCharx` already looks for
`assets/*icon*` as the avatar. Both were written for `.charx` and both do the
right thing here. **The change is confined to the export.**

### What it costs

The card no longer shows up as a picture in the channel. That is a real loss —
card sharing is visual, and a grey file card is less inviting than a portrait.

The honest trade is: post the `.png` export *as well* if you want the channel
to show the character, and the `.zip` for the thing that actually imports. The
README inside the zip can say so, and the button tooltip can too.

I do **not** think keeping the JPEG prefix is worth it. Its only remaining
benefit would be "rename to .jpg and it is a picture again", which is a worse
version of "the picture is a file inside the zip", and it costs the size and
the confusion that started this thread.

## What I would change

1. `exportCardForDiscord` → build a plain archive with `prefixLen` 0, add
   `assets/icon.jpg` as an entry, download as `application/zip` with a `.zip`
   name. Rename the function to match what it does.
2. Rewrite `README.txt` inside the archive for the new shape, including the
   "post the .png too if you want a preview" note.
3. Button label and tooltip: say it is a zip, and say why.
4. Tests: `test-card-share-export.mjs` currently asserts the polyglot layout —
   section A is about the JPEG half and would be replaced with assertions that
   the archive is plain, the portrait is an entry, and the whole thing still
   round-trips.
5. Keep `_zipArchiveBytes`' prefix support. It costs nothing, it is tested, and
   it is the only reason a `.charx` with a prefix would still read.

## Open question for you

Should the `.jpg` polyglot stay as a *second* option for places that do not
re-encode, or be removed entirely?

My recommendation is remove it. Two export buttons already cover the ground —
`.png` for "looks like a character card everywhere" and `.zip` for "survives
anything" — and a third that works on some platforms and silently fails on the
most popular one is a support burden rather than a feature.
