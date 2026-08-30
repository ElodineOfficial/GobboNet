/* @gobbonet-split js/07-prompt.js
   Moved verbatim from chat.html lines 4864-5499.
   carousel, greetings, token estimation, lore, context build
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CAROUSEL PROMPT HELPERS
================================================================ */
function toggleCarouselBody() {
  const cb = document.getElementById('card-carousel-enabled');
  const body = document.getElementById('carousel-body');
  const label = document.getElementById('carousel-toggle-label');
  // Sync checkbox if clicked on the row label (not the checkbox itself)
  // The checkbox fires its own onclick so we just read its current state
  const enabled = cb.checked;
  body.classList.toggle('open', enabled);
  label.classList.toggle('active', enabled);
  updateCarouselCounter(null);
}

function updateCarouselCounter(card) {
  const el = document.getElementById('carousel-counter');
  if (!el) return;
  // Read from editor fields (card may be null when called live)
  const raw = document.getElementById('card-carousel-prompts')?.value || '';
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) { el.textContent = ''; return; }
  const isSeq = document.getElementById('carousel-mode-sequential')?.checked;
  const idx = card ? (card.carouselIndex || 0) : 0;
  if (isSeq) {
    el.textContent = `${lines.length} line${lines.length !== 1 ? 's' : ''} — next: line ${(idx % lines.length) + 1}`;
  } else {
    el.textContent = `${lines.length} line${lines.length !== 1 ? 's' : ''} — selected randomly each turn`;
  }
}

function resetCarouselIndex() {
  if (editingCardId) {
    const card = state.characterCards.find(c => c.id === editingCardId);
    if (card) { card.carouselIndex = 0; saveState(); }
  }
  updateCarouselCounter(null);
}

/**
 * Pick the next carousel line for a card.
 * Mutates card.carouselIndex for sequential mode and saves state.
 * Returns the chosen line string, or null if carousel is off/empty.
 */
function pickCarouselLine(card) {
  if (!card || !card.carouselEnabled) return null;
  const raw = (card.carouselPrompts || '').trim();
  if (!raw) return null;
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  let chosen;
  if (card.carouselMode === 'sequential') {
    const idx = (card.carouselIndex || 0) % lines.length;
    chosen = lines[idx];
    card.carouselIndex = (idx + 1) % lines.length;
  } else {
    // Random — avoid repeating the last pick if possible
    const lastIdx = card._lastCarouselIdx;
    let pick;
    if (lines.length === 1) {
      pick = 0;
    } else {
      do { pick = Math.floor(Math.random() * lines.length); } while (pick === lastIdx);
    }
    chosen = lines[pick];
    card._lastCarouselIdx = pick;
  }
  return chosen;
}

/* ================================================================
   GREETING / ALT GREETINGS HELPERS

   A greeting is a designated opening message set verbatim on the
   card and injected into each new thread as the character's first
   assistant turn. The model never generates it — it's just stamped
   onto thread.messages at creation. Alt greetings are additional
   openings stored as variants on the same injected message so the
   ◀ ▶ navigator already used for rerolls works without any new UI.

   Storage: card.greeting is a single string; card.altGreetings is
   one raw textarea value, blank-line separated (mirrors how
   carouselPrompts is stored as raw newline-separated text). Parsing
   happens on use, not on save, so the user's exact formatting
   round-trips through edit sessions unchanged.
================================================================ */

/** Split the alt-greetings textarea on blank lines (one or more empty
 *  lines between entries). Trims surrounding whitespace and drops
 *  empty results. Multi-paragraph greetings are preserved as a single
 *  entry — separator is a fully blank line, not just a newline. */
function parseAltGreetings(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
}

/** Toggle the alt-greetings editor body open/closed. Mirrors the
 *  carousel toggle exactly — same CSS classes, same click pattern. */
function toggleAltGreetingsBody() {
  const cb = document.getElementById('card-alt-greetings-enabled');
  const body = document.getElementById('alt-greetings-body');
  const label = document.getElementById('alt-greetings-toggle-label');
  if (!cb || !body || !label) return;
  const enabled = cb.checked;
  body.classList.toggle('open', enabled);
  label.classList.toggle('active', enabled);
  updateAltGreetingsCounter();
}

/** Live count of how many variants the next new thread will get.
 *  Counts the primary greeting field + each blank-line-separated
 *  entry in the alts textarea. */
function updateAltGreetingsCounter() {
  const el = document.getElementById('alt-greetings-counter');
  if (!el) return;
  const raw = document.getElementById('card-alt-greetings')?.value || '';
  const alts = parseAltGreetings(raw);
  if (alts.length === 0) { el.textContent = ''; return; }
  const greetingFilled = !!(document.getElementById('card-greeting')?.value || '').trim();
  const total = (greetingFilled ? 1 : 0) + alts.length;
  el.textContent = `${alts.length} alt${alts.length !== 1 ? 's' : ''} \u2014 ${total} total opening${total !== 1 ? 's' : ''} per new thread`;
}

/** Push the card's greeting (plus any alt greetings as flippable
 *  variants) onto a freshly-created thread as its first assistant
 *  message. No-op if the card has no greeting and alts are disabled
 *  / empty. The variant data shape (msg.variants / msg.activeVariant)
 *  is the exact one used by rerolls, so the existing ◀ N/M ▶
 *  navigator picks it up with no rendering changes. */
function injectGreeting(thread, card) {
  if (!card) return;
  const persona = getActivePersona();
  const charName = card.name || 'Assistant';
  const userName = persona.name || 'Anonymous';

  const primary = (card.greeting || '').trim();
  const alts = card.altGreetingsEnabled
    ? parseAltGreetings(card.altGreetings || '')
    : [];

  // Nothing on either side — leave the thread empty so the welcome
  // screen renders as it always has.
  if (!primary && alts.length === 0) return;

  // Assemble the visible list. The primary slot may be empty (user
  // only filled out alts) — in that case the first alt becomes the
  // default and we never show an empty bubble.
  const all = [];
  if (primary) all.push(primary);
  for (const a of alts) all.push(a);

  // Resolve {{char}} / {{user}} / macros at injection time so the
  // stored content is final and matches the convention used by every
  // other persistent message in the app.
  const resolved = all.map(g => translateTemplates(g, charName, userName));

  const ts = Date.now();
  const msg = {
    role: 'assistant',
    content: resolved[0],
    timestamp: ts,
    // The greeting is this card's words, verbatim from its own field. Stamp
    // it so it keeps that face if the user later switches characters.
    cardId: card.id
  };

  // Multiple openings? Promote to the variants shape. Single greeting
  // stays as a plain message — no navigator clutter when there's
  // nothing to flip between.
  if (resolved.length > 1) {
    msg.variants = resolved.map(content => ({
      content,
      reasoning: '',
      timestamp: ts
    }));
    msg.activeVariant = 0;
  }

  thread.messages.push(msg);
}

