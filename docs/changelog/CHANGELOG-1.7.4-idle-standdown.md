# 1.7.4 — Idle stand-down: give the VRAM back

Roadmap item 6: *"Standdown / idle for backend processes [this created an
escalating vram issue for some users]. If not opened or used for 5 min > stand
down. Toggle in user config allows users to enable/disable OR change the
timeout."*

llama-server holds the whole model in VRAM for as long as it runs, whether or
not anyone is talking to it. Leaving GobboNet open overnight pins several
gigabytes against nothing, and the machine does not get that memory back for
anything else until the app is closed.

After `idle_standdown_minutes` with no messages, the model is unloaded. The
next message reloads it.

## Four decisions worth stating

### It is server-side, not a page timer

The obvious place for an idle timer is the browser, and it is the wrong one.
The case that matters most is the browser being **closed** — and a tab that has
been shut cannot run a timer. A client-side version would free VRAM in every
situation except the one where the user has most obviously finished.

The timer belongs to the process that owns the child, so it lives in the
supervisor and keeps running with no browser attached at all.

### "Used" means requests, not "open"

Activity is requests that reach llama.cpp. Not the page being open, not a
poll — **an idle open tab is exactly the case this exists for.** Generation is
the only thing the frontend sends through the proxy, so that needs no
special-casing today.

### The wake is synchronous

A stood-down model reloads *before* the request is forwarded, and the user gets
a slow reply rather than an error.

The alternative is to answer 503 and let the client retry, which is how a swap
works — but a swap is something the user asked for and is watching a progress
panel for. A stand-down reload is not: they pressed send. Returning an error
there would make the feature's most common visible behaviour a failed message,
and the setting would be switched off on every machine within a day. Blocking
costs the same wall-clock time and arrives as a delay instead of a fault.

### The in-flight counter, not a timestamp

This is the one that would have been a real bug. A long generation looks
exactly like an idle one: the request arrived six minutes ago, nothing has
happened since, and the reply is still streaming. Judging on last-activity
alone would unload the model **in the middle of it**, and the cost of that is
not a slow reply — it is a truncated one that reads as a crash.

So requests are counted, the count is checked before standing down, and the
clock is marked again when a request *ends*, so a six-minute generation is not
already past a five-minute timeout the instant it finishes.

## What else it refuses

Stand-down is declined, with a reason recorded for the log, while a swap is
running, unless the phase is Ready, and when there is no process. It is also
not wired up at all in remote mode — there, llama.cpp is somebody else's
process on somebody else's machine, and stopping it is not ours to do.

A model loaded at boot and never used has no clock to measure from. Rather than
treating "never used" as infinitely idle and unloading immediately — which
would fight anyone who starts the app and goes to make tea before typing — the
first check starts the clock and the next one decides.

`PhaseStoodDown` is its own phase, distinct from `PhaseIdle`. One means a model
was deliberately unloaded and the next message costs a load; the other means
none was ever started.

## The setting

`idle_standdown_minutes` in `gobbonet.toml`, **default 5**, `0` disables it.

Also in **CONFIG → Idle Stand-Down**, which reads and writes `/standdown`. That
control is the only thing in CONFIG that lives on the server rather than in
`state.settings`, so it applies on its own button rather than on SAVE, and it
**hides itself entirely** when the server reports it cannot unload anything. A
switch that looks real and does nothing is worse than no switch: the user turns
it on, VRAM stays pinned, and the setting takes the blame for something it was
never able to do.

Changes are persisted to the config file, not just applied — a setting that
reverts on restart is one the user has to rediscover every time, and the people
most likely to change this are the ones it just surprised. When the write
fails (a read-only install), the panel says *"applied for now… will revert on
restart"* rather than claiming a save that did not happen.

Turning it off also wakes a model that is already down, so disabling the
feature does not leave you having to send a message to get your backend back.

## Default on, and the tradeoff

On by default at 5 minutes, as specified. The problem it solves is one users
hit without knowing it is a setting.

