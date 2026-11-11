/**
 * The Linux wizard's Install location page, run (1.8.0, issue #68).
 *
 * The page asks for a data folder and a models folder. The models folder
 * follows the data folder (<data>/models) until it is typed into, and a data
 * folder that already holds GGUF models offers, pre-selected, to use it for
 * models -- so pointing setup at a model collection no longer gives an empty
 * models subfolder.
 *
 * Found by installing the 1.8.0 .deb: the offer also counted the data folder's
 * own models subfolder. A model already there -- where 1.7.9's wizard said
 * existing models belong, where `gobbonet uninstall` leaves the models it
 * keeps, or any setup run again -- made the page offer the data folder
 * itself, and one click on Continue stored model_dir = the data folder. The
 * model menu lists the top of model_dir, so GobboNet then started with no
 * model ("no .gguf files in ...").
 *
 * This runs the page's own location code (installer-linux/wizard.html and
 * its ZIP copy) against a stand-in DOM and a stand-in /api/scan that counts
 * the way gobbonet-setup.py does (tests/test-setup-folders.py runs the real
 * one):
 *
 *   A. Models only in <data>/models: no offer, the models folder stays
 *      <data>/models, and its note says the model is found -- on loading the
 *      page and on typing that folder.
 *   B. A collection (models at its top, or one folder down): still offered,
 *      pre-selected, with everything it holds counted.
 *   C. The notes: "It" for one model, "They" for more, and a folder that
 *      does not exist yet.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const WIZARDS = ['installer-linux/wizard.html', 'linux-amd64/wizard.html'];

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

const between = (src, from, to, file) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) { console.error(`could not locate ${JSON.stringify(from)} in ${file}`); process.exit(1); }
  return src.slice(a, b);
};

const HOME = '/home/u';
const DATA = HOME + '/.local/share/gobbonet';

/* Folders: path -> { files, dirs: { name: [files] } }. A subfolder listed in
   dirs can be scanned in its own right. */
const TREE = {
  [DATA]: { files: ['launch.log'], dirs: { models: ['test-model.gguf'] } },
  [HOME + '/Collection']: { files: ['a.gguf', 'b.GGUF', 'c.gguf', 'mmproj-c.gguf', 'notes.txt'],
                            dirs: { qwen: ['q.gguf'], '.hidden': ['h.gguf'] } },
  [HOME + '/Mixed']: { files: ['top.gguf'], dirs: { models: ['m1.gguf', 'm2.gguf'] } },
  [HOME + '/Sorted']: { files: [], dirs: { mistral: ['x.gguf'], llama: ['y.gguf'] } },
  [HOME + '/Two']: { files: ['one.gguf', 'two.gguf'], dirs: {} },
};
const isModel = (f) => /\.gguf$/i.test(f) && !/mmproj/i.test(f);
function node(path) {
  if (TREE[path]) return TREE[path];
  const cut = path.lastIndexOf('/');
  const parent = TREE[path.slice(0, cut)];
  const files = parent && parent.dirs[path.slice(cut + 1)];
  return files ? { files, dirs: {} } : null;
}
function scanOf(raw) {
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  if (!path.startsWith('/')) return { absolute: false, exists: false, models: 0, models_sub: 0 };
  const n = node(path);
  if (!n) return { absolute: true, exists: false, models: 0, models_sub: 0 };
  let sub = 0;
  for (const [name, files] of Object.entries(n.dirs)) if (!name.startsWith('.')) sub += files.filter(isModel).length;
  return { absolute: true, exists: true, models: n.files.filter(isModel).length, models_sub: sub };
}

