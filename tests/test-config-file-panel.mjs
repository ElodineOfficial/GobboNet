/**
 * CONFIG > Config File: config.toml edited from the chat page.
 *
 * The server side (internal/server/configfile.go, internal/config/editfile.go)
 * has its own Go tests: this PC only, secrets hidden, every save checked,
 * conflicts refused, a backup kept. This covers the panel in js/15-cards.js,
 * run for real against a stub page and a stub server:
 *
 *   A. Where it sits, and what it is made of.
 *   B. Opening: the file in use, or why it cannot be edited from here.
 *   C. Saving: what changed, what was refused (and on which line), conflicts.
 *   D. UNDO LAST SAVE, RELOAD, and closing CONFIG with unsaved edits.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const HTML = read('chat.html');
const CARDS = read('js/15-cards.js');
const SERVER = read('internal/server/server.go');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 600) : '')); }
};
const between = (src, from, to, file) => {
  const a = src.indexOf(from), b = to ? src.indexOf(to, a + 1) : src.length;
  if (a < 0 || b < 0) { console.error(`could not locate ${JSON.stringify(from)} in ${file}`); process.exit(1); }
  return src.slice(a, b);
};

/* ================================================================ A */
console.log('\n=== A. the box ===');
// 1.7.9 (F3): the box is the last one in CONFIG's Advanced section, so it
// runs up to Privacy Status, which stays last.
const box = between(HTML, 'id="config-file-group"', '&#128274; Privacy Status', 'chat.html');
{
  const modal = between(HTML, 'id="settings-modal"', '<!-- MODEL CATALOGUE MODAL', 'chat.html');
  ok(modal.includes('id="config-file-group"'), 'CONFIG has a Config File box');
  ok(HTML.indexOf('id="network-hosts-group"') < HTML.indexOf('id="config-file-group"'), 'after Network access, the other server setting');
  const adv = between(HTML, 'id="cfg-advanced"', '</details>', 'chat.html');
  ok(adv.includes('id="config-file-group"'), 'in the Advanced section (1.7.9): a file editor is a power-user tool');
  ok(/<textarea id="config-file-text"[^>]*spellcheck="false"[^>]*wrap="off"/.test(box), 'a plain-text editor: no spellcheck, no wrapping');
  for (const [id, label] of [['config-file-save', 'SAVE TO CONFIG.TOML'], ['config-file-reload', 'RELOAD'], ['config-file-undo', 'UNDO LAST SAVE']]) {
    ok(new RegExp(`id="${id}"[^>]*>${label}<`).test(box), `${label}`);
  }
  ok(/id="config-file-status" role="status" aria-live="polite"/.test(box), 'results are announced');
  ok(/aria-describedby="tip-config-file"/.test(box) && /only in a browser on the PC GobboNet runs on/.test(box) && /gobbonet set-password/.test(box),
     'its "?" explains the checks, the backup, the hidden secrets and the this-PC rule');
  ok(/case path == "\/config\/file" \|\| path == "\/config\/file\/restore":/.test(SERVER), 'the server answers /config/file, behind the password');
  ok(SERVER.indexOf('/config/file"') > SERVER.indexOf('--- Auth gate'), 'after the sign-in check');
}

