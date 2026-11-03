/**
 * 1.7.9 F1 -- mods, the page half (js/19-extensions.js), run for real against
 * a fake DOM and a fake server:
 *
 *   A. two mods load in order; switching one off leaves the other, and a
 *      script already loaded is not run a second time
 *   B. the old extensions blob moves to the server once, keeping its switch;
 *      a device that is not the PC keeps running it here, as 1.7.8 did;
 *      a file:// page never asks the server
 *   C. the panel: switches, read-only on a phone, SAVE writes My extensions,
 *      Remove offers UNDO
 *   D. /state no longer carries code
 *   E. endorsed mods (F6): nothing fetched until BROWSE; INSTALL, UPDATE and
 *      INSTALLED; 18+ covered until confirmed, remembered on this device;
 *      a phone can look, not install; a refused install says why
 *   F. a mod file that is missing or throws while loading switches its mod
 *      off and says so; a URL entry that fails does not; ?nomods loads none
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const EXT = read('js/19-extensions.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(), tag, children: [], attrs: {}, style: {}, dataset: {}, _text: '', disabled: false, checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { (on === undefined ? !this._s.has(c) : on) ? this._s.add(c) : this._s.delete(c); } },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this.classList._s].join(' '); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get innerHTML() { return this._html || ''; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return el;
}

function world({ mods = [], canManage = true, served = true, importStatus = 200, legacy = null, list = null, search = '', storage = {} } = {}) {
  const head = makeEl('head');
  const els = {};
  for (const id of ['ext-modal', 'mods-list', 'mods-where', 'mods-note', 'ext-enabled', 'ext-toggle-label', 'ext-save-btn', 'ext-clear-btn',
                    'ext-styles-list', 'ext-scripts-list', 'ext-status-dot', 'ext-status-list',
                    'endorsed-list', 'endorsed-note', 'endorsed-browse-btn', 'endorsed-refresh-btn']) els[id] = makeEl('div');
  const body = makeEl('body');
  const winListeners = [];
  const calls = [];
  const server = { mods: JSON.parse(JSON.stringify(mods)), canManage, myExt: { styles: [], scripts: [] }, list, installStatus: 200 };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    IS_SERVED: served,
    state: { extensions: legacy || { enabled: false, styles: [], scripts: [] } },
    saves: 0,
    window: { addEventListener: (type, fn) => winListeners.push({ type, fn }) },
    location: { search }, URLSearchParams,
    localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } },
    document: {
      head, body,
      getElementById: id => els[id] || body.children.find(c => c.id === id) || null,
      createElement: makeEl,
      querySelectorAll: (sel) => {
        let l = head.children.filter(e => e.classList.contains('gobbonet-ext'));
        const m = sel.match(/\[data-ext-key\^="([^"]+)"\]/);
        if (m) l = l.filter(e => (e.getAttribute('data-ext-key') || '').startsWith(m[1]));
        return l;
      },
    },
    confirm: () => true,
    commitPendingUndo() {},
    renderExtStatusList() {}, renderMacroList() {}, updateExtStatusLabel() {}, generateId: () => 'g' + Math.random(),
    escapeHtml: s => String(s), escapeJsAttr: s => String(s),
    undoable: (o) => { ctx.lastUndo = o; },
    fetch: async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
      if (url === '/mods' && method === 'GET') return reply(200, { mods: server.mods, canManage: server.canManage, dir: '/data/mods' });
      if (url.startsWith('/mod-list.json')) return reply(200, server.list);
      if (url === '/mod-list/install') {
        if (!server.canManage) return reply(403, { error: 'PC only' });
        if (server.installStatus !== 200) return reply(server.installStatus, { error: 'checksum mismatch: Neon’s file neon.css does not match the checksum the endorsed list pins for it, so nothing was installed' });
        const id = JSON.parse(opts.body).id, e = server.list.mods.find(x => x.id === id);
        const updated = e.state === 'update';
        e.state = 'installed'; e.installed = e.version;
        if (!updated) server.mods.push({ id, name: e.name, enabled: true, hash: 'e', origin: 'endorsed', files: [{ path: id + '.js', type: 'js' }] });
        return reply(200, { id, version: e.version, updated, enabled: updated ? server.mods.find(x => x.id === id).enabled : true });
      }
      if (url === '/mods/import-legacy') return reply(importStatus, importStatus === 200 ? { id: 'my-extensions', created: true } : { error: 'not on the PC' });
      let m = url.match(/^\/mods\/([^/]+)\/enable$/);
      if (m) { const b = JSON.parse(opts.body); if (b.enabled && !server.canManage) return reply(403, { error: 'PC only' }); server.mods.find(x => x.id === m[1]).enabled = b.enabled; return reply(200, {}); }
      if (url === '/mods/my-extensions/source' && method === 'GET') return reply(200, server.myExt);
      if (url === '/mods/my-extensions/source' && method === 'PUT') { if (!server.canManage) return reply(403, { error: 'PC only' }); server.myExt = JSON.parse(opts.body); return reply(200, { saved: true }); }
      m = url.match(/^\/mods\/([^/]+)$/);
      if (m && method === 'DELETE') { server.removed = server.mods.find(x => x.id === m[1]); server.mods = server.mods.filter(x => x.id !== m[1]); return reply(200, {}); }
      m = url.match(/^\/mods\/([^/]+)\/restore$/);
      if (m) { server.mods.push(server.removed); return reply(200, {}); }
      return reply(404, {});
    },
  };
  ctx.saveState = () => { ctx.saves++; };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(EXT + '\n;this._modsRef = () => _mods; this._draftRef = () => _extDraft;', ctx);
  const loaded = () => head.children.filter(e => e.classList.contains('gobbonet-ext')).map(e => (e.href || e.src || '(inline)').replace(/\?v=.*/, '') + (e.textContent ? ':' + e.textContent : ''));
  // The browser's error event for a script, as window.onerror sees it.
  const fireError = (filename, message) => winListeners.filter(l => l.type === 'error').forEach(l => l.fn({ filename, message }));
  return { ctx, head, els, calls, server, loaded, storage, body, fireError };
}

