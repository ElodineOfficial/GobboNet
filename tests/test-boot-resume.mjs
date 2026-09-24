// Boot after a failed server-state check: reply recovery and local saves.
//
// 1.7.5 resumed pending replies after the startup state check whatever its
// outcome -- the chain was check().catch().then(resumePendingJobs). The
// state-handshake round made a failed check pause sync (correct: no ledger
// seeding on the strength of a request that failed) but its else-branch also
// skipped resumePendingJobs(), so a reply that finished while the page was
// closed was not collected, and one still running was not re-attached.
//
// The same failure path saved the one-time remote-image notice flag with a
// thread-only checkpoint, which on IndexedDB does not write settings: the
// alert came back on every boot. saveState({localOnly}) is the full local save
// that still schedules nothing for the server.
//
// Drives the real js/24-boot.js, the real sync layer and the real saveState().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = n => fs.readFileSync(new URL('../js/' + n, import.meta.url), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + (e && e.message)); failed++; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

// Same shape as tests/test-state-handshake.mjs, instrumented for this suite:
// the real restore/migration code, so a successful check really restores.
const persistenceSrc = read('05-persistence.js');
const applySrc = persistenceSrc.slice(persistenceSrc.indexOf('function applyLoadedState('),
                                      persistenceSrc.indexOf('// Async loader.'));
const cardCodeSrc = read('23-card-code.js');
const neutralizeSrc = cardCodeSrc.slice(cardCodeSrc.indexOf('function neutralizeUntrustedCode('),
                                        cardCodeSrc.indexOf('/**\n * Strip code off'));
