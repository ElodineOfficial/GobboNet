# The Go server

`gobbonet` is a single binary that serves the chat UI, proxies to llama.cpp, syncs
chat state across devices, and — when you ask it to — starts and supervises
llama.cpp itself.

It replaces the runtime half of `fileserver.ps1` + `launch.bat`'s monitor loop.
The setup half (hardware probe, model download) still lives in the launcher
scripts.

## Build

```sh
go build -o gobbonet ./cmd/gobbonet
```

Go 1.25+. No cgo, no runtime dependencies — the result is one file you can copy
next to `web/`.

## Releases

```sh
./build-release.sh
```

Cross-compiles for linux/amd64, linux/arm64, windows/amd64, darwin/arm64 and
darwin/amd64, and bundles each binary with `web/` into an archive under
`dist/<version>/` with a `SHA256SUMS`. Static, `-trimpath`, no cgo — a tester
unpacks it and runs it.

Builds are stamped `1.3-go-<short sha>` at link time and report it from
`gobbonet version`, the startup banner, and `/health-fileserver` — the last so a
tester can copy a build identity out of a browser without a terminal.

The script refuses to build from a dirty tree. A stamped sha that does not
describe the code inside the binary is worse than no stamp: a bug gets reported
against a commit that does not contain it and cannot be reproduced.
`--allow-dirty` overrides, and marks the version `-dirty` so it stays obvious.

Note that `web/chat.html` is bundled and the repo-root `chat.html` is not — the
root file is the older Windows-lineage copy without the `/llm/jobs` client.

## Run

```sh
./gobbonet                       # serve, using the discovered config
./gobbonet serve --config PATH   # serve, using a specific config
./gobbonet set-password          # set or change the access password
./gobbonet check                 # probe the upstream and report what it says
./gobbonet config get llm_url    # read one setting (for launcher scripts)
./gobbonet config set llm_url http://192.168.1.100:8080
./gobbonet config keys           # list every settable key
```

Every subcommand takes `--config PATH`, `config get`/`set` included — a launcher
that pins an explicit config must be able to read and write that same file
rather than whichever one discovery happens to find.

The first run writes a fully commented `config.toml`, tells you where, and exits.
Read it, adjust `llm_url` and `server_exe`, and run again.

## Config discovery

First hit wins:

1. `--config PATH`
2. `$GOBBONET_CONFIG` (`$GEMMA_CONFIG` still works, with a deprecation warning)
3. `$XDG_CONFIG_HOME/gobbonet/config.toml`
4. `~/.config/gobbonet/config.toml`
5. `./config.toml` — matches the Windows layout, next to `launch.bat`

Config and data are deliberately separate: config in `~/.config/gobbonet`, data
(state backup, models, logs) in `~/.local/share/gobbonet`. Nothing large is ever
written next to the config file — `model_dir` defaults to `<data_dir>/models`,
not to a directory beside `config.toml`.

Relative paths inside the config resolve against the config file's own directory,
so a portable install that keeps everything in one folder behaves the way the
Windows tree always did. That is what `model_dir = "./models"` opts into.

`gobbonet config get` / `set` exist so the launcher scripts never have to parse
TOML — Go stays the only TOML parser in the tree. `set` edits the file line by
line, so every comment survives.

## Local mode and remote mode

Set `server_exe` to a llama-server binary for **local mode**: this process starts
llama.cpp, restarts it if it crashes (exponential backoff), and hot-swaps models
on request.

Leave `server_exe` empty for **remote mode**: `llm_url` points at a server
something else manages.

Both modes have full feature parity except hot-swap. Auth, state sync, generation
jobs, web search, RAG, characters, personas, lore, and everything else behave
identically. `/health-fileserver` reports which mode is active and whether
hot-swap is available, and the frontend adapts.

A non-empty `server_exe` pointing at a file that doesn't exist is a **fatal
error**, not a quiet fall back to remote mode. Non-empty is a statement of
intent; the old behaviour turned one typo into a server that proxied into a void
while reporting `"status":"ok"`.

## Passwords

