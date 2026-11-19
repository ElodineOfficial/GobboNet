// Accessibility: panels behave as dialogs (docs/changelog/CHANGELOG-accessibility-dialogs.md).
// Static checks on the real files, like test-hint-tooltips.mjs.
import { fileURLToPath } from 'node:url';
import fs from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const HTML = read('chat.html');
const UTILS = read('js/18-utils.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 700) : '')); }
};
const start = UTILS.indexOf('(function wireDialogs()');
const WIRE = start < 0 ? '' : UTILS.slice(start, UTILS.indexOf('\n})();', start));

console.log('\n=== A. every panel can be named ===');
{
  // The watcher names each panel by its <h2>; a panel without one would be a dialog with no name.
  const backs = [...HTML.matchAll(/<div class="modal-backdrop"[^>]*id="([^"]+)"/g)].map(m => m[1]);
  const unnamed = backs.filter(id => {
    const at = HTML.indexOf(`id="${id}"`), next = HTML.indexOf('class="modal-backdrop"', at + 1);
    return !/<h2[\s>]/.test(HTML.slice(at, next < 0 ? undefined : next));
  });
  ok(backs.length >= 9 && unnamed.length === 0, `each of the ${backs.length} panels in chat.html has an <h2> to be named by`, unnamed.join(', '));
}

console.log('\n=== B. the watcher (js/18-utils.js) ===');
{
  ok(WIRE.length > 0, 'wireDialogs() exists');
  ok(/setAttribute\('role', 'dialog'\)/.test(WIRE) && /setAttribute\('aria-modal', 'true'\)/.test(WIRE) && /setAttribute\('aria-labelledby', h\.id\)/.test(WIRE),
     'each panel is marked a modal dialog, named by its heading');
  ok(/setAttribute\('tabindex', '-1'\)/.test(WIRE), 'the panel itself can take focus (by script only)');
  ok(/attributeFilter: \['class'\], attributeOldValue: true/.test(WIRE), 'one watcher on each backdrop\'s class sees panels open and close, so no open/close function changed');
  ok(/if \(!back\.contains\(now\) && inPage\(now\)\) boxOf\(back\)\.focus\(\{ preventScroll: true \}\);/.test(WIRE),
     'on open, focus moves to the panel, unless the panel already put it inside or it is outside the page (the tour\'s card)');
  ok(/const inPage = el => !el \|\| el === document\.body \|\| !!\(el\.closest && el\.closest\('#app, \.modal-backdrop'\)\);/.test(WIRE) &&
     /if \(!inPage\(now\)\) return;/.test(WIRE),
     'Tab in something above the page (the tour\'s card, a mod\'s own panel) is left to it');
  ok(/if \(to && document\.contains\(to\) && shown\(to\)\) to\.focus/.test(WIRE), 'on close, focus goes back to whatever opened it');
  ok(/getElementById\('app'\)/.test(WIRE) && /el\.setAttribute\('aria-hidden', 'true'\); hidden\.add\(el\);/.test(WIRE) &&
     /el\.removeAttribute\('aria-hidden'\); hidden\.delete\(el\);/.test(WIRE) && /\{ hideBehind\(\); closed\(back\); \}/.test(WIRE) && !/\.inert\s*=/.test(WIRE),
     'while a panel is open the page behind it is hidden from screen readers (aria-hidden, not inert), and shown again before focus goes back');
  ok(/\(e\.key !== 'Tab' && e\.code !== 'Tab'\)/.test(WIRE) && /if \(!e\.shiftKey && now === last\) \{ e\.preventDefault\(\); first\.focus\(\); \}/.test(WIRE) && /else if \(e\.shiftKey && \(now === first \|\| now === boxOf\(back\)\)\)/.test(WIRE),
     'Tab and Shift+Tab wrap inside the panel on top, Shift+Tab from the panel itself too, and in WebKit on Linux');
  ok(/e\.key !== 'Escape' \|\| e\.cancelBubble/.test(WIRE) && /back\.id !== 'model-catalog-modal'/.test(WIRE) && /closeModelCatalog\(\);\s*e\.stopPropagation\(\);/.test(WIRE),
     'Esc closes ADD A MODEL alone, not CONFIG under it, and leaves an open "?" tooltip the first Esc');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
