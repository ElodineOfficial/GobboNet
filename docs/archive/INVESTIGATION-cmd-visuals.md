# Investigation — the console went quiet, and what it stopped telling people

Raised as: *"CMD visuals and loading is WILDLY FUCKED UP compared to previous
versions. [I do however like that the icon is shown in the running process] —
Did we obfuscate any data from being plainly viewable to the users by not
showing windows? Are we properly funneling info back to the gobbonet cmd that
was there before?"*

Short answers, both evidenced below.

**A correction first**, because my first pass at this document got this wrong
and the mistake is worth having on the record rather than quietly fixed.

**Did we obfuscate data by not showing windows?** No. **No window ever showed
the engine's output, in any version.** 1.7.3 gave llama-server its own titled
window, but the script running inside it redirected everything to a log file
(`launch.bat:1807`, ending `^> "!LOG_FILE!" 2^>^&1`), so that window was
*empty*. The raw output has always gone to a file, and nothing about that
changed.

**So what was lost?** Not the stream — the *reading* of it. 1.7.3's `launch.bat`
grepped that log and told you what it said: whether the GPU was being used,
whether VRAM was tight, and what to do about either. It also explained the wait
while it happened. The Go path does none of that. The information did not move
somewhere harder to find; it stopped being produced.

**Are we funnelling it back to the gobbonet console?** No. The console prints
GobboNet's own lines and nothing from or about the engine. Between `starting
llama-server` and `model loaded` it prints nothing at all, which on a large
model is up to a minute of a window that looks frozen.

---

## First, the thing it is not

I diffed v1.7.3 against the 1.7.4 zip. The files that decide what the terminal
looks like are **byte-identical**:

```
launch.bat                                 1.7.3=2696  1.7.4=2696   changed=no
fileserver.ps1                             1.7.3=2061  1.7.4=2061   changed=no
cmd/gobbonet/main.go                       1.7.3=889   1.7.4=889    changed=no
installer/gobbonet.nsi                     1.7.3=1108  1.7.4=1108   changed=no
```

`internal/supervisor/supervisor.go` is the only changed file in that area, and
its diff is the stand-down bookkeeping plus comments. **No AI rewrote the
console output in 1.7.4.** Whatever changed, it was not that.

## What changed is which program you end up talking to

1.7.3's `installer/gobbonet.nsi` already pointed its shortcuts at
`gobbonet.exe`. The difference is that **1.7.4 is the release where the
installer was actually built and handed out** — its own changelog opens with
"Roadmap item 13, first of three. `GobboNetSetup-1.7.4-go-nogit.20260917.exe`".
Before that, people ran the ZIP, and the ZIP's front door is `launch.bat`.

So this is the first release where a typical user meets `gobbonet.exe` instead
of `launch.bat`. Nothing was hidden on purpose; a quieter program was promoted
to the front door and nobody compared the two side by side.

**And I have just made that worse.** The 1.7.5 handoff I added sends
`launch.bat` users into `gobbonet.exe` too, so the ZIP path loses the same
output. That is mine, it is in this zip, and it is fixed by the same work below.

### 1.7.3: four windows — but only one of them said anything

```
launch.bat            visible, green-on-black, narrates every step
llama-server          start /min "llama-server"   -- own window, and EMPTY
embed-server          start /min "embed-server"   -- own window, and empty
fileserver.ps1        start /min                  -- own window, startup only
```

The llama-server window is the one to be careful about. It exists, it has a
title, and clicking it showed you nothing, because the little script it runs
ends in a redirect:

```bat
> "!LAUNCH_SCRIPT!" (
    echo @echo off
    echo "!SERVER_EXE!" --model ... -lv !LOG_VERBOSITY! ... ^> "!LOG_FILE!" 2^>^&1
)
start /min "llama-server" "!LAUNCH_SCRIPT!"
```

So the engine's output sat in a log file in 1.7.3 exactly as it does now. What
`launch.bat` did with it is the part that disappeared:

```
 [..] Waiting for server to load model...
      The first launch on a NEW PC can take several minutes while
      your GPU compiles its shaders. Later starts are much faster.
      (If the server process stops, we halt and show the log.)
```

— and then STEP 3b read the log and gave a verdict.

### The Go path: one console, and the engine is not in it

`internal/supervisor/supervisor.go:338-343`:

```go
if f, err := os.OpenFile(s.opts.LogFile, ...); err == nil {
    cmd.Stderr = io.MultiWriter(s.stderr, logFile)
    cmd.Stdout = logFile
} else {
    cmd.Stderr = s.stderr
}
```

`s.stderr` is not the terminal. It is `*ringBuffer` — 64 KB of memory, kept so
that when a launch fails the error can be quoted back (`supervisor.go:101`,
`:164`, `ring.go`). So:

| llama.cpp writes to | where it goes | on screen? |
|---|---|---|
| stdout | the log file | no |
| stderr | the log file **and** a 64 KB memory buffer | no |

Nothing reaches the console. What the user sees instead, from `main.go`:

```
 [..] starting llama-server from C:\...\llama-cpp\llama-server.exe
                                                     <- silence, up to a minute
 [OK] model loaded: gemma-4-e4b-it-Q4_K_M.gguf
```

## What was lost, specifically

Not just prettiness. 1.7.3's `launch.bat` ran a **STEP 3b** after the engine
came up (`:verify_gpu`) and printed one of these:

```
 [OK] GPU acceleration detected
