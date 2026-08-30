/**
 * Drives the REAL summarizeForLore from js/07-prompt.js.
 *
 * The thing under test is the branch that used to refuse: a context that is
 * FULL, not one that is too small. Every case here is one that previously
 * came back "no room to compress" and dropped the batch on the floor.
 *
 * The interesting assertion is almost always the same one -- a request was
 * actually SENT, and the prompt inside it fits the window we said it had.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/07-prompt.js', 'utf8');

let sent = [];          // every /v1/chat/completions body we posted
let serverCtx = 4096;   // what /props reports
let rejectFirst = false; // 400 the first send, to exercise the retry
let indicators = [];

function makeSSE(text) {
  const enc = new TextEncoder();
  const body = text.split(' ').map(w =>
    'data: ' + JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] }) + '\n').join('')
    + 'data: [DONE]\n';
  const bytes = enc.encode(body);
  let done = false;
  return { getReader: () => ({ read: async () => done ? { done: true }
    : (done = true, { done: false, value: bytes }) }) };
}

function build() {
  sent = []; indicators = [];
  const ctx = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, String, Number, Array, Object, RegExp, parseInt, isNaN,
    TextDecoder, TextEncoder, setTimeout, clearTimeout, AbortController, Promise,
    IS_SERVED: true, LLAMA_URL: '/llm',
    _currentModelFile: 'chat.gguf',
    activeModel: { name: 'T', family: 'llama', thinkingFormat: 'none' },
    state: { settings: {} },
    renderLoreIndicator: (s) => indicators.push(s),
    normalizeThinkingFormat: () => 'none',
    showModelSwitchToast: () => {},
    getActivePersona: () => ({}), escapeHtml: (s) => String(s ?? ''),
    extractTokenFromLine: (line) => {
      const t = line.trim();
      if (!t.startsWith('data:') || t.includes('[DONE]')) return null;
      try { const d = JSON.parse(t.slice(5)).choices?.[0]?.delta?.content;
            return d ? { text: d, field: 'content' } : null; } catch { return null; }
    },
    processStreamDelta: (m, t, f) => { m[f] += t; },
    finalizeStreamMessage: (m) => { m.content = m.content.trim(); },
    swapToModelFile: async () => {},
    privacyFetch: async (url, opts) => {
      if (String(url).endsWith('/props')) {
        return serverCtx
          ? { ok: true, json: async () => ({ default_generation_settings: { n_ctx: serverCtx } }) }
          : { ok: false, status: 500, json: async () => ({}) };
      }
      const parsed = JSON.parse(opts.body);
      sent.push(parsed);
      if (rejectFirst && sent.length === 1) {
        return { ok: false, status: 400, statusText: 'Bad Request' };
      }
      return { ok: true, body: makeSSE('The party reached Ashford and burned the bridge.') };
    },
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + `
    globalThis.__lore   = summarizeForLore;
    globalThis.__est    = estimateTokens;
    globalThis.__probe  = () => ({ kind: _loreLastKind, outcome: _loreLastOutcome });
    globalThis.__dropCtxCache = () => { _loreServerCtx = null; _loreServerCtxAt = 0; };
  `, ctx, { filename: '07-prompt.js' });
  ctx.__dropCtxCache();
  return ctx;
}

const words = (n) => ('word ').repeat(n).trim();
const msg = (role, n) => ({ role, content: words(n) });

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '  <- ' + d : '')); }
};

/* The whole point: whatever we send must fit the window the server said it
   had, with room left for the answer we asked for. */
function fitsWindow(ctx, req, window) {
  const t = ctx.__est(req.messages[0].content) + ctx.__est(req.messages[1].content);
  return (t + req.max_tokens) <= window;
}