const MODS = [
  { id: 'theme', name: 'Theme', enabled: true, hash: 'h1', files: [{ path: 'theme.css', type: 'css' }, { path: 'img/logo.png', type: 'asset' }] },
  { id: 'tools', name: 'Tools', enabled: true, hash: 'h2', files: [{ path: 'a.js', type: 'js' }, { url: 'https://cdn.example/x.css', type: 'css', name: 'remote' }, { path: 'b/c.js', type: 'js' }] },
  { id: 'broken', name: 'Broken', enabled: false, error: 'mod.json is not valid JSON', files: [] },
];

console.log('\n=== A. two mods load in order; switching one leaves the other ===');
{
  const w = world({ mods: MODS });
  await w.ctx.applyMods();
  ok(JSON.stringify(w.loaded()) === JSON.stringify(['/mods/theme/files/theme.css', '/mods/tools/files/a.js', 'https://cdn.example/x.css', '/mods/tools/files/b/c.js']),
     'theme, then tools in its own listed order; an asset is served but not loaded', w.loaded());
  const scripts = w.head.children.filter(e => e.tag === 'script');
  ok(scripts.every(s => s.async === false), 'scripts are added with async=false, so they run in that order');
  ok(w.head.children.every(e => e.getAttribute('data-mod-id')), 'each element says which mod it belongs to');
  const firstScript = scripts[0];
  w.server.mods.find(m => m.id === 'theme').enabled = false;
  await w.ctx.applyMods();
  ok(JSON.stringify(w.loaded()) === JSON.stringify(['/mods/tools/files/a.js', 'https://cdn.example/x.css', '/mods/tools/files/b/c.js']),
     'switching theme off removes its stylesheet and nothing of tools', w.loaded());
  ok(w.head.children.includes(firstScript) && w.head.children.filter(e => e.tag === 'script').length === 2,
     'and tools’ scripts are the same elements: nothing ran twice');
  ok(w.els['ext-status-dot'].textContent.includes('●'), 'the MODS dot is lit while any mod is on');
}

