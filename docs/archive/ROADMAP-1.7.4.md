# Roadmap — v1.7.4

The working list for the 1.7.4 cycle, as handed over. Items are worked one at a
time and confirmed by testing before the next one starts, so the status column
is the authority on what is actually done — not the fact that a line exists.

Each completed item gets a `docs/changelog/CHANGELOG-1.7.4-*.md` entry in the
usual house style: what broke, why it broke, what changed, and what pins it.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Copying code removes linebreaks | **done — awaiting confirmation** | Fenced blocks were already safe. The hole was fences the scanner *declined* (4+ space indent, blockquoted), which fell through to the paragraph pass where `\n -> <br>` runs. See `CHANGELOG-1.7.4-code-copy-linebreaks.md`. |
| 2 | Better sticky cards | **done — awaiting confirmation** | Confirmation *and* notice: they answer different situations. Sticky is now a setting (`stickyCards`, default on) governing casual dismissal; a separate unsaved-changes guard governs destruction and is not optional. Closed the hole where Cancel discarded silently. See `CHANGELOG-1.7.4-sticky-cards.md`. |
| 3 | Export in formats other than images | **done — awaiting confirmation** | Closed together with #7 — they are the same item. New FOR SHARING export: a JPG with a complete ZIP archive appended. See `CHANGELOG-1.7.4-share-export.md`. |
| 4 | Separate phone and computer DB management | **done — awaiting confirmation** | They shared a history because there was one file on the server. `?profile=` puts a second beside it. Three targets per device: shared (default, unchanged), a named profile, or off. See `CHANGELOG-1.7.4-device-sync.md`. |
| 5 | Make smart scrolling optional | **done — awaiting confirmation** | Three modes, not a checkbox: smart guesses wrong in two directions (holds on too long, lets go too easily). Turned up a real bug — finishing a reply while scrolled up dumped you at the top of the thread. See `CHANGELOG-1.7.4-scroll-modes.md`. |
| 6 | Stand-down / idle for backend processes | **done — awaiting confirmation** | Server-side, because the case that matters is the browser being *closed* and a shut tab cannot run a timer. In-flight requests are counted, not just timestamped — a six-minute generation looks exactly like an idle one. `idle_standdown_minutes`, default 5. See `CHANGELOG-1.7.4-idle-standdown.md`. |
| 7 | Character card export "For Discord Sharing" | **done — awaiting confirmation** | Same work as #3. The ZIP uses the `.charx` layout, so renaming the file to `.charx` also imports into other V3-aware apps. |
| 8 | About section carries the current version string | **done — awaiting confirmation** | Reports TWO numbers: the server's and the page's. They disagree when a browser is holding a cached frontend, which looks exactly like a regression. The page stamp was stale by two minor releases; a test now pins it to the VERSION file. Plus a COPY BUILD INFO button. See `CHANGELOG-1.7.4-about-version.md`. |
| 9 | Individual thread and character export | **done — awaiting confirmation** | ⇩ on every thread row, Save on every CAST card. A thread export carries the cast it was held with — including characters that appear only on a message — or it imports somewhere else and every turn renders as the wrong person. See `CHANGELOG-1.7.4-single-export.md`. |
| 10 | Config TOML file | **done — awaiting confirmation** | The server config already existed (25 keys, get/set/keys). The missing half was the browser's settings, which had no file at all — now a `[ui]` table that seeds them. No new dependency. Caught a real bug: `config set` was appending keys inside the new table. See `CHANGELOG-1.7.4-ui-presets.md`. |
| 11 | Fully editable lore | **done — awaiting confirmation** | Promoted from the user mod. The mod could not have seen the race: a compression pass `await`s a model for seconds, then writes lore back over anything typed meanwhile. `mergeLoreAfterPass` keeps both. See `CHANGELOG-1.7.4-lore-editing.md`. |
| 12 | Update all internal version strings | **done — awaiting confirmation** | `VERSION` → 1.7.4 and the frontend stamp with it; everything else already derived from `VERSION`. The shipped `linux-amd64/gobbonet` was rebuilt — it was still the original 1.7.3 binary, so the server halves of #4 and #10 were never running. See `CHANGELOG-1.7.4-version-bump.md`. |
| 13 | Produce exe, deb, rpm | **exe + deb done; rpm repaired, awaiting confirmation** | Fedora investigation found the rpm could not be built at all, and shipped without the setup wizard — hence "does nothing". Findings 1–3 fixed; a shared `payload.manifest` now stops the two Linux builders drifting. Finding 4 (missing dependencies) still open. See `INVESTIGATION-fedora-1.7.4.md` and `CHANGELOG-1.7.4-fedora-repair.md`. |

