# 1.8.0 — GobboNet starts and watches the embedding server

Roadmap item #15. PR #56 (orcmaul) restarted the embedding server from
`launch.bat`'s monitor loop when it died; that loop went with the legacy
server in round 6, and the idea lives in the Go server now. The PR closes with
credit.

## What was happening

The embedding server is the small second llama-server that lets the RAG
Storybook and memory files match by meaning. Up to 1.7.9 the launchers started
it -- `launch.bat` on Windows, `gobbonet-launch` on Linux -- and nothing watched
it. A crash turned semantic search off with no notice; RAG quietly fell back to
names and tags. And on Windows a configured launch, which is what the Start menu
and desktop shortcuts run, goes straight to `gobbonet.exe serve` without
`launch.bat` (`cmd/gobbonet/launch.go`), so it started no embedding server at
all: after a reboot, semantic search stayed off until someone ran
*Setup or add a model*. (Read from the 1.7.9 code; the round's console check
lists the Windows step that confirms it.)

## The change

**One process half for both engines** (`internal/supervisor/managed.go`). The
parts of the chat supervisor that launch and end a process -- its own process
group, the Windows kill-on-close job, the polite-then-forced sweep of the whole
group, waiting for the port -- and the restart loop (one second doubling to two
minutes, unbounded, as 1.7.5 decided) are now functions both use. The chat
model's swaps, rollback and stand-down stay in `Supervisor`; behaviour there is
unchanged, and its existing lifecycle, recovery and stand-down tests pass as
before.

**The embedding server is a managed child** (`internal/supervisor/embed.go`).
`gobbonet serve` starts it after the chat model has loaded, so a GPU it is
allowed onto is fitted to the chat model first, with one command line on every
platform (`EmbedArgs`): `--embeddings --pooling mean`, `--ctx-size`,
`--batch-size` and `--ubatch-size` at `embed_ctx`, and `embed_gpu_layers`. The
Linux launcher used to leave both batch flags off; the page's sub-512-token
slicing covered for it.

- **Pinned.** GobboNet's own model is checked against its SHA-256 before every
  start. A missing or mismatched model is reported with what to do, and not
  retried in a loop; anything else that stops it is retried with backoff.
- **Found where each platform put it**: `<data_dir>/embeddings` (the Linux
  setup wizard's "Download Nomic") and then `model_dir` (where `launch.bat`
  downloads it), so no existing install downloads it again.
- **A server it did not start** already answering on the port is used as it is
  and looked at every 30 seconds; when it goes, GobboNet starts its own.
- **Idle stand-down** stops it after the chat model and brings it back after the
  chat model has reloaded. An `/embed` request wakes it on its own, so the first
  message after a stand-down still matches by meaning.
- Its output is in the console as `[embed]`, filtered like `[llama]`, and in
  `embed-server.log` beside `llama-server.log`.

**New keys** in `config.toml`, documented in the file:

| Key | Default | Meaning |
| --- | --- | --- |
| `embed_mode` | `"managed"` | `managed` starts and watches it; `external` uses `embed_url` as is; `off` disables semantic search |
| `embed_model` | `""` | empty is GobboNet's own model, found as above and pinned; a path is used as is, unchecked |
| `embed_gpu_layers` | `0` | CPU, as before |
| `embed_ctx` | `2048` | as before |

`managed` needs a local engine and an `embed_url` on this PC; without either it
acts as `external`, since there is nothing to start or the address is someone
else's. The roadmap's default path for `embed_model` became the empty value, so
the Windows location is found without being written into anyone's config.

**The launchers no longer start it.** `launch.bat` still downloads the model on
a Windows first run, into `models\`, checked against `EMBED_PIN_SHA256` as
before, and then leaves it to `gobbonet.exe`; its embedding launcher script,
wait loop and `EMBED_CTX`, `EMBED_GPU_LAYERS` and `EMBED_LOG_FILE` are gone (the
first two are config keys now). `EMBED_ENABLE=0` skips the download and writes
`embed_mode = "off"`. `gobbonet-launch` (both copies) starts only the server.
The pin lives in `launch.bat`, `internal/config/embed.go` and both copies of
`gobbonet-setup.py`; a test holds them, the file name and the download address
equal.

**Shown, not silent.** `/health-fileserver` reports `embed`: `running`,
`starting`, `restarting`, `standby`, `failed`, `external` or `off` -- the
roadmap's four, plus the transitions and a `failed` for a model that cannot
start -- with `embed_detail` saying why. CONFIG > Privacy Status gains a line
saying whether matching by meaning is on and, if not, why; the line under the
RAG Storybook ends with "by meaning: on" (or off, resting, restarting).
`gobbonet doctor` has an EMBEDDING SERVER section: mode, model, whether it
matches its pin, whether it answers, and the log. `gobbonet uninstall` removes
`embed-server.log` with the other logs.

Docs: TROUBLESHOOTING.md gains "Matching by meaning is off"; GO_SERVER.md,
RAG_INFO.md, AGENTS.md, installer-win/README.md and tests/README.md follow.

## Tests

- `internal/supervisor/embed_test.go` (new), with this test binary as the
  engine: it starts with the full flag set and marks its log; killed, it
  restarts after backoff through failures and comes back; a model that does not
  match its pin is never started or retried; no model says where it should be;
  a server it did not start is used until it goes, then its own starts; stand-
  down stops it and a wake brings it back; shutdown ends recovery. The chat
  model's stand-down calls its companion after unloading and its wake after
  loading.
- The existing supervisor tests (lifecycle, recovery, stand-down, process
  groups) pass unchanged on the shared process half, and under `-race`.
- `internal/config/embed_test.go` (new): defaults, validation, and where the
  model is looked for. `internal/server/embed_test.go` (new): `/health-fileserver`
  reports off, external and a failed managed server with its reason; who runs
  it for each mode, engine and address. `cmd/gobbonet/doctor_embed_test.go`
  (new): off, external, missing, 1.7's Windows location, a mismatched model, a
  model of your own. `cmd/gobbonet/uninstall_test.go`: the new log goes.
- `tests/test-embed-supervisor.py` (new): neither launcher starts it, in either
  copy; `launch.bat` still downloads and pins it, and `EMBED_ENABLE=0` writes
  `off`; the pin, file name and address agree in every place; the four keys are
  documented; the health report and the wake are wired.
- `tests/test-embed-status.mjs` (new): each state's words; Privacy Status shows
  it in the right colour and hides it for an older server; file:// asks nothing;
  the storybook readout appends it once the server has been asked; opening
  CONFIG and the card editor ask.
- `tests/test-engine-args.py`, `test-launch-gpu-detect.py`,
  `test-launch-cmd-flow.py`: `launch.bat` starts no llama-server at all, and the
  embedding command line is checked in Go.

The new tests fail on the round-7 tree.
