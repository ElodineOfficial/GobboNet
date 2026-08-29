## Complete API Endpoint Inventory

### 1. Authentication (both implementations)

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/login` | Returns the login page HTML |
| `POST` | `/login` | Validates password → `Set-Cookie: gobbonet_session=...` → 302 to `/` |
| `GET` | `/logout` | Revokes session token → 302 to `/login` |
| `POST` | `/logout` | Same as GET (idempotent) |
| `GET` | `/favicon.ico` | Serves favicon if present; 404 silently if not (unauthenticated) |

**Auth gate logic (both):** If unauthenticated:
- `Accept: text/html` → 401 + login page HTML (browser navigates to login screen)
- Anything else → 401 + `{"error":"authentication required","login":"/login"}` (API/proxy calls)

---

### 2. Health / Liveness (both)

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/health-fileserver` | Mode-dependent — see dual-mode contract below |

**Dual-mode contract (Go):** The Go server runs in one of two modes, and `/health-fileserver` reflects that:

| Mode | Trigger | Response |
|---|---|---|
| **Local** | `server_exe` is set in config and exists on disk | `{"status":"ok","pid":<go-pid>,"hotswap":true,"mode":"local","upstream":"http://127.0.0.1:11437/v1"}` |
| **Remote** | `server_exe` is empty (`""`) | `{"status":"ok","pid":<go-pid>,"hotswap":false,"mode":"remote","upstream":"http://192.168.1.100:11437/v1"}` |

The `pid` field is **always present** — it's the Go server's own PID (useful for log correlation, not for the client). The `mode` and `hotswap` fields tell the client what the Go server is capable of. The `upstream` field shows where the Go server is proxying requests to.

**PowerShell behavior (legacy):** Sends `pid` and `hotswap` bool. This matches Go's local-mode response.

**Python behavior (legacy):** Sends `upstream` string instead of `pid`, hardcodes `hotswap: false`. This matches Go's remote-mode response.

**Go unifies both:** Always sends `pid`, always sends `upstream`, conditionally sends `hotswap` based on mode. This gives the frontend everything it needs regardless of which legacy implementation it's talking to.

---

### 3. Model Metadata (both — but fundamentally different)

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/active-model.json` | Model identity + thinking format + context hints |
| `GET` | `/models-list.json` | Dropdown list of models + active indicator |

**Fundamental difference:**

| | Windows | Python |
|---|---|---|
| **Source** | `active-model.json` written to disk by `launch.bat` at boot | Generated on-demand from upstream `/props` |
| **models-list.json** | Written to disk by `launch.bat` + `identify-model.ps1` | Generated from upstream `/props` + local `--models-dir` GGUFs |
| **Drift risk** | Can get out of sync if server restarts with different model | Always reflects what the upstream actually has loaded |
| **Missing input** | `general.architecture` from GGUF header | Modern `/props` includes `model_hf_architecture` (r3170+); older builds omit it

**Go server — primary/fallback strategy:**

`active-model.json` is generated dynamically at runtime. The source depends on operating mode:

| Mode | Primary source | Fallback | Final fallback |
|---|---|---|---|
| **Local** | GGUF header parsing (`gguf-parser-go`) reads `general.architecture`, `tokenizer.chat_template`, `<arch>.context_length` from the `.gguf` binary | — | — |
| **Remote** | `/props` → `model_hf_architecture` field | Filename heuristics (see code) | `thinkingFormat: "none"` |

The `/models-list.json` endpoint is generated on-demand: Go scans `models/` at boot using `gguf-parser-go`, caches the result keyed on directory mtime, and re-scans on each request if the mtime changed. On hot-swap, the new entry appears on the next request. No mutable file, no drift.

**Degradation chain for remote mode:**

The `/props` endpoint may or may not include `model_hf_architecture` depending on the llama.cpp build version (present in most builds from r3170+). The Go server handles all levels gracefully:

```
props has model_hf_architecture?
  ├─ Yes → set thinkingFormat from architecture mapping table (primary)
  ├─ No → filename heuristics on model_path (best-effort fallback)
  │        ├─ Matches → set thinkingFormat
  │        └─ No match → thinkingFormat: "none" (final fallback)