console.log('\n=== B. the old extensions move once ===');
{
  const legacy = { enabled: true, styles: [{ id: 's', name: 'Theme', url: '', raw: 'body{color:red}' }], scripts: [{ id: 'j', name: '', url: 'https://e.example/a.js', raw: '' }] };
  const w = world({ legacy });
  await w.ctx.applyMods();
  const post = w.calls.find(c => c.url === '/mods/import-legacy');
  ok(post && post.body.enabled === true && post.body.styles[0].raw === 'body{color:red}' && post.body.scripts[0].url === 'https://e.example/a.js',
     'the blob is sent with its switch and every entry', post && post.body);
  ok(w.ctx.state.extensions.styles.length === 0 && w.ctx.state.extensions.enabled === false && w.ctx.saves === 1,
     'then this browser’s copy is emptied and saved: the code now lives in the mod');
  await w.ctx.applyMods();
  ok(w.calls.filter(c => c.url === '/mods/import-legacy').length === 1, 'and it is only sent once');
}
{
  const legacy = { enabled: true, styles: [{ id: 's', name: 'Theme', url: '', raw: 'p{}' }], scripts: [] };
  const w = world({ legacy, importStatus: 403, canManage: false });
  await w.ctx.applyMods();
  ok(w.ctx.state.extensions.styles.length === 1 && w.ctx._modsRef().legacyHere === true, 'on a phone the server refuses, and the blob is kept');
  ok(w.loaded().includes('(inline):p{}'), 'and it keeps running here, as in 1.7.8');
}
{
  const legacy = { enabled: true, styles: [{ id: 's', name: '', url: '', raw: 'p{}' }], scripts: [] };
  const w = world({ legacy, served: false });
  await w.ctx.applyMods();
  ok(w.calls.length === 0 && w.loaded().includes('(inline):p{}'), 'a file:// page asks no server and runs the blob as before');
}

