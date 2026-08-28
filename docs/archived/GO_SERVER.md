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

Builds are stamped `<VERSION>-go-<short sha>` at link time — the release half
read from the `VERSION` file at the repo root, the sha from `git rev-parse`, so
`1.5.8-go-afb7e0d`. `installer/build-installer.sh` reads the same file and
stamps the same string, which is why the two cannot drift apart again. Every
build reports it from `gobbonet version`, the startup banner, and
`/health-fileserver` — the last so a tester can copy a build identity out of a
browser without a terminal.

The release half is **upstream's number, not ours**. This port tracks a
GobboNet release; a build stamped `1.5.1-go-<sha>` on a tree carrying 1.5.8's
frontend names a release it is not built from, and says so everywhere the
version is reported. `VERSION` therefore holds the upstream release, and
`internal/version/version_test.go` fails the suite when it disagrees with the
nearest upstream release tag reachable from `HEAD`:

```
VERSION is "1.5.1" but the nearest upstream release tag is v1.5.8.
Every build stamped from this tree reports 1.5.1-go-<sha>, which names a
release it is not built from. Set VERSION to 1.5.8, or explain the gap here.
```

The tag is the check and not the source, because a release build cannot assume
a clone with tags fetched. Where there are none — a shallow clone, an export —
the test skips and names what it could not verify.

So: after merging an upstream release, set `VERSION` to that release, commit,
and run the build. Nothing else carries a version literal.

The script refuses to build from a dirty tree. A stamped sha that does not
describe the code inside the binary is worse than no stamp: a bug gets reported
against a commit that does not contain it and cannot be reproduced.
`--allow-dirty` overrides, and marks the version `-dirty` so it stays obvious.

The bundled `web/` directory is generated, not committed: `stage-web.sh` copies
the repo-root frontend (`chat.html` plus `js/` and `css/`) into it and derives
`favicon.ico` from `gobbonet.ico`. `build-release.sh` runs it for you. Keeping a
second committed copy of 40 upstream files was how the fork previously drifted
without anything reporting it.

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

The UI is on **9066** and llama.cpp on **11437**. Neither is the number it used
to be. 8080 is the most contended port on a developer machine — and on Windows
the dynamic ranges Hyper-V, WSL2 and Docker Desktop reserve can swallow it, so
the bind fails in a way `netstat` cannot explain. 11434 is Ollama's default,
which was worse than a collision: the launcher saw *something* answering there,
concluded llama-server was already up, skipped starting its own, then found
nothing healthy and restarted. Upstream moved both in 1.5.8 and this follows.

An existing install does not move. `config.toml` is written with explicit values
on first run, so only a fresh one sees the new defaults.

Unlike the launcher scripts there is no `.gobbonet-port` file and no silent
clamp to 1024–32767. The port is already a config key the installer writes and
`config set listen_port` edits; a second file saying the same thing is a second
thing to disagree. A port outside 1–65535 is an error, not a substitution — the
reasoning for staying under 32768 is in the generated file's comments, where
someone choosing a port will actually read it.

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

`perf.toml` is the one other file in the config directory, and it is config
rather than data: see **Runtime tuning** below.

Relative paths inside the config resolve against the config file's own directory,
so a portable install that keeps everything in one folder behaves the way the
Windows tree always did. That is what `model_dir = "./models"` opts into.

`gobbonet config get` / `set` exist so the launcher scripts never have to parse
TOML — Go stays the only TOML parser in the tree. `set` edits the file line by
line, so every comment survives.

## Runtime tuning

`ctx_size`, `gpu_layers` and `kv_cache_type` are llama-server launch arguments,
and the settings panel can change them without anyone editing a file. It reads
and writes `/perf`, then posts the model it already has to `/swap-model` to
apply — deliberately reusing the hot-swap path, so there is one restart
mechanism with one lock and one status feed rather than two that can race.

