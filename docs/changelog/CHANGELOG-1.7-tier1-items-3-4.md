# v1.7 tier 1 — items 3 and 4

Round 2. Items 1 and 2 were already settled in the tree I received and are
untouched here. Line numbers are against that tree (`a3481c8` in the local
review repo); "was" refers to the pre-change file.

Two commits, one per roadmap item, exported to `patches/`:

| Patch | Item | Files | Net |
|---|---|---|---|
| `0001-…` | 3 — remaining unescaped interpolations | 2 | +28 / −7 |
| `0002-…` | 4 — lore compression fails silently | 4 | +360 / −38 |

Nothing outside these two items was modified. `.git` in your tree was not
touched; the commits above live in a throwaway repo created here purely to
produce reviewable per-item patches.

---

## Item 3 — remaining unescaped interpolations

Confirmed exactly as the roadmap described, at exactly the cited lines.

### 3a. `js/02-model.js` — five interpolations, three sites

| Was | Now |
|---|---|
| `js/02-model.js:204` | `escapeHtml()` on `activeModel.id` and `activeModel.name` |
| `js/02-model.js:216` | `escapeHtml()` on `activeModel.name \|\| 'Unknown'` |
| `js/02-model.js:242` | `escapeHtml()` on `activeModel.id` and `activeModel.name \|\| 'Model'` |

Plus a comment block above `loadModelsList()` recording why the three
fallback paths escape and the main `models.forEach` loop does not need to
(it uses `createElement` + `textContent`, as the roadmap said).

**`activeModel.id` is a dead field.** It is never assigned anywhere:
`MODEL_REGISTRY` entries carry no `id` (`js/01-config.js:36-248`) and the
fallback object built at `js/02-model.js:26-32` does not set one either. So
`activeModel.id || 'custom'` always evaluates to the literal `'custom'`, and
two of the five interpolations were never reachable. They are wrapped anyway
— it costs nothing and it is correct the moment someone adds the field.

The same dead field is compared at **`js/02-model.js:233`**
(`o.dataset.id === activeModel.id`), which means the "if nothing was marked
active, select by matching activeModel" fallback can never match. That is a
separate latent bug. Not touched — flagging it for a later item, probably 14.

`activeModel.name` is always populated (`MODEL_REGISTRY['custom'].name` is
`'Custom GGUF'`), so wrapping line 204's un-defaulted `${activeModel.name}`
changes nothing behaviourally.

### 3b. `js/22-scheduler.js` — thread ids in an attribute

| Was | Now |
|---|---|
| `js/22-scheduler.js:59` | `escapeHtml(t.id)` in `value=""` |
| `js/22-scheduler.js:77` | `escapeHtml(t.id)` in `value=""` |

The trust boundary is as described: `js/21-data.js:88-91` merges imported
threads with whatever `id` they carry and no validation, and
`js/06-state-sync.js` restores from `/state`.

**Verified the escaping is transparent to the round-trip.** `saveSched()`
reads `document.getElementById('sched-thread').value` back out
(`js/22-scheduler.js:88`), and the browser decodes entities when parsing the
attribute, so the original id is returned unchanged and
`t.id === s.threadId` still matches. Checked against six hostile ids
including `x" onmouseover="alert(1)` and `"><script>alert(4)</script>`.

No double-escaping: `t.name` already had its `escapeHtml()` and was left
alone; the ids arrive raw from state.

### One spot beyond the seven

**`js/22-scheduler.js:37`** interpolated `${s.time}` raw into the schedule
row. `state.schedules` is replaced wholesale by full-backup import at
`js/21-data.js:161` with no validation — the same trust boundary, the same
file, the same bug class as 3b, one line above a line I was already editing.
Wrapped in `escapeHtml()`. It is not one of the seven the roadmap counted,
so it is called out separately here; revert that one hunk if you disagree.

---

## Item 4 — lore compression fails silently and stops firing

Both bugs confirmed at the cited lines. **One consequence in the roadmap is
wrong, and it changes what the fix has to do.**

### Correction to the diagnosis

The roadmap says: *"compression never fires, the archive never shrinks, the
context keeps growing, and every subsequent attempt fails harder."*

The archive does shrink. `js/08-rag.js:750-757` sets `m.archived = true`
**before** `summarizeForLore` is awaited, and nothing un-marks it on failure:

```js
for (let i = 0; i < firstArchivable; i++) {
  const m = liveMsgs[i];
  m.archived = true;        // happens regardless of what comes next
  toArchive.push(m);
  ...
}
if (toArchive.length > 0) {
  summary = await summarizeForLore(summary, toArchive, _authored);
```

So the real failure mode is the opposite of unbounded growth: those messages
are dropped from the model's context **and** never written into lore. The
context does not keep growing — the conversation quietly loses chunks of its
own history. Silent amnesia, not silent bloat.

This makes hard-trim the obviously right product call, because it is already
what the code does by accident. The work was making it deliberate,
recorded and visible rather than silent.

### Two further findings that affect the Verify step

**1. The 4096 case could not have worked with the clamp alone.** The
compression feed was capped only in chars (`MAX_CHARS_PER_PASS = 12000`,
`js/07-prompt.js:432`) — about 3,400 tokens, plus recorded lore and the
system prompt, so roughly 4,500 tokens of *input* before asking for a single
output token. That does not fit `--ctx-size 4096` no matter how carefully
`max_tokens` is clamped. Clamping the ask alone would have converted the 400
into a permanent no-room bail, and the roadmap's own verify step ("confirm
it fires and produces lore") would still fail. The input feed had to become
context-aware too.

**2. The frontend did not know the real `n_ctx`.** `resolveContextLimit()`
(`js/04-state.js:103`) clamps to `activeModel.maxCtx`, which is the model's
*training* context — 131072 for most of the registry — not the `--ctx-size`
llama-server was actually started with. Budgeting against it overestimates by
up to 32x and still 400s. The true value is at `GET /llm/props` →
`default_generation_settings.n_ctx`, previously read only by `gobboDiag()`
(`js/06-state-sync.js:648`). Note that line falls back to `n_ctx_train`,
which is fine for a diagnostic readout and fatal for a budget.

### Changes

**`js/07-prompt.js`**

- **`:298-330`** — new constants. `LORE_OUTPUT_TARGET_TOKENS = 2048` (the old
  fixed value, whose reasoning was sound and is preserved),
  `LORE_OUTPUT_FLOOR_TOKENS = 512`, `LORE_CTX_SAFETY_TOKENS = 256`.
- **`:332-378`** — `getServerContextSize()`. Probes `/props`, accepts only
  `n_ctx`, 60s TTL cache. TTL rather than invalidation hooks because a model
  hot-swap and a perf restart both take far longer than the window, and hooks
  would mean editing files this item has no business in.
- **`:427-440`** — `summarizeForLore` gains a `fallbackCtx` parameter, resets
  `_loreLastKind`, and resolves the context window up front.
- **`:566-612`** — the feed is now bounded by tokens against that window as
  well as by the existing char cap. Built newest-first then reversed, which
  is the same "keep the tail" rule the char cap already used. At least one
  message always goes in; a message too large to fit at all falls through to
  the no-room branch.
- **`:624-660`** — the no-room branch. Computes `remaining` from the real
  window, asks for `min(2048, remaining)`, and **if that is below the floor,
  does not send the request at all**. `renderLoreIndicator('compressing…')`
  moved to *after* this check — showing "compressing" for a pass that was
  never sent is exactly how the old stall read on screen.
- **`:701`** — `max_tokens: askTokens`, was `max_tokens: 2048`.
- **`:717-737`** — the `!resp.ok` branch no longer swallows. A **400 is
  treated as the no-room case**, because `estimateTokens` is `words × 1.43`
  (`js/07-prompt.js:254`) and under-counts CJK, code, URLs and long
  identifiers, so a prompt costed as affordable can still overflow the real
  tokeniser. Prediction plus backstop, not prediction alone.
- **`:390-424`** — `_loreLastKind` (`'ok' | 'skip' | 'noroom' | 'failed'`)
  and `_appendLoreGapMarker()`. `_loreLastOutcome` stays a prose string
  because the inspector prints it verbatim; the caller needs to branch, and
  branching on prose means substring-matching, which breaks on the first
  reword.

The gap marker is the honest half of hard-trim. When a pass gives up, the
messages are already gone from context, so the lore records
`- [N earlier messages dropped without being summarised.]`. That tells the
model there is missing history at that point instead of leaving a hole it
will confabulate across. Successive failures roll the count into the existing
marker rather than appending new lines — otherwise repeated failures would
fill the beat log and, since it is capped at `LORE_MAX_CHARS`, evict real
beats. **SKIP is exempt**: that is the model correctly reporting nothing
worth recording, an intentional discard rather than a loss.

