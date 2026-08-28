Now I have the complete picture. Here's the design for the shared config file that bridges both launchers to the Go server.

---

## Shared Config File Design

A single TOML file — human-editable, commentable, supported by all three runtimes (PowerShell, shell, Go). Both `launch.bat` and `launch.sh` write it during setup; the Go server reads it at startup.

### Architecture: Local Mode and Remote Mode — both first-class

The Go server runs in **one of two modes**, determined entirely by config:

| Mode | How it's used | `server_exe` in config | Hot-swap | Upstream control |
|---|---|---|---|---|
| **Local** | `launch.bat` / `launch.sh` install llama.cpp and run it on this machine | Set to the llama-server binary path (must exist on disk; missing binary is a fatal error) | ✅ Full — swap GGUF files on-the-fly | Go manages the llama.cpp process lifecycle |
| **Remote** | Point at any existing llama.cpp server (LAN, other machine, cloud) | Empty (`""`) | ❌ Disabled — upstream is not local | Go only proxies; it never spawns or controls llama.cpp |

**Both modes get full feature parity** for everything *except* hot-swap: auth, state sync, generation jobs, web search, RAG, characters, personas, lore, scheduler, extensions, macros, variants/rerolls, data export/import — all identical. The Go server reports its capabilities (via `/health-fileserver`) and the frontend adapts automatically.

This means:
- **Windows users** on `launch.bat` get local mode with hot-swap
- **Linux users** on `launch.sh` also get local mode with hot-swap
- **Anyone** with an existing llama.cpp server (remote, cloud, shared) gets full chat with zero local inference overhead
- **The same binary, same config format, same frontend** — no feature flags, no separate builds

### Proposed file location & name

| Platform | Default path | Overridden via |
|---|---|---|
| Windows | `%~dp0\.gobbonet-config.toml` | `GOBBONET_CONFIG` env var |
| Linux | `~/.config/gobbonet/config.toml` | `XDG_CONFIG_HOME/gobbonet/config.toml` / `GOBBONET_CONFIG` env var |

This keeps the Windows behavior identical (config lives next to `launch.bat`) while giving Linux a proper XDG home. Both paths are overridable.

