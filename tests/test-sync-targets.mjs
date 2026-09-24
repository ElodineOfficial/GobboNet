/**
 * Device sync targets — the client half of "make sharing between phone and
 * computer optional".
 *
 * WHY THE FEATURE EXISTS
 * ----------------------
 * A phone and a desktop shared one chat history because there was exactly one
 * file on the server. That was never a decision, it was an implementation
 * detail with a user-visible consequence. A device now picks one of three
 * targets: the shared backup (the default, and what every existing install
 * does), a named profile of its own, or nothing at all.
 *
 * THE TWO THINGS MOST LIKELY TO GO WRONG
 * --------------------------------------
 * 1. THE DEFAULT MOVING. Every install in the field has no target stored. If
 *    an absent or unreadable value resolved to anything other than "shared",
 *    every existing user would boot into an empty chat with their history
 *    still sitting on the server. Section A is about nothing else.
 *
 * 2. THE CHOICE BEING SYNCED. The target must live in its own localStorage
 *    key, never in state.settings, because settings are part of the payload a
 *    restore overwrites. A phone that pulled the desktop's backup would
 *    inherit the desktop's target and silently re-join the two histories — the
 *    separation undone by the act of restoring. Section E pins that.
 *
 * This drives the real functions out of js/06-state-sync.js against a fake
 * localStorage and a fake fetch, so the URLs asserted on are the URLs the
 * browser would actually request.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/06-state-sync.js', 'utf8');

const slice = (from, to) => {
  const a = SRC.indexOf(from);
  const b = to ? SRC.indexOf(to) : SRC.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error('could not locate ' + JSON.stringify(from) + ' in js/06-state-sync.js');
    process.exit(1);
  }
  return SRC.slice(a, b);
};

// Everything from the target model down to (but not including)
// restoreFromServer, plus the switch section at the end of the file.
//
// The real scheduleStateSync / flushStateSync / forceServerFlush are included
// deliberately: a stub would let a switch "push" without ever proving that the
// push path honours the target, which is most of what is being checked here.
// restoreFromServer is excluded because it ends in location.reload(); the
// context stubs it so the switch can be observed choosing it.
const MODEL = slice('const STATE_SYNC_AVAILABLE', 'async function restoreFromServer');
const SWITCH = slice('/** What is on the server.');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* ================================================================
   A fake browser
================================================================ */

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

/**
 * @param served      false models file:// — there is no server at all
 * @param storage     seed values for localStorage
 * @param server      { [path]: {mtime,size} | null } keyed by url without origin
 * @param confirmWith what confirm() returns
 */
