# 1.7.5 — The console can see the engine again

Raised as: *"CMD visuals and loading is WILDLY FUCKED UP compared to previous
versions. [I do however like that the icon is shown in the running process] —
Did we obfuscate any data from being plainly viewable to the users by not
showing windows? Are we properly funneling info back to the gobbonet cmd that
was there before?"*

Full trace in `docs/INVESTIGATION-cmd-visuals.md`. The headline, including a
correction to my own first answer:

## Nothing was hidden by hiding a window

**No window ever showed the engine's output, in any version.** 1.7.3 gave
llama-server its own titled window, but the script inside it ended in
`^> "!LOG_FILE!" 2^>^&1` (`launch.bat:1807`), so that window was empty. The raw
output has always gone to a file.

My first pass at the investigation said otherwise. It was wrong, and the
correction matters: the fix is not "unhide a window", it is "start reading the
file again, out loud".

## And no AI rewrote the console

The files that decide what the terminal looks like are byte-identical between
v1.7.3 and the 1.7.4 zip:

```
launch.bat                                 1.7.3=2696  1.7.4=2696   changed=no
fileserver.ps1                             1.7.3=2061  1.7.4=2061   changed=no
cmd/gobbonet/main.go                       1.7.3=889   1.7.4=889    changed=no
installer/gobbonet.nsi                     1.7.3=1108  1.7.4=1108   changed=no
```

What changed is **which program a user ends up talking to**. 1.7.3's `.nsi`
already pointed its shortcuts at `gobbonet.exe`; 1.7.4 is simply the release
where the installer was built and handed out, so it is the first release where a
typical user meets `gobbonet.exe` instead of `launch.bat`. A quieter program was
promoted to the front door and nobody put the two side by side.

I made it worse before noticing: the `launch.bat` → `gobbonet.exe` handoff added
earlier in this same release took the ZIP path down the quiet road too.

## What was actually lost

`launch.bat` read that log file and told you what it said. `gobbonet.exe` never
did. Concretely absent from the Go path:

| 1.7.3 printed | Go path |
|---|---|
| "can take several minutes while your GPU compiles its shaders" | nothing |
| `[OK] GPU acceleration detected` | nothing |
| the CPU-fallback warning, its four causes, driver links | nothing |
| the VRAM-pressure warning | nothing |
| the log path, at the moment it mattered | only `gobbonet doctor` |

The GPU line is the one that hurts. *"It's very slow"* is the **first**
troubleshooting entry in `README.md` and its answer is "the model may be running
on your processor instead of your graphics card" — a question the terminal used
to answer and then could not.

It was worse than unread. `BuildArgs` did not pass `-lv`, so llama.cpp never
emitted the offload lines at all: they were missing from the log too. That was
deliberate and self-consistent (the 64 KB stderr ring would lose error text to a
noisier banner) and it was the wrong trade.

## What changed

**The engine streams into the main window, prefixed.** Four destinations now,
each answering a different question — the error ring for "why did this fail",
the log for the full history, a scanner for "did it reach the GPU", and the
console for what the user is watching. Nothing that was already written stopped
being written; this adds a reader.

```
 [..] starting llama-server from ...\llama-cpp\llama-server.exe
      The first launch on a NEW PC can take several minutes while your
      GPU compiles its shaders. Later starts are much faster.
      The engine's own output follows, marked [llama].
 [llama] load_tensors: offloading 34 repeating layers to GPU
 [llama] load_tensors: offloaded 35/35 layers to GPU
 [llama] load_tensors:      Vulkan0 model buffer size =  3820.11 MiB
 [OK] model loaded: gemma-4-e4b-it-Q4_K_M.gguf
 [OK] GPU acceleration confirmed -- layers reached the graphics card.
```

This is **more** than 1.7.3 ever showed, on purpose: you asked for the stream
rather than a summary, so both are there.

Whole lines only, with the prefix on each. llama.cpp writes progress in
fragments, and a prefix stamped per `Write()` would land mid-sentence — output
nobody trusts is worse than none. A trailing fragment is flushed when the
process exits, because the last thing a dying engine prints is usually the
reason and it rarely ends in a newline.