> **Review note — Fix XDG inconsistency:** The current design puts config at `~/.local/share` (wrong XDG directory — that's for *data*, not config). Fix: config → `~/.config/gobbonet/config.toml`. Models, state, and spool directories → `~/.local/share/gobbonet/`. Also rename `GEMMA_*` env vars to `GOBBONET_*` and accept old names with a deprecation warning.

### Default config (Go writes this when absent)

```toml
# ================================================================
# GOBBONET - LOCAL AI CHAT
# ================================================================
#
# This is the shared configuration file. It is written by the
# setup scripts (launch.bat on Windows, launch.sh on Linux) but
# can also be edited manually. After editing, restart the
# server to pick up changes.
#
# If you don't have a llama.cpp server running anywhere, run
#   launch.bat       (Windows)
#   launch.sh        (Linux)
# to download and configure one. You can also point at any
# remote llama.cpp-compatible endpoint.
#
# After this file is populated, you can start the server
# directly:
#   gobbonet serve             (uses config in this directory)
#   gobbonet serve --config /path/to/config.toml
# ================================================================

# --- Upstream llama.cpp server ------------------------------------------
# Base URL of the llama-server process. This can be:
#   http://127.0.0.1:11437/v1   — local llama.cpp server
#   http://192.168.1.100:11437/v1 — remote machine on your LAN
#   https://your-server.com/v1   — remote with TLS
#
# The UI and chat state are served by this program (the Go "gobbonet"
# binary). The llama.cpp server handles model inference. They talk
# over HTTP.
llm_url = "http://127.0.0.1:11437/v1"

# --- Optional upstream services -----------------------------------------
# Web search relay / Ollama API endpoint. Leave empty to disable.
search_url = "https://ollama.com/api"

# Embedding server for RAG. Leave empty to disable.
embed_url = "http://127.0.0.1:11436"

# API key sent to the upstream llama.cpp server (never exposed to the
# browser). Set this if your upstream requires authentication.
# For security: the config file is written with 0600 permissions. Alternative:
#   llm_api_key_file = "/path/to/key"     # read from file at startup
#   LLAMA_API_KEY=...                      # or set via environment variable
llm_api_key = ""

# --- Listener -----------------------------------------------------------
# What address and port the gobbonet server binds to.
# 127.0.0.1 = loopback only (default, private and secure).
# 0.0.0.0 = accept connections on all network interfaces (LAN access).
listen_host = "127.0.0.1"
listen_port = 9066

# --- Local-backend (hot-swap) settings ----------------------------------
# These settings are only active when this machine runs the llama.cpp
# server itself ("local mode"). To use local mode, set server_exe below
# to the path of the llama-server binary and point llm_url at the local
# port (default 11437).
#
# If you point llm_url at a remote server ("remote mode"), these can be
# left at their defaults — they won't be used. The Go server proxies
# requests to the remote upstream exactly the same way.
#
# IMPORTANT: Both local and remote modes get full feature parity.
# The only difference is hot-swap (swapping GGUF files on-the-fly),
# which requires Go to control the llama.cpp process. In remote mode,
# the model dropdown shows the current model but swap is disabled.

# Path to the llama-server executable (absolute or relative to config
# directory). When set to "" hot-swap is disabled.
server_exe = ""

# Maximum layers to offload to GPU (0 = CPU only, 99 = all layers).
gpu_layers = 99

# Context window in tokens. Must not exceed the model's max_ctx.
ctx_size = 16384

# KV cache quantization type. Common values: q8_0, q4_0, auto.
kv_cache_type = "q8_0"

# --- Model directory ----------------------------------------------------
# Directory containing .gguf model files. These appear in the model
# selector dropdown (in addition to whatever the upstream /props
# reports). Defaults to <data_dir>/models.
#
# This is where launch.bat / launch.sh download models to.
model_dir = "./models"

# --- Access control -----------------------------------------------------
# The server can be password-protected. If this is set, the value is
# a salted SHA-256 hash in "salt:hash" format or an Argon2id PHC string.
# MIGRATION: on first login after upgrade, passwords are rehashed as Argon2.
# If empty, no password is required.
#
# After initial setup this file is written automatically. To change
# the password, run:
#   gobbonet set-password
# Or delete this section and restart — the server will prompt.
access_secret = ""

# --- Chat template settings (optional) ----------------------------------
# If your model uses a non-standard chat template, you can specify
# a Jinja template file or a built-in template name here.
#
# chat_template_name = "mistral-v3-tekken"
# chat_template_file = ""          # absolute or relative path to a .jinja file

# --- Session & job settings ---------------------------------------------
# Session cookie lifetime in hours. Short for LAN use. Set SameSite=Lax.
session_ttl_hours = 12

# Maximum concurrent detached-generation workers.
job_max_concurrent = 1

# Generation jobs are held in memory (no disk spooling). At ~150 tok/s,
# concurrent jobs for 30 minutes is tens of MB — trivial for modern systems.
# job_max_age_hours is retained as a soft limit for memory management.
```

### Mode detection — fatal error for missing local binary

Current design: `server_exe != ""` AND file exists AND `model_dir` is a directory → local mode.

> **Review note — Fix silent degradation:** Non-empty `server_exe` is a statement of intent. If the binary is missing, that's a fatal error, not a fallback to remote mode. A typo'd path silently demotes you to remote mode where nothing listens, and the health endpoint lies.

### `gobbonet config get/set` subcommands

> **Review note — Adopt:** Don't make PowerShell or shell scripts parse TOML. Ship CLI subcommands (`gobbonet config get <key>`, `gobbonet config set <key> <value>`) and have both launchers shell out to the binary they already carry. Go stays the only TOML parser. (Note: `gobbonet setup` — collapsing hardware probe + model download + process supervision — is deferred to a later phase; it's platform-specific and one-time, so drift risk is lower.)

### What each script reads/writes

**`launch.bat` (Windows) — writes on setup:**
- `llm_url`, `llm_api_key` (from GPU probe recommendations)
- `server_exe` (path to downloaded llama-server.exe)
- `model_dir` (the `models/` folder)
- `gpu_layers`, `ctx_size`, `kv_cache_type` (from hardware probe)
- `listen_port` (always 8080, unchanged)
- `access_secret` (after user picks password)
- Does NOT write `search_url` / `embed_url` on Windows (those were always loopback)

