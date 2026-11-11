/**
 * Which GPU the engine uses (1.8.0, roadmap #12, issue #72): the GPU menu in
 * CONFIG > Model & Performance > Performance, run from the real
 * js/02-model.js against stand-in /gpu answers.
 *
 *   A. The menu: Automatic, each device the engine lists with its memory,
 *      None; the saved choice selected; a card that is gone kept and marked.
 *   B. The note: the CPU-build fallback and its reason, devices that could
 *      not be listed, a small card, PRIME offered for an integrated-only list
 *      (and the switch shown only then, on Linux); remote mode hides it all.
 *   C. Saving: nothing sent when nothing changed; only what changed is sent;
 *      a refusal comes back as the message; the box's buttons and RESET TO
 *      AUTO go through it.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/02-model.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const from = SRC.indexOf('let _gpuLoaded = null;');
const to = SRC.indexOf('/** Reload the current model through the normal swap pipeline. */');
if (from < 0 || to < from) { console.error('could not find the GPU section in js/02-model.js'); process.exit(1); }
const BLOCK = SRC.slice(from, to);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); }
};

function select() {
  return {
    options: [], _v: '',
    get value() { return this._v; },
    set value(v) { this._v = v; },
    set innerHTML(_) { this.options = []; this._v = ''; },
    appendChild(o) { this.options.push(o); if (!this._v) this._v = o.value; return o; },
  };
}

const HYBRID = { devices: [
  { id: 'Vulkan0', name: 'Intel(R) HD Graphics 620', total_mib: 7834, integrated: true },
  { id: 'Vulkan1', name: 'NVIDIA GeForce 940MX', total_mib: 2048, integrated: false } ],
  gpu_device: 'auto', in_use: '', gpu_prime_offload: false, prime_offered: false, linux: true, small_card_mib: 3072 };

function build(view, { post = null } = {}) {
  const els = {
    'perf-device-group': { style: { display: '' } },
    'perf-device': select(),
    'perf-device-note': { textContent: '', style: { display: 'none' } },
    'perf-prime': { checked: false },
    'perf-prime-row': { style: { display: 'none' } },
  };
  const calls = [];
  const ctx = {
    document: { getElementById: id => els[id] || null, createElement: () => ({ value: '', textContent: '' }) },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (opts.method === 'POST') {
        const a = post ? post(JSON.parse(opts.body)) : { status: 200, body: Object.assign({}, view, JSON.parse(opts.body)) };
        return { ok: a.status < 300, status: a.status, json: async () => a.body };
      }
      return { ok: true, status: 200, json: async () => view };
    },
    JSON, console,
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, calls };
}
const labels = sel => sel.options.map(o => o.textContent);

console.log('\n=== A. the menu ===');
{
  const t = build(HYBRID);
  await t.ctx.loadGpuChoice();
  const sel = t.els['perf-device'];
  ok(JSON.stringify(sel.options.map(o => o.value)) === JSON.stringify(['auto', 'Vulkan0', 'Vulkan1', 'none']), 'Automatic, each device, then None', sel.options.map(o => o.value));
  ok(labels(sel)[0] === 'Automatic (prefers a dedicated GPU)' && labels(sel)[3] === 'None: the processor only', 'with plain labels');
  ok(labels(sel)[1] === 'Intel(R) HD Graphics 620 — 7.7 GB (integrated, uses system memory)' && labels(sel)[2] === 'NVIDIA GeForce 940MX — 2.0 GB',
     'each device by name and memory, the integrated one said so', labels(sel));
  ok(sel.value === 'auto', 'the saved choice is selected');
  ok(t.calls.length === 1 && t.calls[0].url === '/gpu', 'read from /gpu');
}
{
  const t = build(Object.assign({}, HYBRID, { gpu_device: 'vulkan1' }));
  await t.ctx.loadGpuChoice();
  ok(t.els['perf-device'].value === 'Vulkan1', 'a saved choice in another case still selects the device');
  const g = build(Object.assign({}, HYBRID, { gpu_device: 'CUDA0', warning: 'gpu_device = "CUDA0": CUDA0 is not among this engine\'s devices (Vulkan0, Vulkan1); using the automatic choice' }));
  await g.ctx.loadGpuChoice();
  ok(g.els['perf-device'].value === 'CUDA0' && labels(g.els['perf-device']).includes('CUDA0 (not found now: Automatic is used)'),
     'a saved card that is gone stays selected, marked');
  ok(/The saved choice, "CUDA0": CUDA0 is not among/.test(g.els['perf-device-note'].textContent), '  and the note says why', g.els['perf-device-note'].textContent);
}

