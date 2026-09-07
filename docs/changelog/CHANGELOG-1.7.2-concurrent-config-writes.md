# v1.7.2 — a double-click could break finishing setup

Pre-existing. Reproduced on the untouched v1.7 tree before anything was changed
here.

---

## Symptom

```
--- FAIL: TestFinishSurvivesConcurrentCalls (0.04s)
    setup_test.go:144: concurrent finish 0: got 500, want 200
    setup_test.go:144: concurrent finish 1: got 500, want 200
    setup_test.go:144: concurrent finish 7: got 500, want 200
```

Three of eight simultaneous calls to the setup wizard's final button fail. The
others succeed, which is what makes it read as random.

---

## Cause

`handleFinish` guarded the question but not the work:

```go
s.mu.Lock()
if s.finishedBody != nil { ...return }   // "already done?" — under the lock
s.mu.Unlock()
// ← config.Set and os.WriteFile happen HERE, unguarded
s.mu.Lock()
s.finishedBody = body                     // set only at the very end
s.mu.Unlock()
```

All eight callers reach the check before any of them reaches the assignment, so
all eight see `nil`, and all eight go on to do the work. `config.Set` then writes
through a **fixed** temporary name:

```go
tmp := path + ".tmp"
os.WriteFile(tmp, []byte(body), 0o600)
return os.Rename(tmp, path)
```

Two callers write the same `config.toml.tmp`; the first renames it into place;
the second's rename finds nothing there. Captured verbatim:

```
{"error":"rename /tmp/.../config.toml.tmp /tmp/.../config.toml: no such file or directory"}
```

Beyond the 500, the `listen_host` that survives is whichever caller lost — so a
user who chose LAN access could end up bound to `127.0.0.1`.

The author was already thinking about repeat calls: the comment above the
handler names the double-click, the browser retry and the refresh-and-resubmit,
and the *response* is correctly idempotent. The gap is that the work in between
was not.

---

## Why it took a user to find it

The failure needs the eight callers to genuinely overlap. On a machine with one
usable CPU they do not, and the test passes with the bug fully present.

Measured, on a box reporting `nproc = 1`:

| `GOMAXPROCS` | failures in 60 runs |
|---|---|
| 1 | **0** |
| 4 | 1 |
| 16 | 3 |

Every "tests pass" reported while this branch was being worked on came from the
top row. The results were real; they were also blind to this entire class of
bug, and that was not stated at the time.

---

## Fix, part one: unique temp files

The collision is in `config.Set`, not in the handler, so that is where it is
fixed. `internal/atomicfile` replaces the three hand-rolled copies of
write-then-rename — in `config`, `state` and `catalog`, all three carrying the
same shared-temp-name flaw — with one implementation that gives every writer its
own file via `os.CreateTemp`, in the destination's own directory so the rename
stays atomic.

**This alone fixes the reported failure.** Verified by reverting the handler
lock while keeping `atomicfile`: the concurrency test passes.

Its own test reproduces the original collision on attempt 0, every run, in a
tenth of a second — against 200 HTTP round-trips and a coin-flip. Testing a bug
where it lives beats testing it through three layers.

## Fix, part two: the handler

The once-only work moves into `completeSetup`, with `s.mu` held across all of it
rather than around the check alone. `handleFinish` keeps the response write, so
the lock is not held across a write to a client.

Decoding stays *inside* the locked section on purpose. That preserves the
original ordering: a repeat call carrying a malformed body still receives the
cached success rather than a 400, because by the time it arrives the question
"did setup finish?" has already been answered.

Holding a mutex across file I/O usually deserves a second look. Here it is the
right trade — a loopback, single-user, one-shot wizard doing a few small writes,
against a race that can lose a setting the user chose.

Redundant with `atomicfile` for the reported 500, and both were verified to fix
it independently. Not redundant in general: without it, eight clicks still do
the work eight times over — eight config writes, eight marker writes, eight
attempts to register a login entry — and the last one to finish decides what
`listen_host` says.

## The other two handlers

`handlePassword` and `handleBackend` had the same exposure and no test.

