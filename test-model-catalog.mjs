/**
 * Item 3 — add models from inside GobboNet, client side.
 *
 * Runs the REAL catalogue functions out of js/02-model.js against a stubbed
 * DOM and a mock fetch. Nothing here touches the network.
 *
 * What is worth checking, in order:
 *   1. Nothing the server sends reaches the DOM as markup. models.ini is
 *      ours, but it is editable on disk and this is the last hop before the
 *      page — the same boundary loadModelsList() already treats as hostile.
 *   2. The client sends an INDEX and never a URL or a filename, so a
 *      compromised page cannot name what to fetch or where to write it.
 *   3. The states the user actually lands in: a download already running,
 *      a failure, an already-installed model, file:// with no server.
 */
import fs from 'fs';
import vm from 'vm';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const MODEL_JS = fs.readFileSync(ROOT + '/js/02-model.js', 'utf8');

// Just the catalogue section — the rest of the file reaches for globals that
// belong to modules loaded around it.
const block = MODEL_JS.slice(
  MODEL_JS.indexOf('/* ================================================================\n   MODEL CATALOGUE')
);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  \u2713 ' + l); } else { fail++; console.log('  \u2717 ' + l); } };
const eq = (a, b, l) => ok(a === b, l + (a === b ? '' : `\n      got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`));

/* --- a DOM small enough to reason about ---------------------------------- */

function makeEl(id) {
  const el = {
    id,
    _text: '',
    _html: '',
    children: [],
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    // A real element keeps className and classList in sync; the stub has to
    // as well, or code that sets one and is read through the other passes or
    // fails for the wrong reason.
    set className(v) {
      this._class = String(v);
      this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    get className() { return this._class || ''; },
    set textContent(v) { this._text = String(v); this.children = []; this._html = ''; },
    get textContent() {
      if (this.children.length) return this.children.map(c => c.textContent).join('');
      return this._text;
    },
    set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) {
      const tag = sel.toLowerCase();
      const hit = (n) => n.tag === tag || (n.children || []).some(hit);
      for (const c of this.children) { if (c.tag === tag) return c; }
      for (const c of this.children) { const r = c.querySelector && c.querySelector(sel); if (r) return r; }
      return null;
    },
  };
  return el;
}

function makeDom() {
  const els = {};
  const get = (id) => (els[id] || (els[id] = makeEl(id)));
  // Every id the catalogue code reaches for.
  [
    'model-catalog-modal', 'model-catalog-list', 'model-catalog-free',
    'model-catalog-progress', 'model-catalog-dl-title', 'model-catalog-bar',
    'model-catalog-log', 'model-catalog-note', 'model-catalog-swap-row', 'add-model-block',
    'add-model-unavailable',
  ].forEach(get);
  return {
    els,
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => { const e = makeEl(null); e.tag = tag; return e; },
    },
  };
}

/* --- harness -------------------------------------------------------------- */

function run(name, { catalogBody, downloadPost, downloadGet, isServed = true }, body) {
  console.log('\n' + name);
  const dom = makeDom();
  const calls = [];

  const fetchMock = async (url, opts) => {
    calls.push({ url, opts });
    const reply = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
    });
    // Matched on the path so the refresh query string is the client's business
    // rather than something every test has to restate.
    if (url.split('?')[0] === '/catalog.json') {
      return reply(catalogBody.status || 200, catalogBody.body);
    }
    if (url === '/model-download' && opts && opts.method === 'POST') {
      return reply(downloadPost.status || 200, downloadPost.body);
    }
    if (url === '/model-download') return reply(200, downloadGet ? downloadGet() : { state: 'idle' });
    return reply(404, {});
  };

  const ctx = {
    console: { error() {}, log() {} },
    document: dom.document,
    fetch: fetchMock,
    IS_SERVED: isServed,
    setInterval: () => 1,
    clearInterval: () => {},
    loadModelsList: () => {},
    swapToModelFile: async () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // MODEL_CATALOG_ENABLED is a top-level `let`, so it lives in the script's
  // lexical scope rather than on the context object. Expose a setter so the
  // suite can drive both sides of the temporary hold.
  vm.runInContext(block +
    '\nglobalThis.__setCatalogEnabled = (v) => { MODEL_CATALOG_ENABLED = v; };', ctx);

  return body({ ctx, els: dom.els, calls });
}