function build({ served = true, storage = {}, server = {}, confirmWith = true,
                 putMtime = 1700000000000 } = {}) {
  const ls = makeStorage(storage);
  const calls = [];
  const confirms = [];
  const state = { threads: [{ id: 't1' }], settings: {} };

  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    localStorage: ls,
    window: { location: { origin: 'http://192.168.1.5:8080' } },
    IS_SERVED: served,
    Date, JSON, Math, Number, String, Object, Array, Promise, RegExp, Error,
    encodeURIComponent,
    setTimeout: (fn) => { return 1; },      // never actually fires
    clearTimeout: () => {},
    confirm: (msg) => { confirms.push(msg); return confirmWith; },
    alert: () => {},
    state,
    buildStateMeta: () => ({ settings: {} }),
    RUNTIME_MESSAGE_FIELDS: [],
    cleanThread: t => t,
    isGenerating: false,
    getActiveThread: () => state.threads[0],
    redactedSyncJson: () => JSON.stringify(state),
    updateSyncIndicator: () => {},
    restoreFromServer: async () => { calls.push({ method: 'RESTORE' }); return true; },
    fetch: async (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      const path = String(url).replace('http://192.168.1.5:8080', '');
      calls.push({ method, path });
      if (path === '/state/profiles') {
        const profiles = Object.keys(server)
          .filter(k => k.startsWith('/state') && k !== '/state/profiles' && server[k])
          .map(k => {
            const m = /profile=([^&]+)/.exec(k);
            return { name: m ? m[1] : '', shared: !m, mtime: server[k].mtime, size: server[k].size };
          });
        return { ok: true, status: 200, json: async () => ({ profiles }) };
      }
      const key = path.replace('/info', '');
      const rec = server[key];
      if (path.includes('/index')) {
        const exists = server[path.replace('/index', '')];
        return { ok: !!exists, status: exists ? 200 : 404,
          headers: { get: () => '2' },
          json: async () => ({ threads: [], meta: 'meta', documentEtag: 'document' }) };
      }
      if (path.endsWith('/info') || path.includes('/info?')) {
        if (!rec) return { ok: false, status: 404, json: async () => ({ error: 'no state on server' }) };
        return { ok: true, status: 200, json: async () => rec };
      }
      if (method === 'DELETE') { delete server[key]; return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }; }
      if (method === 'PUT' || method === 'POST') {
        server[key] = { mtime: putMtime || 1700000000000, size: 42 };
        // A response without an mtime is a shape the client already tolerates
        // (it checks typeof before using it). Section F uses it to keep a
        // successful push from overwriting the value under test.
        const body = putMtime ? { status: 'ok', mtime: putMtime } : { status: 'ok' };
        return { ok: true, status: 200, json: async () => body };
      }
      if (!rec) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ threads: [] }) };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(MODEL + '\n' + SWITCH, ctx);
  // Top-level let/const in a vm script live in the script's lexical scope, not
  // on the context object -- only var and function declarations land there. So
  // `syncTarget` and `stateSync` have to be reached by evaluating their names.
  // The returned objects are live references, so mutating one mutates the real
  // thing the code under test sees.
  const get = (expr) => vm.runInContext(expr, ctx);
  return { ctx, ls, calls, confirms, server, get };
}

/* ================================================================
   A. THE DEFAULT DOES NOT MOVE
================================================================ */
console.log('\n=== A. every existing install keeps sharing ===');
{
  const h = build();                       // nothing in localStorage at all
  eq(h.get('syncTarget').mode, 'shared', 'no stored target means shared');
  eq(h.ctx.syncTargetLabel(), 'shared', 'and it labels itself shared');
  eq(h.ctx.stateSyncUrl(''), 'http://192.168.1.5:8080/state',
     'the push URL is /state with no query string, exactly as before');
  eq(h.ctx.stateSyncUrl('/info'), 'http://192.168.1.5:8080/state/info',
     'and so is the boot check');
  ok(h.ctx.syncEnabled(), 'sync is on');

  // Anything unreadable or unrecognised has to land on shared too, not on some
  // half-applied state.
  for (const [label, raw] of [
    ['malformed JSON', '{not json'],
    ['null', 'null'],
    ['a bare string', '"phone"'],
    ['an unknown mode', '{"mode":"telepathy","profile":"x"}'],
    ['profile mode with no name', '{"mode":"profile","profile":""}'],
    ['profile mode with an illegal name', '{"mode":"profile","profile":"../../etc"}'],
  ]) {
    const b = build({ storage: { gobbonet_sync_target: raw } });
    eq(b.get('syncTarget').mode, 'shared', `${label} falls back to shared`);
    eq(b.ctx.stateSyncUrl(''), 'http://192.168.1.5:8080/state', `  ...and to the unqualified URL`);
  }

  const f = build({ served: false });
  eq(f.ctx.stateSyncUrl(''), null, 'on file:// there is no URL to build');
  ok(!f.ctx.syncEnabled(), 'and nothing is enabled');
}

