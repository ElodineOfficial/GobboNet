/**
 * Exporting one thread and one character — roadmap item 9.
 *
 * WHY BUNDLING IS THE WHOLE FEATURE
 * ---------------------------------
 * A thread references its characters by id, and since the cast work each
 * MESSAGE can carry its own cardId/personaId — that is what lets a thread which
 * changed hands halfway through still show the right name and avatar against
 * each turn. Export the thread alone and import it somewhere else and every one
 * of those turns renders as whoever happens to be active there: exactly the
 * confusion makeCastResolver() exists to prevent, reintroduced by the file
 * format. So a single-thread export carries the cast it was held with.
 *
 * WHY THE ENVELOPE IS THE SAME AS THE BULK ONE
 * --------------------------------------------
 * A one-element `threads` array in the same wrapper means the existing import
 * buttons read these files with no special case, and import already merges by
 * id — so a single-item file is just a smaller merge. Section C is the
 * round trip that proves it, run through the REAL importData.
 *
 * Neither export needs a DOM beyond a download shim, so this drives the real
 * functions with `downloadJSON` captured.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/21-data.js', 'utf8');

const slice = (from, to) => {
  const a = SRC.indexOf(from);
  const b = to ? SRC.indexOf(to) : SRC.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error('could not locate ' + JSON.stringify(from) + ' in js/21-data.js');
    process.exit(1);
  }
  return SRC.slice(a, b);
};

// Everything from the bulk exporter through the end of importData.
const BLOCK = slice('function exportData(', '/* ================================================================\n   DATA MANAGER MODAL');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* A roster where the thread's cast is NOT the whole roster, and where the
   thread changed hands: the Archivist opened it, the Courier answered later.
   An export that only looked at thread.cardId would miss the Courier. */
function freshState() {
  return {
    activeThreadId: 't1',
    activeCardId: 'card-archivist',
    activePersonaId: 'p-me',
    settings: {},
    schedules: [], folders: [], extensions: [], macros: [], searchEnabled: false,
    threads: [
      {
        id: 't1', name: 'The Ledger Incident / part 2',
        cardId: 'card-archivist', cardName: 'Archivist',
        personaId: 'p-me', personaName: 'Me',
        messages: [
          { role: 'user', content: 'hello', personaId: 'p-me' },
          { role: 'assistant', content: 'You again.', cardId: 'card-archivist' },
          { role: 'assistant', content: 'Parcel for you.', cardId: 'card-courier' },
          { role: 'user', content: 'from who?', personaId: 'p-alt' },
        ],
      },
      { id: 't2', name: 'Unrelated', cardId: 'card-bystander', messages: [] },
    ],
    characterCards: [
      { id: 'card-archivist', name: 'Archivist', writingStyle: 'Dry.' },
      { id: 'card-courier', name: 'Courier', writingStyle: 'Brisk.', customCode: 'x', customCodeEnabled: true },
      { id: 'card-bystander', name: 'Bystander', writingStyle: 'Silent.' },
    ],
    personaCards: [
      { id: 'p-me', name: 'Me' },
      { id: 'p-alt', name: 'Alt' },
      { id: 'p-unused', name: 'Unused' },
    ],
  };
}

function build(stateObj) {
  const downloads = [];
  const status = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    state: stateObj || freshState(),
    Date, JSON, Math, Object, Array, Set, String, Number, Boolean,
    DEFAULT_PERSONA: { id: '', name: 'Anonymous', avatar: '', textColor: '', dialogColor: '' },
    DEFAULT_CARD: { id: 'default', name: 'Assistant' },
    DEFAULT_SETTINGS: {},
    DEFAULT_MACROS: [],
    saveState: () => {}, render: () => {}, applyExtensions: () => {},
    migrateExtensions: (e) => e || [],
    // The real rule: content kept, run flags cleared. Modelled rather than
    // stubbed away, because section D asserts on what it does.
    neutralizeUntrustedCode: (blob) => {
      let cards = 0;
      for (const c of (blob.characterCards || [])) {
        if (c && c.customCodeEnabled) { c.customCodeEnabled = false; cards++; }
      }
      return { cards, extensions: false };
    },
    downloadJSON: (data, filename) => { downloads.push({ data, filename }); },
    confirm: () => true,
    setTimeout: () => 0,
    document: {
      getElementById: () => ({ style: {}, textContent: '', className: '',
        set _t(v) {}, }),
    },
  };
  // Capture what the status line was told.
  ctx.document.getElementById = () => {
    const el = { style: {}, className: '' };
    Object.defineProperty(el, 'textContent', {
      get: () => '', set: (v) => { status.push(v); },
    });
    return el;
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const stateSource = fs.readFileSync(ROOT + '/js/04-state.js', 'utf8');
  const schema = stateSource.match(/const STATE_SCHEMA_VERSION\s*=\s*\d+;/)[0];
  vm.runInContext(schema + '\n' + BLOCK, ctx);
  return { ctx, downloads, status, state: ctx.state };
}

