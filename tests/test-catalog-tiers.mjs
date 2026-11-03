/**
 * 1.7.9 F2 + issue #12 -- the Add a Model window's new parts, run for real
 * from js/02-model.js against a stubbed DOM and fetch:
 *
 *   A. an UNVERIFIED entry (no pinned SHA-256) needs a second click; the
 *      first sends nothing, the second sends confirmUnverified; a pinned
 *      entry starts on the first; a 409 from the server arms the row too;
 *      the arming runs out.
 *   B. "Found on this computer": rows from /local-models.json, USE IT sends
 *      only the id, success offers the switch, a clash or an existing link
 *      cannot be clicked, file names are text, never markup.
 *   C. the pinning and live-list tools: pin-hashes.py and
 *      gen-remote-catalog.py exist and the bundled list carries the pins.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const MODEL_JS = read('js/02-model.js');
const block = MODEL_JS.slice(MODEL_JS.indexOf('/* ================================================================\n   MODEL CATALOGUE'));

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };
const tick = () => new Promise(r => setTimeout(r, 0));

function makeEl(tag) {
  const el = {
    tag, children: [], style: {}, dataset: {}, attrs: {}, _text: '', _html: '', disabled: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this.classList._s].join(' '); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; },
    set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelector(sel) { return this.children.find(c => c.tag === sel) || null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function page({ models = [], local = { roots: [], found: [], notes: [] }, onPost = () => ({ status: 200, body: { started: true, status: { state: 'running' } } }) } = {}) {
  const els = {};
  const ids = ['model-catalog-list', 'model-catalog-free', 'model-catalog-filters', 'model-catalog-local',
    'model-catalog-progress', 'model-catalog-dl-title', 'model-catalog-bar', 'model-catalog-log',
    'model-catalog-note', 'model-catalog-swap-row', 'model-catalog-modal'];
  for (const id of ids) els[id] = makeEl('div');
  const posts = [];
  let now = 1_000_000;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: id => els[id] || null, createElement: makeEl },
    IS_SERVED: true, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    Date: { now: () => now },
    loadModelsList: () => { ctx._modelsListReloaded = (ctx._modelsListReloaded || 0) + 1; },
    fetch: async (url, opts = {}) => {
      const path = url.split('?')[0];
      const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
      if (path === '/catalog.json') return reply(200, { models, freeGB: 50, source: 'remote' });
      if (path === '/local-models.json') return reply(200, local);
      if (opts.method === 'POST') { posts.push({ url, body: JSON.parse(opts.body) }); const r = onPost(url, JSON.parse(opts.body)); return reply(r.status, r.body); }
      return reply(200, { state: 'idle' });
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  const rows = () => els['model-catalog-list'].children.filter(r => r.classList.contains('catalog-entry'));
  const row = n => rows().find(r => r.children[0].textContent === n);
  const localRows = () => els['model-catalog-local'].children.filter(r => r.classList.contains('catalog-entry'));
  return { ctx, els, posts, rows, row, localRows, advance: ms => { now += ms; } };
}

const M = (index, display, extra) => ({ index, display, file: display + '.gguf', sizeGB: 5, minVRAM: 8, ctx: 8192, buckets: [], installed: false, ...extra });

console.log('\n=== A. unverified entries need a second click ===');
{
  const p = page({ models: [M(1, 'Pinned', { verified: true, tier: 'small' }), M(2, 'Unpinned', { verified: false, tier: 'small' })] });
  await p.ctx.loadModelCatalog();
  const un = p.row('Unpinned');
  ok(/Unverified: no checksum pinned/.test(un.children[3] && un.children[3].textContent), 'an unpinned entry says Unverified on a line of its own', un.children.map(c => c.textContent));
  ok(!p.row('Pinned').children[3], 'a pinned one says nothing extra');
  un.children[2].onclick();
  await tick();
  ok(p.posts.length === 0, 'the first click sends nothing');
  const armed = p.row('Unpinned');
  ok(armed.children[2].textContent === 'CLICK AGAIN TO DOWNLOAD' && armed.children[2].classList.contains('btn-amber'), 'it asks for a second click');
  ok(/HuggingFace’s own record/.test(armed.children[3].textContent), 'and says what is and is not checked');
  armed.children[2].onclick();
  await tick();
  ok(p.posts.length === 1 && p.posts[0].body.confirmUnverified === true && p.posts[0].body.index === 2 && Object.keys(p.posts[0].body).length === 2,
     'the second click sends the index and confirmUnverified, nothing else', p.posts);

  const q = page({ models: [M(1, 'Pinned', { verified: true })] });
  await q.ctx.loadModelCatalog();
  q.row('Pinned').children[2].onclick();
  await tick();
  ok(q.posts.length === 1 && JSON.stringify(q.posts[0].body) === '{"index":1}', 'a pinned entry starts on the first click, index only');
}
{
  const p = page({ models: [M(2, 'Unpinned', { verified: false })] });
  await p.ctx.loadModelCatalog();
  p.row('Unpinned').children[2].onclick();
  p.advance(9000);
  p.ctx.renderCatalogList();
  ok(p.row('Unpinned').children[2].textContent === 'DOWNLOAD', 'the second click has to come within a few seconds');
}
{
  // The window thought it was pinned; the server's catalogue says otherwise.
  const p = page({ models: [M(3, 'Stale', { verified: true })], onPost: () => ({ status: 409, body: { needsConfirm: true, error: 'x' } }) });
  await p.ctx.loadModelCatalog();
  await p.ctx.startModelDownload(3, 'Stale', 'Stale.gguf');
  ok(p.els['model-catalog-progress'].style.display === 'none', 'a 409 from the server goes back to the list');
  ok(p.ctx.catalogArmed(3), 'with that row armed for the second click');
}
{
  const p = page({ models: [M(1, 'L', { minVRAM: 4 }), M(2, 'Mo', { minVRAM: 22, moeMinVRAM: 8, minRAM: 24 }), M(3, 'H', { minVRAM: 24 }), M(4, 'Me', { minVRAM: 12 }), M(5, 'Hint', { minVRAM: 4, tier: 'large' })] });
  await p.ctx.loadModelCatalog();
  const heads = p.els['model-catalog-list'].children.filter(c => c.classList.contains('catalog-tier')).map(h => h.children[0].textContent);
  ok(JSON.stringify(heads) === '["LIGHT","MEDIUM","HEAVY","MIXTURE OF EXPERTS"]', 'four tier headings, in order', heads);
  ok(JSON.stringify(p.rows().map(r => r.children[0].textContent)) === '["L","Me","H","Hint","Mo"]', 'the server’s tier wins over the figure ("Hint" is listed as heavy)');
  ok(p.els['model-catalog-list'].children.filter(c => c.classList.contains('catalog-tier')).every(h => h.attrs.role === 'heading'), 'headings are headings to a screen reader');
}

console.log('\n=== B. found on this computer ===');
{
  const local = {
    roots: [{ path: '/home/u/.cache/huggingface/hub', kind: 'hf-cache', exists: true }],
    found: [
      { id: 'aaaaaaaaaaaaaaaa', name: 'Foo-Q4_K_M.gguf', file: 'Foo-Q4_K_M.gguf', repo: 'bartowski/Foo-GGUF', sizeGB: 4.4, parts: 1, kind: 'hf-cache', where: '/home/u/.cache/huggingface/hub', state: 'new' },
      { id: 'bbbbbbbbbbbbbbbb', name: '<img src=x onerror=alert(1)>.gguf', file: 'x.gguf', sizeGB: 1, parts: 1, kind: 'folder', where: '/d', state: 'new' },
      { id: 'cccccccccccccccc', name: 'Linked.gguf', file: 'Linked.gguf', sizeGB: 2, parts: 1, kind: 'folder', where: '/d', state: 'linked' },
      { id: 'dddddddddddddddd', name: 'Clash.gguf', file: 'Clash.gguf', sizeGB: 2, parts: 1, kind: 'folder', where: '/d', state: 'name-taken' },
    ],
    notes: [],
  };
  const p = page({ local, onPost: (url, body) => url === '/local-models/link' ? { status: 200, body: { linked: true, file: 'Foo-Q4_K_M.gguf', how: 'symlink' } } : { status: 500, body: {} } });
  await p.ctx.loadLocalModels();
  const box = p.els['model-catalog-local'];
  ok(box.children[0].children[0].textContent === 'FOUND ON THIS COMPUTER', 'a FOUND ON THIS COMPUTER heading');
  const r = p.localRows();
  ok(r.length === 4, 'one row per model found');
  ok(r[0].children[0].textContent === 'bartowski/Foo-GGUF · Foo-Q4_K_M.gguf' && /4\.4 GB · in \/home\/u\/\.cache\/huggingface\/hub \(HuggingFace cache\)/.test(r[0].children[1].textContent),
     'it names the repo, the size and where it is');
  ok(r[1].children[0].textContent === '<img src=x onerror=alert(1)>.gguf' && box.children.every(c => c.innerHTML === ''),
     'a hostile file name is shown as text');
  ok(r[2].children[2].disabled && r[2].children[2].textContent === 'IN YOUR MODELS', 'one already linked cannot be linked again');
  ok(r[3].children[2].disabled && r[3].children[2].textContent === 'NAME IN USE', 'a name clash is shown, not clicked through');
  ok(r[0].children[2].textContent === 'USE IT', 'the rest say USE IT');
  await p.ctx.linkLocalModel('aaaaaaaaaaaaaaaa', 'Foo-Q4_K_M.gguf', r[0]);
  ok(p.posts.length === 1 && p.posts[0].url === '/local-models/link' && JSON.stringify(p.posts[0].body) === '{"id":"aaaaaaaaaaaaaaaa"}',
     'USE IT sends the id and nothing else -- never a path', p.posts);
  ok(p.els['model-catalog-swap-row'].style.display === '' && /Nothing was copied or downloaded/.test(p.els['model-catalog-log'].textContent),
     'then offers SWITCH TO IT NOW, and says nothing was copied');
  ok(p.ctx._modelsListReloaded >= 1, 'and refreshes the header dropdown');
}
{
  const p = page({ local: { roots: [{ exists: false }], found: [], notes: [] } });
  await p.ctx.loadLocalModels();
  ok(/add folders with model_dirs in config\.toml/.test(p.els['model-catalog-local'].textContent), 'with no cache here, it says how to add folders');
  const q = page({ local: { roots: [{ exists: true }], found: [], notes: ['Stopped looking after 50000 entries'] } });
  await q.ctx.loadLocalModels();
  ok(/nothing new/.test(q.els['model-catalog-local'].textContent) && /Stopped looking/.test(q.els['model-catalog-local'].textContent),
     'nothing found says so, and a cut-short scan says that too');
}
{
  const p = page({ local: { roots: [], found: [{ id: 'e', name: 'E.gguf', file: 'E.gguf', sizeGB: 1, state: 'new', where: '/d', kind: 'folder' }], notes: [] },
    onPost: () => ({ status: 409, body: { error: 'name taken: E.gguf is already in your models folder and is a different file' } }) });
  await p.ctx.loadLocalModels();
  const r = p.localRows()[0];
  const done = await p.ctx.linkLocalModel('e', 'E.gguf', r);
  ok(done === false && r.children[2].textContent === 'USE IT' && !r.children[2].disabled, 'a refused link puts the button back');
  ok(/already in your models folder/.test(p.els['model-catalog-local'].textContent), 'and shows the server’s reason');
}

console.log('\n=== C. the catalogue and its tools ===');
{
  const html = read('chat.html');
  ok(/<div id="model-catalog-local"/.test(html) && html.indexOf('id="model-catalog-local"') < html.indexOf('id="model-catalog-filters"'),
     'the found section sits above the catalogue filters');
  ok(/openModelCatalog\(\) \{[\s\S]*?loadModelCatalog\(\);\n  loadLocalModels\(\);/.test(MODEL_JS), 'it is read when the window opens, not before');
  const ini = read('catalog/models.ini');
  ok((ini.match(/^\[\d+\]/gm) || []).length === 16, 'the bundled catalogue has 16 models');
  ok((ini.match(/^sha256=[0-9a-f]{64}\r?$/gm) || []).length >= 2, 'and carries the pinned hashes through');
  ok(fs.existsSync(`${ROOT}/catalog/pin-hashes.py`) && fs.existsSync(`${ROOT}/catalog/gen-remote-catalog.py`), 'pin-hashes.py and gen-remote-catalog.py are shipped');
  const live = JSON.parse(read('catalog/gobbonet_model_list.json'));
  ok(live.schema_version === 1 && live.models.length === 16 && live.models.every(m => ['small', 'mid', 'large', 'moe'].includes(m.tier)),
     'the live list to upload has all 16, each with a tier');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