/* ================================================================
   B. A PROFILE IS A DIFFERENT TARGET
================================================================ */
console.log('\n=== B. a named profile ===');
{
  const h = build({ storage: { gobbonet_sync_target: '{"mode":"profile","profile":"phone"}' } });
  eq(h.get('syncTarget').mode, 'profile', 'the stored mode is read back');
  eq(h.ctx.syncTargetLabel(), 'phone', 'the label is the profile name');
  eq(h.ctx.stateSyncUrl(''), 'http://192.168.1.5:8080/state?profile=phone', 'the push URL carries it');
  eq(h.ctx.stateSyncUrl('/info'), 'http://192.168.1.5:8080/state/info?profile=phone',
     'and so does the boot check, or the two would disagree about which file they mean');
  ok(h.ctx.syncEnabled(), 'sync is still on — a profile is separation, not opting out');

  // The client allowlist has to match the server's, or a name the UI accepts
  // becomes an endless run of failed background syncs with nothing on screen.
  const N = h.ctx.normalizeSyncProfile;
  for (const good of ['phone', 'a', '0', 'my-phone', 'my_phone', 'x'.repeat(32)]) {
    eq(N(good), good, `"${good}" is accepted`);
  }
  eq(N('Phone'), 'phone', 'names fold to lower case, so one name is one file on every OS');
  eq(N('  phone  '), 'phone', 'and surrounding space is trimmed');
  for (const bad of ['../../etc/passwd', '..', '.', 'a/b', 'a\\b', 'has space',
                     'dot.name', '-leading', '_leading', 'x'.repeat(33), '', 'caf\u00e9']) {
    eq(N(bad), '', `${JSON.stringify(bad)} is refused`);
  }
}

/* ================================================================
   C. OFF MEANS OFF
================================================================ */
console.log('\n=== C. off ===');
{
  const h = build({ storage: { gobbonet_sync_target: '{"mode":"off","profile":""}' } });
  ok(h.ctx.syncIsOff(), 'the device reports itself off');
  ok(!h.ctx.syncEnabled(), 'so nothing in this file may touch the network');
  eq(h.get('stateSync').status, 'off', 'and the indicator has a state of its own, not "idle"');

  // Behavioural, not just a source guard: with the target off, the push path
  // and the boot check must make no request at all, even with a backup sitting
  // on the server that they would otherwise find.
  const q = build({ storage: { gobbonet_sync_target: '{"mode":"off","profile":""}' },
                    server: { '/state': { mtime: 1700000000000, size: 9000 } } });
  q.ctx.scheduleStateSync('{"threads":[]}');
  q.ctx.forceServerFlush();
  await q.ctx.checkServerStateOnBoot();
  eq(q.calls.length, 0, 'the push and boot paths issue nothing', JSON.stringify(q.calls));

  // 'off' has to be distinguishable from 'disabled'. One is a choice; the
  // other is file:// with no server to choose.
  const f = build({ served: false });
  eq(f.get('stateSync').status, 'disabled', 'file:// is disabled, which is a different thing');
}

/* ================================================================
   D. SWITCHING
================================================================ */
console.log('\n=== D. switching target ===');
{
  // Into an empty slot: nothing to overwrite, so no question is asked.
  let h = build();
  let res = await h.ctx.applySyncTarget('profile', 'phone');
  await new Promise(resolve => setImmediate(resolve));
  eq(res, 'seeded', 'switching into an unused profile seeds it');
  eq(h.confirms.length, 0, 'without asking anything, because nothing could be lost');
  ok(h.calls.some(c => c.method === 'PUT' && c.path === '/state?profile=phone'),
     'and this device\u2019s data is pushed there', JSON.stringify(h.calls));

  // Into an occupied slot: the user is asked, and both answers are honoured.
  h = build({ server: { '/state?profile=phone': { mtime: 1700000000000, size: 9000 } }, confirmWith: true });
  res = await h.ctx.applySyncTarget('profile', 'phone');
  await new Promise(resolve => setImmediate(resolve));
  eq(res, 'restoring', 'switching into an occupied profile can load it');
  eq(h.confirms.length, 1, 'after exactly one question');
  ok(/already holds a backup/.test(h.confirms[0]), 'which says the slot is occupied', h.confirms[0]);
  ok(/9 KB/.test(h.confirms[0]), 'and how much is in it', h.confirms[0]);

  h = build({ server: { '/state?profile=phone': { mtime: 1700000000000, size: 9000 } }, confirmWith: false });
  res = await h.ctx.applySyncTarget('profile', 'phone');
  await new Promise(resolve => setImmediate(resolve));
  eq(res, 'pushed', 'or overwrite it with this device');
  ok(h.calls.some(c => c.method === 'PUT' && c.path === '/state?profile=phone'),
     'which pushes rather than restoring', JSON.stringify(h.calls));
  ok(!h.calls.some(c => c.method === 'RESTORE'), 'and never both');

  // Switching off must not touch the server at all — least of all delete
  // anything. "Stop syncing" is not "destroy the backup".
  h = build({ server: { '/state': { mtime: 1, size: 10 } } });
  res = await h.ctx.applySyncTarget('off', '');
  eq(res, 'off', 'switching off reports off');
  eq(h.calls.length, 0, 'and makes no request whatsoever', JSON.stringify(h.calls));
  ok(h.server['/state'], 'the shared backup is left exactly where it was');

  // A no-op switch stays a no-op.
  h = build();
  eq(await h.ctx.applySyncTarget('shared', ''), 'unchanged', 'choosing the current target changes nothing');
  eq(h.calls.length, 0, 'and asks the server nothing');

  // A bad name must be refused rather than silently landing on shared.
  h = build();
  eq(await h.ctx.applySyncTarget('profile', '../etc'), 'invalid', 'an illegal profile name is refused');
  eq(h.get('syncTarget').mode, 'shared', 'and the target is left alone');
  eq(await h.ctx.applySyncTarget('profile', ''), 'invalid', 'so is an empty one');
  eq(await h.ctx.applySyncTarget('telepathy', ''), 'invalid', 'so is an unknown mode');
}

