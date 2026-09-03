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
