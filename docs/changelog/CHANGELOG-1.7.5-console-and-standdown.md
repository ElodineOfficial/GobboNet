# 1.7.5 — What the console says, and why stand-down was never firing

From the report: *"let's talk about information flow from the windows CMD that
is showing what's going on. Swap? We want to show that. Initial llama load and
messages? That's a bit too much... something is up with the nomadic model....or
the switch...or the unloading? I can't tell what's what, but 'model stand down'
option does work in the config, I just can't see evidence of it working in the
CMD but I AM ALSO BLIND! So I might be missing it, it also might be what 'all
slots are idle' means!"*

Four separate things, and the attached 901-line capture answered all of them.
Three were real defects. Taking the direct questions first.

## "All slots are idle" — no, that is not stand-down

It is llama.cpp's own message, and it means *the engine has finished a
request*. In the capture it appears 0.02 seconds after startup, before anything
could possibly have gone idle, and then once per reply after that.

Nothing to do with the feature. Reading it as stand-down is an entirely
reasonable misreading of a line that should never have been on screen in the
first place, and it is now filtered out.

## Stand-down really was never firing, and an open tab was why

There was no evidence in the console because there was nothing to see. Stand-down
did not happen once in thirteen minutes. Two independent bugs, both mine.

**1. A browser tab reset the idle clock twelve times a minute.**

`js/24-boot.js` polls `checkConnection()` on a five-second `setInterval`, which
fetches `/llm/health` through the proxy. Every request that reached the proxy
called `MarkActivity()`, on this reasoning, written in the 1.7.4 source:

> Generation is the only thing the frontend sends through the proxy, so that
> distinction needs no special-casing today.

That was never true. The chat page also sends `/health`, `/props`, `/tokenize`
and `/apply-template` down the same proxy. So the shortest timeout the panel
offers is 60 seconds, the poll ran every 5, and the clock could not reach the
end of a 60-second countdown, let alone a five-minute one. The feature whose own
changelog says *"an idle open tab is exactly the case this exists for"* could not
fire while a tab was open. The timer worked perfectly; it was simply never
allowed to finish.

**2. `/llm/jobs` bypassed the mechanism completely.**

The chat page generates through `/llm/jobs`, which is dispatched to the jobs
manager and never touched the proxy. So real use never marked activity, and a
stood-down model was never woken for the one request type that actually needs
it. Fixing only the first bug would have made stand-down start firing in the
middle of conversations.

**Fixed by deciding what counts as use, once, in writing.**
`internal/server/standdown.go` now classifies the request: the five generation
paths, plus `POST /llm/jobs`, hold the model awake and wake it if it is down.
Everything else — `/health`, `/props`, `/tokenize`, `/slots`, `/metrics`, and a
`GET` on a job — does not, and deliberately does not wake it either. Waking on a
health poll is the same bug wearing a different hat: the model would reload five
seconds after every stand-down, forever.

Inspecting a stood-down model now gets a plain 503 saying *"the model is stood
down to free VRAM / it reloads automatically on your next message"*, rather than
a dead-upstream error. Asleep and broken look identical from a refused
connection, and only one of them is true.

## It also said nothing when it declined

`WatchIdle` read `ok, _ := s.standDownDecision(...)`. The reason was computed
and thrown away, so a watchdog declining every fifteen seconds for a perfectly
good reason was indistinguishable from one that was not running. There was no
way to tell the two apart without watching VRAM in another tool.

It now says so — once per reason, never for the ordinary countdown, because
`idle 45s of 5m0s` every fifteen seconds buries the thing it is meant to make
visible:

```
[standdown] holding off: nothing has been sent yet -- the idle clock starts now
[standdown] UNLOADING qwen3-8b-q4.gguf after 5m0s idle -- its VRAM is now free
[standdown] model unloaded. Your next message reloads it automatically.
[standdown] WAKING -- reloading qwen3-8b-q4.gguf for your message
[standdown] reloaded qwen3-8b-q4.gguf in 2.8s on AMD Radeon RX 9070 XT -- all 43 layers on the GPU, 2.9 GB of VRAM
```

## The "nomadic model" is nomic-embed being offered as a chat model

`nomic-embed-text-v1.5.Q8_0.gguf`. The optional RAG feature downloads it into
the same `models/` folder as the chat models, and `ScanDir` handed it back like
any other file — so it appeared in the model dropdown. In the captured session
it was selected at 08:26:13, ran for eleven minutes, and was swapped back out at
08:37:40.

It is not a chat model. Launched as one it gets `--jinja` and
`--reasoning-format`, no `--embeddings`, on the chat port. It loads fine and
then every reply is nonsense. The console said as much, twice, in terms that
tell a non-specialist nothing:

