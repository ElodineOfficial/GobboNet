/**
 * Why a model failed to load, in plain words (1.8.0, roadmap #11, issue #67).
 *
 * The server publishes the cause on /swap-status (internal/supervisor/
 * cause.go); this holds the page's side of it, running the real functions:
 *
 *   A. A chat request that fails while the model is down shows the cause,
 *      not "503": attachLoadFailure asks /swap-status once, after the
 *      failure, and applyGenerationOutcome writes the plain sentence, the
 *      engine's line as text, and where the log is.
 *   B. It asks nothing when the request worked, in remote mode, or when the
 *      page is opened from a file; and a reply that already had text keeps
 *      its "interrupted" note.
 *   C. The landing page: the sentence on the OFFLINE pill, the raw line under
 *      "details", both escaped; refreshOfflineReason reads cause and advice.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = p => fs.readFileSync(ROOT + '/' + p, 'utf8');
const GEN = read('js/03-generation.js');
const DASH = read('js/13-dashboard.js');
const SEARCH = read('js/11-search.js');
const CHAT = read('js/10-chat.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); }
};
const fnBody = (src, sig) => {
  const a = src.indexOf(sig);
  if (a < 0) { console.error('could not locate ' + sig); process.exit(1); }
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
};
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OOM = { phase: 'error', file: 'big.gguf', name: 'big.gguf', cause: 'out_of_memory',
  advice: 'Not enough GPU or system memory for this model. Lower the context size or GPU layers in CONFIG > Performance, or pick a smaller model.',
  message: 'alloc_tensor_range: failed to allocate Vulkan0 buffer of size 13421772800', log: 'llama-server.log' };

function genContext({ status = OOM, served = true, remote = false } = {}) {
  const calls = [];
  const ctx = {
    IS_SERVED: served, _remoteMode: remote, _cotCulledFlag: false, state: { settings: {} },
    fetch: async url => { calls.push(url); return { ok: true, json: async () => status }; },
  };
  vm.createContext(ctx);
  vm.runInContext(fnBody(GEN, 'async function attachLoadFailure(outcome)') +
                  fnBody(GEN, 'function loadFailureText(f)') +
                  fnBody(GEN, 'function applyGenerationOutcome(assistantMsg, outcome, style)'), ctx);
  return { ctx, calls };
}
const failed503 = () => ({ errored: true, aborted: false, errorMessage: 'upstream HTTP 503: Service Unavailable',
                           errorObj: { name: 'Error', message: 'upstream HTTP 503: Service Unavailable' } });

console.log('\n=== A. a failed request while the model is down says why ===');
for (const style of ['diagnostic', 'plain']) {
  const { ctx, calls } = genContext();
  const outcome = await ctx.attachLoadFailure(failed503());
  ok(calls.length === 1 && calls[0] === '/swap-status', `${style}: /swap-status is asked once, after the failure`);
  const msg = { content: '', reasoning: '' };
  ctx.applyGenerationOutcome(msg, outcome, style);
  ok(msg.content.startsWith('**The model did not load.** (`big.gguf`) Not enough GPU or system memory'), `${style}: the plain sentence leads`, msg.content);
  ok(msg.content.includes('The engine said: `alloc_tensor_range: failed to allocate Vulkan0 buffer of size 13421772800`'), `${style}: the engine's own line follows, as text`);
  ok(msg.content.includes("llama-server.log in GobboNet's data folder") && msg.content.includes('`gobbonet doctor`'), `${style}: and where the whole log is`);
  ok(!/503|Service Unavailable|Connection Error/.test(msg.content), `${style}: not the HTTP status`);
}
{
  const { ctx } = genContext({ status: { phase: 'error', name: 'x.gguf', message: 'llama_model_load: something a later engine says' } });
  const msg = { content: '' };
  ctx.applyGenerationOutcome(msg, await ctx.attachLoadFailure(failed503()), 'plain');
  ok(msg.content.startsWith('**The model did not load.** (`x.gguf`)\n\nThe engine said: `llama_model_load: something a later engine says`'),
     'no known cause: the line alone, still instead of the status', msg.content);
}
{
  const { ctx } = genContext({ status: { phase: 'error', name: 'a_b*.gguf', message: 'bad `tick` here', advice: 'Fix it.' } });
  const msg = { content: '' };
  ctx.applyGenerationOutcome(msg, await ctx.attachLoadFailure(failed503()), 'plain');
  ok(msg.content.includes("`bad 'tick' here`") && msg.content.includes('(`a_b*.gguf`)'), 'a backtick or markdown in the line or name cannot break out of its markup', msg.content);
}

console.log('\n=== B. and asks nothing when it should not ===');
{
  const { ctx, calls } = genContext();
  const outcome = await ctx.attachLoadFailure({ errored: false, aborted: false });
  ok(calls.length === 0 && !outcome.loadFailure, 'a request that worked: nothing asked');
  const r = genContext({ remote: true });
  await r.ctx.attachLoadFailure(failed503());
  ok(r.calls.length === 0, 'remote mode: nothing asked (its model is not ours to load)');
  const f = genContext({ served: false });
  await f.ctx.attachLoadFailure(failed503());
  ok(f.calls.length === 0, 'a page opened from a file: nothing asked');
}
{
  const { ctx } = genContext({ status: { phase: 'ready', file: 'a.gguf' } });
  const outcome = await ctx.attachLoadFailure(failed503());
  const msg = { content: '' };
  ctx.applyGenerationOutcome(msg, outcome, 'plain');
  ok(!outcome.loadFailure && msg.content === '**Error:** upstream HTTP 503: Service Unavailable', 'the model is loaded: the plain error, as before', msg.content);
}
{
  const { ctx } = genContext();
  const outcome = await ctx.attachLoadFailure(failed503());
  const msg = { content: 'Half a reply' };
  ctx.applyGenerationOutcome(msg, outcome, 'plain');
  ok(msg.content === 'Half a reply\n\n*(interrupted — upstream HTTP 503: Service Unavailable)*', 'a reply that already had text keeps its words and the interrupted note', msg.content);
}
ok(/return attachLoadFailure\(outcome\);/.test(GEN) && /return await attachLoadFailure\(await _runToolRounds\(/.test(GEN),
   'both chat paths (send and regenerate) go through it, with or without tools');
ok(/const outcome = await attachLoadFailure\(await runGenerationStream\(thread, msg, null, \{ resumeJobId: jobId \}\)\);/.test(CHAT),
   'and so does a reply collected after a reload');

console.log('\n=== C. the landing page ===');
function dashContext(vals) {
  const ctx = Object.assign({ escapeHtml, serverConnected: false, serverOfflinePhase: 'error', serverOfflineReason: '',
                              serverOfflineAdvice: '', serverOfflineCause: '' }, vals);
  vm.createContext(ctx);
  vm.runInContext(fnBody(DASH, 'function offlineStatusHtml()') + fnBody(DASH, 'function offlineDetailsHtml()'), ctx);
  return ctx;
}
{
  const ctx = dashContext({ serverOfflineReason: OOM.message, serverOfflineAdvice: OOM.advice, serverOfflineCause: OOM.cause });
  const pill = ctx.offlineStatusHtml();
  ok(pill.includes('OFFLINE — Not enough GPU or system memory') && pill.includes('title="alloc_tensor_range'), 'the pill says the sentence; its tooltip keeps the raw line', pill);
  const det = ctx.offlineDetailsHtml();
  ok(/<details class="landing-offline-details"><summary>details<\/summary><code>alloc_tensor_range: failed to allocate/.test(det), 'the raw line is under "details"', det);
  ok(det.includes('llama-server.log') && !/\/home|C:\\\\/.test(det), 'it names the log file, not a folder of this PC');
}
{
  const ctx = dashContext({ serverOfflineReason: '<img src=x onerror=alert(1)>', serverOfflineAdvice: '' });
  ok(!ctx.offlineStatusHtml().includes('<img') && !ctx.offlineDetailsHtml().includes('<img'), 'a line from the engine is escaped in both places');
  const old = dashContext({ serverOfflineReason: 'ggml_vulkan: ErrorOutOfDeviceMemory' });
  ok(old.offlineStatusHtml().includes('OFFLINE — ggml_vulkan: ErrorOutOfDeviceMemory'), 'no advice (an older server): the line itself, as before');
  ok(dashContext({ serverConnected: true, serverOfflineReason: 'x' }).offlineDetailsHtml() === '', 'connected: no details');
  ok(dashContext({ serverOfflinePhase: 'starting', serverOfflineReason: 'x.gguf' }).offlineDetailsHtml() === '', 'still loading: no details');
  ok(/\$\{offlineDetailsHtml\(\)\}/.test(DASH), 'the landing header shows it');
}
{
  const ctx = { IS_SERVED: true, serverOfflineReason: 'stale', serverOfflinePhase: '', serverOfflineCause: 'x', serverOfflineAdvice: 'stale',
                fetch: async () => ({ ok: true, json: async () => OOM }) };
  vm.createContext(ctx);
  vm.runInContext(fnBody(SEARCH, 'async function refreshOfflineReason()'), ctx);
  await ctx.refreshOfflineReason();
  ok(ctx.serverOfflineCause === 'out_of_memory' && ctx.serverOfflineAdvice === OOM.advice && ctx.serverOfflineReason === OOM.message,
     'refreshOfflineReason reads cause, advice and the line from /swap-status');
  ctx.fetch = async () => ({ ok: true, json: async () => ({ phase: 'starting', name: 'b.gguf' }) });
  await ctx.refreshOfflineReason();
  ok(ctx.serverOfflineCause === '' && ctx.serverOfflineAdvice === '' && ctx.serverOfflineReason === 'b.gguf', 'and clears them when loading again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
