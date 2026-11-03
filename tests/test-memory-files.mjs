/**
 * Characters read their .md memory files back -- issue #41.
 *
 * "It can write them but not read." A ```file:notes.md block already had a
 * Save button. Now a card carries memoryFiles: imported in the editor, or
 * saved from a block the character wrote, and read back through retrieval:
 * split at their headings, matched against the conversation (by meaning
 * through the local embedding model, by shared words without it), injected
 * labelled with the file and section.
 *
 * Runs the real code out of js/ in Node's vm:
 *   A. names, limits and validation (js/08-rag.js)
 *   B. chunking at headings, fences respected, long paragraphs cut
 *   C. retrieval: semantic with an embed server, shared words without one,
 *      nothing when retrieval is off, the storybook unchanged
 *   D. the prompt: labelled injections, and the one-line index of files
 *   E. the editor: import, remove, pending until SAVE (js/15-cards.js)
 *   F. "Save to memory" on a file block: the speaker's card, replace asks
 *   G. card export/import round-trip, with names and limits enforced
 *   H. the page: the editor section, the button only on text files
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const RAG = read('js/08-rag.js');
const CARDS = read('js/15-cards.js');
const CARDIO = read('js/16-card-io.js');
const UTILS = read('js/18-utils.js');
const HTML = read('chat.html');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l,
  `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);
const between = (src, from, to, file) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) { console.error(`could not locate ${JSON.stringify(from)} in ${file}`); process.exit(1); }
  return src.slice(a, b);
};

/* A deterministic stand-in for the embed server: a bag-of-words vector, so
   texts that share words are close. Enough to exercise ranking for real. */
function fakeEmbed(text) {
  const v = new Array(96).fill(0);
  for (const w of String(text).toLowerCase().replace(/^search_(document|query): /, '').match(/[a-z]{3,}/g) || []) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 96] += 1;
  }
  return v;
}

const SETTINGS = {
  retrievalEnabled: true, retrieverA: true, retrieverB: true, fireThreshold: 1.0, warmthTurns: 2,
  expansionDepth: 1, semanticBackstop: true, topKA: 5, retrievalBudgetTokens: 6000, retrievalWindowMsgs: 4,
};