```
llama_context: n_ctx_seq (32768) > n_ctx_train (2048) -- possible training context overflow
srv send_error: task id = 0, error: the current context does not logits computation. skipping
```

**Fixed at the source**: `ScanDir` no longer offers it. The architecture is the
reliable signal (`bert`, `nomic-bert`, `nomic-bert-moe`, `jina-bert-v2/v3`,
`gte`, `new`, `xlm-roberta`); the filename is the fallback for a header that
will not read, exactly as the existing projector rule works. Embedding models
keep working for what they are for — this only stops them being offered as
something to talk to.

**And said plainly if one turns up anyway**, since a hand-placed file or a new
architecture will eventually get past the list:

```
[swap] note: this model was trained for 2,048 tokens of context but is set to
       32,768. Replies past its training length may come out garbled; if it is
       an embedding or reranking model it is not meant for chat at all
```

## The console itself: 901 lines down to a readable handful

*"Initial llama load and messages? That's a bit too much. We do need to see
pretty much everything else."*

Of the 901 lines, 680 were the engine:

```
182  print_info:               model metadata, during load
139  llama_model_loader:       GGUF key/value pairs, during load
 42  llama_context:
 30  sched_reserve:
 29  load:
 18  load_tensors:
  9  slot print_timing:        per reply
  9  slot launch_slot_:        per reply
  8  srv update_slots:         "all slots are idle", per reply
  5  the formatted prompt itself, echoed back
```

Two things happen to that now.

