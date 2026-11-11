/**
 * Prompt Order: where the retrieved lorebook snippets go (CONFIG > Prompt
 * Order, settings.retrievalNearEnd).
 *
 * Reported as PSU trouble: a long chat works the graphics card hard on every
 * message. llama-server keeps the last prompt it read and reuses it up to the
 * first difference. The snippets change from message to message and sat near
 * the top, with the character, so the whole conversation below them was read
 * again every time. With the setting on they go just before the newest
 * message and only the end of the prompt changes.
 *
 * Runs the real buildContextMessages (js/08-rag.js) and the real
 * normalizeMessagesForStrictTemplates (js/07-prompt.js). Retrieval is stubbed
 * to return a different snippet each turn, as a lorebook does in a scene that
 * moves; section E uses the real retriever.
 *
 *   A. Off (the default, and any settings saved before the option): the order
 *      is what it was.
 *   B. On: character and lore -> conversation -> snippets -> new message,
 *      with the response direction and persona still closest to the message.
 *   C. What the engine reads again each turn, measured on the rendered
 *      prompt: on, only the end; off, nearly all of it.
 *   D. Edge cases: nothing sent yet, a reroll, strict chat templates, models
 *      that fold the system block into the first message.
 *   E. Nothing is lost or added: same snippets, same token count, either way.
 *   F. Wiring: CONFIG, saving, the [ui] preset, the record.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const RAG = read('js/08-rag.js');
const PROMPT = read('js/07-prompt.js');
const STATE = read('js/04-state.js');
const CARDS = read('js/15-cards.js');
const HTML = read('chat.html');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 700) : '')); }
};
const between = (src, from, to, file) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) { console.error(`could not locate ${JSON.stringify(from)} in ${file}`); process.exit(1); }
  return src.slice(a, b);
};
const NORMALIZE = between(PROMPT, 'function normalizeMessagesForStrictTemplates', '\n}\n', 'js/07-prompt.js') + '\n}\n';
const ESTIMATE = between(PROMPT, 'function estimateTokens(text)', 'function getThreadLore', 'js/07-prompt.js');

const SETTINGS = {
  retrievalEnabled: true, retrieverA: true, retrieverB: true, fireThreshold: 1.0, warmthTurns: 2,
  expansionDepth: 1, semanticBackstop: true, topKA: 5, retrievalBudgetTokens: 6000, retrievalWindowMsgs: 4,
};

/* The page, as far as buildContextMessages needs it. `snippets` is what the
   stubbed retriever hands back this turn; `carousel` and `persona` are the two
   per-message blocks that already sit next to the newest message. */
function page({ settings = {}, family = 'llama', persona = '', carousel = '', realRetrieval = false } = {}) {
  const c = {
    console: { log() {}, warn() {}, debug() {}, error() {} },
    Map, Set, Math, JSON, Object, Array, String, Number, Date, RegExp, Promise, Error,
    window: { dispatchEvent() {} }, CustomEvent: function () {}, performance: { now: () => 0 },
    state: { settings: { ...SETTINGS, ...settings } },
    activeModel: { name: 'test', family },
    STORAGE_BACKEND: 'memory', _idb: null, EMBED_URL: '/embed',
    fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),   // no embedding server
    resolveContextLimit: () => 32768,
    resolveContextBudget: () => ({ input: 0.9, reply: 0.2, land: 0.65, keep: 0.22 }),
    getActivePersona: () => ({ name: 'Ren', description: persona, injectionFrequency: persona ? 1 : 0 }),
    getThreadLore: () => '',
    translateTemplates: (t) => String(t ?? ''),
    runCardHook: () => {}, pickCarouselLine: () => carousel, saveState: () => {}, renderMessages: () => {},
  };
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(ESTIMATE + RAG + NORMALIZE, c);
  c.snippets = [];
  if (!realRetrieval) {
    c.runRetrieval = async () => ({
      retrievalTokens: c.snippets.reduce((n, s) => n + c.estimateTokens(s.text) + 4, 0),
      injections: c.snippets.map(s => ({ label: s.label, text: s.text, entityId: s.label })),
    });
  }
  return c;
}

const card = (extra = {}) => ({
  id: 'c1', name: 'Aria', personality: 'Aria is a cartographer.', writingStyle: 'Write in third person.',
  startingLore: 'The city of Vell sits on a river delta.', loreEnabled: true, ragStorybook: '', memoryFiles: [], ...extra,
});
const line = (i) => `Message ${i}: the expedition crossed another stretch of the delta and mapped the channels as they went. `.repeat(4);
function longThread(n = 30) {
  const messages = [];
  for (let i = 0; i < n; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: line(i) });
  messages.push({ role: 'user', content: 'Where do we go next?' });
  return { id: 't1', messages };
}
const snip = (k) => [{ label: 'Storybook: ' + k, text: `${k} is a place on the delta, known for its ${k.length}-arched bridge.` }];
const render = (msgs) => msgs.map(m => `<|${m.role}|>\n${m.content}\n`).join('') + '<|assistant|>\n';
const shared = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const build = async (c, thread, cardObj = card()) => (await c.buildContextMessages(thread, cardObj, {})).apiMessages;
const firstLines = (msgs) => msgs.map(m => m.role[0] + ':' + m.content.split('\n')[0].slice(0, 40));