/* ================================================================
   E. THE CHOICE IS THIS DEVICE'S
================================================================ */
console.log('\n=== E. the target is not part of the synced payload ===');
{
  const h = build();
  await h.ctx.applySyncTarget('profile', 'phone');
  const dump = h.ls._dump();

  ok('gobbonet_sync_target' in dump, 'the choice is persisted under its own key');
  eq(JSON.parse(dump.gobbonet_sync_target).profile, 'phone', 'with the chosen profile');

  // The payload is what a restore overwrites. If the target were in there, a
  // device restoring the desktop's backup would adopt the desktop's target and
  // silently re-join the histories it was separated from.
  const payload = h.ctx.redactedSyncJson();
  ok(!/sync_target|stickyCards?Target|"mode":"profile"/.test(payload),
     'and never appears in the synced payload', payload.slice(0, 120));
  ok(!('syncTarget' in h.ctx.state.settings), 'nor in state.settings');
}

/* ================================================================
   F. PER-TARGET BOOKKEEPING

   lastKnownMtime answers "has anything written to MY file since I last
   looked". Carried across a switch it compares two unrelated clocks, and the
   boot check then either skips a restore it owed or offers one it did not.
================================================================ */
console.log('\n=== F. mtime is remembered per target ===');
{
  // No mtime in the PUT response. A successful push legitimately updates
  // lastKnownMtime, and that would land on top of the value being asserted
  // here -- which is about what a SWITCH adopts, not about what a push then
  // does with it. The two are separate behaviours and are separated here.
  const h = build({ putMtime: null });
  h.get('stateSync').lastKnownMtime = 1000;
  h.ctx.persistSyncMeta();
  await h.ctx.applySyncTarget('profile', 'phone');
  eq(h.get('stateSync').lastKnownMtime, 0, 'a new target starts with no history of its own');

  h.get('stateSync').lastKnownMtime = 5000;
  h.ctx.persistSyncMeta();
  await h.ctx.applySyncTarget('shared', '');
  eq(h.get('stateSync').lastKnownMtime, 1000, 'and switching back recalls the right one');

  const meta = JSON.parse(h.ls._dump().gobbonet_sync_meta);
  eq(meta.byTarget.shared, 1000, 'both are kept');
  eq(meta.byTarget.phone, 5000, 'side by side');

  // 'off' is not a file, so it must not acquire an entry of its own.
  const o = build({ putMtime: null });
  o.get('stateSync').lastKnownMtime = 42;
  await o.ctx.applySyncTarget('off', '');
  o.ctx.persistSyncMeta();
  ok(!('off' in JSON.parse(o.ls._dump().gobbonet_sync_meta).byTarget),
     'switching off leaves no meaningless entry in the map');

  // An install written before targets existed stored a bare lastKnownMtime.
  // It can only have described the shared file.
  const legacy = build({ storage: { gobbonet_sync_meta: '{"lastKnownMtime":777}' } });
  eq(legacy.get('stateSync').lastKnownMtime, 777, 'a legacy mtime is adopted by the shared target');
  legacy.ctx.persistSyncMeta();
  const out = JSON.parse(legacy.ls._dump().gobbonet_sync_meta);
  eq(out.lastKnownMtime, 777, 'and is mirrored at the top level, so a downgrade still finds it');
  eq(out.byTarget.shared, 777, 'as well as in the map');
}