The override lives in a **`perf.toml` beside `config.toml`**, not in it.
`config.toml` is the auto baseline: `installer/gobbonet.nsi` writes `ctx_size`
and `kv_cache_type` into it from the hardware probe, and off Windows a human
writes them by hand. Reset deletes `perf.toml` and the baseline is simply there
again.

Writing into `config.toml` instead would be simpler and wrong. The first save
destroys the probe's numbers, after which "reset to auto" can only mean the
compiled-in 16384/99/q8_0 — which is exactly backwards on the machines that
need reset most. A 6GB card probed down to `ctx_size = 8192` would be reset *up*
to 16384 and stop loading, by the button labelled "put it back how it was".

Two things follow from that split:

`config get ctx_size` reports `config.toml`, because that is the file `config
set ctx_size` writes. Only the serve path overlays `perf.toml`. A getter and a
setter that disagreed about which file they meant would be worse than either
layer alone.

A `perf.toml` that is unparseable or out of range **stops the server**, naming
the file and the value. `fileserver.ps1` warns and falls back to its auto
values; this does not. The file is only ever written by code that validates
first, so a bad one means a hand edit — and running settings the user did not
choose, having noticed they did not choose them, is the quiet substitution this
port keeps removing. Deleting the file is always the way out, and the error says
so.

Startup reports an override when one is in force. A model that fails to load
because of a context size set weeks ago is otherwise a mystery with no visible
cause.

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

## Platform coverage, and what is missing off Windows

The **server** is fully cross-platform. `build-release.sh` cross-compiles
linux/amd64, linux/arm64, windows/amd64, darwin/arm64 and darwin/amd64, and every
runtime feature above works identically on all five: auth, state sync, generation
jobs, proxying, hot-swap, GGUF identification, process supervision.

**First-run setup does not.** Hardware detection (`hardware-probe.ps1`) and the
guided model download (`launch.bat`, wrapped by the NSIS wizard) are PowerShell
and batch, and they are what turn a bare binary into a working install. On
Windows the installer runs them for you. On Linux and macOS there is currently no
equivalent: you write `config.toml` yourself and fetch a GGUF yourself.

That is a deliberate scope line, not an oversight. Bringing the two into line
means one of:

1. **Leave it.** Cheapest. Non-Windows first run stays manual.
2. **Port detection to Go** as `gobbonet probe`, emitting the same JSON and INI
   (`nvidia-smi`, `/sys/class/drm`, `sysctl` on Darwin). NSIS would then call the
   Go binary, `hardware-probe.ps1` retires, and all three platforms share one
   flow — at the cost of owning hardware-detection edge cases that upstream's
   probe spent ~2,000 lines learning, on platforms it never targeted.
3. **Port only the catalogue.** It is already machine-readable as
   `installer/models.ini`; a `gobbonet setup` CLI could drive the download while
   probing stays behind a platform-specific interface.

Current state is (1). (2) is the one that actually retires `launch.bat` and gets
Unix-philosophy parity rather than a Windows installer with two second-class
ports hanging off it, and is the recommended next step — as its own piece of
work, not folded into a release.

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

A POST past `job_max_concurrent` (default **1**) **supersedes** rather than
queues or refuses. It used to answer 429, and both halves of that were wrong.
llama-server runs one slot, so a cap of four only bought a queue it could not
serve: press Stop, send again, and the new generation sat behind a request still
running because llama-server had not noticed the disconnect yet. And a 429 to
someone who just pressed Send is a refusal, when what they want is plainly the
new generation and not the old one.

The wait is the part that matters. The oldest live work is cancelled and then
**waited out** — up to five seconds — before the new request is dispatched.
Dispatching the moment the context is cancelled would queue the new request
behind a connection llama.cpp has not finished tearing down, which is precisely
the stall this removes. The signal is the worker goroutine returning, which
happens strictly after the upstream response body is closed.

