/**
 * The Add a Model window's type and size filters -- roadmap 1.7.7.
 *
 * The whole catalogue at once was a lot to take in. Agreed with the
 * maintainer on 2026-10-12:
 *
 *   TYPE  ALL MODELS / CODING / ROLEPLAY / JACK OF ALL TRADES, from each
 *         model's `buckets` in the catalogue. A model can be in several.
 *   SIZE  ANY SIZE / LIGHT (8 GB or less) / MEDIUM (9 to 16 GB) /
 *         HEAVY (over 16 GB), from the model's GPU memory figure.
 *   LOOK  two rows of the existing small buttons, the chosen one filled the
 *         way SAVE & RESTART MODEL is.
 *
 * Runs the real list code from js/02-model.js against a stubbed DOM.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MODEL_JS = fs.readFileSync(ROOT + '/js/02-model.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const BUCKETS_GO = fs.readFileSync(ROOT + '/internal/catalog/buckets.go', 'utf8');
const block = MODEL_JS.slice(MODEL_JS.indexOf('/* ================================================================\n   MODEL CATALOGUE'));

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), l,
  `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

// The live list's figures, with the agreed buckets.
const MODELS = [
  { index: 1, display: 'Gemma 4 E4B IT', file: 'a', sizeGB: 5.4, minVRAM: 6, ctx: 32768, buckets: ['jack-of-all-trades'] },
  { index: 2, display: 'Llama 3.2 3B Instruct', file: 'b', sizeGB: 3.4, minVRAM: 4, ctx: 32768, buckets: ['jack-of-all-trades'] },
  { index: 3, display: 'Mistral 7B v0.3', file: 'c', sizeGB: 7.5, minVRAM: 8, ctx: 16384, buckets: ['roleplay'] },
  { index: 4, display: 'Qwen3.5 9B', file: 'd', sizeGB: 6.2, minVRAM: 8, ctx: 32768, buckets: ['coding'] },
  { index: 5, display: 'Gemma 4 26B-A4B MoE', file: 'e', sizeGB: 16, minVRAM: 16, ctx: 16384, buckets: ['roleplay', 'jack-of-all-trades'] },
  { index: 6, display: 'Qwen3.6 35B-A3B MoE', file: 'f', sizeGB: 22, minVRAM: 24, ctx: 8192, buckets: ['coding', 'jack-of-all-trades'],
    moeMinVRAM: 8, minRAM: 32 },
  { index: 7, display: 'DeepSeek-R1 8B', file: 'g', sizeGB: 8.5, minVRAM: 10, ctx: 32768, buckets: ['coding'] },
  { index: 8, display: 'gpt-oss 20B', file: 'h', sizeGB: 12, minVRAM: 12, ctx: 16384, buckets: ['coding', 'jack-of-all-trades'] },
  { index: 9, display: 'Command R 7B (12-2024)', file: 'i', sizeGB: 6.6, minVRAM: 8, ctx: 32768, buckets: ['jack-of-all-trades'] },
  { index: 10, display: 'Command R 35B (08-2024)', file: 'j', sizeGB: 19, minVRAM: 24, ctx: 16384, buckets: ['roleplay'] },
  { index: 11, display: 'Untagged, no figure', file: 'k', sizeGB: 1, minVRAM: 0, ctx: 0, buckets: [] },
];

/* --- a DOM small enough to reason about ---------------------------------- */
function makeEl(tag) {
  const el = {
    tag, children: [], style: {}, dataset: {}, attrs: {}, _text: '', _html: '',
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
  };
  return el;
}
/* The filter buttons, built from chat.html's own markup so the test reads
   exactly what ships. */
function filterButtons() {
  return [...HTML.matchAll(/<button class="btn btn-sm" type="button" data-kind="(\w+)" data-value="([\w-]+)"[^>]*>([^<]+)<\/button>/g)]
    .map(m => { const b = makeEl('button'); b.dataset.kind = m[1]; b.dataset.value = m[2]; b.label = m[3]; return b; });
}

function page() {
  const els = {};
  for (const id of ['model-catalog-list', 'model-catalog-free']) els[id] = makeEl('div');
  const filters = makeEl('div');
  const buttons = filterButtons();
  filters.querySelectorAll = () => buttons;
  els['model-catalog-filters'] = filters;
  const ctx = {
    console, document: { getElementById: (id) => els[id] || null, createElement: makeEl },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ models: MODELS, freeGB: 50, source: 'remote' }) }),
    IS_SERVED: true, setInterval: () => 1, clearInterval() {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  // 1.7.9: the list is grouped under tier headings, so rows are picked out by class.
  const rows = () => els['model-catalog-list'].children.filter(r => r.classList.contains('catalog-entry'));
  const names = () => rows().map(r => r.children[0].textContent);
  const rowOf = (n) => rows().find(r => r.children[0].textContent === n);
  const headings = () => els['model-catalog-list'].children.filter(r => r.classList.contains('catalog-tier')).map(h => h.children[0].textContent);
  const pressed = () => buttons.filter(b => b.classList.contains('btn-fill')).map(b => b.label);
  return { ctx, els, buttons, names, pressed, rowOf, headings };
}

