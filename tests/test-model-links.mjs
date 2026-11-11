/**
 * Model links (1.8.0, roadmap #10, issue #52): a chat remembers the model that
 * wrote its last reply, a character can be linked to a model, and opening the
 * chat asks for (or makes) the switch.
 *
 * Drives the REAL js/02-model.js in a minimal fake DOM, as
 * test-remote-models.mjs does, plus source-level checks of the wiring.
 *
 *   A. Names: isPlainModelFile is the server's rule (internal/models/name.go).
 *   B. Precedence: the chat's own model, then the answering character's link,
 *      then nothing; a bad name never counts.
 *   C. Ask first (the default): a bar, a Switch button with the load time, and
 *      nothing swapped until it is pressed; then {file, auto: true}.
 *   D. Switch automatically, Don't switch, remote mode, already loaded, a reply
 *      being written here: each does what it says and nothing more.
 *   E. A model that is not installed: said once, the loaded model is used, the
 *      link is kept, and one click clears it. An imported card linked to an
 *      absent model leaves the loaded model alone.
 *   F. Busy: the server's 409 is offered as "switch when done", and waiting
 *      switches once nothing is being written.
 *   G. Remembering: noteReplyModel writes thread.model only when it changes.
 *   H. Wiring: thread open and new thread follow, a send from the landing page
 *      does not; every reply path remembers; the editor menu, the CONFIG
 *      choice, and card files carry a plain file name only.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = p => fs.readFileSync(ROOT + '/' + p, 'utf8');
const MODEL_JS = read('js/02-model.js');
const THREADS = read('js/09-threads.js');
const CHAT = read('js/10-chat.js');
const CARDS = read('js/15-cards.js');
const CARDIO = read('js/16-card-io.js');
const STATE = read('js/04-state.js');
const HTML = read('chat.html');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, label) => ok(a === b, label, a === b ? undefined : { got: a, want: b });

/* A DOM node good enough for the bar: children, text, buttons. */
function node(tag) {
  const n = {
    tag, children: [], className: '', attrs: {}, onclick: null, type: '', _text: '',
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
  };
  return n;
}
const buttons = el => {
  const out = [];
  const walk = n => { if (n.tag === 'button') out.push(n); (n.children || []).forEach(walk); };
  walk(el);
  return out;
};
const press = async (el, label) => {
  const b = buttons(el).find(x => x.textContent.startsWith(label));
  if (!b) throw new Error('no button "' + label + '" in: ' + el.textContent);
  await b.onclick();
};

const LIST = {
  models: [
    { file: 'alpha.gguf', name: 'Alpha 7B', active: false },
    { file: 'beta.gguf', name: 'Beta 12B', active: true },
  ]
};

