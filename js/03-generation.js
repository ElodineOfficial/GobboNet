/* @gobbonet-split js/03-generation.js
   Moved verbatim from chat.html lines 2020-3134.
   detached jobs, token limit, auto reroll, timer, thinking formats, tool-call unwrap
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   DETACHED GENERATION JOBS (survive tab-away / navigation)

   The old model: the browser held the /llm streaming fetch open for
   the whole generation. Navigate anywhere — new URL, tab close, phone
   screen lock — and the fetch died, the proxy link collapsed, and
   llama-server cancelled the slot. The reply died with the page.

   The new model: the file server owns the upstream connection. We
   POST the exact same request body to /llm/jobs, get an id back
   immediately, and then merely OBSERVE the generation by polling
   /llm/jobs/<id>?from=<byteOffset>. The server spools the raw SSE
   bytes to disk; we feed whatever bytes arrive through the SAME
   parser pipeline as before (extractTokenFromLine →
   processStreamDelta → finalizeStreamMessage), so thinking formats,
   tool-call unwrapping, and reasoning routing behave identically.

   Because the transcript is a byte-stable file, ATTACHING IS
   REPEATABLE: after any navigation we can come back, replay from
   byte 0 into a fresh message object, and land on exactly the text
   a live stream would have produced. `thread.pendingJob` (persisted
   in localStorage/IDB/state like everything else) is the breadcrumb
   that tells boot which jobs to pick back up — see
   resumePendingJobs() near the boot block.

   Fallbacks: on file:// there is no server, and the 1.7 PowerShell
   server (removed in 1.8.0) has no /llm/jobs route. Both cases 404/fail the
   probe and we drop to the legacy direct-stream path automatically.
================================================================ */
const JOBS_URL = LLAMA_URL + '/jobs';

// null = unknown (probe on first send) · true = relay in use · false = legacy.
// Only a definitive 404/405 pins it to false; transient network errors leave
// it null so the next send re-probes.
let jobsAvailable = IS_SERVED ? null : false;

// The one generation this client is currently attached to (global, matching
// the app's one-generation-at-a-time model). stopGeneration() and the CoT
// watchdog reach the job through this.
let currentJob = null;        // { id, threadId, cancelSent }
let _cotCulledFlag = false;   // set by the watchdog so the finalizer can label the stop

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Wake-aware sleep for the job poll loop. Mobile browsers throttle or
   fully suspend timers the moment the app is backgrounded; on return, a
   plain setTimeout fires whenever the throttler gets around to it. The
   poll loop sleeps through THIS instead, so handleAppWake() can resolve
   every parked sleep the instant the user comes back (or the network
   returns — the 'online' event routes here too) and the next poll fires
   immediately instead of "eventually". Each waker removes itself on
   either path, so the parked list can't leak across generations. */
let _pollSleepWakers = [];
function _wakeableSleep(ms) {
  return new Promise(resolve => {
    let timer = null;
    const wake = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      const i = _pollSleepWakers.indexOf(wake);
      if (i >= 0) _pollSleepWakers.splice(i, 1);
      resolve();
    };
    timer = setTimeout(wake, ms);
    _pollSleepWakers.push(wake);
  });
}
function wakePendingPolls() {
  const parked = _pollSleepWakers.splice(0);
  for (const wake of parked) wake();
}

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ================================================================
   SMART TOKEN LIMIT
   Optional cap (CONFIG) on how long a single AI reply may get.
   Uses the same rough estimator as the context meter
   (estimateTokens ≈ ¾ word per token), watches msg.content as it
   streams, and — once the cap is reached — lets the sentence in
   progress finish, then cuts exactly at its end and stops the
   generation. Reasoning/chain-of-thought is exempt: the cap is
   about visible reply length, and reasoning models need room to
   think (this is also why we DON'T set a server-side max_tokens —
   it would count thinking tokens and truncate mid-reasoning).

   A short grace window (~15% of the cap) covers the tail of the
   in-progress sentence; if the model is mid-run-on and no sentence
   end shows up inside the grace, we trim BACK to the last finished
   sentence instead, so the cap can never be blown past by much.

   Enforcement lives in the feeder, so it applies identically to
   fresh sends, rerolls, auto-continue chains, live job re-attaches,
   AND background replays of jobs that finished while the tab was
   closed (a detached job has no client to stop it, so trimming at
   fold-in is the only way the cap can hold there).
================================================================ */

// Sentence terminator + any trailing closers (quotes, brackets, markdown
// emphasis) so a cut after "…end.**" or "…end.") keeps the closers.
const _SENT_END_RE = /[.!?…]["'\u201d\u2019)\]*_]*/g;

/**
 * Heuristic: is the match at [matchStart, matchEnd) a real sentence end?
 * Requires a following whitespace char — never end-of-buffer, because a
 * trailing "." mid-stream might be the "3." of "3.5"; the next chunk
 * resolves it. Skips decimals / "1." list markers (digit before the dot)
 * and common abbreviations or single-letter initials.
 */
function _isSentenceEndAt(text, matchStart, matchEnd) {
  if (matchEnd >= text.length) return false;
  if (!/\s/.test(text[matchEnd])) return false;
  if (text[matchStart] === '.') {
    if (matchStart > 0 && /[0-9]/.test(text[matchStart - 1])) return false;
    const before = text.slice(Math.max(0, matchStart - 9), matchStart + 1);
    if (/(?:\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Fig|Vol|No)|\b[A-Za-z])\.$/.test(before)) return false;
  }
  return true;
}

