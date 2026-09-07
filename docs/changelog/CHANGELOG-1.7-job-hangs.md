# v1.7 — Jobs that never finish

*Started as "make the one failing test pass". The test was wrong, and there was
also a real hang behind it — a different one from the case the test described.*

---

## Two separate problems

`TestJobLifecycleAgainstDeadUpstream` was the only red thing in the suite. Its
comment says a job against a dead upstream must reach a terminal status "rather
than sitting at `running` forever", and it was reporting exactly that failure.

It was wrong, and the thing it was wrong about was not the thing that was broken.

### 1. The test raced (no product bug here)

The poll loop ran 200 iterations back to back with no delay:

```go
for i := 0; i < 200; i++ {
    ...
    if final["status"] != "running" { break }
}
```

Two hundred in-process polls complete in microseconds. The job runs in a
goroutine and still has to fail its dial before it can record anything — measured
at **5.7ms**. So the loop drained and gave up long before the job could possibly
have finished. It was measuring how fast the test process can poll, not whether
the job ever terminates, and it failed a code path that was working correctly.
The `FAIL` line said `(0.00s)`, which was the tell.

Fixed with a real deadline: poll for up to ten seconds with a small sleep. Run
`-count=5`, passes every time.

### 2. A job really could hang — just not that way

A refused connection resolves in milliseconds. But an upstream that **accepts the
socket and then says nothing** is a different case, and nothing bounded it:

- llama.cpp deadlocked or mid-GPU-hang
- a firewall that DROPs instead of REJECTs
- a route that vanished after the connection was established

The client was `&http.Client{}` with this reasoning:

```go
// No client timeout: a generation legitimately runs for a long time.
// The per-job context carries jobTimeout instead.
```

The first sentence is right, and it is exactly why `http.Client.Timeout` cannot
be used here: that clock covers the **whole request including the streaming body**,
so any value large enough for a real generation is far too large to catch a wedge.

But the fallback was a single 30-minute cap. Measured against a silent upstream,
the job sat at `running` for the full half hour with nothing logged. Thirty
minutes of spinner is not meaningfully better than forever to someone waiting on
a reply.

## The fix: stage the bounds, the way the proxy already does

`internal/proxy` had this right and the jobs path never picked it up. Now both
use the same three stages:

| Stage | Window | Catches |
|---|---|---|
| Dial | 10s | upstream not listening |
| First byte (`ResponseHeaderTimeout`) | 5 min | accepted-but-silent |
| Gap between chunks | 10 min | stream stalls mid-generation |
| Total runtime | 30 min | everything else |

The first-byte window is generous on purpose: a 40K-context prefill on a large
model can run well past thirty seconds before llama.cpp emits its first token,
and cutting that off looks like a broken server rather than a busy one. Same
number and same reasoning as the proxy.

The between-chunks watchdog bounds the **gap**, never the total. A generation
that keeps producing is never interrupted however long it runs.
`TestHealthyStreamIsNotKilledByTheWatchdog` pins that — without it, a slow model
on a big context looks exactly like a wedge.

## Cancelled and failed are no longer the same thing

Every one of these arrives at the socket as the same cancellation, and the old
code mapped all of them to `cancelled`:

```go
if ctx.Err() != nil {
    job.setStatus(StatusCancelled, "")
}
```

So a generation that died on its own — or ran past the 30-minute cap — was
reported to the user as something **they** stopped. The real failure went
unrecorded anywhere.

The reasons now travel as context causes (`context.WithCancelCause`,
`context.WithTimeoutCause`), and `terminalFailure` reads the cause before the
error:

- watchdog trip → `error`, *"the model server stopped sending after 10m0s. It may have crashed or run out of memory — check the llama-server log."*
- runtime cap → `error`, *"this generation ran past the 30m0s limit and was stopped."*
- user pressed stop → `cancelled`, as before

`TestCancelStillReadsAsCancelled` guards the other direction, so the new causes
cannot swallow a real cancellation.

## One bug found by running the test

The first version of the watchdog fired perfectly and did nothing.

The stall context was created **after** `http.NewRequestWithContext`, so it
wrapped the read loop but not the request. Cancelling it left the socket open and
`Read` still blocked. `TestStalledStreamReachesError` caught it immediately —
the job hung for the full ten seconds — and the fix was to create the context
before building the request. The comment in `run` now says so, because the
arrangement looks correct either way and only fails at runtime.

## Partial output survives a stall

A stall does not discard what already arrived. Bytes streamed before the upstream
went quiet stay readable, so the half-written reply on screen is not replaced by
an error. Asserted in `TestStalledStreamReachesError`.

## Testability

`idle` and `maxRuntime` moved from constants to `Manager` fields, and the client
is built by `newJobClient(dial, header)`. Defaults are unchanged. This exists so
the watchdogs can be tested in under a second instead of eleven minutes — a
watchdog whose only proof is a five-minute test is one nobody ever runs.

## Tests

`internal/jobs/stall_test.go` — the three ways an upstream can fail to finish:

- `TestDeadUpstreamReachesError` — refused connection. Always worked; pinned so
  the new timeouts cannot regress it.
- `TestWedgedUpstreamReachesError` — accepted and silent. **This was the hang.**
- `TestStalledStreamReachesError` — headers and some tokens, then silence. No EOF
  to end the loop and the first-byte bound already spent, so only the
  between-chunks watchdog can end it.
- `TestHealthyStreamIsNotKilledByTheWatchdog` — the guard on the other side.
- `TestCancelStillReadsAsCancelled`, `TestExpiredJobReportsAnError` — status
  mapping.

Full suite is green, clean under `-race`, and stable at `-count=3`.