function build({ list = LIST, status = { phase: 'ready', file: 'beta.gguf', started_at: 100, updated_at: 103 },
                 settings = {}, swapAnswer = null, remote = false, served = true } = {}) {
  const bar = node('div');
  const toast = { textContent: '', className: '', classList: { add() {}, remove() {} } };
  const sel = { value: 'beta.gguf', disabled: false, options: [], selectedIndex: 0 };
  const calls = [];
  const live = { status: Object.assign({}, status), swapAnswer, saves: 0 };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    IS_SERVED: served,
    window: { location: { origin: 'http://127.0.0.1:9066' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    MODEL_REGISTRY: {},
    state: { activeThreadId: 't1', settings: Object.assign({}, settings) },
    activeCard: { id: 'c1', name: 'Ana', preferredModel: '' },
    getActiveCard: () => ctx.activeCard,
    saveState() { live.saves++; },
    updateModelHint() {},
    isGenerating: false,
    document: {
      getElementById: id => ({ 'model-follow': bar, 'model-switch-toast': toast, 'header-model-select': sel }[id] || null),
      createElement: tag => node(tag),
      createTextNode: t => ({ textContent: String(t) }),
    },
    escapeHtml: s => String(s),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      const reply = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });
      if (url.startsWith('/models-list.json')) return reply(200, remote ? { mode: 'remote', models: [] } : list);
      if (url.startsWith('/swap-status')) return reply(200, live.status);
      if (url === '/swap-model') {
        const b = JSON.parse(opts.body);
        if (live.swapAnswer) { const a = live.swapAnswer(b); if (a) return reply(a.code, a.body); }
        live.status = { phase: 'ready', file: b.file, started_at: 200, updated_at: 202 };
        return reply(202, { phase: 'starting', file: b.file });
      }
      if (url.startsWith('/active-model.json')) return reply(200, { ggufFile: live.status.file, name: live.status.file });
      return reply(404, {});
    }
  };
  vm.createContext(ctx);
  vm.runInContext(MODEL_JS, ctx);
  if (remote) vm.runInContext('_remoteMode = true', ctx);
  vm.runInContext('_currentModelFile = "beta.gguf"', ctx);
  const swaps = () => calls.filter(c => c.url === '/swap-model').map(c => JSON.parse(c.body));
  return { ctx, bar, toast, calls, live, swaps };
}
const thread = (extra = {}) => Object.assign({ id: 't1', messages: [] }, extra);
const settle = () => new Promise(r => setTimeout(r, 60));

console.log('\n=== A. a model name is a plain .gguf file name, as the server says ===');
{
  const { ctx } = build();
  for (const good of ['alpha.gguf', 'Model-Q4_K_M.GGUF', 'a b (1).gguf', 'x'.repeat(250) + '.gguf']) {
    ok(ctx.isPlainModelFile(good), 'accepted: ' + good.slice(0, 40));
  }
  for (const bad of ['', '.gguf', '../alpha.gguf', 'sub/alpha.gguf', 'sub\\alpha.gguf', 'C:alpha.gguf',
                     'alpha.gguf:stream', 'alpha.txt', 'alpha.gguf\n', 'x'.repeat(251) + '.gguf', null, 42, { file: 'a.gguf' }]) {
    ok(!ctx.isPlainModelFile(bad), 'refused: ' + JSON.stringify(bad).slice(0, 40));
  }
  const GO = read('internal/models/name.go');
  ok(/maxFileName = 255/.test(GO) && /case r == '\/' \|\| r == '\\\\'/.test(GO) && /case r == ':'/.test(GO),
     'the same limits as models.CheckFileName: 255 characters, no separator, no colon');
}

console.log('\n=== B. which model a chat wants ===');
{
  const { ctx } = build();
  const card = { id: 'c', name: 'Ana', preferredModel: 'alpha.gguf' };
  eq(ctx.linkedModelFor(thread({ model: 'beta.gguf' }), card).file, 'beta.gguf', 'the chat\'s own model comes first');
  eq(ctx.linkedModelFor(thread({ model: 'beta.gguf' }), card).from, 'thread', '  and says so');
  eq(ctx.linkedModelFor(thread(), card).file, 'alpha.gguf', 'a chat with none follows its character\'s link');
  eq(ctx.linkedModelFor(thread(), card).from, 'card', '  and says so');
  eq(ctx.linkedModelFor(thread(), { preferredModel: '' }), null, 'neither: nothing changes');
  eq(ctx.linkedModelFor(thread({ model: '../evil.gguf' }), card).file, 'alpha.gguf', 'a bad name on the chat never counts');
  eq(ctx.linkedModelFor(thread(), { preferredModel: '/home/me/x.gguf' }), null, 'nor a path on the card');
  eq(ctx.modelFollowMode(), 'ask', 'the default is Ask first');
  ctx.state.settings.modelFollow = 'sideways';
  eq(ctx.modelFollowMode(), 'ask', 'an unknown value is Ask first too');
}

