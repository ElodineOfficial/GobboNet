/**
 * The update button (1.8.0): ABOUT > THIS BUILD > CHECK FOR UPDATES.
 *
 * The server decides what is safe to install (internal/update, with its Go
 * tests); the page asks the question and shows the answer. Held here:
 *
 *   A. Where it is, and that nothing asks for a check on its own.
 *   B. Each answer from /update/check, shown as what it means.
 *   C. The question before anything is downloaded, and what a yes sends.
 *   D. The install's progress, the restart, and the wait for the new program.
 *   E. Nothing a release says is read as markup, and only https is opened.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const HTML = read('chat.html');
const SRC = read('js/28-update.js');
const SCHED = read('js/22-scheduler.js');
const JS_FILES = fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js'));

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 500) : '')); }
};
const eq = (a, b, l) => ok(a === b, l, a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* A fake page: the ids the module uses, buttons it makes, fetch and confirm. */
function makeEl(tag) {
  const el = {
    tagName: tag, textContent: '', hidden: false, className: '', title: '', type: '', disabled: false,
    style: {}, children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    click() { if (this.listeners.click) return this.listeners.click(); },
  };
  return el;
}
function world(routes, opts = {}) {
  const els = {};
  ['about-update', 'about-update-line', 'about-update-notes', 'about-update-bar-wrap', 'about-update-bar',
   'about-update-actions', 'about-update-btn'].forEach(id => { els[id] = makeEl('div'); });
  els['about-update'].hidden = true;
  const calls = [], opened = [], asked = [];
  let reloaded = 0;
  const ctx = {
    console, JSON, Math, Date, Promise, String, Array, Error, setInterval: () => 1, clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    window: { location: { origin: 'http://localhost:9066' } },
    location: { reload() { reloaded++; } },
    document: { getElementById: id => els[id] || null, createElement: makeEl },
    confirm: (q) => { asked.push(q); return opts.confirm !== false; },
    openAboutLink: (u) => opened.push(u),
    formatBytes: (n) => (n / (1024 * 1024)).toFixed(1) + ' MB',
    fetch: async (url, init) => {
      const path = url.replace('http://localhost:9066', '');
      calls.push({ path, init });
      const r = routes[path];
      const ans = typeof r === 'function' ? r(init) : r;
      if (!ans) return { ok: false, status: 404, json: async () => ({}) };
      if (ans.throws) throw new Error(ans.throws);
      return { ok: (ans.status || 200) < 300, status: ans.status || 200, json: async () => ans.body };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, els, calls, opened, asked, get reloaded() { return reloaded; } };
}
const buttons = (w) => w.els['about-update-actions'].children.map(b => b.textContent);
const line = (w) => w.els['about-update-line'].textContent;

const CURRENT = { version: '1.8.0', build: '1.8.0-go-aaaaaaa', serial: 1000 };
const OFFER = { version: '1.8.1', build: '1.8.1-go-bbbbbbb', serial: 2000, hotfix: false, size: 14 * 1024 * 1024,
  notes: 'Fixes and the update button.', notes_url: 'https://github.com/ElodineOfficial/gobbonet/releases/tag/v1.8.1',
  page_url: 'https://github.com/ElodineOfficial/gobbonet/releases/tag/v1.8.1', tag: 'v1.8.1', installable: true };
const check = (over) => ({ '/update/check': { body: Object.assign({ current: CURRENT, on_this_pc: true, notes: [], progress: { state: '' },
  releases_page: 'https://github.com/ElodineOfficial/gobbonet/releases' }, over) } });

/* ================================================================ A */
console.log('\n=== A. under THIS BUILD, and nothing checks on its own ===');
{
  const build = HTML.slice(HTML.indexOf('id="about-build"'), HTML.indexOf('PRIVATE BY DESIGN'));
  const rows = build.indexOf('id="about-version"');
  const btn = build.indexOf('id="about-update-btn"');
  ok(rows > 0 && btn > rows, 'CHECK FOR UPDATES is in THIS BUILD, underneath the build info');
  ok(/onclick="checkForUpdates\(this\)"/.test(build), 'pressing it checks');
  for (const id of ['about-update', 'about-update-line', 'about-update-notes', 'about-update-bar-wrap', 'about-update-actions', 'tip-update']) {
    ok(build.includes('id="' + id + '"'), '#' + id + ' is there');
  }
  ok(/<script src="js\/28-update.js"><\/script>/.test(HTML), 'js/28-update.js is loaded');
  const users = JS_FILES.filter(f => read('js/' + f).includes("'/update/check'"));
  eq(users.join(','), '28-update.js', 'only the update module names /update/check');
  const fnCheck = SRC.slice(SRC.indexOf('async function checkForUpdates'), SRC.indexOf('function renderUpdateCheck'));
  ok((SRC.match(/'\/update\/check'/g) || []).length === 1 && /'\/update\/check'/.test(fnCheck),
     'and only checkForUpdates asks for it, which only the button calls');
  const open = SCHED.slice(SCHED.indexOf('function openAbout()'), SCHED.indexOf('function closeAbout()'));
  ok(/refreshUpdateState\(\)/.test(open) && !/checkForUpdates/.test(open), 'opening ABOUT asks this server how an install is going, never GitHub');
  const refresh = SRC.slice(SRC.indexOf('async function refreshUpdateState'));
  ok(/\/update\/status/.test(refresh) && !/\/update\/check/.test(refresh), 'refreshUpdateState reads /update/status only');
  ok(!/github\.com/.test(SRC), 'no address is written into the page code; every link comes from the server');
}

/* ================================================================ B */
console.log('\n=== B. each answer, shown as what it means ===');
{
  let w = world(check({ status: 'available', offer: OFFER }));
  await w.ctx.checkForUpdates();
  ok(/GobboNet 1\.8\.1 is out \(you have 1\.8\.0\)/.test(line(w)), 'a newer release: what it is and what you have', line(w));
  ok(/14\.0 MB/.test(line(w)), 'and how big the download is', line(w));
  eq(buttons(w).join(','), 'UPDATE NOW,WHAT’S NEW', 'UPDATE NOW, and the release notes');
  eq(w.els['about-update-notes'].textContent, 'Fixes and the update button.', 'the release’s own short notes are shown');
  ok(!w.els['about-update'].hidden, 'the answer is visible');

  w = world(check({ status: 'available', offer: OFFER, on_this_pc: false }));
  await w.ctx.checkForUpdates();
  ok(!buttons(w).includes('UPDATE NOW'), 'from a phone there is no UPDATE NOW');
  ok(/installed from GobboNet on the PC/.test(line(w)), 'and it says where updates are installed', line(w));

  w = world(check({ status: 'available', offer: Object.assign({}, OFFER, { version: '1.8.0', build: '1.8.0-go-ccccccc', hotfix: true }) }));
  await w.ctx.checkForUpdates();
  ok(/A fix for GobboNet 1\.8\.0 is out: build 1\.8\.0-go-ccccccc \(you have 1\.8\.0-go-aaaaaaa\)/.test(line(w)),
     'a hotfix is named as a fix for the version you have, by build', line(w));

  w = world(check({ status: 'current' }));
  await w.ctx.checkForUpdates();
  ok(/You have the newest GobboNet \(1\.8\.0\)/.test(line(w)), 'up to date', line(w));
  eq(buttons(w).length, 0, 'with nothing to press');

  w = world(check({ status: 'current', notes: ['v9.9.9: the update file is not signed by a key this build trusts'] }));
  await w.ctx.checkForUpdates();
  ok(/not signed/.test(w.els['about-update-notes'].textContent), 'a release that was skipped, and why, is mentioned');

  w = world(check({ status: 'off' }));
  await w.ctx.checkForUpdates();
  ok(/switched off: update_releases_url is empty/.test(line(w)), 'switched off in config.toml', line(w));

  w = world(check({ status: 'dev', current: { version: 'dev', build: 'dev' } }));
  await w.ctx.checkForUpdates();
  ok(/development build/.test(line(w)), 'a dev build', line(w));

  w = world(check({ status: 'error', error: 'could not reach the release list: no route to host' }));
  await w.ctx.checkForUpdates();
  ok(/Couldn’t check for updates: could not reach the release list/.test(line(w)), 'an error, in the server’s words', line(w));
  eq(buttons(w).join(','), 'TRY AGAIN', 'with TRY AGAIN');

  w = world(check({ status: 'unverifiable', newest: { tag: 'v1.8.1', page_url: 'https://github.com/ElodineOfficial/gobbonet/releases/tag/v1.8.1' } }));
  await w.ctx.checkForUpdates();
  ok(/cannot install updates itself/.test(line(w)) && /v1\.8\.1/.test(line(w)), 'a build without the signing key says so, and names the newest release', line(w));
  eq(buttons(w).join(','), 'OPEN RELEASES PAGE', 'and points at the releases page instead of installing');
  w.els['about-update-actions'].children[0].click();
  eq(w.opened[0], 'https://github.com/ElodineOfficial/gobbonet/releases/tag/v1.8.1', 'which opens through openAboutLink');

  w = world(check({ status: 'manual', reason: 'This copy was installed from a .deb or .rpm package.', offer: Object.assign({}, OFFER, { installable: false }) }));
  await w.ctx.checkForUpdates();
  ok(/1\.8\.1 is out/.test(line(w)) && /\.deb or \.rpm/.test(line(w)), 'a package install: the release, and why it is not installed from here', line(w));
  ok(buttons(w).includes('OPEN RELEASE PAGE') && !buttons(w).includes('UPDATE NOW'), 'with the release page, not UPDATE NOW');

  w = world({});
  await w.ctx.checkForUpdates();
  ok(/older than 1\.8\.0/.test(line(w)), 'a server with no /update/check (an older one) is named as such', line(w));

  w = world({ '/update/check': { throws: 'Failed to fetch' } });
  await w.ctx.checkForUpdates();
  ok(/Couldn’t check for updates: Failed to fetch/.test(line(w)), 'no server at all');
  ok(w.els['about-update-btn'].disabled === false, 'and the button is pressable again');
}

/* ================================================================ C */
console.log('\n=== C. the question, and what a yes sends ===');
{
  const routes = Object.assign(check({ status: 'available', offer: OFFER }), {
    '/update/install': { status: 202, body: { state: 'downloading', done: 0, total: OFFER.size, build: OFFER.build } },
  });
  let w = world(routes, { confirm: false });
  await w.ctx.checkForUpdates();
  await w.ctx.installUpdate();
  eq(w.asked.length, 1, 'UPDATE NOW asks first');
  const q = w.asked[0] || '';
  ok(/^Update GobboNet from 1\.8\.0 to 1\.8\.1\?/.test(q), 'naming the version you have and the one you get', q);
  ok(/14\.0 MB from GitHub/.test(q) && /signature/.test(q), 'what is downloaded, from where, and that it is checked', q);
  ok(/1\.8\.0-go-aaaaaaa → 1\.8\.1-go-bbbbbbb/.test(q), 'the exact builds', q);
  ok(/chats, characters, models and settings are not touched/.test(q), 'what is left alone', q);
  ok(/restarts/.test(q) && /sign in again/.test(q), 'and what the restart means', q);
  ok(!w.calls.some(c => c.path === '/update/install'), 'a no installs nothing');

  w = world(routes);
  await w.ctx.checkForUpdates();
  await w.ctx.installUpdate();
  const post = w.calls.find(c => c.path === '/update/install');
  ok(!!post && post.init.method === 'POST', 'a yes POSTs /update/install');
  eq(post && post.init.body, JSON.stringify({ build: '1.8.1-go-bbbbbbb', serial: 2000 }), 'naming the build and serial that were offered, nothing else');
  ok(/Downloading 1\.8\.1-go-bbbbbbb/.test(line(w)), 'and shows the download starting', line(w));
  ok(!w.els['about-update-bar-wrap'].hidden, 'with the progress bar');

  w = world(Object.assign(check({ status: 'available', offer: Object.assign({}, OFFER, { version: '1.8.0', build: '1.8.0-go-ccccccc', hotfix: true }) }), routes['/update/install'] ? { '/update/install': routes['/update/install'] } : {}), { confirm: false });
  await w.ctx.checkForUpdates();
  await w.ctx.installUpdate();
  ok(/^Install the fix for GobboNet 1\.8\.0\?/.test(w.asked[0] || ''), 'a hotfix is asked about as a fix', w.asked[0]);
  ok(/replaces the gobbonet program file/.test(q), 'the ZIP or the Windows install: the program file is what is replaced', q);

  w = world(check({ status: 'available', offer: OFFER, install: { kind: 'appimage', target: 'appimage-amd64', can_install: true } }), { confirm: false });
  await w.ctx.checkForUpdates();
  await w.ctx.installUpdate();
  ok(/replaces the GobboNet AppImage \(1\.8\.0-go-aaaaaaa → 1\.8\.1-go-bbbbbbb\)/.test(w.asked[0] || ''),
     'an AppImage: the AppImage is what is replaced (1.8.0)', w.asked[0]);

  w = world(Object.assign(check({ status: 'available', offer: OFFER }), { '/update/install': { status: 409, body: { error: 'That update is no longer the one on offer.' } } }));
  await w.ctx.checkForUpdates();
  await w.ctx.installUpdate();
  ok(/did not start: That update is no longer the one on offer/.test(line(w)), 'a refusal is shown in the server’s words', line(w));
}

/* ================================================================ D */
console.log('\n=== D. progress, restart, and the wait for the new program ===');
{
  const w = world({});
  w.ctx._renderUpdateProgress({ state: 'downloading', done: 7 * 1024 * 1024, total: 14 * 1024 * 1024, build: '1.8.1-go-bbbbbbb' });
  ok(/7\.0 MB of 14\.0 MB/.test(line(w)), 'downloading: how much of how much', line(w));
  eq(w.els['about-update-bar'].style.width, '50%', 'and the bar halfway');
  w.ctx._renderUpdateProgress({ state: 'checking', done: 1, total: 1 });
  ok(/Checking the download/.test(line(w)), 'checking');
  w.ctx._renderUpdateProgress({ state: 'installed', build: '1.8.1-go-bbbbbbb', can_restart: true });
  ok(/1\.8\.1-go-bbbbbbb is installed/.test(line(w)), 'installed', line(w));
  eq(buttons(w).join(','), 'RESTART NOW', 'with RESTART NOW');
  w.ctx._renderUpdateProgress({ state: 'installed', build: '1.8.1-go-bbbbbbb', can_restart: false });
  eq(buttons(w).length, 0, 'no RESTART NOW when this server cannot restart itself');
  ok(/start it again/.test(w.els['about-update-notes'].textContent), 'it says to restart GobboNet by hand');
  w.ctx._renderUpdateProgress({ state: 'failed', error: 'the download does not match the signed update file' });
  ok(/not installed, and nothing was changed: the download does not match/.test(line(w)), 'a failure says nothing changed, and why', line(w));
  w.ctx._renderUpdateProgress({ state: 'failed', error: 'it was thrown away.' });
  ok(/thrown away\.$/.test(line(w)) && !/\.\.$/.test(line(w)), 'a message that ends in a full stop does not get a second one', line(w));
  eq(buttons(w).join(','), 'CHECK AGAIN', 'with CHECK AGAIN');

  // The wait: the old server answers with the old version, then the new one
  // answers 401 (sessions do not survive a restart) or with the new version.
  let n = 0;
  const seq = [{ body: { version: '1.8.0-go-aaaaaaa' } }, { throws: 'down' }, { status: 401, body: {} }];
  const w2 = world({ '/update/restart': { status: 202, body: { restarting: true } }, '/health-fileserver': () => seq[Math.min(n++, seq.length - 1)] });
  await w2.ctx.restartIntoUpdate('1.8.1-go-bbbbbbb');
  ok(w2.calls.some(c => c.path === '/update/restart' && c.init && c.init.method === 'POST'), 'RESTART NOW POSTs /update/restart');
  eq(w2.reloaded, 1, 'the page reloads once the new program answers (401: sign in again)');
  ok(n >= 3, 'not while the old one still answers with the old version');

  let m = 0;
  const seq2 = [{ body: { version: '1.8.0-go-aaaaaaa' } }, { body: { version: '1.8.1-go-bbbbbbb' } }];
  const w3 = world({ '/update/restart': { status: 202, body: {} }, '/health-fileserver': () => seq2[Math.min(m++, 1)] });
  await w3.ctx.restartIntoUpdate('1.8.1-go-bbbbbbb');
  eq(w3.reloaded, 1, 'or when it reports the new version (no password)');

  const w4 = world({ '/update/restart': { status: 409, body: { error: 'Close GobboNet and start it again to finish the update.' } } });
  await w4.ctx.restartIntoUpdate('1.8.1-go-bbbbbbb');
  ok(/could not restart itself/.test(line(w4)) && w4.reloaded === 0, 'a refused restart says what to do instead', line(w4));
}

/* ================================================================ E */
console.log('\n=== E. nothing from a release is markup, and only https opens ===');
{
  const evil = Object.assign({}, OFFER, { notes: '<img src=x onerror=alert(1)>', notes_url: 'javascript:alert(1)', page_url: 'http://example.com' });
  const w = world(check({ status: 'available', offer: evil }));
  await w.ctx.checkForUpdates();
  eq(w.els['about-update-notes'].textContent, '<img src=x onerror=alert(1)>', 'notes are text');
  ok(!/innerHTML/.test(SRC), 'the module never writes innerHTML');
  ok(!buttons(w).includes('WHAT’S NEW'), 'a javascript: or http: link is not offered at all');
  const long = Object.assign({}, OFFER, { notes: 'x'.repeat(5000) });
  const w2 = world(check({ status: 'available', offer: long }));
  await w2.ctx.checkForUpdates();
  ok(w2.els['about-update-notes'].textContent.length <= 601, 'long notes are clipped; the release page has the rest');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