console.log('\n=== C. the panel ===');
{
  const w = world({ mods: MODS });
  await w.ctx.loadMods();
  w.ctx.renderModList();
  const rows = w.els['mods-list'].children.filter(r => r.classList.contains('mod-row'));
  ok(rows.length === 3, 'one row per mod, broken ones included');
  ok(rows[2].children[0].disabled && /Cannot load/.test(rows[2].textContent), 'a broken mod says why and cannot be switched on');
  ok(rows[0].children.length === 3 && rows[0].children[2].children.map(b => b.textContent).join(',') === '↑,↓,Remove', 'on the PC: up, down and Remove');
  ok(rows[0].children[2].children[0].disabled && rows[2].children[2].children[1].disabled, 'the first cannot go up, the last cannot go down');
  ok(/Drop a folder with a mod\.json/.test(w.els['mods-where'].textContent), 'and it says where mods live');

  await w.ctx.removeMod('tools', 'Tools');
  ok(w.calls.some(c => c.url === '/mods/tools' && c.method === 'DELETE') && /Removed mod "Tools"/.test(w.ctx.lastUndo.label), 'Remove asks the server, then offers UNDO');
  await w.ctx.lastUndo.undo();
  ok(w.calls.some(c => c.url === '/mods/tools/restore') && w.ctx._modsRef().list.some(m => m.id === 'tools'), 'UNDO puts it back');
}
{
  const w = world({ mods: MODS, canManage: false });
  await w.ctx.loadMods();
  w.ctx.renderModList();
  const rows = w.els['mods-list'].children.filter(r => r.classList.contains('mod-row'));
  ok(rows.every(r => r.children.length === 2), 'on a phone there are no up, down or Remove buttons');
  ok(!rows[0].children[0].disabled && rows[2].children[0].disabled, 'an ON mod can be switched off; an off one cannot be switched on');
  ok(/managed from GobboNet on the PC/.test(w.els['mods-where'].textContent), 'and it says where to manage them');
  w.ctx.applyExtEditLock();
  ok(w.els['ext-save-btn'].disabled && w.els['ext-modal'].classList.contains('mods-readonly'), 'My extensions is read-only there');
  await w.ctx.setModEnabled('theme', false);
  ok(w.calls.some(c => c.url === '/mods/theme/enable' && c.body.enabled === false), 'switching off goes to the server');
}
{
  const w = world({ mods: [{ id: 'my-extensions', name: 'My extensions', enabled: false, hash: 'h', files: [] }] });
  await w.ctx.loadMods();
  w.ctx.openExtensions();
  w.ctx._draftRef().styles.push({ id: 'n', name: 'New', url: '', raw: 'a{}' });
  w.els['ext-enabled'].checked = true;
  w.ctx.closeExtensions = () => { w.closed = true; };
  const saved = await w.ctx.saveExtensions();
  const put = w.calls.find(c => c.method === 'PUT');
  ok(saved && put && put.url === '/mods/my-extensions/source' && put.body.enabled === true && put.body.styles[0].raw === 'a{}' && !('id' in put.body.styles[0]),
     'SAVE writes My extensions on the server, with its switch', put && put.body);
  ok(w.ctx.state.extensions.styles.length === 0, 'and nothing goes into the synced state');
}

console.log('\n=== D. /state carries no code ===');
{
  const sync = read('js/06-state-sync.js');
  const fn = sync.slice(sync.indexOf('function redactedStateMeta()'), sync.indexOf('function redactedStateMeta()') + 900);
  ok(/if \(meta\) meta\.extensions = \{ enabled: false, styles: \[\], scripts: \[\] \};/.test(fn), 'the meta sent to the server always has an empty extensions list');
  const html = read('chat.html');
  ok(/<div id="mods-list"><\/div>/.test(html) && html.indexOf('id="mods-section"') < html.indexOf('id="ext-enabled"'), 'YOUR MODS sits above My extensions in the panel');
}

