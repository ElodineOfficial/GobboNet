# Roadmap — v1.7.7

The working list for the 1.7.7 cycle, built from *Gobbonet Update notes for
1.7.7*. Item 1 of those notes — "investigate issues 1–10" — is this document:
every item was traced through the code before it was given a size. The findings
are written down below so the plan can be checked against the tree rather than
taken on trust.

Same rules as 1.7.4. Items are worked one at a time and confirmed by testing
before the next one starts, so the status column is the authority on what is
done. Nothing goes beyond an item's scope without asking first, and every visual
change copies an existing component exactly — each item names the one it
copies, and gets before/after screenshots at desktop and phone width. Each
finished item gets a `docs/changelog/CHANGELOG-1.7.7-*.md` entry in the usual
house style.

Item numbers follow the update notes so the two documents line up. #11–#14
were added at the maintainer's request on 2026-10-11, the same day the
maintainer's answers to the first draft came back and are folded in below.

## The list, easiest first

**Size.** XS = a line or two. S = a contained change, no new design. M = a new
control, or both Go and JS. Investigation = size unknown until done.

| Order | # | Item | Size | Status |
|---|---|---|---|---|
| 1 | 12 | `test-linux-onboarding.py` hides its own failures | XS | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-onboarding-test-cleanup.md` |
| 2 | 11 | Build scripts are not executable | S | **done — awaiting confirmation.** Plus two silent `-x` skips. See `CHANGELOG-1.7.7-build-scripts.md` |
| 3 | 2 | Home-screen scroll snaps back (character lists *and* Scheduled Tasks) | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-landing-scroll.md` |
| 4 | 3 | ABOUT: mods and Discord links, update placeholder | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-about-links.md` |
| 5 | 6a | Remove the 8,192-token reply cap ceiling | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-reply-cap-ceiling.md` |
| 6 | 6b | Auto-continue delay and chain cap → CONFIG | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-auto-continue-settings.md` |
| 7 | 6c | Lore compression timeout → CONFIG | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-lore-timeout-setting.md` |
| 8 | 4 | 30-minute stop → the user's own runtime setting | S | **done — awaiting confirmation.** CONFIG design confirmed. See `CHANGELOG-1.7.7-runtime-limit.md` |
| 9 | 14 | The Linux ZIP's `./gobbonet` runs setup, then the chat | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-zip-launcher.md` |
| 10 | 13 | An update that keeps its version stamp keeps showing the old page | S | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-web-refresh.md` |
| 11 | 9 | Thinking on/off per character | S–M | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-thinking-switch.md` |
| 12 | 6d | Context budget reserves → per character | M | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-context-budget.md` |
| 13 | 7 | Let users choose the address their phone connects to | M | **done — awaiting confirmation.** Design given the go-ahead 2026-10-12. See `CHANGELOG-1.7.7-phone-address.md` |
| 14 | 8a | Oversized-model warning in the Linux setup wizard | M | **done — awaiting confirmation.** See `CHANGELOG-1.7.7-wizard-vram-warning.md` |
| 15 | 8b | Why in-app model downloads failed (permissions) | Investigation | **in testing — not listed as working.** The button is live for testing and says so. See `INVESTIGATION-in-app-downloads.md` |
| 16 | 8c | Add a Model: filter the list by type (coding / roleplay / jack of all trades) and size (light / medium / heavy) | M | **done — awaiting confirmation.** Added 2026-10-12. See `CHANGELOG-1.7.7-catalog-filters.md` |
| — | — | Release housekeeping: version strings → 1.7.7 | S | **done — awaiting confirmation.** Bumped early, at the maintainer's request; second pass 2026-10-12. The package-naming docs move with the installers. See `CHANGELOG-1.7.7-version-bump.md` |
| — | 10 | First-run tutorial with AI helper | L | **tabled** |
| — | 1 | Investigate 2–10 | — | **done** (this document) |
| — | 5 | Inventory of hard-coded limits | — | **done** (table below) |

### Why this order

It is strictly easiest-first, with one exception, kept on purpose: **#9 sits
before #6d.** Both add controls to the same per-character box. #9 is one
checkbox and #6d is four fields, so doing the small one first settles the
layout that the bigger one then follows.

**#11 also happens to unblock everything after it**: every later item is built
and packaged with those scripts. Housekeeping was planned last, for the reason 1.7.4
gave (an early bump makes every test build claim to be 1.7.7). The maintainer
asked for it with batch 3, so the test build identifies as 1.7.7; each later
batch is still told apart by the commit in its stamp.

---

## Findings and plans, in the same order

### 1 · #12 — `test-linux-onboarding.py` hides its own failures

When the launcher exits early, the test's cleanup calls `os.killpg` on a process
group that no longer exists (`tests/test-linux-onboarding.py:48`). That raises
`ProcessLookupError`, which replaces the real assertion — so the report says
"no such process" instead of why the launcher stopped.

**Fix:** let the cleanup tolerate a process that has already gone, so the
original failure is what gets reported. No change to what the test checks.

### 2 · #11 — Build scripts are not executable

Every build script has been `100644` since it was first committed:

- `build-release.sh`, `make-zip.sh`, `stage-web.sh`, `verify-payload.sh`
- `installer/build-installer.sh`
- `installer-linux/build-deb.sh`, `installer-linux/package-permissions.sh`
- `installer-fedora/build-rpm.sh`, `check-rpm.sh`, `test-in-fedora.sh`

In a fresh clone, `./build-release.sh` fails with *Permission denied*.
`bash build-release.sh` fails one step later, at its own `./stage-web.sh`
(`:81`); `make-zip.sh:95` does the same. `build-deb.sh:407,409` and
`build-rpm.sh:361,421` call sibling scripts directly too.

**Likely cause.** Release commits are made from Windows, where Git does not
record the executable bit. All three `100755` files in the tree (both copies of
`gobbonet-launch`, and `installer/gen-catalog.py`) got there by explicit
mode-change commits. That means setting the bit once will not survive a zip
extracted and committed on Windows.

**So the fix has two halves:**

1. Internal calls go through `bash`, so the build works whatever the file modes
   are. This half survives a Windows commit.
2. Set the bit on the entry points in git. A zip can't carry this to Windows, so
   it is one command on your side:

   ```
   git update-index --chmod=+x build-release.sh make-zip.sh stage-web.sh verify-payload.sh installer/build-installer.sh installer-linux/build-deb.sh installer-linux/package-permissions.sh installer-fedora/build-rpm.sh installer-fedora/check-rpm.sh installer-fedora/test-in-fedora.sh
   ```

**Left as they are:**

- `gobbonet-setup.py` — run through `python3` and packaged `0644` on purpose
  (`build-deb.sh:313`).
- `postinst` and `postrm` — set to `0755` at packaging (`build-deb.sh:355-356`).
- The test files — run through `node` and `python3`.

**Pinned by:** a check, alongside `tests/test-package-permissions.py`, that no
build script calls another in a way that depends on the bit.

### 3 · #2 — Home-screen scroll snaps back

**The report is right.** `js/24-boot.js:120-142` polls the connection every
five seconds. While the landing page is showing it calls `render()`, which calls
`renderMessages()`, which runs `container.innerHTML = renderLandingPage()`
(`js/13-dashboard.js:165`). That rebuilds every scroll box on the page from
scratch. "Eventually" means within five seconds.

**Reproduced** in Chromium at 1440×900:

| List | Scrolled to | After one tick (today) | With the fix |
|---|---|---|---|
| YOUR CHARACTERS (14 extra cards) | 150 px | 0 | 150 px |
| SCHEDULED TASKS (12 schedules) | 100 px | 0 | covered by the extension below |

**Plan:** the reported fix, *merged* rather than pasted, and extended to
Scheduled Tasks as agreed.

- **Merged, not pasted.** The supplied block closes `if (!thread)` without the
  two home-button lines and the `return` at 166–168. Pasted over 163–169 as
  written, it falls through to `title.textContent = thread.name` with `thread`
  null, and throws on every five-second tick. The merged version keeps those
  lines; it is the version that was tested.
- **Extended to Scheduled Tasks.** `.landing-sched-list`
  (`css/09-dashboard.css:96-100`) is its own 240 px scroller. It is saved and
  restored the same way as `.landing-char-list`.

At phone width neither list scrolls on its own (`css/10-responsive.css:167-168`)
and the page's scroll position already survives in Chromium, so phones were not
affected. The fix is harmless there.

**Visual:** none. **Pinned by:** a test in `tests/` in the existing style, plus
the before/after browser check above.

**Credit:** the report and fix came from a contributor. Who should be credited
in `CONTRIBUTORS.md`? Not blocking.

### 4 · #3 — ABOUT: mods, Discord, update placeholder

ABOUT (`chat.html:1108-1177`) has no links today.

**Addresses (from the maintainer):**

- Mods: `https://goblincorps.com/gobbonet_extras`
- Discord: `https://discord.gg/rcmN8uEbaa`

