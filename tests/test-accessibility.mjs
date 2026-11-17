// Accessibility: keyboard reach and visible focus (docs/changelog/CHANGELOG-accessibility-*.md).
// Static checks on the real files, like test-hint-tooltips.mjs.
import { fileURLToPath } from 'node:url';
import fs from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const JS = Object.fromEntries(fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js')).map(f => [f, read('js/' + f)]));
const UTILS = JS['18-utils.js'], RENDER = JS['12-render.js'], DASH = JS['13-dashboard.js'];
const TOKENS = read('css/01-tokens.css');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 700) : '')); }
};

console.log('\n=== A. rows that open something work from the keyboard ===');
{
  ok(/class="thread-name" role="button" tabindex="0"/.test(RENDER), 'a chat\'s name is a keyboard button');
  ok(/class="folder-name-text" role="button" tabindex="0" aria-expanded=/.test(RENDER), 'a folder\'s name is a keyboard button and says open/closed');
  ok(/role="button" tabindex="0"[^>]*class="card-name"/.test(JS['15-cards.js']), 'a character\'s name in CHARS is a keyboard button');
  ok(/role="button" tabindex="0"[^>]*class="card-name"/.test(JS['17-personas.js']), 'a persona\'s name is a keyboard button');
  ok(/class="landing-char-card [^"]*" role="button" tabindex="0"/.test(DASH), 'home page character cards are keyboard buttons');
  ok(/landing-group-card" role="button" tabindex="0"/.test(JS['29-groups.js']), 'home page group cards are keyboard buttons');
  ok(/matches\('\[role="button"\]\[tabindex\]'\)/.test(UTILS) && /t\.click\(\);/.test(UTILS), 'Enter / Space on a role="button" clicks it');
  ok(/if \(e\.defaultPrevented\) return;/.test(UTILS), 'Enter / Space is left alone when the element\'s own key handler took it');
  ok(/function keepFocusAcross\(container, paint\)/.test(RENDER), 'keepFocusAcross() exists');
  ok(/keepFocusAcross\(list,/.test(RENDER), 'the sidebar keeps focus when it repaints');
  ok(/keepFocusAcross\(grid, paint\)/.test(JS['15-cards.js']), 'the character grid keeps focus when it repaints');
  ok(/keepFocusAcross\(grid, paint\)/.test(JS['17-personas.js']), 'the persona grid keeps focus when it repaints');
  ok((DASH.match(/keepFocusAcross\(container, paint(Landing|Rows)\)/g) || []).length === 2, 'the home page and the messages keep focus when they repaint');
  ok(/function sameMarkup\(container, html\)/.test(RENDER) && /if \(!sameMarkup\(list, html\)\)/.test(RENDER) && /!sameMarkup\(container, html\)/.test(DASH),
     'a repaint that changes nothing leaves the sidebar and home page alone, so a screen reader doesn\'t repeat itself');
}

console.log('\n=== B. focus you can see ===');
{
  ok(/\.thread-item:has\(:focus-visible\) \.thread-ctrl \{ max-width: 200px; opacity: 1; \}/.test(read('css/03-threads.css')), 'thread buttons open on keyboard focus');
  ok(/\.message:has\(:focus-visible\) \.message-actions \{ opacity: 1; \}/.test(read('css/04-chat.css')), 'message buttons show on keyboard focus');
  ok(/\.folder-hdr:has\(:focus-visible\) \.folder-hdr-btns \{ opacity: 1; \}/.test(read('css/12-organisation.css')), 'folder buttons show on keyboard focus');
  ok(/\.cot-summary:focus-visible, \.code-block pre:focus-visible, \.landing-preset-card:focus-visible \{\s*outline: 2px solid var\(--cyan-bright\); outline-offset: -2px;/.test(TOKENS),
     'focus is drawn inside boxes that clip the glow');
  ok(/\.form-group input:is\(\[type="range"\], \[type="radio"\], \[type="checkbox"\]\):focus-visible \{/.test(TOKENS), 'sliders, radio buttons and checkboxes get an outline');
  ok(/@media \(forced-colors: active\) \{\s*:focus-visible \{ outline: 2px solid Highlight !important;/.test(TOKENS), 'forced colours draw a focus outline');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