/* ================================================================ */
console.log('\n=== size classes: 8 / 16 ===');
{
  const { ctx } = page();
  const k = (gb) => { const c = ctx.catalogSizeClass(gb); return c ? c.key : null; };
  eq([1, 4, 6, 8].map(k), ['light', 'light', 'light', 'light'], '8 GB or less is Light');
  eq([9, 10, 12, 16].map(k), ['medium', 'medium', 'medium', 'medium'], '9 to 16 GB is Medium');
  eq([17, 24, 80].map(k), ['heavy', 'heavy', 'heavy'], 'over 16 GB is Heavy');
  eq([0, null, undefined, 'x', -2].map(k), [null, null, null, null, null], 'no figure, no class');
}

console.log('\n=== opening: everything, nothing chosen yet ===');
const P = page();
{
  await P.ctx.loadModelCatalog();
  eq(P.names().length, 11, 'all 11 models are listed');
  eq(P.headings(), ['LIGHT', 'MEDIUM', 'HEAVY', 'MIXTURE OF EXPERTS'], 'grouped under the four tier headings, in order (1.7.9)');
  eq(P.names().slice(0, 3), ['Untagged, no figure', 'Llama 3.2 3B Instruct', 'Gemma 4 E4B IT'], 'smallest download first within a tier');
  eq(P.pressed(), ['ALL MODELS', 'ANY SIZE'], 'ALL MODELS and ANY SIZE are the filled buttons');
  eq(P.els['model-catalog-filters'].style.display, '', 'the filter rows are shown once a list has loaded');
  const meta = P.rowOf('Gemma 4 E4B IT').children[1].textContent;
  eq(meta, 'Light · 5.4 GB download · suits 6 GB VRAM or more · 32,768 token context', 'each row starts with its size class');
  const bare = P.rowOf('Untagged, no figure').children[1].textContent;
  eq(bare, '1.0 GB download', 'a model with no figure has no class, and nothing invented');
}

console.log('\n=== a MoE model says it also suits a smaller card (issue #65) ===');
{
  const moe = P.rowOf('Qwen3.6 35B-A3B MoE').children[1].textContent;
  eq(moe, 'Heavy · 22.0 GB download · suits 24 GB VRAM or more, or 8 GB with 32 GB system RAM · 8,192 token context',
     'Qwen3.6 35B-A3B: or 8 GB with 32 GB system RAM');
  const dense = P.rowOf('Command R 35B (08-2024)').children[1].textContent;
  ok(!/system RAM/.test(dense), 'a dense model says nothing about system RAM', dense);
}

console.log('\n=== type ===');
{
  P.ctx.setCatalogFilter('type', 'coding');
  eq(P.names(), ['Qwen3.5 9B', 'DeepSeek-R1 8B', 'gpt-oss 20B', 'Qwen3.6 35B-A3B MoE'], 'CODING (by tier, smallest first)');
  eq(P.pressed(), ['CODING', 'ANY SIZE'], 'and CODING is now the filled one');
  P.ctx.setCatalogFilter('type', 'roleplay');
  eq(P.names(), ['Mistral 7B v0.3', 'Gemma 4 26B-A4B MoE', 'Command R 35B (08-2024)'], 'ROLEPLAY');
  P.ctx.setCatalogFilter('type', 'jack-of-all-trades');
  eq(P.names(), ['Llama 3.2 3B Instruct', 'Gemma 4 E4B IT', 'Command R 7B (12-2024)', 'gpt-oss 20B',
                 'Gemma 4 26B-A4B MoE', 'Qwen3.6 35B-A3B MoE'], 'JACK OF ALL TRADES');
  ok(!P.names().includes('Untagged, no figure'), 'an untagged model is in no bucket');
  P.ctx.setCatalogFilter('type', 'all');
  ok(P.names().includes('Untagged, no figure'), 'but is under ALL MODELS');
}

