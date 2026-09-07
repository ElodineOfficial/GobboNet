/**
 * Issues #47, #48, #27 — the model dropdown in remote mode.
 *
 * Drives the REAL loadModelsList / onHeaderModelChange / getRequestModelName
 * out of js/02-model.js in a minimal fake DOM, plus source-level guards that
 * every request path actually calls the resolver instead of hardcoding a name.
 *
 * The three reports were one bug: nothing asked the upstream what it served,
 * so the dropdown was empty against a server with models loaded — and every
 * request said model:'local' regardless, which is why the documented Ollama
 * workaround had to alias a real model to that literal name.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

// '..' not '.': these live in tests/ and read the frontend from the repo root.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MODEL_JS = fs.readFileSync(ROOT + '/js/02-model.js', 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};
const eq = (a, b, label) =>
  ok(a === b, label + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

/* ---------- a fake <select> good enough for the real code ---------- */
function makeSelect() {
  const sel = {
    options: [], selectedIndex: -1, _value: '',
    get value() { return this._value; },
    set value(v) {
      this._value = v;
      const i = this.options.findIndex(o => o.value === v);
      if (i >= 0) this.selectedIndex = i;
    },
    set innerHTML(html) {
      this._html = html;
      // The fallback paths build <option> by interpolation; parse enough of it
      // that a test can assert on what the user would actually see.
      const m = /<option value="([^"]*)">([^<]*)<\/option>/.exec(html || '');
      this.options = m ? [{ value: m[1], textContent: m[2], dataset: {} }] : [];
      this.selectedIndex = this.options.length ? 0 : -1;
      this._value = this.options.length ? this.options[0].value : '';
    },
    get innerHTML() { return this._html || ''; },
    appendChild(opt) {
      this.options.push(opt);
      if (opt.selected) { this.selectedIndex = this.options.length - 1; this._value = opt.value; }
      else if (this.selectedIndex < 0) { this.selectedIndex = 0; this._value = this.options[0].value; }
    }
  };
  return sel;
}

