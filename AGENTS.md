# GobboNet — guide for developers and coding agents

GobboNet is a private, offline chat app for local GGUF models. One Go binary,
`gobbonet`, serves the chat page, proxies to llama.cpp and supervises it. The
Windows and Linux launchers and installers around it handle first-run setup.

This file describes the tree as of 1.7.9. Where it and the code disagree, the
code is right, and this file should be fixed in the same change. It names files
and functions rather than line numbers, because line numbers go stale.

---

## Rules that apply to every change

- **Privacy first.** No telemetry, analytics, crash reporting or update checks.
  Nothing leaves the machine unless the user asked for it: engine and model
  downloads happen when the user picks them, and web search only when it is
  switched on. Every download is pinned by SHA-256. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Never edit `internal/webui/assets/`.** `scripts/stage-web.sh` copies `chat.html`,
  `js/`, `css/`, `manifest.webmanifest` and `icons/` there, and `go:embed` compiles them into the binary. Edit the
  originals and re-run `scripts/stage-web.sh`.
- **Batch files are CRLF.** Inside a `( )` block, escape parentheses in `echo`
  text (`^(`, `^)`) and read variables as `!VAR!`, never `%VAR%`.
  `tests/test-launch-cmd-flow.py` and `tests/test-setup-lan.py` check this.
- **The Informant describes the UI as shipped.** The Gobbonet Informant in
  `default-characters.json` quotes button and section names; renaming one means
  updating it, and `tests/test-informant.mjs` fails on any name it quotes that
  the page no longer has. It stays under 1,500 tokens (by `estimateTokens`) and
  answers "I don't know, check TROUBLESHOOTING.md" rather than guessing. A user
  who added an older copy is offered UPDATE on the home screen
  (`defaultCharState`, `updateDefaultChar` in `js/14-scroll.js`).
- **Keep copies in sync.** `installer-linux/wizard.html` and
  `linux-amd64/wizard.html` must be identical.
- **One changelog note per change**, as
  `docs/changelog/CHANGELOG-<version>-<topic>.md`: what was happening, the
  change, and the tests.
- **Say what was not run.** Much of this project only runs on Windows or needs
  a GPU. The Windows batch and PowerShell files are tested statically from
  Linux, so "not run in a Windows console" belongs in the PR.

---

## Where things are

| Path | What it is |
| --- | --- |
| `cmd/gobbonet/` | The binary: `serve` (the default), `launch`, `setup`, `set-password`, `config`, `doctor`, `check`, `engine`, `keyring`, `decrypt`, `autostart`, `uninstall`, `version`. Run `gobbonet --help`. |
| `internal/` | Go packages, listed below. |
| `chat.html`, `js/`, `css/` | The chat page: 25 JS modules (`01-config.js` to `25-tutorial.js`) and 19 stylesheets, as plain `<script>` and `<link>` tags. There is no bundler. `manifest.webmanifest` and `icons/` are its phone home-screen name and icons. |
| `default-characters.json` | The built-in character presets offered on the landing page. |
| `launch.bat` | Windows first run and "Setup or add a model": password, hardware probe, engine download, model menu. It then writes the settings into `gobbonet.exe`'s config and starts it. |
| `fileserver.ps1` | The legacy PowerShell server. Used only when `gobbonet.exe` is missing or `GOBBONET_LEGACY_SERVER` is set. |
| `setup-lan.bat`, `teardown-lan.bat` | Windows LAN access: subnet-scoped firewall rules (`GobboNet-Web`, `GobboNet-mDNS`, program rule `GobboNet`) and URL reservations, and their removal. |
| `stop-gobbonet.bat`, `Repair Windows shortcuts.bat` | Stop everything; re-point Start menu and desktop shortcuts at `gobbonet.exe launch`. |
| `hardware-probe.ps1`, `hw-recommend.ps1`, `identify-model.ps1` | Windows hardware detection, model recommendation, and GGUF identification for the launcher. |
| `installer-win/` | **The Windows installer that ships** (NSIS). |
| `catalog/` | `models.ini`, the model catalogue every platform reads, and `gen-catalog.py`, which generates it from `launch.bat`. `pin-hashes.py` pins each model's SHA-256 into `launch.bat`; `gen-remote-catalog.py` writes `gobbonet_model_list.json`, the live list to upload to goblincorps.com. (Was `installer/` until 1.7.9.) |
| `installer-linux/` | The `.deb`, the Linux launcher `gobbonet-launch`, and its first-run wizard (`gobbonet-setup.py` + `wizard.html`). |
| `installer-fedora/` | The `.rpm`. Install with `sudo dnf install`. |
| `linux-amd64/` | The ZIP's Linux runtime: launcher, wizard copy and, once built, the binary and engine. |
| `engine.sha256` | The pinned llama.cpp build and its hashes, read by every builder. |
| `scripts/` | Build and packaging: `stage-web.sh`, `make-zip.sh`, `build-release.sh`, `verify-payload.sh`, `payload.manifest`, and `PATCH-README.txt`, the release notes `make-zip.sh` puts at the archive's root. Each runs from the repo root whatever directory you call it from. See [docs/BUILDING.md](docs/BUILDING.md). |
| `tests/` | Node and Python suites. See [tests/README.md](tests/README.md). |
| `docs/` | `GO_SERVER.md`, `BUILDING.md`, `state-integration.md`, `INDEX.md`, `changelog/`, investigations and roadmaps. |

