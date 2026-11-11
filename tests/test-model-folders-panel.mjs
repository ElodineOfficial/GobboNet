/**
 * CONFIG > Model & Performance > Model Folders (1.8.0, issue #68).
 *
 * model_dir, model_dirs and scan_hf_cache, which only the Config File editor
 * could change before. Read and written through /model-folders
 * (internal/server/modelfolders.go), from the PC GobboNet runs on only, and
 * saved for the next start on its own button.
 *
 *   A. Loading: the fields show what config.toml says; another device, an
 *      older server, a page opened from a file or a failed read hides the
 *      fields and says why.
 *   B. Saving: one folder per line becomes a list; the server's answer is what
 *      is shown; a refused save keeps what was typed and shows the reason.
 *   C. The markup: in Model & Performance under Add a Model, opened with CONFIG.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const from = SRC.indexOf('function _modelFoldersStatus(');
const to = SRC.indexOf('/* ================================================================\n   PHONE & OTHER DEVICES PANEL');
if (from < 0 || to < from) { console.error('could not find the Model Folders panel in js/15-cards.js'); process.exit(1); }
const BLOCK = SRC.slice(from, to);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); }
};

const SAVED = { editable: true, model_dir: '/home/me/My Models', model_dirs: ['/mnt/lm studio', '~/other'], scan_hf_cache: true, restart_needed: false };

function build({ served = true, get = { status: 200, body: SAVED }, post = null, throws = false } = {}) {
  const els = {
    'model-folders-fields': { style: { display: '' } },
    'set-model-dir': { value: '' },
    'set-model-dirs': { value: '' },
    'set-scan-hf-cache': { checked: false },
    'model-folders-save': { disabled: false },
    'model-folders-status': { textContent: '', dataset: {} },
  };
  const calls = [];
  const ctx = {
    IS_SERVED: served,
    window: { location: { origin: 'http://127.0.0.1:9066' } },
    document: { getElementById: id => els[id] || null },
    JSON, console,
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (throws) throw new Error('offline');
      const r = (opts.method === 'POST') ? post : get;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, calls };
}
const status = t => t.els['model-folders-status'].textContent;
const hidden = t => t.els['model-folders-fields'].style.display === 'none';

console.log('\n=== A. loading ===');
{
  const t = build();
  await t.ctx.loadModelFoldersPanel();
  ok(!hidden(t) && t.els['set-model-dir'].value === '/home/me/My Models', 'the models folder, from config.toml');
  ok(t.els['set-model-dirs'].value === '/mnt/lm studio\n~/other', 'extra folders one per line, a space kept in a name', t.els['set-model-dirs'].value);
  ok(t.els['set-scan-hf-cache'].checked === true, 'the HuggingFace cache box');
  ok(t.calls.length === 1 && t.calls[0].url === 'http://127.0.0.1:9066/model-folders', 'read from /model-folders', t.calls);
  ok(status(t) === '', 'nothing pending: no message');
}
{
  const t = build({ get: { status: 200, body: { ...SAVED, restart_needed: true, env_override: 'GOBBONET_MODEL_DIR' } } });
  await t.ctx.loadModelFoldersPanel();
  ok(/take effect when GobboNet restarts/.test(status(t)) && /GOBBONET_MODEL_DIR is set/.test(status(t)),
     'a saved change not yet in use, and an environment variable that wins, are both said', status(t));
}
{
  const t = build({ get: { status: 200, body: { editable: false, model_dirs: [], reason: 'The model folders can only be changed from the PC GobboNet runs on, at http://127.0.0.1:9066.' } } });
  t.els['set-model-dir'].value = 'stale';
  await t.ctx.loadModelFoldersPanel();
  ok(hidden(t) && /only be changed from the PC/.test(status(t)), 'another device: the fields are hidden, and it says where to change them', status(t));
}
{
  const t = build({ get: { status: 404, body: {} } });
  await t.ctx.loadModelFoldersPanel();
  ok(hidden(t) && /arrived in 1\.8\.0/.test(status(t)), 'an older server: hidden, and says the box is new in 1.8.0');
}
{
  const t = build({ served: false });
  await t.ctx.loadModelFoldersPanel();
  ok(hidden(t) && t.calls.length === 0, 'opened from a file: hidden, and nothing is fetched');
}
{
  const t = build({ throws: true });
  await t.ctx.loadModelFoldersPanel();
  ok(hidden(t) && /Could not reach/.test(status(t)), 'unreachable: hidden, and says so');
}

console.log('\n=== B. saving ===');
{
  const t = build({ post: { status: 200, body: { ...SAVED, model_dir: '/data/models', model_dirs: ['/a b'], scan_hf_cache: false, restart_needed: true, saved: true } } });
  t.els['set-model-dir'].value = ' /data/models ';
  t.els['set-model-dirs'].value = '/a b\r\n\n   \n';
  t.els['set-scan-hf-cache'].checked = false;
  await t.ctx.saveModelFolders();
  const p = t.calls.find(c => c.method === 'POST');
  ok(p && p.url.endsWith('/model-folders'), 'SAVE FOR NEXT START posts to /model-folders', t.calls);
  ok(p && p.body === JSON.stringify({ model_dir: ' /data/models ', model_dirs: ['/a b'], scan_hf_cache: false }),
     'one folder per line, blank lines dropped, spaces inside a name kept', p && p.body);
  ok(t.els['model-folders-status'].dataset.tone === 'ok' && /^Saved to config\.toml\. Saved changes take effect when GobboNet restarts\.$/.test(status(t)),
     'says it is saved, for the next start', status(t));
  ok(t.els['set-model-dir'].value === '/data/models', 'the fields show what the server saved');
  ok(t.els['model-folders-save'].disabled === false, 'the button is usable again');
}
{
  const t = build({ post: { status: 200, body: { ...SAVED, saved: false } } });
  await t.ctx.saveModelFolders();
  ok(/^Nothing changed\.$/.test(status(t)) && !t.els['model-folders-status'].dataset.tone, 'an unchanged save says so', status(t));
}
{
  const t = build({ post: { status: 400, body: { error: 'Give the models folder as a full path, such as /home/you/models.' } } });
  t.els['set-model-dir'].value = 'models';
  await t.ctx.saveModelFolders();
  ok(t.els['set-model-dir'].value === 'models' && t.els['model-folders-status'].dataset.tone === 'err' && /full path/.test(status(t)),
     "a refused save keeps what was typed and shows the server's reason", status(t));
  ok(t.els['model-folders-save'].disabled === false, 'and the button is usable again');
}
{
  const t = build({ throws: true });
  await t.ctx.saveModelFolders();
  ok(/Could not reach/.test(status(t)) && t.els['model-folders-save'].disabled === false, 'an unreachable server says so');
}

console.log('\n=== C. the markup ===');
{
  const model = HTML.slice(HTML.indexOf('data-cfg-section="model"'), HTML.indexOf('data-cfg-section="network"'));
  const group = model.slice(model.indexOf('id="model-folders-group"'));
  ok(model.includes('id="model-folders-group"') && model.indexOf('id="add-model-block"') < model.indexOf('id="model-folders-group"'),
     'the box is in Model & Performance, under Add a Model');
  ok(/<label for="set-model-dir">Models folder<\/label>\s*<input type="text" id="set-model-dir"/.test(group), 'a labelled models folder field');
  ok(/<label for="set-model-dirs"[^>]*>Extra folders to look in, one per line<\/label>\s*<textarea id="set-model-dirs"/.test(group), 'a labelled extra folders box');
  ok(/<input type="checkbox" id="set-scan-hf-cache">\s*<span>Also look in the HuggingFace cache<\/span>/.test(group), 'the HuggingFace cache box');
  ok(/id="model-folders-save" type="button" onclick="saveModelFolders\(\)">SAVE FOR NEXT START</.test(group), 'saved on its own button, for the next start');
  ok(group.includes('aria-describedby="tip-model-folders"') && group.includes('id="tip-model-folders" hidden') &&
     /model_dir.*model_dirs.*scan_hf_cache/.test(group.slice(0, group.indexOf('id="model-folders-fields"'))), 'a "?" note naming the config.toml keys');
  ok(group.includes('id="model-folders-status" aria-live="polite"'), 'a status line read out when it changes');
  const opener = SRC.slice(SRC.indexOf('loadStandDownPanel();'), SRC.indexOf('loadStandDownPanel();') + 200);
  ok(opener.includes('loadModelFoldersPanel();'), 'opening CONFIG loads it');
}

console.log('\n=== D. PURGE ALL leaves the models folder alone ===');
{
  // The models folder can now be a collection the user had before GobboNet,
  // so a factory reset must not reach it. PURGE ALL is the page's own data;
  // the server has no route that deletes a file in model_dir at all.
  const DATA = fs.readFileSync(ROOT + '/js/21-data.js', 'utf8');
  const start = DATA.indexOf('async function purgeData(type) {');
  const purge = DATA.slice(start, DATA.indexOf('\n}\n', start));
  ok(start > 0 && !/fetch\(|\/models|model-folders|local-models/.test(purge), 'purgeData makes no server call, to models or anything else');
  const removals = [];
  for (const f of fs.readdirSync(ROOT + '/internal/server')) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const text = fs.readFileSync(ROOT + '/internal/server/' + f, 'utf8');
    for (const m of text.matchAll(/os\.Remove(All)?\(([^)]*)\)/g)) removals.push(f + ': ' + m[0]);
  }
  ok(removals.length === 1 && removals[0] === 'modelfolders.go: os.Remove(name)',
     "the server deletes no file but Model Folders' own write test", removals);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
