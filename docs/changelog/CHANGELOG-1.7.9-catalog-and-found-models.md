# 1.7.9 — A bigger catalogue, pinned checksums, and models already on your computer

*Patch step 12 of 1.7.9: F2, "Expanded model catalog", and issue #12, models
already on the computer. Thanks to sam-henry-dev and iiiCpu for issue #12.*

## What was happening

- **The catalogue had gaps.** Ten models, with nothing tiny for a machine
  without a GPU, nothing between 9 and 16 GB that was a plain dense model, one
  large dense model, and no coding-focused MoE.
- **Nothing was pinned.** No entry carried a SHA-256 of its own. Every download
  was checked only against HuggingFace's own record of the file, which comes
  from the same host as the file. The generator had a pattern that could not
  read `DL_SHA256` at all, so a pin written into `launch.bat` would never have
  reached `models.ini`.
- **Issue #12.** Someone who already had GGUFs, in the HuggingFace cache or in
  LM Studio's folder, had to download them again or copy them by hand into
  GobboNet's models folder: twice the disk, and minutes of copying.

## The catalogue

**Six new models, one for each gap:**

| # | Model | Tier | Size | Why |
| --- | --- | --- | --- | --- |
| 12 | Llama 3.2 1B Instruct, Q8_0 | Light | 1.3 GB | runs on almost anything, even without a GPU |
| 13 | Mistral Nemo 12B (2407), Q4_K_M | Medium | 7.5 GB | a roleplay favourite; Tekken, so it relies on step 2's fix |
| 14 | Phi-4 14B, Q4_K_M | Medium | 9.1 GB | careful reasoning and code |
| 15 | Mistral Small 3.2 24B (2506), Q4_K_M | Heavy | 14.3 GB | a strong dense all-rounder |
| 16 | Gemma 4 31B IT, Q4_K_M | Heavy | 19.6 GB | the largest dense Gemma 4 |
| 17 | Qwen3-Coder 30B-A3B, Q4_K_M | MoE | 18.6 GB | a coding specialist that runs fast |

Each entry's repo, file name and size were confirmed on HuggingFace. Skip stays
`[11]` in `launch.bat`'s menu, so nothing that already knew the numbers moves.

**Tiers.** The Add a Model window now lists models under four headings: LIGHT,
MEDIUM, HEAVY and MIXTURE OF EXPERTS, smallest download first within each.
LIGHT, MEDIUM and HEAVY are the window's existing size words; MoE gets its own
heading because its size is not the whole story. The SIZE row gains a MOE
button.
- The server says which tier each model is in (`tier` in `/catalog.json`).
- A catalogue can set `tier` itself, in `models.ini` or in the live JSON.
- Otherwise it is worked out: a model with an MoE allowance is MoE, and the
  rest go by the GPU memory they need (8 GB or less, up to 16, more).

**Pins, and UNVERIFIED.**
- An entry with a SHA-256 pinned in the catalogue is checked against it. That
  hash was recorded when the catalogue was made, so a file that changes on
  HuggingFace afterwards is refused.
- An entry without a pin still downloads, checked against HuggingFace's own
  record, but the window marks it **Unverified** and the first click only asks:
  "CLICK AGAIN TO DOWNLOAD", with a line saying what is and is not checked.
  The second click has to come within 8 seconds.
- **The server enforces the second click too.** A request without
  `confirmUnverified` for an unpinned entry gets 409 and starts nothing, so a
  script or a mod cannot skip it.
- `launch.bat`'s own downloader (the legacy path) now uses a pin where there is
  one, instead of fetching HuggingFace's pointer.

**Two models are pinned now:** Mistral Nemo 12B and Gemma 4 31B, with hashes
read from their HuggingFace file pages. The other fourteen need
`catalog/pin-hashes.py`, which this workspace could not run because it cannot
reach huggingface.co:

```
python3 catalog/pin-hashes.py --check   # verify the two pins, list the rest; changes nothing
python3 catalog/pin-hashes.py           # pin every unpinned entry, regenerate models.ini
python3 catalog/gen-remote-catalog.py   # rewrite catalog/gobbonet_model_list.json
```

- The tool reads each file's LFS pointer, writes
  `set "DL_SHA256=..."` under its `DL_FILE` in `launch.bat`, and regenerates
  `models.ini` and its `linux-amd64/` copy.