/* ================================================================
   G. LISTING AND DELETING
================================================================ */
console.log('\n=== G. managing what is on the server ===');
{
  const h = build({ server: {
    '/state': { mtime: 1700000000000, size: 5000 },
    '/state?profile=phone': { mtime: 1700000001000, size: 3000 },
  } });
  const list = await h.ctx.fetchSyncProfiles();
  eq(list.length, 2, 'both backups are listed');
  ok(list.some(p => p.shared), 'the shared one is flagged rather than named');
  ok(list.some(p => p.name === 'phone'), 'and the profile is named');

  ok(await h.ctx.deleteSyncProfile('phone'), 'a profile can be deleted');
  ok(!h.server['/state?profile=phone'], 'and it is gone from the server');
  ok(h.server['/state'], 'while the shared backup is untouched');

  // A deleted backup is not one we have seen. Leaving the old mtime behind
  // would make the next boot read a freshly re-seeded file as "not newer" and
  // skip a restore it owed.
  const h2 = build({ server: { '/state?profile=phone': { mtime: 1700000000000, size: 10 } },
                     storage: { gobbonet_sync_target: '{"mode":"profile","profile":"phone"}',
                                gobbonet_sync_meta: '{"byTarget":{"phone":1700000000000}}' } });
  eq(h2.get('stateSync').lastKnownMtime, 1700000000000, 'the stored mtime is loaded');
  await h2.ctx.deleteSyncProfile('phone');
  eq(h2.get('stateSync').lastKnownMtime, 0, 'and cleared when that backup is deleted');

  ok(!(await h.ctx.deleteSyncProfile('../etc')), 'an illegal name is refused rather than sent');
}

/* ================================================================
   H. WIRING
================================================================ */
console.log('\n=== H. wiring ===');
{
  const html = fs.readFileSync(ROOT + '/chat.html', 'utf8');
  const data = fs.readFileSync(ROOT + '/js/21-data.js', 'utf8');
  const persist = fs.readFileSync(ROOT + '/js/05-persistence.js', 'utf8');

  ok(/id="sync-target-rows"/.test(html), 'the DATA modal has the target controls');
  ok(/value="shared"/.test(html) && /value="profile"/.test(html) && /value="off"/.test(html),
     'with all three choices');
  ok(/id="sync-profile-list"/.test(html), 'and a list of what is on the server');
  ok(/renderSyncTargetPanel\(\)/.test(data), 'which the modal paints when it opens');

  // Every network path has to go through syncEnabled(), or "off" leaks.
  const net = SRC.slice(SRC.indexOf('function scheduleStateSync'), SRC.indexOf('function showRestorePrompt'));
  for (const fn of ['function scheduleStateSync', 'async function flushStateSync',
                    'function forceServerFlush', 'async function checkServerStateOnBoot']) {
    const body = net.slice(net.indexOf(fn), net.indexOf(fn) + 400);
    ok(/syncEnabled\(\)/.test(body), fn.replace(/^(async )?function /, '') + ' is gated on syncEnabled()');
  }
  ok(/beacon && syncEnabled\(\)/.test(SRC), 'and so is the page-teardown beacon');

  // The quota status reads "backed up to server". On an off device there is no
  // server copy, so that label would be a straight lie.
  ok(!/STATE_SYNC_AVAILABLE\) \{ stateSync\.status = 'quota'/.test(persist),
     'the quota status is not shown to a device with sync off');
  ok((persist.match(/syncEnabled\(\)/g) || []).length === 2,
     'both quota sites in persistence are gated');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