/** Live "parsed N entities · M tags · K prose chunks" readout for the RAG
 *  Storybook field, so the author sees how their text was interpreted
 *  (structured vs prose) without guessing. Runs the same parser the
 *  retriever uses, so the counts match what actually fires. */
function updateStorybookReadout() {
  const el = document.getElementById('storybook-readout');
  if (!el) return;
  const raw = document.getElementById('card-rag-storybook')?.value || '';
  if (!raw.trim()) { el.textContent = ''; return; }
  let parsed;
  try { parsed = parseStorybook(raw); } catch (e) { el.textContent = 'parse error'; return; }
  const c = parsed.counts;
  const parts = [];
  parts.push(`${c.entities} ${c.entities === 1 ? 'entity' : 'entities'}`);
  if (c.subtrees) parts.push(`${c.subtrees} subtree${c.subtrees !== 1 ? 's' : ''}`);
  parts.push(`${c.tags} tag${c.tags !== 1 ? 's' : ''}`);
  parts.push(`${c.proseChunks} prose chunk${c.proseChunks !== 1 ? 's' : ''}`);
  el.textContent = 'parsed \u2192 ' + parts.join(' \u00b7 ');
}


function renderAvatar(avatarStr, name) {
  // Every avatar in the app funnels through here, including the per-message
  // render loop in 13-dashboard.js -- so this is the one place the remote-image
  // policy has to hold. safeImageUrl returns '' for anything not permitted,
  // and '' falls through to the initial rather than rendering an empty src.
  const src = safeImageUrl(avatarStr);
  if (src) return `<img src="${escapeHtml(src)}" alt="">`;
  // Fallback: first letter of name
  const initial = (name || '?').charAt(0).toUpperCase();
  return initial;
}

function previewAvatar(inputId, previewId) {
  const url = document.getElementById(inputId).value.trim();
  const preview = document.getElementById(previewId);
  const src = safeImageUrl(url);
  if (src) {
    preview.innerHTML = `<img src="${escapeHtml(src)}" alt="">`;
  } else if (isSuppressedRemoteImage(url)) {
    // Distinguish "blocked by your setting" from "not a picture" -- otherwise a
    // user pastes a perfectly good URL, sees '--', and assumes it is broken.
    preview.textContent = 'remote image \u2014 off in Settings';
  } else {
    preview.innerHTML = '--';
  }
}

function handleAvatarFile(fileInput, textInputId, previewId) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    document.getElementById(textInputId).value = dataUrl;
    // Locally chosen, but route it through the same gate and escape it: one
    // path for every image, no exceptions to remember. This was the only
    // avatar sink with no escaping at all.
    const src = safeImageUrl(dataUrl);
    document.getElementById(previewId).innerHTML =
      src ? `<img src="${escapeHtml(src)}" alt="">` : '--';
  };
  reader.readAsDataURL(file);
}

/* ================================================================
   TOKEN ESTIMATION
   Rough heuristic: 700 words ≈ 1000 tokens
================================================================ */
function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(words * (1000 / 700));
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '') + estimateTokens(m.reasoning || '') + 4;
    if (m.searchData) total += estimateTokens(m.searchData);
    if (m.attachmentText) total += estimateTokens(m.attachmentText);
  }
  return total;
}

/* ================================================================
   LORE SYSTEM
   Compresses older messages into a running summary.
   Keeps last 40 messages verbatim, everything else → lore.
================================================================ */
function getThreadLore(thread) {
  return (thread && thread.lore) || '';
}

function setThreadLore(thread, lore) {
  if (thread) thread.lore = lore;
}

/* Maximum chars we'll retain in lore. Beyond this we trim from the front
   on a sentence boundary so the most recent context is preserved. */
// Backstop only — the prompt targets ~180 words (roughly 1,100 chars), so
// this should never fire in normal operation. It exists to stop a model
// that ignores the word limit from letting lore accrete without bound.
// Lowered from 4000: at that size a runaway summary could occupy ~1,000
// tokens of context, which is most of what the rolling archive was
// supposed to free up in the first place.
const LORE_MAX_CHARS = 2400;

/**
 * Run one compression pass, on a different local model if the card asks for
 * one, and put the chat model back afterwards.
 *
 * llama.cpp holds a single model, and launch.bat runs it with --parallel 1
 * on purpose (see the note at launch.bat:1511 -- two differently-shaped
 * requests in flight churn the KV cache and force a full re-prefill). So
 * "compress on a different model" means borrowing the server for a pass,
 * not running a second one alongside it. Compression already blocks the
 * turn, which is what makes borrowing viable at all: nothing else is trying
 * to use the model while we have it.
 *
 * The cost is two model loads per pass and it is not hideable, so the card
 * editor says so plainly. Blank -- every card, until someone changes it --
 * skips all of this and behaves exactly as before.
 *
 * Failure policy, in order of what hurts the user least:
 *   - Can't borrow            -> compress on the chat model anyway. A worse
 *                                summary beats losing the messages, which is
 *                                what returning empty would do (08-rag.js
 *                                has already marked them archived).
 *   - Compression itself fails -> summarizeForLore's own handling applies;
 *                                the finally block still returns the model.
 *   - Can't give it back       -> loud. The user's chat model is not loaded
 *                                and every following turn would run on the
 *                                summariser without this saying so.
 */
async function compressWithCardModel(existingLore, toArchive, authored, tokenLimit, card) {
  const want = (card && card.loreModelFile ? String(card.loreModelFile) : '').trim();
  const have = (typeof _currentModelFile === 'string') ? _currentModelFile : '';

  // Nothing chosen, no file server to swap with, or it is already loaded.
  if (!want || !IS_SERVED || want === have) {
    return await summarizeForLore(existingLore, toArchive, authored, tokenLimit);
  }

  let borrowed = false;
  try {
    renderLoreIndicator('loading ' + want + ' to compress...');
    await swapToModelFile(want);
    borrowed = true;
  } catch (e) {
    console.warn('[lore] could not load the compression model "' + want
               + '" — falling back to the chat model for this pass:', e);
  }

  try {
    return await summarizeForLore(existingLore, toArchive, authored, tokenLimit);
  } finally {
    if (borrowed && have) {
      try {
        renderLoreIndicator('restoring ' + have + '...');
        await swapToModelFile(have);
      } catch (e) {
        // Nothing here can put it back, so make sure the user finds out
        // now rather than wondering why the character sounds wrong.
        console.error('[lore] FAILED to restore the chat model "' + have
                    + '" after compression. The summariser is still loaded.', e);
        _loreLastKind = 'failed';
        _loreLastOutcome = 'compression finished, but the chat model (' + have
          + ') could not be reloaded afterwards — ' + want + ' is still active. '
          + 'Pick your model again in the header dropdown.';
        if (typeof showModelSwitchToast === 'function') {
          showModelSwitchToast('Could not reload ' + have + ' — ' + want
            + ' is still active. Re-select your model in the header.', 'err', 0);
        }
      }
    }
    renderLoreIndicator('');
  }
}