- It refuses a 404 (a wrong repo or file) and reports a pointer whose size is
  far from what the menu advertises (a typo'd quant, usually).
- `--check` also re-verifies every existing pin, including the two above.

**The live list.** GobboNet prefers the list at
`goblincorps.com/gobbonet_model_list.json` over the bundled one. That list has
the old ten models and publishes no hashes. `catalog/gen-remote-catalog.py`
writes the new one from `models.ini`, with all sixteen, their tiers, and
whatever pins exist, as `catalog/gobbonet_model_list.json`. Upload it to replace
the old one. `min_client` stays 1.7.0, since older clients ignore the new
fields.

## Found on this computer (issue #12)

Add a Model now opens with **FOUND ON THIS COMPUTER**: every chat model GobboNet
can find outside its models folder, with where it is and how big it is. **USE
IT** links it into the models folder. It appears in the header dropdown at once,
and SWITCH TO IT NOW loads it.

- **Where it looks.**
  - The HuggingFace cache: `HF_HUB_CACHE`, else `HF_HOME/hub`, else
    `~/.cache/huggingface/hub`. All three are looked in when they differ and
    exist, since tools disagree about which variable they honour.
  - Every folder in `model_dirs` in `config.toml`, a few levels deep, with `~`
    expanded. For example `model_dirs = ["D:/models", "~/.lmstudio/models"]`.
  - `scan_hf_cache = false` leaves the cache out.
- **What it offers.**
  - Chat models only: projectors and embedding models are left out, by the same
    test the dropdown uses.
  - A split model (`-00001-of-00003.gguf`) is one entry, and only when every part
    is there.
  - The same file under two cache revisions is listed once.
  - Hidden folders, `blobs/` and the models folder itself are skipped.
- **Link, never copy.** A symbolic link on Linux and macOS. On Windows, a hard
  link, which needs no administrator rights or Developer Mode, then a symbolic
  link; across drives neither works without Developer Mode, and the error says
  so. A split model has every part linked, or none: a half-done link is rolled
  back. A different file with the same name already in the models folder is
  never overwritten; that row says NAME IN USE.
- **Private.** It reads folders on this machine and nothing else, and only when
  the window opens. Nothing is scanned at start-up and nothing leaves the
  machine.
- **Bounded.** The walk stops after 6 folders deep, 50,000 entries or 4
  seconds, and says so, so a `model_dirs` entry pointing at a whole drive costs
  a few seconds, not a hang.
- **Safe on a LAN.** Both routes are behind sign-in. The page never sends a
  path: it sends back an ID the scan gave it, and the server re-scans and
  resolves that ID itself, so only a `.gguf` the scan would offer from the
  configured folders can be linked.

## Also fixed

- **The model dropdown listed every part of a split model**, and picking part 2
  of 3 could only fail. It now lists the first part only, which is the one
  llama.cpp loads.
- **A broken link in the models folder was offered as a model.** It is now
  skipped.
- **`gen-catalog.py` could not read `DL_SHA256`.** Its field pattern was
  `[A-Z_]+`, which does not match the digits. Pins now reach `models.ini`.

## Code

| Area | Change |
| --- | --- |
| `launch.bat`, `hw-recommend.ps1` | entries 12–17, their VRAM gates and the MoE allowance for 17, menu range 1–17, pin support in the legacy downloader |
| `catalog/models.ini` | regenerated, with 16 models; `linux-amd64/models.ini` is its copy |
| `catalog/pin-hashes.py`, `catalog/gen-remote-catalog.py` | new |
| `catalog/gobbonet_model_list.json` | new: the list to upload |
| `catalog/gen-catalog.py` | field pattern fix |
| `internal/catalog` | `Entry.Tier()`, `Entry.Verified()`, `tier` read from the INI and JSON |
| `internal/server/models.go` | `tier` and `verified` in `/catalog.json`; the 409 unless `confirmUnverified` |
| `internal/localmodels` | new: `Roots`, `Scan`, `Link` |
| `internal/server/localmodels.go` | `GET /local-models.json`, `POST /local-models/link` |
| `internal/models` | `SplitPart`, `SplitName`, `ChatCapable`; `ScanDir` skips later split parts and broken links |
| `internal/config` | `model_dirs` and `scan_hf_cache`, documented in the generated config file |
| `js/02-model.js`, `chat.html`, `css/13-components.css` | tier headings, MOE button, the Unverified line and second click, FOUND ON THIS COMPUTER |

## Tests

**Go**
- `internal/localmodels`, against a fixture laid out exactly as huggingface_hub
  writes it (blobs, snapshot symlinks, two revisions of the same file), plus a
  projector, an embedding model, split models whole and incomplete, a dangling
  link and a hidden folder:
  - the cache order;
  - what is offered and what is left out;
  - states;
  - linking, linking twice, a name clash refused, and a split model linked
    whole or not at all;
  - the entry, time and depth limits.
- `internal/server`:
  - tier and verified in `/catalog.json`;
  - 409 then 200 for an unpinned entry, 200 on the first click for a pinned one;
  - `/local-models.json` from a cache and `model_dirs`, with `scan_hf_cache = false`
    honoured;
  - a link by ID only (a path in the body is refused) that then shows in
    `/models-list.json`;
  - both routes require sign-in.
- `internal/models`: `ScanDir` lists a split model once and skips a broken link;
  `SplitPart`.

**Python**
- `tests/test-pin-hashes.py`, offline against a fixture of pointers:
  - `--check` changes nothing;
  - pinning everything, then nothing left to pin;
  - CRLF kept;
  - `models.ini` and its copy regenerated;
  - a mismatched pin, a 404 and a wrong-size file reported;
  - the committed live list matches `models.ini`.
- The catalogue suites cover the six new entries: buckets, MoE allowance, the
  menu accepting 12–17 and refusing 18, and the PowerShell markers for slot 17.

**JavaScript**
- `tests/test-catalog-tiers.mjs`, new, 33 checks:
  - the two clicks and what each sends;
  - a 409 arming the row, and the arming running out;
  - tier headings and the server's tier winning;
  - FOUND ON THIS COMPUTER rows, states, text-only names, and USE IT sending
    only the ID.
- `test-catalog-filters.mjs` and `test-model-catalog.mjs` now look rows up by
  name, since the list is grouped by tier. Their expected orders follow the
  tiers.

**In the browser, against a real server and the real engine**
- The fake HuggingFace cache's model and a `model_dirs` model were found, linked
  by USE IT (symlinks), appeared in the dropdown, were switched to with SWITCH TO
  IT NOW, and loaded and generated through the links.
- An unverified download took two clicks, and a pinned one took one. The server
  logged that it expected the pinned hash. Both then failed cleanly at
  "contacting Hugging Face", which this workspace cannot reach.

**Console block** `tests/console/1.7.9-step-12.js`
- It passes 15 of 15. It never downloads or links, puts the filters back, and
  checks the server's 409 refusal only while no download is running.
- On 1.7.8 it fails at once.

**Not run here:** a real download from HuggingFace, `pin-hashes.py` against
HuggingFace, and Windows hard links.