/** Index just past the FIRST sentence end at/after fromIdx, or -1. */
function findSentenceEnd(text, fromIdx) {
  _SENT_END_RE.lastIndex = Math.max(0, fromIdx);
  let m;
  while ((m = _SENT_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (_isSentenceEndAt(text, m.index, end)) return end;
  }
  return -1;
}

/** Index just past the LAST sentence end at/before uptoIdx, or -1. */
function findLastSentenceEnd(text, uptoIdx) {
  const bound = Math.min(text.length, Math.max(0, uptoIdx));
  _SENT_END_RE.lastIndex = 0;
  let best = -1, m;
  while ((m = _SENT_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > bound) break;
    if (_isSentenceEndAt(text, m.index, end)) best = end;
  }
  return best;
}

/**
 * Check msg.content against the smart limit; trim + stop when due.
 * Called from the feeder after every parsed delta. Returns true once
 * the cut has happened (callers stop feeding this message).
 *
 * On the first crossing we freeze the approximate char position where
 * the cap landed (proportional — the estimate is word-based, so exact
 * chars don't exist) and hunt forward from there for the end of the
 * sentence that was in progress.
 */
function maybeApplySmartLimit(msg) {
  if (msg.smartCapped) return true;
  // Per-card. A code assistant and a DM want very different reply lengths,
  // which one global number could never serve.
  // The card writing THIS message: in a group chat that is the member whose
  // turn it is, not the active character (1.8.0). An unstamped message, and
  // a card since deleted, fall back to the active one as before.
  const _writer = (msg.cardId && typeof state !== 'undefined' && Array.isArray(state.characterCards))
    ? state.characterCards.find(c => c.id === msg.cardId) : null;
  const sl = resolveSmartLimit(_writer || (typeof getActiveCard === 'function' ? getActiveCard() : null));
  if (!sl.enabled) return false;
  const text = msg.content || '';
  if (!text) return false;

  const limit = sl.tokens;
  const est = estimateTokens(text);
  if (est < limit) return false;

  const grace = Math.min(96, Math.max(24, Math.round(limit * 0.15)));

  if (!msg._smartLimitAt) {
    msg._smartLimitAt = Math.max(1, Math.floor(text.length * (limit / est)));
  }

  let cut = findSentenceEnd(text, msg._smartLimitAt);
  // A found end that overshoots the grace (marathon sentence) doesn't count.
  if (cut >= 0 && estimateTokens(text.slice(0, cut)) > limit + grace) cut = -1;
  if (cut < 0) {
    if (est <= limit + grace) return false;   // grace still open — keep streaming
    // Run-on overshoot: fall back to the last sentence that DID finish
    // before the cap; failing that, a word boundary near the cap.
    cut = findLastSentenceEnd(text, msg._smartLimitAt);
    if (cut < 0) {
      const ws = text.lastIndexOf(' ', msg._smartLimitAt);
      cut = ws > 25 ? ws : Math.min(text.length, msg._smartLimitAt);
    }
  }

  msg.content = text.slice(0, cut).replace(/\s+$/, '');
  if (msg._parseState) msg._parseState.pending = '';   // don't let finalize re-append tail bytes
  delete msg._smartLimitAt;
  msg.smartCapped = limit;   // persisted — drives the ✂ badge and the feed gate
  console.log(`[smart-limit] ~${est} est tokens ≥ cap ${limit} — cut at sentence end (${msg.content.length} chars), stopping generation`);
  stopGeneration({ keepChain: true });   // capping one reply shouldn't kill an auto-continue chain
  return true;
}

/* ================================================================
   AUTO REROLL (1.8.0) -- a reply that uses an off-limits word is
   written again.

   Banned Phrases (logit bias, js/06-state-sync.js) pushes words down
   before they are written, but it works on the model's tokens: a word
   in another form, split into other pieces, or under a mild bias still
   gets through. This reads the reply itself. As it streams, the
   visible reply -- msg.content, never msg.reasoning -- is checked
   against the card's list; on a hit the reply is stopped there and
   generated again from scratch, up to card.autoRerollMax more times.
   The last try is never stopped early: if it still uses a word, it is
   kept whole and marked (msg.autoReroll.kept), so a turn always ends
   with a complete reply.

   What is never rerolled: a reply that has run a tool (a reroll would
   run the tool again), one the user stopped or the runtime limit cut,
   one that failed, and one finished while the page was closed (that is
   folded in by finalizeJobIntoThread, which does not regenerate).

   Matching: one word or phrase per line, any case, whole words only --
   "nod" does not catch "nodded" -- with `*` at either end standing for
   any run of letters ("chuckl*" catches chuckle, chuckled, chuckling).
   A line that starts or ends with punctuation is matched as written,
   so an em dash on its own line catches every em dash. Straight and
   curly apostrophes match each other. While streaming, a word at the
   very end of the text so far is not counted until the next character
   shows it ended there: "chuckle" may yet become "chuckles".
================================================================ */
const AUTO_REROLL_MAX_DEFAULT = 3;
const AUTO_REROLL_MAX_CEIL = 10;
const AUTO_REROLL_MAX_ENTRIES = 200;
const AUTO_REROLL_MAX_ENTRY_CHARS = 100;
// What a card's list may hold, as text: 200 entries of 100 characters.
const AUTO_REROLL_MAX_WORDS_CHARS = 20200;

const _AR_WORD = /[\p{L}\p{N}_]/u;

/** The card's off-limits list as matchers: [{ entry, re, wordEnd }]. */
function autoRerollMatchers(raw) {
  const out = [];
  const seen = new Set();
  for (let line of String(raw || '').split(/\r?\n/)) {
    line = line.trim().replace(/\s+/g, ' ');
    if (!line || line.length > AUTO_REROLL_MAX_ENTRY_CHARS) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    const body = line.replace(/^\*+|\*+$/g, '');
    if (!body) continue;   // "*" alone would match everything
    seen.add(key);
    const starStart = /^\*/.test(line), starEnd = /\*$/.test(line);
    let src = '';
    for (const ch of body) {
      if (ch === ' ') src += '\\s+';
      else if (ch === "'" || ch === '’') src += "['’]";
      else if (ch === '*') src += '[\\p{L}\\p{N}_\'’-]*';
      else src += ch.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
    }
    const first = body[0], last = body[body.length - 1];
    const wordStart = _AR_WORD.test(first), wordEnd = _AR_WORD.test(last);
    if (starStart) src = '[\\p{L}\\p{N}_\'’-]*' + src;
    if (starEnd) src += '[\\p{L}\\p{N}_\'’-]*';
    if (wordStart) src = '(?<![\\p{L}\\p{N}_])' + src;
    if (wordEnd) src += '(?![\\p{L}\\p{N}_])';
    let re;
    try { re = new RegExp(src, 'giu'); } catch (e) { continue; }
    out.push({ entry: line, re, wordEnd: wordEnd || starEnd });
    if (out.length >= AUTO_REROLL_MAX_ENTRIES) break;
  }
  return out;
}

/**
 * The first off-limits word in text at or after `from`, or null:
 * { entry, match, index }. `streaming` holds back a word that ends at the
 * very end of the text, which the next characters may yet extend.
 */
function findOffLimitsWord(text, matchers, from = 0, streaming = false) {
  text = String(text || '');
  let best = null;
  for (const m of matchers || []) {
    m.re.lastIndex = Math.max(0, from);
    let hit;
    while ((hit = m.re.exec(text)) !== null) {
      if (!hit[0]) { m.re.lastIndex++; continue; }
      const end = hit.index + hit[0].length;
      if (streaming && m.wordEnd && end >= text.length) break;
      if (!best || hit.index < best.index) best = { entry: m.entry, match: hit[0], index: hit.index };
      break;
    }
  }
  return best;
}

/** The card's rule for this turn, or null when it has none. */
function autoRerollRule(card) {
  if (!card || card.autoRerollEnabled !== true) return null;
  const matchers = autoRerollMatchers(card.autoRerollWords);
  if (!matchers.length) return null;
  let max = parseInt(card.autoRerollMax, 10);
  if (!isFinite(max)) max = AUTO_REROLL_MAX_DEFAULT;
  max = Math.min(AUTO_REROLL_MAX_CEIL, Math.max(1, max));
  // Temperature 0 writes the same reply every time: a reroll could only
  // repeat the hit, so the reply is checked and kept, never rerolled.
  const t = Number(card.temperature);
  const deterministic = card.temperature !== undefined && isFinite(t) && t <= 0;
  return { matchers, max: deterministic ? 0 : max, deterministic };
}

/* The turn being checked. One at a time, as generations are; kept here and
   not on the message, so nothing of it is ever saved or synced. */
let _autoRerollTurn = null;   // { msg, rule, armed, scan, hit }

/** Called by the stream feeder after every delta. True once a hit has
 *  stopped this reply: the feeder stops feeding it. */
function maybeAutoReroll(msg) {
  const t = _autoRerollTurn;
  if (!t || t.msg !== msg) return false;
  if (t.hit) return true;
  if (!t.armed) return false;
  // A reply that has run a tool is not rerolled: that would run it again.
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) return false;
  const text = msg.content || '';
  if (t.scan > text.length) t.scan = text.length;   // the smart limit cut it
  const from = Math.max(0, t.scan - AUTO_REROLL_MAX_ENTRY_CHARS * 2);
  const hit = findOffLimitsWord(text, t.rule.matchers, from, true);
  t.scan = text.length;
  if (!hit) return false;
  t.hit = hit;
  if (msg._parseState) msg._parseState.pending = '';
  console.log('[auto-reroll] the reply used "' + hit.match + '" (' + hit.entry + '); stopping it to write it again');
  stopGeneration({ keepChain: true, autoReroll: true });
  return true;
}

/** True while a hit has frozen this reply (the job poll keeps draining). */
function autoRerollFrozen(msg) {
  return !!(_autoRerollTurn && _autoRerollTurn.msg === msg && _autoRerollTurn.hit);
}

/* Set by stopGeneration for any stop that is not the reroll's or the smart
   limit's own -- the Stop button, the runtime limit -- so a reroll never
   starts after one. */
let _genStopRequested = false;

/** Put a reply back to empty for the next try. */
function _resetForReroll(thread, msg) {
  msg.content = '';
  msg.reasoning = '';
  for (const f of ['smartCapped', '_smartLimitAt', '_parseState', 'toolCalls', 'toolPrefix', '_pendingToolCalls', '_finishReason']) delete msg[f];
  try {
    if (thread && typeof state !== 'undefined' && thread.id === state.activeThreadId) {
      renderMessages();
      if (typeof scrollPinnedToBottom !== 'undefined' && scrollPinnedToBottom) scrollToBottom();
    }
  } catch (e) {}
}

/**
 * runGenerationWithTools, with the card's Auto Reroll around it. Same
 * arguments and result. Leaves msg.autoReroll = { rerolls, words, kept }
 * when it rerolled or kept a reply that still uses a word: words are the
 * off-limits words as the model wrote them, up to five.
 */
async function runGenerationWithReroll(thread, assistantMsg, requestBody, opts = {}) {
  opts = opts || {};
  const card = opts.card || ((typeof getActiveCard === 'function') ? getActiveCard() : null);
  delete assistantMsg.autoReroll;
  const rule = autoRerollRule(card);
  _genStopRequested = false;
  if (!rule) return runGenerationWithTools(thread, assistantMsg, requestBody, opts);

  const words = [];
  let rerolls = 0;
  try {
    for (;;) {
      const lastTry = rerolls >= rule.max;
      _autoRerollTurn = { msg: assistantMsg, rule, armed: !lastTry, scan: 0, hit: null };
      const outcome = await runGenerationWithTools(thread, assistantMsg, requestBody, opts);
      let hit = _autoRerollTurn.hit;
      _autoRerollTurn = null;

      const finished = !outcome.errored && (!outcome.aborted || assistantMsg.smartCapped || hit);
      if (!finished || _genStopRequested) {
        // Stopped by the user or the runtime limit, or failed: not ours to redo.
        if (hit && _genStopRequested) return Object.assign({}, outcome, { aborted: true });
        return outcome;
      }
      const usedTool = Array.isArray(assistantMsg.toolCalls) && assistantMsg.toolCalls.length > 0;
      if (!hit) {
        // A word the stream could not stop on: one that ended the reply, or
        // text the parser only gave to the reply at the end.
        finalizeStreamMessage(assistantMsg);
        hit = findOffLimitsWord(assistantMsg.content || '', rule.matchers, 0, false);
      }
      // The word as the model wrote it ("chuckled"), not the list's entry ("chuckl*").
      const said = hit ? String(hit.match).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40) : '';
      if (said && !words.includes(said)) words.push(said);
      if (!hit || lastTry || usedTool) {
        if (rerolls || hit) {
          assistantMsg.autoReroll = { rerolls, words: words.slice(0, 5) };
          if (hit) assistantMsg.autoReroll.kept = usedTool ? 'tool' : (rule.deterministic ? 'temperature' : 'tries');
        }
        if (hit && outcome.aborted && !assistantMsg.smartCapped) {
          // Cannot happen: the last try is never stopped. Belt and braces.
          return Object.assign({}, outcome, { aborted: false });
        }
        return outcome;
      }
      rerolls++;
      console.log('[auto-reroll] try ' + (rerolls + 1) + ' of ' + (rule.max + 1));
      try {
        showModelSwitchToast('Auto reroll: the reply used “' + hit.match + '”, writing it again (' + rerolls + ' of ' + rule.max + ')', 'info', 3000);
      } catch (e) {}
      _resetForReroll(thread, assistantMsg);
      // The stop that ended this try aborted the controller; the next try
      // needs its own, or the direct stream would end before it starts.
      if (typeof AbortController !== 'undefined') abortController = new AbortController();
      if (_genStopRequested) return { errored: false, aborted: true, errorMessage: null, errorObj: null, jobMode: false };
    }
  } finally {
    _autoRerollTurn = null;
  }
}