### Go packages

| Package | Does |
| --- | --- |
| `server` | Wires every route together (list below). |
| `supervisor` | Owns the local llama-server process: builds its command line, starts it, restarts it, swaps models, idle stand-down. |
| `proxy` | Streaming reverse proxy for `/llm`, `/search`, `/embed`. |
| `jobs` | Detached generation (`/llm/jobs`), so a reply survives the page closing. |
| `state` | Cross-device chat state (`/state`). |
| `auth` | Password hashing, login, rate limiting, sessions. |
| `keyring` | Optional encryption of the state files at rest. |
| `config` | `config.toml` discovery, defaults and writes. |
| `models` | Identifies a GGUF from its header: family, context, template, expert count. |
| `catalog`, `modelfetch`, `engine` | The model catalogue (tiers, pins), verified model downloads, and the pinned engine download. |
| `mods` | Mods: folders of CSS/JS under `<data_dir>/mods`, each with a `mod.json` and a switch; served to the page at `/mods` (1.7.9, F1). `endorsed.go`: the endorsed list from goblincorps.com and pinned installs, `/mod-list.json` and `/mod-list/install` (F6, `docs/ENDORSED-MODS.md`). |
| `localmodels` | Finds GGUFs already on the machine (HuggingFace cache, `model_dirs`) and links one into `model_dir`; never copies (1.7.9, issue #12). |
| `setup` | `gobbonet setup`, the Go first-run web wizard for platforms whose installer asks nothing. |
| `webui`, `static` | The embedded chat page, and static file serving. |
| `autostart`, `atomicfile`, `storelock`, `httpx`, `version` | Start at login, atomic file writes, maintenance locking, response helpers, the build stamp. |
| `procjob` | Windows: ties `launch.bat`'s whole process tree to the launcher with a kill-on-close job, and starts the browser outside it. No-ops elsewhere. |

---

## How it runs

```text
 browser (chat.html + js/ + css/)
        |  http://<host>:9066   (listen_port; LAN only if listen_host allows it)
        v
 gobbonet serve ── /login, /state, /perf, /swap-model, /llm/jobs, /catalog.json, ...
        |
        +── /llm/*    ──> llama-server   127.0.0.1:11437  (started and watched by supervisor)
        +── /embed/*  ──> embedding server 127.0.0.1:11436 (optional, for retrieval)
        +── /search/* ──> web-search API  (only when the user turns search on)
```

- **Routes:** listed, in matching order, in the comment at the top of
  `internal/server/server.go`. Everything except `/login`, `/logout`, the
  favicon and the home-screen manifest and icons is behind the password.
  `publicAssets` names those last four files one by one, and
  `tests/test-home-screen.py` keeps the list equal to what the pages name.
- **Engine:** `Supervisor.BuildArgs` makes the llama-server command line.
  Automatic GPU placement passes `--fit on --fit-target <gpu_reserve_mib>`, at
  least 2048 for Mixture-of-Experts models (#65). llama-server always binds to
  loopback. `tests/test-engine-args.py` pins the flags shared with
  `launch.bat`'s legacy path. Jinja is always stated, `--jinja` or
  `--no-jinja`, and a built-in `--chat-template` NAME always goes with
  `--no-jinja`: the pinned engine has Jinja on by default and would render the
  name itself as the prompt (1.7.9, the Tekken bug).
  `internal/supervisor/template_args_test.go` holds this.
- **Config:** `config.toml` is found in this order: `--config`,
  `$GOBBONET_CONFIG`, `$XDG_CONFIG_HOME/gobbonet/`, `~/.config/gobbonet/`, then
  `./config.toml`. On Windows that is usually `%USERPROFILE%\.config\gobbonet\`.
  Data (state, models, logs) lives under `$XDG_DATA_HOME/gobbonet`. Run
  `gobbonet config keys` to list every setting. CONFIG > Config File edits the
  file from a browser on this PC only (`internal/server/configfile.go`,
  `internal/config/editfile.go`): secrets show as `(hidden)`, every save is
  checked as startup would check it, and the replaced file is kept as
  `config.toml.bak`. How long a model may load (`model_load_timeout_seconds`)
  and a reply may take to start (`reply_start_timeout_seconds`) are settings
  here, not constants; the page reads the load limit from `/swap-status`.
- **Password:** stored as Argon2id (`internal/auth/secret.go`). The salt:hash
  form `launch.bat` writes to `.gobbonet-secret` is still accepted and
  upgraded to Argon2id on first login. Sessions are cookies bound to the
  client's IP and User-Agent, so a phone that changes either signs in again;
  from loopback (this PC, any address family) they are bound to neither
  (`auth.ClientFingerprint`). The server logs why it refused a session, once
  per token (`internal/server/authlog.go`). The page re-checks a 401 before it
  asks for the password (`noteLocked`, `js/06-state-sync.js`).
- **Entry points:**
  - **Windows first run:** `launch.bat`, which then starts `gobbonet.exe`.
  - **Windows afterwards:** the shortcuts run `gobbonet.exe launch`, which
    serves the saved config and asks nothing. "Setup or add a model" runs
    `gobbonet.exe launch --setup`. Whenever `launch` runs `launch.bat`, it puts
    it in a kill-on-close job (`internal/procjob`), so closing the window ends
    everything it started (1.7.9, PR #15). A first run that stopped early
    leaves `.gobbonet-setup-pending` beside `launch.bat` and a config with no
    engine; `launch` runs setup again for that (`cmd/gobbonet/launch.go`).
  - **Linux packages and ZIP:** `gobbonet-launch` runs the Python wizard on
    first run, then `gobbonet serve` and the embedding engine.

### The chat page

- **Load order is the contract.** Modules share globals, so `chat.html`'s
  `<script>` order is load-bearing: `01-config.js` first, then `24-boot.js`,
  then only `25-tutorial.js`, which waits on `window.GobboNet.ready`.
  The module headers point to a `REFACTOR-PLAN.md` that is no longer in the
  tree; the order in `chat.html` is what counts.
- **State:** one `state` object (`js/04-state.js`, versioned by
  `STATE_SCHEMA_VERSION`). It is kept in the browser and synced through
  `/state` (`js/06-state-sync.js`); `docs/state-integration.md` covers reading
  it. Don't copy field lists into docs; read `04-state.js`.
- **Rendering:** `render()` repaints the sidebar and messages. Streaming tokens
  update the DOM in place rather than re-rendering.
- **CONFIG** is grouped into Basics, Characters & Chat, Model & Performance,
  Devices & Network and a closed Advanced section (1.7.9), with a search box
  (CONFIG SECTIONS & SEARCH, `js/15-cards.js`). A new setting goes in the
  section a user would look in; `tests/test-config-sections.mjs` holds the
  inventory, so add its id there too.
- **Deleting** one thing never asks "are you sure". It happens at once and
  offers UNDO for 10 seconds (1.7.9; UNDO in `js/18-utils.js`): snapshot what
  you remove, call `undoable({ label, undo, commit })`, and put anything that
  cannot be taken back (an IndexedDB delete, a server request) in `commit`.
  Bulk deletes and PURGE keep their confirm. Add a new delete to the list in
  `tests/test-undo.mjs`.
- **Mods** (1.7.9): page code lives in mods on the PC (`internal/mods`, `js/19-extensions.js`), never in `/state`. Anything that can make code run -- writing a mod, switching one on, reordering, removing -- is `fromThisPC` only on the server; any signed-in device may read the list and switch a mod off. `redactedStateMeta()` always sends an empty `extensions`. Keep it that way. Installing from the endorsed list (F6) is `fromThisPC` too, and every file must match its SHA-256 pin or nothing is installed; an update never changes the user's switch. A mod file that fails to load or throws while it first runs switches its mod off (`modFailed`); `?nomods` loads none.
- **The tour** (`js/25-tutorial.js`, 1.7.9) finds controls by `data-tour="..."`
  only. Moving a control is safe; renaming or removing its `data-tour` is not,
  and `tests/test-tutorial.mjs` will say so. A main control a newcomer needs
  can get a stop: one sentence, a `data-tour` target, and a fallback target if
  it can be hidden.
- **Feature notes:** one visible sentence; anything longer goes in a "?"
  tooltip (`.tip-btn` naming a hidden `.tip-body` by `aria-describedby`; see
  HINT TOOLTIPS in `js/18-utils.js`). Keep warnings in the visible sentence.
- **User content:** goes through `escapeHtml()` before it reaches the DOM.
  Text interpolated into inline handlers goes through `escapeJsAttr()`.
  Synced numbers are coerced with `Number()` before markup, and ids in URL
  paths go through `encodeURIComponent()`. `tests/test-render-escaping.mjs`
  lints the handlers.
- **Code from outside** (restores, backups, card files) always goes through
  `neutralizeUntrustedCode()` or `applyImportedCardCode()`, called directly,
  never behind a `typeof` guard: a missing quarantine must fail the restore.
  `tests/test-untrusted-code-paths.mjs` holds the list of ways in.
- **Mods:** user CSS and JS in the MODS panel, and per-character custom code,
  run with full page access. Imported cards arrive with custom code switched
  off.
- **Memory:** older messages are compressed into lore, one line per pass
  (`summarizeForLore`, `js/07-prompt.js`). The instructions are
  `LORE_DEFAULT_PROMPT`, or the card's own (`loreCustomPrompt`, `lorePrompt`,
  the editor's "Edit the lore summary prompt" box). Keep the default free of
  names and stories: small models copy examples, and lore is fed back as fact.
  The prompt itself is assembled in `buildContextMessages` (`js/08-rag.js`).
  llama-server reuses the last prompt up to its first difference, so anything
  that changes every message belongs near the end. The retrieved snippets go
  with the character unless `settings.retrievalNearEnd` (CONFIG > Prompt
  Order) puts them just before the newest message. The storybook field
  feeds retrieval through the local embedding model (`js/08-rag.js`,
  `docs/RAG_INFO.md`). A card's memory files (`memoryFiles`, issue #41) join
  the same pool, split at their headings; read them through
  `cardMemoryFiles()` and add them through `memoryPutFile()`, which enforce
  the names and limits.
- **Banned phrases:** a card's list becomes `logit_bias` in
  `buildLogitBias()` (`js/06-state-sync.js`, issue #51). It is per token: a
  word is banned at its own token or a safe leading piece, a phrase at its
  rarest word, and common words and short fragments never. Bans are picked
  from `/tokenize` with pieces, cached per model. There is no real CFG:
  llama-server does not expose the logits it would need.
- **Tools:** a card's custom code can offer the model functions with
  `gobbo.tool(name, { description, parameters }, fn)` (`js/23-card-code.js`).
  They are sent as the OpenAI `tools` array only while the card's "Let the
  model call this card's tools" box is ticked (`toolsEnabled === true`, off
  by default and cleared on import). `runGenerationWithTools`
  (`js/03-generation.js`) wraps the transport: the stream feeder collects
  `tool_calls` deltas, the page runs each call (`runCardTool`, 30 s, result
  capped at 8,000 chars, errors go back to the model as text), appends the
  assistant turn and one `tool` message per call after the built context,
  and asks again, at most five requests per reply, the last without `tools`.
  The engine must run with `--jinja`; a refusal is retried once without tools
  and noted in the reply. Consent is re-checked before every request and
  before calls run, and a call is refused if another card owns the registry
  by then. Arguments are the model's, parsed but not schema-checked: card
  authors validate them. Calls are stored on the message as `toolCalls`,
  kept per variant, and shown as a collapsed block; completed rounds' text
  rides along as `toolPrefix` so a reload mid-round replays onto it. There
  are no built-in tools. `tests/test-card-tools.mjs` pins all of it.

---

## Testing

```sh
for f in tests/*.mjs; do node "$f" || echo "FAILED: $f"; done   # frontend, no install step
for f in tests/*.py;  do python3 "$f" || echo "FAILED: $f"; done # launcher, installers, wizards
bash ./scripts/stage-web.sh && go test ./...                            # Go 1.25+
```

- **Frontend suites** load the real files out of `js/` and run them in Node's
  `vm`, so they test what ships.
- **Batch and PowerShell files** are checked statically.
  `tests/test-model-menu-input.py` also runs one `launch.bat` block through a
  small cmd interpreter.
- **`tests/test-linux-onboarding.py`** needs a built `linux-amd64/gobbonet`
  and an engine. `./scripts/make-zip.sh` produces both.
- **Logs:**
  - **Diagnostics:** `gobbonet doctor` checks the config, engine, storage,
    port, LAN addresses and firewall.
  - **Server:** writes to its console, or to `launch.log` under the data
    directory when started from the Linux launcher.

## Building

- **Go:** 1.25 or newer, no cgo. Run `scripts/stage-web.sh` before `go build`, or the
  binary has no chat page.
- **ZIP:** `./scripts/make-zip.sh` builds both servers and refuses to produce an
  archive with a platform missing or a stale version stamp.
- **Installers:** `installer-win/` (NSIS), `installer-linux/build-deb.sh`,
  `installer-fedora/build-rpm.sh`. All of them read `engine.sha256`.
  `installer-linux/build-appimage.sh` makes the AppImage from the `.deb`, so it
  carries the same engine; its own download, the AppImage runtime, is pinned
  in the script.

Details: [docs/BUILDING.md](docs/BUILDING.md).

## Docs that describe the past

#63's docs batch (1.7.8) brought `README.md`, `TROUBLESHOOTING.md`,
`docs/PURGE.md` and `docs/GO_SERVER.md` up to the Go server. What is still
historical on purpose:

- `docs/archive/` holds investigations, roadmaps and design notes from past
  releases (moved there in 1.7.9). `GO_CONFIG_SPLIT.md` is the design note from before the config was
  built. Its status block says what changed; the code wins.
- `docs/changelog/` records each change as it was made. Old entries name files
  and behaviour that later changed.
- Anything about `fileserver.ps1` describes the legacy PowerShell server,
  which runs only without `gobbonet.exe` or with `GOBBONET_LEGACY_SERVER=1`.

The website is not in this repository, so its download sizes and browser
notes (#63) have to be fixed there.

---

*Brought to you by the GoblinCorps. No corpo money, no venture capital, no
masters.*