```

The heuristic table (source code only — not enumerated in docs) maps common filename prefixes to architecture names. When no heuristic matches, the architecture defaults to the filename stem with special characters stripped.

**Why the final fallback doesn't break anything:** When `thinkingFormat` defaults to `"none"`, the only degraded feature is the **collapsible chain-of-thought UI** — the model's `<think>...</think>` blocks are displayed as inline text instead of collapsible sections. The model still generates thinking correctly, the chat still works, the context window (`n_ctx` from `/props`) is still managed. It's a UI polish feature that degrades gracefully rather than a functional failure.

**Local mode has no fallback:** `gguf-parser-go` reads directly from the GGUF binary header, which always contains `general.architecture`. No guessing needed — it's the complete and authoritative source.

---

### 4. State Sync (both)

| Method | Path | Behavior |
|---|---|---|
| `OPTIONS` | `/state` | 204 + CORS headers |
| `GET` | `/state/info` | `{"mtime":<ms>,"size":<bytes>}` + `X-State-Mtime` header — lightweight boot conflict check |
| `GET` | `/state` | Full JSON body + `X-State-Mtime` header — used by `restoreFromServer()` |
| `POST` | `/state` | Replace with new JSON body (validates parses as JSON first), returns `{"status":"ok","mtime":<ms>}` |
| `PUT` | `/state` | Same as POST |
| `POST/PUT` | `/state/info` | 405 method not allowed |

Both validate JSON before writing. Both use atomic writes (`.tmp` + rename). The `X-State-Mtime` header (string-encoded ms-since-epoch) is present on **all** successful `/state` and `/state/info` responses — not just `/state/info` as the table might suggest.

**`/state/info` — PowerShell vs Python: identical behavior, same origin story**

The two implementations return the exact same contract. The `/state/info` special-case route was a bugfix applied to the PowerShell codebase, and the Python port was written with that fix already present.

| Aspect | PowerShell (`fileserver.ps1`) | Python (`state.py`) |
|---|---|---|
| **Success response** | `{"mtime":<ms>,"size":<bytes>}` + `X-State-Mtime` header | `{"mtime":<ms>,"size":<bytes>}` + `X-State-Mtime` header |
| **Not-found response** | `404 {"error":"no state on server"}` | `404 {"error":"no state on server"}` |
| **mtime source** | `[DateTime]::LastWriteTimeUtc` → `.TotalMilliseconds` | `os.stat().st_mtime × 1000` |
| **size source** | `$item.Length` (bytes) | `stat.st_size` (bytes) |
| **UTC handling** | `LastWriteTimeUtc` — Windows-native UTC | `st_mtime` is already seconds-since-epoch UTC (POSIX spec) |
| **Result** | ms since 1970-01-01T00:00:00Z | ms since 1970-01-01T00:00:00Z |

No practical difference. On Linux, `st_mtime` is always stored as UTC seconds (POSIX guarantees this). No timezone translation is needed.

**Historical note (both):** This special-case route was added after a bug was discovered. The wildcard route (`/state` OR `/state/*`) previously sent `/state/info` into the full-body GET branch, which returned the entire state JSON. That body parsed fine on the client but lacked `mtime`/`size` fields, so the boot-time conflict check silently treated the server as empty — auto-restore and the conflict prompt could never fire, and any localStorage on a fresh origin (new IP, new device, cleared cache) showed an empty chat while the real data sat untouched on disk. The Python docstring reads: _"The /state/info branch was once missing, and the wildcard route sent it into the plain GET branch..."_ The PowerShell comment tells the identical story.

**Why this matters for Go:** The client-side logic in `checkServerStateOnBoot()` (`chat.html` line ~3680) depends on these specific field names (`mtime`, `size`) and the `X-State-Mtime` header to drive three decision paths:

1. **Auto-restore** — local empty, server has data → silently restore
2. **Quota-truncation recovery** — server bigger than local + not newer → pull complete history back
3. **Conflict detection** — server newer than last-known → show restore prompt

Any deviation in field names or response semantics would silently break the boot-time conflict detection.

---

### 5. Model Hot-Swap (both, but Python disabled)

| Method | Path | Behavior (Windows) | Behavior (Python) |
|---|---|---|---|
| `POST` | `/swap-model` | Kill llama-server → spawn new with chosen GGUF → 202 | 503 `{"phase":"error","message":"not configured"}` |
| `GET` | `/swap-status` | Poll `{"phase":"starting"→"ready"/"error"}` with readiness probe | `{"phase":"idle"}` always |

**Windows swap contract (full detail):**

| Phase | Meaning |
|---|---|
| `starting` | Stopping old model / loading new model |
| `ready` | llama-server `/health` returned 200; lock file released |
| `error` | Startup failed — includes diagnostic message from log tail |

Windows also has internal functions not exposed as endpoints:
- `Build-LaunchScript()` — generates the llama-server command line with all flags
- `Stop-LlamaServer()` — kills + waits for port to be free (250ms polling + 1.5s grace)
- `Write-SwapStatus()` / `Read-SwapStatus()` — reads/writes `.swap-status.json`
- `Get-LlamaStartupError()` — parses `llama-server.log` tail for human-readable errors
- `Write-ActiveModel()` — updates `active-model.json` on disk
- `Update-ModelsListActive()` — flips the `active` flag in `models-list.json`

**Added after this inventory was written: `/perf`.** Upstream 1.5.8 gave the
llama-server launch arguments a settings panel, which GETs `/perf` for
`{current, auto, overridden, modelMaxCtx}`, POSTs `{ctxSize, gpuLayers,
kvCacheType}` or `{reset:true}`, and then drives the swap contract above to
apply the change — rather than adding a second restart path. Neither
implementation compared in this table has it; the Go server does. See
**Runtime tuning** in `GO_SERVER.md`, which also explains why the override
lives in a `perf.toml` beside `config.toml` instead of upstream's
`.gobbonet-perf.json`.

---

### 6. Generation Jobs (Python only)

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/llm/jobs` | Spawn worker thread → spools raw SSE to disk → 202 `{"id":"...","status":"running"}` |
| `GET` | `/llm/jobs/<id>` | Poll: `{"status":"running","size":N,"next":M,"chunk_b64":"..."}` or terminal statuses |
| `POST` | `/llm/jobs/<id>/cancel` | Write cancel flag + close upstream socket → 200 `{"id":"...","status":"cancelling"}` |
| `DELETE` | `/llm/jobs/<id>` | Remove spool files; if running, cancel first → 200/202 |

**Worker lifecycle:**
- Max 4 concurrent workers (`JOB_MAX_CONCURRENT`)
- 30-minute hard timeout per job (`JOB_TIMEOUT_SECONDS`)
- 48-hour spool retention (`JOB_MAX_AGE_HOURS`)
- 256KB per-poll byte budget (`MAX_POLL_BYTES`), base64-encoded
- On boot: in-flight jobs marked `interrupted`, old spools swept

**Terminal statuses:** `done`, `cancelled`, `error`, `interrupted`

---

### 7. Reverse Proxy (both)

| Prefix | Upstream (Windows) | Upstream (Python) |
|---|---|---|
| `/llm/*` | `127.0.0.1:11434/*` | `GEMMA_LLM_URL` (default `192.168.1.100:8080`) |
| `/search/*` | `127.0.0.1:11435/*` | `GEMMA_SEARCH_URL` (default `127.0.0.1:11435`) |
| `/embed/*` | `127.0.0.1:11436/*` | `GEMMA_EMBED_URL` (default `127.0.0.1:11436`) |

**Proxy behavior (identical):**
- Strips the routing prefix
- Forwards method + path + query + body
- Strips hop-by-hop headers (`Host`, `Content-Length`, `Connection`, etc.)
- Streaming via chunked transfer encoding (no buffering)
- 600-second timeout
- Auto-redirect disabled
- 502 on upstream failure

**Key difference — Authorization header:**
- Windows: injects `--api-key` from config into proxied requests
- Python: injects `GEMMA_LLM_API_KEY` via `Authorization: Bearer <key>` header
- **Python additionally strips the client's `Cookie` header** (not forwarded upstream, because upstream is remote)
- Windows forwarded the cookie too (harmless when upstream is loopback it spawned itself)

**Endpoints the proxy passes through (chat.html calls these):**
| Upstream path | Purpose |
|---|---|
| `/v1/chat/completions` | Streaming chat |
| `/props` | Model metadata (chat template, model path) |
| `/apply-template` | Template rendering test |
| `/tokenize` | Token counting |
| `/health` | llama.cpp liveness |
| `/web_search` | Web search |
| `/health` (search prefix) | Web search liveness |
| `/v1/embeddings` | RAG embeddings |

---

### 8. Static Files (both)

| Path | Behavior |
|---|---|
| `/` | Serves `chat.html` |
| `/style.css` | Serves `style.css` |
| `/default-characters.json` | Serves character presets |
| `/favicon.ico` | Serves favicon (or 404 if absent — special-cased for unauthenticated) |
| Any other path in web root | Serves the file; 404 if not found |

**Traversal protection (both):**
- Rejects `..` path segments
- Rejects dot-prefixed files (`.git`, `.swap-in-progress`, `.jobs/`, etc.)
- Validates resolved path stays within web root

---

### 9. CORS (both)

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, PUT, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization` |
| `Cache-Control` | `no-store` |

**OPTIONS handling:**
- Windows: 204 + CORS headers (before auth gate)
- Python: 204 + CORS headers (via `do_OPTIONS` → `_dispatch` → explicit early return)

---

### Summary: What needs to exist in the Go server

| # | Endpoint group | Windows has it? | Python has it? | Go needs it? |
|---|---|---|---|---|
| 1 | Auth (login/logout/cookie) | ✅ | ✅ | ✅ |
| 2 | `/health-fileserver` | ✅ | ✅ | ✅ |
| 3 | Model metadata (active-model.json, models-list.json) | ✅ (static file) | ✅ (generated from upstream /props) | ✅ (GGUF header parsing for local mode, /props → filename heuristics → graceful degradation for remote) |
| 4 | State sync (`/state`, `/state/info`) | ✅ | ✅ | ✅ |
| 5 | Hot-swap (`/swap-model`, `/swap-status`) | ✅ (full) | ❌ (503) | **Required for local mode** — see dual-mode contract |
| 6 | Generation jobs (`/llm/jobs*`) | ❌ | ✅ | ✅ (important for mobile/background survival) |
| 7 | Reverse proxy (`/llm/*`, `/search/*`, `/embed/*`) | ✅ | ✅ | ✅ |
| 8 | Static file serving | ✅ | ✅ | ✅ |
| 9 | CORS + OPTIONS | ✅ | ✅ | ✅ |
| 10 | Model identification (`identify.py` + `gguf.py`) | ✅ (`identify-model.ps1`) | ✅ | **Solved** — uses `github.com/gpustack/gguf-parser-go` (Go-native, chunked reading, no model download needed) |

---

### ⚠️ Review Feedback — Action Items

> External review of the Go migration design. Each item includes the verdict and rationale.

#### Precondition: Write a conformance test suite

**Status: COMPLETE.** Implemented in Go test suite (`internal/server/conformance_test.go`), executed with `go test -race ./...` in CI.

This prevents the exact `/state/info` regression described above: the wildcard route swallowed it, the client parsed the body fine, and boot conflict detection silently never fired. Prose can't catch that a second time. The suite asserts on:
- Field names (`mtime`, `size`) on all `/state*` responses
- `X-State-Mtime` header on all `/state*` responses
- 405 on `POST /state/info`
- `..` and dot-file rejection on static file serving
- 401 content-negotiation split (HTML vs JSON)

---

#### §1 Auth: rate limit + Argon2 migration

**Rate limit on `POST /login`** — Adopt. Constant-time compare doesn't protect against connection floods. Per-IP token bucket, ~10 lines. Highest-ROI security fix.

**Password hashing: switch from SHA-256 to Argon2** — Adopt. `access_secret` is a salted SHA-256, which is a single-round hash — trivially bruteforceable on a 4090. Use `golang.org/x/crypto/argon2` (id-mode). Implement rehash-on-login so existing users get migrated to Argon2 on their next login without forced re-auth.

---

#### §2 Health: upstream liveness + mode detection

**Add `upstream_ok` to `/health-fileserver`** — Adopt. The endpoint currently reports only the Go process's own liveness. For a proxy server, this is misleading — the diagnostic endpoint lies in the scenario you'd use it to debug. Add a cached (~3s TTL) `upstream_ok` boolean.

**Fix mode detection — fatal error for misconfigured local mode** — Adopt. Current logic: `server_exe != "" && file exists && model_dir is a dir` → local, else remote. A typo'd path silently demotes you to remote mode, proxying to `127.0.0.1:11434` where nothing listens, and `/health-fileserver` cheerfully reports `"status":"ok"`.

Treat non-empty `server_exe` pointing at a missing file as a **fatal config error**, not a mode switch. Non-empty is a statement of intent. Also decouple `model_dir` from mode — "do I supervise the process" and "where do I enumerate models" are unrelated questions.

---

#### §3 Model metadata: dynamic models-list

**Replace static `models-list.json` with on-demand GGUF scanning** — Adopt. The current design writes a static file during setup and mutates the `active` flag on hot-swap. This reintroduces the exact drift risk that motivated the Go migration (the Windows failure mode). Scan `model_dir` at boot using `gguf-parser-go`, cache keyed on directory mtime, re-scan on each request if the mtime changed. This eliminates the mutable file entirely and makes dropping a GGUF into `models/` just work.

---

#### §5 Hot-swap: process groups, stderr ring buffer, rollback

**Process group management** — Adopt, critical. `SysProcAttr{Setpgid: true}` on Linux and job objects on Windows are mandatory. Without them, llama.cpp children outlive the swap and hold the port and VRAM. This is the single most likely cross-platform bug.

**Stderr ring buffer** — Adopt. Replace log-tail regex parsing with a ring buffer capturing llama-server's stderr. Structured errors instead of grepping a file.

**Auto-rollback on failed swap** — Adopt. Retain the previous command line and auto-rollback when the new one fails to load. A bad GGUF shouldn't leave you with no server at all. On a 4090 with dual-model constraints, kill-then-start is the only viable strategy, so rollback is essential.

---

#### §6 Generation jobs: in-memory redesign

**Keep jobs in memory, drop disk spooling** — Adopt. Disk spooling and cancel-flag files exist because a PowerShell runspace cannot share state with the listener; a goroutine can. At ~150 tok/s, thirty minutes is single-digit MB; four concurrent jobs is tens of MB. Just hold it in memory.

This is the one job-related divergence, and it is safe because it changes nothing on the wire except a restart's terminal status: a dropped job 404s and the client reports `lost` where PowerShell reports `interrupted`. Both are terminal and `js/03-generation.js` handles each.

**`context.Context` for cancellation** — Adopt. No flag files. Context propagates into the upstream request, so a cancel frees the llama.cpp slot immediately rather than at end of generation.

**Drop base64 framing** — ~~Adopt~~ **REVERSED.** This was implemented, shipped, and then backed out. The reasoning ("SSE payloads are UTF-8; a JSON string carries them fine, saves 33%") is technically correct and entirely beside the point: `chunk_b64` is the framing `fileserver.ps1` defined, and the stock frontend reads that key and no other. Sending `chunk` does not fail loudly — `js/03-generation.js` finds no `chunk_b64`, leaves its offset unmoved, computes `drained = offset >= size` as false, and polls a perfectly healthy job forever while the user watches a spinner. Nothing is logged on either side.

Two things followed the reversal. The rune-alignment logic in `read()` went with it — it existed only to stop Go's JSON encoder turning a split character into U+FFFD, base64 has no such hazard, and it carried its own stall: a window holding no complete character returned empty and never advanced `next`. And the wire format is now pinned by `internal/server/conformance_test.go`, because a silent infinite poll is not something to rediscover by hand.

The general rule this cost us: the poll response is a contract with a client that reports unknown shapes as silence. Optimise the transport all you like; do not rename its fields.

**Keep polling as primary interface** — The reviewer suggests adding `GET /llm/jobs/{id}/stream?from=N` with `Last-Event-ID` as the primary interface. This adds client complexity for no client benefit. Keep the polling endpoint as primary; if a stream endpoint is added later, it's a separate feature.

---

#### §7 Reverse proxy: use httputil

**Use `httputil.ReverseProxy` with `FlushInterval: -1`** — Adopt. Reimplementing hop-by-hop header stripping is reinventing the wheel. Use Go's standard library with `ResponseHeaderTimeout` given real headroom (a 40K-context prefill can run 30s before the first byte). The 600-second timeout should be the *idle* timeout, not total.

---

#### §9 CORS: SameSite + Host validation

**Fix CORS cookie attack surface** — Adopt partially. The reviewer's scenario (CORS `*` + cookie auth) is mitigated by the auth gate (401 blocks unauthenticated requests regardless of CORS). However, the fixes are trivial and good practice:
- `SameSite=Lax` on the session cookie
- `Host` header validation against an allowlist (relevant because we bind `0.0.0.0` by default — DNS rebinding is in scope)
- Keep `*` for `Access-Control-Allow-Origin` — browsers reject `*` for credentialed XHR anyway, and form POSTs / `<img>` tags aren't gated by CORS at all, so the auth gate is the real boundary

---

### Local Mode vs Remote Mode — Design Principle

The Go server is **not** a choice between local or remote. It supports **both simultaneously**, with **full feature parity** in each mode. This is the core design constraint:

| Feature | Local mode | Remote mode | Notes |
|---|---|---|---|
| Auth (login/logout/session) | ✅ | ✅ | Server-level, mode-agnostic |
| State sync (`/state`, `/state/info`) | ✅ | ✅ | Server-level, mode-agnostic |
| Reverse proxy (`/llm/*`, `/search/*`, `/embed/*`) | ✅ | ✅ | Always a proxy; the upstream is local loopback or remote |
| Generation jobs (`/llm/jobs*`) | ✅ | ✅ | Server-level threading; mobile/background survival |
| Static file serving | ✅ | ✅ | Always serves chat.html, style.css, etc. |
| CORS + OPTIONS | ✅ | ✅ | Always enabled |
| Model metadata (`/active-model.json`, `/models-list.json`) | ✅ GGUF header parsing | ✅ `/props` with `model_hf_architecture` (filename heuristics as fallback) | Source differs, output is identical |
| Model hot-swap (`/swap-model`, `/swap-status`) | ✅ Full | ❌ (503) | Only possible when Go manages llama.cpp locally |
| `/health-fileserver` with `hotswap` flag | ✅ `true` | ❌ `false` | Tells frontend what's possible |
| `launch.sh` as single-entry-point | ✅ One command | ✅ One command | Both modes start with `launch.sh` |
| Web search (`/search/*`) | ✅ Loopback port | ✅ Any reachable URL | Both use the same proxy |
| RAG embeddings (`/embed/*`) | ✅ Loopback port | ✅ Any reachable URL | Both use the same proxy |

**What "full feature parity" means:**
- Chat, streaming, context window, character cards, personas, lore, RAG storybooks, scheduler, extensions, macros, variants/rerolls, data export/import, model dropdown — all work identically in both modes
- The only feature that's mode-specific is **hot-swap** (swapping GGUF files on-the-fly), which requires Go to control the llama.cpp process. In remote mode, this is unavailable (the client's model dropdown becomes informational-only, showing the remote model but not offering a swap)
- The model dropdown in remote mode shows the model name from `/props` and lists any local GGUF files, but the "swap" button is hidden or disabled

**Why this matters:**
- Windows users on the automatic `launch.bat` path get local mode with full hot-swap
- Linux users on `launch.sh` also get local mode with full hot-swap
- Anyone pointing their setup at a remote llama.cpp server still gets chat, state sync, generation jobs, web search, RAG, characters, lore — everything except hot-swap
- No feature-flag toggling in the UI. The server reports its capabilities and the frontend adapts. The user experience is seamless.