console.log('\n=== C. Ask first ===');
{
  const t = build();
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  ok(/This chat used Alpha 7B\./.test(t.bar.textContent), 'the bar names the model the chat used', t.bar.textContent);
  ok(buttons(t.bar).some(b => b.textContent === 'Switch (about 3 s)') && buttons(t.bar).some(b => b.textContent === 'Not now'),
     'with Switch, the last load time, and Not now', buttons(t.bar).map(b => b.textContent));
  eq(t.swaps().length, 0, 'nothing is swapped until it is pressed');
  await press(t.bar, 'Switch');
  eq(JSON.stringify(t.swaps()), JSON.stringify([{ file: 'alpha.gguf', auto: true }]), 'Switch sends {file, auto: true}');
  eq(t.live.status.file, 'alpha.gguf', '  and the model is switched');
  eq(t.bar.textContent, '', '  and the bar goes');
}
{
  const t = build();
  t.ctx.activeCard.preferredModel = 'alpha.gguf';
  await t.ctx.followModelForThread(thread());
  ok(/^Ana is linked to Alpha 7B\./.test(t.bar.textContent), 'a new chat names the character\'s link', t.bar.textContent);
  await press(t.bar, 'Not now');
  eq(t.bar.textContent, '', 'Not now closes it');
  eq(t.swaps().length, 0, '  and switches nothing');
}
{
  const t = build({ status: { phase: 'ready', file: 'beta.gguf' } });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  ok(buttons(t.bar).some(b => b.textContent === 'Switch'), 'no load time known: just Switch');
  eq(t.ctx.swapEtaText({ phase: 'ready', started_at: 10, updated_at: 33 }), 'about 25 s', 'load times are rounded');
  eq(t.ctx.swapEtaText({ phase: 'ready', started_at: 10, updated_at: 250 }), 'about 4 min', 'and long ones are minutes');
  eq(t.ctx.swapEtaText({ phase: 'starting', started_at: 10, updated_at: 33 }), '', 'only a finished load counts');
}

console.log('\n=== D. the other settings, and when nothing should happen ===');
{
  const t = build({ settings: { modelFollow: 'auto' } });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(JSON.stringify(t.swaps()), JSON.stringify([{ file: 'alpha.gguf', auto: true }]), 'Switch automatically: swaps as auto, without asking');
  eq(t.bar.textContent, '', '  and shows no bar');
}
{
  const t = build({ settings: { modelFollow: 'off' } });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t.calls.length, 0, "Don't switch: nothing is even asked of the server");
}
{
  const t = build({ remote: true });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t.calls.length, 0, 'remote mode: nothing (no hot-swap there)');
  const t2 = build({ served: false });
  await t2.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t2.calls.length, 0, 'a page opened from a file: nothing');
}
{
  const t = build();
  await t.ctx.followModelForThread(thread({ model: 'beta.gguf' }));
  eq(t.bar.textContent + t.swaps().length, '0', 'the chat\'s model is already loaded: no bar, no swap');
  await t.ctx.followModelForThread(thread());
  eq(t.calls.length, 2, 'no link at all: only the checks above went out', t.calls.map(c => c.url));
}
{
  const t = build({ settings: { modelFollow: 'auto' } });
  t.ctx.isGenerating = true;
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t.swaps().length, 0, 'a reply being written on this page: no automatic switch under it');
  const t2 = build({ settings: { modelFollow: 'auto' }, status: { phase: 'starting', file: 'gamma.gguf' } });
  await t2.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t2.swaps().length, 0, 'a swap already under way is left alone');
  const t3 = build({ settings: { modelFollow: 'auto' } });
  t3.ctx.state.activeThreadId = 'elsewhere';
  await t3.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  eq(t3.swaps().length, 0, 'the chat was left while the server was asked: nothing');
}

