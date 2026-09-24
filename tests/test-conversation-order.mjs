// Conversation order: activity, drags, and the arrangement carried over from
// before per-conversation sync. See CONVERSATION ORDER in js/04-state.js.
//
//   A-B  1.7.5's rule, restored: a drag sets a place, and the conversation's
//        next message floats it back to the top -- with nothing written on
//        send, so a sent turn stays an append.
//   C    respacing when a gap runs out keeps the arrangement and the rule.
//   D    placements from a build that stored no activity mark.
//   E-F  a saved legacy `threadOrder` list is carried into the keys (only the
//        chats placed against activity are pinned), deterministically, and
//        persisted once by the real loadState().
//   G    sync: placement never reads as a content conflict, and reconcile
//        keeps a placement's two fields together.
//
// Every section drives the real code out of js/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = n => fs.readFileSync(new URL('../js/' + n, import.meta.url), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + (e && e.message)); failed++; }
}

const stateSrc = read('04-state.js');
const orderingSrc = stateSrc.slice(stateSrc.indexOf('const ORDER_KEY_STEP'), stateSrc.indexOf('let isGenerating = false;'));
const persistenceSrc = read('05-persistence.js');
const loaderSrc = persistenceSrc.slice(persistenceSrc.indexOf('function applyLoadedState('),
                                       persistenceSrc.indexOf('/**\n * Build a JSON string suitable'));

// Timestamps relative to the real clock: drops at the top of the list and
// respacing use Date.now(), exactly as the app does.
const T0 = Date.now() - 3600000;
const at = min => T0 + min * 60000;
const msg = (min, content) => ({ role: 'user', content: content || 'm' + min, timestamp: at(min) });
const chat = (id, ...mins) => ({ id, name: id, createdAt: T0, messages: mins.map(m => msg(m, id + m)) });
const now = () => ({ role: 'user', content: 'now', timestamp: Date.now() + 60000 });
const quiet = { log() {}, warn() {}, error() {} };

function orderCtx(threads) {
  const ctx = { console: quiet, state: { threads } };
  vm.createContext(ctx);
  vm.runInContext(orderingSrc, ctx);
  return ctx;
}
const ids = ctx => Array.from(ctx.state.threads, t => t.id);
const byId = (ctx, id) => ctx.state.threads.find(t => t.id === id);

console.log('\n=== A. activity ordering ===');
await check('conversations sort by their latest message', () => {
  const c = orderCtx([chat('a', 1), chat('b', 3), chat('c', 2)]);
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
});
await check('a new message floats a conversation to the top', () => {
  const c = orderCtx([chat('a', 1), chat('b', 3), chat('c', 2)]);
  byId(c, 'a').messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['a', 'b', 'c']);
});

console.log('\n=== B. a drag holds until the next message (the 1.7.5 rule) ===');
await check('dragging a chat down puts it there and records its activity', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  assert.ok(c.placeThreadBeside(byId(c, 'a'), byId(c, 'c'), 'after'));
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
  assert.equal(byId(c, 'a').orderActivity, at(3));
});
await check('its next message floats it back to the top', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  c.placeThreadBeside(byId(c, 'a'), byId(c, 'c'), 'after');
  const a = byId(c, 'a');
  const placed = { order: a.order, orderActivity: a.orderActivity };
  a.messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['a', 'b', 'c']);
  assert.deepEqual({ order: a.order, orderActivity: a.orderActivity }, placed,
                   'nothing was written on send: the conversation head is unchanged, so it stays an append');
});
await check('activity in other chats does not move the placed one', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  c.placeThreadBeside(byId(c, 'a'), byId(c, 'c'), 'after');
  byId(c, 'b').messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
});
await check('a message without a timestamp (e.g. injected by card code) does not float it', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  c.placeThreadBeside(byId(c, 'a'), byId(c, 'c'), 'after');
  byId(c, 'a').messages.push({ role: 'user', content: 'injected' });
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
});
await check('dragging it again after it floated pins it again', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  c.placeThreadBeside(byId(c, 'a'), byId(c, 'c'), 'after');
  byId(c, 'a').messages.push(now());
  c.sortThreadsByOrder();
  assert.ok(c.placeThreadBeside(byId(c, 'a'), byId(c, 'b'), 'after'));
  assert.deepEqual(ids(c), ['b', 'a', 'c']);
  assert.equal(byId(c, 'a').orderActivity, byId(c, 'a').messages.at(-1).timestamp);
});
await check('dragging a chat up holds it above newer chats until they are used', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  assert.ok(c.placeThreadBeside(byId(c, 'c'), byId(c, 'a'), 'before'));
  assert.deepEqual(ids(c), ['c', 'a', 'b']);
  byId(c, 'b').messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
});

