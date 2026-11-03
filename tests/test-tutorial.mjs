/**
 * 1.7.9 F4 — the optional first-run tour (js/25-tutorial.js).
 *
 * A. Every stop points at a data-tour target that exists exactly once, and
 *    only at data-tour targets, so moving controls cannot break it.
 * B. The six stops the plan promised, one sentence each, in every variant.
 * C. When it is offered, run for real against stub state: a fresh profile
 *    only, never after "seen", never over a panel or the sign-in, never to a
 *    profile that already has a conversation.
 * D. Private: no network, no browser storage, no markup from strings; it
 *    records only state.settings.tourSeen, which is also a [ui] preset.
 * E. Wiring: loaded after boot, replay box in CONFIG -> Basics, Esc handled
 *    in the capture phase, focus kept in the card.
 *
 * The tour itself is driven in a real browser by tests/console/1.7.9-step-11.js.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const TOUR = read('js/25-tutorial.js');
const HTML = read('chat.html');
const DASH = read('js/13-dashboard.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '\n      ' + String(extra).slice(0, 400) : '')); }
};

// Load the module with just enough around it to read TOUR_STEPS and run
// tourShouldOffer(). Nothing in it touches the DOM at load time.
function load(over = {}) {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    state: { settings: { tourSeen: false }, threads: [], characterCards: [] },
    defaultCharacters: [{ name: 'Gobbonet Informant' }],
    document: { visibilityState: 'visible', querySelector: () => null },
    ...over,
  };
  vm.createContext(ctx);
  vm.runInContext(TOUR + '\n;this.TOUR_STEPS = TOUR_STEPS;', ctx);
  return ctx;
}

console.log('\n=== A. targets ===');
const targetsIn = (src) => [...src.matchAll(/data-tour="([^"]+)"/g)].map(m => m[1]);
const ALL = [...targetsIn(HTML), ...targetsIn(DASH)];
const ctx = load();
const STEPS = ctx.TOUR_STEPS;
const named = [...new Set(STEPS.flatMap(s => s.targets))];
for (const n of named) {
  ok(ALL.filter(x => x === n).length === 1, `data-tour="${n}" exists exactly once`, ALL.filter(x => x === n).length);
}
ok(ALL.every(n => named.includes(n)), 'and no data-tour is left over that no stop uses', ALL.filter(n => !named.includes(n)));
ok(!/querySelector\((?!'\[data-tour=|'#tour-root|'\.modal-backdrop\.open'|'#settings-modal')/.test(TOUR.replace(/root\.querySelector\('\.tour-[a-z]+'\)/g, '')),
   'the tour finds controls only by data-tour (no class or id selectors for targets)');
{
  const where = (n, src) => { const i = src.indexOf(`data-tour="${n}"`); return src.slice(Math.max(0, i - 40), i + 300); };
  ok(/onclick="openCharacters\(\)" data-tour="characters"/.test(HTML), 'characters -> the CHARS button');
  ok(/onclick="openSettings\(\)" data-tour="config"/.test(HTML), 'config -> the CONFIG button');
  ok(/onclick="createThread\(\)" data-tour="new-chat"/.test(HTML), 'new-chat -> + NEW_THREAD');
  ok(/<div class="input-area" data-tour="message">/.test(HTML), 'message -> the message box row');
  ok(/id="header-model-wrap" data-tour="model"/.test(HTML), 'model -> the header model menu');
  ok(/id="lan-group" data-tour="phone"/.test(HTML), 'phone -> Phone & Other Devices in CONFIG');
  ok(/id="home-btn" data-tour="home"/.test(HTML), 'home -> the header home button');
  ok(/data-tour="help">\s*<div class="landing-section-header">\s*<span>&#128126; DEFAULT CHARACTERS/.test(where('help', DASH)),
     'help -> the DEFAULT CHARACTERS section on the home screen, where the Informant is added');
  const network = HTML.indexOf('data-cfg-section="network"'), adv = HTML.indexOf('data-cfg-section="advanced"');
  const phone = HTML.indexOf('data-tour="phone"');
  ok(phone > network && phone < adv, 'the phone box is in Devices & Network, not inside the closed Advanced');
}

console.log('\n=== B. the six stops ===');
ok(STEPS.length === 6, 'six stops', STEPS.length);
ok(JSON.stringify(STEPS.map(s => s.title)) ===
   JSON.stringify(['Pick a character', 'Send a message', 'Choose a model', 'Settings', 'Your phone', 'Getting help']),
   'in the promised order: character, message, model, CONFIG, phone, help', STEPS.map(s => s.title));
ok(JSON.stringify(STEPS[1].targets) === '["message","new-chat"]', 'the message stop falls back to + NEW_THREAD on the home screen (no box there yet)');
ok(JSON.stringify(STEPS[5].targets) === '["help","home"]', 'the help stop falls back to the home button inside a chat');
ok(STEPS[4].opens === 'config', 'the phone stop opens CONFIG to show the real box');
{
  const one = (t) => /^[^.?!]+[.!?]$/.test(t.replace(/\b(?:TROUBLESHOOTING|config)\.(?:md|toml)\b/g, 'X').replace(/\+ /g, '+'));
  const variants = [];
  for (const s of STEPS) for (const t of [...s.targets, null]) variants.push([s.title, t, s.text(t)]);
  // The help stop reads the profile: Informant offered, installed, or neither.
  const h = STEPS[5];
  ctx.state.characterCards = [{ name: 'Gobbonet Informant' }];
  variants.push(['Getting help (installed)', 'help', h.text('help')]);
  ctx.state.characterCards = [];
  ctx.defaultCharacters = [];
  variants.push(['Getting help (not offered)', 'help', h.text('help')]);
  ctx.defaultCharacters = [{ name: 'Gobbonet Informant' }];
  const bad = variants.filter(([, , t]) => !one(t) || t.length > 140);
  ok(!bad.length, `every line is one sentence of 140 characters or fewer (${variants.length} variants)`, JSON.stringify(bad));
  ok(/\+ ADD/.test(h.text('help')) && /Informant/.test(h.text('help')), 'on the home screen it names the Informant and the + ADD to press');
  ctx.state.characterCards = [{ name: 'Gobbonet Informant' }];
  ok(/pick the Gobbonet Informant in CHARS/.test(h.text('help')), 'if the Informant is already added, it says where to pick it instead');
  ctx.state.characterCards = [];
}

console.log('\n=== C. when it is offered ===');
{
  const c = load();
  ok(c.tourShouldOffer() === true, 'a fresh profile is offered the tour');
  c.state.settings.tourSeen = true;
  ok(c.tourShouldOffer() === false, 'not once it was seen (skipped, taken or finished)');
  c.state.settings.tourSeen = false;
  c.state.threads = [{ messages: [{ role: 'assistant', content: 'greeting' }] }];
  ok(c.tourShouldOffer() === true, 'a chat holding only a greeting is still a fresh profile');
  c.state.threads.push({ messages: [{ role: 'user', content: 'hi' }] });
  ok(c.tourShouldOffer() === false, 'a profile with a conversation of its own is not (an upgrade is never interrupted)');
  c.state.threads = [];
  c.stateSync = { status: 'locked' };
  ok(c.tourShouldOffer() === false, 'never while the sign-in is up');
  c.stateSync = { status: 'ok' };
  c.document.querySelector = (sel) => sel === '.modal-backdrop.open' ? {} : null;
  ok(c.tourShouldOffer() === false, 'never on top of an open panel');
  c.document.querySelector = () => null;
  c.document.visibilityState = 'hidden';
  ok(c.tourShouldOffer() === false, 'never in a background tab');
  c.document.visibilityState = 'visible';
  ok(c.tourShouldOffer() === true, 'and offered again once those clear');
  ok(/if \(!r \|\| r\.ok !== false\) _tourWhenReady\(\)/.test(TOUR), 'not offered when boot could not reach the server (it may not know "seen" yet)');
  ok(/typeof _appBooted === 'undefined' \|\| _appBooted/.test(TOUR), 'waits for the first sync, so a second device hears "seen" before deciding');
}

console.log('\n=== D. private ===');
{
  const code = TOUR.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|import\(|https?:\/\//.test(code), 'it contacts nothing');
  ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), 'it keeps nothing in browser storage');
  ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code), 'it builds its card with textContent only');
  const writes = [...code.matchAll(/state\.settings\.(\w+)\s*=/g)].map(m => m[1]);
  ok(writes.length === 1 && writes[0] === 'tourSeen', 'the only thing it records is state.settings.tourSeen', writes);
  ok(/  tourSeen: false,\n/.test(read('js/04-state.js')), 'tourSeen is a setting (default false), so tour_seen = true in [ui] works as a preset');
  ok(/function startTour\(\)[\s\S]*?_tourMarkSeen\(\);/.test(TOUR) && /function endTour\(reason\)[\s\S]*?_tourMarkSeen\(\);/.test(TOUR),
     'taking it, skipping it and ending it all count as seen');
}

console.log('\n=== E. wiring ===');
{
  ok(HTML.indexOf('<script src="js/24-boot.js"></script>\n<script src="js/25-tutorial.js"></script>') > 0, 'loaded straight after boot');
  ok(HTML.includes('<link rel="stylesheet" href="css/19-tour.css">'), 'its stylesheet is linked');
  const basics = HTML.slice(HTML.indexOf('data-cfg-section="basics"'), HTML.indexOf('data-cfg-section="chat"'));
  ok(/id="cfg-tour-btn" onclick="replayTour\(\)">SHOW ME AROUND<\/button>/.test(basics), 'CONFIG -> Basics has SHOW ME AROUND');
  ok(/closes CONFIG without saving/.test(basics), '  and its visible line says it closes CONFIG without saving');
  ok(/tour_seen = true/.test(basics), '  and its "?" names the [ui] switch for power users');
  ok(/function replayTour\(\) \{\n  if \(typeof closeSettings === 'function' && closeSettings\(\) === false\) return false;/.test(TOUR),
     'replay goes through closeSettings, so an unsaved config.toml still asks first');
  ok(/document\[m\]\('keydown', _tourKey, true\)/.test(TOUR), 'keys are caught in the capture phase (Esc ends the tour, not CONFIG under it)');
  ok(/e\.key === 'Tab'/.test(TOUR) && /aria-modal', 'true'/.test(TOUR), 'a modal dialog that keeps focus inside it');
  ok(/setAttribute\('aria-live', 'polite'\)/.test(TOUR), 'each stop is announced to screen readers');
  ok(/@media \(prefers-reduced-motion: reduce\) \{\n  \.tour-spot \{ transition: none; \}/.test(read('css/19-tour.css')), 'the spotlight respects reduced motion');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