const CATALOG = {
  body: {
    models: [
      { index: 1, display: 'Big Model', file: 'big.gguf', sizeGB: 16, minVRAM: 16, ctx: 16384, installed: false },
      { index: 2, display: 'Small Model', file: 'small.gguf', sizeGB: 3.4, minVRAM: 4, ctx: 32768, installed: true },
    ],
    default: 2,
    freeGB: 120.5,
  },
};

const tick = () => new Promise(r => setTimeout(r, 0));

/* --- 1. no markup reaches the DOM ---------------------------------------- */

await run('Catalogue values are inserted as text, never markup', {
  catalogBody: {
    body: {
      models: [{
        index: 1,
        display: '<img src=x onerror=alert(1)>',
        file: 'x.gguf', sizeGB: 1, minVRAM: 4, ctx: 4096, installed: false,
      }],
      default: 1, freeGB: 10,
    },
  },
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  const list = els['model-catalog-list'];
  eq(list.innerHTML, '', 'nothing was assigned to innerHTML');
  const name = list.children[0].children[0];
  eq(name.textContent, '<img src=x onerror=alert(1)>',
     'a hostile display name survives as literal text');
  ok(list.children[0].children.every(c => c.innerHTML === ''),
     'no child of the row used innerHTML either');
});

/* --- 2. the wire carries an index, nothing else --------------------------- */

await run('Starting a download sends only an index', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: true, status: { state: 'running', display: 'Big Model' } } },
  downloadGet: () => ({ state: 'running', display: 'Big Model', percent: 12, done: 2e9, total: 1.6e10 }),
}, async ({ ctx, calls }) => {
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  const post = calls.find(c => c.opts && c.opts.method === 'POST');
  ok(!!post, 'a POST was made');
  const sent = JSON.parse(post.opts.body);
  eq(Object.keys(sent).join(','), 'index', 'the body carries an index and nothing else');
  eq(sent.index, 1, 'the index is the one clicked');
  ok(!post.opts.body.includes('huggingface') && !post.opts.body.includes('.gguf'),
     'no URL and no filename crosses the wire');
});

/* --- 3. an installed model is not offered again --------------------------- */

await run('An installed model is marked and cannot be re-downloaded', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  const rows = els['model-catalog-list'].children;
  const installedRow = rows[1];
  ok(installedRow.classList.contains('installed'), 'the row is flagged installed');
  const btn = installedRow.children[2];
  ok(btn.disabled === true, 'its button is disabled');
  eq(btn.textContent, 'ALREADY INSTALLED', 'and says so');
  ok(rows[0].children[2].disabled !== true, 'the uninstalled model is still offered');
});

/* --- 4. a download already running is adopted, not duplicated ------------- */

await run('A download already in flight is reported, not restarted', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: false, status: { state: 'running', display: 'Small Model' } } },
  downloadGet: () => ({ state: 'running', display: 'Small Model', percent: 40, done: 4e9, total: 1e10 }),
}, async ({ ctx, els }) => {
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  eq(els['model-catalog-dl-title'].textContent, 'Downloading Small Model',
     'the UI follows the download that is really running');
  ok(els['model-catalog-note'].textContent.includes('Only one download runs at a time'),
     'and says why the click did not start one');
  eq(els['model-catalog-note'].style.display, '', 'the note is visible');
  // The note has to outlive a poll tick, or the user never reads it.
  await ctx.pollModelDownload();
  await tick();
  ok(els['model-catalog-note'].textContent.includes('Only one download runs at a time'),
     'and the explanation survives the next poll tick');
});

/* --- 5. failure is reported, and does not offer a swap -------------------- */