**Plan.** One new box at the end of ABOUT, after YOUR DATA:

- **Box and heading** — copied from the STACK / YOUR DATA boxes
  (`chat.html:1154-1169`), inline styles and all.
- **Buttons** — `btn btn-sm`, the same as COPY BUILD INFO (`chat.html:1135`).
  MODS and DISCORD, each opening in a new tab with `rel="noopener noreferrer"`.
- **Update placeholder** — a disabled `btn btn-sm` reading CHECK FOR UPDATES,
  with one line under it in the box's own body text. Proposed wording: *"Coming
  in a later version. New releases are announced in the Discord."* (change
  freely). It makes no network request.

**Not included** unless asked: a link to the GitHub releases page.

**For the real auto-update later:** PRIVATE BY DESIGN (`chat.html:1140`)
promises that "the only network calls left are ones you ask for". An update
check has to be user-triggered or opt-in, or that sentence has to change.
Nothing in this patch is affected.

### 5 · #6a — Remove the 8,192-token reply cap ceiling

The per-character reply cap is the user's own number, but it is silently
clamped to 8,192 in three places:

- `js/04-state.js:163` — where the cap is read
- `js/15-cards.js:398-399` — where the card is saved
- `chat.html:615` — the input's `max="8192"`

**Plan:** remove the ceiling in all three. Any ceiling we picked would just be
another hard-coded limit, which is what #6 is removing. The floor of 25 stays,
as a sanity check.

**Visual:** none — same input, no maximum.

### 6 · #6b — Auto-continue delay and chain cap → CONFIG

Today these are `AUTO_CONTINUE_DELAY_MS = 20000` and `AUTO_CONTINUE_MAX_CHAIN =
50` (`js/09-threads.js:406-407`). The chain cap exists so `{{auto_continue_9999}}`
can't run away.

**Plan:** two settings in `DEFAULT_SETTINGS`, with today's values as their
defaults, so nothing changes for anyone who doesn't touch them. Both become
presettable from `gobbonet.toml`'s `[ui]` table automatically
(`js/21-data.js:41`).

**Visual:** a new CONFIG box directly after *Reply Delivery*.

- Box: copies the Reply Delivery box style (`chat.html:154`).
- Number rows: copy the "Max runtime: [ n ] min" row of the *Infinite Runtime
  Bug Fix* box (`chat.html:265-269`) — "Delay: [ n ] s" and "Stop after:
  [ n ] replies".

### 7 · #6c — Lore compression timeout → CONFIG

