# 1.7.4 — ABOUT trimmed; share-export investigated

Two reported bugs. The first is done. The second I could not reproduce, so
this records exactly what was checked, and fixes something real that turned up
while checking.

## 1. ABOUT: three rows culled to one

The block showed **Version**, **Page** and **Server**. On a healthy install:

```
Version   1.7.4
Page      1.7.4
Server    1.7.4-go-nogit.20260917
```

Two rows restating the third, and the third adding only build metadata after a
dash. Three lines to say one number.

It is one line now. The `Page` and `Server` rows are gone, and there is a test
naming them so they cannot creep back.

**What I kept, and why you should know I did.** The page-versus-server pair
answers a real question — whether the browser is running the frontend the
server thinks it is — and that caught the stale-binary problem two steps ago.
It has not gone; it moved to the warning, which stays **hidden while the two
agree**. So it costs nothing on the install where it has nothing to report, and
still says this when it does:

> This page is from 1.7.3 but the server binary is older (1.7.2). The web files
> were updated without replacing the gobbonet binary beside them…

COPY BUILD INFO still carries both numbers, plus mode, engine reachability,
storage and sync target. That is a bug report, not screen space.

If you would rather the warning went too, it is one block to delete — but it is
the half that was doing something.

## 2. Share export: could not reproduce "backwards"

I rebuilt a FOR SHARING export with a real avatar, using the real functions,
and checked every direction the word could mean.

| checked | result |
|---|---|
| Byte order | `FF D8 FF E0` at byte 0; EOI at 10925; first `PK\03\04` at 10927. **JPEG first, archive at the tail.** |
| `file(1)` | `JPEG image data, JFIF standard 1.01` |
| Renders as a picture | PIL opens it, 342×512 RGB, correct pixels |
| `unzip -t` | `No errors detected` |
| Renamed to `.zip` | opens, all three entries |
| ZIP internals | local-header order matches central-directory order |
| Import round trip | `card.json` back intact, avatar taken from the image in front of the archive |
| Button wiring | `EXPORT V3` → `exportCardAsV3` → `.png`; `FOR SHARING` → `exportCardForDiscord` → `.jpg` |

Nothing is reversed in the mechanism. Which means "backwards" is something I
have not thought of, and guessing further would waste your time — see the
questions at the end.

## What the investigation did turn up

The format's documented limit is that a platform which **re-encodes** the image
takes the archive with it. That is unavoidable. What is not unavoidable is what
the importer says when it happens.

A `.jpg` with its archive stripped had no branch of its own. It fell through to
the text branch, got decoded as UTF-8, and the user was told:

```
Embedded card data is not valid JSON.
```

A message about JSON, for a picture. It says nothing about what happened, and
nothing about the fix — which is on the **sending** end, not the importing one.
Someone on the receiving end could try that file all afternoon.

An image with no card in it now gets its own message:

> This image has no character card inside it.
>
> If it was shared through a chat app, the app re-encoded the picture and
> stripped the card out with it. Ask the sender to attach the original file and
> download it with the app's download button — copying or saving the preview
> image gives you the re-encoded copy, which is this.
>
> A .png card export survives some places a .jpg does not, so it is worth
> trying that too.

Checked **before** the text branch, or it gets the JSON message anyway; there
is an assertion on that ordering specifically.

`tests/test-card-share-export.mjs` grows from 46 to 54 assertions, including
constructing a stripped file the way a re-encode leaves one. Verified to bite:
removing the branch loses 5.

## What would pin down "backwards" fastest

1. Which direction — does the **export** produce something wrong, or does
   **importing** one produce something wrong?
2. If export: what does the downloaded `.jpg` do — render as a picture, open as
   an archive, both, neither?
3. If import: what is the exact error, or what does the imported card get wrong?
4. Where did the file travel? Posted to Discord and downloaded again, or
   straight off disk?
5. If it went through Discord — was it saved with the **download button**, or
   right-click → save/copy on the preview? Those give different bytes, and only
   the first keeps the archive.
