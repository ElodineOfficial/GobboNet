# 1.8.0 — MCP servers as tools

Roadmap item #16, from Zindaar's issue #42.

## What was asked

MCP (the Model Context Protocol) is how most tool programs now offer
themselves to AI apps: a filesystem reader, a notes database, a git helper,
each a small program that lists its tools and runs them when asked. The issue
asked for characters to be able to use them, as they can use the tools in a
card's own code since roadmap #9.

A browser page cannot start a program, and most MCP servers are programs
reached over stdin and stdout. The Go server can, and already owns the
lifetime of the programs it starts, so the bridge lives there.

## The change

**Servers are `[[mcp_server]]` tables in `config.toml`**: `name`, `command`,
`args`, `env`, and `enabled`, which starts `false`. `config.toml` documents
them, with an example, below the server settings and above `[ui]`, and
CONFIG > Advanced > MCP Servers writes them there. A table is checked when the
file loads: a name of lowercase letters, digits, `-` and `_`, unique; a
command; no control characters; a misspelt key (`comand`) is named, and so is a
top-level setting written below a table, where TOML reads it as part of the
table. New key `mcp_call_timeout_seconds`, default 30, 1 to 3600. `config get`
and `config set` refuse table-valued keys (`[ui]`, `[[mcp_server]]`) instead of
reading or writing nonsense.

**Saved without losing the file.** CONFIG's box rewrites only the
`[[mcp_server]]` tables, sub-tables included, and keeps every comment and every
other section; the result is parsed as `Load` parses it, and must read back as
the servers asked for, before it is written. The Config File editor accepts
table lists through its usual save check, and a save there that changes MCP
settings applies at once rather than on the next start.

**Started by GobboNet, on this PC** (`internal/mcp`). Each server is started by
direct exec of its argument list -- no shell reads it -- the first time a tool
list or a call needs it, and runs until it is switched off, changed or removed,
or GobboNet stops. It goes through `supervisor.Child`, the third user of the
process half the engines share since #15: its own process group, the Windows
kill-on-close job, and the whole group swept on stop. One that exits is started
again on the next use, after a wait that doubles from one second to two
minutes, and says why it stopped: "it exited (exit status 1): " and the last
line it printed.

- **Its environment** is `PATH`, `HOME` and their like (the official MCP SDKs'
  list, plus locale and temp-folder names, and the proxy and certificate
  settings, without which `npx -y` behind a company proxy fails on a
  certificate error), never a `GOBBONET_` variable, plus its own `env` table.
- **Its log** is `mcp-<name>.log` beside `llama-server.log`: its error output
  and GobboNet's lines about it -- started, ready with N tools, each call's tool
  and time -- and never a call's arguments or result. It stops growing at 8 MB.
  `gobbonet uninstall` removes it.

**A small client of our own**, as decided in the roadmap: the official SDK
pulls five more modules into an app meant to run offline, for three methods.
Newline-delimited JSON-RPC 2.0 over stdio: `initialize`, `tools/list` (every
page) and `tools/call`; the server's `ping` is answered, and anything else it
asks for is refused as not offered. Resources, prompts, sampling, roots,
elicitation and remote servers (a `url`) are not in 1.8.0. It asks for MCP
`2025-06-18` and accepts `2024-11-05` to `2025-11-25`. A banner printed on
stdout, which MCP forbids and some servers do anyway, goes to the log. A
message over 32 MB stops the server. A call past `mcp_call_timeout_seconds` is
cancelled at the server and reported as such. Text reaches the character as it
is; an image, audio or a binary file is named in a line saying it was not
shown; a result is cut to `toolResultMaxChars`.

**Who may do what** (`internal/server/mcp.go`):

| | From | |
| --- | --- | --- |
| add, change, switch on, remove | a browser on this PC, on GobboNet's own page | the Config File editor's test: loopback, a loopback `Host`, no forwarding headers |
| switch off | any signed-in device, on GobboNet's own page | it can only take something away |
| list tools, call one | any signed-in device, on GobboNet's own page | the server must be on and list the tool |

`POST /mcp/call` requires an `Origin` that is this server. A browser sends one
on every POST, so no other website can make a call, even on an install with no
password, where no session cookie stands in the way. The tool list and the
settings are same-origin too, since CORS `*` would otherwise let another site
read them. `env` values, which can be tokens, go only to this PC; other devices
see the names.

**CONFIG > Advanced > MCP Servers** lists each server with its command line,
its state ("On. Starts when a character first needs it.", "Running, 5 tools.",
"Not working (tries again in 8 s)." with the reason), and "Runs on this PC with
your permissions." CHECK TOOLS starts it if need be and lists its tools,
marking those that say they only read. The form takes the program, the
arguments one per line, and `NAME=value` lines; PASTE A SETUP (JSON) fills it
from the `{"mcpServers": {...}}` block most servers document, without saving,
and says so when the block is a remote server. Off the PC, only SWITCH OFF and
CHECK TOOLS are offered, with where to go for the rest.

`gobbonet doctor` has an MCP SERVERS section: each server, on or off, whether
its program is found, its `env` names (never values) and its log. The startup
banner names the servers that are on.

Docs: GO_SERVER.md, TROUBLESHOOTING.md ("An MCP server says Not working"),
AGENTS.md and docs/INDEX.md.

## Tests

- `internal/mcp/manager_test.go` (new), against a fake MCP server built into
  the test binary (`internal/mcp/mcptest`, linked only into tests): a server
  starts on first use and not before, answers the client's ping on the way,
  and has both pages of its tool list read; a call round-trips; a call past the
  timeout is cancelled at the server and the server keeps working; a crash
  fails the call with its last words and the server restarts after the
  backoff, not inside it; a start that fails or never answers says why and is
  stopped; an unsupported protocol version and a server with no tools; the
  environment carries none of `GOBBONET_ACCESS_SECRET`, an API key or a bash
  function, and does carry the proxy settings; refusals for an unknown server, a switched-off one, an unlisted
  tool and arguments that are not an object; results are rendered and cut;
  `tools/list_changed` is followed; switching off, changing or shutting down
  stops the program; a missing program is named. Under `-race`.
- `internal/supervisor/child_unix_test.go` (new): `Stop` ends a program's
  helpers too; an exit is seen with its status.
- `internal/config/mcp_test.go` (new): tables load, sub-tables included; each
  refusal; table keys are not `config get`/`set` keys; `UpdateMCPServers` on the
  shipped file and on a hand-written one keeps every comment and settles; a
  refused change leaves the file as it was; **the Config File editor saves a
  table list and refuses a bad one** (the roadmap's own item).
- `internal/server/mcp_test.go` (new): adding, switching on and removing from
  a phone or through a forwarding proxy get 403 and change nothing; a phone may
  switch one off, which stops it; `env` values reach only this PC; tools and
  calls over HTTP with their status codes; every cross-site and Origin-less
  call is refused and starts nothing; the timeout is a 504; a Config File save
  applies at once.
- `cmd/gobbonet/mcp_test.go` (new): doctor's section and the startup line.
- `tests/test-mcp-config.mjs` (new): the box, its wording, the PC and phone
  views, hostile names and details shown as text, CHECK TOOLS, the form and the
  JSON paste. `tests/test-config-sections.mjs` and
  `tests/test-server-presets.mjs` follow.

The new tests fail on the round-8 tree.

## Next in this release

Characters do not call MCP tools yet: the character picker (`card.mcpTools`),
the approval bar and its setting, and Privacy Status's list of enabled servers
follow, on the same routes.