`LORE_TIMEOUT_MS = 45000` (`js/07-prompt.js:428`) is a hard stop on each
compression pass. Slow CPU-only installs are the ones that hit it.

**Plan:** one setting, defaulting to 45 s.

**Visual:** a CONFIG box after *Infinite Runtime Bug Fix*, styled like the
others, with one number row in the same style as above.

### 8 · #4 — 30-minute stop → the user's own runtime setting

**What exists.** `internal/jobs/jobs.go:96` stops every reply at 30 minutes,
even mid-stream. That is the only fixed total cap in the app; the investigation
notes are under "Reference" below.

**The maintainer's decision:** make it a variable setting in the user config.

**The plan, which needs no new control.** CONFIG already holds the user's
runtime limit: the *Infinite Runtime Bug Fix* box (`chat.html:258-271`) — an
"Enable auto-cull" checkbox and "Max runtime: [ n ] min", off by default. Today
that limit is enforced by a timer in the page (`js/10-chat.js:315-335`), so it
only works while the page is open. A reply that carries on with the tab closed
or the phone asleep runs into the server's fixed 30 minutes instead.

- **Page:** when auto-cull is on, send its minutes with each job, as a query
  parameter beside the existing `?thread=` (`js/03-generation.js:379`). The
  request body stays byte-exact.
- **Server:** use that value as the job's runtime cap. No value means no cap.
  The fixed `jobTimeout` goes.
  - `TestExpiredJobReportsAnError` (`internal/jobs/stall_test.go:225`) still
    passes, since it sets its own cap.
  - New tests: a job with no cap outlives the old limit, and a job with a cap
    stops at it.
  - Update the table row at `docs/GO_SERVER.md:332`.

The result is one setting, in CONFIG, applied wherever the reply is running.

**Kept:** the two watchdogs that never cut off a reply that is still streaming —
5 minutes waiting for a first byte, and 10 minutes of silence between chunks.
They catch a dead server, not a long answer.

**Confirmed by the maintainer:** it goes in CONFIG. As built, the page also
sends the limit plus a 15 s grace, so its own stop (with its note) lands first
while it is open; see the changelog.

### 9 · #14 — The Linux ZIP's `./gobbonet` runs setup, then the chat

Raised in "Noticed during batch 1". The maintainer chose the launcher: "the
entire idea is that this should be easier for folks to use".

- The top-level `gobbonet` in the ZIP is now
  `installer-linux/gobbonet-zip-entry`: a short script that runs
  `linux-amd64/gobbonet-launch`, the same launcher the packages install. So a
  ZIP user's first run is the setup page and then the chat, exactly as on a
  `.deb`. Commands like `./gobbonet doctor` still reach the server.
- `make-zip.sh` installs that script and refuses to build if the archive's
  `gobbonet` is anything else. It no longer packs a leftover top-level binary.

See `CHANGELOG-1.7.7-zip-launcher.md`.

### 10 · #13 — An update that keeps its version stamp keeps showing the old page

Found while testing batch 2; added at the maintainer's request.

**What happens.** The server unpacks its built-in chat page into `web/` beside
itself and serves it from there. That folder gets a stamp file recording which
build wrote it. On start, `webui.NeedsExport` (`internal/webui/webui.go`)
rewrites the folder only if the stamp's version *string* differs from the
running build's. So two builds with the same stamp share one page:

- Run the first, then the second, and the second build's frontend never reaches
  the screen.
- Nothing warns. The ABOUT version check compares the server's and the page's
  version strings, which agree.

It bit batch 2 (same base commit as batch 1). For real releases, it would bite a
re-cut build that keeps its version — a hotfix built from the same commit, or a
rebuilt binary dropped over an install.

**The fix.**

- `Export` also writes a **fingerprint of the page built into the binary** (a
  SHA-256 over the embedded files) into the stamp.
- `NeedsExport` rewrites when either the version or the fingerprint differs.

