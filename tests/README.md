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

Two of them cover the same area from opposite ends: `test-cast-identity.mjs`
checks that a past message keeps the character that wrote it, and
`test-cast-mismatch.mjs` checks the notice shown when the *next* reply would
come from someone else.

Each resolves the repo root from its own location, so the working directory does
not matter.

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