console.log('\n=== 1. A full 4K context still compresses ===');
console.log('    (the regression: the feed budget ignored the system prompt, so a');
console.log('     feed that filled it left less than the floor and every pass was refused)');
{
  serverCtx = 4096; rejectFirst = false;
  const ctx = build();
  const batch = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 120));
  const out = await ctx.__lore('- They left the capital.', batch, 'A war-torn kingdom.', 32768);
  check('a request was actually sent', sent.length === 1, 'sent ' + sent.length);
  check('outcome is ok, not noroom', ctx.__probe().kind === 'ok', ctx.__probe().kind);
  check('a beat was appended', /burned the bridge/.test(out), out);
  check('the earlier beat survived', /left the capital/.test(out), out);
  check('prompt + ask fits 4096', sent[0] && fitsWindow(ctx, sent[0], 4096),
        sent[0] ? String(ctx.__est(sent[0].messages[1].content) + sent[0].max_tokens) : 'n/a');
  check('asked for at least the floor', sent[0] && sent[0].max_tokens >= 512,
        String(sent[0] && sent[0].max_tokens));
}

console.log('\n=== 2. A beat log that has grown all session ===');
console.log('    (recorded beats were a fixed cost that was never trimmed: the longer');
console.log('     you played, the more certain the refusal)');
{
  // 2048, because at 4096 a 40-beat log still fits and nothing is trimmed --
  // which is the correct behaviour and would prove nothing here.
  serverCtx = 2048; rejectFirst = false;
  const ctx = build();
  const bigLog = Array.from({ length: 40 }, (_, i) => '- Beat number ' + i + ' ' + words(25)).join('\n');
  const out = await ctx.__lore(bigLog, [msg('user', 200), msg('assistant', 200)], '', 32768);
  check('a request was actually sent', sent.length === 1, 'sent ' + sent.length);
  check('outcome is ok', ctx.__probe().kind === 'ok', ctx.__probe().kind);
  check('prompt + ask fits 2048', sent[0] && fitsWindow(ctx, sent[0], 2048));

  const nums = (s) => new Set((s.match(/Beat number (\d+)/g) || []).map(x => x.split(' ')[2]));
  const inPrompt = nums(sent[0].messages[1].content);
  const inStore  = nums(out);
  check('the OPENING beats were kept as the premise', inPrompt.has('0') && inPrompt.has('1'));
  check('the newest beat was kept', inPrompt.has('39'));
  check('the middle was thinned to fit', inPrompt.size < 40, inPrompt.size + ' of 40');
  check('trimming the PROMPT did not trim STORAGE',
        [...inStore].some(n => !inPrompt.has(n)),
        'prompt ' + inPrompt.size + ' beats, storage ' + inStore.size);
  check('the new beat still landed', /burned the bridge/.test(out));
}

console.log('\n=== 3. One enormous pasted message ===');
console.log('    (the first chunk went in unconditionally, so a single long paste');
console.log('     refused every pass from then on)');
{
  serverCtx = 4096; rejectFirst = false;
  const ctx = build();
  const out = await ctx.__lore('', [msg('user', 6000)], '', 32768);
  check('a request was actually sent', sent.length === 1, 'sent ' + sent.length);
  check('outcome is ok', ctx.__probe().kind === 'ok', ctx.__probe().kind);
  check('prompt + ask fits 4096', sent[0] && fitsWindow(ctx, sent[0], 4096));
  check('the message was clipped, not dropped', /\[\.\.\.\]/.test(sent[0].messages[1].content));
  check('a beat came back', /burned the bridge/.test(out), out);
}

console.log('\n=== 4. A card with a huge authored lore ===');
{
  serverCtx = 4096; rejectFirst = false;
  const ctx = build();
  const out = await ctx.__lore('', [msg('user', 150), msg('assistant', 150)],
                               'PREMISE-HEAD ' + words(3000), 32768);
  check('a request was actually sent', sent.length === 1, 'sent ' + sent.length);
  check('outcome is ok', ctx.__probe().kind === 'ok', ctx.__probe().kind);
  check('prompt + ask fits 4096', sent[0] && fitsWindow(ctx, sent[0], 4096));
  check('authored lore kept its HEAD (who and where)',
        /PREMISE-HEAD/.test(sent[0].messages[1].content));
}

