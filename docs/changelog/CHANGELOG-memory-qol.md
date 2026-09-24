# Memory and engine lifecycle QOL patch

Built on the delivered PR60 fixes and launcher update. No GitHub changes.
No added dependencies, telemetry, downloaded runtime services, model changes,
context reductions or KV-precision changes.

## Engine lifetime

- Serialize boot, wake, swap, recovery, idle unload and shutdown. Request wake
  and activity registration are atomic relative to idle unloading.
- Failed startup/wake attempts terminate and reap their engine before returning.
  Cleanup failures retain ownership and block replacement. An occupied engine
  port is reported before loading another model; unrelated processes are not killed.
- Recovery is one generation-specific loop with at most three failed attempts.
  Shutdown permanently prevents later wake/restart. A successful rollback stays
  eligible for idle unloading, while the failed swap still reports its error.
- Windows uses a separate kill-on-close job for each engine generation. Cleanup
  queries and terminates job membership, including children whose parent exited,
  rather than relying on the parent PID alone. Job assignment failure is logged;
  existing taskkill fallback remains. Assignment follows process creation, so the
  small existing pre-assignment child-spawn window is not eliminated.
- Background generation holds its activity lease until the worker and upstream
  stream finish, including cancellation/error paths. HTTP 202 is not completion.
  Invalid jobs do not wake the model. Health/status polling does not wake it.
- Keep the existing five-minute idle default. Report unload success only after
  cleanup, and never interrupt active generation for an idle timeout.

## GPU placement

`gpu_layers = -1` selects automatic placement. New generated configurations and
this ZIP's managed Windows batch launch use it by default. Existing config.toml
and perf.toml values are preserved: explicit 0/20/99/etc. still mean precisely
those requested layer settings. On an existing shortcut installation, choose -1
in CONFIG's GPU layers field and apply/restart to opt into automatic placement.

Auto uses the engine's own `--fit on`, `--fit-target` and `--fit-ctx` options with
an explicit context and the existing KV precision. `gpu_reserve_mib = 1024` is the
new config-file default: target 1 GiB free per device. This is a fitting target,
not a hard cap or a promise about other applications allocating later. CPU
placement uses system RAM and can reduce speed. This patch does not implement a
hard system-RAM budget or make a model fit hardware that cannot hold it.

Before an automatic load, inspect local `llama-server --help` with a timeout and
bounded output; cache the result until the executable size/mtime changes. Older
engines missing the required options get a clear error before model loading,
not an unexpected fallback to all-GPU allocation. The existing pinned b10456
supports the options. Explicit numeric settings do not require this probe.
Legacy batch/PowerShell mode retains its previous 99-layer default and announces
that automatic fitting requires the managed Go launcher. No engine auto-update.

## Reporting

The model-load sentence now labels its number as model buffers, rather than
implying total VRAM. A separate engine-reported subtotal includes model, KV,
compute and recurrent-state buffers when recognized. Host/pinned buffers are
excluded. Repeated reports replace the same named buffer instead of adding it
again. Actual context is shown when reported. Driver/unreported allocations and
shared-vs-dedicated physical residency are not inferred from these log values.
The original complete engine log remains available.

## Validation and limits

- Full Go test run: all packages pass except the previously documented
  TestVersionFileMatchesUpstreamRelease mismatch (VERSION 1.7.5, nearest release
  tag v1.7.3). Release metadata is unchanged.
- Race-enabled supervisor, jobs and server tests pass.
- Real child-process regression tests cover startup timeout cleanup, repeated
  failed wakes, concurrent single-load wake, active-request protection, shutdown
  during boot and refusal to use an already occupied engine port.
- Job tests cover the activity lease after HTTP 202, release on cancellation,
  invalid input without a wake, and failed wake without a registered job.
- Automatic-argument, unsupported-engine, help-cache, explicit-setting and
  allocation-reporting tests pass. Launcher flag checks and all 22 frontend
  suites pass.
- Windows amd64 and Linux amd64 binaries are rebuilt with staged embedded UI.
  A native Windows job-tree regression test is included and cross-compiled;
  it cannot run in this Linux environment.
- No GPU is available here. Actual VRAM savings and performance across GPU/model
  combinations have not been measured. Batch sizes, Flash Attention policy and
  KV/model quantization are deliberately unchanged pending those measurements.

## Suggested on-device acceptance run

Cold start; long generation beyond the idle timeout; idle unload with the tab
open and closed; wake; repeated model swaps; failed load; exit during loading.
Check owned engine count, dedicated/shared GPU memory, system RAM, response
continuity and load/reply latency. Compare the same model/context/precision and
workload. There should be no accumulating engines across transitions, and no
idle unload while a reply is still running.
