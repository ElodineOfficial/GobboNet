/**
 * Group chats (1.8.0): several characters in one conversation.
 *
 * A group is a cast list with rules for whose turn it is (js/04-state.js,
 * GROUPS); a chat started from one carries thread.groupId (js/09-threads.js);
 * js/29-groups.js decides who replies and what that member is sent. The
 * reply itself is written by sendMessage / regenerateFromThread exactly as
 * for one character, with the member's own card.
 *
 *   A. The record: what a group may hold, however it arrived.
 *   B. Turn order: round and round after whoever spoke last, your place in
 *      it, muted and deleted members.
 *   C. Natural and shuffled order; replies per round.
 *   D. The DM: what it is asked, how its answer is read, what happens when
 *      it cannot be.
 *   E. What a member reads: the real buildContextMessages, for a group.
 *   F. Stop strings, and tidying a finished reply.
 *   G. A round: one member after another; Stop; looking away; picking a
 *      member; NEXT; AUTO.
 *   H. The bar under the chat.
 *   I. Saving, syncing, importing, exporting, purging.
 *   J. Wiring: the page, the two reply paths, the rest of the app.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const GROUPS = read('js/29-groups.js');
const STATE = read('js/04-state.js');
const THREADS = read('js/09-threads.js');
const PROMPT = read('js/07-prompt.js');
const RAG = read('js/08-rag.js');
const CHAT = read('js/10-chat.js');
const DATA = read('js/21-data.js');
const PERSIST = read('js/05-persistence.js');
const HTML = read('chat.html');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 900) : '')); }
};
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l, 'got:  ' + JSON.stringify(a) + '\n      want: ' + JSON.stringify(b));
const between = (src, from, to, file) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) { console.error(`could not locate ${JSON.stringify(from)} in ${file}`); process.exit(1); }
  return src.slice(a, b);
};
const GROUP_STATE = between(STATE, 'const GROUP_ORDERS', '// Built-in macro names', 'js/04-state.js');
const CAST = between(THREADS, 'function makeCastResolver(thread)', '/* ── Group chats', 'js/09-threads.js');
const THREAD_GROUP = between(THREADS, 'function threadGroup(thread)', '/** Start a chat with a group', 'js/09-threads.js');
const ESTIMATE = between(PROMPT, 'function estimateTokens(text)', 'function getThreadLore', 'js/07-prompt.js');
const NORMALIZE = between(PROMPT, 'function normalizeMessagesForStrictTemplates', '\n}\n', 'js/07-prompt.js') + '\n}\n';

/* A fake element: enough of the DOM for the bar and its buttons. */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, listeners: {}, style: {},
    className: '', textContent: '', title: '', type: '', disabled: false, parent: null,
    classList: { add(...c) { el.className = (el.className + ' ' + c.join(' ')).trim(); }, contains(c) { return (' ' + el.className + ' ').includes(' ' + c + ' '); } },
    setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    replaceChildren(...c) { el.children = []; c.forEach(x => el.appendChild(x)); },
    addEventListener(t, fn) { el.listeners[t] = fn; },
    click() { if (!el.disabled && el.listeners.click) return el.listeners.click({ stopPropagation() {}, currentTarget: el }); },
    contains(x) { for (let n = x; n; n = n.parent) if (n === el) return true; return false; },
    all() { return el.children.flatMap(c => [c, ...c.all()]); },
    querySelectorAll(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m ? el.all().filter(n => m[1] in n.attrs) : []; },
    text() { return [el.textContent, ...el.children.map(c => c.text())].join(''); },
    focus() {},
  };
  return el;
}

const CARDS = () => [
  { id: 'mira', name: 'Mira', personality: 'Mira is a ship’s navigator. She is careful and dry.', writingStyle: 'Write as Mira.', avatar: '' },
  { id: 'bram', name: 'Bram', personality: 'Bram is the cook. He talks too much.', writingStyle: 'Write as Bram.', avatar: '' },
  { id: 'reyes', name: 'Captain Reyes', personality: 'Reyes commands the Larkspur.', writingStyle: 'Write as Reyes.', avatar: '' },
];

/* The page, as far as js/29-groups.js needs it. Timers are collected and run
   by hand; regenerateFromThread is a stand-in that "writes" a reply and
   reports back, as the real one does. */