console.log('\n=== size, and both together ===');
{
  P.ctx.setCatalogFilter('size', 'light');
  eq(P.names(), ['Llama 3.2 3B Instruct', 'Gemma 4 E4B IT', 'Qwen3.5 9B', 'Command R 7B (12-2024)', 'Mistral 7B v0.3'], 'LIGHT');
  P.ctx.setCatalogFilter('size', 'medium');
  eq(P.names(), ['DeepSeek-R1 8B', 'gpt-oss 20B', 'Gemma 4 26B-A4B MoE'], 'MEDIUM');
  P.ctx.setCatalogFilter('size', 'heavy');
  eq(P.names(), ['Command R 35B (08-2024)', 'Qwen3.6 35B-A3B MoE'], 'HEAVY');
  P.ctx.setCatalogFilter('size', 'moe');
  eq(P.names(), ['Qwen3.6 35B-A3B MoE'], 'MOE: only the Mixture-of-Experts models (1.7.9)');
  eq(P.headings(), ['MIXTURE OF EXPERTS'], 'under their own heading');
  P.ctx.setCatalogFilter('size', 'heavy');
  P.ctx.setCatalogFilter('type', 'coding');
  eq(P.names(), ['Qwen3.6 35B-A3B MoE'], 'CODING + HEAVY');
  eq(P.pressed(), ['CODING', 'HEAVY'], 'one filled button per row');
  eq(P.buttons.filter(b => b.attrs['aria-pressed'] === 'true').map(b => b.label), ['CODING', 'HEAVY'], 'and aria-pressed agrees');
  P.ctx.setCatalogFilter('type', 'roleplay');
  P.ctx.setCatalogFilter('size', 'light');
  eq(P.names(), ['Mistral 7B v0.3'], 'ROLEPLAY + LIGHT');
  P.ctx.setCatalogFilter('size', 'medium');
  eq(P.names(), ['Gemma 4 26B-A4B MoE'], 'ROLEPLAY + MEDIUM');
  P.ctx.setCatalogFilter('type', 'coding');
  P.ctx.setCatalogFilter('size', 'light');
  eq(P.names(), ['Qwen3.5 9B'], 'CODING + LIGHT');
}

console.log('\n=== nothing matching, and nonsense ===');
{
  const p = page();
  await p.ctx.loadModelCatalog();
  p.ctx.setCatalogFilter('type', 'roleplay');
  p.ctx.setCatalogFilter('size', 'heavy');
  p.ctx.setCatalogFilter('type', 'jack-of-all-trades');
  ok(p.names().length === 1 && p.names()[0] === 'Qwen3.6 35B-A3B MoE', 'JACK + HEAVY');
  // An empty result says how to get back.
  vm.runInContext("_catalogModels = _catalogModels.filter(m => m.minVRAM <= 8);", p.ctx);
  p.ctx.renderCatalogList();
  eq(p.els['model-catalog-list'].textContent, 'No models match. Choose ALL MODELS or ANY SIZE to see more.',
     'no match: says so, and how to see more');
  p.ctx.setCatalogFilter('colour', 'blue');
  eq(p.pressed(), ['JACK OF ALL TRADES', 'HEAVY'], 'an unknown filter is ignored');
}

console.log('\n=== the choice lasts while the page is open ===');
{
  await P.ctx.loadModelCatalog();
  eq(P.pressed(), ['CODING', 'LIGHT'], 'reopening keeps the last choice');
  eq(P.names(), ['Qwen3.5 9B'], 'and the list follows it');
}

console.log('\n=== an empty catalogue hides the filters ===');
{
  const p = page();
  p.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) });
  await p.ctx.loadModelCatalog();
  eq(p.els['model-catalog-list'].textContent, 'The catalogue is empty.', 'says the catalogue is empty');
  eq(p.els['model-catalog-filters'].style.display, 'none', 'and shows no filters for nothing');
}

console.log('\n=== the markup ===');
{
  const btns = filterButtons();
  eq(btns.map(b => `${b.dataset.kind}:${b.dataset.value}:${b.label}`), [
    'type:all:ALL MODELS', 'type:coding:CODING', 'type:roleplay:ROLEPLAY', 'type:jack-of-all-trades:JACK OF ALL TRADES',
    'size:any:ANY SIZE', 'size:light:LIGHT', 'size:medium:MEDIUM', 'size:heavy:HEAVY', 'size:moe:MOE'], 'the nine buttons, in order');
  const goBuckets = (BUCKETS_GO.match(/var Buckets = \[\]string\{([^}]*)\}/)[1].match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1));
  eq(btns.filter(b => b.dataset.kind === 'type' && b.dataset.value !== 'all').map(b => b.dataset.value), goBuckets,
     'the type buttons are exactly the buckets the server knows');
  ok(btns.every(b => new RegExp(`onclick="setCatalogFilter\\('${b.dataset.kind}','${b.dataset.value}'\\)"`).test(HTML)),
     'each button sets its own filter');
  const box = HTML.slice(HTML.indexOf('<div id="model-catalog-filters"'), HTML.indexOf('<!-- LIST VIEW -->'));
  ok((box.match(/<span style="font-size:12px;color:rgba\(255,255,255,0\.5\);min-width:38px;">(Type|Size):<\/span>/g) || []).length === 2,
     'the Type: / Size: labels are Auto-Continue’s inline label style');
  ok(HTML.includes('<span style="font-size:12px;color:rgba(255,255,255,0.5);">Wait between posts:</span>'), 'which is still what Auto-Continue uses');
  ok((box.match(/display:flex;align-items:center;gap:10px;flex-wrap:wrap;/g) || []).length === 2, 'two wrapping rows, so a phone wraps them');
  ok(HTML.indexOf('id="model-catalog-filters"') < HTML.indexOf('id="model-catalog-list"'), 'above the list');
  ok(/class="btn btn-sm btn-fill"[^>]*>SAVE &amp; RESTART MODEL/.test(HTML), 'and btn-fill is the same filled look SAVE & RESTART MODEL uses');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
