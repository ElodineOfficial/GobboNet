/**
 * Drives the REAL compressWithCardModel from js/07-prompt.js.
 * The thing under test is not the happy path -- it is that the user's chat
 * model always comes back, and that messages are never lost when it doesn't.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/07-prompt.js', 'utf8');

let swaps = [];          // every model file we asked the server to load
let loaded = 'chat-24b.gguf';
let swapFailsFor = null; // a filename whose swap should fail
let toasts = [];
let compressCalls = 0;
let compressThrows = false;

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
  swaps = []; toasts = []; compressCalls = 0;
  const ctx = {
    console: { log: () => {}, warn: () => {}, error: (...a) => toasts.push('ERR:' + a[0]) },
    Date, Math, JSON, String, Number, Array, Object, RegExp, parseInt,
    TextDecoder, TextEncoder, setTimeout, clearTimeout, AbortController, Promise,
    IS_SERVED: true, LLAMA_URL: '/llm',
    _currentModelFile: loaded,
    activeModel: { name: 'T', family: 'llama', thinkingFormat: 'none' },
    state: { settings: {} },
    renderLoreIndicator: () => {},
    normalizeThinkingFormat: () => 'none',
    showModelSwitchToast: (m, k) => toasts.push(k + ':' + m),
    getActivePersona: () => ({}), escapeHtml: (s) => String(s ?? ''),
    extractTokenFromLine: (line) => {
      const t = line.trim();
      if (!t.startsWith('data:') || t.includes('[DONE]')) return null;
      try { const d = JSON.parse(t.slice(5)).choices?.[0]?.delta?.content;
            return d ? { text: d, field: 'content' } : null; } catch { return null; }
    },
    processStreamDelta: (m, t, f) => { m[f] += t; },
    finalizeStreamMessage: (m) => { m.content = m.content.trim(); },
    // The swap the wrapper calls. Records the request and moves `loaded`.
    swapToModelFile: async (file) => {
      swaps.push(file);
      if (swapFailsFor && file === swapFailsFor) throw new Error('swap did not complete');
      loaded = file;
      ctx._currentModelFile = file;
    },
    privacyFetch: async (url) => {
      if (String(url).endsWith('/props')) {
        return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 32768 } }) };
      }
      compressCalls++;
      if (compressThrows) throw new TypeError('Failed to fetch');
      // Whichever model is loaded is the one that answers.
      return { ok: true, body: makeSSE('Summary from ' + loaded) };
    },
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + `
    globalThis.__run = compressWithCardModel;
    globalThis.__probe = () => ({ kind: _loreLastKind, outcome: _loreLastOutcome });
    globalThis.__dropCtxCache = () => { _loreServerCtx = null; _loreServerCtxAt = 0; };
  `, ctx, { filename: '07-prompt.js' });
  return ctx;
}

const msg = (n) => ({ role: 'user', content: ('word ').repeat(n).trim() });
let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); }
};

console.log('\n=== 1. No model chosen: nothing swaps, behaviour unchanged ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = null; compressThrows = false;
  const ctx = build();
  const out = await ctx.__run('', [msg(30)], '', 32768, { loreEnabled: true });
  check('zero swaps', swaps.length === 0, swaps.join(','));
  check('compression still ran', compressCalls === 1, String(compressCalls));
  check('chat model still loaded', loaded === 'chat-24b.gguf', loaded);
  check('produced a beat', /Summary from/.test(out), out);
}

console.log('\n=== 2. A different model chosen: borrow, compress, give back ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = null; compressThrows = false;
  const ctx = build();
  const out = await ctx.__run('', [msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'tiny-1b.gguf' });
  check('swapped out then back', swaps.join(',') === 'tiny-1b.gguf,chat-24b.gguf', swaps.join(','));
  check('chat model restored', loaded === 'chat-24b.gguf', loaded);
  check('the SUMMARISER produced it, not the chat model',
        /Summary from tiny-1b/.test(out), out);
  check('outcome ok', ctx.__probe().kind === 'ok', ctx.__probe().kind);
}

console.log('\n=== 3. Chosen model already loaded: no pointless swap ===');
{
  loaded = 'tiny-1b.gguf'; swapFailsFor = null; compressThrows = false;
  const ctx = build();
  await ctx.__run('', [msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'tiny-1b.gguf' });
  check('zero swaps', swaps.length === 0, swaps.join(','));
  check('compression ran', compressCalls === 1);
}

console.log('\n=== 4. Borrow FAILS: compress anyway, never lose the messages ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = 'broken.gguf'; compressThrows = false;
  const ctx = build();
  const out = await ctx.__run('- Prior.', [msg(30), msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'broken.gguf' });
  check('tried once, gave up', swaps.join(',') === 'broken.gguf', swaps.join(','));
  check('did NOT try to swap back (never left)', swaps.length === 1);
  check('chat model untouched', loaded === 'chat-24b.gguf', loaded);
  check('compressed on the chat model instead', compressCalls === 1, String(compressCalls));
  check('a real beat, not a gap marker',
        /Summary from chat-24b/.test(out) && !/dropped without being/.test(out), out);
}

console.log('\n=== 5. Compression throws mid-borrow: model STILL comes back ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = null; compressThrows = true;
  const ctx = build();
  const out = await ctx.__run('- Prior.', [msg(30), msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'tiny-1b.gguf' });
  check('swapped back despite the failure',
        swaps.join(',') === 'tiny-1b.gguf,chat-24b.gguf', swaps.join(','));
  check('chat model restored', loaded === 'chat-24b.gguf', loaded);
  check('failure recorded', ctx.__probe().kind === 'failed', ctx.__probe().kind);
  check('gap marker written (item 4 holds)', /2 earlier messages dropped/.test(out), out);
  compressThrows = false;
}

console.log('\n=== 6. Give-back FAILS: loud, not silent ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = 'chat-24b.gguf'; compressThrows = false;
  const ctx = build();
  await ctx.__run('', [msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'tiny-1b.gguf' });
  check('attempted the restore', swaps.join(',') === 'tiny-1b.gguf,chat-24b.gguf', swaps.join(','));
  check('error toast raised', toasts.some(t => t.startsWith('err:')), toasts.join(' | '));
  check('toast names both models',
        toasts.some(t => t.includes('chat-24b.gguf') && t.includes('tiny-1b.gguf')),
        toasts.join(' | '));
  check('outcome marked failed so the banner shows it',
        ctx.__probe().kind === 'failed', ctx.__probe().kind);
  check('reason tells the user how to fix it',
        /header/i.test(ctx.__probe().outcome), ctx.__probe().outcome);
  swapFailsFor = null;
}

console.log('\n=== 7. file:// mode: no file server, so no swap attempt ===');
{
  loaded = 'chat-24b.gguf'; swapFailsFor = null;
  const ctx = build();
  ctx.IS_SERVED = false;
  vm.runInContext('IS_SERVED = false;', ctx);
  const out = await ctx.__run('', [msg(30)], '', 32768,
    { loreEnabled: true, loreModelFile: 'tiny-1b.gguf' });
  check('no swap attempted', swaps.length === 0, swaps.join(','));
  check('compression still ran on the chat model', /Summary from chat-24b/.test(out), out);
}

console.log('\n=== 8. Legacy cards (field absent) ===');
{
  loaded = 'chat-24b.gguf';
  for (const [label, card] of [['{}', {}], ['null', { loreModelFile: null }],
                               ['whitespace', { loreModelFile: '  ' }]]) {
    const ctx = build();
    await ctx.__run('', [msg(20)], '', 32768, card);
    check(`${label} -> no swap`, swaps.length === 0, swaps.join(','));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