function ragContext({ embed = 'up', settings = {} } = {}) {
  const calls = [];
  const ctx = {
    console: { log() {}, warn() {}, debug() {}, error() {} },
    Map, Set, Math, JSON, Object, Array, String, Number, Date, RegExp, Promise, Error,
    window: { dispatchEvent() {} }, CustomEvent: function () {},
    performance: { now: () => 0 },
    state: { settings: { ...SETTINGS, ...settings } },
    activeModel: { name: 'test' },
    STORAGE_BACKEND: 'memory', _idb: null,
    EMBED_URL: '/embed',
    estimateTokens: (s) => Math.ceil(String(s || '').length / 4),
    fetch: async (url, opts) => {
      calls.push(url);
      if (embed !== 'up') return { ok: false, status: 502, json: async () => ({}) };
      const input = JSON.parse(opts.body).input;
      return { ok: true, json: async () => ({ data: [{ embedding: fakeEmbed(input) }] }) };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(RAG, ctx);
  ctx.calls = calls;
  return ctx;
}

const NOTES = [
  '# Aria\'s notes',
  'Things I keep track of.',
  '',
  '## Quests',
  '### Open',
  'Find the silver key hidden in the old mill by the river.',
  '',
  '```sh',
  '# not a heading',
  'echo hi',
  '',
  '```',
  '',
  '## Creatures',
  'Dragons nest in the northern peaks and hoard copper, never gold.',
  '',
  '## People',
  'Bram the blacksmith owes me a favour since the winter storm.',
].join('\n');

/* ================================================================ A */
console.log('\n=== A. names, limits, validation ===');
{
  const c = ragContext();
  const name = (s) => c.memoryFileName(s);
  eq(['../../etc/passwd', '..\\x\\notes.md', '.hidden.md', 'Notes', 'quest log.txt', 'a<b>:c|d?.md', ''].map(name),
     ['passwd.md', 'notes.md', 'hidden.md', 'Notes.md', 'quest log.txt', 'abcd.md', ''],
     'a name, never a path: last segment, no reserved characters, no leading dots, .md added');
  const long = name('x'.repeat(300) + '.markdown');
  ok(long.length === 100 && long.endsWith('.markdown'), 'long names are cut to 100 characters, keeping the extension', long.length);

  eq(c.cardMemoryFiles({ memoryFiles: [{ name: 'a.md', text: 'x' }, { name: 'A.MD', text: 'dup' }, { name: 5, text: 'x' },
                                       null, { name: 'b.md' }, { name: 'c.md', text: 'y', updated: 7 }] })
       .map(f => f.name + ':' + f.text + ':' + f.updated),
     ['a.md:x:0', 'c.md:y:7'], 'cardMemoryFiles skips malformed entries and duplicate names (any case)');
  eq(c.cardMemoryFiles({}), [], 'no field reads as no files');

  let r = c.memoryPutFile([], 'notes', 'hello', 1);
  ok(r.ok && r.name === 'notes.md' && r.files.length === 1 && !r.replaced, 'a file is added', JSON.stringify(r));
  const before = JSON.stringify(r.files);
  const r2 = c.memoryPutFile(r.files, 'NOTES.md', 'v2', 2);
  ok(r2.ok && r2.replaced && r2.files.length === 1 && r2.files[0].text === 'v2', 'the same name in any case replaces it');
  eq(JSON.stringify(r.files), before, 'the list passed in is not changed');
  eq(c.memoryPutFile([], 'a.md', '   \n').ok, false, 'an empty file is refused');
  eq(c.memoryPutFile([], 'a.md', 'bin\u0000ary').ok, false, 'a file with NUL bytes is refused as not text');
  eq(c.memoryPutFile([], 'a.md', 'a\r\nb').files[0].text, 'a\nb', 'Windows line endings are normalised');
  const big = c.memoryPutFile([], 'big.md', 'x'.repeat(100001));
  ok(!big.ok && /100,000/.test(big.error), 'over 100,000 characters is refused, and the message says the limit', big.error);
  let many = [];
  for (let i = 0; i < 20; i++) many = c.memoryPutFile(many, 'f' + i + '.md', 'x').files;
  const twentyFirst = c.memoryPutFile(many, 'one-more.md', 'x');
  ok(!twentyFirst.ok && /20 memory files/.test(twentyFirst.error), 'a 21st file is refused', twentyFirst.error);
  ok(c.memoryPutFile(many, 'f3.md', 'replacing is fine').ok, 'but replacing one of the 20 is allowed');
  let heavy = [];
  for (let i = 0; i < 4; i++) heavy = c.memoryPutFile(heavy, 'h' + i + '.md', 'x'.repeat(99000)).files;
  const over = c.memoryPutFile(heavy, 'h4.md', 'x'.repeat(10000));
  ok(!over.ok && /400,000/.test(over.error), 'more than 400,000 characters in total is refused', over.error);
}

/* ================================================================ B */
console.log('\n=== B. chunking ===');
{
  const c = ragContext();
  const chunks = c.memoryFileChunks({ name: 'notes.md', text: NOTES });
  eq(chunks.map(x => x.heading), ["Aria's notes", "Aria's notes › Quests › Open", "Aria's notes › Creatures", "Aria's notes › People"],
     'split at headings, each chunk keeping its heading path');
  ok(chunks[1].text.includes('# not a heading') && !chunks.some(x => x.heading.includes('not a heading')),
     'a # line inside a code fence is text, not a heading');
  eq(new Set(chunks.map(x => x.id)).size, chunks.length, 'chunk ids are unique');
  ok(chunks.every(x => !x.text.startsWith('#')), 'heading lines are not repeated in the chunk text');

  const para = ('The tide turned. ').repeat(400);   // ~6,800 characters, one paragraph
  const cut = c.memoryFileChunks({ name: 'long.md', text: para });
  ok(cut.length >= 4 && cut.every(x => x.text.length <= 2000), 'a paragraph over 2,000 characters is cut, at sentence ends', cut.map(x => x.text.length).join(','));
  const small = Array.from({ length: 30 }, (_, i) => 'Fact number ' + i + ' about the realm, its rivers, its roads and the people who keep them.').join('\n\n');
  const packed = c.memoryFileChunks({ name: 'facts.md', text: small });
  ok(packed.length > 1 && packed.length < 30 && packed.every(x => x.text.length <= 1200 + 50),
     'small paragraphs are packed together up to ~1,200 characters', packed.length + ' chunks');
  eq(c.memoryFileChunks({ name: 'e.md', text: '# Only a heading\n\n## And another' }), [], 'headings with nothing under them make no chunks');
}

/* ================================================================ C */
console.log('\n=== C. retrieval ===');
const thread = (text) => ({ id: 't1', messages: [{ role: 'user', content: text }] });
const card = (extra = {}) => ({ id: 'c1', name: 'Aria', ragStorybook: '', memoryFiles: [{ name: 'notes.md', text: NOTES, updated: 1 }], ...extra });
const budget = () => ({ token_limit: 8192, budget: 7000 });
{
  let c = ragContext();
  let r = await c.runRetrieval(thread('Where do the dragons nest? Up in the northern peaks?'), card(), 4000, budget());
  const top = r.injections[0] || {};
  ok(top.label === "Memory file: notes.md › Aria's notes › Creatures", 'with an embed server: the matching section is injected, labelled', JSON.stringify(r.injections.map(i => i.label)));
  ok(top.text && top.text.startsWith('Dragons nest') && !top.text.includes('notes.md'), 'the payload is the section text alone; the label carries the file name');
  const row = r.record.candidates.find(x => x.cand_id === top.entityId);
  ok(row && row.kind === 'memory' && row.trigger_type === 'semantic', 'telemetry records it as a semantic memory hit', JSON.stringify(row));
  eq(r.record.cards_in_play[0].memory_chunks, 4, 'and counts the card\'s memory chunks');

  c = ragContext({ embed: 'down' });
  r = await c.runRetrieval(thread('Bram the blacksmith wants his favour back, remember the storm?'), card(), 4000, budget());
  ok(r.injections.length >= 1 && r.injections[0].label.endsWith('› People'), 'embed server down: shared words still find the right section', JSON.stringify(r.injections.map(i => i.label)));
  const kw = r.record.candidates.find(x => x.included);
  ok(kw && kw.trigger_type === 'keyword', 'recorded as a keyword hit', JSON.stringify(kw));
  ok(r.record.config.memory_keyword_fallback === true && r.record.config.embed_available === false, 'and the record says the fallback ran');

  r = await c.runRetrieval(thread('The weather is lovely and the river is calm today.'), card(), 4000, budget());
  ok(!r.injections.some(i => i.label && i.label.endsWith('Open')), 'one shared word in passing (river) does not pull a section in', JSON.stringify(r.injections.map(i => i.label)));

  c = ragContext({ settings: { retrieverA: false } });
  r = await c.runRetrieval(thread('The silver key in the old mill, did we find it?'), card(), 4000, budget());
  ok(r.injections.length >= 1 && r.injections[0].label.endsWith('Open') && !c.calls.length,
     'Retriever A switched off: shared words, and the embed server is not called', `${JSON.stringify(r.injections.map(i => i.label))} calls=${c.calls.length}`);

  c = ragContext({ settings: { retrievalEnabled: false } });
  r = await c.runRetrieval(thread('dragons dragons northern peaks'), card(), 4000, budget());
  eq(r.injections.length, 0, 'retrieval switched off: memory files are not read either');

  c = ragContext();
  r = await c.runRetrieval(thread('Where do the dragons nest? The northern peaks?'), card(), 10, budget());
  ok(r.injections.length === 0 && r.record.candidates.some(x => x.eviction_reason === 'budget'),
     'no room in the budget: nothing injected, and the candidate is recorded as evicted for budget');

  // Storybook plain text has its own path without embeddings since 1.7.9
  // (names and distinctive words; tests/test-rag-storybook.mjs). It is not
  // the memory-file fallback, which stays for memory files only.
  c = ragContext({ embed: 'down' });
  const book = 'Bram the blacksmith owes a favour since the winter storm.';
  r = await c.runRetrieval(thread('Bram the blacksmith and the winter storm favour'), card({ memoryFiles: [], ragStorybook: book }), 4000, budget());
  ok(r.injections.length === 1 && !r.record.config.memory_keyword_fallback,
     'a storybook-only card without embeddings: its plain text fires on its own path, not the memory fallback');
  c = ragContext({ embed: 'down' });
  r = await c.runRetrieval(thread('anything'), card({ memoryFiles: [] }), 4000, budget());
  ok(r.injections.length === 0 && r.record.cards_in_play[0].memory_chunks === 0, 'a card with nothing authored and no memory: nothing to do');
}

/* ================================================================ D */
console.log('\n=== D. the prompt ===');
async function build(cardObj, text, embed = 'up') {
  const c = ragContext({ embed });
  Object.assign(c, {
    resolveContextLimit: () => 8192,
    resolveContextBudget: () => ({ input: 0.9, reply: 0.2, land: 0.65, keep: 0.22 }),
    estimateMessagesTokens: (ms) => ms.reduce((n, m) => n + Math.ceil((m.content || '').length / 4) + 4, 0),
    getActivePersona: () => ({ name: 'Ren', description: '', injectionFrequency: 0 }),
    getThreadLore: () => '',
    translateTemplates: (t) => t,
    normalizeMessagesForStrictTemplates: (m) => m,
    runCardHook: () => {}, pickCarouselLine: () => '', saveState: () => {}, renderMessages: () => {},
  });
  const out = await c.buildContextMessages(thread(text), cardObj, {});
  return out.apiMessages;
}
{
  const withMem = await build(card({ writingStyle: 'STYLE', personality: '' }), 'Where do the dragons nest in the northern peaks?');
  const sys = withMem.filter(m => m.role === 'system').map(m => m.content);
  const memIdx = sys.findIndex(s => s.startsWith("[Memory file: notes.md › Aria's notes › Creatures]"));
  const listIdx = sys.findIndex(s => s.startsWith('[Memory files]'));
  ok(memIdx >= 0, 'the retrieved section reaches the prompt under its label', sys.map(s => s.split('\n')[0]).join(' | '));
  ok(listIdx > memIdx && sys[listIdx + 1] === 'STYLE', 'the index of files comes after it (with Prompt Order off), right before the writing style');
  ok(/You keep these files: notes\.md\./.test(sys[listIdx]) && /```file:notes\.md/.test(sys[listIdx]),
     'it names the files and how to write one back', sys[listIdx]);

  const without = await build({ id: 'c2', name: 'Bob', writingStyle: 'STYLE', personality: '', ragStorybook: '' }, 'hello there');
  ok(!without.some(m => (m.content || '').startsWith('[Memory')), 'a card with no memory files: no memory blocks at all');
  eq(without.filter(m => m.role === 'system').map(m => m.content.split('\n')[0]), ['[Character: Bob]', 'STYLE'],
     'and its system blocks are exactly what they were');
}

/* ================================================================ E */
console.log('\n=== E. the editor ===');
function el(tag, id) {
  return {
    tagName: tag, id, value: '', textContent: '', title: '', className: '', type: '', children: [], dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { throw new Error('innerHTML used for #' + id); },
  };
}
function editorContext() {
  const c = ragContext();
  const els = {};
  for (const id of ['card-memory-files', 'card-memory-list', 'card-memory-readout', 'card-memory-input']) els[id] = el('div', id);
  Object.defineProperty(els['card-memory-list'], 'textContent', { set(v) { this.children = []; }, get() { return ''; } });
  const toasts = [], downloads = [];
  Object.assign(c, {
    document: { getElementById: (id) => els[id] || null, createElement: (t) => el(t) },
    Blob: function (parts, opts) { this.text = parts.join(''); this.type = opts && opts.type; },
    _downloadBlob: (b, name) => downloads.push([name, b.text]),
    showModelSwitchToast: (m, k) => toasts.push([k, m]),
    confirm: () => c._confirmAnswer !== false,
    saveState: () => { c.saves = (c.saves || 0) + 1; },
    ragIngestCard: () => { c.ingests = (c.ingests || 0) + 1; },
    undoable: (o) => { c.lastUndo = o; },   // js/18-utils.js UNDO (1.7.9)
    editingCardId: null,
  });
  vm.runInContext(between(CARDS, '/* ================================================================\n   MEMORY FILES in the editor', 'function saveCard() {', 'js/15-cards.js'), c);
  vm.runInContext('globalThis.__setEditing = (id) => { editingCardId = id; };', c);
  c.els = els; c.toasts = toasts; c.downloads = downloads;
  return c;
}
const fileOf = (name, text, size) => ({ name, size: size ?? text.length, text: async () => text });
{
  const c = editorContext();
  c.loadCardMemoryEditor({ memoryFiles: [{ name: 'notes.md', text: NOTES }] });
  eq(c.els['card-memory-list'].children.length, 1, 'opening the editor lists the card\'s files');
  const row = c.els['card-memory-list'].children[0];
  ok(row.children[0].textContent === 'notes.md' && /part/.test(row.children[1].textContent), 'each row: name, then size and parts', row.children[1].textContent);

  await c.importCardMemoryFiles({ files: [fileOf('lore.md', '# Lore\nOld kings.'), fileOf('evil.exe', 'MZ'), fileOf('huge.md', 'x', 500000), fileOf('Notes.MD', 'replaced text')], value: 'x' });
  const names = c._memoryEditorFiles().map(f => f.name);
  eq(names, ['Notes.MD', 'lore.md'], 'import adds .md files, replaces a same-named one, refuses others');
  const readout = c.els['card-memory-readout'].textContent;
  ok(/lore\.md added/.test(readout) && /evil\.exe: not a \.md or \.txt file/.test(readout) && /huge\.md: too large/.test(readout) && /Notes\.MD replaced/.test(readout),
     'and says what happened to each', readout);

  const hostile = '<img src=x onerror=alert(1)>.md';
  await c.importCardMemoryFiles({ files: [fileOf(hostile, 'text')] });
  ok(c.els['card-memory-list'].children.some(r => r.children[0].textContent === 'img src=x onerror=alert(1).md'),
     'a hostile file name lands as plain text: < and > stripped, and rows never use innerHTML');

  c.removeCardMemoryFile(0);
  ok(!c._memoryEditorFiles().some(f => f.name === 'Notes.MD') && /Notes\.MD removed/.test(c.els['card-memory-readout'].textContent), 'remove takes it off the pending list');
  // 1.7.9: and offers UNDO, which puts it back in the editor, in its place.
  ok(c.lastUndo && /Removed memory file "Notes\.MD"/.test(c.lastUndo.label), 'remove offers UNDO, naming the file', c.lastUndo && c.lastUndo.label);
  c.lastUndo.undo();
  ok(c._memoryEditorFiles()[0] && c._memoryEditorFiles()[0].name === 'Notes.MD' && /Notes\.MD restored/.test(c.els['card-memory-readout'].textContent),
     'UNDO puts it back first in the list, and says so');
  c.removeCardMemoryFile(0);
  c.downloadCardMemoryFile(0);
  eq(c.downloads[0], ['lore.md', '# Lore\nOld kings.'], 'download hands back the file as it is stored');

  // SAVE writes the pending list; a page without the field leaves the card alone.
  const saveSrc = between(CARDS, 'function saveCard() {', '\nfunction ', 'js/15-cards.js');
  ok(/if \(document\.getElementById\('card-memory-files'\)\) card\.memoryFiles = _memoryEditorFiles\(\);/.test(saveSrc),
     'saveCard writes the pending list only when the editor has one');
  ok(/_memoryChanged && cardMemoryFiles\(card\)\.length/.test(saveSrc), 'and embeds the files ahead of the first chat when they changed');
  ok(/loadCardMemoryEditor\(card\);\s*\/\/ Snapshot AFTER/.test(CARDS), 'editCard loads the list before the unsaved-changes snapshot');
}

/* ================================================================ F */
console.log('\n=== F. Save to memory on a file block ===');
{
  const c = editorContext();
  const aria = { id: 'aria', name: 'Aria', memoryFiles: [] };
  const bram = { id: 'bram', name: 'Bram', memoryFiles: [{ name: 'notes.md', text: 'old', updated: 1 }] };
  const thr = { id: 't', cardId: 'aria', messages: [{ role: 'assistant', content: 'x' }, { role: 'assistant', cardId: 'bram', content: 'y' }, { role: 'user', content: 'z' }] };
  Object.assign(c, {
    state: { ...c.state, characterCards: [aria, bram] },
    getActiveThread: () => thr,
    getActiveCard: () => aria,
    makeCastResolver: (t) => ({ cardFor: (m) => [aria, bram].find(k => k.id === ((m && m.cardId) || t.cardId)) }),
  });
  const btn = (index, filename, content) => ({
    closest: (sel) => sel === '[data-index]' ? { dataset: { index: String(index) } } : null,
    _payload: { filename, content },
  });
  c.fileBlockPayload = (b) => b._payload;

  c.saveFileToCardMemory(btn(0, 'quest-log.md', '# Quests\nFind the key.'));
  eq(aria.memoryFiles.map(f => f.name), ['quest-log.md'], 'a block in Aria\'s reply goes into Aria\'s memory');
  ok(c.saves === 1 && c.ingests === 1 && /saved to Aria's memory/.test(c.toasts.at(-1)[1]), 'saved, embedded ahead of time, and confirmed in a toast', JSON.stringify(c.toasts));

  c._confirmAnswer = false;
  c.saveFileToCardMemory(btn(1, 'notes.md', 'new'));
  eq(bram.memoryFiles[0].text, 'old', 'in a cast thread the speaker (Bram) owns it; declining the replace changes nothing');
  c._confirmAnswer = true;
  c.saveFileToCardMemory(btn(1, 'NOTES.md', 'new'));
  ok(bram.memoryFiles.length === 1 && bram.memoryFiles[0].text === 'new' && /updated in Bram's memory/.test(c.toasts.at(-1)[1]),
     'accepting replaces it', JSON.stringify(bram.memoryFiles));

  c.saveFileToCardMemory(btn(2, 'from-me.md', 'user pasted this'));
  ok(aria.memoryFiles.some(f => f.name === 'from-me.md'), 'a block in the user\'s own message goes to the thread\'s character');

  c.__setEditing('aria');
  c.loadCardMemoryEditor(aria);
  c.saveFileToCardMemory(btn(0, 'later.md', 'written while the editor was open'));
  ok(c._memoryEditorFiles().some(f => f.name === 'later.md'), 'an editor open on the same card picks it up, so its SAVE will not drop it');

  c.saveFileToCardMemory(btn(0, 'big.md', 'x'.repeat(100001)));
  ok(c.toasts.at(-1)[0] === 'err' && /100,000/.test(c.toasts.at(-1)[1]), 'over the limit: an error toast, nothing saved');

  c.makeCastResolver = () => ({ cardFor: () => ({ id: null, name: 'Deleted' }) });
  c.saveFileToCardMemory(btn(0, 'x.md', 'y'));
  ok(/no character/.test(c.toasts.at(-1)[1]), 'a message whose character was deleted says so instead of guessing');
}

/* ================================================================ G */
console.log('\n=== G. card export / import ===');
{
  const c = ragContext();
  Object.assign(c, {
    DEFAULT_CARD: { name: '', memoryFiles: [] }, generateId: () => 'new-id',
    applyImportedCardCode: (card) => card, parseAltGreetings: () => [],
    FALLBACK_CARD_TEXT_COLOR: '#fff', FALLBACK_CARD_DIALOG_COLOR: '#f0f',
  });
  vm.runInContext(between(CARDIO, 'function _stripOriginalMacro', 'function _uniqueCardName', 'js/16-card-io.js'), c);
  vm.runInContext(between(CARDIO, 'function _cardToV3', 'function _v3ToV2', 'js/16-card-io.js'), c);
  const v3 = c._cardToV3({ name: 'Aria', memoryFiles: [{ name: 'notes.md', text: NOTES, updated: 5 }] });
  eq(v3.data.extensions.gobbonet.memoryFiles, [{ name: 'notes.md', text: NOTES }], 'export carries the files (name and text) in extensions.gobbonet');
  ok(!('gobbonet' in c._cardToV3({ name: 'Plain' }).data.extensions), 'a card without memory adds nothing to its export');

  const back = c._cardDataToInternal(v3.data, 'chara_card_v3', '');
  eq(back.memoryFiles.map(f => [f.name, f.text]), [['notes.md', NOTES]], 'import reads them back');

  const hostile = { name: 'X', extensions: { gobbonet: { memoryFiles: [
    { name: '../../secrets/plan', text: 'ok' }, { name: 'bin.md', text: 'a\u0000b' },
    { name: 'big.md', text: 'x'.repeat(100001) }, { name: 'n.md', text: 7 }, 'junk' ] } } };
  eq(c._cardDataToInternal(hostile, 'chara_card_v3', '').memoryFiles.map(f => f.name), ['plan.md'],
     'a shared card cannot bring a path, a binary or an oversized file; bad entries are left behind');
  eq(c._cardDataToInternal({ name: 'None' }, 'chara_card_v2', '').memoryFiles, [], 'a card from another app imports with none');
  const snap = between(CARDIO, 'function _liveCardSnapshot', 'function _cardFileStem', 'js/16-card-io.js');
  ok(/memoryFiles: document\.getElementById\('card-memory-files'\) \? _memoryEditorFiles\(\) : card\.memoryFiles/.test(snap),
     'exporting from the open editor includes its unsaved memory changes, like every other field');
}

/* ================================================================ H */
console.log('\n=== H. the page ===');
{
  const editor = between(HTML, 'id="card-editor"', 'id="card-custom-code"', 'chat.html');
  ok(/id="card-memory-group"/.test(editor) && /<textarea id="card-memory-files" hidden/.test(editor),
     'the Memory Files section sits in the card editor, with its list in a hidden textarea (seen by the unsaved-changes guard)');
  ok(/accept="\.md,\.markdown,\.txt,text\/markdown,text\/plain"/.test(editor) && /onchange="importCardMemoryFiles\(this\)"/.test(editor), 'the picker takes .md and .txt');
  const fp = read('js/22-scheduler.js');
  ok(/querySelectorAll\('input, textarea, select'\)/.test(fp), 'the guard fingerprints every textarea, hidden ones included');

  const ctx = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), Math };
  vm.createContext(ctx);
  vm.runInContext(between(UTILS, 'function mdRenderFileBlock', '\n/* ── Display maths', 'js/18-utils.js'), ctx);
  ok(/onclick="saveFileToCardMemory\(this\)"[^>]*>Save to memory<\/button>/.test(ctx.mdRenderFileBlock('notes.md', 'x')), 'a .md block gets Save to memory');
  ok(ctx.mdRenderFileBlock('log.txt', 'x').includes('Save to memory'), 'so does a .txt block');
  ok(!ctx.mdRenderFileBlock('data.json', 'x').includes('Save to memory') && ctx.mdRenderFileBlock('data.json', 'x').includes('downloadFile(this)'),
     'a .json block keeps only Copy and Save');
  const dl = between(UTILS, 'function downloadFile(btn)', '\n}', 'js/18-utils.js');
  ok(/fileBlockPayload\(btn\)/.test(dl), 'Save and Save to memory read the block through the same function');
  ok(/\.card-memory-row/.test(read('css/06-cards.css')), 'the rows have their style');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
