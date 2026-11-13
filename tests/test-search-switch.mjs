/**
 * 1.8.0: the web search switch (🔍) belongs to this device.
 *
 * It used to ride in /state with everything else. Switching it on at the PC
 * switched it on for every phone and browser that opened GobboNet afterwards
 * (their boot adopts the server's state), so their messages went to the web
 * with nobody there having asked -- reproduced in two browsers on one server:
 * a phone with its own key that never touched 🔍 sent its message to
 * /search. When the switch arrived by a full sync while the page was open,
 * the button did not even change: js/06-state-sync.js set the variable and
 * not the button.
 *
 * Run for real: js/11-search.js against a fake page and localStorage, and
 * applyLoadedState / buildStateMeta out of js/05-persistence.js. Then the
 * places that used to read or write the shared copy.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const SEARCH = read('js/11-search.js');
let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };

function page(stored, { unreadable = false } = {}) {
  const store = {};
  if (stored !== undefined) store['gobbonet.webSearch'] = stored;
  const attrs = {}; const cls = new Set();
  const btn = {
    title: '', setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k],
    classList: { toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
  };
  let saves = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: k => { if (unreadable) throw new Error('blocked'); return k in store ? store[k] : null; },
                    setItem: (k, v) => { if (unreadable) throw new Error('blocked'); store[k] = String(v); } },
    document: { getElementById: id => (id === 'search-toggle' ? btn : null) },
    state: { searchEnabled: false, settings: {} },
    saveState: () => { saves++; },
  };
  vm.createContext(ctx);
  vm.runInContext(SEARCH + '\nthis.on = () => searchEnabled;', ctx);
  return { ctx, store, btn, attrs, saves: () => saves };
}

console.log('\n=== this device\'s switch ===');
{
  const p = page();
  p.ctx.showSearchSwitch();
  ok(p.ctx.on() === false && !p.btn.classList.contains('active') && p.attrs['aria-pressed'] === 'false',
     'a device that never switched it on: off, and the button says so');
  ok(/off on this device/.test(p.btn.title), 'its title says it is this device\'s', p.btn.title);
  p.ctx.toggleSearch();
  ok(p.ctx.on() === true && p.store['gobbonet.webSearch'] === 'on', 'switched on here: kept in this browser');
  ok(p.btn.classList.contains('active') && p.attrs['aria-pressed'] === 'true' && /ON on this device/.test(p.btn.title),
     'and the button shows it at once');
  ok(p.ctx.state.searchEnabled === false && p.saves() === 0, 'nothing is written to the shared state');
  p.ctx.toggleSearch();
  ok(p.ctx.on() === false && p.store['gobbonet.webSearch'] === 'off' && !p.btn.classList.contains('active'), 'and off again');
  const again = page('on');
  ok(again.ctx.on() === true, 'opened again in the same browser: still on');
  const broken = page('on', { unreadable: true });
  ok(broken.ctx.on() === false, 'storage that cannot be read: off, never on');
  broken.ctx.toggleSearch();
  ok(broken.ctx.on() === true && broken.btn.classList.contains('active'), 'and it can still be switched on for this page, which the button shows');
}

console.log('\n=== what another device says is ignored ===');
{
  const P = read('js/05-persistence.js');
  const load = P.slice(P.indexOf('function applyLoadedState(saved)'), P.indexOf('\nasync function loadState('));
  ok(!/saved\.searchEnabled/.test(load) && /state\.searchEnabled = false;/.test(load),
     'loading state (boot, sync, an older browser\'s copy) never takes the switch from it');
  const meta = P.slice(P.indexOf('function buildStateMeta()'), P.indexOf('\nfunction metaPartOf('));
  ok(/searchEnabled: false,/.test(meta) && !/searchEnabled: state\.searchEnabled/.test(meta),
     'what goes to the server says false, so a 1.8.0 device reading it turns its own off');
  const SYNC = read('js/06-state-sync.js');
  ok(!/searchEnabled\s*=\s*state\.searchEnabled/.test(SYNC) && /showSearchSwitch\(\)/.test(SYNC),
     'a full sync while the page is open leaves the switch alone, and the button still shows it');
  const BOOT = read('js/24-boot.js');
  ok(!/state\.searchEnabled/.test(BOOT) && /showSearchSwitch\(\);/.test(BOOT) && !/searchEnabled\s*=/.test(BOOT), 'boot shows this device\'s switch, not the server\'s');
  const DATA = read('js/21-data.js');
  ok(!/data\.searchEnabled/.test(DATA), 'importing a backup does not switch search on');
  ok(!/state\.searchEnabled\s*=\s*searchEnabled/.test(SEARCH), 'the switch no longer writes the shared copy');
  const CHAT = read('js/10-chat.js');
  ok(/if \(searchEnabled && !isProgrammatic\) \{/.test(CHAT), 'sending still searches only when this device\'s switch is on, never for an automatic continue');
  const all = ['js/04-state.js', 'js/05-persistence.js', 'js/06-state-sync.js', 'js/10-chat.js', 'js/21-data.js', 'js/24-boot.js']
    .map(f => [f, read(f)]).filter(([, s]) => /searchEnabled\s*=\s*(state|saved|data)\.searchEnabled/.test(s));
  ok(all.length === 0, 'nothing anywhere sets the switch from a stored copy', all.map(a => a[0]));
}

console.log('\n=== the page ===');
{
  const HTML = read('chat.html');
  ok(/id="search-toggle" onclick="toggleSearch\(\)" title="Web search is off on this device\.[^"]*" aria-pressed="false">/.test(HTML),
     'the button starts off, and says it is this device\'s');
  const CHARS = read('default-characters.json');
  ok(/Web search: 🔍 by the input \(per device\)/.test(CHARS), 'the Gobbonet Informant says it is per device');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