**Why fingerprint the built-in page, not the files on disk:** the stamp file
invites people to hand-edit the unpacked page ("Edit these files and reload the
page"). Comparing against the disk would wipe those edits on every restart.
Comparing against the binary's own page only replaces them when the build's page
actually changed — the same promise the stamp already makes for version changes.

- **Old stamps** have no fingerprint, so they are rewritten once, like a version
  change.
- **The stamp's wording** gains "or the built-in page changes".

**Pinned by:** the first tests `internal/webui` has had:

- same version + different built-in page → rewritten;
- same version + same page + hand-edited files → left alone;
- old stamp without a fingerprint → rewritten once;
- interrupted export → still redone (the stamp is written last).

**Effect:** the "delete `web/` first" step disappears for good, for test batches
and real releases alike. Local per-batch commits (below) already avoid it for
these batches; this fixes the cause.

**As built:** as planned. The stamp gains a `content=` line, and when the server
refreshes for this reason its startup notes say the same version now carries a
different interface. Proved with two real binaries of one version stamp: before
the change, `web/` kept the first one's page; after, it holds the second's. See
`CHANGELOG-1.7.7-web-refresh.md`.

### 11 · #9 — Thinking on/off per character

**Today nothing turns thinking off.** `thinkingFormat` only tells the parser how
to split reasoning out for display.

**The engine already runs with what this needs.** Most models get `--jinja` (the
classifier defaults it on: `internal/models/classify.go:174`,
`internal/supervisor/supervisor.go:380`), plus `--reasoning-format auto` (`:387`).
With Jinja templates, llama.cpp accepts per-request `chat_template_kwargs`, and
templates that support it honour `enable_thinking: false` (the Qwen3 family is
the clear case). The jobs path forwards the request body byte-for-byte
(`internal/jobs/jobs.go:672`), so this is a frontend-only change.

**Plan (as agreed, a character card option):**

- **The card field.** A new `thinkingEnabled` field, read as
  `card.thinkingEnabled !== false`. Existing and imported cards therefore stay
  thinking-on with no migration.
- **The request.** When the field is off, both chat request bodies
  (`js/10-chat.js:177`, `:793`) carry
  `chat_template_kwargs: { enable_thinking: false }`.
- **Export.** The field travels exactly as the reply cap does — in backups,
  single-character export and device sync — because those carry the whole card.
  Like the reply cap, it is not part of the V3 PNG, by design. No card-I/O
  change is needed.

**Visual.** A checkbox row in the card's *Context & Reply Length* box, built
exactly like "Cap this character's reply length" (`chat.html:620-623`). Label:
"Let this character think (if the model supports switching it off)".

**Honest limits.** Models trained to always reason will ignore the switch —
DeepSeek-R1 distills, and gpt-oss (which can be turned down, not off). The
behaviour has to be checked on a real install against the catalogue's thinking
models: Qwen3.5 9B, Qwen3.6 35B-A3B, DeepSeek-R1 8B, gpt-oss 20B and Gemma 4.

**Not included** unless asked: sending the same switch on lore compression
passes. Compression on a thinking model spends its budget on reasoning; that is
why `LORE_OUTPUT_FLOOR_TOKENS` exists (`js/07-prompt.js:444`).

**As built:** as planned, plus a one-line hint under the checkbox naming the
always-reasoning models. Checked against llama.cpp b10456's source: the value
must be a JSON boolean (a string is rejected), which is what is sent. Through
the real card editor and a stand-in model server, an unticked character's new
messages and regenerates carried `enable_thinking: false`, and a ticked one
sent nothing extra. Behaviour on real models still needs a real install. See
`CHANGELOG-1.7.7-thinking-switch.md`.

### 12 · #6d — Context budget reserves → per character

This is the "token reservation for lorebook compression" from the update notes.
Four fixed fractions decide when compression fires and how much it frees
(`js/08-rag.js:618-658`):

| Fraction | Value |
|---|---|
| Input budget, as a share of the context | 90% |
| Landing point after compression | 0.65 of the budget |
| Recent turns always kept verbatim | 0.22 of the budget |
| Room reserved for the reply | 0.20 of the budget |

**Plan.**

- **Per character, with global defaults.** Resolved at read time like
  `resolveContextLimit` (`js/04-state.js:137`): blank on the card means "use
  the global". The globals are today's values, so nothing moves for anyone who
  doesn't touch them.
- **Range-check the combinations.** Bad combinations — the recent reserve
  bigger than the landing point, for example — are clamped with a hint rather
  than allowed to stall compression.

**Visual:** four number fields in the same *Context & Reply Length* box, in
the existing `form-row` layout (`chat.html:607-618`).

**As built:**

- **One resolver**, `resolveContextBudget(card)` (`js/04-state.js`), read by
  both the budgeter and the context meter, so the meter's second copy of the
  numbers is gone.
- **The order card → setting → today's value.** The four settings can be
  preset from `gobbonet.toml` `[ui]`.
- **Each field is held to its own range**, then to the order keep < land <
  where compression starts, with a 5-point gap. Every adjustment comes back as
  a sentence, shown in the editor.
- **A note under the fields** says, as you type, where compression starts and
  where it lands, in terms of the whole context.

The meter's trigger on a 4,096-token context is unchanged at default (2,949
tokens) and follows the card when set. See `CHANGELOG-1.7.7-context-budget.md`.

### 13 · #7 — Choose the address the phone connects to

**The maintainer's clarification:** the phone uses something like
`192.168.x.x:9066`, the PC itself uses `127.0.0.1:9066`, and users want to be
able to change the address their phone connects to.

**What exists.**

- The server listens on `0.0.0.0` by default (`internal/config/file.go:118`),
  which answers on *every* network address the PC has.
- It already ranks those addresses by adapter (ordinary network adapter, then
  virtual, then VPN) and sends the list to the browser in `/health`
  (`internal/server/server.go:585-608`).
- The page never shows that list. The only place it appears is the console
  banner at startup, which scrolls away.
- Changing anything means re-running setup or editing `config.toml`.

**One thing GobboNet cannot do.** The `192.168.x.x` number is handed out by the
router. GobboNet can choose *among* the PC's addresses and change the port, but
it cannot pick a new number or make one permanent. If the number keeps changing
— the case `js/06-state-sync.js:793` already warns about — the fix is a DHCP
reservation in the router. The new box says so in one line.

**Plan:** a new CONFIG box, "Phone & Other Devices" (cyan box style, as Reply
Delivery), in two parts:

- **Part 1 — show the addresses.** Every address this server answers on, each
  labelled with its adapter, recommended one first, each with a COPY button
  (`btn btn-sm`). This alone fixes the most common report: the address shown was
  the wrong adapter (Ethernet vs Wi-Fi, VPN, WSL), and the right one was never
  visible.
- **Part 2 — choose the address and port.**
  - A choice of *Automatic (all addresses)* or one specific address, plus the
    port. Saved to `listen_host` / `listen_port` through an authenticated
    endpoint, the same way `/perf` saves tuning.
  - Applied the next time GobboNet starts, and the box shows the new address
    *before* saving, so nobody is cut off from a page they can no longer find.
  - When one specific address is chosen, the server also keeps listening on
    loopback. Pinning a single address would otherwise stop `127.0.0.1`
    working on the PC itself, because today's bind is one listener
    (`internal/server/server.go:705-737`).

**Visual:** an existing CONFIG box style, `btn btn-sm` buttons, and the
existing select and number inputs. Nothing new.

**To confirm:** that parts 1 and 2 together are what you meant.

**Confirmed** — "work on those", 2026-10-12. **As built:**

- **The box sits after Performance.** It reuses Idle Stand-Down's box and
  status line, ABOUT's build rows with COPY buttons, and Performance's
  address/port pair and SAVE FOR NEXT START button.