console.log('\n=== 5. The server refuses anyway: re-fit and retry ===');
console.log('    (estimateTokens under-counts CJK, code and URLs, so a prompt we');
console.log('     costed as affordable can still overflow the real tokeniser)');
{
  serverCtx = 4096; rejectFirst = true;
  const ctx = build();
  const batch = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 120));
  const out = await ctx.__lore('- They left the capital.', batch, '', 32768);
  check('it tried twice', sent.length === 2, 'sent ' + sent.length);
  check('the retry was smaller than the first attempt',
        sent.length === 2 && sent[1].messages[1].content.length < sent[0].messages[1].content.length);
  check('the retry fits a 60% window', sent[1] && fitsWindow(ctx, sent[1], Math.floor(4096 * 0.6)));
  check('outcome is ok, not noroom', ctx.__probe().kind === 'ok', ctx.__probe().kind);
  check('a beat came back', /burned the bridge/.test(out), out);
}

console.log('\n=== 6. A genuinely too-small window still fails honestly ===');
console.log('    (this is the one case the old message was right about)');
{
  serverCtx = 700; rejectFirst = false;
  const ctx = build();
  const before = '- They left the capital.';
  const out = await ctx.__lore(before, [msg('user', 400)], '', 32768);
  check('nothing was sent', sent.length === 0, 'sent ' + sent.length);
  check('outcome is noroom', ctx.__probe().kind === 'noroom', ctx.__probe().kind);
  check('the gap is written down, not swallowed',
        /dropped without being summarised/.test(out), out);
  check('the earlier lore survives', /left the capital/.test(out), out);
  check('it names the fix', /context size/.test(ctx.__probe().outcome), ctx.__probe().outcome);
  check('the indicator was cleared', indicators[indicators.length - 1] === '');
}

console.log('\n=== 7. Roomy context: unchanged behaviour ===');
{
  serverCtx = 32768; rejectFirst = false;
  const ctx = build();
  const batch = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 60));
  const out = await ctx.__lore('- They left the capital.', batch, 'A war-torn kingdom.', 32768);
  check('a request was sent', sent.length === 1);
  check('the full target ask, as before', sent[0].max_tokens === 2048, String(sent[0].max_tokens));
  check('nothing was trimmed: every message is present',
        batch.every(() => /word/.test(sent[0].messages[1].content))
        && !/\[\.\.\.\]/.test(sent[0].messages[1].content));
  check('outcome ok', ctx.__probe().kind === 'ok');
}

console.log('\n=== 8. SKIP is still a clean no-op, not a gap ===');
{
  serverCtx = 32768; rejectFirst = false;
  const ctx = build();
  ctx.privacyFetch = async (url, opts) => {
    if (String(url).endsWith('/props')) {
      return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 32768 } }) };
    }
    sent.push(JSON.parse(opts.body));
    return { ok: true, body: makeSSE('SKIP') };
  };
  const out = await ctx.__lore('- They left the capital.', [msg('user', 40)], '', 32768);
  check('outcome is skip', ctx.__probe().kind === 'skip', ctx.__probe().kind);
  check('no gap marker', !/dropped without/.test(out), out);
  check('lore returned unchanged', out === '- They left the capital.', out);
}

console.log('\n=== 9. No /props: falls back to the card limit, still fits it ===');
{
  serverCtx = 0; rejectFirst = false;
  const ctx = build();
  const batch = Array.from({ length: 16 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 100));
  await ctx.__lore('', batch, '', 4096);
  check('a request was sent', sent.length === 1, 'sent ' + sent.length);
  check('budgeted against the card limit', sent[0] && fitsWindow(ctx, sent[0], 4096));
  check('outcome ok', ctx.__probe().kind === 'ok', ctx.__probe().kind);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