/* Hard ceiling on a single compression pass. Compression is awaited by
   buildContextMessages, which sendMessage awaits, so this is also the
   longest the app can appear frozen before the user's turn goes through.
   Generous enough that a slow local model finishes normally; short enough
   that a stuck one is an inconvenience rather than a lockup. */
const LORE_TIMEOUT_MS = 45000;

/* Output budget for one compression pass.

   TARGET is what we ask for when there is room, and it is the old fixed
   value: 700 cut beats mid-word because max_tokens covers reasoning as
   well as content, and removing the cap let a looping model run to the
   end of the context. 2048 sits between those two failures and the
   reasoning behind it was never the problem.

   The problem was that it was an ABSOLUTE number inside a budget that is
   RELATIVE to how full the context already is. llama-server rejects a
   request when prompt_tokens + max_tokens > n_ctx, so on a nearly-full
   context the ask itself was what pushed it over and every pass came
   back 400.

   FLOOR is the smallest ask worth making. Below roughly this, a model
   that thinks before answering spends the whole allowance on reasoning
   and returns empty content -- which lands in the "model returned
   nothing at all" branch and looks like a different bug. If we cannot
   afford the floor we do not send the request at all.

   SAFETY covers the gap between our token estimate and the server's real
   tokeniser. estimateTokens is words x 1.43 and under-counts CJK, code,
   URLs and long identifiers, so the margin is deliberately wide. */
const LORE_OUTPUT_TARGET_TOKENS = 2048;
const LORE_OUTPUT_FLOOR_TOKENS  = 512;
const LORE_CTX_SAFETY_TOKENS    = 256;

/* The model server's REAL context window, cached briefly.

   Nothing else in the frontend knows this number. resolveContextLimit()
   reports the card's budget clamped to activeModel.maxCtx, and maxCtx is
   the model's TRAINING context -- 131072 for most of the registry --
   while llama-server may well have been started with --ctx-size 4096.
   Budgeting a request against the training figure is how you send a
   prompt that cannot fit and get the 400 this whole change exists to
   stop, so the only number worth having is the one the server reports.

   Deliberately does NOT fall back to n_ctx_train. gobboDiag() accepts it
   because it is displaying a fact; here it would silently reintroduce
   the exact overestimate above. If the server does not report n_ctx we
   return null and the caller falls back to the card's limit, which is at
   least a number the user chose.

   Cached on a short TTL rather than invalidated by hand. A model
   hot-swap (02-model.js) and a perf restart (savePerfSettings) both
   change n_ctx, and both take far longer than this window to complete,
   so a timer costs one small fetch per compression and needs no hooks in
   files this item has no business touching. A stale reading is survivable
   in a way a stale hook is not: the worst case is one pass budgeted
   against the old size, which now fails safely instead of hanging. */
let _loreServerCtx = null;
let _loreServerCtxAt = 0;
const LORE_CTX_TTL_MS = 60000;

async function getServerContextSize() {
  const now = Date.now();
  if (now - _loreServerCtxAt < LORE_CTX_TTL_MS) return _loreServerCtx;
  _loreServerCtxAt = now;
  if (!IS_SERVED) { _loreServerCtx = null; return null; }
  try {
    const r = await privacyFetch(LLAMA_URL + '/props', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = await r.json();
    const gen = p && p.default_generation_settings;
    const n = (gen && typeof gen.n_ctx === 'number') ? gen.n_ctx : null;
    _loreServerCtx = (n && n > 0) ? n : null;
  } catch (e) {
    // Server down, proxy 401, or an older llama-server that does not
    // report it. Not worth a console.error on a path that has a fallback.
    _loreServerCtx = null;
  }
  return _loreServerCtx;
}

/* Why the last compression pass produced what it did.
   summarizeForLore has three ways to give up -- a bad HTTP response, an
   empty parse, or a thrown error -- and all three returned the previous
   lore unchanged, which on screen is indistinguishable from "it ran and
   decided nothing needed adding". Four passes with nothing to show for
   them and no way to tell which branch fired is not a diagnosable state,
   so each one now records why. Read it in the lore inspector. */
let _loreLastOutcome = null;

/* Machine-readable companion to _loreLastOutcome.
     'ok'     -- a beat was written
     'skip'   -- the model correctly reported nothing worth recording
     'noroom' -- no context left to summarise in; messages were dropped
     'failed' -- the request errored, timed out, or produced nothing
   _loreLastOutcome stays a prose string because the lore inspector prints
   it verbatim. The caller needs to BRANCH on the result, and branching on
   prose means matching substrings, which breaks the first time someone
   rewords a message. */
let _loreLastKind = 'ok';

/**
 * Record, in the lore itself, that messages were dropped without being
 * summarised.
 *
 * This is the honest half of the hard-trim policy. buildContextMessages
 * marks messages .archived BEFORE awaiting this module, and nothing ever
 * un-marks them, so when a pass gives up those messages are already gone
 * from the model's context. Saying nothing leaves the model with a hole
 * it cannot see and will confabulate across; one line tells it there is
 * missing history at that point, which is the difference between a gap
 * and amnesia.
 *
 * Rolls the count into an existing marker rather than appending a new
 * one. Successive failures would otherwise fill the beat log with
 * near-identical lines and crowd out the actual story -- and the log is
 * capped at LORE_MAX_CHARS, so those lines would evict real beats.
 */
function _appendLoreGapMarker(existingLore, count) {
  const n = Math.max(1, count | 0);
  const prior = (existingLore || '').trim();
  const lines = prior ? prior.split('\n') : [];
  const last = lines.length ? lines[lines.length - 1] : '';
  const m = last.match(/^- \[(\d+) earlier messages? dropped without being summarised\.\]$/);
  const total = m ? (parseInt(m[1], 10) + n) : n;
  const marker = '- [' + total + ' earlier message' + (total === 1 ? '' : 's')
               + ' dropped without being summarised.]';
  if (m) lines[lines.length - 1] = marker;
  else lines.push(marker);
  return lines.join('\n');
}

/**
 * Reduce a model reply to one clean beat.
 *
 * Small models add labels, bullets, quotes and preamble no matter how
 * plainly the prompt forbids them, and when the reasoning-recovery path
 * fires we may be handed a whole chain-of-thought with the answer at the
 * end. Every one of those has to be stripped here, because whatever comes
 * out is appended permanently and read as fact by every later pass.
 */
function _cleanLoreBeat(text) {
  let t = (text || '').trim();
  if (!t) return '';

  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Two different multi-line shapes need opposite handling.
    //
    // A numbered or bulleted list means the model ignored "one beat" and
    // wrote several. Take the FIRST: it is the primary event, and taking
    // the last would quietly discard the most important one.
    //
    // Anything else is most likely a recovered chain-of-thought with the
    // answer at the end, so take the LAST.
    const isItem = (l) => /^([-*\u2022]|\d+[.)])\s/.test(l);
    const listish = lines.filter(isItem).length >= 2;
    t = listish ? lines.find(isItem) : lines[lines.length - 1];
  }

  t = t
    .replace(/^[-*\u2022\s]+/, '')                        // bullet
    .replace(/^\d+\s*[.)]\s*/, '')                        // "3. " / "3) " list number
    .replace(/^(beat|summary|note|entry|output)\s*[:\-]\s*/i, '')  // label
    .replace(/^\[|\]$/g, '')                              // wrapping brackets
    .replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, '') // wrapping quotes
    .trim();

  // Two sentences maximum. A model that ignores the word limit gets
  // trimmed rather than allowed to bloat the log one entry at a time.
  const sentences = t.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 2) {
    // Each captured sentence carries the leading space of the one before it,
    // so trim before joining or the result gets a double space in the middle.
    t = sentences.slice(0, 2).map(x => x.trim()).join(' ').trim();
  }

  // Deliberately NO hard character truncation here. Cutting at a fixed
  // offset severs a word and stores the fragment permanently, which is the
  // one thing a lorebook must never do. Two-sentence selection above is a
  // choice between whole sentences; this would have been a guillotine.
  // Runaway length is handled at the log level by the LORE_MAX_CHARS
  // middle-drop, and flagged in the inspector when beats average too long.

  return t;
}