- **The choice also offers *This PC only*.** It is an existing `listen_host`
  state the Linux wizard can write, and the box has to be able to show it and
  undo it.
- **A save is checked before it is written:**
  - the address must be one this PC has;
  - the port range is `launch.bat`'s 1024–32767 on Windows and the Linux
    wizard's 1024–65535 elsewhere;
  - the engine's ports are refused;
  - a taken port is refused;
  - another site's page can't drive it.
- **Windows:** the save also writes `.gobbonet-port`, because `launch.bat`
  takes the port from there. After a port change the box says to run LAN Setup
  again for the firewall rule.
- **A pinned address keeps loopback beside it**, as planned.

See `CHANGELOG-1.7.7-phone-address.md`.

### 14 · #8a — Oversized-model warning in the Linux setup wizard

**Nothing blocks a model for being too big for the hardware.** The only hard
refusal is disk space (size + 1 GB: `internal/server/models.go:258`,
`internal/setup/setup.go:403`), which stays.

- **Windows already warns and asks:** `launch.bat:1210-1237` ("Heads up …
  Download it anyway?") and the installer's dialog (`installer/gobbonet.nsi:644`).
- **The Linux wizard doesn't.** `installer-linux/wizard.html:262` (and its
  identical copy in `linux-amd64/`) only prints "suits N GB VRAM or more". The
  Go side has no VRAM figure to compare against.

**The VRAM source: the bundled engine.** Verified in the llama.cpp source at
the pinned tag b10456 (`common/arg.cpp:1139-1162`): `llama-server
--list-devices` prints one line per GPU —
`  CUDA0: <name> (<total> MiB, <free> MiB free)` — or `(none)`, with the CPU
excluded.

**Plan.**

- **Read the GPU memory.** Parse that output once per engine binary, cached
  the same way `memoryCapabilities` caches `--help`
  (`internal/supervisor/memory.go`). Expose it through the setup API.
- **Warn before downloading.** When detected VRAM is below a model's
  `min_vram`, the wizard shows `launch.bat`'s wording through native
  `confirm()`, the house pattern.
- **Never block on a failed probe.** When VRAM is unknown, no warning —
  `launch.bat`'s rule.
- **Check on a real GPU machine.** The numbers need a GPU to verify; this
  sandbox has no engine. Integrated GPUs on Vulkan may report shared system
  memory as their total, so the wording should stay "may run slowly", not "will
  not run".

**Visual:** none beyond the browser's own confirm dialog, the same as every
other confirmation in the app.

**As built:**

- **The reading of the device list is `hardware-probe.ps1`'s, ported to Go**
  (`internal/engine/devices.go`):
  - names with their own parentheses are handled;
  - Vulkan's `uma` flag and the integrated-GPU name list leave integrated GPUs
    out;
  - capacity rounds to the card's label;
  - the largest dedicated card is the figure.
- **One addition:** known discrete names (NVIDIA, Radeon RX, Arc A/B) are never
  called integrated for holding most of system memory. Otherwise an 8 GB card
  in an 8 GB machine would be.
- **The probe starts with the wizard**, is cached per engine file, and gives up
  after 20 s.
- **`GET /api/gpu`** serves the figure, proxied by the Python setup shell.
- **The confirm uses `launch.bat`'s first sentence and question.** The middle
  sentence is reworded: GobboNet's server falls back to system memory, so the
  model is slow rather than failing.
- **Both wizards carry it:** the packaged one, and the one built into the
  program.
- **Checked through the real Linux launcher** with a stand-in 8 GB GPU.

See `CHANGELOG-1.7.7-wizard-vram-warning.md`.

### 15 · #8b — Why in-app model downloads failed

**Background, from the maintainer:** it was mostly a permissions issue, and
after a lot of attempts the "download more models here" approach wasn't viable.
The button has been held off since the 1.7 releases (`MODEL_CATALOG_ENABLED =
false`, `js/02-model.js:772`). It is already in the `v1.7.2` tag and absent
from `v1.6`, and the running build shows NOT WORKING YET.

**What the code rules out.** The Windows installer is per-user — it installs to
`$LOCALAPPDATA\GobboNet` with `RequestExecutionLevel user`
(`installer/gobbonet.nsi:69,76`) and creates `$INSTDIR\models` itself. Linux
defaults to `~/.local/share/gobbonet/models`. So on a standard install the
models folder *should* be writable; the failure is somewhere narrower.

**Hypotheses, most likely first:**

1. **A protected or redirected folder.** The portable zip unpacked into
   Documents or Desktop, where Windows *Controlled Folder Access* blocks
   unrecognised programs from writing, and OneDrive redirection makes it
   likelier. Or into Program Files, or onto a drive the account can't write.
2. **Antivirus.** A new executable writing a multi-GB `.part` file from an
   outbound download gets blocked or quarantined mid-transfer.
3. **The upstream refusing.** A gated Hugging Face repo answers 401/403 without
   a login. The shipped catalogue's mirrors are ungated, but the remote
   catalogue could point anywhere.
4. **The app's own access checks.** The download refused from a phone or a
   second device: auth or origin checks on `POST /model-download`.
5. **The swap after the download,** not the download itself: starting the new
   model is a process launch, with its own permission story on Windows.

**Steps:**

1. Collect whatever error text or logs survive from the earlier attempts.
   `gobbonet doctor` prints the log location.
2. Make a dev build with the hold lifted. The tests already prove flipping the
   flag restores the whole path.
3. Record the HTTP status and server log line at each stage: catalogue → `POST`
   → `.part` written → renamed → list refreshed → swap.
4. Run that across a matrix:
   - Windows installer
   - Portable zip in Documents with Controlled Folder Access on
   - Portable zip on a OneDrive Desktop
   - Portable zip in Program Files
   - Linux `.deb` and `.rpm`
   - Each from the PC and from a phone
