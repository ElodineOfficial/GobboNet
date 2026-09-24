# Tests and preview pages

Developer tooling. Nothing here ships, and nothing here is needed to run
GobboNet.

## Frontend suites (`*.mjs`)

Plain Node, no framework and no install step. They read the real files out of
`js/` and evaluate them, so they test what actually ships rather than a copy.

```sh
node tests/test-markdown-render.mjs     # one suite
for f in tests/*.mjs; do node "$f" || echo "FAILED: $f"; done   # all of them
```

`test-engine-args.py` pins the llama-server command line across the two launch
paths — `launch.bat`'s `:start_server` block and `Supervisor.BuildArgs`, the
latter being what the `.deb` and the Windows installer both use. Every flag
present on one side and not the other has to be listed as a known, reasoned
difference or the test fails. It also holds the `-lv` / offload-detection
pairing from #33: if GPU-offload confirmation is ever added to the Go path,
`-lv` must arrive with it, because llama.cpp files those log lines above the
default verbosity threshold.

```sh
python3 tests/test-engine-args.py
```

`test-prompt-safety.py` and `test-image-url-gate.mjs` cover the three fixes from
PR #30 (John McCardle). The first pins the confirmation-prompt hygiene in
`launch.bat` and the sanitizer routing in `identify-model.ps1` — neither can run
on CI, since one needs an interactive Windows console and the other a real GGUF.
The PR proposed parsing the PowerShell with its own AST under a container; this
does the same job statically so it runs anywhere the rest of the suite does. The
second drives the real `safeImageUrl` and asserts nothing it returns can carry a
character that ends an HTML attribute or a CSS `url()`. Background is in
[`docs/changelog/CHANGELOG-1.7.3-prompt-and-sanitizer-fixes.md`](../docs/changelog/CHANGELOG-1.7.3-prompt-and-sanitizer-fixes.md).

`test-remote-models.mjs` covers the model dropdown in remote mode — the shape
behind #47, #48 and #27. It drives the real `loadModelsList` /
`onHeaderModelChange` in a fake DOM and includes source guards that no request
path has drifted back to a hardcoded model name. Background is in
[`docs/changelog/CHANGELOG-1.7.3-remote-model-list.md`](../docs/changelog/CHANGELOG-1.7.3-remote-model-list.md).

`test-code-copy.mjs` covers the Copy button on a code block, driving the real
`parseMarkdown` and `copyCodeBlock` over a node tree built from the rendered
HTML. The DOM is a shim at the top of the file rather than a dependency, since
nothing in `tests/` has an install step. It pairs with section B3 of
`test-markdown-render.mjs`: that one covers what renders, this one covers what
reaches the clipboard. Background is in
[`docs/changelog/CHANGELOG-1.7.4-code-copy-linebreaks.md`](../docs/changelog/CHANGELOG-1.7.4-code-copy-linebreaks.md).

`test-standdown-panel.mjs` covers the CONFIG control for idle stand-down. The
mechanism itself is server-side and tested in Go
(`internal/supervisor/standdown_test.go` for the decision rule,
`internal/server/standdown_endpoint_test.go` for the endpoint); this covers the
one thing only the browser can get wrong, which is showing a switch that cannot
work. Background is in
[`docs/changelog/CHANGELOG-1.7.4-idle-standdown.md`](../docs/changelog/CHANGELOG-1.7.4-idle-standdown.md).

`test-lore-editing.mjs` covers hand-editing the lore summary. Section A is the
one that matters: a compression pass `await`s a model for seconds and then
writes the summary back, so an edit made during that window would be silently
replaced by something derived from the version it replaced. It pins that the
edit survives *and* the pass's beat is kept where the two can be separated.
Background is in
[`docs/changelog/CHANGELOG-1.7.4-lore-editing.md`](../docs/changelog/CHANGELOG-1.7.4-lore-editing.md).

`test-version-stamp.mjs` covers the build identity in the ABOUT panel. Section
A is the load-bearing one: it asserts the frontend's `GOBBONET_UI_VERSION`
equals the `VERSION` file, so bumping one without the other fails the suite.
That guard exists because the string it replaced read
`1.6.0-no-encoded-payload` for the whole of 1.7.x — the one thing in the app
claiming to identify the build was wrong by two minor releases and nothing
noticed. The rest covers the server-vs-page mismatch warning, which is how a
cached frontend gets told apart from a real regression. Background is in
[`docs/changelog/CHANGELOG-1.7.4-about-version.md`](../docs/changelog/CHANGELOG-1.7.4-about-version.md).

`test-server-presets.mjs` covers the `[ui]` table in `gobbonet.toml`, which
seeds browser settings from the config file. The rule it exists to protect is
seed-not-lock: a device that has its own settings keeps them and is only
offered the presets. Section D asserts the key list is generated from
`DEFAULT_SETTINGS` by adding a setting at runtime and checking it is
immediately presettable — the property that keeps Go and the browser from
needing two lists. The Go halves are `internal/server/ui_defaults_test.go` and
`internal/config/ui_table_test.go`. Background is in
[`docs/changelog/CHANGELOG-1.7.4-ui-presets.md`](../docs/changelog/CHANGELOG-1.7.4-ui-presets.md).

`test-single-export.mjs` covers exporting one thread or one character, driving
the real export and import with the download captured. The fixture is built so
the easy implementation fails: the thread's cast is not the whole roster, and
one character appears only on a message rather than on the thread, so an export
that read `thread.cardId` alone would miss it. Section C is the full round trip
through the real `importData`. Background is in
[`docs/changelog/CHANGELOG-1.7.4-single-export.md`](../docs/changelog/CHANGELOG-1.7.4-single-export.md).