/* ================================================================ A */
console.log('\n=== A. off: the order it has always had ===');
for (const [label, settings] of [['absent (settings saved before the option)', {}], ['false', { retrievalNearEnd: false }],
                                 ['a non-boolean ("yes")', { retrievalNearEnd: 'yes' }]]) {
  const c = page({ settings });
  c.snippets = snip('Harrowgate');
  const out = await build(c, longThread());
  const sys = out[0];
  ok(out[0].role === 'system' && /\[Storybook: Harrowgate\]/.test(sys.content), `${label}: the snippet is in the system block at the top`);
  ok(sys.content.indexOf('[Storybook: Harrowgate]') < sys.content.indexOf('Write in third person.'),
     `${label}: before the writing style, as before`);
  ok(!/\[Storybook/.test(out.at(-1).content), `${label}: and not with the newest message`);
}

/* ================================================================ B */
console.log('\n=== B. on: conversation, then snippets, then the new message ===');
{
  const c = page({ settings: { retrievalNearEnd: true }, persona: 'Ren is a surveyor.', carousel: 'Keep it short.' });
  c.snippets = snip('Harrowgate');
  // Before the normaliser, to see the order as built.
  c.normalizeMessagesForStrictTemplates = (m) => m;
  const raw = await build(c, longThread());
  const idx = (re) => raw.findIndex(m => re.test(m.content));
  const iSnip = idx(/^\[Storybook: Harrowgate\]/), iDir = idx(/^\[Narrative direction/), iPers = idx(/^\[Persona: Ren\]/);
  const iLast = raw.length - 1, iFirstConvo = raw.findIndex(m => m.role !== 'system');
  ok(raw[iLast].role === 'user' && raw[iLast].content === 'Where do we go next?', 'the newest message is last');
  ok(iFirstConvo < iSnip && iSnip < iDir && iDir < iPers && iPers < iLast,
     'order: conversation -> snippets -> response direction -> persona -> newest message', firstLines(raw).slice(-6).join(' | '));
  ok(raw.slice(0, iFirstConvo).every(m => !/Storybook/.test(m.content)), 'the blocks at the top no longer carry the snippet');
  const top = raw.slice(0, iFirstConvo).map(m => m.content.split('\n')[0]);
  ok(top.join('|') === '[Lore]|[Character: Aria]|Write in third person.', 'the top is character and lore, unchanged', top.join('|'));

  // After the real normaliser: what llama-server receives.
  const c2 = page({ settings: { retrievalNearEnd: true } });
  c2.snippets = snip('Harrowgate');
  const out = await build(c2, longThread());
  ok(out.filter(m => m.role === 'system').length === 1 && out[0].role === 'system', 'one system message, at the start');
  ok(out.at(-1).role === 'user' && out.at(-1).content.startsWith('[System: [Storybook: Harrowgate]')
     && out.at(-1).content.endsWith('Where do we go next?'), 'the snippet rides on the newest message, marked [System: ...]', out.at(-1).content.slice(0, 120));
  let alternates = true;
  for (let i = 2; i < out.length; i++) if (out[i].role === out[i - 1].role) alternates = false;
  ok(alternates, 'user and assistant still alternate, so strict templates (Mistral Nemo) accept it');
}

/* ================================================================ C */
console.log('\n=== C. what is read again each message ===');
async function session(nearEnd, turns = 4) {
  const c = page({ settings: { retrievalNearEnd: nearEnd } });
  const thread = longThread(30);
  const places = ['Harrowgate', 'Saltmarsh', 'Ombry', 'Kestrel Ford', 'Tamsin'];
  const reread = [];
  let prev = null, size = 0;
  for (let t = 0; t < turns; t++) {
    c.snippets = snip(places[t]);
    const prompt = render(await build(c, thread));
    if (prev !== null) reread.push(prompt.length - shared(prev, prompt));
    prev = prompt; size = prompt.length;
    thread.messages.push({ role: 'assistant', content: `Reply ${t}: we head on through the reeds toward ${places[t]}.` });
    thread.messages.push({ role: 'user', content: `And after ${places[t]}?` });
  }
  return { reread, size };
}
{
  const off = await session(false), on = await session(true);
  const pct = (r, s) => Math.round(100 * r / s);
  const offAvg = off.reread.reduce((a, b) => a + b, 0) / off.reread.length;
  const onAvg = on.reread.reduce((a, b) => a + b, 0) / on.reread.length;
  console.log(`      prompt ~${on.size} characters; read again per message: off ${Math.round(offAvg)} (${pct(offAvg, off.size)}%), on ${Math.round(onAvg)} (${pct(onAvg, on.size)}%)`);
  ok(off.reread.every(r => r > 0.9 * off.size), 'off: a changed snippet means nearly the whole prompt is read again', off.reread.join(', '));
  ok(on.reread.every(r => r < 0.1 * on.size), 'on: only the end is read again', on.reread.join(', '));
  ok(onAvg * 10 < offAvg, 'at least ten times less to read again in this chat', `${onAvg} vs ${offAvg}`);

  // What is read again, on: the previous newest message and everything after.
  const c = page({ settings: { retrievalNearEnd: true } });
  const thread = longThread(30);
  c.snippets = snip('Harrowgate');
  const p1 = render(await build(c, thread));
  thread.messages.push({ role: 'assistant', content: 'Reply: toward Harrowgate.' }, { role: 'user', content: 'And then?' });
  c.snippets = snip('Saltmarsh');
  const p2 = render(await build(c, thread));
  const cut = shared(p1, p2);
  ok(p2.slice(0, cut).includes(line(29)) && p2.slice(0, cut).endsWith('<|user|>\n') && p2.slice(cut).startsWith('Where do we go next?'),
     'the reuse runs to the start of the previous message, the one that carried last turn\'s snippet', JSON.stringify(p2.slice(cut, cut + 60)));

  // Same snippet two turns running: on, still only the end changes.
  const same = page({ settings: { retrievalNearEnd: true } });
  const th = longThread(30);
  same.snippets = snip('Ombry');
  const q1 = render(await build(same, th));
  th.messages.push({ role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'More?' });
  const q2 = render(await build(same, th));
  ok(q2.length - shared(q1, q2) < 0.1 * q2.length, 'an unchanged snippet costs no more than a changed one');
}

/* ================================================================ D */
console.log('\n=== D. edge cases ===');
{
  // Nothing to put the snippet in front of: where it always was.
  const c = page({ settings: { retrievalNearEnd: true } });
  c.snippets = snip('Harrowgate');
  c.normalizeMessagesForStrictTemplates = (m) => m;
  const greetingOnly = await build(c, { id: 't', messages: [{ role: 'assistant', content: 'Welcome to Vell.' }] });
  ok(greetingOnly.findIndex(m => /Storybook/.test(m.content)) < greetingOnly.findIndex(m => m.role === 'assistant'),
     'no user message yet: the snippet stays at the top rather than going missing');

  // A reroll: the last message is the empty slot being rewritten.
  const reroll = longThread(10);
  reroll.messages.push({ role: 'assistant', content: '' });
  const r = await build(c, reroll);
  const iSnip = r.findIndex(m => /Storybook/.test(m.content));
  ok(r[iSnip + 1].role === 'user' && r[iSnip + 1].content === 'Where do we go next?', 'a reroll: still just before the newest user message');

  // Normalised, the reroll ends on that user message.
  const c2 = page({ settings: { retrievalNearEnd: true } });
  c2.snippets = snip('Harrowgate');
  const rn = await build(c2, reroll);
  ok(rn.at(-1).role === 'user' && /^\[System: \[Storybook: Harrowgate\]/.test(rn.at(-1).content), 'and what is sent ends on it, snippet attached');

  // DeepSeek / Qwen fold the system block into the first user message. First
  // message of a chat: the block and the snippet both land on it.
  const q = page({ settings: { retrievalNearEnd: true }, family: 'qwen' });
  q.snippets = snip('Harrowgate');
  const first = await build(q, { id: 't', messages: [{ role: 'user', content: 'Hello.' }] });
  ok(first.length === 1 && first[0].role === 'user' && first[0].content.startsWith('[Lore]')
     && first[0].content.includes('[Storybook: Harrowgate]') && first[0].content.endsWith('Hello.'),
     'Qwen, first message: the character, then the snippet, then the message, in one user turn', JSON.stringify(first).slice(0, 300));
  const later = await build(q, longThread(6));
  ok(later.at(-1).content.startsWith('[System: [Storybook: Harrowgate]') && !later[0].content.includes('Storybook'),
     'Qwen, later: the folded block at the top stays the same, the snippet goes with the newest message');

  // No snippets this turn: on and off send exactly the same thing.
  const a = page({ settings: { retrievalNearEnd: true } }), b = page({ settings: { retrievalNearEnd: false } });
  ok(JSON.stringify(await build(a, longThread())) === JSON.stringify(await build(b, longThread())),
     'a turn with no snippets is identical either way');
}

/* ================================================================ E */
console.log('\n=== E. nothing lost, nothing added ===');
{
  const snippets = [...snip('Harrowgate'), ...snip('Saltmarsh')];
  const a = page({ settings: { retrievalNearEnd: true } }), b = page({ settings: { retrievalNearEnd: false } });
  a.snippets = snippets; b.snippets = snippets;
  const ra = await a.buildContextMessages(longThread(), card(), {}), rb = await b.buildContextMessages(longThread(), card(), {});
  const found = (msgs) => snippets.every(s => msgs.some(m => m.content.includes(s.text)));
  ok(found(ra.apiMessages) && found(rb.apiMessages), 'every snippet reaches the model either way');
  ok(ra.tokensUsed === rb.tokensUsed && ra.budget === rb.budget, 'the same token count and budget', `${ra.tokensUsed} / ${rb.tokensUsed}`);
  const words = (msgs) => msgs.map(m => m.content).join(' ').replace(/\[System: |\]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  ok(words(ra.apiMessages) === words(rb.apiMessages), 'the same words reach the model; only where they sit differs');

  // The real retriever (tags, no embedding server), with the setting on.
  const book = '# harrowgate\nA town of nine bridges.\ntags: harrowgate [1.0], bridges [0.5]';
  const real = page({ settings: { retrievalNearEnd: true }, realRetrieval: true });
  const t = longThread(6);
  t.messages.at(-1).content = 'Shall we cross into Harrowgate?';
  const out = await build(real, t, card({ ragStorybook: book }));
  ok(/nine bridges/.test(out.at(-1).content) && !/nine bridges/.test(out[0].content),
     'with the real retriever: the fired entry goes with the newest message, not the top', firstLines(out).join(' | '));
}

/* ================================================================ F */
console.log('\n=== F. wiring ===');
{
  const defaults = between(STATE, 'const DEFAULT_SETTINGS = {', '\n};', 'js/04-state.js');
  ok(/\n  retrievalNearEnd: false\n?$/.test(defaults) || /retrievalNearEnd: false/.test(defaults), 'off by default (DEFAULT_SETTINGS.retrievalNearEnd = false)');
  ok(/state\.settings\.retrievalNearEnd === true/.test(RAG), 'only a real true turns it on');
  // 1.7.9 (F3): in CONFIG's Advanced section, followed by Lore Compression.
  const box = between(HTML, 'id="prompt-order-group"', '&#128221; Lore Compression', 'chat.html');
  ok(between(HTML, 'id="cfg-advanced"', '</details>', 'chat.html').includes('id="prompt-order-group"'), 'in the Advanced section');
  ok(/<input type="checkbox" id="set-retrieval-near-end">/.test(box) && /Put lorebook snippets just before my newest message/.test(box),
     'CONFIG has the switch, in its own Prompt Order box');
  ok(/character and lore &rarr; the conversation &rarr; lorebook snippets &rarr; your new message/.test(box), 'it spells out the order it gives');
  ok(/<strong>Planned:<\/strong> arranging the whole prompt yourself/.test(box), 'and the plan to hand over the whole order');
  ok(HTML.indexOf('id="settings-modal"') < HTML.indexOf('id="prompt-order-group"')
     && HTML.indexOf('id="prompt-order-group"') < HTML.indexOf('<!-- MODEL CATALOGUE MODAL'), 'inside CONFIG');
  ok(/getElementById\('set-retrieval-near-end'\)\.checked = \(state\.settings\.retrievalNearEnd === true\)/.test(CARDS), 'CONFIG shows the saved choice');
  ok(/state\.settings\.retrievalNearEnd = document\.getElementById\('set-retrieval-near-end'\)\.checked/.test(between(CARDS, 'function saveSettings()', '\n}\n', 'js/15-cards.js')),
     'SAVE stores it');
  ok(/near_end: !!cfg\.retrievalNearEnd/.test(RAG), 'each retrieval record notes which order the turn used');
  ok(/it is included as \[Memory file: \.\.\.\]/.test(RAG) && !/appears above as \[Memory file/.test(RAG),
     'the memory-files note no longer says the parts appear "above"');

  // gobbonet.toml [ui] can preset it: the key is in DEFAULT_SETTINGS, which
  // is the list js/21-data.js checks presets against.
  const c = { Object, String };
  vm.createContext(c);
  vm.runInContext(between(STATE, 'const DEFAULT_SETTINGS = {', '\n};', 'js/04-state.js').replace('const DEFAULT_SETTINGS', 'globalThis.DEFAULT_SETTINGS') + '\n};'
    + between(read('js/21-data.js'), 'function _presetKeyToSetting', 'function validateServerPresets', 'js/21-data.js'), c);
  ok(c._presetKeyToSetting('retrieval_near_end') === 'retrievalNearEnd', 'presettable as retrieval_near_end = true in gobbonet.toml [ui]');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