async function summarizeForLore(existingLore, messagesToSummarize, authoredLore, fallbackCtx) {
  _loreLastOutcome = null;
  _loreLastKind = 'ok';

  // How many messages the caller has already archived. Every give-up path
  // below reports this number, because it is the thing the user actually
  // lost -- not the size of the summary, which is what the log records.
  const archivedCount = (messagesToSummarize || []).length;

  // The window everything below is budgeted against. Prefer what the
  // server reports; fall back to the card's limit when it cannot be
  // reached (file:// mode, proxy down, older llama-server). The fallback
  // can overestimate, which is what the 400 handler further down is for.
  const serverCtx = await getServerContextSize();
  const ctx = serverCtx || Math.max(2048, parseInt(fallbackCtx, 10) || 4096);
  // Instructions go in a SYSTEM message, not the user turn — most modern
  // chat templates weight system content more reliably for format
  // compliance. We also do NOT include m.reasoning: chain-of-thought from
  // earlier turns is working memory the model already discarded, and
  // folding it into lore was poisoning future summaries with CoT-of-CoT.
  //
  // The output is FIELDED rather than a narrative paragraph, and that is
  // the whole point of this prompt. A free-form story paragraph has to
  // re-ground the reader every time it changes subject ("Back at the
  // tavern...", "Still in Ashford..."), so with a recursive fold the
  // location got restated on every single pass — half a dozen times in a
  // long session. Fields carry a standing fact exactly once, in one
  // place, and leave EVENTS free to describe only what changed.
  //
  // The second half of the fix is the word REWRITE. The old prompt said
  // "fold in" and "updated summary", which reads as append-only: the
  // model treated the existing summary as immutable and bolted a new
  // sentence on the end. Nothing ever authorised it to delete, merge or
  // shorten what was already there, so the summary could only accrete.
  const sys = 'You are keeping a running list of plot beats for a story. You will be '
    + 'given the beats recorded so far and the newest stretch of conversation. '
    + 'Write ONE new beat covering only what happened in the new messages.\n\n'
    + 'RULES:\n'
    + '1. One sentence. Two at the absolute most. Under twenty words.\n'
    + '2. Only what is NEW. If it is already in the recorded beats, do not write '
    + 'it again - not the setting, not who anyone is, not anything unchanged. '
    + 'Assume the reader has the earlier beats in front of them.\n'
    + '3. Concrete: names, places, actions, decisions, reversals. Not mood, not '
    + 'scenery, not how anyone felt.\n'
    + '4. Plain past tense. No preamble, no bullet, no quotes, no labels. Output '
    + 'the sentence and nothing else.\n'
    + '5. If nothing of consequence happened, reply with exactly: SKIP\n\n'
    + 'This is the shape:\n'
    + 'Lucia was turned into a vampire by Vasch.\n'
    + 'Lucia escaped Vasch\'s mansion.\n'
    + 'Vasch began hunting Lucia and lost her trail.\n'
    + 'A resistance group took Lucia in.\n\n'
    + 'Each of those covers many exchanges, and none repeats the one before it.';

  // The chain starts at the card's authored starting lore, not at the first
  // generated beat. It was never shown to the summariser, so the model had
  // no way to know the premise was already written down and would record it
  // again as beat one. Both go under the same do-not-repeat heading -- from
  // the model's point of view they serve the same purpose.
  //
  // Only generated beats are returned and stored. Authored lore stays the
  // card's, untouched, and is injected into context separately.
  const authored = (authoredLore || '').trim();

  // Bound the input. The archive step can hand over a very large block --
  // on a 4K-context model the first pass frees a lot at once -- and a big
  // prompt on a small model is both slow and the condition under which it
  // is most likely to lose the plot and start looping.
  //
  // The most recent messages are the ones the new beat is about, so when
  // there are too many, keep the tail. An older message that misses this
  // window was almost certainly covered by the beat written last pass.
  const MAX_MSGS_PER_PASS = 24;
  const MAX_CHARS_PER_PASS = 12000;
  let feed = (messagesToSummarize || []).filter(m => (m && m.content));
  if (feed.length > MAX_MSGS_PER_PASS) feed = feed.slice(-MAX_MSGS_PER_PASS);
  let feedChars = feed.reduce((a, m) => a + ((m.content || '').length), 0);
  while (feed.length > 2 && feedChars > MAX_CHARS_PER_PASS) {
    feedChars -= (feed[0].content || '').length;
    feed = feed.slice(1);
  }

  /* ================================================================
     FIT THE PROMPT TO THE WINDOW

     This is the part that decides whether compression happens at all,
     and it used to be a single-shot estimate followed by a verdict.
     Estimate the feed budget once, fill it, cost the finished prompt,
     and if the leftover would not cover an output ask, give up and
     hard-trim. Three things were wrong with that.

     1. The feed budget did not subtract the SYSTEM prompt, the closing
        instruction, or the per-request fudge -- roughly 280 tokens it
        then spent on messages anyway. So a feed that filled its budget
        left about 280 tokens LESS than the floor it was budgeted to
        leave, and the pass was refused. Any conversation long enough to
        fill the feed hit this, which is every conversation that needs
        compressing. The feature read as "it never fires".

     2. The recorded beats were a fixed cost that grew all session and
        was never trimmed. On a small server window the do-not-repeat
        header alone could exceed the context, and no amount of feed
        trimming could recover it. The longer the session ran, the more
        certain the refusal -- exactly backwards.

     3. One oversized message was always included regardless of cost
        (the first chunk went in unconditionally), so a single long
        paste could refuse every pass from then on.

     The replacement trims until it fits instead of checking whether it
     did. Rungs, cheapest thing to lose first:

       1. Thin the middle of the beat log. Keeps the opening premise and
          the newest beats -- the two parts that actually do the
          do-not-repeat job -- and drops between them.
       2. Drop the oldest feed messages. Already this file's stated
          policy: an older message that misses the window was almost
          certainly covered by the beat written last pass.
       3. Drop the remaining beats. Risks a repeated beat, which is
          recoverable; lost history is not.
       4. Shorten the authored lore, keeping its HEAD. The premise leads
          with who and where.
       5. Clip the last message, keeping its TAIL. A message ends on its
          outcome, which is what a beat is about. Half a message
          summarised beats a whole one dropped.

     Only when a minimal prompt plus the floor cannot fit the window at
     all -- a genuinely too-small context, not a full one -- do we fall
     through to the hard-trim path below.
  ================================================================ */

  const LORE_TAIL = '=== END ===\nWrite the one new beat now. One sentence. Nothing else.';
  // Fixed and untrimmable: the instructions, plus the per-request
  // overhead the old code applied as a bare +16 AFTER budgeting.
  const sysTokens = estimateTokens(sys) + 16;

  /* Keep the END of a message. Word-wise, because estimateTokens counts
     words -- clipping by character offset would sever a word and make
     the cost estimate wrong in the same breath. */
  function _loreClipTail(text, maxTokens) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const keep = Math.floor(maxTokens * 0.7);
    if (keep < 1 || words.length <= keep) return text;
    return '[...] ' + words.slice(-keep).join(' ');
  }

  /* Drop one line from the MIDDLE of the beat log, keeping the first two
     and the last three. Same reasoning as the LORE_MAX_CHARS cap: the
     opening beats are the premise everything later rests on, the newest
     are what the model is most likely to restate, and the middle is the
     most safely forgotten. Returns null when there is nothing left to
     give, which is the signal to move to the next rung. */
  function _loreThinBeats(text) {
    const lines = String(text || '').split('\n').filter(l => l.trim());
    if (lines.length <= 5) return null;
    return lines.slice(0, 2).concat(lines.slice(3)).join('\n');
  }

  function _loreChunk(m, clipTokens) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = clipTokens ? _loreClipTail(m.content || '', clipTokens) : (m.content || '');
    let chunk = role + ': ' + text + '\n';
    // Search results are a repetition source in their own right: web
    // snippets restate the same place and product names in every result,
    // and folding them in whole taught the summariser that those names
    // were the most salient thing in the batch. A short excerpt is enough
    // to record THAT a search happened and roughly what it found.
    if (m.searchData) {
      const sd = m.searchData.length > 600
        ? m.searchData.slice(0, 600) + '\u2026'
        : m.searchData;
      chunk += '[Search results referenced]:\n' + sd + '\n';
    }
    return chunk + '\n';
  }

  /* Build the largest prompt that leaves room for a floor-sized answer
     inside `window`. Returns null only if no such prompt exists.
     `window` is a parameter rather than a closure read so the 400
     handler can re-fit against a deliberately pessimistic figure. */
  function _loreFit(window) {
    let beats = (existingLore || '').trim();
    let auth  = authored;
    let msgs  = feed.slice();
    let clip  = 0;
    const notes = { beatsThinned: 0, msgsDropped: 0, beatsDropped: false,
                    authorTrimmed: false, clipped: false };

    // Bounded: every rung strictly shrinks the material or returns.
    for (let guard = 0; guard < 400; guard++) {
      const rec = [auth, beats].filter(Boolean).join('\n');
      const head = rec
        ? '=== ALREADY WRITTEN DOWN - DO NOT REPEAT ANY OF THIS ===\n' + rec
          + '\n\n=== NEW MESSAGES ===\n'
        : '=== THE STORY SO FAR ===\n';
      const last = msgs.length - 1;
      const bodyNow = head
        + msgs.map((m, i) => _loreChunk(m, (clip && i === last) ? clip : 0)).join('')
        + LORE_TAIL;
      const promptTokens = sysTokens + estimateTokens(bodyNow);
      const ask = Math.min(LORE_OUTPUT_TARGET_TOKENS,
                           window - promptTokens - LORE_CTX_SAFETY_TOKENS);
      if (ask >= LORE_OUTPUT_FLOOR_TOKENS) {
        return { body: bodyNow, ask: ask, promptTokens: promptTokens, notes: notes };
      }

      const thinner = _loreThinBeats(beats);
      if (thinner !== null) { beats = thinner; notes.beatsThinned++; continue; }
      if (msgs.length > 1)  { msgs.shift();   notes.msgsDropped++;  continue; }
      if (beats)            { beats = '';     notes.beatsDropped = true; continue; }
      if (auth) {
        const words = auth.split(/\s+/).filter(Boolean);
        notes.authorTrimmed = true;
        auth = words.length > 30 ? words.slice(0, Math.floor(words.length / 2)).join(' ') : '';
        continue;
      }
      // One message, no header left. Clip it to whatever room remains.
      // Computed rather than iterated -- at this point every other term
      // is known, so there is exactly one right answer and no reason to
      // converge on it. Runs once; if the result still will not fit, the
      // window cannot hold the instructions and a floor-sized reply.
      if (!notes.clipped) {
        const room = window - sysTokens - estimateTokens(head) - estimateTokens(LORE_TAIL)
                   - LORE_OUTPUT_FLOOR_TOKENS - LORE_CTX_SAFETY_TOKENS - 12;
        if (room >= 48) { clip = room; notes.clipped = true; continue; }
      }
      return null;
    }
    return null;
  }

  let fitted = _loreFit(ctx);

  if (!fitted) {
    // No room to compress. Now a genuinely too-small context rather than
    // a merely full one: everything shrinkable has been shrunk and the
    // window still cannot hold the instructions plus a floor-sized
    // reply. This is a real condition, not an error, and it gets its own
    // branch precisely so it does not arrive as a 400.
    //
    // Policy is hard-trim: the messages the caller already archived stay
    // archived, we write down that they are missing, and the turn goes
    // through. It is the only one of the three options that is
    // self-correcting -- dropping this batch frees the context that made
    // compression impossible, so the next pass usually succeeds on its
    // own. Refusing the user's turn would deadlock the conversation, and
    // "stop compressing" would leave it stuck at exactly the fullness
    // that caused the problem.
    _loreLastKind = 'noroom';
    _loreLastOutcome = 'no room to compress -- a ' + ctx + '-token context'
      + (serverCtx ? '' : ' (estimated; the server did not report its context size)')
      + ' cannot hold the summariser\'s instructions and a '
      + LORE_OUTPUT_FLOOR_TOKENS + '-token reply, even with the prompt trimmed to '
      + 'nothing. The ' + archivedCount + ' oldest message'
      + (archivedCount === 1 ? ' was' : 's were') + ' dropped from context instead. '
      + 'Raise the model server\'s context size to fix this.';
    console.warn('[lore]', _loreLastOutcome);
    renderLoreIndicator('');
    return _appendLoreGapMarker(existingLore, archivedCount);
  }

  // Visible indicator so the user can see compression is happening rather
  // than the UI appearing frozen. Cleared on completion / error / abort.
  // Deliberately after the fit check: showing "compressing..." for a
  // pass that was never sent is how the old silent stall read on screen.
  renderLoreIndicator('compressing older messages into lore...');
  if (fitted.notes.msgsDropped || fitted.notes.clipped
      || fitted.notes.beatsThinned || fitted.notes.beatsDropped
      || fitted.notes.authorTrimmed) {
    const n = fitted.notes;
    console.warn('[lore] context is tight -- trimmed to fit a ' + ctx + '-token window: '
      + [n.msgsDropped ? n.msgsDropped + ' older message' + (n.msgsDropped === 1 ? '' : 's') + ' dropped' : '',
         n.clipped ? 'newest message clipped' : '',
         n.beatsThinned ? n.beatsThinned + ' recorded beat' + (n.beatsThinned === 1 ? '' : 's') + ' held back' : '',
         n.beatsDropped ? 'do-not-repeat list omitted' : '',
         n.authorTrimmed ? 'authored lore shortened' : ''
        ].filter(Boolean).join(', ')
      + '. Compressing anyway.');
  }

  // Lore compression must never hold the conversation hostage.
  //
  // This runs inside buildContextMessages, which sendMessage awaits before
  // it can post anything, so a summariser that hangs does not degrade
  // gracefully -- it eats the user's turn and delivers no reply at all.
  // There was nothing bounding the wait, so a single stuck request stopped
  // the whole app.
  //
  // On abort we keep the previous lore and carry on. Losing one beat is a
  // rounding error; losing the message someone just typed is not.
  const _loreAbort = new AbortController();
  const _loreTimer = setTimeout(() => _loreAbort.abort(), LORE_TIMEOUT_MS);

  /* One send. Extracted so the 400 handler can re-fit and try again
     without duplicating the request body. */
  function _loreSend(f) {
    return privacyFetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: _loreAbort.signal,
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: f.body }
        ],
        // Stream so we don't block the UI for ~30s with zero feedback.
        // The tokens are dropped on the floor — we just want progress.
        stream: true,
        // Whatever is left of the context, capped at
        // LORE_OUTPUT_TARGET_TOKENS and never below the floor -- see the
        // constants at the top of this section for why those two numbers
        // are what they are. On a roomy context this is 2048 and behaves
        // exactly as it did before; on a tight one it shrinks instead of
        // 400ing, and when it cannot reach the floor we never get here.
        max_tokens: f.ask,
        // Mild repeat penalty. The chat path gets one from the card's
        // sampler settings; this request was sending temperature alone,
        // which is the classic degenerate-loop recipe.
        repeat_penalty: 1.1,
        // Low temperature: we want stable, repeatable summaries.
        temperature: 0.3
      })
    });
  }

  try {
    let resp = await _loreSend(fitted);

    // A 400 here is the server's own context check, and our prediction of
    // it can be wrong in the one direction that matters: estimateTokens is
    // words x 1.43, which under-counts CJK, code, URLs and long
    // identifiers, so a prompt we costed as affordable can still overflow
    // the real tokeniser.
    //
    // That is an inaccurate ESTIMATE, not a full context, and the two used
    // to be treated the same -- one 400 and the batch was dropped. Re-fit
    // against 60% of the window instead. The ladder above will shed beats
    // and older messages until it fits a figure the estimate cannot
    // plausibly have overshot, and the retry costs one round trip inside
    // the timeout budget we were already holding. Only if THAT is refused
    // do we accept the loss.
    if (!resp.ok && resp.status === 400) {
      const tighter = _loreFit(Math.floor(ctx * 0.6));
      if (tighter) {
        console.warn('[lore] the server refused a prompt we costed as affordable; '
          + 'retrying against a 60% window.');
        fitted = tighter;
        resp = await _loreSend(fitted);
      }
    }

    if (!resp.ok) {
      const noRoom = (resp.status === 400);
      _loreLastKind = noRoom ? 'noroom' : 'failed';
      _loreLastOutcome = noRoom
        ? ('the model server rejected the summary as too long for its '
           + ctx + '-token context, even after trimming and a second, smaller '
           + 'attempt. The ' + archivedCount
           + ' oldest message' + (archivedCount === 1 ? ' was' : 's were')
           + ' dropped from context instead.')
        : ('HTTP ' + resp.status + ' from the model server. The ' + archivedCount
           + ' oldest message' + (archivedCount === 1 ? ' was' : 's were')
           + ' dropped from context without being summarised.');
      console.error('[lore] request failed:', resp.status, resp.statusText);
      renderLoreIndicator('');
      return _appendLoreGapMarker(existingLore, archivedCount);
    }

    // Reuse the project's existing thinking-format parser. Whatever the
    // model emits — <think> tags, <channel|> markers, harmony channels,
    // server-split reasoning_content — gets routed to tmpMsg.reasoning,
    // and the actual answer to tmpMsg.content. We then throw away
    // .reasoning. This is the fix that keeps CoT out of lore.
    const tmpMsg = { role: 'assistant', content: '', reasoning: '' };
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const tok = extractTokenFromLine(line);
        if (tok) processStreamDelta(tmpMsg, tok.text, tok.field);
      }
    }
    // Flush held-back buffer and scrub stray format markers.
    finalizeStreamMessage(tmpMsg);

    renderLoreIndicator('');

    // If parsing produced nothing, keep the prior lore rather than
    // overwriting it with an empty string (which would silently lose
    // every earlier summary).
    let summary = (tmpMsg.content || '').trim();

    // Recover text that the thinking-format parser filed as reasoning.
    //
    // Both of its reparent guards require state.phase === 'pre'
    // (03-generation.js:888 and :1031). Two branches leave that phase and
    // never come back: the server-split branch sets 'thinking_done' when
    // llama-server returns reasoning_content -- which it does, because
    // launch.bat starts it with --reasoning-format auto -- and gemma's
    // header branch sets 'thinking'. Either way the whole reply lands in
    // .reasoning with nothing to rescue it, and the summariser returned
    // the previous lore unchanged while the model was answering perfectly.
    //
    // For a summary the distinction does not matter. There is no user
    // watching a chain-of-thought block here; there is a paragraph we
    // asked for and we want it out of whichever bucket it landed in.
    if (!summary) {
      const reasoned = (tmpMsg.reasoning || '').trim();
      if (reasoned) {
        summary = reasoned;
        _loreLastOutcome = 'recovered ' + reasoned.length +
                           ' chars the parser had filed as reasoning';
        console.warn('[lore] content was empty; recovered ' + reasoned.length +
                     ' chars from reasoning. Parser filed the whole reply as ' +
                     'chain-of-thought.');
      }
    }

    // Reduce whatever came back to one clean beat. Deliberately aggressive:
    // a bad line here is appended permanently, and every later pass reads it
    // as established fact.
    summary = _cleanLoreBeat(summary);

    if (!summary) {
      // The interesting case. If .reasoning has text but .content does not,
      // the model answered and the thinking-format parser filed the whole
      // reply as chain-of-thought -- a parser problem, not a model one.
      // Distinguishing those two is the difference between fixing a regex
      // and rewriting a prompt.
      const rlen = (tmpMsg.reasoning || '').trim().length;
      _loreLastKind = 'failed';
      _loreLastOutcome = (rlen
        ? ('model replied but the parser filed all ' + rlen +
           ' characters as reasoning, not content')
        : 'model returned nothing at all')
        + '. The ' + archivedCount + ' oldest message'
        + (archivedCount === 1 ? ' was' : 's were')
        + ' dropped from context without being summarised.';
      console.error('[lore] empty summary.', _loreLastOutcome,
                    '| format:', normalizeThinkingFormat(activeModel && activeModel.thinkingFormat));
      // The messages are already archived and nothing was written down,
      // so this is a gap whatever the cause. Same treatment as a failed
      // request -- the user loses the same history either way.
      return _appendLoreGapMarker(existingLore, archivedCount);
    }

    // SKIP is the model correctly reporting that nothing worth recording
    // happened. Not a failure, and nothing to append.
    if (/^skip\b/i.test(summary)) {
      // Not a gap. The model read the batch and judged it inconsequential,
      // which is the outcome this instruction exists to produce, so no
      // marker and no warning -- the archived messages were discarded on
      // purpose rather than lost.
      _loreLastKind = 'skip';
      _loreLastOutcome = 'nothing worth recording this pass (SKIP)';
      return existingLore || '';
    }

    // APPEND, never rewrite. This is the design change.
    //
    // Asking a small local model to rewrite an entire summary every pass
    // produced two failures at once: standing facts got restated on every
    // rewrite (the location, six times over), and the text drifted as each
    // pass re-interpreted the last. A beat log has neither problem. Old
    // lines are never touched so they cannot drift, and each new line
    // covers only new ground because that is all that was asked for.
    const prior = (existingLore || '').trim();
    let combined = prior ? (prior + '\n- ' + summary) : ('- ' + summary);

    // Cap. Beats are short, so 2400 chars holds 20-25 of them, which is a
    // lot of story. When it does overflow, drop from the MIDDLE and keep
    // the first two: the opening beats are the premise everything later
    // rests on ("Lucia was turned into a vampire by Vasch" explains every
    // line after it), while the middle is the most safely forgotten.
    if (combined.length > LORE_MAX_CHARS) {
      const lines = combined.split('\n').filter(function (l) { return l.trim(); });
      const head = lines.slice(0, 2);
      const tail = [];
      let budget = LORE_MAX_CHARS - head.join('\n').length - 24;
      for (let k = lines.length - 1; k >= 2 && budget > 0; k--) {
        budget -= lines[k].length + 1;
        if (budget > 0) tail.unshift(lines[k]);
      }
      combined = head.concat(['- [...]']).concat(tail).join('\n');
    }
    summary = combined;
    return summary;
  } catch (e) {
    // An abort is a timeout, not a crash, and saying so matters: it points
    // at a stuck or looping model rather than a bug in the request.
    const _lost = ' The ' + archivedCount + ' oldest message'
                + (archivedCount === 1 ? ' was' : 's were')
                + ' dropped from context without being summarised.';
    _loreLastKind = 'failed';
    if (e && e.name === 'AbortError') {
      _loreLastOutcome = 'timed out after ' + Math.round(LORE_TIMEOUT_MS / 1000)
                       + 's and was cancelled so the turn could continue.' + _lost;
      console.warn('[lore] compression timed out.', _loreLastOutcome);
    } else {
      _loreLastOutcome = 'threw: ' + (e && e.message ? e.message : String(e)) + '.' + _lost;
      console.error('Lore summarization failed:', e);
    }
    renderLoreIndicator('');
    return _appendLoreGapMarker(existingLore, archivedCount);
  } finally {
    // Six return paths leave this function. A finally is the only way to be
    // sure the timer dies on all of them -- a leaked one fires minutes
    // later and aborts a controller nobody is listening to, or worse, keeps
    // the page awake for no reason.
    clearTimeout(_loreTimer);
  }
}