5. Write up an `INVESTIGATION-in-app-downloads.md`, the same as earlier
   investigations.

**Decision point after the write-up:** fix it if it comes down to one cause;
otherwise retire the in-app path deliberately. Retiring it would remove a
visible button, so that is a visual change, and it is asked about first. The
installer, `launch.bat` and the "drop a `.gguf` in the models folder" route
cover adding models in the meantime.

**Batch 5 — worked on, not listed as working**, at the maintainer's request:
"I'll test what you can't and we can work on errors from there".

- **Step 2:** the button is live in the builds, labelled "Being tested — not
  confirmed working yet". The first try hid it behind `?test-downloads` in the
  address. In testing the button did nothing, and the switch was lost on
  signing in anyway, so the maintainer chose the live button (2026-10-12).
- **Step 3 is built in.** Every failure names its step and explains the usual
  cause on that platform, and every step is logged with `[download]`.
- **Three robustness changes:**
  - the models folder is tried before any download;
  - antivirus holding the finished file at the rename is waited out on Windows;
  - the downloader can no longer hang forever, since it had no timeouts at all.
- **Step 5's write-up exists:** `INVESTIGATION-in-app-downloads.md`, with the
  step-by-step trace, how each hypothesis will now show itself, and the test
  matrix (step 4) for the maintainer to run.

### Release housekeeping

Not a feature; it comes with any release.

- `VERSION` and `GOBBONET_UI_VERSION` (`js/01-config.js:24`) move to 1.7.7
  together. `tests/test-version-stamp.mjs` pins them equal.
- `TestVersionFileMatchesUpstreamRelease` needs a `v1.7.7` tag before `go test`
  is quiet.

**Done with batch 3**, at the maintainer's request:

- `VERSION`, the page stamp, and `installer-win/gobbonet.nsi`'s three literals.
- The bump commit is tagged `v1.7.7` locally only; the real tag goes on GitHub
  at release.
- Docs that name the shipped 1.7.6 packages (`START-HERE.md`,
  `LINUX-START-HERE.md`, `FEDORA.md`, `SHA256SUMS.txt`) move with the packaging
  step, per the 1.7.4 rule.

**Second pass, 2026-10-12**, before the installers:

- **Nothing else names 1.7.6** except history: comments recording when
  something changed, and the `.spec`'s changelog entries.
- **`docs/BUILDING.md` was version-neutral in name only.** It said `VERSION`
  "already says `1.7.4`", gave 1.7.4 filenames, and called `VERSION` the only
  version literal. Its commands now read `<VERSION>`, and it names the two
  literals that move with `VERSION`.
- **`installer-win/gobbonet.nsi`'s three literals** (`APPVER`, `OutFile`,
  `VIProductVersion`) had no test, so a release could ship an installer named
  and stamped as the previous one. `tests/test-version-strings.py` now holds
  them to `VERSION`, and holds `installer/gobbonet.nsi` to its `-D` define.
- **Left for the installer step**, as the rule says:
  - `START-HERE.md`, `LINUX-START-HERE.md`, `installer-fedora/FEDORA.md`;
  - the root `SHA256SUMS.txt`;
  - a `1.7.7-1` entry in `installer-fedora/gobbonet.spec`'s changelog.

  They name real package files, build stamps and checksums, which exist only
  once the 1.7.7 packages are built.

See `CHANGELOG-1.7.7-version-bump.md`.

### #10 — First-run tutorial (tabled)

Groundwork, so it is not lost. The **Gobbonet Informant** default character is
already an AI helper ("Ask about any button or setting"), but its 6,856-character
brief was last changed in the 1.7.3 commit. So it predates everything
`ROADMAP-1.7.4.md` added — sticky cards, device sync profiles, scroll modes,
stand-down, lore editing — and mentions none of them. Whatever shape the tutorial
takes, refreshing that brief is the cheapest first step.

---

## Reference

### #4 investigation — every timer on the reply path

- `internal/jobs/jobs.go:96` sets `jobTimeout = 30 * time.Minute`, applied at
  `:690` with `WithTimeoutCause`. The user is told "this generation ran past the
  30m0s limit and was stopped" (`:555`).
- The browser's watchdog is CONFIG → *Infinite Runtime Bug Fix*, off by default.
- Chat requests send `max_tokens: -1` (`js/10-chat.js:177`, `:793`).
- The direct `/llm/*` proxy has no total cap.
- The legacy `fileserver.ps1:922-923` values look like a 30-minute cap, but
  aren't one. On `HttpWebRequest`, `Timeout` bounds the wait for a response and
  `ReadWriteTimeout` bounds each individual read, so a reply that keeps
  streaming never trips either.
- The two watchdogs kept: first byte 5 min (`internal/jobs/jobs.go:112`,
  `internal/proxy/proxy.go:35`); silence between chunks 10 min (`jobs.go:118`,
  `proxy.go:40`).

### #5 — Inventory of hard-coded limits

Every limit on a live code path that a user could plausibly hit.