console.log('\n=== B. the note ===');
{
  const t = build(HYBRID);
  await t.ctx.loadGpuChoice();
  const note = t.els['perf-device-note'];
  ok(note.style.display === '' && /NVIDIA GeForce 940MX has 2\.0 GB, so only a few layers fit on it/.test(note.textContent),
     'Automatic picks the 2 GB card: the note says most layers will run on the processor', note.textContent);
  t.els['perf-device'].value = 'Vulkan0';
  t.ctx.updateGpuNote();
  ok(note.style.display === 'none', 'the integrated GPU: no small-card note (its memory is system RAM)');
  ok(t.els['perf-prime-row'].style.display === 'none', 'PRIME is not offered: the NVIDIA card is already in the list');
}
{
  const only = { devices: [HYBRID.devices[0]], gpu_device: 'auto', gpu_prime_offload: false, prime_offered: true, linux: true, small_card_mib: 3072,
                 engine_build: 'cpu', engine_build_reason: 'the GPU build would not start: error while loading shared libraries: libvulkan.so.1' };
  const t = build(only);
  await t.ctx.loadGpuChoice();
  const text = t.els['perf-device-note'].textContent;
  ok(/running the CPU build of the engine, because the GPU build would not start \(error while loading shared libraries: libvulkan\.so\.1\)\. Usually that is a missing Vulkan driver\./.test(text),
     'the CPU-build fallback is said, with the launcher\'s reason', text);
  ok(/sees only an integrated GPU\. On a laptop with an NVIDIA card too, PRIME offload below/.test(text), 'and PRIME is suggested');
  ok(t.els['perf-prime-row'].style.display === '', 'the PRIME switch is shown');
  const off = build(Object.assign({}, only, { linux: false, prime_offered: false }));
  await off.ctx.loadGpuChoice();
  ok(off.els['perf-prime-row'].style.display === 'none', 'never off Linux');
}
{
  const t = build({ devices: [], probe_error: 'the engine took longer than 20s to list its devices', gpu_device: 'auto', linux: true, small_card_mib: 3072 });
  await t.ctx.loadGpuChoice();
  ok(/could not list its devices: the engine took longer/.test(t.els['perf-device-note'].textContent), 'a probe that failed is said');
  const n = build({ devices: [], gpu_device: 'auto', linux: false, small_card_mib: 3072 });
  await n.ctx.loadGpuChoice();
  ok(/sees no GPU, so the model runs on the processor/.test(n.els['perf-device-note'].textContent), 'no GPU at all is said');
  const r = build({ remote: true, devices: [] });
  await r.ctx.loadGpuChoice();
  ok(r.els['perf-device-group'].style.display === 'none', 'remote mode: the GPU menu is hidden');
}

console.log('\n=== C. saving ===');
{
  const t = build(HYBRID);
  await t.ctx.loadGpuChoice();
  ok(await t.ctx.saveGpuChoice() === '' && t.calls.filter(c => c.method === 'POST').length === 0, 'nothing changed: nothing sent');
  t.els['perf-device'].value = 'Vulkan1';
  ok(await t.ctx.saveGpuChoice() === '', 'a new choice saves');
  const p = t.calls.find(c => c.method === 'POST');
  ok(p && p.url === '/gpu' && p.body === '{"gpu_device":"Vulkan1"}', 'only what changed is sent', p && p.body);
  t.els['perf-prime'].checked = true;
  await t.ctx.saveGpuChoice();
  ok(t.calls.filter(c => c.method === 'POST')[1].body === '{"gpu_prime_offload":true}', 'the PRIME switch on its own');
}
{
  const t = build(HYBRID, { post: () => ({ status: 400, body: { error: 'gpu_device = "CUDA0": CUDA0 is not among this engine\'s devices' } }) });
  await t.ctx.loadGpuChoice();
  t.els['perf-device'].value = 'none';
  ok(/CUDA0 is not among/.test(await t.ctx.saveGpuChoice()), 'a refusal comes back as the message to show');
}
{
  const save = SRC.slice(SRC.indexOf('async function savePerfSettings(applyNow) {'), SRC.indexOf('/** Put everything back to the hardware-detected values. */'));
  ok(/const gpuErr = await saveGpuChoice\(\);\s*if \(gpuErr\) \{ _perfStatus\(gpuErr, 'error'\); return; \}\s*if \(!applyNow\)/.test(save),
     'SAVE FOR NEXT START and SAVE & RESTART MODEL save the GPU choice before restarting');
  const reset = SRC.slice(SRC.indexOf('async function resetPerfSettings() {'), SRC.indexOf('/* ================================================================\n   WHICH GPU'));
  ok(/dev\.value = 'auto';\s*const gpuErr = await saveGpuChoice\(\);/.test(reset), 'RESET TO AUTO puts the GPU back to Automatic too');
  ok(/loadGpuChoice\(\);/.test(SRC.slice(SRC.indexOf('async function loadPerfSettings() {'), SRC.indexOf('async function savePerfSettings('))), 'opening CONFIG loads the menu');
  const perf = HTML.slice(HTML.indexOf('Performance &mdash; llama.cpp tuning'), HTML.indexOf('id="perf-status"'));
  ok(/<label for="perf-device">GPU<\/label>\s*<select id="perf-device" onchange="updateGpuNote\(\)">/.test(perf), 'the GPU menu is in the Performance box, above its buttons');
  ok(/<input type="checkbox" id="perf-prime">\s*<span>Use the NVIDIA GPU through PRIME offload<\/span>/.test(perf), 'with the PRIME switch, hidden until it applies');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
