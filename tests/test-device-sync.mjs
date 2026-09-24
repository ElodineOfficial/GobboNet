// DEVICE SYNC choices (DATA -> DEVICE SYNC: shared / separate profile / off).
//
// In 1.7.5 a device switched into a new profile, kept its own data over an
// existing backup, or turned sync back on, and was simply "synced". After the
// per-conversation rewrite each of those ended in "chat conflict": the
// whole-document seed wrote every conversation, left the ledger empty, and the
// pushes that followed tried to CREATE each one again -- 412, counted as a
// conflict. A second path raised a false conflict PROMPT on the first device
// to load a chat that lacked the loader's default fields (integration-made,
// imported, older clients).
//
//   A  the seed records what it wrote, verified against the index -- and
//      falls back to the old behaviour when another write got in between
//   B  copies differing only in load-time defaults relate as the same chat
//   C  those defaults stay equal to the ones the loader actually fills in
//
// Drives the real js/06-state-sync.js against an in-memory server that keeps
// the real protocol's rules (conditional headers, 412, index with ETags).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = n => fs.readFileSync(new URL('../js/' + n, import.meta.url), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + (e && e.message)); failed++; }
}

// ---- an in-memory state server with the protocol's rules -----------------
function stateServer() {
  let doc = null, n = 0, mtime = 1700000000000;
  const calls = [];
  const etag = () => '"e' + (++n) + '"';
  const ok = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: k => headers[k] || (k === 'X-State-Protocol' ? '2' : null) },
    json: async () => body, text: async () => JSON.stringify(body)
  });
  const index = () => ({
    documentEtag: doc.etag, meta: doc.metaEtag, mtime: doc.mtime,
    threads: [...doc.threads.values()].map(t => ({ id: t.id, etag: t.etag, messages: t.body.messages.length, bytes: 1 }))
  });
  const srv = {
    calls, get doc() { return doc; },
    // Another device writing to the same backup.
    foreignEdit(id) { const t = doc.threads.get(id); t.body = { ...t.body, name: 'edited elsewhere' }; t.etag = etag(); doc.etag = etag(); doc.mtime = ++mtime; },
    afterSeed: null,
    async fetch(url, opts = {}) {
      const u = new URL(url, 'http://local'); const method = opts.method || 'GET';
      const h = opts.headers || {}; const path = u.pathname;
      calls.push(method + ' ' + path + (h['If-None-Match'] ? ' INM' : h['If-Match'] ? ' IM' : ''));
      if (path === '/state/info') return doc ? ok(200, { size: 1000, mtime: doc.mtime }) : ok(404, {});
      if (path === '/state/index') return doc ? ok(200, index()) : ok(404, {});
      if (path === '/state' && method === 'PUT') {
        if (h['If-None-Match'] === '*' && doc) return ok(412, { etag: doc.etag });
        if (h['If-Match'] && (!doc || h['If-Match'] !== doc.etag)) return ok(412, { etag: doc && doc.etag });
        const body = JSON.parse(opts.body);
        doc = { threads: new Map(), metaEtag: etag(), etag: etag(), mtime: ++mtime };
        for (const t of body.threads || []) doc.threads.set(t.id, { id: t.id, etag: etag(), body: t });
        const resp = ok(200, { status: 'ok', mtime: doc.mtime });
        if (srv.afterSeed) { srv.afterSeed(); srv.afterSeed = null; }
        return resp;
      }
      let m = path.match(/^\/state\/threads\/([^/]+)$/);
      if (m && method === 'PUT') {
        const id = decodeURIComponent(m[1]); const cur = doc && doc.threads.get(id);
        if (h['If-None-Match'] === '*' && cur) return ok(412, { etag: cur.etag, messages: cur.body.messages.length });
        if (h['If-Match'] && (!cur || h['If-Match'] !== cur.etag)) return ok(412, { etag: cur && cur.etag });
        const t = { id, etag: etag(), body: JSON.parse(opts.body) };
        doc.threads.set(id, t); doc.etag = etag(); doc.mtime = ++mtime;
        return ok(200, { etag: t.etag, messages: t.body.messages.length, mtime: doc.mtime });
      }
      m = path.match(/^\/state\/threads\/([^/]+)\/append$/);
      if (m && method === 'POST') {
        const cur = doc && doc.threads.get(decodeURIComponent(m[1]));
        if (!cur || h['If-Match'] !== cur.etag) return ok(412, { etag: cur && cur.etag });
        cur.body = { ...cur.body, messages: cur.body.messages.concat(JSON.parse(opts.body)) };
        cur.etag = etag(); doc.etag = etag(); doc.mtime = ++mtime;
        return ok(200, { etag: cur.etag, messages: cur.body.messages.length, mtime: doc.mtime });
      }
      m = path.match(/^\/state\/threads\/([^/]+)$/);
      if (m && method === 'GET') {
        const cur = doc && doc.threads.get(decodeURIComponent(m[1]));
        return cur ? ok(200, cur.body, { ETag: cur.etag }) : ok(404, {});
      }
      if (path === '/state/meta' && method === 'PUT') {
        if (h['If-None-Match'] === '*' && doc) return ok(412, { etag: doc.metaEtag });
        if (h['If-Match'] && h['If-Match'] !== doc.metaEtag) return ok(412, { etag: doc.metaEtag });
        doc.metaEtag = etag(); doc.etag = etag(); doc.mtime = ++mtime;
        return ok(200, { etag: doc.metaEtag, mtime: doc.mtime });
      }
      return ok(404, {});
    }
  };
  return srv;
}

