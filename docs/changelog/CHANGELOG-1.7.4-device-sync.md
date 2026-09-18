# 1.7.4 — Phone and computer stop sharing a history unless you want them to

Roadmap item 4: *"Better DB management between separation of phone and
computer [make sharing between the two optional]"*.

## Why they were joined

They were joined because there was exactly one file.

`/state` read and wrote `state.json`, and every browser that opened the page
pushed to it and restored from it. That was never a decision about how devices
should relate to each other — it was the simplest thing that solved the problem
sync was built for, which is worth restating because it is still a real
problem: each LAN IP is a separate browser origin, so when the PC's DHCP lease
rotates, the phone arrives at a new address with an empty localStorage and its
chats apparently gone.

The fix for that shouldn't also mean the phone and the desktop are one
conversation. Now it doesn't have to.

## Three targets

A device picks one, and the choice is that browser's alone.

| | What it does |
|---|---|
| **Shared** | The single shared `state.json`. **The default**, and exactly what every existing install already does. |
| **Separate profile** | `state-<name>.json` beside it. A separate history that still gets the safety net — a rotated IP still hands *your own* chats back. |
| **Off** | No network at all. Fully local, and the only mode where nothing about this device reaches the server. |

The middle one is the interesting option and the reason this isn't just an
on/off switch. Turning sync off does separate the devices, but it throws away
the thing sync exists for. A profile keeps both.

Set under **DATA → DEVICE SYNC**, which also lists what is actually on the
server, with sizes and ages, and lets you delete a backup.

## Server

`internal/state/state.go`. Every route takes an optional `?profile=`:

```
GET    /state/info?profile=phone     metadata for one target
GET    /state?profile=phone          the body
POST   /state?profile=phone          store
DELETE /state?profile=phone          remove
GET    /state/profiles               what exists
```

**No parameter is the old behaviour, byte for byte.** Every install in the
field and every client written before profiles existed sends `/state` bare, and
that still lands on `state.json` under its existing name. An empty
`?profile=` is treated as absent too, so a client building its URL by string
concatenation can't accidentally fork the file.

### The name is an untrusted string on a path

`^[a-z0-9][a-z0-9_-]{0,31}$`, and nothing else. No dot means no `..`; no
slash or backslash means no escaping the data directory; 32 characters keeps
the result inside every path limit. There's also a post-`Join` check that the
resolved path is still in the data directory — redundant today, but it turns a
future loosening of the pattern into a failed request rather than a write
somewhere it shouldn't be.

Names fold to lower case, so `Phone` and `phone` can't be two profiles on Linux
and one on Windows and macOS — which would look like data loss the first time
someone moved a backup between machines.

**An unrecognised name is a 400, never a fall back to the shared file.**
Quietly writing one device's history into the slot the user separated is the
one unrecoverable outcome in this feature, and a typo in a query string is not
worth that risk.

Windows reserved device names (`CON`, `NUL`, `COM1`) survive the pattern and
are harmless: the file is `state-con.json`, whose stem is `state-con`, not
`con`. That safety comes from the prefix, so the prefix isn't cosmetic.

## Client

`js/06-state-sync.js` owns the target; `js/21-data.js` only renders it.

### The choice is not in `state.settings`

This is the part that would have been a silent, confusing bug. Settings are
part of the payload that gets synced, and a restore overwrites them. If the
target lived there, a phone that pulled the desktop's backup would inherit the
desktop's target and **silently re-join the two histories** — the separation
undone by the act of restoring, with nothing on screen to explain it. The
target lives in its own localStorage key, for the same reason the sync metadata
already does.

### `lastKnownMtime` is per target

It answers "has anything written to *my* file since I last looked", and every
decision in `checkServerStateOnBoot` hangs off that answer. One number carried
across a switch compares two unrelated clocks, and the boot check would then
either skip a restore it owed the user or offer one it didn't. It's a map now,
keyed by target, with the old bare value adopted by the shared target on
upgrade (it can only ever have described `state.json`) and mirrored back at the
top level so a downgrade still finds it.

### Switching asks a direct question

Boot-time conflict resolution is tuned for "I just opened the page and
something may have changed while I was away", and is deliberately conservative
— it will keep local and re-publish when the server copy is much smaller, on
the grounds that a tiny newer snapshot is usually a mid-flight one.

Reusing that here would be quietly destructive. Pointing a device at a profile
is not an ambiguous event that needs guessing at: the user has just said which
pile of data they mean. So the switch asks directly, and there are only two
sensible answers — take what's in the slot, or put this device's data into it.
An empty slot is seeded with no question, because nothing can be lost.

### Off means off

Every network path goes through one `syncEnabled()` gate rather than a
condition repeated in a dozen places where one could be forgotten. Switching
off makes no request at all — least of all a delete. *Stop syncing* is not
*destroy the backup*.

Two smaller honesty fixes fell out of that. The `quota` status reads "backed up
to server (click to restore full history)", which on an off device is a
straight lie at the worst possible moment; it's gated now. And clicking the
sync indicator while off used to offer a restore that would only produce a
"sync is off" alert — it opens the DATA panel instead, where the switch
actually is.

## What pins it

**`internal/server/state_profiles_test.go`** — 8 tests through the real server,
so routing is covered too. That's where the original `/state/info` regression
lived: the handler was right and the route swallowed it.

The one that matters most is `TestStateDefaultPathUnchanged`. The rest cover
separate files that don't disturb each other, the allowlist against 17 hostile
names (with an assertion that *nothing was written anywhere* as a side effect,
including outside the data directory), listing, per-profile `/state/info`, and
delete.

**`tests/test-sync-targets.mjs`** — 100 assertions driving the real client
against a fake `localStorage` and a fake `fetch`, so the URLs asserted on are
the URLs the browser would actually request. Section A is about nothing except
the default not moving: absent, malformed, `null`, a bare string, an unknown
mode, and a profile mode with an illegal name all have to land on shared.

Four guarantees were verified to fail without their fix:

| Reverted | Assertions lost |
|---|---|
| Default resolves to a profile instead of shared | 12 |
| `syncEnabled()` ignores the off state | 2 |
| Target persisted into `state.settings` | 1 |
| Switch doesn't re-adopt the target's mtime | 2 |

Two things the tests caught that review had not:

- The profile listing filter used "did trimming change the string?" to detect
  the `state-` prefix. `TrimPrefix` is a no-op when the prefix is absent, so
  `state.json` was listed as a profile called `state`, and
  `notstate-phone.json` as `notstate-phone`. It checks prefix and suffix
  explicitly now.
- `persistSyncMeta` wrote an `off` key into the per-target mtime map. Harmless,
  but `off` is not a file and has no mtime worth remembering.

One test premise was wrong and is worth recording: section F originally
asserted on `lastKnownMtime` right after a switch, which races with the push
that switch triggers — a successful push legitimately updates that value. The
two are separate behaviours and are separated now, with the fake server
omitting `mtime` from its response (a shape the client already tolerates).

## Not changed

Version strings still say 1.7.3 — items 8 and 12.

Nothing about the existing sync behaviour moves for a device that doesn't touch
the setting: same file, same URL, same boot decisions, same conflict prompt.
The prompt now names which backup it's talking about, since there can be more
than one.