`handlePassword` is a real fix. It assigned `s.cfg.AccessSecret` and
`s.passwordSet` from several goroutines with no synchronisation, so config.toml
could end up holding one hash while the process held another — the password
accepted now not being the one that works at next launch. Hashing stays outside
the lock, since `auth.NewSecret` is deliberately slow and there is nothing to
protect until there is a hash.

`handleBackend` is defence in depth, and the changelog should say so rather than
claim a scalp. Once `config.Set` stopped colliding, no black-box assertion here
separates the guarded handler from the unguarded one — both pass. The lock still
earns its place: a mode is several settings that only make sense together, and
`backendMode` should not be able to disagree with what was written.

---

## The test now fails on one core

The test found this and then could not prove it, which made it worse than
useless: it reported what the hardware allowed rather than whether the code was
correct. Three changes:

- **It asks for `GOMAXPROCS(8)` itself**, restored on exit. Costs nothing, and
  is the difference between catching the bug and reporting the machine.
- **A start barrier.** Goroutines launched in a loop drift apart by the time it
  takes to spawn the next one, which is enough for the first to finish alone.
- **Repeats**, because one attempt catches it roughly one time in twenty. The
  count settled at 25 rather than 200: deep detection moved to
  `internal/atomicfile`, whose test reproduces the collision on attempt 0 every
  run, so the handler test only has to cover the handler's own contract.

Against the unfixed handler it now fails on every run at `GOMAXPROCS=1` — the
setting it used to pass under — catching it at attempts 3, 74 and 19 across
three runs. Against the fix: eight consecutive clean runs at `GOMAXPROCS` of
both 1 and 16.

It also prints the failing response body, so the next reader sees the rename
error rather than an unexplained 500.

`internal/setup` runs in ~20s, most of it the password test's KDF. `-short`
trims every attempt count, with comments saying plainly that `-short` exercises
these paths and does not test for the races.

---

## What the tests are actually for

Worth writing down, because the first version of these was expensive and
dishonest.

A 120-attempt black-box test against the broken `handlePassword` caught it once
and missed it once, at nearly three minutes a run. A detector that slow and that
unreliable is worse than none, because a pass reads as proof.

`-race` finds the same bug in three attempts, every time, and names the two
lines. So the concurrency in these tests is bait for the race detector, and the
attempt counts are small on purpose. The collision itself is covered properly and
cheaply by `internal/atomicfile`'s own test.

`internal/setup` went from 191s to ~20s along the way, and got better at its job.

## Already right elsewhere

The pattern was known in this codebase: `handleDownload` holds `s.mu`, and
`internal/server/models.go` guards its `config.Set` calls with a dedicated
`writeMu` and a comment describing exactly this hazard. Three places out of five
had it. That is worth saying — this was a gap, not carelessness.

---

## Files changed

| File | Change |
|---|---|
| `internal/atomicfile/atomicfile.go` | New — one write-then-rename with unique temp files |
| `internal/atomicfile/atomicfile_test.go` | New — collision, permissions, cleanup, failure leaves the original intact |
| `internal/config/file.go` | `Set` uses `atomicfile` |
| `internal/state/state.go` | `writeAtomic` uses `atomicfile` |
| `internal/catalog/fetch.go` | cache write uses `atomicfile` |
| `internal/setup/setup.go` | `handleFinish` split into `completeSetup`; `handlePassword` guarded; `handleBackend` split into `applyBackend` |
| `internal/setup/setup_test.go` | `GOMAXPROCS`, start barrier, `-short` paths, error bodies; two new concurrency tests |

---

## Verification

- Full suite at `GOMAXPROCS=16` **with the race detector**: all 11 packages
  clean.
- Repeats at `GOMAXPROCS=16`: models and version ×20, supervisor ×5, server and
  jobs ×3. No further races surfaced.
- The strengthened finish test confirmed to fail on the unfixed handler and pass
  on the fixed one, at both `GOMAXPROCS=1` and `16`.
- `atomicfile`'s collision test confirmed to reproduce the original ENOENT on
  attempt 0 when the old fixed-name implementation is swapped back in.
- `-race` confirmed to report the `handlePassword` data race, naming
  `setup.go:268` and `269`, in 5 attempts on the unguarded handler.
- Full suite **with `-race` at `GOMAXPROCS=16`**: all 12 packages clean.