const chat = (id, n, extra) => ({ id, name: id, createdAt: 1, pinned: false, folderId: null, tags: [], forkSource: null,
  messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: id + i, timestamp: 1000 + i })), ...(extra || {}) });

function client(srv, threads) {
  const store = new Map();
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, IS_SERVED: true, isGenerating: false, TextEncoder,
    window: { location: { origin: 'http://local' }, innerWidth: 1000, addEventListener() {} },
    location: { reload() { throw new Error('unexpected reload'); } },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    state: { threads, settings: {} }, RUNTIME_MESSAGE_FIELDS: ['_reasoningDone', '_parseState', '_smartLimitAt'],
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, alert() {}, confirm: () => true, structuredClone,
    buildStateMeta: () => ({ settings: { theme: 'x' } }),
    cleanThread: t => structuredClone(t),
    redactedSyncJson: () => JSON.stringify({ threads: ctx.state.threads, settings: { theme: 'x' } }),
    fetch: (u, o) => srv.fetch(u, o)
  };
  vm.createContext(ctx);
  vm.runInContext(read('06-state-sync.js'), ctx);
  vm.runInContext('updateSyncIndicator = () => {};', ctx);
  return { ctx, get: e => vm.runInContext(e, ctx) };
}

console.log('\n=== A. seeding a target records what it wrote ===');
await check('switching into a new profile: one upload, no re-creates, no conflict', async () => {
  const srv = stateServer();
  const c = client(srv, [chat('a', 2), chat('b', 1)]);
  c.get('invalidateLedger()');
  await c.ctx.pushChangedConversations();
  assert.deepEqual(srv.calls.filter(x => x.startsWith('PUT')), ['PUT /state INM'], srv.calls.join(', '));
  assert.notEqual(c.get('stateSync.status'), 'conflict');
  const L = c.get('currentLedger()');
  assert.deepEqual(Object.keys(L.threads).sort(), ['a', 'b']);
  assert.equal(L.threads.a.etag, srv.doc.threads.get('a').etag, 'with the server\u2019s own version');
  assert.equal(L.meta, srv.doc.metaEtag);
});
await check('the next message after seeding goes out as an append', async () => {
  const srv = stateServer();
  const c = client(srv, [chat('a', 2)]);
  c.get('invalidateLedger()');
  await c.ctx.pushChangedConversations();
  c.ctx.state.threads[0].messages.push({ role: 'user', content: 'more', timestamp: 5000 });
  srv.calls.length = 0;
  await c.ctx.pushChangedConversations();
  assert.deepEqual(srv.calls.filter(x => !x.startsWith('GET')), ['POST /state/threads/a/append IM']);
});
await check('keeping this device over an existing backup (If-Match seed): no conflict', async () => {
  const srv = stateServer();
  await srv.fetch('/state', { method: 'PUT', headers: {}, body: JSON.stringify({ threads: [chat('old', 1)] }) });
  const c = client(srv, [chat('a', 2)]);
  c.get('invalidateLedger(undefined, true)');
  await c.ctx.pushChangedConversations();
  assert.deepEqual(srv.calls.filter(x => x.startsWith('PUT') && !x.includes('/state INM')).slice(-1), ['PUT /state IM']);
  assert.notEqual(c.get('stateSync.status'), 'conflict');
  assert.deepEqual([...srv.doc.threads.keys()], ['a']);
});
await check('another write between the upload and the index: nothing is adopted', async () => {
  const srv = stateServer();
  const c = client(srv, [chat('a', 2), chat('b', 1)]);
  srv.afterSeed = () => srv.foreignEdit('a');
  c.get('invalidateLedger()');
  await c.ctx.pushChangedConversations();
  const L = c.get('currentLedger()');
  assert.equal(L.threads.a && L.threads.a.etag === srv.doc.threads.get('a').etag && L.threads.a.hash, undefined,
               'the foreign version was not recorded as ours');
  assert.equal(c.get('stateSync.status'), 'conflict', 'so it is surfaced, as before, rather than skipped');
});
await check('an index holding a conversation we did not send is not adopted', async () => {
  const srv = stateServer();
  const c = client(srv, [chat('a', 1)]);
  srv.afterSeed = () => { srv.doc.threads.set('x', { id: 'x', etag: '"ex"', body: chat('x', 1) }); };
  c.get('invalidateLedger()');
  await c.ctx.pushChangedConversations();
  assert.equal(c.get('seededIndexMatches({ threads: [{ id: "a", etag: "e", messages: 1 }, { id: "x", etag: "e", messages: 1 }] }, new Map([["a", { n: 1, hash: "h" }]]))'), false);
});