console.log('\n=== E. a model that is not installed ===');
{
  const t = build({ settings: { modelFollow: 'auto' } });
  const th = thread({ model: 'gone.gguf' });
  await t.ctx.followModelForThread(th);
  ok(/This chat used gone, which is not installed here, so the loaded model answers\./.test(t.bar.textContent),
     'it says so, and that the loaded model answers', t.bar.textContent);
  eq(t.swaps().length, 0, 'nothing is swapped, even set to switch automatically');
  eq(th.model, 'gone.gguf', 'the link is kept (a model on an unplugged drive keeps it)');
  t.bar.textContent = '';
  await t.ctx.followModelForThread(th);
  eq(t.bar.textContent, '', 'said once per chat, not on every open');
  const t2 = build();
  const th2 = thread({ model: 'gone.gguf' });
  await t2.ctx.followModelForThread(th2);
  await press(t2.bar, 'Forget it');
  eq(th2.model, undefined, 'Forget it clears the chat\'s link in one click');
  eq(t2.live.saves, 1, '  and saves');
}
{
  // An imported card naming a model this PC does not have.
  const t = build({ settings: { modelFollow: 'auto' } });
  t.ctx.activeCard = { id: 'imp', name: 'Stranger', preferredModel: 'their-70B.gguf' };
  await t.ctx.followModelForThread(thread({ id: 't1' }));
  eq(t.swaps().length, 0, 'an imported card linked to an absent model leaves the loaded model alone');
  eq(t.live.status.file, 'beta.gguf', '  the loaded model is still loaded');
  ok(/Stranger is linked to their 70B, which is not installed here/.test(t.bar.textContent), '  and the bar says why', t.bar.textContent);
  ok(t.calls.every(c => c.url === '/models-list.json' || c.url === '/swap-status'), '  and nothing was fetched from anywhere else');
  await press(t.bar, 'Clear link');
  eq(t.ctx.activeCard.preferredModel, '', 'Clear link clears the character\'s link in one click');
}

console.log('\n=== F. never over someone else\'s reply ===');
{
  let busy = true;
  const t = build({ swapAnswer: () => busy ? { code: 409, body: { busy: true, phase: 'ready', message: 'a reply is being written' } } : null });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  await press(t.bar, 'Switch');
  ok(/A reply is being written right now, on this device or another\. Switch to Alpha 7B when it is done\?/.test(t.bar.textContent),
     'a 409 busy is offered as a switch once the reply is done', t.bar.textContent);
  eq(t.live.status.file, 'beta.gguf', '  and the loaded model is untouched');
  ok(!/Swap failed/.test(t.toast.textContent), '  and it is not shown as a failure', t.toast.textContent);
  t.live.status = { phase: 'ready', file: 'beta.gguf', busy: true };
  await press(t.bar, 'Switch when done');
  ok(/Waiting for the reply to finish, then switching to Alpha 7B\./.test(t.bar.textContent), 'waiting says what it is waiting for');
  await settle();
  eq(t.live.status.file, 'beta.gguf', 'still busy: still waiting');
  busy = false;
  t.live.status = { phase: 'ready', file: 'beta.gguf' };
  await settle(); await settle();
  eq(t.live.status.file, 'alpha.gguf', 'nothing being written any more: switched');
  eq(t.bar.textContent, '', '  and the bar is gone');
  ok(t.swaps().every(b => b.auto === true), 'every switch it made went as auto, so the server could refuse it');
}
{
  const t = build({ swapAnswer: () => ({ code: 409, body: { busy: true } }) });
  await t.ctx.followModelForThread(thread({ model: 'alpha.gguf' }));
  await press(t.bar, 'Switch');
  t.live.status = { phase: 'ready', file: 'beta.gguf', busy: true };
  await press(t.bar, 'Switch when done');
  t.ctx.state.activeThreadId = 'another';
  await settle();
  eq(t.bar.textContent, '', 'leaving the chat ends the wait');
  const n = t.swaps().length;
  await settle();
  eq(t.swaps().length, n, '  and nothing more is sent');
}