/* ================================================================
   BUILD CONTEXT (token-aware with rolling archive)

   Two views of the conversation:
     thread.messages — the user-visible scrollback. Grows forever.
                       Messages marked .archived = true are kept here
                       for the UI but no longer sent to the model.
     [non-archived]  — what we actually send. Compresses periodically
                       as the budget approaches.

   Everything below is token-driven. Message counts are never used as
   thresholds — the user can configure a 16k or a 100k context and the
   same logic scales naturally. The only floors are token reserves:
   we promise to keep AT LEAST RECENT_RESERVE_FACTOR of the budget as
   trailing verbatim messages no matter how aggressively we compress.

   Cycle when liveTokens + overhead would exceed budget:
     1. Walk oldest-first through non-archived messages.
     2. Mark .archived = true until we've freed enough to land at
        TARGET_FACTOR of budget — OR until archiving the next one
        would eat into the trailing reserve, whichever comes first.
     3. Fold those just-archived messages into lore.
     4. Re-render so the UI shows the dimmed + divider state.
================================================================ */
/* ================================================================
   NORMALIZE MESSAGES FOR STRICT TEMPLATES

   Some chat templates — most notably Mistral Nemo's v3-tekken —
   enforce a hard contract on the messages array:
     1. At most ONE system message, only at the very start.
     2. Strict user/assistant/user/assistant alternation after that.
   When violated, the template calls raise_exception(), llama-server
   returns 500, and the file server's reverse proxy passes it to the
   browser as 502. This is what was making MN-Violet-Lotus and other
   Nemo merges fail on existing threads while working on fresh ones.

   Our buildContextMessages above intentionally pushes multiple system
   messages (character prompt, lore, personality reminder, narrative
   direction), and the token-trim safety net can shift messages off
   the front in a way that leaves the array starting with assistant.
   Gemma 4 and Mistral Small v7-tekken silently tolerate both; Nemo
   refuses.

   This pass produces a Nemo-safe array without losing content:
     1. Merge ALL leading system messages into one (joined by \n\n).
     2. Fold any leading assistant message(s) — the opening greeting,
        plus the rare token-trim leftover — into the leading system
        block as a labeled opening, so the array can start on a user
        turn WITHOUT deleting that content from context. (Previously
        these were dropped, which silently lost the greeting.)
     3. Fold mid-conversation system messages into the NEXT user
        message as a [System: ...] prefix. If no user follows, append
        to the previous user message as a trailing note.
     4. Merge consecutive same-role conversation messages with \n\n
        (handles edits/branches that produced user→user pairs).

   Applied universally rather than gating on model family because:
     - The user explicitly wants robust mid-thread model swapping.
     - The transformations are no-ops or near-no-ops on tolerant
       templates (collapsing multiple systems into one is what every
       template ends up doing internally anyway).
     - Keeping the call sites simple is worth more than the small
       fidelity loss from [System: ...] markers on tolerant models.
================================================================ */
function normalizeMessagesForStrictTemplates(messages) {
  if (!messages || !messages.length) return messages || [];

  const VALID_ROLES = new Set(['system', 'user', 'assistant']);
  
  // Distilled reasoning models (DeepSeek, Qwen) frequently ignore the 'system' role.
  // Folding the system prompt directly into the first user message guarantees they read it.
  const fam = (activeModel && activeModel.family) ? String(activeModel.family).toLowerCase() : '';
  const foldLeadingSystem = ['deepseek', 'qwen'].includes(fam);

  let working = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase().trim();
    if (!VALID_ROLES.has(role)) continue;
    const content = (m.content == null) ? '' : String(m.content);
    working.push({ role, content });
  }
  if (!working.length) return [];

  let i = 0;
  const leadingSystem = [];
  while (i < working.length && working[i].role === 'system') {
    if (working[i].content) leadingSystem.push(working[i].content);
    i++;
  }
  // Leading assistant message(s) — the character's opening greeting, stamped
  // by injectGreeting() at messages[0] as an assistant turn (or, rarely, an
  // old reply orphaned at the front by the trim safety net). Rather than bury
  // it in the system block (the old behavior), we weave it back as a PROPER
  // turn pair: a minimal user anchor followed by the assistant greeting. That
  // keeps the greeting an in-character assistant turn for every template —
  // strict ones (Mistral Nemo et al.) can't open on an assistant turn, so the
  // user anchor is what makes the opening legal — while still giving it a real
  // user-side context. Empty / whitespace greeting slots (e.g. blanked for an
  // in-flight reroll) carry no content and are skipped.
  const leadingAssistant = [];
  while (i < working.length && working[i].role === 'assistant') {
    const c = (working[i].content || '').trim();
    if (c) leadingAssistant.push(working[i].content);
    i++;
  }
  const greetingText = leadingAssistant.length ? leadingAssistant.join('\n\n') : '';
  // The greeting's anchor is itself a user-role message, so for fold models it
  // can double as the carrier for the deferred system block.
  const haveUserTarget = !!greetingText || !!working.find(m => m.role === 'user');

  const out = [];
  let pendingSystem = '';

  if (leadingSystem.length) {
    if (foldLeadingSystem && haveUserTarget) {
      // Defer the system block onto the first user-role message — the greeting
      // anchor if present, otherwise the first real user turn.
      pendingSystem = leadingSystem.join('\n\n');
    } else {
      out.push({ role: 'system', content: leadingSystem.join('\n\n') });
    }
  }

  // Weave the opening greeting as [user anchor] -> [assistant greeting]. The
  // anchor is a minimal cue so the array can legally open user-first; on fold
  // models it also carries the deferred system block.
  if (greetingText) {
    let anchor = '[Start of conversation]';
    if (pendingSystem) { anchor = pendingSystem + '\n\n' + anchor; pendingSystem = ''; }
    out.push({ role: 'user', content: anchor });
    out.push({ role: 'assistant', content: greetingText });
  }

  for (; i < working.length; i++) {
    const m = working[i];
    if (m.role === 'system') {
      if (m.content) {
        pendingSystem = pendingSystem ? pendingSystem + '\n\n' + m.content : m.content;
      }
      continue;
    }
    if (pendingSystem && m.role === 'user') {
      const isFirstUser = m === working.find(w => w.role === 'user');
      // Only add the [System: ] label for mid-conversation injected prompts.
      // For the main folded system block at the start, inject it seamlessly.
      const prefix = (isFirstUser && foldLeadingSystem)
        ? `${pendingSystem}\n\n`
        : `[System: ${pendingSystem}]\n\n`;
      out.push({ role: 'user', content: prefix + m.content });
      pendingSystem = '';
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (pendingSystem) {
    for (let j = out.length - 1; j >= 0; j--) {
      if (out[j].role === 'user') {
        out[j].content = out[j].content + `\n\n[System: ${pendingSystem}]`;
        break;
      }
    }
  }

  // Drop empty/whitespace-only assistant messages.
  const nonEmpty = out.filter(m =>
    m.role !== 'assistant' || (m.content || '').trim().length > 0
  );

  // Merge consecutive same-role conversation messages.
  const merged = [];
  for (const m of nonEmpty) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      prev.content = prev.content + '\n\n' + m.content;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }

  // Drop trailing assistant messages so the array terminates cleanly on 'user'.
  while (merged.length && merged[merged.length - 1].role === 'assistant') {
    merged.pop();
  }

  // Re-merge after popping (guarantees strictly alternating array).
  const finalPass = [];
  for (const m of merged) {
    const prev = finalPass[finalPass.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      prev.content = prev.content + '\n\n' + m.content;
    } else {
      finalPass.push({ role: m.role, content: m.content });
    }
  }

  return finalPass;
}