**`js/08-rag.js`**

- **`:769`** — passes `tokenLimit` as the fallback budget, with a comment
  noting it can overestimate and why the 400 handler still matters.
- **`:788-800`** — the lore log gains a `failed` boolean.
- **`:803-818`** — `pendingLoreCompressionNote` now carries `kind` and
  `reason`.

**`js/13-dashboard.js`**

- **`:458-490`** — the in-chat banner gets a warning variant. **This fixes a
  UI lie**: the banner previously said "folded N older messages into the
  summary" on *every* pass that archived anything, including passes that
  archived those messages and then failed to summarise them — telling the
  user their history was preserved at the exact moment it was dropped. The
  warning names what was lost rather than the status code, and carries the
  reason on `title` and `aria-label` so it is available without opening the
  inspector.
- **`:519-535`** — new `_loreRowFailed()`. The inspector's old test was
  `e.why && e.after === 0`, which no longer holds now that a failed pass
  writes a gap marker (so `after` is non-zero). It reads the recorded verdict
  and falls back to the old test for rows written before this change.

**`css/15-lore-view.css`**

- **`:33-49`** — `.lore-banner-warn`. Amber (`--orange`), not the magenta of
  a routine system inject, and borrowing the colour the inspector already
  uses for give-up rows so the two read as one event in two places.

### On the accessibility question

I asked whether to add an `aria-live` region and you said to build for the
user base rather than for you. My call: **no new live-region pattern.** The
project has zero ARIA today apart from one `role="button"`, and introducing a
codebase-wide announcement mechanism is its own piece of work, not something
to smuggle in under item 4. Instead the warning banner carries the full
reason in `aria-label` and `title` — one attribute, no new pattern, and a
screen reader tabbing to the banner hears the whole message. If you ever do
want live regions, that is a clean standalone item.

---

## Verification

`test-lore.mjs` (shipped alongside) loads the **real** `js/07-prompt.js` into
a VM against a fake llama-server that enforces the actual server rule
(`prompt + max_tokens > n_ctx` → 400). The module under test is byte-identical
to what ships; the probe shim is appended at load time, not edited in.

**35 assertions, all passing.** The ones that matter:

| # | Scenario | Result |
|---|---|---|
| 1 | `--ctx-size 4096`, 20-message archive | **Fires and produces a beat.** prompt 3145 + ask 679 = 3824 / 4096 |
| 2 | Roomy context (131072) | Still asks for exactly 2048 — no behaviour change |
| 3 | Genuinely no room (700) | **No request sent at all**, `kind=noroom`, gap marker, prior lore intact |
| 4 | 4 consecutive failures | One marker line, count rolled to 8, original beats intact |
| 5 | A 400 that slips through anyway | Treated as no-room, gap recorded |
| 6 | Non-400 (503) | `kind=failed`, status reported, gap recorded |
| 7 | Model returns SKIP | No marker, lore untouched — correctly not a gap |
| 8 | Server reports no `n_ctx` | Falls back to card limit, **does not** use the 131072 `n_ctx_train` |
| 9 | Timeout / `AbortError` | Turn survives, gap recorded, prior lore kept |
| 10 | Model returns nothing | `kind=failed`, gap recorded |

Separately verified the gap marker cannot grow without bound: 50 consecutive
failures on a lore log already near the cap produced one marker line and 59
chars of total growth.

`LORE_TIMEOUT_MS` (45s) is untouched, as instructed.

### What still needs a human at a real machine

The harness models the server's rule but not its tokeniser — it reuses
`estimateTokens`, so it cannot catch a real under-count. That is precisely
what the 256-token safety margin and the 400 backstop exist for, but the
margin's adequacy is an empirical question. Worth running the roadmap's
Verify against a CJK or code-heavy conversation on a small `--ctx-size`, and
watching for the amber banner. If it appears often on ordinary English
prose, the margin is too tight; if it never appears on a deliberately
hostile conversation, it is about right.

Item 3's verify (import a backup with a hostile thread id and a hostile card
name, open the scheduler and the model dropdown) still wants doing in a real
browser — the round-trip proof above is logic, not a live DOM.