console.log('\n=== C. respacing an exhausted gap ===');
await check('an exhausted gap respaces, keeps the arrangement, and keeps the rule', () => {
  const a = chat('a', 3), b = chat('b', 2), c3 = chat('c', 1);
  // Two placements one representable step apart at this magnitude: nothing
  // fits between them, so the drop below must respace first.
  const X = at(30);
  a.order = X + Math.pow(2, -12); a.orderActivity = at(3);
  b.order = X;                    b.orderActivity = at(2);
  const c = orderCtx([a, b, c3]);
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['a', 'b', 'c']);
  assert.ok(c.placeThreadBeside(byId(c, 'c'), byId(c, 'b'), 'before'));
  assert.deepEqual(ids(c), ['a', 'c', 'b']);
  for (const t of c.state.threads) {
    assert.equal(typeof t.order, 'number');
    assert.equal(t.orderActivity, t.messages.at(-1).timestamp, 'respace records each activity mark');
  }
  byId(c, 'b').messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'a', 'c']);
});

console.log('\n=== D. placements that carry no activity mark ===');
const chatSrc = read('10-chat.js');
const sendSrc = chatSrc.slice(chatSrc.indexOf('async function sendMessage('));
const heal = sendSrc.match(/if \(typeof thread\.order === 'number' && typeof thread\.orderActivity !== 'number'\) \{\s*delete thread\.order;\s*\}/);
await check('such a placement holds its place until used', () => {
  const a = chat('a', 3); a.order = at(0.5);
  const c = orderCtx([a, chat('b', 2), chat('c', 1)]);
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['b', 'c', 'a']);
});
await check('sendMessage retires it, between pushing the message and sorting', () => {
  assert.ok(heal, 'the retirement statement is in sendMessage');
  const pos = sendSrc.indexOf(heal[0]);
  assert.ok(sendSrc.indexOf('thread.messages.push(userMessage)') < pos);
  assert.ok(pos < sendSrc.indexOf('sortThreadsByOrder()'));
});
await check('after which the chat floats, as it did before the upgrade', () => {
  const a = chat('a', 3); a.order = at(0.5);
  const c = orderCtx([a, chat('b', 2), chat('c', 1)]);
  const run = vm.runInContext('(function (thread) {' + heal[0] + '})', c);
  a.messages.push(now());
  run(a);
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['a', 'b', 'c']);
  assert.equal('order' in a, false);
});
await check('a placement that has its mark is not retired', () => {
  const c = orderCtx([chat('a', 3), chat('b', 2)]);
  c.placeThreadBeside(byId(c, 'a'), byId(c, 'b'), 'after');
  const run = vm.runInContext('(function (thread) {' + heal[0] + '})', c);
  run(byId(c, 'a'));
  assert.equal(typeof byId(c, 'a').order, 'number');
});

