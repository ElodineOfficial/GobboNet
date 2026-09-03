# v1.7 tier 2 — items 5 and 6

Round 3. Tier 1 items 1–4 are in the tree and untouched. Line numbers are
against that tree (`ca7b3b9` in the local review repo).

Two commits, one per roadmap item, exported to `patches/`:

| Patch | Item | Files | Net |
|---|---|---|---|
| `0001-…` | 5 — installer password rejected by the browser | 1 | +102 / −2 |
| `0002-…` | 6 — optional streaming toggle | 5 | +77 / −3 |

Both items departed from the roadmap's suggested implementation. Both
departures are explained below, and both were forced by something in the
code rather than by preference.

---

## Item 5 — password set in the installer is rejected by the browser

The diagnosis is exactly right, and the mechanism checks out at the cited
lines. `fileserver.ps1:217-223` parses `GEMMA_ACCESS_SECRET` once into
`$AccessSalt` / `$AccessHash` at startup, and `Get-PasswordHash` closes over
`$AccessSalt`. Nothing re-reads it. A server still running from before the
password change is permanently hashing against the old salt.

That is the whole reason the obvious remedies fail. Deleting
`.gobbonet-secret`, uninstalling, reinstalling, adding antivirus exceptions —
every one of them touches **disk**, and none of them touches a running
**process**. Only ending that process does, which is why a reboot "fixes" it
and why the bug reads as haunted.

### Changes

**`launch.bat:242`** — set `SECRET_JUST_SET` when `:setup_password` actually
runs. Cleared first, because `setlocal` inherits the calling window's
environment and a value left over from an earlier run in the same `cmd`
session would make a no-change run look like a password change. This also
covers `launch.bat reset-password`, which deletes the secret file and so
triggers the same path — correctly, since reset-password is the clearest case
of all for refusing to adopt.

**`launch.bat:1840`** — the adoption branch declines to adopt when a password
was written this run, and falls through to the port-holder check that names
the PID.

**`launch.bat:1889`** — a hard stop for the password case, placed after
holder detection so the PID is still reported.

### Two departures, both to avoid regressions

**1. Gated on `PW_PORT_CONFLICT`, not `SECRET_JUST_SET` alone.**

The roadmap says to refuse adoption "when that flag is set". Implemented
literally, that **breaks first install**. A first install also writes a new
password, so `SECRET_JUST_SET` is set — but the port is free, so the probe
fails and control jumps forward to exactly the branch that refuses to
continue. The app would never start on a clean machine.

So the refusal keys off the *combination*: a password was written **and** the
probe found something already on the port. I did not catch this by reading
it; the flow simulator caught it, which is why that harness is shipped.

**2. A hard stop, not the generic "Try to start anyway?" prompt.**

Falling through into the existing prompt looks right and isn't, because
answering "yes" cannot help. A second `fileserver.ps1` fails to bind a port
that is already held and exits. The `:fserver_wait` probe loop below would
then get its 401 from the **old** server, print
`[OK] File server on :<port>`, and hand the user straight back into the
wrong-password loop — with one extra dead PowerShell for company. Offering a
choice whose only outcome is the original bug is worse than not offering it.

The stop is deliberately **not** gated on `PORT_HOLDER` resolving. That lookup
needs PowerShell and `Get-NetTCPConnection`; when either is unavailable
`PORT_HOLDER` is empty, but the probe has already proved something is there,
so the advice stands with or without a PID.

### Verification

`test-launch-flow.py` parses the edited region of `launch.bat` and interprets
the real `if defined` / `if errorlevel` / `goto` lines rather than asserting
on text, so a control-flow regression shows up as the wrong terminal state.

| Scenario | Result |
|---|---|
| First install (new password, free port) | starts normally |
| Normal relaunch, server already running | **adopts** — unchanged |
| Normal relaunch, nothing running | starts normally |
| **New password + orphan holding the port** | **names the PID, stops** |
| New password + orphan, holder unresolvable | stops, generic advice |
| `reset-password` with a free port | starts normally |
| No password change, port held by a non-HTTP listener | existing prompt, unchanged |

The roadmap flags the already-running-and-unchanged path as the regression
risk. That is row 2, and it still adopts.

Structural checks after the edit: block depth balances to 0, no unresolved
`goto` targets, no duplicate labels, CRLF preserved throughout, and no new
`::` comment inside a `( )` block (see below for why that last one matters).

---

## Item 6 — optional streaming toggle

Setting `streamReplies`, default `true`. The config panel entry sits directly
beneath Avatar Size and above everything else, as specified — verified by
parsing the rendered panel order:

```
1. Avatar Size
2. Reply Delivery      <-- new
3. Search API Key
4. Performance …
```

### The departure: this gates painting, not the request

The roadmap calls for threading a flag through the two chat call sites and
adding a non-streaming branch that reuses the parser on a complete body. I
did not do that, because **it would silently break the smart reply limit.**

`maybeApplySmartLimit` (`js/03-generation.js:164`) calls `stopGeneration()`
the instant the running estimate crosses the cap — it works by cancelling
generation mid-stream. And the chat request body sends **`max_tokens: -1`**
(`js/10-chat.js:166`, `:779`). So mid-stream cancellation is the *only* thing
bounding reply length in the chat path.

Send `stream: false` and there is no mid-stream to stop. The model runs to
EOS or fills the context, and the user waits — potentially for minutes — for a
long reply that then gets trimmed after the fact. A user who ticked a box
labelled "don't stream" would have quietly lost their reply-length cap.