**`-lv 4` is back**, matching `LOG_VERBOSITY=4` in `launch.bat` exactly, so this
is not noisier than the behaviour it restores. `-lv` and the offload check are
one decision: either alone is useless, and passing neither is what made every
GPU invisible.

**GPU and VRAM are reported again**, ported from STEP 3b with two deliberate
differences. It reads the stream as it goes past rather than grepping a file
that is still being written; and it does **not** stop to ask "Continue anyway?",
because `gobbonet.exe` is usually started from a shortcut with nobody watching
and a server that waits forever for an unanswered question is worse than a slow
one. It warns and carries on.

**The engine log path is in the banner**, not only in `gobbonet doctor`. The
moment someone needs it is the moment they are least likely to go hunting for a
subcommand.

**`show_engine_output`**, default **true**. Off for a service or a scheduled
task, or anyone who finds a 70B load's chatter too much. The log file and the
GPU verdict are produced either way — verified.

**The handoff message says the output continues here**, so `launch.bat` users
are not left thinking the narration went away with the old server.

## One real bug, found by running it

The first live drill printed `could not confirm GPU acceleration` on a machine
whose engine was about to confirm it. `Boot()` returns when `/health` answers
200, and llama.cpp prints the offload lines before it starts listening — so in
wall-clock terms the lines come first, but they travel through a pipe scanned by
another goroutine. "The engine printed it" and "we read it" are different
instants, and reading the verdict the moment `Boot()` returned lost that race.

The failure mode is the worst available: a confident CPU warning on a working
GPU. `AwaitGPUVerdict` now waits up to 3s, returning the instant the marker
arrives — so a healthy GPU pays nothing and the full wait only falls on a
machine that is about to read a long warning anyway.

## What was kept, deliberately

- **One window with the app's icon.** That was the part you liked, and it is the
  constraint this works inside, not something to undo. No new windows.
- **No hidden-window trick.** `launch.bat` documents why `-WindowStyle Hidden`
  was removed — a hidden PowerShell binding a LAN port is its own AV heuristic,
  and the hidden state propagated to children so llama-server could not write
  its log. Nothing here reintroduces it.
- **No filtered-summary-instead-of-output.** You asked whether data was being
  hidden; answering that with a curated view would be the same mistake in a
  nicer jumper. Raw lines, plus a verdict.
- **`launch.bat`'s STEP 1/2/3 narration is not re-enacted.** Those steps
  describe work the Go server does in a different order, and the engine download
  and model menu belong to the installer and the setup wizard now. Narrating
  them would be theatre.

## What pins it

`internal/supervisor/engineout_test.go` — 11 tests: whole lines, partial lines
held then flushed, a flush that does not repeat, never reporting a short write
(`io.Copy` treats one as an error), blank-line collapsing, every offload wording
llama.cpp has actually used, a marker split across two writes, VRAM pressure,
not inventing a GPU from output that mentions none, `Reset` clearing a previous
model's verdict, and `SawOutput` distinguishing "not confirmed" from "never
heard from it".

`tests/test-engine-args.py` — the `-lv` invariant held, and widened: it read one
file, and the offload markers now live in a sibling, so it reported "does not
grep" while the package plainly did. It scans the package now.

**Verified live**, against a stand-in that prints what llama.cpp prints in the
order it prints it — full banner, then listen:

| drill | result |
|---|---|
| GPU machine | 18 `[llama]` lines stream, then `GPU acceleration confirmed` |
| `gpu_layers = 0` | the full CPU-fallback warning with causes and log path |
| VRAM tight | `VRAM WARNING` plus the current `ctx_size` |
| `show_engine_output = false` | 0 `[llama]` lines, verdict still printed, log still 18 lines |

## Not verified here

No Windows machine, so the console was exercised on Linux. The code paths are
identical — one `io.Writer` and one `os.Stdout` — and nothing in it is
platform-specific, but the thing being fixed is what a Windows console looks
like, and that wants one look on Windows before release.