function build(payload, { fetchFails = false } = {}) {
  const sel = makeSelect();
  const swapCalls = [];
  // 02-model.js declares its own showModelSwitchToast, which shadows anything
  // the context supplies -- so observe the element it writes to rather than
  // trying to stub the function.
  const toastEl = {
    textContent: '', className: '',
    classList: { add(c) { toastEl.className += ' ' + c; }, remove() {} }
  };
  const toasts = toastEl;

  const ctx = {
    console,
    IS_SERVED: true,
    // 02-model.js is a plain <script> in the browser, so it reaches for a few
    // globals the page provides. Supply the minimum rather than slicing the
    // file into fragments -- the point of this harness is to run what ships.
    window: { location: { origin: 'http://127.0.0.1:9066' } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    MODEL_REGISTRY: { custom: { name: 'Custom GGUF', family: 'custom', maxCtx: 4096, defaultCtx: 2048 } },
    document: {
      getElementById: id => {
        if (id === 'header-model-select') return sel;
        if (id === 'model-switch-toast') return toastEl;
        return null;
      },
      // The happy path builds options with createElement + textContent, which
      // is exactly why it needs no escaping. Without this the real code throws
      // and silently takes its catch branch, and the suite ends up asserting
      // against the fallback instead of the thing under test.
      createElement: () => ({ value: '', textContent: '', dataset: {}, selected: false })
    },
    escapeHtml: s => String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    setTimeout, clearTimeout,
    fetch: async (url) => {
      if (fetchFails) throw new Error('offline');
      if (url.startsWith('/models-list.json')) {
        return { ok: true, json: async () => payload };
      }
      if (url === '/swap-model') { swapCalls.push(url); return { ok: true, json: async () => ({}) }; }
      // pollSwapStatus spins on the wall clock until phase is ready|error, so
      // the harness has to actually finish the swap or the suite hangs.
      if (url.startsWith('/swap-status')) {
        return { ok: true, json: async () => ({ phase: 'ready', file: 'Qwen3-30B.gguf' }) };
      }
      if (url.startsWith('/active-model.json')) {
        return { ok: true, json: async () => ({ id: 'qwen3', ggufFile: 'Qwen3-30B.gguf', name: 'Qwen3 30B' }) };
      }
      return { ok: false, json: async () => ({}) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(MODEL_JS, ctx);
  return { ctx, sel, toasts, swapCalls };
}

const REMOTE = {
  mode: 'remote',
  active: 'gemma3:12b',
  models: [
    { file: 'gemma3:12b', id: 'gemma3:12b', name: 'gemma3:12b', family: 'remote', remote: true, active: true },
    { file: 'qwen3:30b', id: 'qwen3:30b', name: 'qwen3:30b', family: 'remote', remote: true, active: false }
  ]
};

const LOCAL = {
  active: 'Cydonia-24B.gguf',
  models: [
    { file: 'Cydonia-24B.gguf', id: 'cydonia', name: 'Cydonia 24B', family: 'mistral', active: true },
    { file: 'Qwen3-30B.gguf', id: 'qwen3', name: 'Qwen3 30B', family: 'qwen', active: false }
  ]
};

console.log('\nremote mode — the dropdown is populated (#47, #27)');
{
  const { ctx, sel } = build(REMOTE);
  await ctx.loadModelsList();
  eq(sel.options.length, 2, 'both upstream models are listed');
  eq(sel.options[0].value, 'gemma3:12b', 'option value is the upstream model id');
  eq(sel.options[0].dataset.remote, '1', 'remote rows are flagged for the change handler');
  eq(ctx.getRequestModelName(), 'gemma3:12b', 'the active upstream model is what requests will name');
}

console.log('\nremote mode — selecting a model does not restart anything');
{
  const { ctx, sel, toasts, swapCalls } = build(REMOTE);
  await ctx.loadModelsList();
  sel.value = 'qwen3:30b';
  await ctx.onHeaderModelChange(sel);
  eq(swapCalls.length, 0, 'no /swap-model POST for a server GobboNet does not manage');
  eq(ctx.getRequestModelName(), 'qwen3:30b', 'the selection is what the next request names');
  ok(/qwen3:30b/.test(toasts.textContent) && /t-ok/.test(toasts.className),
     'user is told the switch took effect');
}

console.log("\nlocal mode — nothing changes (model:'local' is still correct)");
{
  const { ctx, sel } = build(LOCAL);
  await ctx.loadModelsList();
  eq(sel.options.length, 2, 'local GGUFs still listed');
  eq(ctx.getRequestModelName(), 'local',
     "local mode still sends 'local' — llama-server serves one model and ignores the field");
  eq(sel.options[0].dataset.remote, '', 'local rows are not flagged remote');
}

console.log('\nlocal mode — a local swap still goes through /swap-model');
{
  const { ctx, sel, swapCalls } = build(LOCAL);
  await ctx.loadModelsList();
  sel.value = 'Qwen3-30B.gguf';
  await ctx.onHeaderModelChange(sel);
  ok(swapCalls.length > 0, 'hot-swap still fires for a server we DO manage');
}

console.log('\nempty list — "could not ask" is distinguishable from "nothing loaded" (#47)');
{
  const { ctx, sel } = build({ mode: 'remote', active: '', models: [], upstream_error: 'connection refused' });
  await ctx.loadModelsList();
  ok(/Upstream unreachable/.test(sel.innerHTML), 'unreachable upstream says so');
}
{
  const { ctx, sel } = build({ mode: 'remote', active: '', models: [] });
  await ctx.loadModelsList();
  ok(/Upstream reports no models/.test(sel.innerHTML),
     'a reachable upstream with nothing loaded says something different');
}
{
  const { ctx, sel } = build({ active: '', models: [] });
  await ctx.loadModelsList();
  ok(!/Upstream/.test(sel.innerHTML), 'local mode keeps its own empty-state wording');
}

console.log('\nfetch failure falls back without throwing');
{
  const { ctx, sel } = build(REMOTE, { fetchFails: true });
  await ctx.loadModelsList();
  ok(sel.options.length >= 1, 'a dropdown still renders');
  eq(ctx.getRequestModelName(), 'local', "unknown state falls back to 'local', not to undefined");
}

console.log('\nsource guards — every request path uses the resolver');
{
  const files = ['js/03-generation.js', 'js/07-prompt.js', 'js/10-chat.js', 'js/23-card-code.js'];
  let hardcoded = 0, resolved = 0;
  for (const f of files) {
    const src = fs.readFileSync(ROOT + '/' + f, 'utf8');
    hardcoded += (src.match(/model:\s*'local'/g) || []).length;
    resolved += (src.match(/model:\s*getRequestModelName\(\)/g) || []).length;
  }
  eq(hardcoded, 0, "no request path still hardcodes model:'local'");
  eq(resolved, 5, 'all five request paths call getRequestModelName()');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