Two smaller dependencies point the same way: the ~2.5 s partial `saveState`
tick and the server-side job spool both need bytes as they land, and they are
what make a reply survive a navigation or a Stop.

Meanwhile the thing actually being asked for — not *watching* the reply get
written, so a story beat isn't spoiled — is entirely a rendering concern.

So: keep the bytes, hold the brush. The transport streams in both modes; the
painter is gated. Output is byte-identical either way, because held mode ends
with the same `finalizeStreamMessage` → `renderStreamingUpdate` the streaming
path uses, so a thinking model's reasoning is split from its content by
exactly the same parser. Only the timing of the reveal differs.

A side benefit of stopping at the render layer: because tokens still arrive,
the existing typing dots and the live `⏱` timer keep working, so a held reply
looks like it's being written rather than looking frozen. Stop still works,
and stopping mid-reply still keeps what arrived.

### Changes

| File | What |
|---|---|
| `js/04-state.js:153` | `streamReplies: true` default |
| `chat.html` | Reply Delivery block, directly beneath Avatar Size |
| `js/15-cards.js:28,46` | load / save |
| `js/03-generation.js:285` | `shouldPaintWhileStreaming()` |
| `js/03-generation.js:302` | resolved **once per generation** |
| `js/03-generation.js:330,338` | the two in-stream repaints, gated |
| `js/13-dashboard.js:336` | typing dots persist for a held reply |

Two details worth knowing:

**The mode is resolved once per generation, not per chunk.** Flipping the
toggle mid-reply would otherwise reveal a half-written message — the exact
spoiler the setting exists to prevent. Whatever the setting was when the turn
started is what that turn honours.

**`js/13-dashboard.js:336` is not cosmetic.** `renderStreamingUpdate` is
gated, but a full `renderMessages()` is not, and it rebuilds from state —
which holds the partial text. Without this, switching to another thread and
back mid-reply would reveal the held reply. `isGenerating` is already `false`
by the time the post-generation `renderMessages()` runs, so the finished reply
still lands normally.

The setting reads `!== false` in all three places, so a settings blob saved
before this option existed streams exactly as it always has.

**Lore compression is untouched** and still streams, as instructed — it uses
its own reader loop in `07-prompt.js`, not `makeStreamFeeder`, so the gate
cannot reach it. Confirmed by grep, not by assumption.

### Verification

`test-stream-toggle.mjs` loads the real `js/03-generation.js` and counts
paints. **18 assertions, all passing.**

| # | Scenario | Result |
|---|---|---|
| 1 | Streaming on (default) | paints during the reply |
| 2 | Streaming off | **zero paints**, identical text captured |
| 3 | Thinking model, held | reasoning held too — no COT spoiler |
| 4 | **Smart limit while held** | still fires, still stops generation mid-reply |
| 5 | Held mode | partial `saveState` still ticks — recovery intact |
| 6 | `undefined` / missing settings / `true` | all stream; only explicit `false` holds |

Test 4 is the one that ruled out the roadmap's approach.

---

## Not done, and why: the `::`-in-a-block fix

The roadmap mentions PR #24 also fixes "a `::` comment inside a `( )` block"
behind the issue #17 drive-letter spam, and suggests splitting it out. I
looked, and it is bigger and sharper than a one-liner.

**There are 53 of them, not one.** A line-oriented block scan (ignoring parens
inside comments and `echo` text; the file balances to depth 0, so the scan is
trustworthy) finds 53 `::` / `rem` comments sitting inside open `( )` blocks.

**The best candidate for the *spam* specifically is `launch.bat:2401-2402`,**
inside `if defined HAVE_CURL (` in the `:http_alive` subroutine. That
subroutine is called from the health-monitor loop, so anything it prints
repeats — which fits "spam" in a way the once-per-launch sites don't.

**But the obvious fix is a trap.** Line 2401 reads:

```
    :: -f makes curl fail on any status >= 400 instead of quietly saving the
```

Mechanically rewriting `::` → `rem` turns that `>=` into a **redirection**,
creating a file called `=` and a brand-new bug. Any conversion pass has to
either move these comments outside their blocks or rewrite the text to avoid
`>`, `<` and `|`.

I have no Windows `cmd` here to confirm which of the 53 actually fire, and the
exact triggering conditions for `::`-in-a-block are narrower than "all of
them". Guessing at that and rewriting 53 sites in a 2,428-line batch file you
cannot easily test is exactly the kind of change that should not ride along
with something else. It wants its own item, its own commit, and one run on a
real machine — but the analysis above should make it cheap when you get to it.

---

## What still needs a human at a real machine

**Item 5** cannot be fully verified without Windows. The simulator proves the
control flow; it does not prove `cmd` parses the new lines as intended. The
sequence worth running:

1. Fresh install on a clean folder → sets a password, starts normally.
2. Close the launcher window (leaving the file server orphaned), then
   `launch.bat reset-password`, set a *different* password → should name the
   PID and stop, **not** report `[OK] File server already running`.
3. End that PID, run `launch.bat` → normal start, new password works.
4. Plain `launch.bat` twice in a row with a server up → second run must still
   print `[OK] File server already running` and not spawn a duplicate.

Step 4 is the regression check.

**Item 6** wants a look with a thinking model specifically. The held path ends
by triggering the COT block's first appearance and the content transition in
the same repaint, which is a code path the streaming mode reaches gradually
and held mode reaches all at once. It should be identical — the parser and the
painter are the same — but it is worth one real reply to confirm the COT block
renders collapsed and correct rather than flashing.
