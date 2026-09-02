# v1.7 — VRAM recommendations that leave room to run

*Closes #23. Supersedes #39, whose conclusion was right and whose stated
mechanism was not — see below.*

---

## Symptom

The installer recommended **gpt-oss 20B** — a 12 GB download — to a 12 GB
card, gave no pre-download warning, and only mentioned VRAM pressure after
the download finished and the server had started:

```text
[*] VRAM WARNING: Model is tight on your GPU memory.
```

On the reporter's RTX 4070 llama.cpp then said:

```text
Vulkan0 : NVIDIA GeForce RTX 4070 (12226 MiB, 11030 MiB free)
common_fit_params: failed to fit params to free device memory:
n_gpu_layers already set by user to 99, abort
```

`llama-server.exe` crashed on the first message. The chat UI showed a generic
connection error. It took them roughly five hours to work out why.

---

## Cause

**Rung thresholds were set to each model's download size.** A card clearing
12 GB was offered a 12 GB model, leaving nothing for the KV cache, llama.cpp's
compute buffers, or the ~1.2 GB Windows holds for the display. The measured
free VRAM was 10.77 GiB against an 11.28 GiB model: the weights alone did not
fit, before any cache existed.

**The pre-download warning could not fire.** It triggers on
`vram < min_vram`, and `min_vram` for gpt-oss was also 12. So `12 >= 12`
waved through precisely the card that needed stopping.

**It was never only the 12 GB rung.** Three of four were overcommitted:

| Card | Was offered | File | Spare |
|---|---|---|---|
| 16 GB | Gemma 4 26B | 16 GB | **0.0 GB** |
| 12 GB | gpt-oss 20B | 12 GB | **0.0 GB** |
| 8 GB | Qwen3.5 9B | 6.2 GB | 1.8 GB |
| 6 GB | Gemma 4 E4B | 5.4 GB | **0.6 GB** |

The 16 GB rung is the same bug and nobody had reported it yet.

---

## A note on PR #39

Its headline is *"Uses `usable_budget_gb` instead of nominal VRAM"*. That
change would have done nothing here. For a discrete card the two numbers are
identical by construction:

```powershell
if (-not $IsIntegrated -and $VramGB -ge 4) {
    return @{ gb = $VramGB; source = 'gpu' }
}
```

On an RTX 4070 both read 12. `usable_budget_gb` differs only for integrated
graphics and CPU-only machines. The part of #39 that does the work is the
other bullet — requiring more than 12 GB for gpt-oss — and its choice of
Qwen3.5 9B for 12 GB cards is adopted here unchanged.

---

## Fix

**One rule, applied everywhere:** a rung may only offer a model at least 2 GB
smaller than the rung, and `min_vram` is never below file size + 2 GB. The
2 GB is `headroom_gb`, already defined in the catalogue schema and until now
carried but unused.

New ladder:

| Card | Now gets | File | Spare |
|---|---|---|---|
| 20 GB+ | Gemma 4 26B-A4B MoE | 16 GB | 4.0 |
| 16 GB | gpt-oss 20B | 12 GB | 4.0 |
| 12 GB | Qwen3.5 9B | 6.2 GB | 5.8 |
| 8 GB | Gemma 4 E4B IT | 5.4 GB | 2.6 |
| below | Llama 3.2 3B | 3.4 GB | 2.6+ |

Biggest cards keep the biggest model; gpt-oss moves up to the rung where it
fits rather than being dropped.

`min_vram`, raised and never lowered — slot 10 already asked for more than the
rule gives and that judgement was left alone:

| Slot | Model | File | Was | Now |
|---|---|---|---|---|
| 1 | Gemma 4 E4B IT | 5.4 | 6 | 8 |
| 2 | Llama 3.2 3B | 3.4 | 4 | 6 |
| 3 | Mistral 7B v0.3 | 7.5 | 8 | 10 |
| 4 | Qwen3.5 9B | 6.2 | 8 | 9 |
| 5 | Gemma 4 26B-A4B | 16 | 16 | 18 |
| 6 | Qwen3.6 35B-A3B | 22 | 24 | 24 |
| 7 | DeepSeek-R1 8B | 8.5 | 10 | 11 |
| 8 | gpt-oss 20B | 12 | 12 | **14** |
| 9 | Command R 7B | 6.6 | 8 | 9 |
| 10 | Command R 35B | 19 | 24 | 24 |

On the reporter's machine gpt-oss 20B is now listed as
`[ needs ~14 GB VRAM - will be slow ]` and is not the recommendation — which
is the second option from their own "Expected behavior" list.

**Both warnings stopped overclaiming.** They said the model *"can still run by
spilling into system RAM, but expect it to be noticeably slower"*. With
`--n-gpu-layers 99` forced, llama.cpp does not spill — its fitting pass aborts,
which is the crash in this report. Both copies now say it may run far more
slowly and on a large enough shortfall will fail to start at all.

---

## Files changed

| File | Change |
|---|---|
| `hw-recommend.ps1` | `$min` table and the `$rec` ladder |
| `launch.bat` | Eight `PICK_MIN` values; pre-download prompt wording |
| `installer/models.ini` | Regenerated |
| `installer/gobbonet.nsi` | Pre-download dialog wording |

The thresholds live in two hand-maintained tables in two languages.
`gen-catalog.py` cross-checks them and refuses to build on drift — verified by
desyncing slot 8 on purpose, which produced:

```
ERROR: hw-recommend.ps1 and launch.bat disagree about the VRAM gate for
slot(s) 8: 8: $min=14 PICK_MIN=12.
```

---

## Not changed

**`--n-gpu-layers 99`.** #23 also suggests reducing layers automatically when
the configuration will not fit. Dropping the forced count would let llama.cpp
fit params itself — its log literally says the abort is because the value was
user-set — but that changes model loading for every existing install, on
hardware not available here. Worth doing; worth doing deliberately.

**The recommendation the app shows after install.** The ladder is consumed by
the NSIS installer only; the Go setup wizard lists models with their
`min_vram` and does not preselect. Both now read the corrected figures.

**Remote catalogues.** The ladder ships in `models.ini`. A hosted catalogue
that still carries the old rungs would reintroduce this for the in-app model
browser, which is outside this repository.

**`:llm_state` in `launch.bat`.** #23's secondary report — the embedding
server keeping a `tasklist` image-name check positive after the chat server
died, stalling recovery for ~2 minutes — is already gone in 1.7's Go
supervisor, which tracks its own child by handle. It survives only in the
legacy batch path.

---

## Verification

- The installer's ladder replayed across 19 VRAM sizes from 0 to 32 GB.
  Every recommendation leaves at least 2 GB, and no recommendation triggers
  its own pre-download warning — a combination that was reachable before and
  is what #23 hit.
- The launcher menu replayed for a 12 GB and a 16 GB card; both label the
  models that no longer fit and mark a model that does.
- `gen-catalog.py` cross-check confirmed to fire on deliberate drift.
- Batch linter still clean on all four scripts, CRLF intact.
- `go build`, `go vet`, all 11 Go packages, and all 9 `.mjs` suites pass.

What still needs real hardware: confirming a 12 GB card is offered Qwen3.5 9B
and that it loads with room to spare. The arithmetic is checkable here; the
GPU is not.