/* ---- The card editor's Auto Reroll box (chat.html, card-auto-reroll-*) ---- */

/** card.autoRerollMax, held to 1..10, 3 when unset. */
function autoRerollMaxOf(card) {
  const n = parseInt(card && card.autoRerollMax, 10);
  if (!isFinite(n)) return AUTO_REROLL_MAX_DEFAULT;
  return Math.min(AUTO_REROLL_MAX_CEIL, Math.max(1, n));
}

/** The line under the box: what it will do with what is in the editor. */
function updateAutoRerollNote() {
  const note = document.getElementById('card-auto-reroll-note');
  if (!note) return;
  const on = !!(document.getElementById('card-auto-reroll-enabled') || {}).checked;
  const words = autoRerollMatchers((document.getElementById('card-auto-reroll-words') || {}).value || '');
  const tries = autoRerollMaxOf({ autoRerollMax: (document.getElementById('card-auto-reroll-max') || {}).value });
  const temp = Number((document.getElementById('card-temperature') || {}).value);
  const n = words.length;
  const these = n === 1 ? 'this word' : 'these ' + n + ' words';
  const usesOne = n === 1 ? 'this word' : 'one of these ' + n + ' words';
  let text;
  if (!on) text = n ? 'Off: tick the box above to check replies for ' + these + '.' : '';
  else if (!n) text = 'On, but the list is empty, so nothing is checked.';
  else if (isFinite(temp) && temp <= 0) text = 'Temperature is 0, so every try would be the same reply: replies that use ' + usesOne + ' are marked, not written again. Raise Temperature above 0 to reroll.';
  else text = 'On: a reply that uses ' + usesOne + ' is written again, up to ' + tries + (tries === 1 ? ' more time.' : ' more times.');
  note.textContent = text;
}

/** ADD MY BANNED PHRASES: the Banned Phrases list, added to this one. */
function addBannedToAutoReroll() {
  const banned = document.getElementById('card-banned-phrases');
  const box = document.getElementById('card-auto-reroll-words');
  if (!banned || !box) return;
  const have = box.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const seen = new Set(have.map(l => l.toLowerCase()));
  let added = 0;
  for (const raw of banned.value.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    have.push(l);
    added++;
  }
  box.value = have.join('\n');
  updateAutoRerollNote();
  const note = document.getElementById('card-auto-reroll-note');
  if (note && !added) note.textContent = (banned.value.trim() ? 'Every Banned Phrase is already in this list. ' : 'Banned Phrases is empty. ') + note.textContent;
}

/** The pointer under Banned Phrases: bring the box into view. */
function goToAutoReroll() {
  const g = document.getElementById('card-auto-reroll-group');
  if (!g) return;
  try { g.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { g.scrollIntoView(); }
  const cb = document.getElementById('card-auto-reroll-enabled');
  try { if (cb) cb.focus({ preventScroll: true }); } catch (e) {}
}

/* ================================================================
   GENERATION TIMER
   Every AI reply records how long it took to generate (genMs on the
   message, shown as a ⏱ badge in its header). While a generation is
   in flight, a live ticking readout runs off genStartedAt — which is
   persisted, so a reload mid-generation resumes the clock honestly.
   For detached jobs the fileserver's own started_at/updated_at
   stamps are preferred: they stay correct even for replies that
   finished while the tab was closed.
================================================================ */
let _genTimerId = null;

function formatGenTime(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return '<1s';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const mnt = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return mnt + 'm ' + String(rem).padStart(2, '0') + 's';
}

function startGenTimerTicker() {
  stopGenTimerTicker();
  _genTimerId = setInterval(() => {
    const el = document.getElementById('gen-live-timer');
    if (!el) return;   // streaming thread not on screen — data keeps flowing, badge re-appears on switch-back
    const t0 = parseInt(el.dataset.t0, 10);
    if (t0) el.textContent = '\u23F1 ' + (formatGenTime(Date.now() - t0) || '0s');
  }, 1000);
}

function stopGenTimerTicker() {
  if (_genTimerId !== null) {
    clearInterval(_genTimerId);
    _genTimerId = null;
  }
}

/**
 * Byte-chunk consumer shared by BOTH transports (job polling and legacy
 * direct streaming). Owns the TextDecoder + partial-line buffer + the
 * throttled render/save ticks that used to be duplicated inline in
 * sendMessage and regenerateFromThread.
 *
 * The render tick is scoped to the job's own thread: background resumes
 * and mid-generation thread switches must never paint into whatever
 * thread happens to be on screen. (Data always went to the right message
 * object; the DOM writes were the loose end.)
 */
/**
 * Should a reply be painted as it arrives, or held until it is finished?
 *
 * This gates PAINTING, not the request. The transport keeps streaming in
 * both modes, deliberately, because three things in the chat path depend
 * on receiving tokens as they are produced:
 *
 *   1. The smart reply limit. maybeApplySmartLimit (this file) calls
 *      stopGeneration() the moment the estimate crosses the cap, and the
 *      chat request sends max_tokens: -1 -- so mid-stream cancellation is
 *      the ONLY thing bounding reply length. Ask llama-server for a
 *      non-streaming completion and the cap silently stops working: the
 *      model runs to EOS or fills the context, and the user waits for a
 *      long reply that then gets trimmed anyway.
 *   2. Partial progress. The ~2.5s saveState tick below, and the
 *      server-side job spool, both need bytes as they land. They are what
 *      make a reply survive a navigation or a Stop.
 *   3. The reveal itself. Held mode still ends with the same
 *      finalizeStreamMessage -> renderStreamingUpdate the streaming path
 *      uses, so a thinking model's reasoning is split from its content by
 *      exactly the same parser. Nothing about the output differs; only
 *      when it is shown.
 *
 * What the user asked for is not to WATCH the reply being written, and
 * that is entirely a rendering concern. So: keep the bytes, hold the
 * brush. Reads `!== false` so an older settings blob, or a corrupted one,
 * streams as every existing install already does.
 */
function shouldPaintWhileStreaming() {
  try {
    return !(state && state.settings && state.settings.streamReplies === false);
  } catch (e) {
    return true;
  }
}

function makeStreamFeeder(assistantMsg, thread) {
  const decoder = new TextDecoder();
  let lineBuf = '';
  let lastRender = 0, lastSave = 0, chunkCount = 0, firstLogged = false;
  const threadIsVisible = () => document.visibilityState !== 'hidden' && thread && thread.id === state.activeThreadId;
  // Resolved once per generation, not per chunk: flipping the toggle
  // mid-reply would otherwise reveal a half-written message, which is the
  // exact thing the setting exists to prevent. Whatever it was when the
  // turn started is what this turn honours.
  const paintLive = shouldPaintWhileStreaming();
  if (!paintLive) console.log('[stream] holding reply until complete (Reply Delivery: hold)');
  return {
    feed(bytes) {
      // Smart limit already cut this reply — freeze it. The job poll keeps
      // draining spooled bytes between our cancel and the server's ack (and
      // replays drain terminal transcripts fully); none of that may append
      // past the cut.
      if (assistantMsg.smartCapped || autoRerollFrozen(assistantMsg)) return;
      const text = decoder.decode(bytes, { stream: true });
      if (!text) return;
      if (!firstLogged) {
        console.log('[stream] First raw chunk:', JSON.stringify(text.slice(0, 500)));
        firstLogged = true;
      }
      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        chunkCount++;
        // Tool calls ride on the same lines as the text, in their own field.
        mergeToolCallDeltas(assistantMsg, extractToolCallDeltas(line));
        const result = extractTokenFromLine(line);
        if (result) {
          processStreamDelta(assistantMsg, result.text, result.field);
          // A group member's own name label comes off as it is written
          // (1.8.0, js/29-groups.js), rather than sitting there until the end.
          if (thread && thread.groupId && typeof groupLiveTrim === 'function') groupLiveTrim(assistantMsg, thread);
          // An off-limits word stops the reply here, to be written again.
          if (maybeAutoReroll(assistantMsg)) return;
          if (maybeApplySmartLimit(assistantMsg)) {
            // Content was truncated at the sentence end — repaint now so the
            // trimmed text (not the overshoot) is what stays on screen.
            // Skipped in held mode: nothing is on screen to correct, and the
            // caller's post-generation repaint shows the trimmed text anyway.
            if (paintLive && threadIsVisible()) renderStreamingUpdate(assistantMsg);
            return;
          }
        } else if (chunkCount <= 3) {
          console.log('[stream] Unparsed line ' + chunkCount + ':', JSON.stringify(line.trim().slice(0, 200)));
        }
      }
      const now = Date.now();
      if (paintLive && now - lastRender > 80 && threadIsVisible()) {
        renderStreamingUpdate(assistantMsg);
        lastRender = now;
      }
      // Persist partial progress locally every ~2.5s. Less load-bearing than
      // it used to be (the server-side spool is now the source of truth for
      // recovery), but it keeps the thread preview fresh and covers the
      // legacy direct path.
      if (now - lastSave > 2500) {
        saveState({ skipServerSchedule: true, thread });
        lastSave = now;
      }
    },
    // Parse any trailing partial line once the stream/transcript is complete.
    // SSE events are newline-terminated so this is almost always empty, but a
    // final unterminated JSON line (non-stream responses, abrupt closes) still
    // deserves a parse attempt rather than a console shrug.
    flush() {
      if (assistantMsg.smartCapped || autoRerollFrozen(assistantMsg)) { lineBuf = ''; return; }
      const tail = (lineBuf + decoder.decode()).trim();
      lineBuf = '';
      if (tail) {
        mergeToolCallDeltas(assistantMsg, extractToolCallDeltas(tail));
        const result = extractTokenFromLine(tail);
        if (result) {
          processStreamDelta(assistantMsg, result.text, result.field);
          if (!maybeAutoReroll(assistantMsg)) maybeApplySmartLimit(assistantMsg);
        }
      }
    },
    stats() { return { chunkCount }; }
  };
}