/** Run the real importData against an in-memory file. */
function importInto(h, payload, type) {
  const readers = [];
  h.ctx.FileReader = function () {
    const self = this;
    this.readAsText = () => {
      readers.push(() => self.onload({ target: { result: JSON.stringify(payload) } }));
    };
  };
  vm.runInContext('this.FileReader = FileReader;', h.ctx);
  h.ctx.importData({ files: [{ name: 'f.json' }] }, type);
  readers.forEach(fn => fn());
}

/* ================================================================
   A. ONE THREAD, WITH ITS CAST
================================================================ */
console.log('\n=== A. exporting a single thread ===');
{
  const h = build();
  h.ctx.exportThread('t1');
  eq(h.downloads.length, 1, 'one file is produced');
  const { data, filename } = h.downloads[0];

  eq(data.gobbonet_export, 'threads', 'the envelope is the same one the bulk export writes');
  eq(data.threads.length, 1, 'carrying exactly one thread');
  eq(data.threads[0].id, 't1', 'the one that was asked for');
  ok(!JSON.stringify(data.threads).includes('Unrelated'), 'and not the others');

  // The cast, including the character that only appears on a message.
  const cardNames = (data.characterCards || []).map(c => c.name).sort();
  eq(cardNames.join(','), 'Archivist,Courier',
     'both characters that actually spoke are bundled');
  ok(!cardNames.includes('Bystander'),
     'a character that never appeared in this thread is not');

  const personaNames = (data.personaCards || []).map(p => p.name).sort();
  eq(personaNames.join(','), 'Alt,Me', 'both personas that spoke are bundled');
  ok(!personaNames.includes('Unused'), 'an unused persona is not');

  ok(/^gobbonet-thread-the-ledger-incident-part-2-\d{4}-\d{2}-\d{2}\.json$/.test(filename),
     'the filename names the thread and the date', filename);
}

console.log('\n=== A2. threads with nothing to bundle ===');
{
  const h = build();
  h.ctx.exportThread('t2');
  const { data } = h.downloads[0];
  eq((data.characterCards || []).length, 1, 'a thread whose card exists still bundles it');
  eq((data.personaCards || []).length, 0, 'and bundles no persona when none was recorded');

  // A legacy thread with no ids at all must still export, just with an empty
  // cast -- makeCastResolver falls back to the active card for those.
  const st = freshState();
  st.threads.push({ id: 't3', name: 'Legacy', messages: [{ role: 'user', content: 'hi' }] });
  const h2 = build(st);
  h2.ctx.exportThread('t3');
  const d2 = h2.downloads[0].data;
  eq((d2.characterCards || []).length, 0, 'a thread with no cast ids bundles nothing');
  eq(d2.threads[0].id, 't3', 'but still exports the thread');

  // An unknown id is a no-op, not a crash or an empty file.
  const h3 = build();
  h3.ctx.exportThread('nope');
  eq(h3.downloads.length, 0, 'exporting a thread that does not exist writes nothing');
}

/* ================================================================
   B. ONE CHARACTER
================================================================ */
console.log('\n=== B. exporting a single character ===');
{
  const h = build();
  h.ctx.exportCharacter('card-courier');
  const { data, filename } = h.downloads[0];
  eq(data.gobbonet_export, 'cards', 'the same envelope the bulk character export writes');
  eq((data.characterCards || []).length, 1, 'with one character');
  eq(((data.characterCards || [])[0] || {}).name, 'Courier', 'the one asked for');

  // Lossless, unlike the V3 PNG: fields the spec has no room for survive.
  eq(((data.characterCards || [])[0] || {}).customCode, 'x', 'card code survives the round trip');
  ok(/^gobbonet-character-courier-\d{4}-\d{2}-\d{2}\.json$/.test(filename),
     'the filename names the character', filename);

  const h2 = build();
  h2.ctx.exportCharacter('nope');
  eq(h2.downloads.length, 0, 'an unknown character writes nothing');
}

/* ================================================================
   C. THE ROUND TRIP

   The point of reusing the bulk envelope: these files go back in through the
   existing buttons, with no new import path to keep in step.
================================================================ */
console.log('\n=== C. exported here, imported there ===');
{
  // Export from one install...
  const source = build();
  source.ctx.exportThread('t1');
  const file = source.downloads[0].data;

  // ...into another that has never seen any of it.
  const target = build({
    activeThreadId: null, activeCardId: 'default', activePersonaId: 'p-theirs',
    settings: {}, schedules: [], folders: [], extensions: [], macros: [],
    threads: [],
    characterCards: [{ id: 'default', name: 'Assistant' }],
    personaCards: [{ id: 'p-theirs', name: 'Them' }],
  });
  importInto(target, file, 'threads');

  eq(target.state.threads.length, 1, 'the thread arrives');
  eq(target.state.threads[0].name, 'The Ledger Incident / part 2', 'intact');

  const names = target.state.characterCards.map(c => c.name).sort().join(',');
  eq(names, 'Archivist,Assistant,Courier', 'and so do the characters it was held with');
  const pnames = target.state.personaCards.map(p => p.name).sort().join(',');
  eq(pnames, 'Alt,Me,Them', 'and the personas');

  // Which is the whole point: every stamped message can still resolve.
  const cardIds = new Set(target.state.characterCards.map(c => c.id));
  const stamped = file.threads[0].messages.filter(m => m.cardId).map(m => m.cardId);
  ok(stamped.every(id => cardIds.has(id)),
     'every message that names a character can find it after the import');

  ok(target.status.some(m => /Imported 1 thread/.test(m)), 'the status line reports the thread',
     JSON.stringify(target.status));
  ok(target.status.some(m => /Also added .*character/.test(m)),
     'and says what else came with it', JSON.stringify(target.status));
}