Only enough work is shed to get under the cap, oldest first. At the default of 1
that is upstream's behaviour exactly; above it, shedding every live worker would
throw away generations that had room to run. And shedding happens *after* the
request body is validated, so a malformed request from a buggy client cannot
kill a generation the user is reading.

Poll responses carry the SSE bytes base64-encoded in `chunk_b64`, and the window
is a plain byte range with no character alignment — byte-for-byte the framing
`fileserver.ps1` defined. `js/03-generation.js` reads `chunk_b64` and nothing
else, and it does not error on an unrecognised payload: it leaves the offset
where it was and polls a healthy job forever with nothing to show. Character
splits are the client's problem to solve and it already does, decoding with
`TextDecoder(..., {stream: true})`.

An earlier revision sent raw UTF-8 in a `chunk` string to save the 33% base64
overhead. That is why the alignment logic existed — Go's JSON encoder turns a
split character into U+FFFD — and it is why both are gone.

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

## Web search

`/search/*` goes straight to `search_url` — `https://ollama.com/api` by default
— carrying the browser's own `Authorization` header and nothing of ours. It is
the only route that leaves the machine in local mode, and only when a user switches
search on and supplies a key. (In remote mode, `/llm/*` can also leave the machine
if `llm_url` is configured with a LAN or cloud inference endpoint.)

Upstream ran a relay for this until 1.6.0: a hidden-window PowerShell started
from `launch.bat` with `-EncodedCommand` and 4,656 characters of base64, binding
11435 and forwarding authenticated traffic to that same host. 1.6.0 deleted it
(`Handle-Search` in `fileserver.ps1` makes the call directly) because the shape
— encoded PowerShell, hidden window, listener, external relay — is what
antivirus scores as command-and-control largely regardless of payload.

This port never started that process, so a default of `127.0.0.1:11435` meant
`/search` answered 502 on every install where search was turned on. Now the
proxy points at the API itself; it already strips our session cookie, which
matters more against a third-party host than a loopback one.

`/search/health` is answered here rather than forwarded, because the client
probes it before every search and the API has no such route. It reports that the
route is configured, not that the internet is reachable — an unauthenticated
probe cannot tell "offline" from "bad key", and the search request that follows
reports the real failure with the upstream's own status.

## Sanitising values from a downloaded file

1.6.0 added three scrubbers to the PowerShell — `ConvertTo-BatchSafe`,
`ConvertTo-CmdArgSafe`, `ConvertTo-CmdPathSafe` — because model ids, families,
template names and KV cache types are lifted out of a GGUF the user downloaded
and then written into a `.cmd` that `launch.bat` CALLs. A quote or an ampersand
in `general.architecture` is arbitrary code before the chat window opens.

None of that machinery is ported, because the sink does not exist here:
llama-server is started with an argv slice through `os/exec`, so there is no
shell, no quoting, and no generated script. `kv_cache_type` is checked against an
allowlist (`f16`, `q8_0`, `q4_0`) rather than scrubbed, which is stricter than
stripping metacharacters out of it.

The one clamp that is ported is `general.architecture` itself
(`models.sanitiseArch`), at the same point upstream clamps it. It becomes the
`id` and `family` for every model that reaches the generic branches, and both go
to the browser in `active-model.json`; clamping at the source means a consumer
added later cannot reopen the hole by forgetting.

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
internal/config/       TOML config, discovery, mode detection, get/set,
                       the perf.toml tuning overlay
internal/auth/         sessions, Argon2id + legacy migration, rate limit
internal/server/       routing, auth gate, health endpoint, /perf
internal/state/        /state and /state/info
internal/models/       GGUF parsing, classifier, model metadata endpoints
internal/jobs/         in-memory detached generation
internal/proxy/        streaming reverse proxy
internal/supervisor/   llama-server lifecycle, hot-swap, rollback
internal/static/       static file serving
internal/httpx/        response helpers, CORS, MIME
web/                   chat.html and friends
```