console.log('\n=== B. load-time defaults are not a change ===');
await check('a chat without the defaults relates as the same chat once loaded', () => {
  const c = client(stateServer(), []);
  const server = { id: 'm', name: 'Integration chat', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
  const local = { ...structuredClone(server), pinned: false, folderId: null, tags: [], forkSource: null };
  assert.equal(c.ctx.relateThreads(local, server), 'same');
});
await check('a real change to one of those fields is still a change', () => {
  const c = client(stateServer(), []);
  const server = { id: 'm', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
  const local = { ...structuredClone(server), pinned: true, folderId: null, tags: [], forkSource: null };
  assert.notEqual(c.ctx.relateThreads(local, server), 'same');
});
await check('appended messages on a chat without defaults still read as server-ahead', () => {
  const c = client(stateServer(), []);
  const local = { id: 'm', pinned: false, folderId: null, tags: [], forkSource: null, messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
  const server = { id: 'm', messages: [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'yo', timestamp: 2 }] };
  assert.equal(c.ctx.relateThreads(local, server), 'server-ahead');
});

console.log('\n=== C. the defaults match what the loader fills in ===');
await check('THREAD_LOAD_DEFAULTS equals applyLoadedState\u2019s migration block', () => {
  const persistence = read('05-persistence.js');
  const block = persistence.slice(persistence.indexOf('Migrate threads: add folder/pin/tag/branch fields if missing'));
  const loop = block.slice(0, block.indexOf('}'));
  const loader = {};
  for (const m of loop.matchAll(/if \(!t\.hasOwnProperty\('(\w+)'\)\)\s*t\.\1\s*=\s*([^;]+);/g)) loader[m[1]] = JSON.parse(m[2].trim());
  const c = client(stateServer(), []);
  assert.deepEqual(JSON.parse(c.get('JSON.stringify(THREAD_LOAD_DEFAULTS)')), loader);
  assert.ok(Object.keys(loader).length >= 4, 'found the loader\u2019s defaults');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