console.log('\n=== E. endorsed mods ===');
const LIST = () => ({ canManage: true, source: 'remote', notes: [], mods: [
  { id: 'neon', name: 'Neon', version: '1.1', author: 'Elodine', state: 'update', installed: '1.0', homepage: 'https://goblincorps.com/gobbonet_extras' },
  { id: 'clock', name: 'Clock', version: '2', state: 'new' },
  { id: 'spicy', name: 'Spicy', version: '1', state: 'new', adult: true },
  { id: 'theirs', name: 'Theirs', version: '1', state: 'taken' },
  { id: 'later', name: 'Later', version: '1', state: 'problem', problem: 'needs GobboNet 1.8.0 or newer' },
]});
const erows = w => w.els['endorsed-list'].children.filter(r => r.classList.contains('endorsed-row'));
const ebtn = r => r.children[1].children[0];
{
  const w = world({ mods: [{ id: 'neon', name: 'Neon', enabled: false, hash: 'n', origin: 'endorsed', files: [] }], list: LIST() });
  await w.ctx.loadMods();
  w.ctx.openExtensions();
  ok(!w.calls.some(c => c.url.startsWith('/mod-list')), 'opening the MODS panel fetches nothing from the endorsed list');
  await w.ctx.browseEndorsedMods(false);
  ok(w.calls.filter(c => c.url === '/mod-list.json').length === 1, 'BROWSE asks GobboNet for the list');
  ok(w.els['endorsed-browse-btn'].style.display === 'none' && w.els['endorsed-refresh-btn'].style.display === '', 'and then becomes REFRESH');
  const rows = erows(w);
  ok(rows.map(r => r.getAttribute('data-endorsed-id')).join(',') === 'neon,clock,theirs,later', 'the 18+ mod is not shown', rows.map(r => r.getAttribute('data-endorsed-id')));
  ok(/1 mod is marked 18\+ and hidden/.test(w.els['endorsed-list'].textContent), 'and the list says one is hidden, and why');
  ok(ebtn(rows[0]).textContent === 'UPDATE' && /you have v1\.0/.test(rows[0].textContent) && !ebtn(rows[0]).disabled, 'an older install is offered an UPDATE');
  ok(ebtn(rows[1]).textContent === 'INSTALL' && !ebtn(rows[1]).disabled, 'a new one, INSTALL');
  ok(ebtn(rows[2]).disabled && /already in your mods folder/.test(rows[2].textContent), 'a hand-made folder of the same name is left alone, and it says so');
  ok(ebtn(rows[3]).disabled && /needs GobboNet 1\.8\.0/.test(rows[3].textContent), 'a mod for a newer GobboNet says what it needs');

  const cover = w.els['endorsed-list'].children.find(c => c.classList.contains('endorsed-adult-cover'));
  cover.children[1].onclick();
  ok(w.storage['gobbonet.mods.adultOk'] === '1' && erows(w).some(r => r.getAttribute('data-endorsed-id') === 'spicy'),
     'I AM 18 OR OLDER shows it, and is remembered on this device');
  ok(/18\+/.test(erows(w).find(r => r.getAttribute('data-endorsed-id') === 'spicy').textContent), 'with an 18+ badge');

  await w.ctx.installEndorsedMod('clock', ebtn(erows(w)[1]));
  ok(w.calls.some(c => c.url === '/mod-list/install' && c.body.id === 'clock'), 'INSTALL asks the server to install it');
  ok(/Installed Clock v2 and switched it on/.test(w.els['endorsed-note'].textContent), 'and says it is installed and on', w.els['endorsed-note'].textContent);
  ok(w.loaded().includes('/mods/clock/files/clock.js'), 'its file is loaded straight away');
  ok(ebtn(erows(w).find(r => r.getAttribute('data-endorsed-id') === 'clock')).textContent === 'INSTALLED', 'and the list now says INSTALLED');

  await w.ctx.installEndorsedMod('neon');
  ok(/Updated Neon to v1\.1; it is still off, as you had it/.test(w.els['endorsed-note'].textContent), 'an update keeps the user’s off switch, and says so', w.els['endorsed-note'].textContent);
  w.server.installStatus = 502;
  w.server.list.mods[1].state = 'update';
  await w.ctx.installEndorsedMod('clock');
  ok(/does not match the checksum.*nothing was installed/.test(w.els['endorsed-note'].textContent) && w.els['endorsed-note'].classList.contains('mods-note-error'),
     'a refused install says why, in one line');
}
{
  const w = world({ list: Object.assign(LIST(), { canManage: false }), canManage: false, storage: { 'gobbonet.mods.adultOk': '1' } });
  await w.ctx.browseEndorsedMods(false);
  ok(erows(w).length === 5, 'a device that confirmed 18+ before sees every mod');
  ok(erows(w).every(r => ebtn(r).disabled) && /installed from GobboNet on the PC/.test(w.els['endorsed-list'].textContent),
     'on a phone every button is off, and it says where to install');
}
{
  const w = world({ list: { off: true, notes: ['The endorsed list is switched off: mod_list_url is empty in config.toml.'], mods: [] } });
  await w.ctx.browseEndorsedMods(false);
  ok(/mod_list_url is empty/.test(w.els['endorsed-list'].textContent), 'a list switched off in config.toml says how it was switched off');
}
{
  const w = world({ list: { canManage: true, source: 'cache', notes: ['showing the list as it was on 3 Oct 2026'], mods: [{ id: 'a', name: 'A', version: '1', state: 'new' }] } });
  await w.ctx.browseEndorsedMods(true);
  ok(w.calls.some(c => c.url === '/mod-list.json?refresh=1'), 'REFRESH asks for a fresh copy');
  ok(/could not be reached just now; this is the list as it was on 3 Oct 2026/.test(w.els['endorsed-list'].textContent), 'a saved copy says it is one, and from when');
}
{
  const w = world({ served: false });
  await w.ctx.browseEndorsedMods(false);
  ok(w.calls.length === 0 && /opened as a file/.test(w.els['endorsed-note'].textContent), 'a file:// page explains instead of asking');
}