console.log('\n=== G. remembering the model that wrote the reply ===');
{
  const t = build();
  const th = thread();
  await t.ctx.noteReplyModel(th);
  eq(th.model, 'beta.gguf', 'a reply records the loaded model on its chat');
  eq(t.live.saves, 1, '  and saves');
  await t.ctx.noteReplyModel(th);
  eq(t.live.saves, 1, 'the same model again: the chat is not rewritten (or re-uploaded)');
  t.live.status = { phase: 'starting', file: 'alpha.gguf' };
  await t.ctx.noteReplyModel(th);
  eq(th.model, 'beta.gguf', 'mid-swap: nothing recorded');
  t.live.status = { phase: 'ready', file: '../x.gguf' };
  await t.ctx.noteReplyModel(th);
  eq(th.model, 'beta.gguf', 'a name that is not a plain file name is never recorded');
  const r = build({ remote: true });
  const th2 = thread();
  await r.ctx.noteReplyModel(th2);
  eq(th2.model, undefined, 'remote mode records nothing');
}

console.log('\n=== H. wiring ===');
{
  const sw = THREADS.slice(THREADS.indexOf('function switchThread(id) {'), THREADS.indexOf('function getActiveThread()'));
  ok(/followModelForThread\(getActiveThread\(\)\);/.test(sw), 'opening a chat follows its model');
  const ct = THREADS.slice(THREADS.indexOf('function createThread(opts) {'), THREADS.indexOf('/* Activity-based ordering'));
  ok(/if \(!\(opts && opts\.fromSend\) && typeof followModelForThread === 'function'\) followModelForThread\(thread\);/.test(ct),
     'a new chat follows its character\'s link');
  ok(/createThread\(\{ fromSend: true \}\);/.test(CHAT), 'but not one made by sending from the landing page: that message is already going');
  eq((CHAT.match(/noteReplyModel\(thread\)/g) || []).length, 3, 'every reply path remembers its model: send, regenerate, resumed job');
  ok(/preferredModel: '',/.test(STATE) && /modelFollow: 'ask',/.test(STATE), 'defaults: no link, Ask first');
  ok(/<select id="card-preferred-model" onchange="updatePreferredModelNote\(\)">\s*<option value="">Whatever is loaded \(default\)<\/option>/.test(HTML),
     'the character editor has "Model for this character", defaulting to whatever is loaded');
  ok(/card\.preferredModel = isPlainModelFile\(preferred\) \? preferred : '';/.test(CARDS), 'saving the card keeps a plain file name or nothing');
  ok(/o\.textContent = want \+ '  \(not installed\)';/.test(CARDS) && /group\.style\.display = \(!data \|\| data\.mode === 'remote'\) \? 'none' : '';/.test(CARDS),
     'a missing link shows as not installed; the menu is hidden in remote mode');
  ok(/isPlainModelFile\(card\.preferredModel\)\) g\.preferredModel = card\.preferredModel;/.test(CARDIO), 'a card file carries the link as a file name only');
  ok(/card\.preferredModel = \(typeof isPlainModelFile === 'function' && isPlainModelFile\(pm\)\) \? pm : '';/.test(CARDIO),
     'an imported link is kept only if it is a plain file name');
  ok(/name="set-model-follow" value="ask"/.test(HTML) && /name="set-model-follow" value="auto"/.test(HTML) && /name="set-model-follow" value="off"/.test(HTML),
     'CONFIG > Characters & Chat > Model Switching has the three choices');
  ok(/state\.settings\.modelFollow = followPick\.value;/.test(CARDS) && /el\.checked = \(el\.value === modelFollowMode\(\)\);/.test(CARDS),
     '  saved by SAVE, and shown as it will apply');
  ok(/<div class="cast-mismatch-live" id="model-follow" role="status"><\/div>/.test(HTML), 'the bar is announced, in the cast-mismatch strip style');
  ok(!/innerHTML/.test(MODEL_JS.slice(MODEL_JS.indexOf('function showModelFollowBar('), MODEL_JS.indexOf('function cancelModelFollowWait('))),
     'the bar is built from text nodes: names from model files and cards never become markup');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