`test-scroll-modes.mjs` covers how the viewport behaves while a reply streams
— follow-but-let-go, always follow, or never — driving the real functions
against a fake scroll container that clamps `scrollTop` the way a real one
does. Section D is the one that earns its keep: it pins that the end-of-stream
rebuild puts the reading position back instead of leaving the user at the top
of the thread. Background is in
[`docs/changelog/CHANGELOG-1.7.4-scroll-modes.md`](../docs/changelog/CHANGELOG-1.7.4-scroll-modes.md).

`test-sync-targets.mjs` covers which server-side backup a device syncs with —
the shared one, a profile of its own, or none — driving the real target logic
against a fake localStorage and a fake fetch, so the URLs asserted on are the
ones a browser would request. Section A exists for one reason: an install with
no target stored must resolve to *shared*, or every existing user boots into an
empty chat with their history still on the server. The Go half is
`internal/server/state_profiles_test.go`. Background is in
[`docs/changelog/CHANGELOG-1.7.4-device-sync.md`](../docs/changelog/CHANGELOG-1.7.4-device-sync.md).

`test-card-share-export.mjs` covers the FOR SHARING character-card export — a
JPG with a ZIP archive appended — driving the real ZIP writer and reader over a
small JPEG embedded in the test file. The assertion that earns its keep is that
a *naively* concatenated archive fails to read: the offsets have to be written
biased by the length of the image in front of them, or GobboNet cannot open its
own export. Background is in
[`docs/changelog/CHANGELOG-1.7.4-share-export.md`](../docs/changelog/CHANGELOG-1.7.4-share-export.md).

`test-char-modal.mjs` covers dismissal of the CAST modal — the sticky setting,
the unsaved-changes guard, and the notice shown when a dismissal is refused —
by running the real handlers from `js/22-scheduler.js` in a fake DOM. Section A
is the original v1.7 device/pointer/target matrix and is deliberately frozen:
with the editor clean and sticky on, every answer must still be what it was.
Background is in
[`docs/changelog/CHANGELOG-1.7.4-sticky-cards.md`](../docs/changelog/CHANGELOG-1.7.4-sticky-cards.md).

Two of them cover the same area from opposite ends: `test-cast-identity.mjs`
checks that a past message keeps the character that wrote it, and
`test-cast-mismatch.mjs` checks the notice shown when the *next* reply would
come from someone else.

Each resolves the repo root from its own location, so the working directory does
not matter.

`test-conversation-order.mjs` covers where a conversation sits in the sidebar:
activity order, a drag holding until the chat is next used (the 1.7.5 rule),
respacing, placements from builds that recorded no activity mark, carrying a
saved `threadOrder` list into the keys through the real `applyLoadedState` and
`loadState`, and the two sync guards -- a placement never reads as a message
conflict, and reconcile keeps a placement's two fields together. Background is
in [`docs/changelog/CHANGELOG-feature-restore.md`](../docs/changelog/CHANGELOG-feature-restore.md).

`test-device-sync.mjs` covers the DEVICE SYNC choices against the real sync
layer and an in-memory server with the protocol's rules: seeding a target
records the versions it wrote (so a new profile, "keep this device", or sync
back on ends synced, not in conflict), a write from another device in between
is not adopted, and a chat missing the loader's defaults does not read as a
conflict. It also holds `THREAD_LOAD_DEFAULTS` equal to the loader's block.
Background is in [`docs/changelog/CHANGELOG-feature-restore.md`](../docs/changelog/CHANGELOG-feature-restore.md).

`test-boot-resume.mjs` drives the real `24-boot.js` against the real sync layer:
pending replies resume after the startup state check whether or not it
succeeded, and the one-time notice flag reaches storage through
`saveState({ localOnly })` without scheduling a push.

## Launcher invariants

`test-launch-gpu-detect.py` checks the arrangement in `launch.bat` that lets it
confirm GPU offload: that `-lv` is passed, that the verbosity is high enough for
llama.cpp to emit the lines the check reads, and that the check accepts more than
one spelling of them. Background is in
[`docs/changelog/CHANGELOG-1.7-llamacpp-log-verbosity.md`](../docs/changelog/CHANGELOG-1.7-llamacpp-log-verbosity.md).

```sh
python3 tests/test-launch-gpu-detect.py
```

`test-setup-lan.py` does the same job for `setup-lan.bat` and
`teardown-lan.bat`, neither of which can be exercised on CI — they need
Administrator on Windows and a real firewall to talk to. It pins how the web
port is resolved, that no allow rule is ever wider than `LocalSubnet`, that
every rule added has a matching removal in the teardown, and that no `%VAR%`
read sits inside a parenthesised block. Background is in
[`docs/changelog/CHANGELOG-1.7.3-lan-address-and-firewall.md`](../docs/changelog/CHANGELOG-1.7.3-lan-address-and-firewall.md).

```sh
python3 tests/test-setup-lan.py
```

`test-launch-gpu-layers.py` pins where `launch.bat` turns automatic GPU
placement (`-1`) into 99 layers: on the legacy path only, before llama-server
and the hot-swap variables see it, never on the managed hand-off to
`gobbonet.exe`, which does its own capability-checked fitting.

## Preview pages (`preview/`)

A suite tells you the renderer produced the right markup. It cannot tell you
whether the result *looks* right. Open these in a browser for that:

- `preview/math-preview.html` — LaTeX and math rendering
- `preview/render-preview.html` — markdown, code blocks, chat bubbles

They load the real `css/` and `js/` from the repo root rather than copies, so
they cannot drift from what ships.

## Go tests

Alongside the code they cover, run the usual way:

```sh
go test ./...
```