function harness(file) {
  const src = fs.readFileSync(ROOT + '/' + file, 'utf8');
  const logic = between(src, 'var modelsTouched = false', "$('save-location').onclick", file);
  const load = between(src, "$('data-path').value = s.data_dir;", "$('web-port').value", file);
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, value: '', textContent: '', style: {}, listeners: {}, onclick: null,
    classList: { set: new Set(), toggle(c, on) { (on ? this.set.add(c) : this.set.delete(c)); }, contains(c) { return this.set.has(c); } },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  });
  // As the page's markup has them.
  el('data-has-models').style.display = 'none';
  el('c-usedata').classList.set.add('sel');
  const scans = [];
  const ctx = {
    console, Promise, JSON, encodeURIComponent, setTimeout, clearTimeout,
    $: el,
    fetch: async (url) => {
      const u = new URL(url, 'http://127.0.0.1:1');
      if (u.pathname !== '/api/scan') throw new Error('unexpected GET ' + url);
      const path = u.searchParams.get('path');
      scans.push(path);
      return { ok: true, json: async () => scanOf(path) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(logic + '\nfunction __load(s) {\n' + load + '\n}', ctx);
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  return {
    els, scans,
    async open(data_dir, model_dir) { ctx.__load({ data_dir, model_dir }); await settle(); },
    async type(id, value) { el(id).value = value; for (const f of el(id).listeners.input || []) f(); await settle(450); },
    view() {
      return { models: el('model-path').value, offered: el('data-has-models').style.display === 'block',
               label: el('usedata-t').textContent, note: el('model-note').textContent,
               use: el('c-usedata').classList.contains('sel') };
    },
  };
}

for (const file of WIZARDS) {
  console.log(`\n=== ${file} ===`);

  console.log('A. models only in the data folder\'s own models subfolder');
  {
    let h = harness(file);
    await h.open(DATA, DATA + '/models');
    let v = h.view();
    eq(v.offered, false, 'opening the page on the default folders: the data folder is not offered for models');
    eq(v.models, DATA + '/models', 'the models folder stays <data>/models');
    eq(v.note, '1 GGUF model found here. It will be in the model menu.', 'and says the model there is found');

    h = harness(file);
    await h.open(HOME + '/Fresh', HOME + '/Fresh/models');
    await h.type('data-path', DATA);
    v = h.view();
    ok(!v.offered && v.models === DATA + '/models', 'typing that data folder in: likewise', JSON.stringify(v));
  }

  console.log('B. a data folder that is a model collection');
  {
    let h = harness(file);
    await h.open(DATA, DATA + '/models');
    await h.type('data-path', HOME + '/Collection');
    let v = h.view();
    eq(v.offered, true, '3 at its top and 1 a folder down: offered');
    eq(v.label, 'Use this folder for models (4 found)', 'counting the GGUFs the model menu would, not the projector or a hidden folder');
    ok(v.use && v.models === HOME + '/Collection', 'pre-selected: the models folder is the data folder', JSON.stringify(v));

    await h.type('data-path', HOME + '/Sorted');
    v = h.view();
    ok(v.offered && v.label === 'Use this folder for models (2 found)', 'models sorted into subfolders, none at the top: offered', JSON.stringify(v));

    await h.type('data-path', HOME + '/Mixed');
    v = h.view();
    ok(v.offered && v.label === 'Use this folder for models (3 found)',
       'one at the top and two in its own models subfolder: offered, all three counted', JSON.stringify(v));

    await h.type('data-path', HOME + '/New');
    v = h.view();
    ok(!v.offered && v.models === HOME + '/New/models', 'a folder that does not exist yet: nothing offered, models follow it', JSON.stringify(v));
    eq(v.note, 'This folder will be created.', 'and the note says it will be made');
  }

  console.log('C. the models folder\'s note');
  {
    const h = harness(file);
    await h.open(DATA, DATA + '/models');
    await h.type('model-path', HOME + '/Two');
    eq(h.view().note, '2 GGUF models found here. They will be in the model menu.', 'two models: "They"');
    await h.type('model-path', HOME + '/Collection');
    eq(h.view().note, '3 GGUF models found here. They will be in the model menu. 1 more in its subfolders will be under Add a Model › Found on this computer.',
       'models at the top and one a folder down');
    await h.type('data-path', DATA);
    eq(h.view().models, HOME + '/Collection', 'a typed models folder is not overwritten by a later data folder');
  }
}

const same = fs.readFileSync(ROOT + '/' + WIZARDS[0], 'utf8') === fs.readFileSync(ROOT + '/' + WIZARDS[1], 'utf8');
ok(same, 'the ZIP copy of the wizard is identical');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
