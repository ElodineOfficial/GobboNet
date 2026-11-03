# 1.7.9 — Closing the setup window ends everything it started

*Patch step 6 of 1.7.9. Finishes PR #15 (DawidKorach), "Fix orphaned Windows
background processes". 1.7 already ended llama-server whatever killed gobbonet,
through a job object (`CHANGELOG-1.7-orphaned-processes.md`). This step covers
the processes that job never held.*

## What was happening

Two processes outlived the window that started them:

- **The embedding server.** `launch.bat` starts it with `start /min`, then runs
  `gobbonet.exe` in the foreground. Nothing owned it. Closing the console window
  ended `gobbonet.exe`, and its llama-server through the 1.7 job, but the
  embedding server kept running, holding port 11436 and its memory until a
  reboot or `stop-gobbonet.bat`.
- **Anything else `launch.bat` started before handing over.**

This happened on both doors into `launch.bat`: a first run through
`gobbonet.exe launch`, and the "Setup or add a model" shortcut, which ran
`launch.bat` directly.

## The change

**`launch.bat` runs inside a kill-on-close job.** The new package
`internal/procjob` creates a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
puts `cmd.exe` in it as soon as it starts. Membership is inherited, so the
embedding server, `gobbonet.exe` and their helpers all join. When the launcher
process ends, however it ends (the window's X, End task, a crash), the kernel
closes the job and ends the whole tree. There is no watchdog and no ownership
file, the same reasoning as 1.7.

This is safe because `launch.bat` does not hand off and exit. It runs
`gobbonet.exe` in the foreground until GobboNet stops, so the job lives exactly
as long as GobboNet does.

**The browser is kept out.** `--open` starts the browser from inside the tree.
A browser that was not already running would have joined the job and been
closed along with GobboNet. The job therefore allows breakaway, and
`setup.OpenBrowser` starts the opener with `CREATE_BREAKAWAY_FROM_JOB` through
`procjob.StartDetached`. If GobboNet is itself inside someone else's job that
refuses breakaway, it starts the opener normally, which is the 1.7.8 behaviour.

**"Setup or add a model" goes through `gobbonet.exe`.** The new
`gobbonet launch --setup` runs `launch.bat` the same way, even on a configured
install. The shortcut now targets `gobbonet.exe launch --setup`, in both
`installer-win/gobbonet.nsi` and `repair-windows-shortcuts.ps1`. Off Windows,
`--setup` says to use `gobbonet setup`.

A job that cannot be created is reported in one line and setup carries on. It
is a backstop, never a gate.

**One honest limitation, the same as 1.7.** `cmd.exe` is put in the job just
after it starts, because `os/exec` does not expose the thread handle
`CREATE_SUSPENDED` would need. `cmd.exe` spends that moment reading
`launch.bat`, long before it starts anything.

## Updating from the ZIP

Run **Repair Windows shortcuts.bat** once, so "Setup or add a model" points at
the new command. The installer rewrites the shortcut by itself.

## Tests

- `internal/procjob/procjob_test.go`: the portable contract. Both calls are safe
  everywhere, and `StartDetached` starts the process.
- `internal/procjob/procjob_windows_test.go` (Windows only): a grandchild
  (`ping.exe`, started by `cmd.exe`) joins the job, and ending the job ends the
  tree. It compiles here with `GOOS=windows go test -c`, but was **not run**.
- `cmd/gobbonet/launch_test.go`:
  - `TestSetupBatchCommand`: a fixed relative `launch.bat`, with the legacy
    switch stripped in any letter case;
  - `TestLaunchSetupFlag`: `--setup` off Windows, and the usage text.
- `tests/test-windows-installer.py`, `tests/test-windows-launch.py`: the
  Setup shortcut targets `gobbonet.exe launch --setup` in the NSIS script and
  the repair script.

**Not run:** any of this in Windows. To check it by hand:

1. Run Repair Windows shortcuts.bat.
2. Open "Setup or add a model" and pick a model.
3. When the chat opens, close the console window with its X.
4. Task Manager should show no `llama-server.exe` and no `gobbonet.exe`, and
   the browser should still be open.