## Post-1.7.4 bug reports

| report | status |
|---|---|
| stand-down option missing from CONFIG | **done** — it hid itself in remote mode; an invisible feature is indistinguishable from one that was never built. Always visible now, disabled with a reason, and moved to the bottom of CONFIG |
| "why does the binary have to match?" | **done** — chasing it found worse: a 1.7.4 config stopped the 1.7.3 binary booting outright. Unknown keys are now classified, typos still fatal, newer keys warned and ignored. See `CHANGELOG-1.7.4-config-forward-compat.md` |
| ABOUT server info not earning its space | **done** — culled to one line; the page/server pair moved into the warning, which is hidden unless they disagree |
| "export as zip with JPG working backwards" | **done** — and the report was right. Rendering inline *is* the re-encode path, so the polyglot was self-defeating on the one platform it was named for. Now a plain `.zip`, button relabelled EXPORT FOR DISCORD. See `INVESTIGATION-share-export-format.md` and `CHANGELOG-1.7.4-share-export-zip.md` |
| "the zip can't just replace old files and work" | **done** — and it could not, for a blunter reason than expected: the archive had no Windows server in it at all, so the update path could never replace the server half. The frontend is now compiled into the binary, the zip is built by a script that refuses to ship a platform short, and `launch.bat` hands over to `gobbonet.exe`. See `INVESTIGATION-standdown-forward-compat.md` and `CHANGELOG-1.7.5-one-file-update.md` |
| "CMD visuals and loading is WILDLY FUCKED UP" | **done** — and not a rewrite: the console files are byte-identical to 1.7.3. `gobbonet.exe` became the front door and it never read the engine log the way `launch.bat` did. The engine now streams into the window marked `[llama]`, `-lv` is back, and the GPU/VRAM verdicts return. See `INVESTIGATION-cmd-visuals.md` and `CHANGELOG-1.7.5-engine-output.md` |

## Running order

Agreed with the maintainer, and followed from here:

**9 → 10 → 8 → 12 → 11 → 6 → 13**

Item 13 also owns the packaging documents (`LINUX-START-HERE.md`,
`installer-linux/README.md`), which still name 1.7.3 `.deb` files. Those
describe packages that were actually built and shipped; bumping the text before
the 1.7.4 packages exist would point people at files that are not there.

8 and 12 sit immediately after 10 on purpose: doing the About section and the
version strings back to back is what makes it possible to test that About
really is reporting the build you are running. The three most involved items
(11, 6, 13) are held to the end.

## Sequencing notes

- **#8 and #12 belong together**, and both belong near the end. Bumping version
  strings early means every intermediate test build claims to be 1.7.4, which
  defeats the point of #8 — being able to ask a user what they are running and
  get a useful answer.
- **#3 and #7 turned out to be one item**, and were closed as one. There was no
  general mechanism worth building separately: what makes sharing painful is
  metadata loss, and the fix for that is a single additional export rather than
  a family of formats. The V3 PNG export is untouched and remains the default.
- **#6 and #10 both touch user config.** Doing #10 first gives #6 somewhere to
  put its toggle and its timeout that is not another ad-hoc JSON field.
- **#13 is last by construction** — it packages whatever the other twelve leave
  behind.

## Build environment

`docs/BUILDING.md` covers the normal path. The frontend suites need
nothing but Node; the Go side needs a 1.25 toolchain to match `go.mod`.

One thing worth knowing for #6, #10, #12 and #13, all of which touch Go: the
repo root is the source of truth for the frontend, and `stage-web.sh` copies it
into `internal/webui/assets`, from where `go:embed` compiles it into the binary.
**Editing `js/` without re-staging and rebuilding means the running app keeps
serving the old file** — the same trap `stage-web.sh`'s header comment was
written about, now confined to a dev loop.

As of 1.7.5 it no longer follows a release to the user: there is no staged copy
beside the binary any more, so the frontend and the server cannot be updated
separately. That was written up as its own item below, because it is what made
#6 look broken.
