/**
 * CONFIG > Basics > When GobboNet Starts (1.8.0, roadmap #7, PR #58).
 *
 * open_browser lives in config.toml, because every launcher reads it there, so
 * the box reads and writes /launch-settings (internal/server/launchsettings.go)
 * rather than state.settings. It saves the moment it changes, like Idle
 * Stand-Down, and it must never show a state the server did not confirm.
 *
 *   A. Loading: the box shows what config.toml says; an older server, a page
 *      opened from a file, or a failed read disables it and says why.
 *   B. Saving: a change is POSTed as JSON and the box keeps the server's
 *      answer; a refused or failed save puts the box back.
 *   C. The markup: in Basics, with a one-line note and a "?", and opened with
 *      CONFIG.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const from = SRC.indexOf('function _openBrowserStatus(');
const to = SRC.indexOf('/* ================================================================\n   PHONE & OTHER DEVICES PANEL');
if (from < 0 || to < from) { console.error('could not find the When GobboNet Starts panel in js/15-cards.js'); process.exit(1); }
const BLOCK = SRC.slice(from, to);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); }
};

function build({ served = true, get = { status: 200, body: { open_browser: true } }, post = null, throws = false } = {}) {
  const els = {
    'set-open-browser': { checked: false, disabled: false },
    'open-browser-status': { textContent: '', dataset: {} },
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
      const r = (opts.method === 'POST') ? (post || { status: 200, body: JSON.parse(opts.body) }) : get;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, calls };
}

console.log('\n=== A. loading ===');
{
  const t = build({ get: { status: 200, body: { open_browser: true } } });
  await t.ctx.loadOpenBrowserPanel();
  ok(t.els['set-open-browser'].checked === true && !t.els['set-open-browser'].disabled, 'open_browser true: ticked and usable');
  ok(t.calls.length === 1 && t.calls[0].url === 'http://127.0.0.1:9066/launch-settings', 'read from /launch-settings', t.calls);
}
{
  const t = build({ get: { status: 200, body: { open_browser: false } } });
  t.els['set-open-browser'].checked = true;
  await t.ctx.loadOpenBrowserPanel();
  ok(t.els['set-open-browser'].checked === false, 'open_browser false: unticked');
}
{
  const t = build({ get: { status: 404, body: {} } });
  await t.ctx.loadOpenBrowserPanel();
  ok(t.els['set-open-browser'].disabled && /arrived in 1\.8\.0/.test(t.els['open-browser-status'].textContent),
     'an older server: disabled, and says the setting is new in 1.8.0', t.els['open-browser-status'].textContent);
}
{
  const t = build({ served: false });
  await t.ctx.loadOpenBrowserPanel();
  ok(t.els['set-open-browser'].disabled && t.calls.length === 0, 'opened from a file: disabled, and nothing is fetched');
}
{
  const t = build({ throws: true });
  await t.ctx.loadOpenBrowserPanel();
  ok(t.els['set-open-browser'].disabled && /Could not reach/.test(t.els['open-browser-status'].textContent), 'unreachable: disabled, and says so');
}

console.log('\n=== B. saving ===');
{
  const t = build();
  t.els['set-open-browser'].checked = false;
  await t.ctx.applyOpenBrowser(false);
  const p = t.calls.find(c => c.method === 'POST');
  ok(p && p.url.endsWith('/launch-settings') && p.body === '{"open_browser":false}', 'unticking POSTs {"open_browser":false}', t.calls);
  ok(t.els['set-open-browser'].checked === false && t.els['open-browser-status'].dataset.tone === 'ok' &&
     /without opening a browser/.test(t.els['open-browser-status'].textContent), 'and says what the next start will do', t.els['open-browser-status']);
}
{
  const t = build();
  t.els['set-open-browser'].checked = true;
  await t.ctx.applyOpenBrowser(true);
  ok(t.els['set-open-browser'].checked === true && /A browser tab opens/.test(t.els['open-browser-status'].textContent), 'ticking it back says the tab opens again');
}
{
  const t = build({ post: { status: 500, body: { error: 'config.toml could not be written, so the setting was not changed' } } });
  t.els['set-open-browser'].checked = false;
  await t.ctx.applyOpenBrowser(false);
  ok(t.els['set-open-browser'].checked === true && t.els['open-browser-status'].dataset.tone === 'err' &&
     /could not be written/.test(t.els['open-browser-status'].textContent), 'a refused save puts the box back and shows the server\'s reason', t.els);
}
{
  const t = build({ throws: true });
  t.els['set-open-browser'].checked = true;
  await t.ctx.applyOpenBrowser(true);
  ok(t.els['set-open-browser'].checked === false && /Could not reach/.test(t.els['open-browser-status'].textContent), 'an unreachable server puts the box back');
}
{
  const t = build({ post: { status: 200, body: { open_browser: true } } });
  t.els['set-open-browser'].checked = false;
  await t.ctx.applyOpenBrowser(false);
  ok(t.els['set-open-browser'].checked === true, 'the box shows what the server saved, not what was clicked');
}

console.log('\n=== C. the markup ===');
{
  const basics = HTML.slice(HTML.indexOf('data-cfg-section="basics"'), HTML.indexOf('data-cfg-section="chat"'));
  ok(basics.includes('id="open-browser-group"') && basics.includes('&#127760; When GobboNet Starts'), 'the box is in CONFIG > Basics');
  ok(/<input type="checkbox" id="set-open-browser" onchange="applyOpenBrowser\(this\.checked\)">/.test(basics), 'the checkbox saves on change, not on SAVE');
  ok(basics.includes('aria-describedby="tip-open-browser"') && basics.includes('id="tip-open-browser" hidden'), 'with a "?" note');
  ok(basics.includes('id="open-browser-status" aria-live="polite"'), 'and a status line read out when it changes');
  const opener = SRC.slice(SRC.indexOf('loadStandDownPanel();'), SRC.indexOf('loadStandDownPanel();') + 200);
  ok(opener.includes('loadOpenBrowserPanel();'), 'opening CONFIG loads it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
