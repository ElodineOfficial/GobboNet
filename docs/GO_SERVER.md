# The Go server

`gobbonet` is a single binary that serves the chat UI, proxies to llama.cpp, syncs
chat state across devices, and — when you ask it to — starts and supervises
llama.cpp itself.

It replaced the runtime half of the 1.7 PowerShell server (`fileserver.ps1`)
and `launch.bat`'s monitor loop; 1.8.0 removed both, so it is the only server.
The setup half (hardware probe, model download) still lives in the launcher
scripts.

## Build

```sh
go build -o gobbonet ./cmd/gobbonet
```

Go 1.25+. No cgo, no runtime dependencies — the result is one file, with the
chat page compiled in (run `bash ./scripts/stage-web.sh` first; see below).

## Releases

```sh
bash ./scripts/build-release.sh
```

Cross-compiles for linux/amd64, linux/arm64, windows/amd64, darwin/arm64 and
darwin/amd64, and bundles each binary with the fallback model catalogue
(`models.ini`) into an archive under `dist/<version>/` with a `SHA256SUMS`.
There is no `web/` beside it any more: the page is inside the binary.
Static, `-trimpath`, no cgo — a tester unpacks it and runs it.

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

The frontend is compiled into the binary. `stage-web.sh` copies the repo-root
frontend (`chat.html` plus `js/` and `css/`) into `internal/webui/assets` and
derives `favicon.ico` from `gobbonet.ico`; `go:embed` takes it from there.
`build-release.sh` and `make-zip.sh` run it for you, and a build that skips it
produces a binary with no page in it, which the server reports rather than
serving 404s.

It used to be staged into `./web` and shipped beside the executable. Keeping a
second *committed* copy of 40 upstream files was how the fork drifted without
anything reporting it — and staging solved that only inside the repo. In a
user's install the same two-copy problem remained, and the copy beside the
binary won: dropping a new release over a folder replaced the root frontend and
left `web/` alone, so the server went on serving the old page and every
server-side feature of the release looked missing. One artifact cannot drift
from itself.

A disk directory is still served if `web_root` names one, layered over the
built-in copy so a partial override is a modified page rather than a broken one.
It is never discovered — see `internal/server/webroot.go`.

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

A list key takes words (`config set allowed_hosts "a.example b.example"`) or,
for items with spaces in them, a JSON array:
`config set model_dirs '["/home/me/My Models", "/mnt/models"]'`.
`config get --json KEY` prints a value as JSON, so a script reading a list
gets the items back whole (1.8.0).

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

## When the LAN bind is refused

`listen_host` defaults to `0.0.0.0` so a phone on the same network can reach the
UI. When the machine refuses that bind, the server takes loopback instead and
keeps running rather than exiting.

That is deliberate: this process serves the chat page. Failing outright meant a
user whose machine would not allow a wide bind lost desktop chat entirely while
llama.cpp stayed healthy on its own port — which reads as a front-end bug. Phone
access needs the wide bind; chat on this machine never did.

The fallback only ever **narrows** what is exposed. There is no path from
loopback out to the network, so a server configured to stay local cannot be
widened by a failure. A machine that can bind the network still does.

It applies to permission failures (`EACCES`, `WSAEACCES`), addresses this machine
does not have (`EADDRNOTAVAIL` — a `listen_host` pinned to a LAN address DHCP
later moved), and unsupported families (`::` with IPv6 off). It deliberately does
**not** apply to `EADDRINUSE`: the port is occupied, and moving somewhere quieter
would hide the most common startup failure there is.

The banner reports the address actually bound, never the configured one, and
`/health-fileserver` carries the same fact for anyone who cannot read a terminal:

```json
{ "lan_access": false, "listen_host": "127.0.0.1", "listen_port": 9066,
  "lan_bind_denied": "listen tcp 0.0.0.0:9066: bind: permission denied" }
```

On Windows, a bind refused on *every* address usually means the port sits in a
range reserved by Hyper-V, WSL or Docker Desktop. `netstat` shows nothing
listening because nothing is — the range is reserved, not occupied. Check with
`netsh interface ipv4 show excludedportrange protocol=tcp` and pick a port
outside every listed range.

## Choosing the address and port from CONFIG

Since 1.7.7, CONFIG's *Phone & Other Devices* box shows the addresses phones
can use and saves `listen_host` / `listen_port` through `GET`/`POST /lan`
(`internal/server/lan.go`). A save applies on the next start. Nothing rebinds
under the page that asked.