| Limit | Value | Where | Home | In 1.7.7? |
|---|---|---|---|---|
| Reply cap ceiling | 8,192 tok | `js/04-state.js:163`, `js/15-cards.js:398`, `chat.html:615` | Removed | **6a** |
| Auto-continue delay / chain cap | 20 s / 50 | `js/09-threads.js:406-407` | CONFIG | **6b** |
| Lore pass timeout | 45 s | `js/07-prompt.js:428` | CONFIG | **6c** |
| Total reply runtime | 30 min | `internal/jobs/jobs.go:96` | CONFIG (existing setting) | **#4** |
| Input budget share of context | 90% | was `js/08-rag.js:618`; now `resolveContextBudget` | Card, global default | **6d** |
| Post-compression landing point | 0.65 of budget | was `js/08-rag.js:625`; now `resolveContextBudget` | Card, global default | **6d** |
| Recent turns kept verbatim | 0.22 of budget | was `js/08-rag.js:633`; now `resolveContextBudget` | Card, global default | **6d** |
| Reply reserve that triggers compression | 0.20 of budget | was `js/08-rag.js:658`; now `resolveContextBudget` | Card, global default | **6d** |
| Lore pass output target / floor / safety | 2048 / 512 / 256 tok | `js/07-prompt.js:453-455` | — | next patch |
| Lore pass input | 24 msgs / 12,000 chars | `js/07-prompt.js:682-683` | — | next patch |
| Lore summary backstop | 2,400 chars | `js/07-prompt.js:349` | — | next patch |
| Attachment text / file size | 100,000 chars / 8 MB | `js/18-utils.js:2037-2038` | CONFIG | next patch |
| RAG knobs (threshold, warmth, top-k, budget, window…) | various | `js/04-state.js:229-238` | Already settings, TOML-presettable; no CONFIG controls | next patch (M, ten fields) |
| Wait for first byte | 5 min | `internal/jobs/jobs.go:112`, `internal/proxy/proxy.go:35` | Config file | next patch |
| Silence between chunks | 10 min | `internal/jobs/jobs.go:118`, `internal/proxy/proxy.go:40` | Config file | next patch |
| State upload size | 128 MiB | `internal/state/state.go:90` | Config file | next patch |
| Card-code request default | 600 tok | `js/23-card-code.js:148` | — | no: already overridable per call |

**Left alone — safety floors and internals:** context floor of 2,048
(`js/04-state.js:152`); the 1 GB download size floor; the 128 MiB job buffer;
the disk-space check; render/markdown/highlight caches; the telemetry ring;
poll sizes; catalogue body caps; the lore context TTL; the follow-button
distance. None of these is a choice a user is making.

### #6 — the three homes

1. **CONFIG.** Add the key to `DEFAULT_SETTINGS` (`js/04-state.js`). It is then
   presettable from `gobbonet.toml`'s `[ui]` table automatically
   (`js/21-data.js:41`), and shows under DATA → SERVER PRESETS.
2. **Character card.** Resolved at read time: the card's value, with blank
   meaning "inherit the global". This is how `resolveContextLimit` and
   `resolveSmartLimit` already work (`js/04-state.js:137`, `:156`). Visual: the
   *Context & Reply Length — per character* box (`chat.html:603`).
3. **Data — the config file (`gobbonet.toml`).** For limits that live in Go. New
   keys go through the 1.7.4 forward-compatibility classification, so an older
   binary that reads a newer config warns rather than refusing to start.

---

## Noticed during batch 1 — not changed, for a decision

- **`make-zip.sh` never builds the top-level `gobbonet`, but requires it.** Its
  manifest lists `gobbonet` at the archive root — the binary `LINUX-START-HERE.md`
  tells ZIP users to run as `./gobbonet` — but the script only builds
  `gobbonet.exe` and `linux-amd64/gobbonet`. It passes on a machine that happens to
  have a leftover `gobbonet` from an earlier `go build`, and it then ships that
  leftover. The stamp check at the end only looks at `linux-amd64/gobbonet`, so a
  stale one goes unnoticed — the same shape as 1.7.4 shipping a 1.7.3 server.
  - **For batch 1** it was built by hand with the script's own flags and stamp,
    and checked.
  - **The question:** should the top-level `./gobbonet` be the server binary (what
    `.gitignore` calls "Built binary", and what `docs/GO_SERVER.md` documents), or
    the launcher, which runs setup first and writes the `launch.log` that
    `LINUX-START-HERE.md` points ZIP users at? The fix to the script follows from
    the answer.
  - **The evidence**, gathered after the maintainer asked for more detail:
    - **The docs mean the launcher.** In the `.deb`, the `gobbonet` command is a
      link to the launcher (`installer-linux/build-deb.sh:345`).
      `LINUX-START-HERE.md` (written in 1.7.3) tells ZIP users to "substitute
      `./gobbonet`" for that same command. It lists Python 3.8+ and xdg-utils as
      requirements, which only the setup wizard and the browser-opening need.
      And it points at `launch.log`, which only the launcher writes.
    - **The ZIP gives the binary.** Run as a first-time user, the binary in the
      batch 1 and 2 ZIPs prints "Review [config.toml]… then run gobbonet again"
      and exits. There is no setup wizard, no browser, and no `launch.log`.
  - **Recommended:**
    - Ship a three-line wrapper script as the top-level `./gobbonet` that hands
      over to `linux-amd64/gobbonet-launch`.
    - Have `make-zip.sh` copy that script rather than look for a built file.
    - Because it is text, it cannot go stale.
    - The launcher already passes commands straight through to the server
      (`./gobbonet doctor`, `./gobbonet version`, `./gobbonet config set …`
      still work), so ZIP users get the same behaviour as `.deb` users either
      way.
  - **Decided: the launcher. Done as #14.**
- **Coming home from a thread, the home page can start partway down.** Same with
  the original code; see the #2 changelog.

## Noticed during batch 2

- **An update with an unchanged version stamp keeps showing the old page.** Now
  item #13 on the list, at the maintainer's request. Done in batch 4.

## Noticed during batch 5 — not changed

- **Signing in always lands on the plain page.** `POST /login` redirects to
  `/`, so anything else in the address the user opened — a query, a path — is
  dropped. It is what sank the `?test-downloads` switch. Nothing else depends
  on it today.

## Added after batch 5