/**
 * Try to create a detached job. Returns the job id, or null when the relay
 * isn't available (file://, old fileserver) — callers then use the legacy
 * direct stream.
 */
async function startGenerationJob(thread, requestBody) {
  if (jobsAvailable === false) return null;
  // The user's runtime limit rides along so the server enforces it too, and it
  // still holds once this tab is closed (roadmap 1.7.7 #4). Off sends nothing,
  // and a job with no limit has none. A server older than 1.7.7 ignores the
  // parameter and keeps its fixed 30 minutes.
  const limitMin = (typeof cotTimeoutLimitMinutes === 'function') ? cotTimeoutLimitMinutes() : 0;
  const limitQS = limitMin > 0 ? `&max_runtime_s=${limitMin * 60}` : '';
  try {
    const r = await privacyFetch(`${JOBS_URL}?thread=${encodeURIComponent(thread.id)}${limitQS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    if (r.status === 404 || r.status === 405) {
      // Route doesn't exist: raw llama-server (file://) or a pre-jobs
      // PowerShell server. Remember and stop probing.
      jobsAvailable = false;
      console.log('[jobs] /llm/jobs not available — using legacy direct streaming');
      return null;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`job start failed: HTTP ${r.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
    }
    const j = await r.json();
    if (!j || !j.id) throw new Error('job start: malformed response');
    jobsAvailable = true;
    return j.id;
  } catch (err) {
    if (jobsAvailable === true) throw err;   // relay is known-good → surface the real error
    console.warn('[jobs] probe failed, falling back to direct stream this turn:', err.message);
    return null;                             // stays null → re-probe next send
  }
}

/**
 * Poll a job to a terminal state, feeding transcript bytes to `feeder`.
 * Never gives up on transient network errors alone (the whole point is
 * surviving flaky moments) — but ~30s of continuous unreachability returns
 * 'unreachable' so the UI can tell the user to reload-and-reattach.
 */
async function pollJobToCompletion(jobId, feeder, startOffset = 0) {
  let offset = startOffset;
  let idleDelay = 120;
  let consecutiveFailures = 0;
  while (true) {
    let r, j;
    try {
      r = await privacyFetch(`${JOBS_URL}/${encodeURIComponent(jobId)}?from=${offset}`, { cache: 'no-store' });
      if (r.status === 404) return { status: 'lost', offset };
      if (r.status === 401) return { status: 'unauthorized', offset };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= 50) return { status: 'unreachable', offset };
      await _wakeableSleep(600);   // 'online' / app-return cuts this short — retry the moment connectivity plausibly returns
      continue;
    }
    if (j.chunk_b64) {
      feeder.feed(_b64ToBytes(j.chunk_b64));
      offset = (typeof j.next === 'number') ? j.next : offset;
      idleDelay = 120;
    }
    const drained = (typeof j.size === 'number') ? (offset >= j.size) : !j.chunk_b64;
    if (j.status === 'running') {
      if (!drained) continue;                       // backlog: pull again immediately
      const cancelPending = currentJob && currentJob.id === jobId && currentJob.cancelSent;
      await _wakeableSleep(j.chunk_b64 ? 90 : (cancelPending ? 120 : Math.min(idleDelay += 40, 450)));
      continue;
    }
    if (!drained) continue;                         // terminal, but bytes remain — drain fully
    // started_at / updated_at ride along on the status file (updated_at is
    // stamped when the worker writes the terminal status) — hand them up so
    // the response timer stays accurate for jobs that finished while the
    // tab was away. Absent on pre-timing fileservers; callers fall back.
    return { status: j.status, error: j.error, offset,
             startedAt: (typeof j.started_at === 'number') ? j.started_at : null,
             updatedAt: (typeof j.updated_at === 'number') ? j.updated_at : null };
  }
}

/**
 * The shared generation transport. Streams one turn into `assistantMsg`,
 * via the job relay when available, else the legacy direct fetch. Pure
 * transport + parsing: finalizeStreamMessage(), isGenerating flips, scroll
 * settling, and chain logic stay with the callers.
 *
 * opts.resumeJobId — reattach to an existing job (skips the POST) and
 * replay/follow its transcript from opts.fromOffset (default 0).
 *
 * Returns { errored, aborted, errorMessage, errorObj, jobMode }.
 */