**The per-reply chatter and the metadata dump are filtered out.** Replaying the
real capture: **680 engine lines in, 9 out.** The rule is deliberately the way
round that fails safely — a short list of things *observed* to be noise is
dropped and everything else is kept, because llama.cpp's log strings are
internal wording it has reworded before (issue #33), and an allow-list would
start hiding new messages the day upstream renames something. Clutter is the
harmless failure; silence is not.

The formatted prompt is gone for a second reason as well. At `-lv 4` llama.cpp
echoes it, which means the conversation was being printed to a window someone
might be sharing.

**The load is summarised instead of relayed.** Filtering alone got a load down
to seventeen lines, which is better and still wrong, because of what the lines
are:

```
0.00.083.537 I   - Vulkan0 : AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)
0.01.776.206 I load_tensors: offloaded 43/43 layers to GPU
0.01.776.212 I load_tensors:      Vulkan0 model buffer size =  2934.68 MiB
0.02.797.612 I srv  llama_server: model loaded
```

Four lines, three facts, padded columns, the facts in a different place on each
line. Read down a screen that is fine. Read **aloud**, one line at a time, with
no way to skim back, each line stops halfway through an answer.

So those lines are read on the way past and the console gets the sentence:

```
[swap] LOADING google_gemma-4-E4B-it-Q4_K_M.gguf
[swap] loaded google_gemma-4-E4B-it-Q4_K_M.gguf in 2.8s on AMD Radeon RX 9070 XT -- all 43 layers on the GPU, 2.9 GB of VRAM
```

The same treatment applies where it is useful rather than only where it was
asked for. A partial offload — the usual cause of "why is this so slow" — reads
`20 of 43 layers on the GPU, the rest on the CPU`. A CPU-only load names the
processor and says `no GPU offload`, because that is the case someone otherwise
spends an evening on driver settings over. And `n_ctx_seq (32768) <
n_ctx_train (131072)`, which llama.cpp reports as "the full capacity of the
model will not be utilized", becomes one of the few genuinely useful knobs a
user has:

```
[*]  note: using 32,768 of the 131,072 tokens of context this model supports --
     raise the context setting in CONFIG if you want it to remember more, at the
     cost of VRAM
```

**Warnings and errors are not summarised.** They pass through untouched, in
llama.cpp's own words. A paraphrase is a convenience for the routine case; the
non-routine case is exactly where somebody's own wording beats ours. In the
captured session that means the three lines showing the embedding model failing
to generate still arrive verbatim — which is the evidence that was wanted and
was previously buried under two hundred lines of metadata.

**The log file is unaffected.** It receives everything, every time, and
`engine_output_full = true` puts the raw stream back on screen.

## Two smaller things the capture showed

**Every swap wasted about eleven seconds and printed two alarming lines.** The
polite `taskkill /T` sends `WM_CLOSE`, which a console-less child ignores, so it
returned exit 255 — and the old code treated that as a real error, which bought
a five-second grace period before escalating. Twice. It now escalates to
`/F` immediately on refusal, which is what was always going to happen.

**An unreadable GGUF was announced twice on every boot**, because two unrelated
callers both read its header: `Boot`'s directory scan, to find a model at all,
and `start`'s identification, to decide what flags to launch it with. Both were
right to look and both were right to complain, and the user heard the same
sentence twice. One warning per file per run now. Worth a mutex and a map
because of who reads this console: a duplicate is not a glance-over, it is the
same sentence read out again, and four bad files would have said it eight times
before the app started.

## Accessibility, stated as a rule rather than a nicety

The primary reader of this console is blind and hears it through a screen
reader. That is now the standard the output is written to, and it is pinned by
tests rather than left to taste:

- **The verb comes first.** `UNLOADING`, `WAKING`, `LOADING`, `loaded`.
- **One event is one line.** A screen reader reads sequentially; an event split
  across three lines is three events as far as the listener can tell.
- **No fact lives only in a column position.** Every number is in the place a
  sentence puts it.
- **Nothing depends on colour or alignment.**
- **Repetition costs something.** A standing condition is said once. The
  countdown is never narrated. `already stood down`, fifteen seconds after the
  line that unloaded it, is not reported at all.
- **Big numbers are grouped** — `32,768`, not `32768`, which many readers spell
  out one digit at a time.

## What pins it

`internal/server/standdown_activity_test.go` — the classification, and the half
that fails when the frontend changes. It reads `js/` for every `LLAMA_URL + '…'`
call and refuses to pass if the page learns to call an endpoint nobody has
classified, naming it. That is exactly how this bug happened: a path was added
on one side and nobody revisited the other.

`internal/supervisor/standdown_log_test.go` — what the watchdog *says*: that a
refusal is reported, that a standing reason is reported **once**, that the
countdown is never narrated, that a changed reason is reported again, that the
unload names the model and the VRAM and says it comes back by itself, that every
line is one line, and that a nil logger does not panic.

`internal/supervisor/loadsummary_test.go` — every input string is one llama.cpp
has actually printed. Both of its wordings for the context mismatch are
understood (it uses two in a single session). A line split across two writes is
still read. `Reset` clears the summary, or a swap would report the previous
model's layer count as its own.

`internal/supervisor/replay_test.go` — the real 901-line capture, replayed
through the filter *and* the summary together, asserting the **facts** survive
somewhere rather than that particular lines do. Which of the two carries a fact
is an implementation choice; "can the console answer 'is my GPU being used'" is
the property that matters.

`internal/models/embedding_test.go` — the architecture list, the filename
fallback, that chat architectures are not mistaken for embedders, and that an
embedding model alone in a folder is not offered as a fallback chat model.

All five fixes were mutation-tested: the shipped bug was restored in each case
and the relevant tests were confirmed to fail, with the failure message naming
the defect. The lifecycle was then driven end to end — boot, hot swap, twenty
health polls, stand-down, and a wake on a real message — against a stand-in
engine replaying the capture's own output.

### One test that found a real hole while being written

`TestARewordedLineIsNotSilentlyDropped` asserts that a line the summary cannot
parse still reaches the screen. It failed. `offloaded 43/43 layers to GPU` — the
single most-watched line in the stream — has the prefix `load_tensors:`, which
is on the noisy list because its other eighteen lines are buffer arithmetic. So
it survived only by being *recognised* first. Reword it upstream and neither the
summary nor the keep-list recognises it, the prefix rule drops it, and the answer
to "is my GPU being used" disappears from the console without anybody touching
the file.

The fix is a short list of watched words that the prefix rule may not override.
A line about offloading that we failed to understand goes on screen and looks
out of place, which is how someone finds out.

The same concern shaped how the load lines are hidden at all. Rather than a list
of "lines the summary covers" — which would go stale the day one is reworded,
dropping the line while no longer capturing the fact — the filter asks the
parser: a line is hidden only if feeding it to a throwaway summary *changed
something*, which means the fact is now in the sentence. The two cannot disagree.

## Still true

- One file to update. No new config file, no migration.
- Both new settings default to the behaviour above: `show_engine_output = true`,
  `engine_output_full = false`.
- No new hidden windows, encoded payloads, or outbound hosts.

## Known remaining repetition

Two of llama.cpp's own model-file warnings still print on every load of the
models that provoke them — a control-token type override and a tokenizer
`special_eos_id` note. They are per-model constants rather than events, so
saying them once per session would be defensible. They are left alone
deliberately: suppressing engine *warnings* is a decision worth making
explicitly rather than as a side effect of tidying, and this area has already
been bitten once by output that went quiet. Say the word and they become
once-per-model, the same way the GGUF header warning now is.
