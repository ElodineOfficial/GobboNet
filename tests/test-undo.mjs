/**
 * 1.7.9 F8 — UNDO for deletions.
 *
 * Part A drives the real UNDO block from js/18-utils.js with a fake clock and
 * a minimal DOM: undo puts things back and saves, the window closes on its own
 * and commits, a second delete commits the first, sync is held while a delete
 * is pending, Ctrl+Z works outside text fields only.
 *
 * Part B pins the wiring: every single-item delete offers UNDO, the things
 * that cannot be taken back wait for commit, the confirms UNDO replaces are
 * gone, and bulk deletes and PURGE keep theirs.
 *
 * Every delete is exercised for real, in the browser, by
 * tests/console/1.7.9-step-9.js.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const UTILS = read('js/18-utils.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '\n      ' + String(extra).slice(0, 400) : '')); }
};

// ── A. the core, for real ────────────────────────────────────────────────────
console.log('\n=== A. the UNDO core ===');
function harness() {
  let now = 0;
  const timers = [];
  const listeners = {};
  const els = {};
  const mkEl = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, textContent: '', offsetWidth: 1,
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; },
      addEventListener(t, f) { (this.on = this.on || {})[t] = f; },
      querySelector(sel) { return this.children.find(c => c.className === sel.slice(1)); } };
    return e;
  };
  const body = mkEl('body');
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f, ms) => { const t = { f, at: now + ms, done: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
    document: {
      body,
      getElementById: (id) => els[id] || null,
      createElement: mkEl,
      addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    },
    saves: 0, pushes: 0,
  };
  ctx.saveState = () => { ctx.saves++; };
  ctx.scheduleStateSync = () => { ctx.pushes++; };
  ctx.flushStateSync = () => { ctx.flushes = (ctx.flushes || 0) + 1; };
  vm.createContext(ctx);
  const block = UTILS.slice(UTILS.indexOf('/* ================================================================\n   UNDO (1.7.9, F8)'));
  vm.runInContext(block, ctx);
  ctx.advance = (ms) => { now += ms; for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.f(); } };
  ctx.key = (e) => { for (const f of listeners.keydown || []) f(e); };
  ctx.toast = () => els['undo-toast'];
  return ctx;
}
{
  const h = harness();
  const list = ['a', 'b', 'c'];
  let committed = 0;
  list.splice(1, 1);
  h.undoable({ label: 'Deleted "b"', undo: () => list.splice(1, 0, 'b'), commit: () => committed++ });
  ok(h.undoHoldsSync() === true, 'a pending delete holds the push to other devices');
  ok(h.toast() && h.toast().classList.contains('visible'), 'the toast is shown');
  ok(h.toast().children[0].textContent === 'Deleted "b"', 'with the label, set as text (never markup)');
  ok(h.toast().attrs.role === 'status' && h.toast().attrs['aria-live'] === 'polite', 'and announced to screen readers');
  h.advance(9999);
  ok(h.undoHoldsSync() && committed === 0, 'still pending just before 10 s');
  ok(h.undoLast() === true, 'UNDO takes it back');
  ok(list.join('') === 'abc', 'the item is back in its place', list.join(''));
  ok(committed === 0, 'commit never ran');
  ok(h.saves === 1 && h.pushes === 1, 'UNDO saves, then lets the held push go');
  ok(!h.undoHoldsSync() && !h.toast().classList.contains('visible'), 'nothing pending, toast gone');
  ok(h.undoLast() === false, 'a second UNDO does nothing');
}
{
  const h = harness();
  let committed = 0, undone = 0;
  h.undoable({ label: 'x', undo: () => undone++, commit: () => committed++ });
  h.advance(10000);
  ok(committed === 1 && undone === 0, 'after 10 s the delete commits by itself');
  ok(!h.undoHoldsSync() && h.pushes === 1, 'and the held push is released');
  ok(h.undoLast() === false, 'too late to UNDO');
}
{
  const h = harness();
  const log = [];
  h.undoable({ label: 'first', undo: () => log.push('undo1'), commit: () => log.push('commit1') });
  h.undoable({ label: 'second', undo: () => log.push('undo2'), commit: () => log.push('commit2') });
  ok(log.join() === 'commit1', 'a second delete makes the first final', log.join());
  h.undoLast();
  ok(log.join() === 'commit1,undo2', 'UNDO then takes back the second only', log.join());
  h.advance(20000);
  ok(log.join() === 'commit1,undo2', "the first window's timer does not fire twice", log.join());
}
{
  const h = harness();
  let undone = 0;
  h.undoable({ label: 'x', undo: () => undone++ });
  let prevented = false;
  h.key({ key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() { prevented = true; } });
  ok(undone === 0 && !prevented, 'Ctrl+Z in a text field is left to the browser (undo typing)');
  h.key({ key: 'z', ctrlKey: true, shiftKey: true, target: { tagName: 'DIV' }, preventDefault() {} });
  ok(undone === 0, 'Ctrl+Shift+Z (redo) is not UNDO');
  h.key({ key: 'z', metaKey: true, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
  ok(undone === 1 && prevented, 'Cmd/Ctrl+Z elsewhere undoes');
}
{
  const h = harness();
  h.undoable({ label: 'x', undo: () => { throw new Error('boom'); }, commit: () => {} });
  ok(h.undoLast() === true && !h.undoHoldsSync() && h.pushes === 1, 'an UNDO that throws still clears the pending delete and releases sync');
}

// ── B. the wiring ────────────────────────────────────────────────────────────
console.log('\n=== B. every single-item delete offers UNDO ===');
const body = (file, name) => {
  const s = read(file);
  const a = s.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (a < 0) return '';
  const b = s.indexOf('\n}\n', a);
  return s.slice(a, b + 2);
};
const PATHS = [
  ['js/09-threads.js', 'deleteThread', 'a chat'],
  ['js/10-chat.js', 'deleteMessage', 'a message'],
  ['js/12-render.js', 'deleteFolder', 'a folder'],
  ['js/15-cards.js', 'deleteCard', 'a character (editor)'],
  ['js/15-cards.js', 'deleteCardById', 'a character (list)'],
  ['js/15-cards.js', 'removeCardMemoryFile', 'a memory file'],
  ['js/17-personas.js', 'deletePersona', 'a persona (editor)'],
  ['js/17-personas.js', 'deletePersonaById', 'a persona (list)'],
  ['js/20-macros.js', 'deleteMacro', 'a macro'],
  ['js/19-extensions.js', 'removeExtEntry', 'an extension entry'],
  ['js/21-data.js', 'onDeleteSyncProfile', 'a server backup'],
];
for (const [file, fn, what] of PATHS) {
  const b = body(file, fn);
  ok(/undoable\(\{|_offerCardUndo\(|_offerPersonaUndo\(/.test(b), `${what}: ${fn}() offers UNDO`);
  ok(!/confirm\(/.test(b), `  and asks no "are you sure" first`);
}
console.log('\n=== C. what cannot be taken back waits for commit ===');
{
  const t = body('js/09-threads.js', 'deleteThread');
  const commit = t.slice(t.indexOf('commit:'));
  ok(t.indexOf("idbDelete('threads'") > t.indexOf('commit:'), 'the IndexedDB record of a chat is removed only on commit', t.slice(0, 200));
  ok(/idbDelete\('threads', id\)/.test(commit), '  (inside commit)');
  const p = body('js/21-data.js', 'onDeleteSyncProfile');
  ok(p.indexOf('deleteSyncProfile(name)') > p.indexOf('commit:'), "a server backup's DELETE is sent only on commit");
  const sync = read('js/06-state-sync.js');
  const flush = sync.slice(sync.indexOf('async function flushStateSync()'), sync.indexOf('async function flushStateSync()') + 900);
  ok(/undoHoldsSync\(\)\) \{\s*stateSync\.pendingPush = true;\s*return;/.test(flush), 'the push to other devices waits while a delete is pending');
  const exit = sync.slice(sync.indexOf('function flushBeforeExit('), sync.indexOf('function flushBeforeExit(') + 900);
  ok(/if \(beacon\) \{ try \{ if \(typeof commitPendingUndo === 'function'\) commitPendingUndo\(\);/.test(exit),
     'leaving the page for good makes a pending delete final before the last save and push');
  const ext = read('js/19-extensions.js');
  ok(/function closeExtensions\(\) \{\n  commitPendingUndo\(\);/.test(ext) && /function saveExtensions\(\) \{\n  commitPendingUndo\(\);/.test(ext),
     'the extensions panel commits a removed entry before it closes or saves its draft');
}
console.log('\n=== D. bulk deletes and PURGE keep their confirm ===');
{
  const data = read('js/21-data.js');
  ok(/confirm\(/.test(body('js/19-extensions.js', 'clearAllExtensions')), 'clearing every extension still asks');
  ok(/PURGE/.test(data) && /confirm\(|prompt\(/.test(data.slice(data.indexOf('PURGE'))), 'PURGE still asks');
}
{
  const css = read('css/13-components.css');
  ok(/#undo-toast\.visible \{ opacity: 1; pointer-events: auto;/.test(css), 'the toast is clickable when shown');
  ok(/@media \(prefers-reduced-motion: reduce\) \{ \.undo-toast-bar \{ display: none; \} \}/.test(css), 'the countdown bar respects reduced motion');
}

console.log('\n=== D2. tags and scheduled messages ask first instead (Elodine, 1.7.9) ===');
for (const [file, fn, what] of [['js/12-render.js', 'removeTag', 'a tag'], ['js/22-scheduler.js', 'deleteSched', 'a scheduled message']]) {
  const b = body(file, fn);
  ok(/confirm\(/.test(b) && !/undoable\(/.test(b), `${what}: ${fn}() asks first and offers no UNDO`);
  ok(b.indexOf('confirm(') < b.search(/filter\(/), '  and asks before it deletes anything');
}
console.log('\n=== D3. PURGE asks, then offers UNDO ===');
{
  const p = body('js/21-data.js', 'purgeData');
  ok((p.match(/confirm\(/g) || []).length === 4 && (p.match(/_offerPurgeUndo\(/g) || []).length === 4, 'all four purges ask first and then offer UNDO');
  ok(!/cannot be undone/i.test(p) && /UNDO is offered for 10 seconds afterwards/.test(p), 'the questions say UNDO follows, not "cannot be undone"');
  ok(p.indexOf("idbClearStore('threads')") < p.indexOf("_offerPurgeUndo('Purged ' + snap.threads.length"), 'the stored threads are still destroyed at once; UNDO saves them back');
  ok(p.indexOf('wipeLocalStorageAll()') < p.indexOf("_offerPurgeUndo('Purged all data'"), 'PURGE ALL still wipes storage at once');
  const u = body('js/21-data.js', '_offerPurgeUndo');
  ok(/for \(const f of Object\.keys\(snap\)\) state\[f\] = snap\[f\];/.test(u) && /saveState\(\);/.test(u), 'UNDO restores every purged field and saves it in full');
}
console.log('\n=== D4. a final delete reaches the server at once ===');
{
  const c = harness();
  c.undoable({ label: 'x', undo() {} });
  c.advance(10001);
  ok(c.flushes === 1 && c.pushes >= 1, 'when the window closes, the push goes now, not after the 2-second debounce', { flushes: c.flushes, pushes: c.pushes });
}
console.log('\n=== E. saving is not deleting ===');
{
  // Step 9 added the character UNDO to deleteCard; the same line landed at
  // the end of saveCard too, whose closing lines look alike, where _card is
  // not defined. Every character save then ended in a ReferenceError (after
  // the save itself had happened). Fixed in 1.7.9's RAG patch.
  for (const [file, fn] of [['js/15-cards.js', 'saveCard'], ['js/17-personas.js', 'savePersona']]) {
    const b = body(file, fn);
    ok(b && !/_offer\w*Undo\(|undoable\(/.test(b), `${fn}() offers no UNDO: it deletes nothing`);
  }
  // And anywhere an UNDO helper is handed a "_name" local, that local is
  // declared in the same function.
  const files = fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const src = read('js/' + f);
    for (const m of src.matchAll(/^(?:async )?function (\w+)\(/gm)) {
      const b = body('js/' + f, m[1]);
      for (const call of b.matchAll(/_offer\w*Undo\(([^)]*)\)/g)) {
        for (const arg of call[1].split(',').map(x => x.trim()).filter(x => /^_\w+$/.test(x))) {
          if (!new RegExp('\\b(?:const|let|var) ' + arg + '\\b').test(b)) bad.push(`${f} ${m[1]}(): ${arg}`);
        }
      }
    }
  }
  ok(bad.length === 0, 'every _offer…Undo() call is handed locals its own function declares', bad);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
