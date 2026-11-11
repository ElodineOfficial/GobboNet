# 1.8.0 — Choose the GPU, and see which one the engine uses

Issue #72 (NeoArte). Roadmap item #12.

## What was happening

On a hybrid laptop (an Intel GPU and a 2 GB NVIDIA GeForce 940MX), the
NVIDIA card went unused, and nothing in GobboNet said which GPU the engine
saw or let the user pick one. The likely causes, in order:

1. The Linux launcher fell back to the CPU build of the engine because the GPU
   build would not start, and said so only in `launch.log`.
2. The NVIDIA Vulkan driver was not visible, so only the Intel GPU was listed.
3. The card was used, but with 2 GB and the 1 GB reserve very few layers fit.

`internal/engine/devices.go` already asked the engine (`llama-server
--list-devices`), but only the Linux setup wizard used it.

## The change

**`gpu_device`**, a new config key, default `"auto"`.

- **auto** leaves the choice to llama.cpp: every dedicated GPU, and an
  integrated one only when there is no dedicated one.
- **none** passes `--device none`, so the processor does everything.
- **A device ID**, as `--list-devices` names it (`Vulkan1`, or
  `CUDA0,CUDA1` for two), is passed as `--device`.

The value must match a fixed pattern to be saved or loaded at all
(`engine.ValidDeviceSetting`). It is then checked against the engine's own
list before use (`engine.ResolveDevice`), and is always passed as one
argument, never through a shell. A device that is no longer listed falls back
to automatic with a warning, so a removed card never stops GobboNet starting.
"auto" runs no probe at start-up at all.

**`gpu_prime_offload`**, Linux only, default off. It sets the fixed pair
`__NV_PRIME_RENDER_OFFLOAD=1` and `__VK_LAYER_NV_optimus=NVIDIA_only` on the
engine process alone, as `prime-run` does. A launch from the desktop menu
never goes through `prime-run`, so this makes the choice stick. It is offered
only when the engine sees an integrated GPU and nothing else.

**CONFIG > Model & Performance > Performance** gets a **GPU** menu: Automatic
(prefers a dedicated GPU), each device the engine lists with its memory (the
integrated one marked as using system memory), and None: the processor only.
It is saved by the box's own buttons, and SAVE & RESTART MODEL restarts on it
through the swap path, like the other launch settings. RESET TO AUTO sets it
back to Automatic and leaves the PRIME switch alone, since that switch fixes
the machine rather than tuning the model. Under the menu, a note covers:

- the CPU-build fallback and the launcher's reason for it;
- devices that could not be listed, or no GPU at all;
- a saved card that is no longer there (it stays selected, marked "not found
  now");
- a chosen card under about 3 GB: only a few layers fit, and the rest run on
  the processor;
- PRIME offload, with its switch, when the engine sees only an integrated GPU.

Remote mode hides the menu.

**`/gpu`** (`internal/server/gpu.go`). GET lists the devices, the setting
from `config.toml`, what the next start will use, and on Linux whether PRIME
is offered and which build the launcher picked. POST saves both keys and
hands them to the supervisor for the next start. Like `/perf`, any signed-in
device may use it, and a page on another site cannot (`sameOriginOrNone`).
The device list comes from `engine.ProbeDevices`, which runs the engine once
per engine file and caches the answer, so opening CONFIG never starts the
engine again.

**gobbonet doctor** has a **GPU** section:

- the engine build (Linux): GPU, or CPU ONLY with the launcher's reason and
  what usually fixes it;
- each device with its memory, integrated or dedicated;
- what `gpu_device` makes of them, including which card "auto" picks here and
  why a stale ID was dropped;
- the PRIME switch, and a suggestion when it would help;
- a small-card note;
- where the last load went ("on NVIDIA GeForce 940MX -- 12 of 33 layers on the
  GPU …"), rebuilt from `llama-server.log` with the console's own load
  sentence.

**The Linux launcher notes its choice.** `pick_engine()` in
`installer-linux/gobbonet-launch` (both copies) writes
`~/.local/share/gobbonet/engine-choice`, beside `launch.log`: `build=gpu`,
`build=cpu` with the GPU build's own last words as the reason (usually
"error while loading shared libraries: libvulkan.so.1"), or `build=none`.
Doctor and CONFIG read it.

Docs: README (two troubleshooting entries), LINUX-START-HERE.md, GO_SERVER.md,
and the generated `config.toml`.

## Tenets

- **Private.** No new tools and no network: the device list comes from the
  engine itself.
- **Secure.** The device ID is pattern-checked and passed as one argument.
  The PRIME variables are a fixed pair, not free text.
- **Easy.** Automatic stays the default.
- **Power.** Device, reserve and layers are all keys.

## Tests

- `internal/engine/gpuchoice_test.go` (new): a ParseDeviceList fixture for an
  Intel iGPU plus an NVIDIA 940MX (integrated flags, the dedicated pick, the
  small card); PRIME offered only for an integrated-only list; the setting's
  pattern, with shell and flag injection refused; ResolveDevice for auto,
  none, an ID in any case, two IDs, a stale ID, a mix, and an engine that
  could not list its devices; the launcher's engine-choice file.
- `internal/supervisor/device_test.go` (new): gpu_device becomes `--device`,
  none is `--device none`, auto passes nothing, and Options seed it; the last
  load's sentence is rebuilt from the log's last run.
- `internal/supervisor/prime_env_test.go` (new, Linux): the PRIME pair reaches
  the engine's environment only when switched on, the rest of the environment
  is kept, and GobboNet's own process never takes it.
- `internal/server/gpu_test.go` (new): GET lists the devices; POST writes
  `config.toml` and the next start with the engine's spelling; auto clears
  `--device`; stale, injected and empty choices are refused with nothing
  written; PRIME is refused off Linux; a cross-site POST is refused; a probe
  that failed is reported and blocks a named device; PRIME is offered for an
  integrated-only list; remote mode.
- `cmd/gobbonet/doctor_gpu_test.go` (new): the CPU-fallback message with its
  reason; devices, what auto picks, the small card and the last load; a stale
  setting explained; remote mode; PRIME suggested for an integrated-only list.
- `tests/test-gpu-choice.mjs` (new): the menu's options and labels; the saved
  choice selected in any case; a card that is gone kept and explained; the
  small-card, CPU-build, PRIME, probe-error and no-GPU notes; the PRIME switch
  only on Linux and only when offered; remote mode hidden; saving only what
  changed; a refusal shown; the box's buttons and RESET TO AUTO going through
  it.
- `tests/test-config-sections.mjs`: the menu's ids and labels.
- `tests/test-engine-args.py`: `--device` joins the flags the Go path passes
  and `launch.bat` does not, with its reason.
- In a browser (Playwright, not committed), against `gobbonet serve` and a
  stand-in engine that lists an Intel and an NVIDIA GPU: the menu, the note,
  SAVE & RESTART MODEL starting the engine with `--device Vulkan1`,
  `config.toml` updated, and RESET TO AUTO. `gobbonet doctor` was read live
  with a CPU-fallback note in place.

Not run here: a real GPU, and PRIME on a real hybrid laptop. The console
snippet shows what your engine sees on your PC.
