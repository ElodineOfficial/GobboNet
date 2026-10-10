# MoE models get more headroom under automatic GPU placement

For issue #65. No new dependency, no new config key, no change for dense models.

## What broke

On a card a Mixture-of-Experts model does not fit (8-12 GB with Qwen3.6 35B-A3B,
Gemma 4 26B-A4B or gpt-oss 20B), automatic placement loaded the model and ran it
at well under what the hardware can do: the 35B at 13 t/s instead of 21, gpt-oss
at 9 instead of 20, Gemma reading prompts at a third of its speed. Nothing was
reported. It looked like "my card can't handle this model".

## Why

The engine's fit pass is MoE-aware: dense parts of every layer on the GPU, most
experts in RAM, as many layers' experts on the GPU as it believes fit. It aims to
leave `gpu_reserve_mib` (1024) free and lands exactly there. But that target does
not cover the compute buffers allocated after loading or the VRAM the desktop
already holds, so the driver pages ~1 GB of the engine's allocations out to
system RAM. Windows' per-process "Shared GPU memory" counter shows it: ~650-880
MB during generation at 1024, ~65 MB at 2048.

Dense models at 1024 do not spill (a 9B measured 38.7 t/s with all layers on the
GPU), and raising the reserve for them costs real speed (29/33 layers, 22.4 t/s).
So the fix has to be conditional on the model.

## What changed

- `models.ReadGGUFMeta` reads `<arch>.expert_count` (gguf-parser-go already
  exposes it); `ClassifyInput` and `Record` carry it as `ExpertCount`, settled up
  front in `Classify` like context length is.
- `supervisor.BuildArgs` passes `--fit-target max(gpu_reserve_mib, 2048)` for a
  record with `ExpertCount > 0`, and `gpu_reserve_mib` unchanged otherwise. The
  floor is `MoEFitTargetMiB`, with the measurements in its comment.
- The `[memory]` policy line reports the target actually passed.
- `config.toml` comment on `gpu_reserve_mib` says so.

## What pins it

`TestMoEModelsGetMoreFitHeadroom`: a dense record keeps 1024, a MoE record gets
2048, a configured 3072 is never lowered, and explicit layer counts never carry
fit flags. Measured outcomes (both states this rule produces, through
`gobbonet.exe` on a stock 1.7.6 copy with the pinned engine) are attached to #65.