- **#8c, Add a Model filters** (order 16), at the maintainer's request once
  in-app downloads worked: "Right now we're just throwing a giant list at the
  users." Buckets, size split and layout were all agreed first. See
  `CHANGELOG-1.7.7-catalog-filters.md`. **For the maintainer:** the live list on
  goblincorps.com needs the bucket tags added, and the changelog lists them.
  Until then each model borrows its buckets from the bundled list.

- **Saved passwords landing in the conversation search** (bug fix), reported
  in testing. Chrome took the chat page for a login form. The bug predates
  1.7.7. See `CHANGELOG-1.7.7-search-autofill.md`.

## Held for the next patch

At the maintainer's decision (2026-10-12), 1.7.7 takes nothing further in these
two areas:

- **Further GitHub issues.** No new investigations start in 1.7.7.
- **The hard-coded limits not yet touched.** These are the rows marked "next
  patch" in the #5 inventory above:
  - the lore pass's output target and input caps, and its summary backstop;
  - the attachment text and file-size limits;
  - the RAG knobs' CONFIG controls;
  - the server's first-byte and between-chunk watchdogs;
  - the state upload size.

**#10, the first-run tutorial**, stays tabled.

**What remains for 1.7.7 is the installers**, starting with the package-naming
docs listed under *Release housekeeping*, and the #8b test matrix.

## Installers

The maintainer's direction (2026-10-12): "We want installers to act the **SAME
WAY** they did in the 1.7.5 [not 1.7.6]". Each OS keeps its own simplified
steps, done one at a time: Windows, then Linux, then Fedora.

- **Windows — built, not run.** The installer is `installer-win/`, the dark one
  whose first launch opens `launch.bat` in a console window. That window detects
  the hardware and offers the models.
  - **The pages are unchanged.**
  - **One fix:** `models.ini` is now installed, which *Add a Model* needs
    offline and for its type buttons.
  - **The first test build was the wrong installer.** It was `installer/`,
    built the way 1.7.4 had been built by mistake, and the maintainer rejected
    it. It is reverted.
  - **The guard:** `docs/BUILDING.md` and a test now name `installer-win/`.
  - See `CHANGELOG-1.7.7-windows-installer.md`.
- **Linux — built and run here, not on a desktop.** The installer is
  `installer-linux/`, the `.deb`, from the maintainer's own 1.7.3 and 1.7.5
  commits. Its menu entry opens the browser setup wizard, which is the only
  installer with "Where should models run?".
  - **Unchanged since 1.7.5,** apart from #8a's GPU-memory question.
  - **The packaged first run passes** for both local and LAN, and every wizard
    step was walked in a browser.
  - **Fixed, with the maintainer's approval:** the model step's "models belong
    in" line, which went stale when another folder was chosen. This was already
    the case in 1.7.5.
  - See `CHANGELOG-1.7.7-linux-installer.md`.
- **Fedora — built and tested in Fedora 43, 44, 45 and Rawhide, not on
  hardware.** The installer is `installer-fedora/`, the `.rpm` installed with
  dnf.
  - **The user flow is the Debian one:** the same launcher and browser wizard.
  - **1.7.6 changed only the packaging, and that stays.** It is what lets the
    engine start on Fedora 45, which moved to OpenSSL 4.
  - **One fix 1.7.6 deferred to this binary:** `gobbonet uninstall` named apt
    on Fedora too; it now names dnf.
  - See `CHANGELOG-1.7.7-fedora-installer.md`.
- **The package-naming docs** (`START-HERE.md` and the rest under *Release
  housekeeping*) move once all three are built.

## Still open

- **#8b:** the test matrix in `INVESTIGATION-in-app-downloads.md`, run on the
  machines the authoring sandbox can't reach. Send the failure title, message
  and `[download]` lines from any row that fails.

## Build environment

`docs/BUILDING.md` says Go was unavailable in the authoring sandbox. That is no
longer true here:

- Go 1.25.0 was built from its GitHub source.
- The five blocked `golang.org/x/…` modules were rebuilt from their GitHub mirrors
  into a local file proxy. The Go command still checks every one against
  `go.sum` — `go mod verify` reports *all modules verified* — so the dependency
  sources are the same ones `go.sum` pins.

Baseline at `314bdc9`, before any 1.7.7 change:

- `go vet` is clean and every Go package passes.
- All 27 `tests/*.mjs` pass.
- 7 of 8 Python suites pass. The eighth, `test-linux-onboarding.py`, needs a full
  install with an engine, which a checkout does not contain — and when it fails,
  it reports the wrong reason (item #12). Pointed at a built prefix with
  `GOBBONET_TEST_PREFIX`, it passes; see the #12 changelog.

The same reminder as 1.7.4: `js/` and `css/` edits only reach the binary after
`stage-web.sh` and a rebuild.

**One more trap, for testing batches.** The binary unpacks its chat page into a
`web/` folder beside itself, and rewrites that folder only when its version stamp
changes (`internal/server/webroot.go`).

- Batch 1 is stamped `1.7.6-go-314bdc9-dirty`, which differs from any real 1.7.6
  install, so its page replaces the old one.
- Batch 2 was built from the same base commit, so it carried the *same* stamp,
  and an install that ran batch 1 kept serving batch 1's page until `web/` was
  deleted. Item #13 fixes the cause.
- **From batch 3 on, each batch is built from its own local commit** on the
  branch `1.7.7-local`. The maintainer approved this on 2026-10-11; the branch
  is never pushed, and `main` is untouched. Each zip's stamp therefore names a
  commit of its own (`1.7.7-go-<sha>` since the version bump in batch 3).
  Batches 1 and 2 together are commit `91a6d69`.
- Dev builds are all stamped `dev` and had the same issue.
- **From batch 4 on, the trap is gone** (#13): the stamp also records a
  fingerprint of the page built into the binary, so any build whose page differs
  refreshes `web/`, whatever its version says. Nothing needs deleting between
  batches or dev builds any more.