console.log('\n=== E. carrying a saved 1.7.5 arrangement ===');
function loaderCtx(extra) {
  const ctx = Object.assign({
    console: quiet, state: { threads: [], settings: {} },
    DEFAULT_SETTINGS: {}, DEFAULT_CARD: { id: 'default', name: 'Assistant' }, DEFAULT_PERSONA: { id: 'default' },
    DEFAULT_MACROS: [], STATE_SCHEMA_VERSION: 1, loadedSchemaVersion: null, hadOwnSettings: false,
    migrateExtensions: e => e || {}, legacyThreadOrderAdopted: [],
    cleanThread: t => structuredClone(t)
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(orderingSrc + '\n' + loaderSrc, ctx);
  return ctx;
}
const legacyBlob = (order, extraThreads) => ({
  threads: [chat('a', 50), chat('b', 40), chat('c', 30), chat('d', 20), chat('e', 10)].concat(extraThreads || []),
  threadOrder: order, settings: {}, characterCards: [{ id: 'default', name: 'Assistant' }], activeCardId: 'default'
});
await check('a chat dragged up keeps its place, and nothing else is written', () => {
  const c = loaderCtx();
  assert.equal(c.applyLoadedState(legacyBlob(['a', 'd', 'b', 'c', 'e'])), true);
  assert.deepEqual(ids(c), ['a', 'd', 'b', 'c', 'e']);
  assert.deepEqual(Array.from(c.state.threads.filter(t => 'order' in t), t => t.id), ['d']);
  assert.equal(byId(c, 'd').orderActivity, at(20));
});
await check('a chat dragged down keeps its place', () => {
  const c = loaderCtx();
  c.applyLoadedState(legacyBlob(['b', 'c', 'a', 'd', 'e']));
  assert.deepEqual(ids(c), ['b', 'c', 'a', 'd', 'e']);
  assert.deepEqual(Array.from(c.state.threads.filter(t => 'order' in t), t => t.id), ['a']);
});
await check('a chat dragged to the very bottom keeps its place', () => {
  const c = loaderCtx();
  c.applyLoadedState(legacyBlob(['b', 'c', 'd', 'e', 'a']));
  assert.deepEqual(ids(c), ['b', 'c', 'd', 'e', 'a']);
});
await check('several placements at once, with the fewest chats pinned', () => {
  const c = loaderCtx();
  c.applyLoadedState(legacyBlob(['e', 'a', 'c', 'b', 'd']));
  assert.deepEqual(ids(c), ['e', 'a', 'c', 'b', 'd']);
  assert.equal(c.state.threads.filter(t => 'order' in t).length, 2);
});
await check('a chat missing from the list (newer than it) sorts by its own activity', () => {
  const c = loaderCtx();
  c.applyLoadedState(legacyBlob(['b', 'c', 'a', 'd', 'e'], [chat('new', 60)]));
  assert.deepEqual(ids(c), ['new', 'b', 'c', 'a', 'd', 'e']);
});
await check('after carrying over, the next message floats a pinned chat (1.7.5 rule)', () => {
  const c = loaderCtx();
  c.applyLoadedState(legacyBlob(['b', 'c', 'a', 'd', 'e']));
  byId(c, 'a').messages.push(now());
  c.sortThreadsByOrder();
  assert.deepEqual(ids(c), ['a', 'b', 'c', 'd', 'e']);
});
await check('deterministic: the same list and chats give the same numbers on another device', () => {
  const one = loaderCtx(), two = loaderCtx();
  const blob = legacyBlob(['e', 'a', 'c', 'b', 'd']);
  one.applyLoadedState(structuredClone(blob));
  two.applyLoadedState(structuredClone(blob));
  const marks = ctx => JSON.stringify(Array.from(ctx.state.threads, t => [t.id, t.order, t.orderActivity]));
  assert.equal(marks(one), marks(two));
});
await check('a chat that already has an explicit order is left alone', () => {
  const c = loaderCtx();
  const blob = legacyBlob(['b', 'c', 'a', 'd', 'e']);
  blob.threads[3].order = at(45); blob.threads[3].orderActivity = at(20);   // d, placed by this build
  c.applyLoadedState(blob);
  assert.equal(byId(c, 'd').order, at(45));
});
await check('a blob without a legacy list pins nothing', () => {
  const c = loaderCtx();
  const blob = legacyBlob(undefined); delete blob.threadOrder;
  c.applyLoadedState(blob);
  assert.deepEqual(ids(c), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(c.state.threads.some(t => 'order' in t), false);
});

console.log('\n=== F. loadState persists the carry once ===');
function idbLoad(meta, threads, { failWrites = false } = {}) {
  const writes = [];
  const ctx = loaderCtx({
    STORAGE_BACKEND: 'idb', _idb: null, STORAGE_KEY: 'state', LEGACY_STORAGE_KEY: 'legacy',
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    idbOpen: async () => ({}),
    idbGet: async () => structuredClone(meta),
    idbGetAll: async () => structuredClone(threads),
    idbPut: async (store, value, key) => {
      if (failWrites) throw new Error('quota');
      writes.push({ store, key, value: structuredClone(value) });
    }
  });
  return { ctx, writes };
}
const legacyMeta = { threadOrder: ['b', 'c', 'a', 'd', 'e'], settings: { theme: 'kept' },
                     characterCards: [{ id: 'default', name: 'Assistant' }], activeCardId: 'default' };
const legacyThreads = () => [chat('a', 50), chat('b', 40), chat('c', 30), chat('d', 20), chat('e', 10)];
await check('IndexedDB: the pinned chats and the meta record minus the list are written', async () => {
  const { ctx, writes } = idbLoad(legacyMeta, legacyThreads());
  await ctx.loadState();
  assert.deepEqual(ids(ctx), ['b', 'c', 'a', 'd', 'e']);
  const threadWrites = writes.filter(w => w.store === 'threads');
  assert.deepEqual(threadWrites.map(w => w.value.id), ['a']);
  assert.equal(typeof threadWrites[0].value.order, 'number');
  const metaWrite = writes.find(w => w.store === 'meta');
  assert.equal(metaWrite.key, 'app');
  assert.equal('threadOrder' in metaWrite.value, false, 'the list is gone');
  assert.deepEqual(metaWrite.value.settings, { theme: 'kept' }, 'and nothing else in meta changed');
});
await check('the next load finds no list, writes nothing and shows the same arrangement', async () => {
  const first = idbLoad(legacyMeta, legacyThreads());
  await first.ctx.loadState();
  const meta2 = first.writes.find(w => w.store === 'meta').value;
  const pinned = new Map(first.writes.filter(w => w.store === 'threads').map(w => [w.value.id, w.value]));
  const threads2 = legacyThreads().map(t => pinned.get(t.id) || t);
  const second = idbLoad(meta2, threads2);
  await second.ctx.loadState();
  assert.equal(second.writes.length, 0);
  assert.deepEqual(ids(second.ctx), ['b', 'c', 'a', 'd', 'e']);
});
await check('even after the pinned chat floated, a reload does not pin it back', async () => {
  const first = idbLoad(legacyMeta, legacyThreads());
  await first.ctx.loadState();
  const meta2 = first.writes.find(w => w.store === 'meta').value;
  const a = first.writes.find(w => w.store === 'threads').value;
  a.messages.push(now());
  const second = idbLoad(meta2, legacyThreads().map(t => (t.id === 'a' ? a : t)));
  await second.ctx.loadState();
  assert.deepEqual(ids(second.ctx), ['a', 'b', 'c', 'd', 'e']);
});
await check('a failed write leaves the carried arrangement in memory, without throwing', async () => {
  const { ctx } = idbLoad(legacyMeta, legacyThreads(), { failWrites: true });
  await ctx.loadState();
  assert.deepEqual(ids(ctx), ['b', 'c', 'a', 'd', 'e']);
});
await check('localStorage fallback: the rewritten blob has the pins and no list', async () => {
  let written = null;
  const blob = { ...legacyMeta, threads: legacyThreads() };
  const ctx = loaderCtx({
    STORAGE_BACKEND: 'idb', STORAGE_KEY: 'state', LEGACY_STORAGE_KEY: 'legacy',
    idbOpen: async () => { throw new Error('no IndexedDB'); },
    localStorage: { getItem: k => (k === 'state' ? JSON.stringify(blob) : null), setItem: (k, v) => { written = JSON.parse(v); }, removeItem() {} },
    buildStateBlob: () => ({ settings: ctx.state.settings, threads: ctx.state.threads })
  });
  await ctx.loadState();
  assert.deepEqual(ids(ctx), ['b', 'c', 'a', 'd', 'e']);
  assert.ok(written, 'written back');
  assert.equal('threadOrder' in written, false);
  assert.equal(typeof written.threads.find(t => t.id === 'a').order, 'number');
});

console.log('\n=== G. sync: placement is never a content conflict ===');
function syncCtx() {
  const ctx = {
    console: quiet, IS_SERVED: true, isGenerating: false, TextEncoder,
    window: { location: { origin: 'http://local' }, innerWidth: 1000, addEventListener() {} },
    location: { reload() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    state: { threads: [], settings: {} }, RUNTIME_MESSAGE_FIELDS: ['_reasoningDone', '_parseState', '_smartLimitAt'],
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, alert() {}, confirm: () => true, structuredClone,
    fetch: async () => { throw new Error('offline'); }
  };
  vm.createContext(ctx);
  vm.runInContext(read('06-state-sync.js'), ctx);
  return ctx;
}
await check('copies that differ only in placement relate as the same conversation', () => {
  const s = syncCtx();
  const local = chat('x', 1, 2), server = structuredClone(local);
  local.order = at(5); local.orderActivity = at(2);
  server.order = at(7); server.orderActivity = at(1);
  assert.equal(s.relateThreads(local, server), 'same');
  delete server.order; delete server.orderActivity;
  assert.equal(s.relateThreads(local, server), 'same');
});
async function reconcileServerAhead(local, server) {
  const s = syncCtx();
  const applied = [];
  s.state.threads = [local];
  s.__L = { seeded: true, threads: { x: { etag: 'e1', n: local.messages.length, hash: 'stale' } } };
  s.__server = server;
  s.__applied = applied;
  vm.runInContext(`
    syncEnabled = () => true;
    currentLedger = () => __L;
    persistSyncLedger = () => {};
    fetchStateIndex = async () => ({ threads: [{ id: 'x', etag: 'e2' }] });
    fetchOneThread = async () => ({ thread: structuredClone(__server), etag: 'e2' });
    applyPulledThread = (thread) => { __applied.push(thread); return true; };
    updateSyncIndicator = () => {}; forceServerFlush = () => {}; saveState = () => {}; render = () => {};
  `, s);
  await s.reconcileWithServer({ reason: 'test' });
  return { s, applied };
}
await check('server-ahead: their messages, our placement -- both fields kept together', async () => {
  const local = chat('x', 1); local.order = at(5); local.orderActivity = at(1);
  const server = chat('x', 1, 2); server.order = at(9); server.orderActivity = at(0.5);
  const { s, applied } = await reconcileServerAhead(local, server);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].messages.length, 2, 'their appended message is taken');
  assert.equal(applied[0].order, at(5));
  assert.equal(applied[0].orderActivity, at(1), 'with our activity mark, not theirs');
  assert.equal(vm.runInContext('stateSync.pendingPush', s), true, 'and our placement goes back out');
});
await check('server-ahead: a local placement without a mark does not inherit theirs', async () => {
  const local = chat('x', 1); local.order = at(5);
  const server = chat('x', 1, 2); server.order = at(9); server.orderActivity = at(0.5);
  const { applied } = await reconcileServerAhead(local, server);
  assert.equal(applied[0].order, at(5));
  assert.equal('orderActivity' in applied[0], false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
