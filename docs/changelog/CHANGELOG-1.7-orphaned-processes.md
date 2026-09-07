# v1.7 — Orphaned llama-server processes

*Addresses PR #15 ("Fix orphaned Windows background processes"). The PR targets
the PowerShell launcher, which 1.7 replaced; what carried over is the problem it
identified, solved with a different mechanism.*

---

## What the PR proposed, and why this does not do that

PR #15 adds `runtime-watchdog.ps1`: a separate PowerShell process that polls for
a dead parent PID, reads an ownership state file, and stops the services that one
launch marked as its own.

That design was right for the launcher it was written against, where nothing
owned the child processes directly. It does not fit the Go server, and porting it
would have been a step backwards:

- **A watchdog is itself a process that can be killed.** It closes the gap for a
  parent that dies but not for a machine where both die — the Task Manager
  "End task on the whole tree" case.
- **It can only act after the fact.** It notices an orphan on its next poll,
  after the port and VRAM have already been held.
- **It needs ownership bookkeeping** — a state file, a marker file for
  hot-swap promotion, port-and-command-line matching to identify processes — all
  of which exists to reconstruct a parent/child relationship the Go supervisor
  already has directly.

The Go supervisor already does better for every case where it gets to run: the
child goes into its own process group at launch, and Ctrl+C, SIGTERM, a swap and
an unexpected child exit all sweep the whole group. That covers llama.cpp's
helpers, including ones reparented to init after their leader died.

## The gap that was real

**All of that only works if gobbonet gets to run Go code.**

It does not always get to. `taskkill /F`, Task Manager's "End task", a panic, an
out-of-memory kill, or closing the console window a shortcut opened all end the
process with no notice and no handler. llama-server then survives its parent,
holding several gigabytes of VRAM and the upstream port. The next launch fails to
bind, exits in milliseconds, and `/swap-status` sits at `starting` — which reads
as a slow model rather than a leaked process.

That is the report. On Windows it is also the *routine* case, because closing a
console window is a normal way to stop a program rather than a deliberate kill.

## The fix: a job object, not a watchdog

Windows already has the right primitive. The child is assigned to a job object
carrying `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which terminates every process in
the job when the last handle to it closes. The kernel closes this process's
handles when it dies, **whatever killed it** — so the guarantee holds for exactly
the cases Go-side cleanup cannot reach.

No polling. No second process to keep alive. No ownership file. Job membership is
inherited, so llama-server's own helpers join the job when it spawns them.

`internal/supervisor/killjob_windows.go`. Failure to create or assign the job is
logged, not fatal: it is a backstop for abnormal exits, and losing it is no
reason to refuse to run a model. Every explicit cleanup path is unaffected.

### One honest limitation

The child is assigned *after* it starts, so a helper spawned in that window would
escape the job. Closing this properly needs `CREATE_SUSPENDED` and a thread
handle `os/exec` does not expose. The window is opened against a process that
spends its first seconds reading a multi-gigabyte model off disk before it spawns
anything, which makes it sub-millisecond against a wait of seconds.

## Unix gets nothing, deliberately

There is no equivalent, and the near-equivalents are worse than the gap.

Linux has `prctl(PR_SET_PDEATHSIG)`, exposed as `SysProcAttr.Pdeathsig`. It fires
on the death of the creating **thread**, not the process, and Go gives no
guarantee that the runtime thread which happened to fork the child outlives it. A
retired thread would deliver `SIGKILL` to a healthy llama-server in the middle of
a generation. Trading a rare leak after an abnormal exit for a random kill during
normal operation is a bad trade, so it was not taken. macOS and the BSDs have
nothing in this shape at all.

What remains on Unix is the process-group handling, which covers every path where
gobbonet runs its own cleanup. Only a `SIGKILL` of gobbonet itself leaks, and on
Unix that is a deliberate act rather than a routine gesture.

`killjob_unix.go` is a documented no-op rather than a silent absence, so the next
reader finds the reasoning instead of the gap.

## A second, smaller gap closed

`serve` ended with `return srv.Serve(listener)` and no cleanup on that path. Ctrl+C
was handled by a signal handler, but **a listener error was not**: gobbonet would
exit and leave llama-server running with the GPU and port held. A `defer
srv.Shutdown()` now covers it. The signal handler keeps its own call, since
`os.Exit` skips defers.

## Tests

`internal/supervisor/process_unix_test.go` — the package had **no test files at
all** before this, so the group handling that prevents orphans was entirely
unverified.

- `TestKillingOnlyTheLeaderLeavesHelpers` demonstrates the leak rather than
  assuming it: kill only the leader and the helper is still running. If this ever
  stops holding, the group handling is redundant and the reasoning in
  `process_unix.go` is wrong.
- `TestTerminateGroupKillsHelpers` is the fix — one signal reaches the whole tree.
- `TestGroupIDSurvivesReaping` pins why `pgid` is stored separately from `cmd`:
  once the reaper has `Wait()`ed the leader, `Getpgid` fails with `ESRCH` while
  the helpers are still running, so deriving the group late is exactly the case
  where it cannot be derived.
- `TestTerminateGroupIgnoresZero` guards the uninitialised case, where negating a
  zero pgid would signal gobbonet's *own* group — killing itself and everything
  sharing its terminal.

The job object itself needs Windows to exercise and is not covered by a test that
runs here. It is type-checked on every build via `GOOS=windows`.
