# v1.7 — GPU detection against newer llama.cpp builds

*Closes #33. The DRY half was already fixed in 1.7; this is the `-lv` half.*

---

## Symptom

Swap in llama.cpp b9829 or newer and every launch stops to say:

```text
[*] WARNING: Could not confirm GPU acceleration.
    The model may be running on CPU, which is VERY slow.
    ...
Continue anyway? [Y/N]
```

on a machine where the GPU is working perfectly well. Answering `Y` gets past
it, but a launcher that halts for a prompt on every start is not one you can
leave to come up on its own.

---

## Cause

`STEP 3b` decides whether llama.cpp used the GPU by grepping its log for
`offloaded`, `Vulkan0`, `CUDA0` or `Metal0`. Those strings stopped appearing.

Not because they were removed — because of where they are filed. In
`common/log.cpp`:

```cpp
static int common_get_verbosity(enum ggml_log_level level) {
    switch (level) {
        case GGML_LOG_LEVEL_DEBUG: return LOG_LEVEL_DEBUG;   // 5
        case GGML_LOG_LEVEL_INFO:  return LOG_LEVEL_TRACE;   // 4
        ...
```

and the default threshold is `LOG_DEFAULT_LLAMA = LOG_LEVEL_INFO`, which is 3.
So anything the *engine* logs at INFO is mapped to 4 and dropped, while lines
emitted through *common's* own `LOG_INF` sit at 3 and survive.

That split is why this worked at all until now: the offload summary comes from
`llama-model.cpp` via `LLAMA_LOG_INFO` and was already being filtered, while
the `Vulkan0 : ...` device line came through common and still printed. Upstream
has been steadily moving lines across that boundary, and by b9829 the ones this
script greps for are all on the quiet side.

`-lv 4` raises the threshold to trace and they come back.

**Nothing shipped was broken.** Windows pins `b9294` in `launch.bat`, which is
older than b9829. The reporter hit this by testing newer builds by hand. This
is a landmine rather than an outage — one that arms itself the moment the
engine pin is bumped.

---

## Fix

**`LOG_VERBOSITY`, alongside the other engine knobs**, passed to the chat
server as `-lv`:

```bat
set "LOG_VERBOSITY=4"
```

4 is trace, not debug. DEBUG is level 5 and stays filtered, so this asks for
exactly the messages that used to arrive by default rather than opening the
floodgates — the log returns to its previous volume, it does not grow past it.

Verified against both pinned engines that `-lv` is accepted, by reading
`common/arg.cpp` at each tag:

| Build | Pinned by | `-lv` accepted |
|---|---|---|
| b9294 | `launch.bat` (Windows) | yes |
| b10456 | `build-deb.sh` (Linux) | yes |

So the flag does not narrow which engine can be dropped in.

**Only the chat server gets it.** The embedding server's log is never read, so
raising its verbosity would be noise. The Go supervisor does not get it either
and deliberately so: it keeps a bounded ring of llama-server's stderr, and
since #43 the landing page shows the error extracted from that ring. Filling
the ring with trace output would push the line worth reading out of it.

**The check now accepts more spellings** — `offloading` as well as `offloaded`,
plus `ROCm0` and `SYCL0` for a hand-swapped engine. Any one hit is enough.

**The warning names the real cause first.** If detection does fail, the first
listed possibility is now a newer llama.cpp filing the lines above the log
threshold, pointing at `LOG_VERBOSITY` — rather than sending someone to
reinstall a GPU driver that was never the problem.

---

## Where the report and the code disagree

#33 also says that after the warning, *"if llama.cpp dies it's not able to
recover anymore thanks to that lack of GPU acceleration detection"* — hedged
with "from what I can tell".

The monitor loop does not consult GPU detection. It polls `:llm_state`, and on
a miss it kills the port's process and restarts from `!LAUNCH_SCRIPT!`, with no
reference to `GPU_CONFIRMED` and no prompt. `:verify_gpu` is reachable only
from startup.

There is a real effect, though not that one: the prompt runs *before* the
monitor loop is ever entered. An unattended launch that stops there never gets
as far as monitoring, so nothing is watching to recover. Removing the false
warning removes that too.

This is recorded rather than silently fixed because the reporter's mechanism
could not be reproduced in the code, and quietly "fixing" something unfound is
worse than saying so.

---

## Already fixed: the DRY half

The other half of #33 — `dry_penalty_last_n: -1` rejected by b10273+ with
`Value must be between 0 <= value <= 2147483647, but got -1` — is resolved in
1.7. `resolveDryPenaltyLastN()` in `js/06-state-sync.js` sends the resolved
context size instead of the old sentinel, clamped so the DRY ring buffer stays
proportionate. Nothing to do.

The report suggests exposing the field on the character card next to Repeat
Window. Not done: the resolver already tracks the card's context limit, so a
manual box would mostly be a way to set it wrong, and the sane value is not a
matter of taste. Easy to add if it is wanted for parity — say so and it goes in.

---

## Version map

| Build | Upstream change | Windows (b9294) | Linux (b10456) |
|---|---|---|---|
| b9829 | offload lines above default log level | unaffected | **affected** |
| b10273 | `penalty_last_n = -1` rejected | unaffected | **affected** |

Linux is past both, which is why the DRY failure surfaced there first. Windows
is past neither today, which is why the GPU warning has only been seen by
people swapping engines by hand. Both are now handled on either side of the
line.

---

## Files changed

| File | Change |
|---|---|
| `launch.bat` | `LOG_VERBOSITY` knob; `-lv` on the chat server; wider offload patterns; warning text |
| `test-launch-gpu-detect.py` | New — pins the arrangement |

---

## Verification

`test-launch-gpu-detect.py` asserts the parts that would silently rot: the knob
exists, is at least 4, is defined before use, reaches the chat server, does
*not* reach the embedding server, and the check accepts several spellings.
Confirmed to fail on both realistic regressions — dropping the level to 3, and
removing the flag — and to pass once restored.

Also: batch linter clean on all four scripts, CRLF intact, `models.ini` still
byte-identical after touching `launch.bat`, the #23 ladder still has zero
overcommitted rungs, `go build`/`vet`/all 11 Go packages green, all 9 `.mjs`
suites pass.

What still needs a Windows box with a GPU: seeing the offload lines reappear
under a b9829+ engine. The filtering mechanism was read from llama.cpp's source
at both pinned tags, and the reporter confirmed `-lv 4` works, but no engine ran
here.
