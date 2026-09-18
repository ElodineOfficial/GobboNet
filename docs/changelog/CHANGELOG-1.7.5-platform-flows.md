# 1.7.5 — Windows gets its CMD window back

Raised as: *"LINUX = HANDLES LAUNCH OPTIONS VIA HTML. WINDOWS = CMD WINDOW.
This isn't hard. You're being asked to recreate what was already there. I did
not say 'make them the same across the board' I said 'recreate faithfully with
the new items implemented'."*

Fair, and I had it wrong twice over.

## What I did wrong

The two platforms onboard differently on purpose:

| | how launch options are answered |
|---|---|
| **Linux** | in a browser — `gobbonet-setup.py` serves `wizard.html` |
| **Windows** | in the CMD window — `launch.bat` asks on screen |

The handoff I added earlier in this release sat at the **top** of `launch.bat`,
above everything, and ran `gobbonet setup` when a machine was not configured.
`gobbonet setup` serves the HTML wizard. So Windows was handed the Linux
experience, and every question that used to be answered in the green window —
the password, the engine download, the hardware probe, the model menu, the
integrity check — stopped being asked there at all.

Then, asked why the console looked wrong, I "fixed" the console by streaming
engine output into the Go banner. Useful work, wrong problem: the banner was
never supposed to be what a Windows user met.

## What it does now

`launch.bat` is **byte-identical to v1.7.3** from the top of the file down to
STEP 3. Verified, not asserted:

```
$ diff v1.7.3/launch.bat launch.bat   # before the two seams were added
(no output)
```

Preflight, the keep-open guard, the password, STEP 1's engine download with its
pinned checksum, STEP 2's model check, the hardware-aware menu, the download and
its integrity check — all of it, exactly where it was, asking exactly what it
asked.

Two seams were then added, both **after** the questions:

**1. `launch.bat` stops starting llama-server itself** when `gobbonet.exe` is
present, and jumps to the embedding-server step. It has to: idle stand-down
unloads the backend process, which means the server has to own it. The old start
is still there, immediately below, as `:start_server_legacy`.

**2. At STEP 5 it hands the server role over**, in that same window:

```bat
"!GN!" config set server_exe    "!SERVER_EXE!"
"!GN!" config set model_dir     "!MODEL_DIR!"
"!GN!" config set ctx_size      "!CTX_SIZE!"
...
"!GN!" --open --model "!GGUF_BASENAME!"
```

Run directly, not `start /min`, so the loading output, the GPU check and any
error land in front of the person who has been reading that screen.

`fileserver.ps1` is still started on the legacy path, which is reached when
there is no `gobbonet.exe` or when `GOBBONET_LEGACY_SERVER=1` is set.

## Two details that would have made it hollow

**The model menu has to actually decide something.** `Boot("")` scans
`model_dir` and takes `records[0]`, so handing over without naming a file would
boot whatever sorts first and make STEP 2 decorative. `serve` gained `--model`.
Demonstrated with two files in one folder:

```
without --model:  [OK] model loaded: aaa-first.gguf
with --model:     [OK] model loaded: zzz-the-one-i-picked.gguf
```

**The password must not be asked twice.** `launch.bat` writes a salted
SHA-256 pair to `.gobbonet-secret`, and that is exactly the legacy `salt:hash`
form `internal/auth` accepts (`secret.go:19`, `legacyRe`) and upgrades to
Argon2id on the first successful login. So the handover copies it into
`access_secret` and the user is never asked again.

## Linux is untouched

The only change to `installer-linux/gobbonet-launch` in this release is the
`web_root` migration. `gobbonet-setup.py` and `wizard.html` are as they were —
launch options are still answered in the browser there, which is the point.

## What pins it

`tests/test-launch-cmd-flow.py` replaces `test-launch-handoff.py`, and asserts
the **shape of the flow** rather than just the existence of a handover: all nine
STEP markers present, engine → model → server → web still in that order, the
engine downloader and the yes/no prompts still in the window, the handover
positioned *after* STEP 1 and STEP 2, every collected answer passed through,
`--model` present, the password reused rather than re-asked, `gobbonet` started
in-window rather than minimised, and both legacy labels defined after the jumps
that reach them.

One assertion earns its place specifically: **`gobbonet setup` must not appear
in `launch.bat` at all.** That single call is what handed Windows the Linux
wizard, and a test that forbids it by name is the one that would have caught
this on the day.

## Not verified here

No Windows machine. The batch is checked structurally and by eye; the Go side of
the handover (`--model`, the config keys, the in-window output) was exercised
live on Linux. One real run of `launch.bat` on Windows is still wanted before
release — that is the platform this change is entirely about.