```

or, on failure, a screenful the Go path has no equivalent of: the warning that
the model may be on the CPU "which is VERY slow", four numbered causes, AMD and
NVIDIA driver links, the log file path, a dump of every GPU-related line in the
log, and a **"Continue anyway?"** prompt. Followed by a VRAM check:

```
 [*] VRAM WARNING: Model is tight on your GPU memory.
      If you get 500 errors during chat, try:
        - Reduce CTX_SIZE / use a smaller model or quantization
```

So the score:

| 1.7.3 showed | Go path |
|---|---|
| "waiting… can take several minutes while your GPU compiles its shaders" | **nothing** |
| `[OK] GPU acceleration detected` | **nothing** |
| the CPU-fallback warning, its causes, driver links | **nothing** |
| VRAM pressure warning | **nothing** |
| the log path, on screen, at the moment it mattered | only via `gobbonet doctor` |
| llama.cpp's raw output | log file only — *the same in both* |

The GPU one matters most. "It's very slow" is the **first** troubleshooting
entry in `README.md`, and its answer is "the model may be running on your
processor instead of your graphics card" — which the terminal used to answer
and now cannot.

### The engine is not even asked to say it any more

`BuildArgs` does not pass `-lv`. That is deliberate and documented
(`supervisor.go:226-234`): llama.cpp files the offload lines above its default
threshold, `launch.bat` raises verbosity precisely so its grep can find them,
and the Go path does no such check — so raising verbosity would only evict
error text from the 64 KB ring.

Self-consistent, and it means the offload lines are missing from the log too.
`tests/test-engine-args.py` pins the pair: the Go path either greps for offload
**and** passes `-lv`, or does neither. Restoring one requires the other, which
is the right rule and the test is right to hold it.

## What is genuinely better now, and stays

- **One window, with your icon on it.** `gobbonet.exe` is a real executable, so
  the process carries the app's icon instead of `cmd.exe`'s. Keeping that is the
  constraint the fix works within, not something to undo.
- **No hidden-window antivirus signal.** `launch.bat` documents at length why
  `-WindowStyle Hidden` was removed: a hidden PowerShell binding a LAN port is
  its own AV heuristic, and the hidden state propagated to children so
  llama-server could not write its log.
- **Errors are quoted, not hunted.** The ring buffer means a failed launch
  reports llama.cpp's actual complaint instead of "see the log".

The goal is not to go back to four windows. It is to put the information back
in the one window that now exists.

---

## The plan

Agreed: **stream the engine into the main window**, and **restore the GPU and
VRAM checks plus live progress**.

### 1. Tee the engine's output to the console

This goes **further than 1.7.3 ever did**, deliberately, because you asked for
the stream rather than a summary. 1.7.3 only showed a verdict derived from the
log; this puts the lines themselves on screen as they arrive, and keeps the
verdict too.

`Options` gains a console writer. When set, both streams are tee'd to it as
they arrive, alongside the log file and the error ring — nothing currently
written stops being written.

Lines are prefixed so the two programs are distinguishable in one window:

```
 [..] starting llama-server from C:\...\llama-server.exe
 [llama] llama_model_loader: loaded meta data with 30 key-value pairs
 [llama] load_tensors: offloading 34 repeating layers to GPU
 [llama] load_tensors: offloaded 35/35 layers to GPU
 [llama]   Vulkan0 model buffer size =  3820.11 MiB
 [OK] model loaded: gemma-4-e4b-it-Q4_K_M.gguf
```

Prefixed rather than raw because "funnelling it back to the gobbonet cmd" only
helps if the reader can tell which program is talking. A partial line is held
until its newline, so the prefix cannot land mid-sentence.

### 2. Restore `-lv`, and the check it exists for

Both together, because the test requires it and because either alone is
useless. The ring-buffer objection is answered by the tee: the error text is on
screen as it happens, so the ring is no longer the only copy.

### 3. Report GPU offload and VRAM pressure

A scanner on the same stream watches for llama.cpp's offload wording
(`offloaded`, `offloading`, `Vulkan0`, `CUDA0`, `Metal0`, `ROCm0`, `SYCL0` —
several, because it is internal wording that has moved before) and for
`cannot meet free memory` / `failed to fit`. After the load:

```
 [OK] GPU acceleration detected
```

or the CPU-fallback warning with the causes, the driver links and the log path,
carried over from `launch.bat` — minus the "Continue anyway?" prompt, because
`gobbonet.exe` is often started from a shortcut with nobody watching, and a
server that stops for an unanswered question is worse than a slow one. It warns
and carries on.

### 4. Say where the log is, on screen

One line in the banner. Currently only `gobbonet doctor` knows it.

### 5. A switch, defaulted to visible

`show_engine_output`, default **true**. Off for anyone running it as a service
or who finds a 70B load's chatter too much. Default on because the complaint
being fixed is that it was silently off for everyone.

### 6. Fix the handoff I added

`launch.bat` handing over to `gobbonet.exe` is right — one server, one feature
set — but it must not be a downgrade in what you can see. With 1–4 done it
isn't, and the handoff message should say the output continues in this window
rather than implying the old narration is gone.

### What I am deliberately not doing

- **Not restoring the extra windows.** You liked the single process with the
  icon; four taskbar buttons is the thing that was replaced, not the thing that
  was lost. The output is what was lost.
- **Not re-narrating `launch.bat`'s STEP 1/2/3.** Those steps describe work the
  Go server does in a different order, and some of it (engine download, model
  menu) belongs to the installer and the setup wizard now. Narrating it would be
  theatre.
- **Not parsing the engine's output into a tidy summary instead of showing it.**
  You asked whether data was being hidden; answering that with a filtered view
  would be the same mistake in a nicer jumper. Raw, prefixed, plus a summary
  line at the end.