await run('A failed download reports the message and offers no swap', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: true, status: { state: 'running' } } },
  downloadGet: () => ({
    state: 'error',
    message: 'Checksum mismatch \u2014 the file is corrupt or was tampered with, so it has been deleted.',
  }),
}, async ({ ctx, els }) => {
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  await ctx.pollModelDownload();
  await tick();
  eq(els['model-catalog-dl-title'].textContent, 'Download failed', 'the title says it failed');
  ok(els['model-catalog-log'].textContent.includes('Checksum mismatch'),
     "the server's own message is shown verbatim");
  eq(els['model-catalog-swap-row'].style.display, 'none',
     'no swap is offered for a model that never landed');
});

/* --- 6. success offers the swap rather than taking it --------------------- */

await run('A finished download offers the swap instead of forcing it', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: true, status: { state: 'running' } } },
  downloadGet: () => ({ state: 'done', message: 'Downloaded and checksum verified.', done: 1.6e10 }),
}, async ({ ctx, els }) => {
  let swapped = false;
  ctx.swapToModelFile = async () => { swapped = true; };
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  await ctx.pollModelDownload();
  await tick();
  eq(els['model-catalog-dl-title'].textContent, 'Downloaded', 'the title reports success');
  ok(swapped === false, 'the model was NOT switched automatically');
  eq(els['model-catalog-swap-row'].style.display, '', 'the swap is offered');
  await ctx.swapToDownloadedModel();
  await tick();
  ok(swapped === true, 'and happens only when the user asks');
});

/* --- 6b. provenance is stated ------------------------------------------- */

await run('A bundled fallback says so instead of looking live', {
  catalogBody: { body: Object.assign({}, CATALOG.body, { source: 'bundled' }) },
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  ok(els['model-catalog-free'].textContent.includes('shipped with GobboNet'),
     'the user is told this is the shipped list');
});

await run('A live catalogue does not claim to be a fallback', {
  catalogBody: { body: Object.assign({}, CATALOG.body, { source: 'remote' }) },
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  ok(!els['model-catalog-free'].textContent.includes('shipped with GobboNet'),
     'no fallback notice on the live list');
  ok(els['model-catalog-free'].textContent.includes('GB free'),
     'free space is still reported');
});

/* --- 7. an unreachable catalogue says so ---------------------------------- */

await run('A 503 from the catalogue is explained, not blank', {
  catalogBody: { status: 503, body: { error: 'The model catalogue is not available.' } },
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  ok(els['model-catalog-list'].textContent.includes('not available'),
     "the server's reason is shown");
});

/* --- 8. file:// has no server to download with ---------------------------- */

await run('file:// hides the button and explains why', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: false,
}, async ({ ctx, els }) => {
  ctx.__setCatalogEnabled(true);   // isolate the file:// behaviour from the hold
  const block = els['add-model-block'];
  const btn = { tag: 'button', style: {} };
  block.children.push(btn);
  ctx.applyModelCatalogAvailability();
  eq(btn.style.display, 'none', 'the button is hidden');
  eq(els['add-model-unavailable'].style.display, '', 'an explanation is shown');
  ok(els['add-model-unavailable'].textContent.includes('needs the GobboNet server'),
     'and it says what is missing');
});

await run('served mode, hold flag ON: the button works normally', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: true,
}, async ({ ctx, els }) => {
  ctx.__setCatalogEnabled(true);
  const block = els['add-model-block'];
  const btn = { tag: 'button', style: {} };
  block.children.push(btn);
  ctx.applyModelCatalogAvailability();
  ok(btn.style.display !== 'none', 'the button stays visible');
  ok(!btn.disabled, 'and is clickable');
  eq(btn.textContent, 'BROWSE CATALOGUE', 'with its normal label');
  // Asserts the note is not SHOWN, rather than that it was not TOUCHED.
  ok(els['add-model-unavailable'].style.display !== '', 'no explanation is shown');

  // The reason the early return went: it made the function one-way. Left
  // over state has to survive a second call, or the panel can only ever
  // get worse as it is reopened -- and that is also what makes the hold
  // below safe to lift.
  els['add-model-unavailable'].style.display = '';
  els['add-model-unavailable'].textContent = 'stale message from somewhere else';
  btn.style.display = 'none';
  btn.disabled = true;
  ctx.applyModelCatalogAvailability();
  ok(btn.style.display !== 'none', 'a second call restores the button');
  ok(!btn.disabled, 'and re-enables it');
  ok(els['add-model-unavailable'].style.display !== '', 'and clears the stale note');
});