`access_secret` holds an Argon2id hash. A legacy `salt:hash` SHA-256 secret from
a Windows install still verifies and is **rewritten as Argon2id on the next
successful login** — users migrate by logging in once, with no forced reset.

`POST /login` is rate limited per source IP (burst of 10, refilling one every six
seconds). Constant-time comparison stops an attacker learning the password a byte
at a time; it does nothing about simply trying a lot of passwords.

## Host header

The server binds `0.0.0.0` by default, which puts DNS rebinding in scope. IP
literals, `localhost` and any `*.local` name are always accepted — that covers
normal LAN use, where you type an address rather than a name. Any other hostname
must be listed in `allowed_hosts`.

## Generation jobs

`/llm/jobs*` holds the upstream connection so a reply survives the browser
navigating away, the tab closing, or a phone locking.

Jobs are held **in memory** — no disk spooling, no cancel flag files. Cancellation
is a `context.Context` that propagates into the upstream request, so a cancel
frees the llama.cpp slot immediately.

Poll responses carry the raw SSE bytes in a `chunk` JSON string rather than
base64, saving 33% of the bandwidth. The offset protocol still counts bytes, so
`read` aligns each window to a UTF-8 character boundary: it extends forward when
the completing bytes have arrived, and trims back only when the tail character is
genuinely still in flight. Without that, Go's JSON encoder turns a split
character into U+FFFD and silently corrupts the stream.

## Model identification

`model_dir` is scanned on demand and every GGUF's header is read for ground
truth — architecture, embedded chat template, context length. The same
classifier runs against a remote server's `/props`, so a model is identified by
one set of rules whether it is local or not.

Two things the scan deliberately does:

**Context length always comes from the metadata.** The filename hard overrides
(llama3, mistral-small, mistral-nemo, granite, command-r) decide which chat
template to use and nothing else. Advertising a model's theoretical window when
the server was launched with `--ctx-size 8192` makes the UI offer a context
llama.cpp rejects on every request past the real limit.

**Multimodal projectors are excluded.** Vision models ship `mmproj-*.gguf` next
to the weights, so a plain scan finds them. llama-server takes a projector via
`--mmproj` alongside a real `--model`; handed one as `--model` it refuses to
load. The header is authoritative (projectors declare architecture `clip`); the
filename convention only decides files whose header cannot be read.

The `family` a model reports is a key `chat.html` looks up in its stop-string
table, by exact match. Architecture-derived families are normalised to that
vocabulary — `qwen2`, `qwen3moe` and `phi3` all report `qwen`/`phi` — because a
miss means the model's turn markers get rendered to the user as content.

## Process supervision

In local mode llama-server runs in its own process group, and the group id is
captured at launch rather than derived later. Once the child has been reaped its
PID is gone from the process table, so `Getpgid` fails — while the rest of the
group is still running. Stopping therefore sweeps the group by id and confirms
it is empty (`kill(-pgid, 0)`) rather than trusting the leader's exit, which
says nothing about its helpers.

This matters because the failure is silent and expensive: an orphaned helper is
reparented to init, disappears from any walk of our own descendants, and keeps
holding GPU memory. The next model then fails to allocate a backend buffer, and
nothing in that error points at the real cause.

## Tests

```sh
go test ./...
go test -race ./...
```

`internal/server/conformance_test.go` is the important one. It pins the wire
contract `chat.html` depends on — exact field names, exact headers, exact status
codes — because the `/state/info` regression that motivated this migration was
invisible to every other kind of check: the wildcard route swallowed the request,
the client parsed the body without error, and boot-time conflict detection just
silently stopped firing.

## Layout

```
cmd/gobbonet/          CLI entry point
internal/config/       TOML config, discovery, mode detection, get/set
internal/auth/         sessions, Argon2id + legacy migration, rate limit
internal/server/       routing, auth gate, health endpoint
internal/state/        /state and /state/info
internal/models/       GGUF parsing, classifier, model metadata endpoints
internal/jobs/         in-memory detached generation
internal/proxy/        streaming reverse proxy
internal/supervisor/   llama-server lifecycle, hot-swap, rollback
internal/static/       static file serving
internal/httpx/        response helpers, CORS, MIME
web/                   chat.html and friends
```