**`launch.sh` (Linux) — writes on setup:**
- Same fields, plus `search_url` and `embed_url` (optional, may be remote)
- `server_exe` (path to downloaded llama-server binary)
- `model_dir`
- `gpu_layers`, `ctx_size`, `kv_cache_type` (from `nvidia-smi`, etc.)
- `access_secret`

**Go server (`gobbonet serve`) — reads at startup:**
- All of the above
- If `access_secret` is empty → prompts interactively for password (or `gobbonet set-password`)
- If config file is completely absent → writes the comment-filled defaults above, prints a message, exits
- Determines operating mode by inspecting `server_exe`:
  - **Local mode**: `server_exe != ""` AND the file exists AND `model_dir` is a directory
    → Hot-swap enabled. `active-model.json` from GGUF header parsing. Model dropdown offers swap.
  - **Fatal error**: `server_exe != ""` AND the file does NOT exist
    → Exit with error. Non-empty `server_exe` is a statement of intent.
  - **Remote mode**: `server_exe` is empty
    → Hot-swap disabled (503). `active-model.json` from upstream `/props` (with filename heuristics and graceful degradation as fallbacks).
  - **Both modes serve identically**: static files, reverse proxy (all three upstreams), auth, state sync, generation jobs, web search, RAG, and all other features. The only difference is hot-swap and the source of model metadata.

### The Go startup flow

```
1. Find config.toml:
   a. --config flag
   b. GOBBONET_CONFIG env var (accept GEMMA_CONFIG with deprecation warning)
   c. ~/.config/gobbonet/config.toml (or XDG_CONFIG_HOME/gobbonet/config.toml)
   d. ./config.toml (project root, same as Windows)

2. If absent → write default with comments → explain → exit

3. Parse TOML → Config struct

4. Determine operating mode:
   - `server_exe != ""` AND the file exists AND `model_dir` is a directory → **local mode**
   - `server_exe != ""` AND the file does NOT exist → **FATAL: server_exe set but binary missing**
   - `server_exe == ""` → **remote mode**
   - model_dir absence does NOT affect mode detection (decoupled)

5. If access_secret empty:
   a. If --no-auth → skip
   b. If interactive TTY → prompt for password → write secret → continue
   c. If no TTY (systemd, cron, etc.) → print error → exit

6. Print banner with mode + config summary

7. Start HTTP server
```

### Why TOML over JSON/YAML

| | TOML | JSON | YAML |
|---|---|---|---|
| **Comments** | ✅ native | ❌ | ✅ (but fragile) |
| **Human-editable** | ✅ | ❌ | ✅ |
| **Go library** | `github.com/BurntSushi/toml` (battle-tested) | stdlib | `gopkg.in/yaml.v3` |
| **PowerShell support** | No native, but `ConvertFrom-StringData` can parse flat key=value; or use a small Go helper to dump TOML → env vars for `launch.bat` | ✅ `ConvertFrom-Json` | ❌ |
| **Shell support** | `grep`/`sed` for simple values; `yq` for YAML | ✅ `jq` | ✅ `yq` |
| **Default values in file** | ✅ (documented defaults in comments) | ❌ | ✅ |

**Key advantage:** the defaults are *in the file itself* as comments. Users see them, understand them, can uncomment and adjust. With JSON, you'd need a separate defaults document. With YAML, comments are easy but the format is less structured (indentation errors are common).

### GGUF model metadata — `gpustack/gguf-parser-go`