async function runGenerationStream(thread, assistantMsg, requestBody, opts = {}) {
  const feeder = makeStreamFeeder(assistantMsg, thread);
  let errored = false, aborted = false, errorMessage = null, errorObj = null;

  let jobId = opts.resumeJobId || null;
  if (!jobId && requestBody) {
    try {
      jobId = await startGenerationJob(thread, requestBody);
    } catch (err) {
      return { errored: true, aborted: false, errorMessage: err.message, errorObj: err, jobMode: true };
    }
  }

  if (jobId) {
    currentJob = { id: jobId, threadId: thread.id, cancelSent: false };
    // Breadcrumbs for resume-after-navigation. Persisted immediately: if the
    // user navigates one second from now, these are what boot follows back.
    assistantMsg.jobId = jobId;
    thread.pendingJob = { id: jobId, startedAt: Date.now() };
    saveState({ skipServerSchedule: true, thread });
    renderSidebar();   // surface the generating dot right away

    const res = await pollJobToCompletion(jobId, feeder, opts.fromOffset || 0);
    feeder.flush();

    if (res.status === 'cancelled') {
      aborted = true;
    } else if (res.status === 'error') {
      errored = true; errorMessage = res.error || 'generation failed upstream';
    } else if (res.status === 'interrupted') {
      errored = true; errorMessage = 'the file server restarted mid-generation';
    } else if (res.status === 'lost') {
      errored = true; errorMessage = 'generation record no longer on the server (restarted or cleaned up)';
    } else if (res.status === 'unauthorized') {
      // Same cause as a 401 on the sync routes: the server restarted and took
      // the session with it. Ask for the password here rather than telling
      // somebody to reload, which would also throw away whatever else they
      // had typed. See THE SERVER RESTARTED in 06-state-sync.js.
      errored = true; errorMessage = 'signed out mid-generation — sign back in to re-attach';
      try { noteLocked({ status: 401, url: JOBS_URL + '/' + jobId }); } catch (_) {}
    } else if (res.status === 'unreachable') {
      errored = true; errorMessage = 'lost contact with the file server mid-generation — the reply may still be completing; reload to re-attach';
    }

    // 'unreachable' keeps the breadcrumb ON PURPOSE: the job is likely still
    // running server-side and a reload should re-attach. Every other outcome
    // is terminal — clear the markers and ack so the spool gets cleaned up.
    if (res.status !== 'unreachable') {
      delete thread.pendingJob;
      delete assistantMsg.jobId;
      privacyFetch(`${JOBS_URL}/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
    }
    if (currentJob && currentJob.id === jobId) currentJob = null;
    return { errored, aborted, errorMessage, errorObj, jobMode: true,
             startedAt: res.startedAt || null, updatedAt: res.updatedAt || null };
  }

  // ── Legacy direct stream (file:// mode, or a fileserver without jobs) ──
  try {
    const resp = await privacyFetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: abortController ? abortController.signal : undefined
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`llama-server returned ${resp.status}: ${resp.statusText}` +
                      (detail ? ' — ' + detail.slice(0, 400) : ''));
    }
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feeder.feed(value);
    }
    feeder.flush();
  } catch (err) {
    if (err.name === 'AbortError') aborted = true;
    else { errored = true; errorMessage = err.message; errorObj = err; }
  }
  return { errored, aborted, errorMessage, errorObj, jobMode: false };
}

/**
 * Shared post-transport bookkeeping for aborts and errors. `style` picks the
 * error voice: 'diagnostic' (sendMessage's connection-triage block) or
 * 'plain'. One deliberate change from the old code: when tokens already
 * arrived, an error APPENDS a note instead of replacing the reply — a
 * mid-stream failure shouldn't vaporize three paragraphs of good text.
 */
function applyGenerationOutcome(assistantMsg, outcome, style) {
  // runGenerationWithTools explains a fallback here (the engine refused the
  // tools array). Stamped before any abort/error note, after the final text.
  if (outcome.note) {
    assistantMsg.content += `\n\n*(${outcome.note})*`;
  }
  if (outcome.aborted) {
    if (assistantMsg.smartCapped) {
      // Smart token limit trim — expected behavior, not an interruption.
      // The ✂ badge in the message header tells the story; a content note
      // would clutter every capped reply AND get fed back to the model as
      // part of the conversation on later turns.
      return;
    }
    if (_cotCulledFlag) {
      const mins = state.settings.cotTimeoutMinutes || 2;
      assistantMsg.content += `\n\n*(auto-stopped — runtime exceeded ${mins} min limit. If this happens often, raise the timer in CONFIG.)*`;
    } else {
      assistantMsg.content += '\n\n*(generation stopped)*';
    }
    return;
  }
  if (!outcome.errored) return;

  const hadText = !!((assistantMsg.content || '').trim() || (assistantMsg.reasoning || '').trim());
  if (hadText) {
    assistantMsg.content += `\n\n*(interrupted — ${outcome.errorMessage || 'generation failed'})*`;
    return;
  }
  // The model did not load (1.8.0, #67): say why, in plain words, rather than
  // the HTTP status the request got for it. attachLoadFailure read it from
  // /swap-status when the request failed.
  if (outcome.loadFailure) {
    assistantMsg.content = loadFailureText(outcome.loadFailure);
    return;
  }
  if (style === 'diagnostic') {
    const err = outcome.errorObj || { name: 'Error', message: outcome.errorMessage || 'generation failed' };
    let diag = `**Connection Error**\n\n`;
    diag += `**Error type:** ${err.name}\n**Message:** ${err.message}\n\n`;
    if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      diag += `**Likely cause:** llama-server is not running, or the page was opened directly.\n`;
      diag += `Open the chat at the address GobboNet prints when it starts, rather than opening chat.html itself. `;
      diag += `If you are already there, llama-server did not come up -- the landing page shows why.\n`;
    } else if ((err.message || '').includes('404')) {
      diag += `**Cause:** Endpoint not found. Make sure llama-server is running with --api-key disabled.\n`;
    }
    assistantMsg.content = diag;
  } else {
    assistantMsg.content = `**Error:** ${outcome.errorMessage || 'generation failed'}`;
  }
}


/* A failed request, when the model itself failed to load (1.8.0, #67).
   The request only says 502 or 503; /swap-status says why. Asked once,
   after the failure, and only when the server runs the model here. */
async function attachLoadFailure(outcome) {
  if (!outcome || !outcome.errored || !IS_SERVED || (typeof _remoteMode !== 'undefined' && _remoteMode)) return outcome;
  try {
    const r = await fetch('/swap-status', { cache: 'no-store' });
    if (r.ok) {
      const s = await r.json();
      if (s && s.phase === 'error' && (s.advice || s.message)) {
        outcome.loadFailure = { cause: String(s.cause || ''), advice: String(s.advice || ''), line: String(s.message || ''),
                                file: String(s.name || s.file || '') };
      }
    }
  } catch (e) { /* the plain error stays */ }
  return outcome;
}

/** The chat's words for a model that did not load. Markdown: the line is
 *  inline code, so it is shown as text whatever it holds. */
function loadFailureText(f) {
  const line = String(f.line || '').replace(/`/g, "'").slice(0, 400);
  const file = String(f.file || '').replace(/`/g, "'").slice(0, 255);
  let out = '**The model did not load.**' + (file ? ' (`' + file + '`)' : '');
  if (f.advice) out += ' ' + f.advice;
  if (line) out += '\n\nThe engine said: `' + line + '`';
  out += "\n\nThe engine's full log is llama-server.log in GobboNet's data folder; `gobbonet doctor` on the PC shows where.";
  return out;
}

/* ================================================================
   TOOL CALLS -- the loop around runGenerationStream

   A card's code can offer the model functions (gobbo.tool, 23-card-code.js).
   When the card's tools switch is on, the request carries them as the OpenAI
   `tools` array and llama-server (run with --jinja) parses the model's calls
   into `tool_calls` deltas, which makeStreamFeeder collects on the message as
   _pendingToolCalls. This loop runs the calls in the page, appends the
   assistant turn and one `tool` message per call to the request, and asks
   again, for up to toolMaxRounds rounds of calls (cardToolLimit, a setting
   since 1.8.0); one more request follows without `tools`, so the model has
   to answer in text.

   The extra messages are appended AFTER buildContextMessages: its
   normalizer drops `tool` roles and `tool_calls`, and putting them at the
   end also keeps the cached prompt prefix intact for llama-server.

   Without tool definitions this is exactly one runGenerationStream call.
================================================================ */
// Tool results are appended after the built context, outside the context
// budget. A reply's results together may add TOOL_RESULT_BUDGET_FACTOR times
// one result's limit (toolResultMaxChars): past that, the next request goes
// without `tools`, so the model has to answer with what it has instead of
// pushing the prompt past the context window. 3 x 8,000 is PR #71's 24,000.
const TOOL_RESULT_BUDGET_FACTOR = 3;

/** Join streamed tool_calls deltas onto the message, keyed by call index. */
function mergeToolCallDeltas(msg, delta) {
  if (!delta) return;
  if (delta.finishReason) msg._finishReason = delta.finishReason;
  if (!Array.isArray(delta.toolCalls) || !delta.toolCalls.length) return;
  const list = msg._pendingToolCalls || (msg._pendingToolCalls = []);
  for (const d of delta.toolCalls) {
    // llama-server tags every fragment with the call's index
    // (tools/server/server-chat.cpp). Without one, match the id, or treat a
    // fragment that names a function as a new call and anything else as a
    // continuation of the last one, so a server that omits the index still
    // cannot merge call 2's arguments into call 1.
    let call = (d.index != null) ? list.find(c => c.index === d.index) : null;
    if (!call && d.id) call = list.find(c => c.id === d.id);
    if (!call && d.index == null && !d.name && list.length) call = list[list.length - 1];
    if (!call) {
      call = { index: (d.index != null) ? d.index : list.length, id: null, name: null, arguments: '' };
      list.push(call);
    }
    if (d.id && !call.id) call.id = d.id;
    if (d.name && !call.name) call.name = d.name;
    if (d.arguments) call.arguments += d.arguments;
  }
}

/** Remove and return the collected calls as [{ id, name, arguments }]. */
function takePendingToolCalls(msg) {
  const list = Array.isArray(msg._pendingToolCalls) ? msg._pendingToolCalls : [];
  delete msg._pendingToolCalls;
  delete msg._finishReason;
  // Nine alphanumerics: the shape Mistral's v7 templates insist on, and one
  // every other template accepts, for a server that sent no id.
  const synth = () => (Math.random().toString(36).slice(2) + '000000000').replace(/[^a-z0-9]/g, '').slice(0, 9);
  return list.filter(c => c && c.name).map((c) => ({
    id: c.id || synth(),
    name: c.name,
    arguments: c.arguments || ''
  }));
}

/** llama-server's refusal when the engine runs without --jinja:
 *  "tools param requires --jinja flag" (tools/server/server-common.cpp),
 *  wrapped by the jobs relay as "upstream HTTP 400: {...}". Matched on the
 *  one phrase both refusals share, so an unrelated template error that
 *  happens to mention tools and jinja is not mistaken for it. */
function isNoJinjaError(message) {
  return /requires --jinja/i.test(String(message || ''));
}

/** Stop pressed since the round began (either transport). */
function toolLoopStopped() {
  if (abortController && abortController.signal && abortController.signal.aborted) return true;
  if (currentJob && currentJob.cancelSent) return true;
  return false;
}

/** Append tool-call records to the message; they are stored with it. */
function recordToolCalls(msg, recs) {
  if (!recs || !recs.length) return;
  if (!Array.isArray(msg.toolCalls)) msg.toolCalls = [];
  for (const r of recs) msg.toolCalls.push(r);
}

/**
 * Generate one reply, running the active card's tools as the model calls
 * them. Same signature and result as runGenerationStream, plus `note` when
 * the engine refused the tools array and the turn was retried without it.
 *
 * opts.card -- the card whose tools apply (default: the active card). The
 * tools themselves always come from cardToolDefs(card): there is no way to
 * hand this function a tools array, so the card's switch is the only gate.
 *
 * Consent is re-checked before every request and before any call runs. The
 * card can change under a running reply (activateCard has no generation
 * guard) and the box can be unticked mid-turn; either drops `tools` from the
 * next request and stops calls from running, and runCardTool refuses a call
 * whose card is no longer the one that owns the live registry.
 *
 * The text of completed rounds is kept on the message as `toolPrefix` while
 * a later round runs, so finalizeJobIntoThread can replay a reload onto it
 * instead of a blank message. It is removed when the loop ends.
 */
async function runGenerationWithTools(thread, assistantMsg, requestBody, opts = {}) {
  opts = opts || {};
  const card = opts.card || ((typeof getActiveCard === 'function') ? getActiveCard() : null);
  const tools = cardToolDefs(card);
  delete assistantMsg._pendingToolCalls;
  delete assistantMsg._finishReason;
  delete assistantMsg.toolPrefix;

  if (!tools.length) {
    const outcome = await runGenerationStream(thread, assistantMsg, requestBody, opts);
    takePendingToolCalls(assistantMsg);   // nothing to run them with; drop any strays
    return attachLoadFailure(outcome);
  }

  try {
    return await attachLoadFailure(await _runToolRounds(thread, assistantMsg, requestBody, opts, card, tools));
  } finally {
    delete assistantMsg.toolPrefix;
  }
}

async function _runToolRounds(thread, assistantMsg, requestBody, opts, card, tools) {
  const body = Object.assign({}, requestBody, {
    tools: tools,
    messages: (requestBody.messages || []).slice()
  });
  const signal = abortController ? abortController.signal : undefined;
  let outcome = null;
  // Where this round's text begins in the message: earlier rounds' text stays
  // on screen ahead of it, but only the round's own words are echoed back.
  let contentFrom = (assistantMsg.content || '').length;
  let reasoningFrom = (assistantMsg.reasoning || '').length;
  // Consent, re-read every time it matters. False once the box is unticked,
  // the code is switched off, or another card took over the registry.
  const consented = () => cardToolDefs(card).length > 0;
  let resultChars = 0;
  // Read once per reply, at its start: a change in CONFIG applies to the next.
  const requests = cardToolLimit('toolMaxRounds') + 1;
  const budget = TOOL_RESULT_BUDGET_FACTOR * cardToolLimit('toolResultMaxChars');

  for (let round = 1; round <= requests; round++) {
    if (round === requests) delete body.tools;   // the last word has to be text
    if (body.tools && resultChars > budget) {
      console.warn('[card-tool] tool results passed ' + budget + ' chars; asking without tools');
      delete body.tools;
    }
    if (body.tools && !consented()) {
      console.warn('[card-tool] consent withdrawn mid-reply; asking without tools');
      delete body.tools;
    }
    outcome = await runGenerationStream(thread, assistantMsg, body, opts);
    const finish = assistantMsg._finishReason || null;
    const calls = takePendingToolCalls(assistantMsg);

    if (round === 1 && outcome.errored && isNoJinjaError(outcome.errorMessage)) {
      console.warn('[card-tool] the engine refused the tools array (no --jinja); retrying without tools');
      delete body.tools;
      outcome = await runGenerationStream(thread, assistantMsg, body, opts);
      takePendingToolCalls(assistantMsg);
      return Object.assign({}, outcome, { note: "this model can't use tools: the engine runs it without --jinja" });
    }
    if (!body.tools) return outcome;   // none were offered this round; strays are dropped
    if (!calls.length || outcome.errored || outcome.aborted || assistantMsg.smartCapped) return outcome;
    if (toolLoopStopped()) return Object.assign({}, outcome, { aborted: true });
    if (finish === 'length') {
      // The reply was cut by the token limit, so the arguments may be too.
      // Running a half-formed call is worse than the cut the user can see.
      console.warn('[card-tool] reply cut by the token limit; not running ' + calls.length + ' unfinished call(s)');
      return outcome;
    }
    if (!consented()) {
      console.warn('[card-tool] consent withdrawn mid-reply; ' + calls.length + ' call(s) not run');
      return outcome;
    }

    // Settle this round's parser state, so the text that came with the calls
    // is final before it is echoed back and the next round parses cleanly.
    finalizeStreamMessage(assistantMsg);
    const fullText = assistantMsg.content || '';
    const roundText = fullText.slice(Math.min(contentFrom, fullText.length)).trim();
    const fullReasoning = assistantMsg.reasoning || '';
    const roundReasoning = fullReasoning.slice(Math.min(reasoningFrom, fullReasoning.length)).trim();

    const recs = [];
    for (const c of calls) {
      recs.push(await runCardTool(c.name, c.arguments, { signal: signal, cardId: card.id, thread: thread }));
    }
    recordToolCalls(assistantMsg, recs);
    for (const r of recs) resultChars += (r.result || '').length;
    if (toolLoopStopped()) return Object.assign({}, outcome, { aborted: true });

    const turn = {
      role: 'assistant',
      content: roundText,
      tool_calls: calls.map(c => ({ id: c.id, type: 'function',
                                    function: { name: c.name, arguments: c.arguments } }))
    };
    // Harmony (gpt-oss) and Qwen3 templates read the reasoning that led to a
    // tool call back from the assistant turn; templates that do not know the
    // field ignore it. Only this round's reasoning, like the text.
    if (roundReasoning) turn.reasoning_content = roundReasoning;
    body.messages.push(turn);
    calls.forEach((c, i) => {
      body.messages.push({ role: 'tool', tool_call_id: c.id, content: recs[i].result });
    });

    // The round's text stays on screen; the next round's continues below it.
    if (fullText) assistantMsg.content = fullText + '\n\n';
    if (assistantMsg.reasoning) assistantMsg.reasoning = assistantMsg.reasoning + '\n\n';
    contentFrom = (assistantMsg.content || '').length;
    reasoningFrom = (assistantMsg.reasoning || '').length;
    // What a reload mid-round replays onto (finalizeJobIntoThread), instead
    // of a blank message: the next job's transcript holds only its own round.
    assistantMsg.toolPrefix = { content: assistantMsg.content || '', reasoning: assistantMsg.reasoning || '' };
    console.log('[card-tool] round ' + round + ': ran ' + calls.length + ' call(s), asking again');
    try { saveState({ skipServerSchedule: true, thread: thread }); } catch (e) {}
    // Same anchor dance as the end of sendMessage: the rebuild resets
    // scrollTop, and a reader who scrolled up must not be yanked to the top.
    try {
      if (thread && state && thread.id === state.activeThreadId) {
        const anchor = captureScrollAnchor();
        renderMessages();
        settleScrollAfterGeneration(anchor);
      }
    } catch (e) {}
  }
  return outcome;
}

/* ================================================================
   THINKING FORMAT REGISTRY
   Each format describes how a model emits its chain-of-thought
   inside the raw content stream. Some servers pre-split reasoning
   into a separate field (handled above as field='reasoning'); this
   registry handles the case where reasoning arrives INLINE in
   field='content' and needs to be extracted client-side.

   Known formats:
     'none'     — no thinking; content is content. Llama, Mistral,
                  Phi, base Gemma 3 (without /think mode), etc.
     'deepseek' — <think>...</think> tags. The de-facto open-weights
                  standard. Covers DeepSeek-R1, Qwen3 thinking, QwQ,
                  GLM-4.5/4.6 thinking, Hunyuan thinking, Granite
                  thinking, and most reasoning distills. Some chat
                  templates force-open <think> in the prompt, so
                  the model's output may start with reasoning and
                  only emit </think> — we detect that case too.
     'harmony'  — gpt-oss channels:
                  <|channel|>analysis<|message|>...<|end|>
                  <|start|>assistant<|channel|>final<|message|>...
                  Used by gpt-oss-20b and gpt-oss-120b.
     'gemma'    — Gemma's <channel|> marker. Mostly historical now
                  that llama.cpp routes Gemma reasoning into the
                  reasoning_content field automatically; kept for
                  backward compatibility with existing chats.

   Aliases (so users typing the older or vendor name still works):
     'qwen', 'qwen3', 'r1', 'reasoning', 'think', 'think_tags' -> 'deepseek'
     'gpt-oss', 'gpt_oss', 'oss', 'openai', 'channels' -> 'harmony'
     '' / null / undefined -> 'none'
================================================================ */
const THINKING_FORMAT_ALIASES = {
  '': 'none', 'off': 'none', 'plain': 'none',
  'qwen': 'deepseek', 'qwen3': 'deepseek',
  'r1': 'deepseek', 'reasoning': 'deepseek',
  'think': 'deepseek', 'think_tags': 'deepseek',
  'thinking': 'deepseek',
  'gpt-oss': 'harmony', 'gpt_oss': 'harmony', 'gptoss': 'harmony',
  'oss': 'harmony', 'openai': 'harmony', 'channels': 'harmony'
};

function normalizeThinkingFormat(fmt) {
  const k = (fmt || 'none').toLowerCase();
  if (k in THINKING_FORMAT_ALIASES) return THINKING_FORMAT_ALIASES[k];
  if (['none', 'deepseek', 'harmony', 'gemma'].includes(k)) return k;
  return 'none';
}

/**
 * Returns the largest prefix of `text` we can safely flush WITHOUT
 * accidentally cutting a marker in half. Holds back up to (marker.length-1)
 * trailing chars in case a marker is mid-stream.
 */
function safeFlushLength(text, markers) {
  // Find the longest possible partial-match suffix across all markers
  let holdBack = 0;
  for (const marker of markers) {
    if (!marker) continue;
    const maxCheck = Math.min(marker.length - 1, text.length);
    for (let n = maxCheck; n > holdBack; n--) {
      if (text.slice(text.length - n) === marker.slice(0, n)) {
        holdBack = n;
        break;
      }
    }
  }
  return Math.max(0, text.length - holdBack);
}

/**
 * Per-message stream parser. Maintains state on msg._parseState,
 * routes reasoning vs content into msg.reasoning / msg.content based
 * on the active thinking format.
 *
 * Call from the streaming loop for every (text, field) extracted.
 *
 * field='reasoning' is trusted as-is (server pre-extracted it).
 * field='content' is parsed according to the format.
 */
function processStreamDelta(msg, deltaText, field) {
  if (!deltaText) return;
  const fmt = normalizeThinkingFormat(activeModel && activeModel.thinkingFormat);

  // Initialize per-message state on first delta
  if (!msg._parseState) {
    msg._parseState = {
      // 'pre'       — haven't decided yet (deepseek/gemma: tokens may be implicit-think)
      // 'thinking'  — buffering into msg.reasoning
      // 'content'   — buffering into msg.content
      // 'between'   — harmony only: between channels
      phase: (fmt === 'deepseek' || fmt === 'harmony' || fmt === 'gemma') ? 'pre' : 'content',
      pending: '',
      // Where this parse began. Both are 0 for a fresh reply; a later tool
      // round (runGenerationWithTools) parses onto a message that already
      // holds the earlier rounds' text, and finalizeStreamMessage's
      // implicit-think give-up must judge only what this round added.
      contentAtStart: (msg.content || '').length,
      reasoningAtStart: (msg.reasoning || '').length
    };
  }
  const state = msg._parseState;

  // Server already routed this as reasoning — trust it.
  if (field === 'reasoning') {
    msg.reasoning = (msg.reasoning || '') + deltaText;
    // Once we've seen any server-side reasoning, we know subsequent
    // 'content' tokens are the final answer. Skip inline parsing.
    state.serverSplit = true;
    state.phase = 'thinking_done';
    return;
  }

  // field === 'content'
  if (state.serverSplit || fmt === 'none') {
    msg.content += deltaText;
    return;
  }

  // Inline parser based on format
  state.pending += deltaText;
  if (fmt === 'deepseek')      processDeepseekStream(msg, state);
  else if (fmt === 'harmony')  processHarmonyStream(msg, state);
  else if (fmt === 'gemma')    processGemmaStream(msg, state);
  else { msg.content += state.pending; state.pending = ''; }
}

/**
 * deepseek-style: <think>...</think>
 * Handles both explicit (model emits both tags) and implicit (chat
 * template force-opens <think>, so model only emits </think>) cases.
 */
function processDeepseekStream(msg, state) {
  const OPEN  = '<think>';
  const CLOSE = '</think>';
  const markers = [OPEN, CLOSE];

  // Loop because a single delta may close one phase and open another
  while (state.pending) {
    if (state.phase === 'pre') {
      // Look for whichever marker comes first
      const openIdx  = state.pending.indexOf(OPEN);
      const closeIdx = state.pending.indexOf(CLOSE);

      // Found explicit <think> — anything before it is content
      if (openIdx >= 0 && (closeIdx < 0 || openIdx < closeIdx)) {
        if (openIdx > 0) msg.content += state.pending.slice(0, openIdx);
        state.pending = state.pending.slice(openIdx + OPEN.length);
        state.phase = 'thinking';
        continue;
      }

      // Found </think> first → implicit thinking (open tag was in prompt)
      if (closeIdx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, closeIdx);
        state.pending = state.pending.slice(closeIdx + CLOSE.length);
        state.phase = 'content';
        continue;
      }

      // No markers found yet. To allow live streaming of the implicit-
      // thinking case, route 'pre' tokens to reasoning provisionally.
      // If we never see </think>, finalizeStreamMessage() reparents
      // anything mistakenly classified as reasoning back to content.
      const safe = safeFlushLength(state.pending, markers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      // Once we've buffered enough without seeing any tag, give up
      // and switch to content — this is a non-thinking model masquerading
      // as one (or thinking was disabled).
      if ((msg.reasoning || '').length > 64 && !state.pending.includes('<')) {
        msg.content += msg.reasoning;
        msg.reasoning = '';
        state.phase = 'content';
        continue;
      }
      break;
    }

    if (state.phase === 'thinking') {
      const closeIdx = state.pending.indexOf(CLOSE);
      if (closeIdx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, closeIdx);
        state.pending = state.pending.slice(closeIdx + CLOSE.length);
        state.phase = 'content';
        continue;
      }
      const safe = safeFlushLength(state.pending, [CLOSE]);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    if (state.phase === 'content') {
      // After </think> we still strip stray <think> if a model loops
      const openIdx = state.pending.indexOf(OPEN);
      if (openIdx >= 0) {
        msg.content += state.pending.slice(0, openIdx);
        state.pending = state.pending.slice(openIdx + OPEN.length);
        state.phase = 'thinking';
        continue;
      }
      const safe = safeFlushLength(state.pending, [OPEN]);
      if (safe > 0) {
        msg.content += state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }
    break;
  }
}

/**
 * harmony (gpt-oss): channels separated by Harmony tokens.
 *   <|channel|>analysis<|message|>...<|end|>
 *   <|start|>assistant<|channel|>final<|message|>...
 *   <|return|>
 * The 'commentary' channel (tool calls) is folded into reasoning so
 * users can see it but it doesn't pollute the main response.
 */
function processHarmonyStream(msg, state) {
  // Markers we care about. The set of literal sequences that may appear
  // mid-stream — used both for matching and for safe-flush hold-back.
  const ANALYSIS_OPEN  = '<|channel|>analysis<|message|>';
  const FINAL_OPEN     = '<|channel|>final<|message|>';
  const COMMENT_OPEN   = '<|channel|>commentary<|message|>';
  const END            = '<|end|>';
  const RETURN         = '<|return|>';
  const START          = '<|start|>';
  const allMarkers = [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN, END, RETURN, START,
                      '<|channel|>', '<|message|>'];

  const findFirst = (haystack, needles) => {
    let bestIdx = -1, bestNeedle = null;
    for (const n of needles) {
      const i = haystack.indexOf(n);
      if (i >= 0 && (bestIdx < 0 || i < bestIdx)) { bestIdx = i; bestNeedle = n; }
    }
    return { idx: bestIdx, needle: bestNeedle };
  };

  while (state.pending) {
    if (state.phase === 'pre') {
      // Skip until first channel marker. Anything before it (preamble,
      // role tokens, etc.) is dropped.
      const m = findFirst(state.pending, [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = (m.needle === FINAL_OPEN) ? 'content' : 'thinking';
        continue;
      }
      // Hold back tail in case marker is mid-stream
      const safe = safeFlushLength(state.pending, allMarkers);
      // Drop the safe portion (it's pre-stream noise like role headers)
      state.pending = state.pending.slice(safe);
      break;
    }

    if (state.phase === 'thinking') {
      // End thinking on <|end|>, <|return|>, or transition to final/commentary
      const m = findFirst(state.pending, [END, RETURN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, m.idx);
        state.pending = state.pending.slice(m.idx + m.needle.length);
        if (m.needle === FINAL_OPEN)        state.phase = 'content';
        else if (m.needle === COMMENT_OPEN) state.phase = 'thinking'; // stay
        else                                 state.phase = 'between'; // <|end|>
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    if (state.phase === 'between') {
      // After <|end|>, look for next channel marker
      const m = findFirst(state.pending, [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        // Drop everything before (it's role/start tokens)
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = (m.needle === FINAL_OPEN) ? 'content' : 'thinking';
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      state.pending = state.pending.slice(safe);
      break;
    }

    if (state.phase === 'content') {
      const m = findFirst(state.pending, [END, RETURN]);
      if (m.idx >= 0) {
        msg.content += state.pending.slice(0, m.idx);
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = 'done';
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      if (safe > 0) {
        msg.content += state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    // 'done' or unknown — drop the rest
    state.pending = '';
    break;
  }
}

/**
 * Gemma channel format: <channel|> separates reasoning from final.
 * Mostly handled by the server-side jinja reasoning extractor (which
 * routes Gemma reasoning into the reasoning_content field), but kept
 * as a fallback for when a user runs without --reasoning-format gemma
 * and the marker arrives inline in content.
 */
function processGemmaStream(msg, state) {
  const MARKER = '<channel|>';
  const HEADER = '<|channel>thought';
  const markers = [MARKER, HEADER];

  while (state.pending) {
    if (state.phase === 'pre' || state.phase === 'thinking') {
      // Strip optional header tag at start
      if (state.pending.startsWith(HEADER)) {
        state.pending = state.pending.slice(HEADER.length).replace(/^\n/, '');
        state.phase = 'thinking';
        continue;
      }
      const idx = state.pending.indexOf(MARKER);
      if (idx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, idx);
        state.pending = state.pending.slice(idx + MARKER.length);
        state.phase = 'content';
        continue;
      }
      const safe = safeFlushLength(state.pending, markers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      // Implicit-thinking give-up: if we've buffered a fair amount in 'pre'
      // and there's no '<' anywhere in pending, this isn't a Gemma channel
      // stream — reparent reasoning -> content.
      if (state.phase === 'pre' && (msg.reasoning || '').length > 64 && !state.pending.includes('<')) {
        msg.content += msg.reasoning;
        msg.reasoning = '';
        state.phase = 'content';
        continue;
      }
      break;
    }
    // content phase
    msg.content += state.pending;
    state.pending = '';
    break;
  }
}

/* ================================================================
   TOOL-CALL ENVELOPE UNWRAP

   Some models — most notably Meta's Llama 3.x, whose embedded chat
   template advertises tool/function calling — reply to ordinary chat
   by wrapping the plain text in a JSON "function call" envelope
   instead of just speaking. A bare "hello" comes back as:

       {"name": "print", "parameters": {"s": "Hello, friend!"}}

   A request carries a `tools` array only when the active card offers
   tools (runGenerationWithTools); otherwise llama-server has no tool
   schema to bind this to, leaves the JSON verbatim in `content`, and it
   renders in the chat box as raw JSON. This unwraps that envelope back
   to the human-facing text ("Hello, friend!"). It is separate from real
   tool calls, which arrive parsed in `tool_calls` and never in content.

   It is deliberately strict: it only fires when the ENTIRE message is
   a single such envelope, so a normal reply that merely happens to
   contain JSON is never altered. On any non-matching input it returns
   the original text unchanged (a true no-op), which keeps every other
   model's output untouched.
================================================================ */

// Argument keys that, when present, hold the text the model meant to "say".
// Covers the common shapes across Llama/Mistral/generic tool templates.
const TOOLCALL_TEXT_KEYS = [
  's', 'text', 'content', 'message', 'response',
  'output', 'answer', 'reply', 'value', 'say', 'msg'
];

/**
 * If `raw` is exactly a single tool-call envelope wrapping plain text,
 * return that inner text. Otherwise return null (caller leaves text as-is).
 */
function extractToolCallText(raw) {
  if (!raw) return null;
  const t = raw.trim();
  // Must be a lone JSON object that constitutes the whole message.
  if (t.charAt(0) !== '{' || t.charAt(t.length - 1) !== '}') return null;
  // Cheap structural pre-check so we don't JSON.parse every message.
  if (!/"name"\s*:/.test(t)) return null;
  if (!/"(?:parameters|arguments)"\s*:/.test(t)) return null;

  let obj;
  try { obj = JSON.parse(t); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.name !== 'string') return null;

  let args = (obj.parameters != null) ? obj.parameters : obj.arguments;
  if (args == null) return null;
  // Some servers double-encode the arguments as a JSON string.
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { return args; } // plain string arg
  }
  if (typeof args === 'string') return args;
  if (typeof args !== 'object' || Array.isArray(args)) return null;

  // Prefer a recognized "say this" field.
  for (const k of TOOLCALL_TEXT_KEYS) {
    if (typeof args[k] === 'string') return args[k];
  }
  // Fallback: a single string-valued argument is almost certainly the text.
  const strVals = Object.keys(args)
    .map(k => args[k])
    .filter(v => typeof v === 'string');
  if (strVals.length === 1) return strVals[0];

  return null;
}

/** No-op-safe wrapper: returns unwrapped text, or the original if not an envelope. */
function unwrapToolCallText(raw) {
  const inner = extractToolCallText(raw);
  return (inner == null) ? raw : inner;
}

/**
 * Best-effort unwrap for the LIVE streaming view, where `raw` may be a
 * still-incomplete envelope (the closing braces haven't arrived yet).
 * Only engages once the content clearly opens with a tool-call envelope,
 * so normal replies stream exactly as before. While the inner string is
 * mid-stream we surface what we have so the user sees clean text building
 * up instead of raw JSON braces; finalizeStreamMessage() does the strict,
 * authoritative unwrap when the stream ends.
 */
function unwrapToolCallTextLive(raw) {
  if (!raw) return raw;
  const t = raw.trim();
  // Only intervene when this looks like a tool-call envelope from the start.
  if (!/^\{\s*"name"\s*:/.test(t)) return raw;

  // If it's already complete and parseable, use the strict result.
  const strict = extractToolCallText(t);
  if (strict != null) return strict;

  // Partial: tolerantly pull the in-progress text value of the first
  // recognized key. Handles escaped quotes inside the string.
  const keyGroup = TOOLCALL_TEXT_KEYS.join('|');
  const m = t.match(new RegExp('"(?:' + keyGroup + ')"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (m) {
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }
  // Envelope opened but no text field yet — show nothing rather than braces.
  return '';
}

/**
 * Called once at end-of-stream to flush any held-back buffer and
 * scrub any stray markers that slipped through (e.g., truncated
 * stream where the model never emitted a closing tag).
 */
function finalizeStreamMessage(msg) {
  const fmt = normalizeThinkingFormat(activeModel && activeModel.thinkingFormat);
  const state = msg._parseState;
  if (state) {
    // Flush any pending bytes to the bucket we were last in
    if (state.pending) {
      if (state.phase === 'thinking' || state.phase === 'pre') {
        msg.reasoning = (msg.reasoning || '') + state.pending;
      } else {
        msg.content += state.pending;
      }
      state.pending = '';
    }

    // Implicit-think give-up: in 'pre' phase for deepseek/gemma, we routed
    // tokens to reasoning provisionally. If we never saw the close marker
    // AND we never collected anything to content, treat this as a non-thinking
    // model and reparent reasoning -> content.
    const cAt = state.contentAtStart || 0, rAt = state.reasoningAtStart || 0;
    if ((fmt === 'deepseek' || fmt === 'gemma') && state.phase === 'pre' &&
        (msg.content || '').length === cAt && (msg.reasoning || '').length > rAt) {
      msg.content = (msg.content || '') + msg.reasoning.slice(rAt);
      msg.reasoning = msg.reasoning.slice(0, rAt);
    }
  }

  // Scrub stray markers (per format)
  if (msg.reasoning) {
    if (fmt === 'gemma') {
      msg.reasoning = msg.reasoning
        .replace(/^<\|channel>thought\n?/i, '')
        .replace(/<channel\|>\s*$/i, '');
    } else if (fmt === 'deepseek') {
      msg.reasoning = msg.reasoning
        .replace(/^<think>\s*/i, '')
        .replace(/<\/think>\s*$/i, '');
    } else if (fmt === 'harmony') {
      msg.reasoning = msg.reasoning
        .replace(/<\|(?:end|return|start|message|channel)\|>/g, '');
    }
    msg.reasoning = msg.reasoning.trim();
  }
  if (msg.content) {
    if (fmt === 'gemma') {
      msg.content = msg.content.replace(/^<channel\|>\s*/i, '');
    } else if (fmt === 'deepseek') {
      msg.content = msg.content
        .replace(/^<\/think>\s*/i, '')
        .replace(/^<think>[\s\S]*?<\/think>\s*/i, ''); // belt+suspenders
    } else if (fmt === 'harmony') {
      msg.content = msg.content
        .replace(/<\|(?:end|return|start|message|channel)\|>/g, '');
    }
    msg.content = msg.content.trim();

    // Llama 3.x (and similar) sometimes wrap a plain reply in a JSON
    // function-call envelope, e.g. {"name":"print","parameters":{"s":"Hi"}}.
    // Unwrap it back to the human-facing text. No-op on normal replies.
    msg.content = unwrapToolCallText(msg.content).trim();
  }

  delete msg._parseState;
}

/**
 * DIAGNOSTIC: Make a raw non-streaming request and dump the full response.
 * Run from browser console:  testRawResponse("Hello")
 *
 * Useful for debugging thinking-token formats — shows whether the server
 * is splitting reasoning into reasoning_content (preferred) or leaving
 * it inline in content with raw markers we then need to parse.
 */
async function testRawResponse(prompt) {
  console.log('=== RAW RESPONSE TEST ===');
  console.log('Active model:', activeModel.name, '— format:', normalizeThinkingFormat(activeModel.thinkingFormat));
  try {
    const resp = await fetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getRequestModelName(),
        messages: [{ role: 'user', content: prompt || 'Say hello in one sentence.' }],
        stream: false
      })
    });
    const raw = await resp.text();
    console.log('HTTP', resp.status, '— Full response:');
    console.log(raw);
    try {
      const json = JSON.parse(raw);
      if (json.choices && json.choices[0] && json.choices[0].message) {
        const m = json.choices[0].message;
        const content = m.content || '';
        const reasoning = m.reasoning_content || m.reasoning || '';
        console.log('--- message.content:', JSON.stringify(content));
        console.log('--- message.reasoning_content:', JSON.stringify(reasoning));
        // Probe for known thinking markers in either field
        const probes = {
          'deepseek <think>':   /<think>/.test(content) || /<think>/.test(reasoning),
          'deepseek </think>':  /<\/think>/.test(content) || /<\/think>/.test(reasoning),
          'harmony <|channel|>': /<\|channel\|>/.test(content) || /<\|channel\|>/.test(reasoning),
          'gemma <channel|>':    /<channel\|>/.test(content)   || /<channel\|>/.test(reasoning)
        };
        for (const [k, v] of Object.entries(probes)) console.log('---', k, ':', v);
      }
    } catch (e) {}
  } catch (e) { console.error('Fetch failed:', e); }
  console.log('=== END TEST ===');
}