**A `listen_host` naming one specific network address is served on loopback
too** (`127.0.0.1`, or `::1` for an IPv6 address). Pinning narrows what the
network can reach, never what this machine can: the launchers open and probe
`127.0.0.1`.

**`POST /lan` refuses a save that would not start:**

- an address this machine doesn't have;
- a port outside 1024–32767 on Windows (`launch.bat`'s bounds) or 1024–65535
  elsewhere;
- the engine's ports;
- a port that is taken right now.

It also refuses a request whose `Origin` is not this server.

**On Windows it also writes `.gobbonet-port`.** `launch.bat` takes the port from
there, and would otherwise put the old one back.

## Orphaned llama-server processes

Stopping llama-server is handled in-process: Ctrl+C, SIGTERM, a model swap and an
unexpected child exit all run the same group cleanup, which signals the whole
process group so llama.cpp's helpers cannot survive holding VRAM and the port.

None of that runs if `gobbonet` itself is killed without warning — `taskkill /F`,
Task Manager's "End task", a panic, an OOM kill, or closing the console window a
shortcut opened. On Windows the child is therefore also assigned to a **job
object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the kernel terminates the
whole tree when this process dies for any reason at all. Job membership is
inherited, so llama-server's own helpers are covered too.

There is no equivalent on Unix and none is faked. `PR_SET_PDEATHSIG` fires on the
death of the creating *thread*, and Go does not guarantee the runtime thread that
forked the child outlives it — a retired thread would kill a healthy
llama-server mid-generation. A rare leak after an abnormal exit is the better
trade. On Unix only a `SIGKILL` of `gobbonet` leaks, and that is a deliberate act
rather than the routine "close the window" gesture it is on Windows.

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

The chat page can edit the file in use: CONFIG > **Config File**, from a browser
on the PC GobboNet runs on (never from another device, since the file decides
which programs GobboNet starts). It hides `access_secret` and `llm_api_key`,
refuses a save that would stop the next start, and keeps the previous version
as `config.toml.bak`. Changes apply on the next start.

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
the file and the value. The PowerShell server warned and fell back to its auto
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
   `catalog/models.ini`; a `gobbonet setup` CLI could drive the download while
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

For DuckDNS, Tailscale MagicDNS (short names or full `.ts.net` names), or your
own domain, first open GobboNet by IP address or `localhost` and sign in. In
**CONFIG > Network access**, add the exact names you control, one per line,
then choose **SAVE NETWORK NAMES**. A pasted HTTP(S) address is accepted; only
its hostname is saved. Changes apply immediately and survive restart. These
are server settings, separate from the other CONFIG settings and their Cancel
button. To remove the name you are currently using, connect by IP first.

An `unrecognised Host header` response means the request reached GobboNet but
its hostname is not trusted. Pointing DuckDNS at the same IP does not make its
Host header the same as a request to the IP. Do not disable the check or allow
all DuckDNS/Tailscale domains: an unrelated hostname can resolve to your IP too.

For existing versions without the panel, add the names at the **top level** of
the active `config.toml` (before any `[table]` headings), then restart GobboNet:

```toml
allowed_hosts = ["my-goblin.duckdns.org", "desktop.your-tailnet.ts.net", "desktop"]
```

The CLI alternative is `gobbonet config set allowed_hosts "my-goblin.duckdns.org desktop.your-tailnet.ts.net desktop"`.
Use your own names. This setting does not configure DNS, port forwarding, TLS,
or Tailscale routing. Password authentication still applies; a new hostname
may ask you to sign in again. Use a private VPN for remote access.

## Generation jobs

`/llm/jobs*` holds the upstream connection so a reply survives the browser
navigating away, the tab closing, or a phone locking.

Jobs are held **in memory** — no disk spooling, no cancel flag files. Cancellation
is a `context.Context` that propagates into the upstream request, so a cancel
frees the llama.cpp slot immediately.

### A job always reaches a terminal status

The frontend polls until a job stops being `running`, so anything that leaves it
there is a spinner that never ends with nothing logged to explain it.

`http.Client.Timeout` cannot be used to prevent that: it covers the whole request
*including* the streaming body, so any value large enough for a real generation is
far too large to catch a wedged upstream. The bounds are staged instead, the same
way `internal/proxy` does it:

| Stage | Window | Catches |
|---|---|---|
| Dial | 10s | upstream not listening |
| First byte | 5 min, `reply_start_timeout_seconds` | socket accepted, nothing sent — a deadlocked llama.cpp, a GPU hang, a firewall that DROPs |
| Gap between chunks | 10 min | a stream that stalls mid-generation with no EOF |
| Total runtime | none, unless the user sets one | only the limit the user chose in CONFIG |

The first-byte window is generous on purpose — a 40K-context prefill can run well
past thirty seconds before the first token — and since 1.7.8 it is
`reply_start_timeout_seconds` in `config.toml` (default 300, 10 to 86400), for a
long prompt read on the CPU. It applies to the jobs every reply goes through and
to the `/llm` route lore compression uses; `/search` and `/embed` keep 5 minutes.
A model load has its own bound, `model_load_timeout_seconds` (default 180, 10 to
7200): start-up, a swap, the reload after idle stand-down, and a restart from
CONFIG > Performance. `/swap-status` reports it as `load_timeout_seconds`, and the
page waits that long plus 30 seconds, so the server's reason always arrives
before the page gives up. Both messages name the setting.

`/swap-model` takes `{"file": "<name>.gguf"}`, a plain file name in the models
folder. Since 1.8.0 it also takes `"auto": true` for a switch the page makes on
its own (model links, #52): that one is refused with 409 and `"busy": true`
while any reply is being written for any device, and `/swap-status` carries
`"busy": true` for as long as that lasts. A swap picked from the model menu
has no `auto` and is not held.

When a load fails, `/swap-status` also carries `cause` (`engine_too_old`,
`incomplete_file`, `out_of_memory`, `file_not_found`), `advice` (one plain
sentence for it) and `log` (`llama-server.log`, the file's name only), beside
the engine's own line in `message` (1.8.0, #67). The cause is read from the
whole of the engine's output, so llama.cpp's sign-off line no longer hides it;
see `internal/supervisor/cause.go`. Every engine run starts a marked section of
`llama-server.log`, which `gobbonet doctor` reads for LAST MODEL LOAD.

`/model-check` is CHECK FILE: POST `{"index": N, "source": "catalogue"}`
re-hashes an installed catalogue model against the catalogue's pinned SHA-256
with no network; `"source": "huggingface"` first asks huggingface.co for the
checksum it records, and is sent only from the "Ask HuggingFace" button. GET
polls. `/gpu` lists the devices the engine itself sees (`llama-server
--list-devices`, run once and cached) and saves `gpu_device` and
`gpu_prime_offload` (1.8.0, #72). The between-chunks watchdog
bounds the **gap**, never the total, so a long healthy generation is never cut off.

**There is no fixed total cap** (since 1.7.7). There used to be one — thirty
minutes — and it stopped replies that were still streaming. How long a reply may
run is now the user's call: CONFIG → *Infinite Runtime Bug Fix* sets a limit,
and the page sends it with each job as `POST /llm/jobs?max_runtime_s=N`, so the
server enforces it too and it still holds with the tab closed. The server allows
15 seconds past it (`pageCapGrace`) so that while the page is open, the page's
own stop — which carries a note explaining it — lands first. No parameter, or
`0`, means no limit; anything else that is not a whole number of seconds is
refused with 400 before the running generation is touched. Memory stays bounded
regardless: one job's buffer is capped at 128 MiB.

Why a job stopped travels as a context *cause*, because a watchdog trip and a
user pressing Stop are the same cancellation at the socket. Only the cause
separates them, and reporting a generation that died on its own as `cancelled`
tells someone their own click stopped a reply they were waiting for. A watchdog
trip and a runtime-cap expiry both report `error` with a message naming which
bound was hit; a real cancellation still reports `cancelled`.

Bytes that arrived before a stall stay readable — a half-written reply on screen
is not replaced by an error.

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
the PowerShell server defined. `js/03-generation.js` reads `chunk_b64` and nothing
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
the only route that passes a browser's request out of the machine, and only when
a user switches search on and supplies a key. (GobboNet itself fetches two
static lists when asked: the model catalogue and, from 1.7.9, the endorsed mod
list when BROWSE is clicked; see docs/ENDORSED-MODS.md.)

Upstream ran a relay for this until 1.6.0: a hidden-window PowerShell started
from `launch.bat` with `-EncodedCommand` and 4,656 characters of base64, binding
11435 and forwarding authenticated traffic to that same host. 1.6.0 deleted it
(`Handle-Search` in the PowerShell server made the call directly, and this
server does the same) because the shape
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

## Verifying a downloaded model

A model download is checked against a SHA-256 before it is moved into place.
There are two possible sources for that hash and they are **not** equal in
weight:

- **the catalogue's `sha256`** — does not come from the host serving the
  weights, so it establishes authenticity. HuggingFace and the catalogue
  publisher would both have to lie, in agreement.
- **HuggingFace's LFS pointer** — comes from the same host as the file. It
  proves the transfer was not corrupted and nothing more. A compromised host, or
  a TLS-intercepting proxy, supplies both the file and the hash it is checked
  against.

The catalogue pin wins where both exist. Where they **disagree** the download is
refused before a byte transfers: one of the two is wrong, fetching gigabytes to
compare against a disputed hash achieves nothing, and quietly preferring the pin
would hide a catalogue that has drifted from the file it describes. The message
prints both values and names the file.

Where neither source has a hash, the size floor in `modelfetch` is the backstop —
HuggingFace serves an LFS pointer of a few hundred bytes instead of the weights
when something goes wrong upstream, and it arrives as a clean 200.

`models.ini` entries may carry a pin, which is the useful case for a bundled,
private or air-gapped catalogue that the operator controls:

```ini
[1]
display=Llama 3.2 3B Instruct
repo=bartowski/Llama-3.2-3B-Instruct-GGUF
file=Llama-3.2-3B-Instruct-Q8_0.gguf
sha256=3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7
```

Optional everywhere. Case and surrounding whitespace are normalised, so a pasted
digest is not read as a mismatch. A malformed value is dropped **and logged**,
because silently ignoring a broken security control leaves an operator believing
a download is pinned when it is not.

`require_checksum = true` in `config.toml` turns an unverifiable download into an
error rather than falling back to the size floor. It is **off by default**, which
is compatibility rather than preference: the shipped `models.ini` carries no
hashes and the published catalogue still sends `null` for every entry, so turning
it on by default would refuse every download on a stock install. Turn it on when
every entry in your catalogue has a pin — at that point a missing hash means the
catalogue is wrong and you want to hear about it.

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

### The embedding server (1.8.0)

The embedding server that lets the RAG Storybook match by meaning is a second
managed child, through the same code (`internal/supervisor/managed.go`): its own
process group, the Windows kill-on-close job, the same sweep on stop and the
same restart loop, one second doubling to two minutes. Up to 1.7.9 a launcher
script started it and nothing watched it.

`embed_mode` in `config.toml` says who runs it. `managed` (the default) starts
it after the chat model has loaded, on `embed_url`'s port, with
`EmbedArgs` (`--embeddings --pooling mean`, batch sizes raised to `embed_ctx`,
`embed_gpu_layers` on the GPU, 0 by default). It needs a local engine and an
`embed_url` on this PC; otherwise it acts as `external`, which uses `embed_url`
as it is. `off` starts nothing.

GobboNet's own model, `nomic-embed-text-v1.5.Q8_0.gguf`, is looked for in
`<data_dir>/embeddings` (where the Linux setup wizard puts it) and then in
`model_dir` (where `launch.bat` downloads it), and is checked against its SHA-256
pin before every start. A missing or mismatched model is reported, never retried.
A server GobboNet did not start, already answering on the port, is used as it is
and looked at again every 30 seconds; GobboNet starts its own when it goes.
Idle stand-down stops it after the chat model and brings it back after the chat
model has reloaded, and an `/embed` request wakes it on its own.

`/health-fileserver` reports it as `embed` (`running`, `starting`, `restarting`,
`standby`, `failed`, `external` or `off`) with `embed_detail` saying why; Privacy
Status and the line under the RAG Storybook show it, and `gobbonet doctor` has
an EMBEDDING SERVER section. Its log is `embed-server.log` beside
`llama-server.log`.

### MCP servers (1.8.0)

An MCP server is a program that offers tools a character can call. Each is an
`[[mcp_server]]` table in `config.toml` (`name`, `command`, `args`, `env`,
`enabled`, which starts `false`), added in CONFIG > Advanced > MCP Servers or by
hand. `internal/mcp` runs them, through the third managed-process path in the
supervisor package (`supervisor.Child`): its own process group, the Windows
kill-on-close job, the same sweep on stop. A server is started by direct exec
of its argument list, never through a shell, the first time a tool list or a
call needs it, and runs until it is switched off, changed, or GobboNet stops.
One that exits is started again on the next use, after a wait that doubles from
one second to two minutes. Its error output goes to `mcp-<name>.log` beside
`llama-server.log`, with GobboNet's own lines about it; neither ever holds a
tool's arguments or results.

It inherits only `PATH`, `HOME` and their like (the official MCP SDKs' list,
plus the locale and temp-folder names, and the proxy and certificate settings
`npx -y` and `uvx` need to fetch a server behind a company proxy) from
GobboNet's environment, never a `GOBBONET_` variable, plus its own `env`
table.

The client is small and our own: newline-delimited JSON-RPC 2.0 over stdio,
`initialize`, `tools/list` (paged) and `tools/call`, answering the server's
`ping`. Resources, prompts, sampling, roots, elicitation and the remote HTTP
transport are not offered. It asks for MCP `2025-06-18` and accepts
`2024-11-05` to `2025-11-25`. A call that runs past `mcp_call_timeout_seconds`
(30 by default) is cancelled at the server. Text results reach the character as
they are; an image, audio or a binary file is named in a line saying it was not
shown. A result is cut to the chat page's `toolResultMaxChars`.

| Route | Who | What |
|---|---|---|
| `GET /mcp/tools[?refresh=1]` | any signed-in device, GobboNet's own page | every server, its state and, once running, its tools; starts enabled servers |
| `POST /mcp/call` | any signed-in device, with an `Origin` that is this server | `{server, tool, arguments, max_chars}`: the server must be on and list the tool |
| `GET /mcp/servers` | any signed-in device, GobboNet's own page | the tables and their state; `env` values only to this PC |
| `POST /mcp/servers` | `disable`: any signed-in device; `save`, `enable`, `remove`: a browser on this PC | `{action, name, server}`; the file is checked as `Load` reads it before it is written |

"This PC" is the Config File editor's test (`fromThisPC`): loopback, a
loopback `Host`, no forwarding headers. A browser sends `Origin` on every POST,
so requiring it on `/mcp/call` keeps every other website from making a call,
even on an install with no password. Saving MCP settings in the Config File
editor applies them at once, as the box does. `gobbonet doctor` has an MCP
SERVERS section.

On Windows, a command such as `npx` is `npx.cmd`, which Windows runs through
`cmd.exe` however it is started. Name `node.exe` and the script instead where
a server's arguments hold `&`, `|`, `%` or quotes.

### The update button (1.8.0)

ABOUT > CHECK FOR UPDATES. `internal/update` reads GitHub's release list
(`update_releases_url`), only when the button is pressed. It takes a release
only from its signed `gobbonet-update.json`, ed25519 with a key built into the
program, and installs only a later release, or a later build of the same one
(its serial, `version.Stamp`, is the commit time). The download's and the
program's SHA-256 are pinned; the new program is run once before it is moved
into place, and the old one waits beside it as `.old` until the next start.
docs/UPDATES.md has the maintainer's side.

| Route | Who | What |
|---|---|---|
| `GET /update/check` | any signed-in device, GobboNet's own page | `status` (`available`, `current`, `manual`, `unverifiable`, `off`, `dev`, `error`), the offer, and whether this install can take it; asks GitHub, at most once a minute |
| `GET /update/status` | any signed-in device, GobboNet's own page | the install: `state`, `done`, `total`, `error`, `can_restart` |
| `POST /update/install` | a browser on this PC, with an `Origin` that is this server | `{build, serial}`: the offer the person confirmed; anything else is 409 |
| `POST /update/restart` | the same | after an install: stop, and start the new program (exec on Linux; a new process in the same console on Windows) |

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
internal/server/       routing, auth gate, health endpoint, /perf, /lan
internal/state/        /state and /state/info
internal/models/       GGUF parsing, classifier, model metadata endpoints
internal/jobs/         in-memory detached generation
internal/proxy/        streaming reverse proxy
internal/supervisor/   llama-server lifecycle, hot-swap, rollback; the
                       embedding server; supervisor.Child for MCP servers
internal/mcp/          MCP servers: the stdio client, their programs, tool calls
internal/update/       the update button: the release list, signatures, the swap
internal/static/       static file serving (over an fs.FS)
internal/httpx/        response helpers, CORS, MIME
internal/webui/        the frontend, compiled in; assets/ is staged, not committed
```

## Upgrading older history

The hostname/history patch automatically imports the older PowerShell
`.gobbonet-state.json` from known installation directories after sign-in. If
there is no current shared history, it becomes `state.json`; if current history
already exists, the older copy becomes a separate recovery profile. Open
**DATA > Upgrade recovery** to access it. Original files remain untouched.

The browser also migrates merged localStorage history into split IndexedDB
records atomically. Interrupted older migrations are detected where possible;
ambiguous older copies are offered in Upgrade recovery. Restoring browser
history keeps sync off until you choose a target, so it cannot overwrite
another device's history. The panel can download the browser snapshot retained
before recovery.

Keep `legacy-import.json` in the data directory. It prevents intentional history
deletions from being undone by reimporting a retained old file. New imported
history is encrypted if the install is encrypted; retained old plaintext
originals are not rewritten. Files moved elsewhere and browser data belonging
to another origin can still be recovered with the normal DATA import workflow.