Model identification (inventory gap #2) requires reading KV pairs from the GGUF header: `general.architecture`, `tokenizer.chat_template`, and `<arch>.context_length`. The llama.cpp redistributable shipped with gobbonet includes no CLI tool that dumps this (it's a DLL-split build with no `--dump` or `--info` subcommand).

Rather than writing a GGUF reader from scratch, the Go server uses the existing, battle-tested library:

> **https://github.com/gpustack/gguf-parser-go**

Key reasons:
- Written in Go — zero external dependencies, compiles to a single binary
- Reads GGUF metadata via **chunked streaming** — no need to load the entire model into memory; just the KV header is parsed (typically a few KB of a multi-GB file)
- Already handles the full GGUF v2/v3 spec: endianness, all value types, nested arrays, tensor counts
- Used in production by GPUStack for model catalog scanning at scale
- Exposes structured Go types: `ModelInfo` with `General`, `Architecture`, `ContextLength`, `ChatTemplate`, etc. — exactly the fields `identify-model.ps1` extracts
- Also provides memory-usage estimation and TPS calculation (useful later for `launch.sh`'s hardware-aware model recommendation)

The Go server uses it to scan the `models/` directory on-demand and on hot-swap to verify a newly-selected model's metadata.

### Model metadata — primary/fallback strategy

`active-model.json` is generated dynamically at runtime. The source depends on operating mode:

| Mode | Primary source | Fallback | Final fallback |
|---|---|---|---|
| **Local** | GGUF header parsing (`gguf-parser-go`) reads `general.architecture`, `tokenizer.chat_template`, `<arch>.context_length` directly from the `.gguf` file | — | — |
| **Remote** | llama.cpp's `/props` endpoint → `model_hf_architecture` field | Filename heuristics (see code) | `thinkingFormat: "none"` |

The `/models-list.json` endpoint is generated on-demand: Go scans `models/` at boot via `gguf-parser-go`, caches keyed on directory mtime, re-scans on request if mtime changed. No mutable file, no drift.

**Degradation chain for remote mode:** The `/props` endpoint may or may not include `model_hf_architecture` depending on the llama.cpp build version. The Go server handles all three levels gracefully:

```
props has model_hf_architecture?
  ├─ Yes → set thinkingFormat from architecture mapping table (primary)
  ├─ No → filename heuristics on model_path (best-effort)
  │        ├─ Matches → set thinkingFormat
  │        └─ No match → thinkingFormat: "none" (final fallback)
```

When `thinkingFormat` defaults to `"none"`, the only degraded feature is the **collapsible chain-of-thought UI** — the model's `<think>...</think>` blocks are displayed as inline text instead of collapsible sections. The model still generates thinking correctly, the chat still works, the context window is still managed. It's a UI polish feature that degrades to "thinking is just visible text" rather than a functional failure.

**Local mode has no fallback:** `gguf-parser-go` reads directly from the GGUF binary header, which always contains `general.architecture`. No guessing needed — it's the complete and authoritative source.

### What stays in `launch.bat` / `launch.sh`

After this design, both scripts are thin wrappers. They operate differently depending on mode:

**Local mode (default for both scripts):**
1. **One-time setup** — hardware probe → recommend model → download llama.cpp → download GGUF → set password → write `config.toml` with `server_exe` set
2. **Start the Go server** (`gobbonet serve`), which starts and supervises `llama-server` directly
3. **Health monitor loop** — handled by `gobbonet serve` with exponential backoff

> **Review note — Collapse launch.sh health monitor into Go:** The health monitor loop, swap coordination, and process supervision should be inside the Go binary, not duplicated in `launch.sh`. This eliminates the drift on the hot path. Use `gobbonet serve` as a proper supervisor with exponential backoff. The setup scripts (hardware probe + model download) can remain as thin wrappers for now — they're one-time interactive flows, not drift-prone hot paths. `gobbonet setup` consolidation is a v2 goal.

**Remote mode (manual setup, no scripts involved):**
1. User edits `config.toml` — points `llm_url` at remote, clears `server_exe` (`server_exe = ""`)
2. Runs `launch.sh` or `gobbonet serve` directly — no llama.cpp management needed
3. No health monitor loop (nothing to monitor — the upstream is managed elsewhere)

The config file is the single source of truth. Everything that was scattered across env vars, `launch.bat` variables, and `fileserver.ps1` CONFIG block now lives in one place.

**Remote-mode setup** — point at an existing llama.cpp server:

The user edits `config.toml` to:
1. Set `llm_url` to the remote llama.cpp endpoint (e.g., `http://192.168.1.100:11437/v1`)
2. Clear `server_exe` (set to `""`)
3. Set `search_url` / `embed_url` if the remote also provides those
4. Optionally set `llm_api_key` if the remote requires auth

Then runs `launch.sh` (or `gobbonet serve` directly). The same binary, same config format, same frontend — just a different upstream. No hot-swap, but everything else works identically.

**Hybrid setup** — local chat, remote inference:

A common pattern: run `gobbonet serve` on your laptop in remote mode (`server_exe = ""`), but point `llm_url` at a desktop PC or cloud server running llama.cpp. The chat UI is served from your laptop, the model inference runs on the remote machine. State sync still works across devices on the LAN. This is the primary use case for the remote mode — a centralized model server with thin clients.
