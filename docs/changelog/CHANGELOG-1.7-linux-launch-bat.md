# v1.7 — "I need to run launch.bat?"

*Closes #43.*

---

## Symptom

A Linux user installs GobboNet, downloads a model, and the landing page says:

```
● OFFLINE — run launch.bat
Error: HTTP 502
```

They search the disk for `launch.bat`, do not find it, and open an issue
asking where it is. Sending a chat gives:

```
Post "http://127.0.0.1:11437/v1/chat/completions":
dial tcp 127.0.0.1:11437: connect: connection refused
```

A second reporter hit the same wall and got out only by finding
`~/.local/share/gobbonet/llama-server.log` themselves, where the real answer
had been all along:

```
ggml_vulkan: Device memory allocation of size 1047613056 failed.
ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory
```

A 20B model on a 12 GB card. Nothing to do with `launch.bat`.

---

## Cause

Two faults, and the second hid the first.

**The instruction was hardcoded and wrong.** `js/13-dashboard.js` printed
`OFFLINE — run launch.bat` whenever the connection check failed, on every
platform. There is no `launch.bat` on Linux. It is also wrong on Windows in
1.7, where `gobbonet.exe` is the launcher and `launch.bat` only adds models.

**The real reason was already known and never asked for.** The supervisor
captures llama-server's stderr, and `ringBuffer.LastError()` pulls the
actionable line out of it — its match list has included `out of memory` all
along. A failed boot records `phase: "error"` with that text, served at
`/swap-status`.

So the answer was sitting in memory, one HTTP call away, while the UI showed
a guess. The frontend polled `/health` for a yes/no and never asked why.

`Error: HTTP 502` came from the same place: the raw proxy status, printed
verbatim. True, and no help.

---

## Fix

**The pill reports what actually happened.** When the connection check fails,
`checkConnection()` now also reads `/swap-status` and the landing page shows
that text verbatim:

```
● OFFLINE — ggml_vulkan: Device memory allocation of size 1047613056 failed.
```

Blunt on purpose. The failure in #43 was information being withheld, so the
full line goes on screen, with the untruncated text in the tooltip because
llama.cpp can be wordy.

When nothing can be learned it falls back to `OFFLINE — llama-server is not
responding`: still true, still platform-neutral, and it does not send anyone
looking for a file. A model that is merely still loading now reports
`LOADING MODEL — <name>` in the ready colour, since that is not a failure.

**A Go bug found on the way.** `restartAfterCrash` logged its failures but
never called `setStatus`. If llama-server died after a good start and every
restart then failed, `/swap-status` kept reporting the `ready` it was set to
before the crash — the one endpoint you would ask "is the model up, and if
not why" answering with a stale yes while nothing was listening.

Harmless while nothing consumed it. Not harmless now that the landing page
does, so each failed attempt publishes its reason.
`TestRestartAfterCrashPublishesFailure` covers it; with the fix reverted it
fails with `phase = "ready" after failed restarts`, which is the bug exactly.

**Seven other places said the same wrong thing.** Fixing only the pill would
have moved the reporter to the next one. All are user-visible strings:

| Where | Was |
|---|---|
| `02-model.js` hot-swap toast | *Open the chat from launch.bat* |
| `02-model.js` perf panel | *Start from launch.bat* |
| `02-model.js` perf restart | *restart launch.bat to apply* |
| `03-generation.js` connection error | *Launch chat via **launch.bat*** |
| `06-state-sync.js` backup alert | *only available when launched via launch.bat* |
| `11-search.js` proxy console | *Make sure launch.bat is running* |
| `11-search.js` search test log | *Make sure you launched via launch.bat* |

All now refer to GobboNet and the address it prints at startup. The
connection-error diagnostic additionally points at the landing page, which is
now the thing that knows the answer.

Two stale UI strings went with them: the About panel described the server as
a *"PowerShell HTTP listener + launch.bat"*, which is the 1.6 architecture,
and the search hint claimed the proxy *"is started by launch.bat"*.

Every remaining `launch.bat` in `js/` is inside a comment, describing history
accurately. Those were left alone.

---

## Files changed

| File | Change |
|---|---|
| `internal/supervisor/supervisor.go` | `restartAfterCrash` publishes each failure through `setStatus` |
| `internal/supervisor/restart_status_test.go` | New — regression test for the stale status |
| `js/04-state.js` | `serverOfflineReason` / `serverOfflinePhase` |
| `js/11-search.js` | `refreshOfflineReason()` reads `/swap-status`; two hint strings |
| `js/13-dashboard.js` | `offlineStatusHtml()` replaces the hardcoded pill |
| `js/02-model.js` | Three user-facing strings |
| `js/03-generation.js` | Connection-error diagnostic |
| `js/06-state-sync.js` | Backup alert |
| `chat.html` | About panel; search hint |

No new endpoints. `/swap-status` already existed and already answered this.

---

## Not fixed here

The VRAM exhaustion behind the second report. Recommending a 20B model for a
12 GB card is #23/#39. This makes that failure legible; it does not stop it
happening.

---

## Verification

- `offlineStatusHtml()` exercised over six inputs: VRAM error, empty message,
  loading with and without a model name, idle/remote, a 400-character
  message, and hostile markup in stderr. All escape cleanly — that text is a
  subprocess's stderr rendered into both text and attribute context, so
  `escapeHtml` is load-bearing, not decorative.
- Reverting the supervisor fix makes the new test fail with the exact stale
  `ready`; restoring it passes.
- `go build`, `go vet`, all 11 Go test packages green.
- All 9 of the repo's own `.mjs` suites pass; every `js/*.js` parses.

What still needs a real box: seeing the message on a machine where
llama-server genuinely fails. There is no GPU here, so the pill was tested
against synthesised statuses rather than a live failing server.