/* --- the temporary hold -------------------------------------------------- */
/* The download path is known-bugged and gated off pending a fix patch. What
   is worth proving is not the wording but the shape: the user is told, the
   control cannot be operated, and lifting the hold needs nothing but the
   flag. */

await run('hold flag OFF: the button says it is not working', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: true,
}, async ({ ctx, els }) => {
  ctx.__setCatalogEnabled(false);
  const block = els['add-model-block'];
  const btn = { tag: 'button', style: {} };
  block.children.push(btn);
  ctx.applyModelCatalogAvailability();
  ok(btn.disabled === true, 'the button is disabled');
  ok(btn.style.display !== 'none', 'but still visible, so the feature is not a mystery');
  ok(/not working/i.test(btn.textContent), 'and the button itself says so');
  eq(els['add-model-unavailable'].style.display, '', 'an explanation is shown');
  ok(els['add-model-unavailable'].textContent.includes('later patch'),
     'it says a fix is coming rather than blaming the user');
  ok(els['add-model-unavailable'].textContent.includes('models folder'),
     'and gives the manual way in meanwhile');
});

await run('hold flag OFF beats file://: our fault is reported as ours', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: false,
}, async ({ ctx, els }) => {
  ctx.__setCatalogEnabled(false);
  const block = els['add-model-block'];
  const btn = { tag: 'button', style: {} };
  block.children.push(btn);
  ctx.applyModelCatalogAvailability();
  ok(!els['add-model-unavailable'].textContent.includes('needs the GobboNet server'),
     'it does not send the user hunting for a server problem');
  ok(/not working/i.test(btn.textContent), 'it reports the real reason');
});

await run('hold flag OFF: the modal cannot be opened anyway', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: true,
}, async ({ ctx, els, calls }) => {
  ctx.__setCatalogEnabled(false);
  const before = calls.length;
  ctx.openModelCatalog();
  ok(!els['model-catalog-modal'].classList.contains('open'), 'the modal stays shut');
  eq(calls.length, before, 'and nothing was fetched');
});

/* --- the bug-hunt fixes --------------------------------------------------- */

/* The list was resolved once per process and then memoised, so a user who
   opened this offline and reconnected a minute later kept getting the bundled
   list until GobboNet was restarted. Opening the modal now says "go and look". */
await run('Opening the catalogue asks the server to look again', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
}, async ({ ctx, calls }) => {
  await ctx.loadModelCatalog();
  await tick();
  const get = calls.find(c => c.url.startsWith('/catalog.json'));
  ok(!!get, 'the catalogue was requested');
  ok(get.url.includes('refresh=1'), 'the request asks for a fresh resolution');
});

/* "The model catalogue is not available." is not something a user can act on.
   The notes name the step that failed. */
await run('A 503 lists why each source failed, not just that one did', {
  catalogBody: {
    status: 503,
    body: {
      error: 'The model catalogue is not available.',
      detail: 'no catalogue available: the remote fetch did not succeed',
      notes: [
        'could not reach the catalogue: dial tcp: lookup goblincorps.com: no such host',
        'using the model list that shipped with GobboNet',
      ],
    },
  },
  downloadPost: { body: {} },
}, async ({ ctx, els }) => {
  await ctx.loadModelCatalog();
  await tick();
  const shown = els['model-catalog-list'].textContent;
  ok(shown.includes('not available'), 'the headline is shown');
  ok(shown.includes('no such host'), 'the reason the fetch failed is shown');
  ok(shown.includes('shipped with GobboNet'), 'every note is shown, not just the first');
  eq(els['model-catalog-list'].innerHTML, '', 'the notes went in as text, not markup');
});