console.log('\n=== F. a mod that fails is switched off ===');
{
  const two = [
    { id: 'good', name: 'Good', enabled: true, hash: 'g', files: [{ path: 'g.js', type: 'js' }] },
    { id: 'bad', name: 'Bad', enabled: true, hash: 'b', files: [{ path: 'b.css', type: 'css' }, { path: 'b.js', type: 'js' }] },
    { id: 'net', name: 'Net', enabled: true, hash: 'n', files: [{ url: 'https://cdn.example/n.js', type: 'js' }] },
  ];
  const w = world({ mods: two });
  await w.ctx.applyMods();
  const script = id => w.head.children.find(e => e.tag === 'script' && e.getAttribute('data-mod-id') === id);
  // The browser gives absolute URLs; in this fake the src is as set.
  w.fireError(script('bad').src, 'TypeError: x is undefined');
  await new Promise(r => setTimeout(r, 0));
  ok(w.calls.some(c => c.url === '/mods/bad/enable' && c.body.enabled === false), 'a mod whose script throws while loading is switched off on the server');
  ok(!w.head.children.some(e => e.getAttribute('data-mod-id') === 'bad') && script('good'), 'its files leave the page; the other mod’s stay');
  const notice = w.body.children.find(c => c.id === 'mod-notice');
  ok(notice && notice.getAttribute('role') === 'alert' && /“Bad” was switched off: it stopped with an error while loading \(TypeError: x is undefined\)/.test(notice.textContent),
     'a notice says which mod and why', notice && notice.textContent);
  ok(notice.children[1].children.map(b => b.textContent).join(',') === 'OPEN MODS,SWITCH BACK ON,DISMISS', 'with OPEN MODS, SWITCH BACK ON and DISMISS');

  script('good').onload();
  w.fireError(script('good').src, 'later error from a click handler');
  await new Promise(r => setTimeout(r, 0));
  ok(!w.calls.some(c => c.url === '/mods/good/enable'), 'an error after a script has loaded (its event handlers) switches nothing off');

  script('net').onerror();
  await new Promise(r => setTimeout(r, 0));
  ok(!w.calls.some(c => c.url === '/mods/net/enable'), 'a URL entry that cannot be fetched (the network) leaves its switch alone');
}
{
  const w = world({ mods: [{ id: 'gone', name: 'Gone', enabled: true, hash: 'x', files: [{ path: 'gone.js', type: 'js' }] }] });
  await w.ctx.applyMods();
  w.head.children.find(e => e.tag === 'script').onerror();
  await new Promise(r => setTimeout(r, 0));
  ok(w.calls.some(c => c.url === '/mods/gone/enable' && c.body.enabled === false) &&
     /could not be loaded/.test(w.body.children.find(c => c.id === 'mod-notice').textContent), 'a mod file that cannot be loaded switches its mod off too');
}
{
  const w = world({ mods: [{ id: 'theme', name: 'Theme', enabled: true, hash: 'h1', files: [{ path: 'theme.css', type: 'css' }] }], search: '?nomods' });
  await w.ctx.applyMods();
  ok(w.loaded().length === 0 && w.calls.some(c => c.url === '/mods'), '?nomods in the address loads no mods, and the panel still lists them');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
