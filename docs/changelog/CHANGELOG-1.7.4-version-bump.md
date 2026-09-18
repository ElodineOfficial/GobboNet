# 1.7.4 — Version bump, and the stale binary it exposed

Roadmap item 12, *"Update all internal version strings"* — plus a fix for the
`Server: unknown` report that prompted it, which turned out to be the visible
edge of something considerably worse.

## The version bump

`VERSION` → **1.7.4**, and `GOBBONET_UI_VERSION` in `js/01-config.js` with it.

That is the entire list, and it is worth stating plainly because it sounds too
short. Everything else already derives:

- `build-release.sh`, `installer/build-installer.sh`, `installer-linux/build-deb.sh`
  and `installer-fedora/build-rpm.sh` all read `VERSION`.
- The binary is stamped at link time via `-ldflags -X …version.Version`.
- `gobbonet version`, the startup banner and `/health-fileserver` all report
  that stamp.

A grep for `1.7.3` across every `.go`, `.js`, `.html`, `.sh`, `.bat`, `.py`,
`.toml` and `.ini` in the tree now returns nothing. The remaining mentions are
in changelogs and in prose describing what 1.7.3 *did* ("before 1.7.3 this was
easy to hit"), which are statements about the past and were left alone.

`tests/test-version-stamp.mjs` — added in item 8 for exactly this moment —
passed after both were changed, and fails if only one is.

One rename: `docs/BUILDING-1.7.3.md` → **`docs/BUILDING.md`**. A build guide
whose *filename* carries a version is wrong from the next release onward. Same
disease as the frontend stamp that sat at `1.6.0-no-encoded-payload` through
the whole of 1.7.x; `VERSION` is the one place a release number belongs.

## The `Server: unknown` report, and what was under it

The reported symptom was ABOUT showing `Server — unknown`. Chasing it turned up
two separate faults.

### 1. The shipped binary was never rebuilt

`linux-amd64/gobbonet` in the handover zip was still the **original 1.7.3
binary**. Every frontend change reached the tester; no Go change ever did.

```
$ linux-amd64/gobbonet version
1.7.3-go-nogit.20260908

$ curl localhost:PORT/ui-defaults.json   →  404      # item 10's server half
$ curl localhost:PORT/state/profiles     →  404      # item 4's server half
```

That is bad on its own and worse in how it fails. Both of those degrade
*quietly* by design — `fetchSyncProfiles` returns `[]` on a non-OK response, so
the panel reads "Nothing stored on the server yet" rather than erroring. And an
old server ignores an unrecognised `?profile=` query string, so pointing a
device at a separate profile would have written to the shared `state.json`
anyway: **the phone and the desktop would have gone on sharing one history
while the UI said they were separated.** Items 4 and 10 could not have been
meaningfully tested, and item 4 would have looked like it worked.

The binary is rebuilt from the current tree and stamped
`1.7.4-go-nogit.20260916`, following `build-release.sh`'s own convention
(`<VERSION>-go-<sha>`, with the `nogit.<date>` fallback the previous build
used).

It is built `CGO_ENABLED=0 -trimpath -ldflags "-s -w …"`, matching
`build-release.sh` exactly. The binary that shipped was **dynamically linked**;
this one is static, so it does not depend on the glibc of whatever machine
built it. Verified live: `/health-fileserver`, `/ui-defaults.json`,
`/state/profiles`, separate profile files on disk, and a path-traversal
attempt still refused with a 400.

### 2. ABOUT gave one message for two opposite faults

`unknown` was a dead word. It could mean the server answered without a version,
or that nothing GobboNet-shaped answered at all — which is what serving these
files from a plain static file server produces, and it means half the app is
not running. That now says so: **"no GobboNet server answered here"**.

More importantly, the mismatch warning assumed one direction. It always said
*your browser is holding a cached copy — hard-refresh*.

For the fault that actually existed, that advice was **exactly backwards**. The
page was newer than the server, and no amount of cache-clearing would have
helped. So the warning reads the direction now:

| | |
|---|---|
| Server **ahead of** page | Cached frontend. Hard-refresh. |
| Page **ahead of** server | The web files were updated without replacing the binary beside them. Sync profiles, config presets and model swapping may be missing or silently do nothing. Re-run the installer or rebuild. *Clearing your cache will not help here.* |

Comparison is on the release triple, so `1.7.4-go-deadbee` and `1.7.4` are not
a mismatch — only the release number differing is. A `dev` build is never
flagged.

This is the more valuable half of the fix. The binary being stale was one
mistake on one handover; a warning that sends the reader in the wrong direction
would have cost time on every future one.

## What pins it

`tests/test-version-stamp.mjs`, now **49 assertions**. Both directions of the
mismatch are covered, along with same-release-different-sha not being flagged,
and "no GobboNet server answered" appearing in both the panel and the pasted
block. Verified to bite: removing the page-ahead-of-server branch loses 3
assertions.

Section C no longer hardcodes `1.7.3` — it builds its expectations from the
`VERSION` file. A test carrying a release literal is the same disease this file
exists to prevent, and it failed on this very bump, which is how it got
noticed.

## Not changed

`LINUX-START-HERE.md`, `installer-linux/README.md` and
`installer-linux/FIX-1.7.3-REVISION-2.md` still name 1.7.3 `.deb` files. Those
describe packages that were actually built and shipped; bumping the text to
1.7.4 would point at files that do not exist yet. **Item 13 produces the
1.7.4 exe/deb/rpm and owns those documents.**