function world({ group = {}, messages = [], bar = false, replyOk = () => true, dm = null } = {}) {
  const timers = [];
  const els = { 'group-bar': bar ? makeEl('div') : null, 'msg-input': makeEl('textarea') };
  if (els['group-bar']) els['group-bar'].style.display = 'none';
  const c = {
    console: { log() {}, warn() {}, error() {} },
    Map, Set, Math, JSON, Object, Array, String, Number, Date, RegExp, Promise, Error, parseInt, isFinite,
    AbortController, AbortSignal,
    setTimeout: (fn, ms) => { timers.push({ fn, ms: ms || 0, kind: 't' }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: (fn, ms) => { timers.push({ fn: null, ms, kind: 'i' }); return timers.length; },
    clearInterval: () => {},
    requestAnimationFrame: () => {},
    document: { getElementById: (id) => els[id] || null, createElement: makeEl, activeElement: null, body: makeEl('body') },
    window: { innerWidth: 1280, innerHeight: 900 },
    DEFAULT_CARD: { id: 'default', name: 'Assistant', avatar: '' },
    DEFAULT_PERSONA: { id: 'default-persona', name: 'Anonymous', avatar: '' },
    safeImageUrl: () => '',
    renderAvatar: (a, n) => String(n || '?').charAt(0),
    escapeHtml: (s) => String(s), escapeJsAttr: (s) => String(s),
    translateTemplates: (t, ch, us) => String(t ?? '').replace(/\{\{char\}\}/gi, ch).replace(/\{\{user\}\}/gi, us),
    getRequestModelName: () => 'local',
    updateInputState: () => {}, saveState: () => { c.saves++; }, render: () => {}, renderCardGrid: () => {}, renderPersonaGrid: () => {},
    cancelAutoContinue: (why) => { c.chainCancelled = why; c.autoContinue = null; },
    maybeContinueChain: () => { c.chainMoved = (c.chainMoved || 0) + 1; },
    autoContinueMaxChain: () => 3,
    autoContinue: null,
    applyCardCode: (card) => { c.codeLoads.push(card ? card.id : 'active'); c._cardCodeCardId = card && card.customCodeEnabled ? card.id : null; },
    _cardCodeCardId: null,
    codeLoads: [], saves: 0, replies: [],
    generateId: () => 'id' + Math.random().toString(36).slice(2, 8),
    undoable: (o) => { c.lastUndo = o; },
    closePopover: () => {}, openCharacters: () => {}, closeCharacters: () => {},
  };
  c.state = {
    activeThreadId: 't1', activeCardId: 'mira', activePersonaId: 'p1',
    characterCards: CARDS(),
    personaCards: [{ id: 'p1', name: 'Ren', description: 'Ren is the new deckhand.', avatar: '' }],
    threads: [], groups: [], settings: {},
  };
  c.getActiveCard = () => c.state.characterCards.find(x => x.id === c.state.activeCardId) || c.state.characterCards[0];
  c.getActivePersona = () => c.state.personaCards[0];
  c.getActiveThread = () => c.state.threads.find(t => t.id === c.state.activeThreadId) || null;
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext('let isGenerating = false; let abortController = null; let _popover = null;', c);
  vm.runInContext(GROUP_STATE + CAST + THREAD_GROUP + ESTIMATE + GROUPS, c);
  const g = c.normalizeGroup(Object.assign({ id: 'g1', name: 'The Larkspur',
    members: [{ cardId: 'mira' }, { cardId: 'bram' }, { cardId: 'reyes' }] }, group));
  c.state.groups = [g];
  const thread = { id: 't1', name: 'x', groupId: 'g1', groupName: g.name, cardId: 'mira', cardName: 'Mira', personaId: 'p1', messages: [] };
  for (const [who, text] of messages) thread.messages.push(who === 'you' ? { role: 'user', content: text, personaId: 'p1' } : { role: 'assistant', content: text, cardId: who });
  c.state.threads = [thread];
  // The stand-in for the reply paths: push the member's message, report back.
  c.regenerateFromThread = async (opts) => {
    const card = opts.groupCard;
    const t = c.getActiveThread();
    const msg = { role: 'assistant', content: 'reply from ' + card.name, cardId: card.id };
    t.messages.push(msg);
    c.replies.push(card.id);
    c.groupAfterReply(t, msg, replyOk(card, c.replies.length));
  };
  if (dm) c.groupDMRequest = async (messages, signal) => { c.dmAsked = (c.dmAsked || []).concat([messages]); return dm(messages, signal, c); };
  const run = (expr) => vm.runInContext(expr, c);
  // Run queued timers (and whatever they queue) until none are left.
  const flush = async (max = 40) => {
    for (let i = 0; i < max; i++) {
      await new Promise(r => setImmediate(r));
      const due = timers.findIndex(t => t.kind === 't' && t.fn);
      if (due < 0) { await new Promise(r => setImmediate(r)); if (timers.findIndex(t => t.kind === 't' && t.fn) < 0) return; continue; }
      const fn = timers[due].fn; timers[due].fn = null;
      await fn();
    }
  };
  return { c, g, thread, run, flush, timers, els, pendingTimers: () => timers.filter(t => t.kind === 't' && t.fn) };
}
const say = (w, who, text) => w.thread.messages.push(who === 'you' ? { role: 'user', content: text, personaId: 'p1' } : { role: 'assistant', content: text, cardId: who });
const speakers = (w) => w.thread.messages.map(m => m.role === 'user' ? 'you' : m.cardId);
const seq = (list) => { let i = 0; return () => list[Math.min(i++, list.length - 1)]; };

/* ================================================================ A */
console.log('\n=== A. the record ===');
{
  const w = world();
  const N = w.c.normalizeGroup;
  eq(N({ id: 'g', name: '  Crew  ', members: ['a', { cardId: 'b', muted: true, talk: 250 }, { cardId: 'a' }, { nope: 1 }, null, 7] }).members,
     [{ cardId: 'a', muted: false, talk: 50 }, { cardId: 'b', muted: true, talk: 100 }],
     'members are card ids with two settings; a card listed twice is kept once, and junk is dropped');
  const g = N({ id: 'g', order: 'whatever', introduce: 'everything', greetings: 7, maxReplies: -3, autoDelaySeconds: 99999, userSlot: 40,
                userInOrder: 'yes', allowSelf: 1, stopOnOthers: 0, members: [{ cardId: 'a' }], extra: '<script>', dmInstructions: 'x'.repeat(9000) });
  eq([g.order, g.introduce, g.greetings, g.maxReplies, g.autoDelaySeconds, g.userSlot, g.userInOrder, g.allowSelf, g.stopOnOthers],
     ['list', 'short', 'all', 0, 600, 1, false, false, true],
     'a choice is one of its list, a number is in its range, a switch is only on when it is exactly true (stopOnOthers: off only when exactly false)');
  ok(!('extra' in g) && g.dmInstructions.length === 4000, 'a field this build does not know is not kept, and long text is cut');
  eq(g.name, 'Unnamed group', 'a group with no name gets one');
  ok(N(null) === null && N([]) === null && N({ name: 'no id' }) === null && N('g') === null, 'something that is not a group, or has no id, is not one');
  eq(N({ id: 'g', members: Array.from({ length: 40 }, (_, i) => ({ cardId: 'c' + i })) }).members.length, 24, 'at most 24 members');
  eq(w.c.normalizeGroups([{ id: 'a' }, { id: 'a' }, 5, { id: 'b' }]).map(x => x.id), ['a', 'b'], 'a list of groups keeps each id once');
  eq(w.c.normalizeGroups(undefined), [], 'state saved before groups existed has none');
  ok(/groups: \[\],/.test(STATE), 'a fresh state has an empty list of groups');
}

/* ================================================================ B */
console.log('\n=== B. turn order ===');
{
  let w = world();
  const pick = (w, count = 0) => { const p = w.c.groupListPick(w.thread, w.c.state.groups[0], count); return !p ? null : p.user ? 'you' : p.card.id; };
  eq(pick(w), 'mira', 'an empty chat: the first member begins');
  say(w, 'you', 'hello'); eq(pick(w), 'mira', 'after your first message, still the first member');
  say(w, 'mira', 'hi'); eq(pick(w, 1), 'bram', 'then the next');
  say(w, 'bram', 'hi'); say(w, 'reyes', 'hi'); eq(pick(w, 3), 'mira', 'and round again after the last');
  say(w, 'you', 'again'); say(w, 'mira', '..');
  w.thread.messages.pop();                       // the reply is deleted
  eq(pick(w), 'mira', 'whose turn it is follows the chat: delete a reply and that member is next again');

  w = world({ messages: [['you', 'hi'], ['mira', 'a']] });
  w.c.state.groups[0].members[1].muted = true;
  eq(pick(w, 1), 'reyes', 'a muted member is passed over');
  w.c.state.groups[0].members.forEach(m => { m.muted = true; });
  eq(pick(w, 1), null, 'with everyone muted, nobody');

  w = world({ messages: [['you', 'hi'], ['mira', 'a']] });
  w.c.state.characterCards = w.c.state.characterCards.filter(x => x.id !== 'bram');
  eq(pick(w, 1), 'reyes', 'a member whose character was deleted is skipped');
  w.c.state.characterCards.push(CARDS()[1]);
  eq(pick(w, 1), 'bram', 'and takes its turn again when the character is back');

  w = world({ messages: [['you', 'hi'], ['bram', 'a'], ['gone', 'I used to be here']] });
  eq(pick(w, 1), 'reyes', 'a former member\'s old message does not confuse the order');

  // You in the order: Mira, YOU, Bram, Captain Reyes
  w = world({ group: { userInOrder: true, userSlot: 1 } });
  eq(pick(w), 'bram', 'you in the order, empty chat: the member after your place begins');
  say(w, 'you', 'go'); eq(pick(w, 0), 'bram', 'you speak: the member after you replies');
  say(w, 'bram', '..'); eq(pick(w, 1), 'reyes', 'then the next');
  say(w, 'reyes', '..'); eq(pick(w, 2), 'mira', 'round the end of the list to the top');
  say(w, 'mira', '..'); eq(pick(w, 3), 'you', 'and when it comes to your place, it is your turn');
  eq(pick(w, 0), 'bram', 'the start of a round (you spoke, or passed) is never "your turn"');
  // You stop the round after Bram and speak again: it carries on with Reyes.
  w = world({ group: { userInOrder: true, userSlot: 1 }, messages: [['you', 'a'], ['bram', 'b'], ['you', 'wait']] });
  eq(pick(w, 0), 'reyes', 'speak out of turn and the order carries on from whoever spoke last');
  // Your place at the end is the same as not being asked first.
  w = world({ group: { userInOrder: true, userSlot: 3 }, messages: [['you', 'a'], ['mira', 'b'], ['bram', 'c'], ['reyes', 'd']] });
  eq(pick(w, 3), 'you', 'your place last: after the last member it is your turn');
  // The member before your place is muted: the round still stops at you.
  w = world({ group: { userInOrder: true, userSlot: 2, members: [{ cardId: 'mira' }, { cardId: 'bram', muted: true }, { cardId: 'reyes' }] }, messages: [['you', 'a'], ['reyes', 'b'], ['mira', 'c']] });
  eq(pick(w, 2), 'you', 'a muted member next to your place does not carry the round past you');
  // Only one member can speak, and you spoke: they answer.
  w = world({ group: { userInOrder: true, userSlot: 1, members: [{ cardId: 'mira', muted: true }, { cardId: 'bram' }] }, messages: [['bram', 'a'], ['you', 'b']] });
  eq(pick(w, 0), 'bram', 'the only member who can speak answers you');
  eq(w.c.groupRoundCap(w.c.state.groups[0], 3), 3, 'a round holds everyone once by default');
  eq(w.c.groupRoundCap({ maxReplies: 2 }, 5), 2, 'or the number the group sets');
}

/* ================================================================ C */
console.log('\n=== C. natural and shuffled order ===');
{
  const talk0 = [{ cardId: 'mira', talk: 0 }, { cardId: 'bram', talk: 0 }, { cardId: 'reyes', talk: 0 }];
  let w = world({ group: { order: 'natural', members: talk0 }, messages: [['you', 'Captain, should we ask Bram about the stores?']] });
  w.c.rng = () => 0.5; w.run('_groupRng = rng');
  eq(w.c.groupNaturalQueue(w.thread, w.g), ['reyes', 'bram'], 'natural: the members named reply, in the order named; "Captain" finds Captain Reyes');
  w = world({ group: { order: 'natural', members: talk0 }, messages: [['you', 'Miranda and the brambles']] });
  w.c.rng = () => 0; w.run('_groupRng = rng');
  eq(w.c.groupNaturalQueue(w.thread, w.g).length, 1, 'a name inside another word is not a mention; with nobody named or talkative, one member still replies');
  w = world({ group: { order: 'natural', members: [{ cardId: 'mira', talk: 100 }, { cardId: 'bram', talk: 0 }, { cardId: 'reyes', talk: 100 }] }, messages: [['you', 'Anyone?']] });
  w.c.rng = () => 0.5; w.run('_groupRng = rng');
  eq(w.c.groupNaturalQueue(w.thread, w.g).slice().sort(), ['mira', 'reyes'], 'the talkative join in, the quiet do not');
  w = world({ group: { order: 'natural', members: talk0 }, messages: [['you', 'x'], ['mira', 'I, Mira, wonder what Bram thinks.']] });
  w.c.rng = () => 0.5; w.run('_groupRng = rng');
  eq(w.c.groupNaturalQueue(w.thread, w.g), ['bram'], 'a member does not answer a mention of themselves in their own message');
  w.g.allowSelf = true;
  eq(w.c.groupNaturalQueue(w.thread, w.g), ['mira', 'bram'], 'unless the group lets the same character speak twice in a row');
  w = world({ group: { order: 'natural', members: [{ cardId: 'mira', talk: 100, muted: true }, { cardId: 'bram', talk: 0 }] }, messages: [['you', 'Mira?']] });
  w.c.rng = () => 0.5; w.run('_groupRng = rng');
  eq(w.c.groupNaturalQueue(w.thread, w.g), ['bram'], 'a muted member is not drawn in by being named');

  w = world({ group: { order: 'shuffle' }, messages: [['you', 'x'], ['reyes', 'y']] });
  w.c.rng = seq([0.99, 0.99, 0.99]); w.run('_groupRng = rng');
  const q = w.c.groupShuffleQueue(w.thread, w.g);
  eq(q.slice().sort(), ['bram', 'mira', 'reyes'], 'shuffle: every member once');
  w.c.rng = () => 0.99; w.run('_groupRng = rng');
  ok(w.c.groupShuffleQueue(w.thread, w.g)[0] !== 'reyes', 'and not led by whoever just spoke', w.c.groupShuffleQueue(w.thread, w.g));

  w = world({ group: { order: 'shuffle', maxReplies: 2 }, messages: [['you', 'x']] });
  const round = w.c.groupBeginRound(w.thread, w.g, 'user');
  eq(round.queue.length, 2, 'replies per round cuts a shuffled round short');
  ok(w.c.groupMentionIndex('Hey REYES!', 'Captain Reyes') < 0 && w.c.groupMentionIndex('hey captain reyes', 'Captain Reyes') === 4 && w.c.groupMentionIndex('Zoë?', 'Zoë') === 0,
     'names are matched whole, in any case, accents included; the first word of a longer name counts, a later word alone does not');
}

/* ================================================================ D */
console.log('\n=== D. the DM ===');
{
  let w = world({ group: { order: 'dm', dmInstructions: 'Let Bram interrupt.', scenario: 'On deck at dawn with {{user}}.' }, messages: [['you', 'What now?'], ['mira', 'We wait for wind.']] });
  const present = w.c.groupMembers(w.g);
  const msgs = w.c.groupDMMessages(w.thread, w.g, present.slice(1), true, 'Ren');
  ok(/You are the DM of a group chat/.test(msgs[0].content) && /never write what the characters say/.test(msgs[0].content), 'the DM is told it chooses and does not write');
  ok(/- Bram: Bram is the cook/.test(msgs[0].content) && /- Captain Reyes: Reyes commands/.test(msgs[0].content) && !/- Mira/.test(msgs[0].content), 'who it may choose, each with a line about them');
  ok(/- Ren: the user, a real person/.test(msgs[0].content), 'you, when you have a place in the order');
  ok(/How to choose, from the person running this chat:\nLet Bram interrupt\./.test(msgs[0].content), 'the owner\'s instructions');
  ok(/The scene:\nOn deck at dawn with Ren\./.test(msgs[0].content), 'the scene');
  ok(/Ren: What now\?\n\nMira: We wait for wind\./.test(msgs[1].content) && /Answer with one of: Bram, Captain Reyes, Ren$/.test(msgs[1].content), 'the conversation with its speakers named, and the names to answer with', msgs[1].content);
  const long = world({ group: { order: 'dm' }, messages: Array.from({ length: 40 }, (_, i) => [i % 2 ? 'mira' : 'you', 'opening ' + i + ' ' + 'word '.repeat(300) + 'closing ' + i + '.']) });
  const lm = long.c.groupDMMessages(long.thread, long.g, long.c.groupMembers(long.g), false, 'Ren')[1].content;
  ok(lm.length < 9000 && /closing 39\./.test(lm) && !/closing 5\./.test(lm), 'only the end of a long chat is shown to it, the newest messages kept', lm.length);
  ok(!/opening 39 /.test(lm) && /Mira: …/.test(lm), 'and of a long message, its end: where a question to someone usually is');

  const names = [{ key: 'mira', name: 'Mira' }, { key: 'bram', name: 'Bram' }, { key: 'reyes', name: 'Captain Reyes' }, { key: 'user', name: 'Ren' }];
  const P = (t, last) => w.c.groupParseChoice(t, names, last);
  eq([P('Bram'), P('  **Captain Reyes**. '), P('"mira"'), P('Ren')], ['bram', 'reyes', 'mira', 'user'], 'an answer that is a name');
  eq([P('I think Bram should answer Mira.'), P('Next: Captain.'), P('Reyes')], ['bram', 'reyes', null], 'the first name in a longer answer; a first word counts, a last word alone does not');
  eq([P(''), P('Nobody.'), P('Bramble')], [null, null, null], 'no name on the list is no answer');
  eq(P('Mira spoke last, so maybe Bram... no, Captain Reyes', true), 'reyes', 'for a model that thought aloud and ran out of room: the name it ended on');

  // Asking it.
  w = world({ group: { order: 'dm' }, messages: [['you', 'hm'], ['mira', 'a']], dm: async () => ({ content: 'Captain Reyes', reasoning: '' }) });
  let r = await w.c.groupAskDM(w.thread, w.g, { count: 1 });
  eq(r.card.id, 'reyes', 'the DM\'s choice replies');
  ok(!/- Mira/.test(w.c.dmAsked[0][0].content), 'the member who just spoke is not on its list');
  eq([w.run('isGenerating'), w.run('abortController')], [false, null], 'while it chooses, Stop is live; afterwards the page is as it was');
  w.g.allowSelf = true;
  await w.c.groupAskDM(w.thread, w.g, { count: 1 });
  ok(/- Mira/.test(w.c.dmAsked[1][0].content), 'unless the same character may speak twice in a row');

  w = world({ group: { order: 'dm', userInOrder: true, userSlot: 3 }, messages: [['you', 'hm'], ['mira', 'a']], dm: async () => ({ content: 'Ren', reasoning: '' }) });
  eq(await w.c.groupAskDM(w.thread, w.g, { count: 1 }), { user: true }, 'with you in the order it can choose you');
  await w.c.groupAskDM(w.thread, w.g, { count: 0 });
  ok(!/- Ren/.test(w.c.dmAsked[1][0].content), 'but not as the very first reply of a round: you have just spoken');
  w = world({ group: { order: 'dm' }, messages: [['you', 'hm']], dm: async () => ({ content: 'Ren', reasoning: '' }) });
  eq(await w.c.groupAskDM(w.thread, w.g, { count: 1 }), null, 'without a place in the order you are not on its list, and naming you is no answer');

  w = world({ group: { order: 'dm' }, messages: [['you', 'hm']], dm: async () => ({ content: '', reasoning: 'Mira just... so Bram.' }) });
  eq((await w.c.groupAskDM(w.thread, w.g, { count: 0 })).card.id, 'bram', 'an answer left in the model\'s reasoning is still read');
  w = world({ group: { order: 'dm' }, messages: [['you', 'hm']], dm: async () => { throw new Error('HTTP 500'); } });
  eq(await w.c.groupAskDM(w.thread, w.g, { count: 0 }), null, 'a failed request is no answer');
  w = world({ group: { order: 'dm', members: [{ cardId: 'mira' }] }, messages: [['you', 'hm']], dm: async () => ({ content: 'x' }) });
  r = await w.c.groupAskDM(w.thread, w.g, { count: 0 });
  ok(r.card.id === 'mira' && !w.c.dmAsked, 'with one member to choose from, nothing is asked');
  w = world({ group: { order: 'dm' }, messages: [['you', 'hm']], dm: async (m, signal, c) => { vm.runInContext('abortController.abort()', c); throw new Error('aborted'); } });
  eq(await w.c.groupAskDM(w.thread, w.g, { count: 0 }), { stopped: true }, 'Stop while it chooses stops the round');

  // In a round: an unreadable answer falls back to the turn order, and says so.
  w = world({ group: { order: 'dm' }, messages: [['you', 'hm']], dm: async () => ({ content: 'Hmm, hard to say.' }) });
  const card = await w.c.groupTurnCard(w.thread, w.g, { startedBy: 'user' });
  ok(card.id === 'mira' && /turn order decided/.test(w.run('_groupStatus')), 'no clear answer: the turn order decides, and the bar says so');
  ok(/chat_template_kwargs = \{ enable_thinking: false \}/.test(GROUPS) && /max_tokens: GROUP_DM_MAX_TOKENS/.test(GROUPS) && /_remoteMode/.test(GROUPS),
     'the request is short, with thinking off (left out for a remote server)');
}

/* ================================================================ E */
console.log('\n=== E. what a member reads ===');
{
  function promptWorld({ group = {}, messages = [], family = 'llama', carousel = '' } = {}) {
    const w = world({ group, messages });
    Object.assign(w.c, {
      activeModel: { name: 'test', family },
      STORAGE_BACKEND: 'memory', _idb: null, EMBED_URL: '/embed',
      fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }),
      resolveContextLimit: () => 32768,
      resolveContextBudget: () => ({ input: 0.9, reply: 0.2, land: 0.65, keep: 0.22 }),
      getThreadLore: () => '', runCardHook: () => {}, pickCarouselLine: () => carousel, renderMessages: () => {},
      performance: { now: () => 0 }, CustomEvent: function () {},
    });
    w.c.window.dispatchEvent = () => {};
    vm.runInContext(RAG + NORMALIZE, w.c);
    w.c.runRetrieval = async () => ({ retrievalTokens: 0, injections: [] });
    w.build = async (cardId) => (await w.c.buildContextMessages(w.thread,
      Object.assign({ loreEnabled: true, startingLore: '', ragStorybook: '', memoryFiles: [] }, w.c.state.characterCards.find(x => x.id === cardId)), {}));
    return w;
  }
  const convo = [['you', 'Where are we, {{char}}?'], ['mira', 'Off the cape. {{char}} is sure of it.'], ['bram', 'Bram says soup is on.'], ['you', 'Captain?']];
  let w = promptWorld({ group: { scenario: 'The Larkspur, at night. {{char}} is on deck with {{user}}.' }, messages: convo });
  let out = (await w.build('reyes')).apiMessages;
  const sys = out[0].content;
  ok(out[0].role === 'system' && /\[Character: Captain Reyes\]/.test(sys) && /Write as Reyes\./.test(sys), 'the prompt is the member\'s own card');
  ok(/\[Group chat: The Larkspur\]/.test(sys) && /You are Captain Reyes\. Also here:/.test(sys), 'plus who else is in the conversation');
  ok(/- Mira: Mira is a ship’s navigator/.test(sys) && /- Bram: Bram is the cook/.test(sys) && !/- Captain Reyes/.test(sys), 'the other members, each with a few lines about them');
  ok(/- Ren: the user\. Ren is the new deckhand\./.test(sys), 'and you, with your persona, on every turn');
  ok(/\[Scene\]\nThe Larkspur, at night\. Captain Reyes is on deck with Ren\./.test(sys), 'the scene, with {{char}} as whoever is speaking');
  ok(sys.indexOf('[Group chat') > sys.indexOf('[Character:') && sys.indexOf('[Group chat') < sys.indexOf('Write as Reyes.'), 'placed after who the member is, before its writing style');
  eq(out.slice(1).map(m => m.role), ['user'], 'Reyes has not spoken: everything said so far is the other side');
  const said = out[1].content;
  ok(/^Ren: Where are we, Captain Reyes\?/.test(said), 'your message, with your name in front; {{char}} in it is the member reading');
  ok(/\n\nMira: Off the cape\. Mira is sure of it\./.test(said), 'another member\'s message, named; {{char}} in it is its author');
  ok(/\n\nBram: Bram says soup is on\.\n\nRen: Captain\?/.test(said), 'in the order they were said');
  ok(/\n\n\[System: It is Captain Reyes’s turn\. Write Captain Reyes’s next message and nothing else, in Captain Reyes’s own voice\. Do not write for Mira, Bram or Ren\.\]$/.test(said),
     'and the prompt ends by saying whose turn it is', said.slice(-220));

  out = (await w.build('mira')).apiMessages;
  eq(out.slice(1).map(m => m.role), ['user', 'assistant', 'user'], 'for Mira, her own message is the assistant\'s');
  eq(out[2].content, 'Off the cape. Mira is sure of it.', 'with no name in front of it');
  ok(/^Bram: Bram says soup/.test(out[3].content) && /Ren: Captain\?/.test(out[3].content), 'and what came after is the other side again');

  // The member's own message is the last thing said.
  w = promptWorld({ messages: [['you', 'Go on.'], ['bram', 'Soup first.']] });
  out = (await w.build('bram')).apiMessages;
  eq(out.slice(1).map(m => m.role), ['user', 'assistant', 'user'], 'own message last: a cue stands in for the other side, so the prompt still ends there');
  ok(/^\[The conversation continues\.\]\n\n\[System: It is Bram’s turn\./.test(out[3].content), 'the cue, then whose turn', out[3].content);
  ok(out[2].content === 'Soup first.', 'and the member\'s last message is kept, not dropped');

  w = promptWorld({ messages: [] });
  out = (await w.build('mira')).apiMessages;
  ok(out.length === 2 && out[1].role === 'user' && /^\[The conversation begins\.\]/.test(out[1].content), 'an empty chat (NEXT pressed first): the member is asked to begin');

  // A reroll: the empty slot being filled is not sent as a bare name.
  w = promptWorld({ messages: [['you', 'Hi'], ['bram', '']] });
  out = (await w.build('mira')).apiMessages;
  ok(!/Bram:\s*(\n|$)/.test(out[1].content) && /^Ren: Hi/.test(out[1].content), 'an empty message is left out');

  // Greetings: a leading greeting of the member's own keeps its anchor.
  w = promptWorld({ messages: [['mira', 'Mira waves.'], ['bram', 'Bram nods.'], ['you', 'Hello both.']] });
  out = (await w.build('mira')).apiMessages;
  eq(out.slice(1).map(m => m.role), ['user', 'assistant', 'user'], 'opening greetings: the member\'s own is hers, the other\'s is named');
  ok(out[1].content === '[Start of conversation]' && /^Bram: Bram nods\.\n\nRen: Hello both\./.test(out[3].content), 'in a shape strict chat templates accept', out.map(m => m.content.slice(0, 30)));

  // What the others are told.
  w = promptWorld({ group: { introduce: 'names' }, messages: convo });
  ok(/- Mira\n- Bram\n- Ren: the user\n/.test((await w.build('reyes')).apiMessages[0].content), '"names only" gives names only');
  w = promptWorld({ group: { introduce: 'full' }, messages: convo });
  w.c.state.characterCards[0].personality = 'Mira. ' + 'She charts. '.repeat(120);
  const full = (await w.build('reyes')).apiMessages[0].content;
  ok(full.split('She charts.').length > 100, '"whole personality" gives all of it');
  w = promptWorld({ messages: convo });
  w.c.state.characterCards[0].personality = 'Mira. ' + 'She charts. '.repeat(120);
  ok((await w.build('reyes')).apiMessages[0].content.split('She charts.').length < 40, 'the default gives a few lines');

  // A muted member is still in the room; a deleted one is not listed.
  w = promptWorld({ group: { members: [{ cardId: 'mira', muted: true }, { cardId: 'bram' }, { cardId: 'reyes' }, { cardId: 'gone' }] }, messages: convo });
  const s2 = (await w.build('reyes')).apiMessages[0].content;
  ok(/- Mira:/.test(s2) && !/gone/.test(s2), 'a muted member is still present; a deleted one is not listed');

  // The persona's every-N injection stands down; a narrative direction moves to the end.
  w = promptWorld({ messages: convo, carousel: 'A storm is coming.' });
  w.c.state.personaCards[0].injectionFrequency = 1;
  out = (await w.build('reyes')).apiMessages;
  ok(!/\[Persona: Ren\]/.test(JSON.stringify(out)), 'the persona is in the group block, so it is not injected a second time');
  ok(/\[System: \[Narrative direction for this response\]\nA storm is coming\.\n\nIt is Captain Reyes’s turn/.test(out[out.length - 1].content), 'a card\'s narrative direction goes just before the turn line', out[out.length - 1].content.slice(-300));

  // The budget counts the block.
  w = promptWorld({ group: { scenario: 'word '.repeat(700) }, messages: convo });
  const withScene = (await w.build('reyes')).tokensUsed;
  w = promptWorld({ messages: convo });
  ok(withScene - (await w.build('reyes')).tokensUsed > 900, 'the group block is counted against the context');

  // Models that fold the system prompt into the first message.
  w = promptWorld({ messages: convo, family: 'qwen' });
  out = (await w.build('mira')).apiMessages;
  ok(out[0].role === 'user' && /\[Group chat: The Larkspur\]/.test(out[0].content) && out[out.length - 1].role === 'user', 'models that fold the system prompt still get the block first and end on the other side');

  // A chat that is not a group's is untouched.
  w = promptWorld({ messages: [['you', 'Hi {{char}}'], ['mira', 'Hello.'], ['you', 'Again']] });
  delete w.thread.groupId;
  out = (await w.build('mira')).apiMessages;
  ok(!/Group chat|turn\./.test(JSON.stringify(out)) && out[1].content === 'Hi Mira' && out[3].content === 'Again', 'a chat with one character is built exactly as before');
  ok(w.c.groupPromptContext(w.thread, w.c.state.characterCards[0], w.c.state.personaCards[0]) === null, 'groupPromptContext is null for it');

  // The summary names the speakers.
  w = promptWorld({ messages: convo });
  const ctx = w.c.groupPromptContext(w.thread, w.c.state.characterCards[2], w.c.state.personaCards[0]);
  eq(ctx.forLore(w.thread.messages).map(m => m.loreSpeaker), ['Ren', 'Mira', 'Bram', 'Ren'], 'messages go to the lore summary with their speakers named');
  ok(w.thread.messages.every(m => !('loreSpeaker' in m)), 'on copies: nothing is written into the chat');
  ok(/const role = m\.loreSpeaker \|\| \(m\.role === 'user' \? 'User' : 'Assistant'\)/.test(PROMPT), 'and the summary uses those names');
  ok(/groupCtx \? groupCtx\.forLore\(toArchive\) : toArchive/.test(RAG), 'buildContextMessages hands them over that way');
}

/* ================================================================ F */
console.log('\n=== F. stop strings, and tidying a reply ===');
{
  const w = world({ messages: [['you', 'hi']] });
  const mira = w.c.state.characterCards[0];
  eq(w.c.groupStopParams({ stop: ['</s>'] }, w.thread, mira).stop, ['</s>', '\nBram:', '\nCaptain Reyes:', '\nRen:'], 'a reply stops where it would start another speaker\'s line');
  eq(w.c.groupStopParams({}, w.thread, mira).stop.includes('\nMira:'), false, 'never on the member\'s own name');
  w.g.stopOnOthers = false;
  eq(w.c.groupStopParams({ stop: ['</s>'] }, w.thread, mira), { stop: ['</s>'] }, 'switched off for the group, nothing is added');
  w.g.stopOnOthers = true;
  w.c._remoteMode = true;
  eq(w.c.groupStopParams({}, w.thread, mira), {}, 'nor for a remote server, which may allow only four');
  w.c._remoteMode = false;
  const plain = { id: 'tx', messages: [] };
  eq(w.c.groupStopParams({ stop: ['a'] }, plain, mira), { stop: ['a'] }, 'nor in a chat with one character');

  const clean = (text, card = mira) => { const m = { role: 'assistant', content: text, cardId: card.id }; const changed = w.c.groupCleanReply(m, w.thread, card); return [m.content, changed]; };
  eq(clean('Mira: We hold course.'), ['We hold course.', true], 'the member\'s own name comes off the front');
  eq(clean('**Mira:** We hold course.')[0], 'We hold course.', 'bold or not');
  eq(clean('mira : ok')[0], 'ok', 'in any case');
  eq(clean('We hold course.\n\nBram: Soup!\nRen: I agree.')[0], 'We hold course.', 'a reply that runs on as someone else ends there');
  eq(clean('We hold.\n**Captain Reyes:** Aye.')[0], 'We hold.', 'bold or not');
  eq(clean('Bram said: hold on. Mira: fine.'), ['Bram said: hold on. Mira: fine.', false], 'a name in the middle of a line is left alone');
  eq(clean('Bram: I am not Mira.')[0], 'Bram: I am not Mira.', 'a reply that is ONLY someone else\'s line is not emptied');
  w.g.stopOnOthers = false;
  eq(clean('Mira: Scene.\nBram: Line.')[0], 'Scene.\nBram: Line.', 'with the switch off only the member\'s own label is removed');
  w.g.stopOnOthers = true;
  eq(clean('Mira: hi', { id: 'x', name: '' }), ['Mira: hi', false], 'a card with no name is left alone');

  const live = (text) => { const m = { role: 'assistant', content: text, cardId: 'mira' }; w.c.groupLiveTrim(m, w.thread); return m.content; };
  eq([live('Mi'), live('Mira'), live('Mira:'), live('Mira: We'), live('We hold course, Mira: yes, that is my final word')],
     ['Mi', 'Mira', '', 'We', 'We hold course, Mira: yes, that is my final word'], 'while a reply streams the label goes as soon as it is whole, and only at the very start');
  ok(/groupLiveTrim\(assistantMsg, thread\)/.test(read('js/03-generation.js')), 'the stream feeder calls it');

  // Greetings.
  const g = world({ group: { greetings: 'all', members: [{ cardId: 'mira' }, { cardId: 'bram', muted: true }, { cardId: 'reyes' }] } });
  g.c.injectGreeting = (t, card) => t.messages.push({ role: 'assistant', content: 'hi from ' + card.id, cardId: card.id });
  const t1 = { messages: [] }; g.c.injectGroupGreetings(t1, g.g);
  eq(t1.messages.map(m => m.cardId), ['mira', 'reyes'], 'a new chat opens with every unmuted member\'s greeting, in turn order');
  g.g.greetings = 'first'; const t2 = { messages: [] }; g.c.injectGroupGreetings(t2, g.g);
  eq(t2.messages.map(m => m.cardId), ['mira'], 'or the first member\'s');
  g.g.greetings = 'none'; const t3 = { messages: [] }; g.c.injectGroupGreetings(t3, g.g);
  eq(t3.messages.length, 0, 'or none');
}

/* ================================================================ G */
console.log('\n=== G. a round ===');
{
  // You send a message: the reply path asks who answers, writes it, reports back.
  let w = world({ messages: [['you', 'hello']] });
  let first = await w.c.groupTurnCard(w.thread, w.g, { startedBy: 'user' });
  eq(first.id, 'mira', 'groupTurnCard names the first to reply');
  say(w, 'mira', 'reply from Mira');
  eq(w.c.groupAfterReply(w.thread, {}, true), true, 'groupAfterReply takes the chat from there');
  await w.flush();
  eq(speakers(w), ['you', 'mira', 'bram', 'reyes'], 'and the others reply in turn, each through regenerateFromThread with its own card');
  eq(w.run('_groupRound'), null, 'then the round is over');
  eq(w.c.replies, ['bram', 'reyes'], 'one reply each');

  // Replies per round.
  w = world({ group: { maxReplies: 1 }, messages: [['you', 'a']] });
  await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(speakers(w), ['you', 'mira'], 'replies per round = 1: one reply and it is your turn');

  // You in the order.
  w = world({ group: { userInOrder: true, userSlot: 2 }, messages: [['you', 'a']] });
  first = await w.c.groupTurnCard(w.thread, w.g, {}); say(w, first.id, 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(speakers(w), ['you', 'reyes', 'mira', 'bram'], 'with you third in the order: the round runs from after you, round to you');

  // A reply fails or is stopped: the round ends, and a chain with it.
  w = world({ messages: [['you', 'a']], replyOk: (card) => card.id !== 'bram' });
  w.c.autoContinue = { threadId: 't1' };
  await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(speakers(w), ['you', 'mira', 'bram'], 'a stopped or failed reply ends the round there');
  ok(/stopped/.test(w.c.chainCancelled || ''), 'and cancels an {{auto_continue}} chain');
  w = world({ messages: [['you', 'a']] });
  w.c.autoContinue = { threadId: 't1' };
  await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(w.c.chainMoved, 1, 'a chain sends its next post once, when the whole round is in');

  // You look at another chat mid-round.
  w = world({ messages: [['you', 'a']] });
  await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true);
  w.c.state.threads.push({ id: 't2', messages: [] }); w.c.state.activeThreadId = 't2';
  await w.flush();
  eq(speakers(w), ['you', 'mira'], 'look at another chat and the round ends with the reply in progress');
  ok(w.c.state.threads[1].messages.length === 0, 'nothing is written into the other chat');

  // A reply that is not part of a round (a reroll).
  w = world({ messages: [['you', 'a'], ['bram', 'b']] });
  eq(w.c.groupAfterReply(w.thread, {}, true), false, 'a reroll is not a round: groupAfterReply leaves it to the caller');
  eq(w.c.groupRerollCard(w.thread, w.g).id, 'bram', 'and the member who wrote the reply writes it again');

  // Manual.
  w = world({ group: { order: 'manual' }, messages: [['you', 'a']] });
  eq(await w.c.groupTurnCard(w.thread, w.g, {}), null, 'manual: nobody replies to your message');
  w.c.groupNobodyReplies(w.thread);
  ok(/Click a member/.test(w.run('_groupStatus')), 'and the bar says how to get a reply');
  await w.c.groupTalk('reyes'); await w.flush();
  eq(speakers(w), ['you', 'reyes'], 'pick a member and it replies, alone');

  // Picking a member works for a muted one, and whatever the order.
  w = world({ group: { members: [{ cardId: 'mira' }, { cardId: 'bram', muted: true }, { cardId: 'reyes' }] }, messages: [['you', 'a']] });
  await w.c.groupTalk('bram'); await w.flush();
  eq(speakers(w), ['you', 'bram'], 'a muted member replies when picked, and nobody follows');
  await w.c.groupTalk('nobody'); await w.flush();
  eq(speakers(w).length, 2, 'a card that is not in the group cannot be picked');

  // NEXT.
  w = world({ messages: [['you', 'a'], ['mira', 'b']] });
  await w.c.groupPass('pass'); await w.flush();
  eq(speakers(w), ['you', 'mira', 'bram', 'reyes', 'mira'], 'NEXT: a round with no message from you, carrying on after whoever spoke last');
  w = world({ group: { order: 'manual' }, messages: [] });
  await w.c.groupPass('pass'); await w.flush();
  eq(speakers(w), [], 'NEXT does nothing in manual order');

  // Two clicks do not start two replies.
  w = world({ messages: [['you', 'a']] });
  const slow = []; w.c.regenerateFromThread = (o) => new Promise(res => slow.push(() => { w.thread.messages.push({ role: 'assistant', content: 'x', cardId: o.groupCard.id }); w.c.groupAfterReply(w.thread, {}, false); res(); }));
  const p1 = w.c.groupPass('pass'); await new Promise(r => setImmediate(r));
  const p2 = w.c.groupTalk('reyes'); await new Promise(r => setImmediate(r));
  eq(slow.length, 1, 'a second click while a reply is being started does nothing');
  slow[0](); await p1; await p2;

  // The DM in a round.
  w = world({ group: { order: 'dm' }, messages: [['you', 'Bram?']], dm: async (m) => ({ content: /Answer with one of: (\w+)/.exec(m[1].content)[1] }) });
  first = await w.c.groupTurnCard(w.thread, w.g, {}); say(w, first.id, 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(speakers(w).length, 4, 'DM: asked before each reply, the round still holds everyone once at most');
  eq(w.c.dmAsked.length, 3, 'one question per reply');
  w = world({ group: { order: 'dm', userInOrder: true, userSlot: 3 }, messages: [['you', 'x']], dm: async (m) => ({ content: /, Ren$/.test(m[1].content) ? 'Ren' : 'Bram' }) });
  first = await w.c.groupTurnCard(w.thread, w.g, {}); say(w, first.id, 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(speakers(w), ['you', 'bram'], 'the DM hands the turn back to you and the round ends');

  // Custom code: the speaker's is loaded for its turn, the active card's put back after.
  w = world({ messages: [['you', 'a']] });
  w.c.state.characterCards[1].customCodeEnabled = true; w.c.state.characterCards[1].customCode = 'gobbo.on("reply", () => {})';
  w.c.state.activeCardId = 'reyes';
  first = await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(w.c.codeLoads, ['bram', 'reyes', 'active'], 'a member\'s custom code is loaded for its turn, unloaded for the next member\'s, and the active character\'s is put back at the end');
  w = world({ messages: [['you', 'a']] });
  await w.c.groupTurnCard(w.thread, w.g, {}); say(w, 'mira', 'x'); w.c.groupAfterReply(w.thread, {}, true); await w.flush();
  eq(w.c.codeLoads, [], 'with no custom code anywhere, nothing is loaded or reloaded');

  // AUTO.
  w = world({ group: { maxReplies: 1, autoDelaySeconds: 5 }, messages: [['you', 'a']] });
  w.c.toggleGroupAuto();
  ok(w.run('_groupAuto.threadId') === 't1' && w.pendingTimers().length === 1 && w.pendingTimers()[0].ms === 0, 'AUTO on, nothing running: a round starts at once');
  for (let i = 0; i < 12; i++) await w.flush();
  eq(speakers(w), ['you', 'mira', 'bram', 'reyes'], 'round follows round with no message from you, and it stops after the limit a chain has (3 here)');
  ok(w.run('_groupAuto.threadId') === null && /stopped after 3 rounds/.test(w.run('_groupStatus')), 'saying why');
  ok(w.timers.some(t => t.ms === 5000), 'with the group\'s pause between rounds');
  w = world({ group: { maxReplies: 1 }, messages: [['you', 'a']] });
  w.c.toggleGroupAuto(); w.c.toggleGroupAuto();
  ok(w.run('_groupAuto.threadId') === null && w.pendingTimers().length === 0, 'pressing it again turns it off and cancels the wait');
  w = world({ group: { maxReplies: 1 }, messages: [['you', 'a']] });
  w.c.toggleGroupAuto(); w.c.groupStopRequested();
  eq(w.run('_groupAuto.threadId'), null, 'Stop turns AUTO off');
  w = world({ group: { maxReplies: 1 }, messages: [['you', 'a']] });
  w.c.toggleGroupAuto(); w.c.groupLeftThread('t2');
  eq(w.run('_groupAuto.threadId'), null, 'so does opening another chat');
  w = world({ group: { maxReplies: 1 }, messages: [['you', 'a']], replyOk: () => false });
  w.c.toggleGroupAuto(); await w.flush();
  ok(w.run('_groupAuto.threadId') === null && speakers(w).length === 2, 'and a reply that fails');
  w = world({ group: { order: 'manual' }, messages: [] });
  w.c.toggleGroupAuto();
  ok(w.run('_groupAuto.threadId') === null && /manual/.test(w.run('_groupStatus')), 'AUTO has nothing to follow in manual order');
  ok(/addEventListener\('input'/.test(GROUPS) && /You started typing, so AUTO stopped/.test(GROUPS), 'typing in the message box stops it');
  ok(!/_groupAuto/.test(PERSIST) && !/groupAuto/.test(STATE), 'AUTO is never saved: a reload starts with it off');
}

/* ================================================================ H */
console.log('\n=== H. the bar under the chat ===');
{
  let w = world({ bar: true, messages: [['you', 'hi'], ['mira', 'a']] });
  const barEl = w.els['group-bar'];
  w.c.renderGroupBar();
  const keys = () => barEl.querySelectorAll('[data-gkey]').map(e => e.getAttribute('data-gkey'));
  const by = (k) => barEl.querySelectorAll('[data-gkey]').find(e => e.getAttribute('data-gkey') === k);
  ok(barEl.style.display === '' && /The Larkspur/.test(barEl.text()), 'a group chat shows the bar, with the group\'s name');
  eq(keys(), ['name', 'talk:mira', 'mute:mira', 'talk:bram', 'mute:bram', 'talk:reyes', 'mute:reyes', 'next', 'auto'], 'each member in turn order with "reply now" and mute, then NEXT and AUTO');
  ok(/Next: Bram/.test(barEl.text()), 'turn order says who is next');
  ok(by('talk:bram').parent.classList.contains('group-chip-next'), 'and marks them');
  by('mute:bram').click();
  ok(w.c.state.groups[0].members[1].muted === true && w.c.saves === 1, 'the mute button mutes, for the group, and saves');
  ok(by('talk:bram').parent.classList.contains('group-chip-muted') && by('mute:bram').getAttribute('aria-pressed') === 'true' && /Next: Captain Reyes/.test(barEl.text()), 'the bar shows it, and who is next now');
  await by('talk:bram').click(); await w.flush();
  eq(speakers(w).slice(-1), ['bram'], 'clicking a member has it reply');

  w = world({ bar: true, group: { userInOrder: true, userSlot: 1 }, messages: [['you', 'hi'], ['bram', 'a'], ['reyes', 'b'], ['mira', 'c']] });
  w.c.renderGroupBar();
  const chips = w.els['group-bar'].all().filter(e => e.classList.contains('group-chip')).map(e => e.text().replace(/[^\w ]/g, '').trim());
  ok(chips[1].endsWith('You') && chips.length === 4, 'with you in the order, your place is shown among the members', chips);
  ok(/Your turn\. Then: Bram/.test(w.els['group-bar'].text()), 'and the bar says when it is your turn, and who follows');

  for (const [order, words] of [['manual', /click a member/i], ['natural', /whoever you name/], ['shuffle', /random order/], ['dm', /DM decides/]]) {
    w = world({ bar: true, group: { order }, messages: [] });
    w.c.renderGroupBar();
    ok(words.test(w.els['group-bar'].text()), order + ' order says how replies are chosen');
    if (order === 'manual') ok(w.els['group-bar'].querySelectorAll('[data-gkey]').filter(e => /next|auto/.test(e.getAttribute('data-gkey'))).every(e => e.disabled), 'NEXT and AUTO are off in manual order');
  }

  w = world({ bar: true, messages: [] });
  delete w.thread.groupId;
  w.c.renderGroupBar();
  ok(w.els['group-bar'].style.display === 'none' && w.els['group-bar'].children.length === 0, 'a chat with one character has no bar');
  w.thread.groupId = 'deleted'; w.thread.groupName = 'Old Crew';
  w.c.renderGroupBar();
  ok(/was deleted/.test(w.els['group-bar'].text()) && /Old Crew/.test(w.els['group-bar'].text()), 'a chat whose group was deleted says so, by name');

  w = world({ bar: true, group: { name: '<img src=x onerror=1>' }, messages: [] });
  w.c.state.characterCards[0].name = '<b>Mira</b>';
  w.c.renderGroupBar();
  ok(w.els['group-bar'].all().some(e => e.textContent === '<b>Mira</b>') && !/innerHTML/.test(between(GROUPS, 'function renderGroupBar()', '/* ----------------------------------------------------------------\n   6.', 'js/29-groups.js')),
     'names are text: the bar is built without innerHTML');
  // The one place this file writes markup is the string the home screen
  // inserts; every value in it goes through an escaper.
  ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(GROUPS), 'nothing in this file sets markup on the page itself');
  const landingSrc = between(GROUPS, 'function landingGroupsHtml()', '/* ----------------------------------------------------------------\n   7.', 'js/29-groups.js');
  const holes = [...landingSrc.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1].trim());
  const safeHole = (h) => /^(escapeHtml|escapeJsAttr|renderAvatar)\(/.test(h) || /^(avatar|faces|tiles)$/.test(h) ||
    /^Math\.min\(4, present\.length\) \|\| 1$/.test(h) || /^faces \|\| escapeHtml\(/.test(h);
  eq(holes.filter(h => !safeHole(h)), [], 'the home-screen section escapes every value it prints');
  ok(holes.length >= 6, 'and that check read the section', holes.length);
  w = world({ group: { name: '<img src=x onerror=1>' }, messages: [] });
  w.c.escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.c.renderAvatar = (a, n) => w.c.escapeHtml(String(n || '?').charAt(0));
  w.c.state.characterCards[0].name = '<b>Mira</b>';
  const landing = w.c.landingGroupsHtml();
  ok(/&lt;img src=x onerror=1&gt;/.test(landing) && !/<img src=x/.test(landing) && /&lt;b&gt;Mira&lt;\/b&gt;, Bram/.test(landing) && !/<b>Mira/.test(landing),
     'a group or character named like markup is shown as text there');
  w.c.state.groups = [];
  eq(w.c.landingGroupsHtml(), '', 'with no groups the home screen has no section for them');
}

/* ================================================================ I */
console.log('\n=== I. saving, syncing, importing, exporting, purging ===');
{
  ok(/groups: state\.groups \|\| \[\],/.test(between(PERSIST, 'function buildStateMeta()', 'function metaPartOf', 'js/05-persistence.js')), 'groups are saved, and synced, with the rest of the non-chat state');
  ok(/state\.groups = \(typeof normalizeGroups === 'function'\) \? normalizeGroups\(saved\.groups\) : \[\];/.test(PERSIST), 'and read back through normalizeGroup, whatever device wrote them');
  ok(/\['threads', 'characterCards', 'personaCards', 'groups', 'folders', 'macros', 'schedules'\]/.test(read('js/06-state-sync.js')), 'a server snapshot whose groups are not a list of objects is refused');

  // Export and import, the real functions.
  const w = world({ messages: [['you', 'hi'], ['mira', 'a']] });
  const files = [];
  Object.assign(w.c, { downloadJSON: (data, name) => files.push({ data, name }), STATE_SCHEMA_VERSION: 1, _threadFolders: () => [],
    neutralizeUntrustedCode: () => ({ cards: 0 }), DEFAULT_PERSONA: { id: 'd' } });
  vm.runInContext(between(DATA, 'function _exportSlug(name)', '/** The folders a set of threads sits in', 'js/21-data.js'), w.c);
  w.c.exportThread('t1');
  eq(files[0].data.groups.map(g => g.id), ['g1'], 'exporting a group chat brings its group');
  eq(files[0].data.characterCards.map(x => x.id).sort(), ['bram', 'mira', 'reyes'], 'and every member, including one who has not spoken yet');
  w.c.exportGroup('g1');
  ok(files[1].data.gobbonet_export === 'cards' && files[1].data.groups.length === 1 && files[1].data.characterCards.length === 3 && /^gobbonet-group-the-larkspur-/.test(files[1].name),
     'a group exports as its characters plus itself, in the envelope the Characters import reads');
  const exported = JSON.parse(JSON.stringify(files[1].data));
  w.c.state.groups = []; w.c.state.characterCards = [];
  exported.groups[0].evil = 'x'; exported.groups.push({ id: 'g1', name: 'twin' }, 'junk');
  eq(w.c._mergeBundledCast(exported), ' Also added 3 character(s), 1 group(s).', 'importing it adds the characters and then the group');
  ok(w.c.state.groups.length === 1 && !('evil' in w.c.state.groups[0]) && w.c.groupMembers(w.c.state.groups[0]).length === 3, 'read through normalizeGroup; the group finds its members');
  eq(w.c._mergeImportedGroups([{ id: 'g1', name: 'again' }]), 0, 'a group already here is left alone');
  ok(/const groupsAdded = _mergeImportedGroups\(data\.groups\);\s*\n\s*saveState\(\); render\(\);/.test(DATA), 'DATA > Import > Characters reads a group export');
  ok(/state\.groups\s+= normalizeGroups\(data\.groups\);/.test(DATA) && /groups: state\.groups \|\| \[\],\s*\n\s*schedules/.test(DATA), 'a full backup carries groups out and back');
  ok(/'personaCards', 'activePersonaId', 'groups', 'schedules'/.test(DATA) && /_purgeSnapshot\(\['characterCards', 'activeCardId', 'groups'\]\)/.test(DATA) && /state\.groups\s+= \[\];/.test(DATA),
     'PURGE ALL and resetting the characters clear groups, with UNDO');

  // Deleting a group, and UNDO.
  const d = world({ messages: [['you', 'hi']] });
  d.c.renderGroupGrid = () => {};
  d.c.deleteGroupById('g1');
  ok(d.c.state.groups.length === 0 && d.c.threadGroup(d.thread) === null && d.thread.groupId === 'g1', 'deleting a group leaves its chats, which are ordinary chats until it is back');
  d.c.lastUndo.undo();
  ok(d.c.threadGroup(d.thread) !== null, 'UNDO brings it back, and its chats find it again');
  ok(/label: 'Deleted group "/.test(GROUPS), 'the delete offers UNDO by name');
}

/* ================================================================ J */
console.log('\n=== J. wiring ===');
{
  // The page.
  const row = between(HTML, '<div class="sidebar-new-row">', '</div>', 'chat.html');
  ok(/onclick="createThread\(\)" data-tour="new-chat"[^>]*>\+ THREAD<\/button>/.test(row) && /id="new-group-btn" onclick="openGroupPicker\(event\)"[^>]*>\+ GROUP<\/button>/.test(row),
     'the new-chat button is two: + THREAD and + GROUP');
  ok(!/NEW_THREAD<\/button>/.test(HTML), 'the old single button is gone');
  ok(/<div class="group-bar" id="group-bar" role="group"[^>]*style="display:none;">/.test(HTML) && HTML.indexOf('id="group-bar"') < HTML.indexOf('id="context-info"') && HTML.indexOf('id="group-bar"') > HTML.indexOf('id="messages"'),
     'the bar sits between the chat and the message box, hidden until a group chat is open');
  const castList = between(HTML, '<div id="char-modal-list">', '<div id="card-editor"', 'chat.html');
  ok(castList.indexOf('id="card-grid"') < castList.indexOf('id="group-grid"') && castList.indexOf('id="group-grid"') < castList.indexOf('id="persona-grid"') && /onclick="createGroup\(\)"[^>]*>\+ NEW GROUP</.test(castList),
     'CAST lists groups between characters and personas, with + NEW GROUP');
  const editor = between(HTML, '<div id="group-editor"', '<div class="modal-actions" id="char-close-row">', 'chat.html');
  for (const id of ['group-name', 'group-avatar', 'group-member-list', 'group-add-select', 'group-user-in-order', 'group-members-json', 'group-order',
                    'group-dm-instructions', 'group-max-replies', 'group-auto-delay', 'group-allow-self', 'group-scenario', 'group-introduce', 'group-greetings', 'group-stop-on-others']) {
    ok(editor.includes('id="' + id + '"'), 'the editor has #' + id);
  }
  eq([...editor.matchAll(/<option value="(\w+)">/g)].map(m => m[1]), ['list', 'natural', 'shuffle', 'dm', 'manual', 'names', 'short', 'full', 'all', 'first', 'none'], 'its choices are the ones the record accepts');
  ok(/onclick="deleteGroup\(\)"/.test(editor) && /onclick="cancelGroupEdit\(\)"/.test(editor) && /onclick="saveGroup\(\)"/.test(editor), 'DELETE, Cancel and SAVE, like a character');
  ok(/<script src="js\/29-groups\.js"><\/script>/.test(HTML) && /href="css\/21-groups\.css"/.test(HTML), 'the script and stylesheet are loaded');
  ok(HTML.indexOf('<script src="js/29-groups.js">') > HTML.indexOf('<script src="js/28-update.js">') &&
     HTML.indexOf('<script src="js/28-update.js">') > 0, 'last, after everything it calls');
  // Loaded after boot, whose first render may have run without it.
  ok(/window\.GobboNet\.ready\.then\(_groupCatchUp/.test(GROUPS), 'after boot it draws what a first render before this file would have skipped');
  {
    const w = world({ bar: true, messages: [] });
    let renders = 0;
    w.c.render = () => { renders++; };
    w.c.document.querySelector = () => null;
    w.c.state.activeThreadId = null;
    w.c._groupCatchUp();
    eq(renders, 1, 'on the home screen with groups and no YOUR GROUPS section, it renders once');
    w.c.document.querySelector = (sel) => (sel === '.landing-group-list' ? {} : null);
    w.c._groupCatchUp();
    w.c.state.activeThreadId = 't1';
    w.c.document.querySelector = () => null;
    w.c._groupCatchUp();
    w.c.state.activeThreadId = null;
    w.c.state.groups = [];
    w.c._groupCatchUp();
    eq(renders, 1, 'and not when the section is there, a chat is open, or there are no groups');
  }

  // The editor's member list: you among the members.
  const w = world();
  w.run('_groupDraft = { members: [{cardId:"mira"},{cardId:"bram"},{cardId:"reyes"}], userInOrder: true, userSlot: 1 }');
  let rows = w.run('_groupDraftRows()');
  eq(rows.map(r => r.user ? 'YOU' : r.member.cardId), ['mira', 'YOU', 'bram', 'reyes'], 'the editor shows you among the members, at your place');
  rows.splice(2, 0, rows.splice(1, 1)[0]);        // move YOU down one row
  w.c.rows = rows; w.run('_groupDraftFromRows(rows)');
  eq([w.run('_groupDraft.userSlot'), w.run('_groupDraft.members.map(m => m.cardId).join()')], [2, 'mira,bram,reyes'], 'moving your row changes your place, not the members\' order');
  rows = w.run('_groupDraftRows()'); rows.splice(0, 0, rows.splice(3, 1)[0]);   // move Reyes to the top
  w.c.rows = rows; w.run('_groupDraftFromRows(rows)');
  eq([w.run('_groupDraft.userSlot'), w.run('_groupDraft.members.map(m => m.cardId).join()')], [3, 'reyes,mira,bram'], 'moving a member past you keeps you where you were among them');

  // The two reply paths.
  const send = between(CHAT, 'async function sendMessage(overrideContent)', 'function stopGeneration', 'js/10-chat.js');
  const regen = between(CHAT, 'async function regenerateFromThread(options = {})', 'JOB RESUME', 'js/10-chat.js');
  ok(/const card = _group \? await groupTurnCard\(thread, _group, \{ startedBy: 'user' \}\) : getActiveCard\(\);\s*\n\s*if \(!card\) \{ groupNobodyReplies\(thread\); return; \}/.test(send),
     'sendMessage: in a group chat a member answers, or nobody');
  ok(/if \(_group && typeof groupAfterReply === 'function' && groupAfterReply\(thread, assistantMsg, !sendErrored\)\) return;/.test(send), 'and the round takes it from there');
  ok(/else if \(options\.groupCard\) card = options\.groupCard;/.test(regen) && /else if \(options\.rerollIntoLastMessage\) card = groupRerollCard\(thread, _group\);/.test(regen) && /else card = await groupTurnCard\(thread, _group, \{ startedBy: 'user' \}\);/.test(regen),
     'regenerateFromThread: the round\'s member, the same member on a reroll, or a new round after an edit');
  ok(/groupAfterReply\(thread, assistantMsg, !\(outcome\.errored \|\| \(outcome\.aborted && !assistantMsg\.smartCapped\)\)\);/.test(regen), 'and it reports back when the reply is done');
  for (const [name, src] of [['sendMessage', send], ['regenerateFromThread', regen]]) {
    ok(/groupStopParams\(getStopStrings\(\), thread, card\)/.test(src) && /groupCleanReply\(assistantMsg, thread, card\)/.test(src), name + ' adds the stop strings and tidies the reply');
    ok(/buildContextMessages\(thread, card\)/.test(src) && /getCardSamplerParams\(card\)/.test(src) && /buildLogitBias\(card\)/.test(src) && /runGenerationWithReroll\(thread, assistantMsg, requestBody, \{ card \}\)/.test(src),
       name + ' writes it with that member\'s card: prompt, samplers, banned phrases, Auto Reroll, tools');
    ok(/cardId: card\.id/.test(src), name + ' stamps the message with who wrote it');
  }
  ok(/groupPass\('pass'\);\s*\n\s*return;/.test(send), 'Enter on an empty box in a group chat is NEXT');
  ok(/if \(!_group\) \{\s*\n\s*try \{\s*\n\s*storedContent = transformViaCardHook\('send'/.test(send), 'the active character\'s send hook does not run in a group chat');
  ok(/groupStopRequested\(\)/.test(between(CHAT, 'function stopGeneration', 'COT INFINITE RUNTIME', 'js/10-chat.js')), 'Stop tells the group');

  // The rest of the app.
  ok(/function applyCardCode\(forCard\)/.test(read('js/23-card-code.js')) && /const card = forCard \|\|/.test(read('js/23-card-code.js')), 'custom code can be loaded for a named card');
  ok(/state\.characterCards\.find\(c => c\.id === msg\.cardId\)/.test(read('js/03-generation.js')), 'the reply length limit is the writing member\'s');
  ok(/makeCastResolver\(thread\)\.cardFor\(assistantMsg\)/.test(read('js/14-scroll.js')), 'a streaming reply is painted in its member\'s colours');
  ok(/if \(typeof threadGroup === 'function' && threadGroup\(thread\)\) return hide\(\);/.test(read('js/13-dashboard.js')), 'the "replying as someone else" notice stays out of group chats');
  ok(/replyCardForThread\(thread\)/.test(read('js/13-dashboard.js')) && /renderGroupBar\(\)/.test(read('js/13-dashboard.js')) && /landingGroupsHtml\(\)/.test(read('js/13-dashboard.js')), 'the context meter, the bar and the home screen follow the group');
  ok(/const card = inGroup \? null :/.test(read('js/02-model.js')), 'a group chat follows the model it last used, not one member\'s link');
  ok(/groupHostCard\(_group\)/.test(read('js/17-personas.js')), 'and wears its first member\'s background');
  ok(/thread-group-badge/.test(read('js/12-render.js')), 'the sidebar marks a group chat');
  ok(/\['card-editor', 'persona-editor', 'group-editor'\]/.test(read('js/22-scheduler.js')), 'the group editor is guarded against losing unsaved changes like the other two');
  ok(/renderGroupGrid\(\)/.test(read('js/15-cards.js')) && /editingGroupId = null/.test(read('js/15-cards.js')), 'opening CAST shows the groups list, not a stale editor');
  ok(/newThread\.groupId = thread\.groupId;/.test(THREADS), 'a branch of a group chat is a group chat');

  // A deleted member's messages are not shown under the first member's name.
  const c = world({ messages: [['you', 'x'], ['gone', 'old'], ['mira', 'new']] });
  const cast = c.c.makeCastResolver(c.thread);
  eq([cast.cardFor(c.thread.messages[1]).name, cast.cardFor(c.thread.messages[2]).name], ['Former member', 'Mira'], 'a deleted member\'s messages say "Former member", not the first member\'s name');
  const single = { id: 's', cardId: 'gone', cardName: 'Old Name', messages: [] };
  eq(c.c.makeCastResolver(single).cardFor({ role: 'assistant', cardId: 'other-gone' }).name, 'Old Name', 'a chat with one character keeps its tombstone name as before');

  // Starting a chat.
  const t = world();
  Object.assign(t.c, { injectGreeting: (th, card) => { if (card.id === 'mira') th.messages.push({ role: 'assistant', content: 'Mira waves.', cardId: 'mira' }); },
    sortThreadsByOrder: () => {}, updateSidebarVisibility: () => {}, applyActiveCardBackground: () => {} });
  vm.runInContext(between(THREADS, 'function createGroupThread(groupId)', 'function createThread(opts)', 'js/09-threads.js'), t.c);
  const made = t.c.createGroupThread('g1');
  ok(made && made.groupId === 'g1' && made.groupName === 'The Larkspur' && made.cardId === 'mira' && made.name === 'The Larkspur' && t.c.state.activeThreadId === made.id,
     'a new group chat carries its group, is named after it, and opens');
  eq(made.messages.map(m => m.cardId), ['mira'], 'with the members\' greetings');
  t.c.state.groups[0].members = [{ cardId: 'nobody' }];
  eq(t.c.createGroupThread('g1'), null, 'a group with nobody left in it starts no chat');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