function harness({ status = 200, noticeSeen = true, remoteNoticeSeen = true } = {}) {
  const resumed = [], saves = [], paints = [];
  const remote = { threads: [], characterCards: [{ id: 'a', name: 'One' }], settings: remoteNoticeSeen ? { remoteImageNoticeSeen: true } : {} };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, IS_SERVED: true,
    window: { location: { origin: 'http://local' }, innerWidth: 1000, addEventListener() {} },
    location: { reload() { throw Error('Unexpected reload'); } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {}, getElementById: () => ({ classList: { toggle() {} }, textContent: '' }), querySelector: () => null },
    state: { threads: [], settings: noticeSeen ? { remoteImageNoticeSeen: true } : {}, characterCards: [{ id: 'default', name: 'Assistant' }] },
    isGenerating: false, STORAGE_BACKEND: 'localstorage', storageQuotaHit: false, STORAGE_KEY: 'state',
    DEFAULT_SETTINGS: {}, DEFAULT_CARD: { id: 'default' }, DEFAULT_PERSONA: { id: 'default' }, DEFAULT_MACROS: [],
    STATE_SCHEMA_VERSION: 1, loadedSchemaVersion: null, hadOwnSettings: false, sortThreadsByOrder() {},
    migrateExtensions: e => e || {}, _idbFullSaveTimer: null, _idbPendingBlob: null,
    buildStateBlob: () => structuredClone(ctx.state), buildStateMeta: () => ({ settings: ctx.state.settings }),
    isQuotaError: e => e.name === 'QuotaExceededError',
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, TextEncoder, alert() {}, confirm: () => true,
    isSuppressedRemoteImage: () => false, searchEnabled: false, defaultCharacters: [], _appBooted: false,
    loadState: async () => {}, loadServerPresets: async () => {}, seedSettingsFromServerPresets() {},
    loadActiveModel: async () => {}, loadModelsList() {}, setupInput() {}, applyExtensions() {}, applyCardCode() {},
    applyAvatarScale() {}, render() { paints.push(1); }, scrollToBottom() {}, attachScrollPinTracking() {},
    applyActiveCardBackground() {}, updateSchedCount() {}, checkConnection: async () => {}, checkSchedules() {},
    saveState(opts) { saves.push(opts === undefined ? 'undefined' : JSON.parse(JSON.stringify(opts))); },
    resumePendingJobs: async () => { resumed.push(ctx._appBooted); },
    fetch: async (url) => {
      if (url === 'default-characters.json') return { ok: true, json: async () => [] };
      if (status === 0) throw Error('Network unavailable');
      return { ok: status === 200, status, headers: { get: () => '42' },
        json: async () => url.includes('/info') ? { size: 500, mtime: 42 } : structuredClone(remote),
        text: async () => JSON.stringify(remote) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(applySrc + '\n' + neutralizeSrc + '\n' + read('06-state-sync.js'), ctx);
  vm.runInContext('updateSyncIndicator = () => {}; persistSyncMeta = () => {};' +
                  'ensureSyncLedger = async () => true; reconcileWithServer = async () => {};', ctx);
  return {
    ctx, resumed, saves, paints,
    async boot() {
      vm.runInContext(read('24-boot.js'), ctx);
      const result = await ctx.window.GobboNet.ready;
      for (let i = 0; i < 5; i++) await tick();   // let the background chain settle
      return result;
    }
  };
}

console.log('\n=== A. pending replies resume whatever the state check said ===');
for (const [label, status] of [['a network failure', 0], ['a server error (500)', 500], ['an authentication failure (401)', 401]]) {
  await check(`after ${label}, boot still resumes pending replies`, async () => {
    const h = harness({ status });
    const result = await h.boot();
    assert.equal(result.ok, false, 'the failed check is still reported');
    assert.equal(h.resumed.length, 1, 'resumePendingJobs ran once');
    assert.equal(h.ctx._appBooted, true, 'and wake-driven resumes are armed');
    assert.equal(h.resumed[0], false, 'the boot pass runs before wake resumes are armed, as in 1.7.5');
  });
}
await check('after a successful check, replies resume too (unchanged path)', async () => {
  const h = harness({ status: 200 });
  const result = await h.boot();
  assert.equal(result.ok, true);
  assert.equal(h.resumed.length, 1);
  assert.equal(h.ctx._appBooted, true);
});

console.log('\n=== B. the one-time notice flag reaches storage after a failed check ===');
await check('a failed check saves with localOnly (full local save, no push)', async () => {
  const h = harness({ status: 0, noticeSeen: false });
  await h.boot();
  assert.equal(h.ctx.state.settings.remoteImageNoticeSeen, true);
  assert.deepEqual(h.saves, [{ localOnly: true }]);
});
await check('a successful check saves normally (schedules the push, as before)', async () => {
  // The restore adopts the server's settings, so the server's copy is unseen too.
  const h = harness({ status: 200, noticeSeen: false, remoteNoticeSeen: false });
  await h.boot();
  const noticeSave = h.saves[h.saves.length - 1];
  assert.ok(noticeSave !== undefined, 'a save happened');
  assert.ok(!noticeSave.localOnly && !noticeSave.skipServerSchedule, JSON.stringify(h.saves));
});

console.log('\n=== C. saveState({localOnly}) semantics, real function ===');
const persistence = read('05-persistence.js');
const saveSrc = persistence.slice(persistence.indexOf('function saveState('),
                                  persistence.indexOf('\n}\n', persistence.indexOf('function saveState(')) + 3);
function saveHarness(backend) {
  const calls = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, STORAGE_BACKEND: backend, storageQuotaHit: false,
    state: { threads: [{ id: 't1', messages: [] }], activeThreadId: 't1', settings: { remoteImageNoticeSeen: true } },
    buildStateBlob: () => ({ settings: { remoteImageNoticeSeen: true }, threads: [] }),
    getActiveThread: () => ({ id: 't1', messages: [] }), cleanThread: t => t,
    idbPut: (store) => { calls.push('idbPut:' + store); return Promise.resolve(); },
    saveFullToIdb: () => calls.push('saveFullToIdb'),
    scheduleStateSync: () => calls.push('scheduleStateSync'),
    localStorage: { setItem: () => calls.push('localStorage.setItem') },
    STORAGE_KEY: 'k', isQuotaError: () => false, syncEnabled: () => true, updateSyncIndicator() {},
    stateSync: { status: 'ok' }
  };
  vm.createContext(ctx);
  vm.runInContext(saveSrc, ctx);
  return { ctx, calls };
}
await check('IndexedDB, localOnly: full save, nothing scheduled', () => {
  const h = saveHarness('idb'); h.ctx.saveState({ localOnly: true });
  assert.deepEqual(h.calls, ['saveFullToIdb']);
});
await check('IndexedDB, skipServerSchedule: still the one-thread checkpoint', () => {
  const h = saveHarness('idb'); h.ctx.saveState({ skipServerSchedule: true });
  assert.deepEqual(h.calls, ['idbPut:threads']);
});
await check('IndexedDB, default: full save and scheduled push, unchanged', () => {
  const h = saveHarness('idb'); h.ctx.saveState();
  assert.deepEqual(h.calls, ['scheduleStateSync', 'saveFullToIdb']);
});
await check('localStorage, localOnly: written, nothing scheduled', () => {
  const h = saveHarness('localstorage'); h.ctx.saveState({ localOnly: true });
  assert.deepEqual(h.calls, ['localStorage.setItem']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