console.log('\n=== C2. importing into a install that already has them ===');
{
  const source = build();
  source.ctx.exportThread('t1');
  const file = source.downloads[0].data;

  // The recipient already owns Archivist, with their OWN edits to it.
  const target = build();
  target.state.characterCards[0].writingStyle = 'MY version, do not clobber';
  target.state.threads = [];
  importInto(target, file, 'threads');

  eq(target.state.characterCards.length, 3, 'no duplicate characters are created');
  eq(target.state.characterCards.find(c => c.id === 'card-archivist').writingStyle,
     'MY version, do not clobber',
     'and an existing character is left exactly as it was');
  eq(target.state.personaCards.length, 3, 'same for personas');

  // Re-importing the same file twice must not duplicate the thread either.
  importInto(target, file, 'threads');
  eq(target.state.threads.filter(t => t.id === 't1').length, 1,
     'importing the same file twice adds the thread once');
}

/* ================================================================
   D. A FILE FROM SOMEONE ELSE

   Card code out of an untrusted file does not get to arrive already running.
   The bundled path has to follow the same rule as the character import, or
   wrapping a card in a thread export would be a way around it.
================================================================ */
console.log('\n=== D. bundled card code arrives switched off ===');
{
  const source = build();
  source.ctx.exportThread('t1');
  const file = source.downloads[0].data;
  ok((file.characterCards || []).some(c => c.customCodeEnabled),
     'the sender had this character\u2019s code switched on');

  const target = build({
    threads: [], characterCards: [], personaCards: [], settings: {},
    schedules: [], folders: [], extensions: [], macros: [],
  });
  importInto(target, file, 'threads');
  const courier = target.state.characterCards.find(c => c.id === 'card-courier');
  eq((courier || {}).customCode, 'x', 'the code itself is kept');
  eq((courier || {}).customCodeEnabled, false, 'but it arrives switched OFF');
  ok(target.status.some(m => /switched OFF/.test(m)), 'and the user is told',
     JSON.stringify(target.status));
}

/* ================================================================
   E. BACKWARDS COMPATIBILITY

   Files written by every build before this one have no cast keys at all.
================================================================ */
console.log('\n=== E. older export files ===');
{
  const target = build({
    threads: [], characterCards: [{ id: 'default', name: 'Assistant' }],
    personaCards: [{ id: 'p', name: 'P' }], settings: {},
    schedules: [], folders: [], extensions: [], macros: [],
  });
  importInto(target, {
    gobbonet_export: 'threads', version: 1, exported: 1,
    threads: [{ id: 'old', name: 'Old Export', messages: [] }],
  }, 'threads');
  eq(target.state.threads.length, 1, 'a file with no cast keys still imports');
  eq(target.state.characterCards.length, 1, 'and adds no characters');
  ok(!target.status.some(m => /Also added/.test(m)),
     'and does not claim it added anything', JSON.stringify(target.status));

  // The bulk exports must not have changed shape.
  const h = build();
  h.ctx.exportData('threads');
  eq(((h.downloads[0] || {}).data || {}).threads.length, 2, 'the bulk thread export still sends everything');
  ok(h.downloads[0].data.characterCards === undefined,
     'and still bundles nothing, as it always has');
  h.ctx.exportData('cards');
  eq((((h.downloads[1] || {}).data || {}).characterCards || []).length, 3, 'the bulk character export is unchanged');
}

/* ================================================================
   F. WIRING
================================================================ */
console.log('\n=== F. wiring ===');
{
  const render = fs.readFileSync(ROOT + '/js/12-render.js', 'utf8');
  const cards = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');

  ok(/exportThread\('\$\{escapeJsAttr\(t\.id\)\}',event\)/.test(render),
     'every thread row has an export control');
  // Without stopPropagation the row's own onclick fires and the export also
  // switches threads.
  ok(/function exportThread\(id, event\) \{\s*\n\s*if \(event\) event\.stopPropagation\(\);/.test(SRC),
     'which does not also switch to that thread');
  ok(/exportCharacter\('\$\{escapeJsAttr\(c\.id\)\}'\)/.test(cards),
     'every character in the grid has one too');
  ok(/event\.stopPropagation\(\);exportCharacter/.test(cards),
     'which does not also activate that character');

  // The two character exports serve different purposes and both have to stay.
  const io = fs.readFileSync(ROOT + '/js/16-card-io.js', 'utf8');
  ok(/function exportCardAsV3\(/.test(io), 'the V3 PNG export is untouched');
  ok(/async function exportCardForDiscord\(/.test(io), 'so is the sharing export');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