The cost is real and worth saying plainly: **the first message after a pause
pays a full model load.** On a small model from an SSD that is a few seconds;
on a 70B it can be a minute. If testing says 5 minutes is too aggressive, it is
one number in `Default()` — everything downstream reads it.

## What pins it

**`internal/supervisor/standdown_test.go`** (11 tests). The decision is
separated from acting on it precisely so it can be tested without launching a
model: the timeout boundary, the disabled case, every refusal with its reason,
the in-flight guard including a long generation and 200 concurrent requests,
the clock starting on first check, and that eight simultaneous requests against
a stood-down model produce **one** reload rather than eight — the GPU has only
just been given its memory back.

**`internal/server/standdown_endpoint_test.go`** (7) and
**`tests/test-standdown-panel.mjs`** (29) cover the endpoint and the panel,
including that the control disappears in remote mode.

Verified to bite: removing the in-flight guard fails
`TestStandDownRefusesWhileARequestIsInFlight`; removing the visibility check
fails the remote-mode assertion.

**And verified live**, against a real supervisor driving a stand-in for
llama-server, because the unit tests deliberately stop short of launching
anything:

```
1) booted:      phase=ready
2) stood down at t+75s
   {"idle_seconds":66,"minutes":1,"stood_down":true,"supported":true}
3) sending a message:  http 200 in 0.50s
   reply: {"choices":[{"message":{"content":"hi"}}]}
4) after:       phase=ready
   [standdown] idle for 1m0s; unloading test-model.gguf to free VRAM
```

The backend process was confirmed gone while stood down and back afterwards,
and the toggle was confirmed to write `idle_standdown_minutes` into the config
file without disturbing the `[ui]` table beside it.

## Not changed

Remote mode is untouched. Swapping, `/perf` and the crash-restart path are
untouched — stand-down uses the same `stop()` that already suppresses
restart-on-exit, so a deliberate unload is not mistaken for a crash.

---

# Follow-up — the setting nobody could find

Reported as: *"I don't see an option in the config menu. Did we properly
implement this beyond that?"*

It was implemented. It was invisible, which turns out to be the same thing.

## What was happening

`loadStandDownPanel()` hid the whole section unless `/standdown` reported
`supported: true`, and that is false whenever GobboNet points at a llama.cpp it
did not start. Reproduced against the shipped binary:

```
mode:       remote
/standdown: {"minutes":0,"supported":false}
```

so the section removed itself, and CONFIG looked exactly as it had before the
feature existed.

The original reasoning still holds on its own terms — a switch that cannot act
gets blamed when the VRAM stays pinned. But it traded one problem for a worse
one. **An invisible feature is indistinguishable from a feature that was never
built**, and the first thing it produced was the maintainer asking whether the
work had been done at all. A setting nobody can find is not a conservative
default; it is a missing setting.

## What it does now

Always visible. When it cannot act, the control is **disabled** and the reason
sits next to it:

| situation | what it says |
|---|---|
| remote mode | pointed at a llama.cpp running somewhere else, so it cannot unload it — that process belongs to whoever started it |
| server older than the page | this server does not have the setting; update the binary |
| server unreachable | could not reach the server to read this setting |
| `file://` | opened from a file, so there is nothing here to unload |

Nobody flips a switch that does nothing, and nobody wonders whether the switch
exists. The old rule only achieved the first of those.

It has also moved to the **bottom of CONFIG**, directly above Privacy Status,
which is where it was asked for.

## Tests

`tests/test-standdown-panel.mjs`, 43 assertions. Section A now checks each
can't-act case for three things rather than one: still visible, control
disabled, and a reason on screen. There are also assertions on its position in
the panel and that the markup does **not** carry `display:none`.

Verified to bite: restoring the hide-in-remote-mode branch fails 4.

Two harness notes. The fake DOM had no APPLY button and no `disabled` property,
so "the control is disabled" could not have been checked before. And the
position assertion first matched a *comment* elsewhere in the panel that
mentions Privacy Status by name; it anchors on the label now.