/* A server-side download that has already finished used to be reported for the
   life of the process, so every later open of the modal reacted to a transfer
   from a session the user had left -- writing into a hidden panel and starting
   a second catalogue load that raced the first. */
await run('Opening on a finished download does not redraw or reveal anything', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  downloadGet: () => ({ state: 'done', display: 'Big Model', message: 'Downloaded.' }),
}, async ({ ctx, els, calls }) => {
  await ctx.pollModelDownload({ silent: true });
  await tick();
  eq(els['model-catalog-progress'].style.display, undefined, 'the progress panel stays hidden');
  eq(els['model-catalog-dl-title'].textContent, '', 'no stale title is written');
  ok(!calls.some(c => c.url.startsWith('/catalog.json')),
     'no second catalogue load was kicked off');
});

await run('A download still running IS picked up on open', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  downloadGet: () => ({ state: 'running', display: 'Big Model', percent: 40, done: 6e9, total: 1.6e10 }),
}, async ({ ctx, els }) => {
  await ctx.pollModelDownload({ silent: true });
  await tick();
  eq(els['model-catalog-progress'].style.display, '', 'the progress panel is revealed');
  ok(els['model-catalog-dl-title'].textContent.includes('Big Model'),
     'and it names what is downloading');
});

await run('Closing the modal lets the server forget a finished download', {
  catalogBody: CATALOG,
  downloadPost: { body: { cleared: true } },
}, async ({ ctx, calls }) => {
  ctx.closeModelCatalog();
  await tick();
  const post = calls.find(c => c.opts && c.opts.method === 'POST');
  ok(!!post, 'a POST was made on close');
  eq(JSON.parse(post.opts.body).clear, true, 'it asks to clear');
  ok(!('index' in JSON.parse(post.opts.body)), 'and starts nothing');
});

await run('file:// closes without talking to a server that is not there', {
  catalogBody: CATALOG,
  downloadPost: { body: {} },
  isServed: false,
}, async ({ ctx, calls }) => {
  ctx.closeModelCatalog();
  await tick();
  eq(calls.length, 0, 'no request was attempted');
});

/* The download used to succeed and leave the user guessing where the file
   went. Both branches have to say. */
await run('A finished download says where the file is and how to reach it', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: true, status: { state: 'running', display: 'Big Model' } } },
  downloadGet: () => ({ state: 'done', display: 'Big Model', message: 'Downloaded and checksum verified.' }),
}, async ({ ctx, els }) => {
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  const note = els['model-catalog-note'].textContent;
  ok(note.includes('models folder'), 'it says where the file went');
  ok(note.includes('dropdown'), 'it says where to find it');
  ok(/restart/i.test(note), 'and that a restart also picks it up');
  eq(els['model-catalog-swap-row'].style.display, '', 'the swap is still offered');
});

await run('A failed swap says the download itself was fine', {
  catalogBody: CATALOG,
  downloadPost: { body: { started: true, status: { state: 'running', display: 'Big Model' } } },
  downloadGet: () => ({ state: 'done', display: 'Big Model', message: 'Downloaded.' }),
}, async ({ ctx, els }) => {
  await ctx.startModelDownload(1, 'Big Model', 'big.gguf');
  await tick();
  ctx.swapToModelFile = async () => { throw new Error('llama-server did not come back'); };
  await ctx.swapToDownloadedModel();
  await tick();
  ok(els['model-catalog-log'].textContent.includes('llama-server did not come back'),
     'the real reason is shown');
  const note = els['model-catalog-note'].textContent;
  ok(note.includes('downloaded fine'), 'the download is not blamed for the swap');
  ok(/restart/i.test(note), 'and restarting is offered as the way through');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