/* A page with just this box, and a server to answer it. */
function el(id) {
  const e = { id, value: '', textContent: '', disabled: false, style: { display: '' }, dataset: {}, children: [],
    selectionStart: 0, selectionEnd: 0, scrollTop: 0,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
                 toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    appendChild(c) { this.children.push(c); this.textContent += c.textContent; return c; },
    focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  Object.defineProperty(e, 'innerHTML', { set() { throw new Error('innerHTML used on #' + id); } });
  return e;
}
function page(responses) {
  const ids = ['config-file-path', 'config-file-open', 'config-file-editor', 'config-file-text', 'config-file-notes',
               'config-file-save', 'config-file-reload', 'config-file-undo', 'config-file-status', 'settings-modal'];
  const els = Object.fromEntries(ids.map(id => [id, el(id)]));
  const calls = [];
  const c = {
    console, JSON, Math, Object, Array, String, Number, RegExp, Promise, Error, parseInt, parseFloat,
    IS_SERVED: true, window: { location: { origin: 'http://127.0.0.1:9066' } },
    document: { getElementById: (id) => els[id] || null, createElement: (t) => el(t) },
    getComputedStyle: () => ({ lineHeight: '18px' }),
    confirmAnswer: true, confirms: [],
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      const key = (opts.method || 'GET') + ' ' + url.replace('http://127.0.0.1:9066', '');
      const r = (responses[key] || []).shift() || { status: 500, body: {} };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  c.confirm = (m) => { c.confirms.push(m); return c.confirmAnswer; };
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(between(CARDS, 'function closeSettings()', 'function saveSettings()', 'js/15-cards.js')
    + between(CARDS, 'const _cfgFile = ', null, 'js/15-cards.js'), c);
  c.els = els; c.calls = calls;
  return c;
}
const FILE = '# comments\nlisten_port = 9066\naccess_secret = "(hidden)"  # the password hash\nsession_ttl_hours = 12\n';
const view = (extra = {}) => ({ status: 200, body: { editable: true, path: '/home/me/.config/gobbonet/config.toml', text: FILE,
                                                     version: 'v1', hidden: ['access_secret'], has_backup: false, ...extra } });
const tick = () => new Promise(r => setTimeout(r, 0));

/* ================================================================ B */
console.log('\n=== B. opening ===');
{
  const c = page({ 'GET /config/file': [view({ path: '/x/<img src=x onerror=alert(1)>/config.toml' })] });
  await c.loadConfigFilePanel();
  ok(c.els['config-file-path'].textContent === 'In use: /x/<img src=x onerror=alert(1)>/config.toml', 'names the file in use, as text (a path cannot inject markup)');
  ok(c.els['config-file-open'].style.display === '' && c.els['config-file-editor'].style.display === 'none', 'OPEN EDITOR, editor still closed');
  c.openConfigFileEditor();
  ok(c.els['config-file-text'].value === FILE && c.els['config-file-editor'].style.display === '', 'OPEN EDITOR shows the file');
  ok(c.els['config-file-undo'].disabled === true, 'UNDO LAST SAVE is off until there is a save to undo');

  const away = page({ 'GET /config/file': [{ status: 200, body: { editable: false, reason: 'config.toml can only be opened from the PC GobboNet runs on, at http://127.0.0.1:9066.' } }] });
  await away.loadConfigFilePanel();
  ok(/only be opened from the PC/.test(away.els['config-file-path'].textContent) && away.els['config-file-open'].style.display === 'none',
     'elsewhere: says where to open it, and offers no editor');
  const out = page({ 'GET /config/file': [{ status: 401, body: {} }] });
  await out.loadConfigFilePanel();
  ok(/Sign in again/.test(out.els['config-file-path'].textContent), 'signed out: says to sign in again');
  const file = page({});
  file.IS_SERVED = false; vm.runInContext('IS_SERVED = false', file);
  await file.loadConfigFilePanel();
  ok(/Opened from a file/.test(file.els['config-file-path'].textContent) && file.calls.length === 0, 'opened as a file: says so, asks nothing');
  const notes = page({ 'GET /config/file': [view({ env_overrides: ['GOBBONET_LISTEN_PORT'], perf_overrides: true })] });
  await notes.loadConfigFilePanel();
  const n = notes.els['config-file-notes'];
  ok(/GOBBONET_LISTEN_PORT/.test(n.textContent) && /CONFIG > Performance/.test(n.textContent) && n.style.display === '',
     'says when the environment or CONFIG > Performance overrides the file');
}

/* ================================================================ C */
console.log('\n=== C. saving ===');
{
  const saved = FILE.replace('12', '6');
  const c = page({
    'GET /config/file': [view(), view({ text: saved, version: 'v2', has_backup: true })],
    'POST /config/file': [
      { status: 400, body: { error: 'Not saved: toml: line 2 (last key "listen_port"): expected value' } },
      { status: 200, body: { ok: true, changed: ['session_ttl_hours'], warnings: ['future_thing'], version: 'v2', has_backup: true } },
    ],
  });
  await c.loadConfigFilePanel(); c.openConfigFileEditor();
  const ta = c.els['config-file-text'];
  ta.value = FILE.replace('listen_port = 9066', 'listen_port = =');
  c.updateConfigFileDirty();
  ok(ta.classList.contains('dirty') && c.isConfigFileDirty() && c.els['config-file-status'].textContent === 'Unsaved changes.', 'an edit is marked unsaved');
  await c.saveConfigFile();
  ok(c.calls.at(-1).body.version === 'v1' && c.calls.at(-1).body.text === ta.value, 'SAVE sends the text and the version it was opened at');
  ok(c.els['config-file-status'].dataset.tone === 'err' && /^Not saved: .*line 2/.test(c.els['config-file-status'].textContent), 'refused: the reason, as the server gave it');
  ok(ta.value.slice(ta.selectionStart, ta.selectionEnd) === 'listen_port = =', 'and the cursor is put on line 2');
  ok(ta.value.includes('listen_port = ='), 'the edit stays in the box to fix');

  ta.value = saved;
  await c.saveConfigFile();
  const st = c.els['config-file-status'];
  ok(st.dataset.tone === 'ok' && /^Saved: session_ttl_hours\. Restart GobboNet to use it/.test(st.textContent), 'saved: what changed, and that it applies on restart', st.textContent);
  ok(/does not know future_thing/.test(st.textContent), 'a key this version ignores is mentioned');
  ok(ta.value === saved && !c.isConfigFileDirty() && c.els['config-file-undo'].disabled === false, 'the box reloads from the server, clean, with UNDO available');

  const conflict = page({ 'GET /config/file': [view()], 'POST /config/file': [{ status: 409, body: { error: 'config.toml changed since you opened it.' } }] });
  await conflict.loadConfigFilePanel(); conflict.openConfigFileEditor();
  conflict.els['config-file-text'].value = 'mine';
  await conflict.saveConfigFile();
  ok(/changed since you opened it/.test(conflict.els['config-file-status'].textContent) && conflict.els['config-file-text'].value === 'mine',
     'changed elsewhere: refused, and the edit is kept');
}

/* ================================================================ D */
console.log('\n=== D. undo, reload, closing ===');
{
  const c = page({
    'GET /config/file': [view({ has_backup: true }), view({ version: 'v3' }), view({ version: 'v4' })],
    'POST /config/file/restore': [{ status: 200, body: { ok: true, changed: ['session_ttl_hours'], version: 'v3', restored: true } }],
  });
  await c.loadConfigFilePanel(); c.openConfigFileEditor();
  c.confirmAnswer = false;
  await c.undoConfigFileSave();
  ok(c.confirms.length === 1 && !c.calls.some(x => x.url.endsWith('/restore')), 'UNDO asks first, and does nothing if you say no');
  c.confirmAnswer = true;
  await c.undoConfigFileSave();
  const r = c.calls.find(x => x.url.endsWith('/restore'));
  ok(r && r.method === 'POST' && r.body.version === 'v1', 'then puts the previous version back, at the version on screen');
  ok(/^Put back the previous version: session_ttl_hours\./.test(c.els['config-file-status'].textContent), 'and says what changed');

  c.els['config-file-text'].value = 'edited'; c.confirmAnswer = false;
  await c.reloadConfigFile();
  ok(c.els['config-file-text'].value === 'edited', 'RELOAD with unsaved edits asks, and keeps them if you say no');
  c.confirmAnswer = true;
  await c.reloadConfigFile();
  ok(c.els['config-file-text'].value === FILE, 'and loads the file again if you say yes');

  // Closing CONFIG.
  const m = c.els['settings-modal'];
  m.classList.add('open');
  c.applyAvatarScale = () => {};
  c.els['config-file-text'].value = 'edited again'; c.confirmAnswer = false;
  ok(c.closeSettings() === false && m.classList.contains('open'), 'closing CONFIG with unsaved edits asks, and stays open if you say no');
  c.confirmAnswer = true;
  c.closeSettings();
  ok(!m.classList.contains('open'), 'and closes if you say yes');
  c.els['config-file-text'].value = c.els['config-file-text'].value; m.classList.add('open');
  const asked = c.confirms.length;
  vm.runInContext('_cfgFile.open = false', c);
  c.closeSettings();
  ok(c.confirms.length === asked && !m.classList.contains('open'), 'with the editor closed, CONFIG closes without asking');

  ok(/loadNetworkHostsPanel\(\);\s+loadConfigFilePanel\(\);/.test(CARDS), 'opening CONFIG loads the panel');
  ok(!/config-file/.test(between(CARDS, 'function saveSettings()', '\n}\n', 'js/15-cards.js')), "CONFIG's SAVE never writes config.toml");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
