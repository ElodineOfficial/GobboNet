// Accessibility: every control has a name a screen reader can say (docs/changelog/CHANGELOG-accessibility-names.md).
// Static checks on the real files, like test-hint-tooltips.mjs.
import { fileURLToPath } from 'node:url';
import fs from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const HTML = read('chat.html');
const RENDER = read('js/12-render.js'), DASH = read('js/13-dashboard.js');
const UTILS = read('js/18-utils.js'), GROUPS = read('js/29-groups.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 700) : '')); }
};
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, ' ').trim();

console.log('\n=== A. chat.html ===');
{
  // A button whose text has no letter or digit is read out by its symbol ("times", "pushpin").
  const symbolOnly = [...HTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/[A-Za-z0-9]/.test(text(inner)) && !/aria-label(ledby)?=/.test(attrs))
    .map(([whole]) => whole.slice(0, 120));
  ok(symbolOnly.length === 0, 'every button that shows only a symbol has an aria-label', symbolOnly.join('\n      '));

  // A number box's words sit beside it in a <span>, which names nothing.
  const unnamed = [...HTML.matchAll(/<input\b[^>]*type="number"[^>]*>/g)].map(([tag]) => tag)
    .filter(tag => !/aria-label(ledby)?=/.test(tag))
    .filter(tag => { const id = (tag.match(/id="([^"]+)"/) || [])[1]; return !id || !HTML.includes(`for="${id}"`); });
  ok(unnamed.length === 0, 'every number box has a label or an aria-label', unnamed.map(t => t.slice(0, 100)).join('\n      '));

  ok(/<select id="header-model-select" aria-labelledby="header-model-label"/.test(HTML) && /id="header-model-label">MODEL</.test(HTML),
     'the model dropdown is named by its MODEL text');
  ok(/class="search-toggle" aria-label="Web search"/.test(HTML), 'the web search button is "Web search" whatever its tooltip says');
}

console.log('\n=== B. buttons built in js/ ===');
{
  // The chat's name is said once, as the group around its buttons; each button is its word.
  // Naming every button after the chat made one chat six long sentences in a row.
  ok(/<div class="thread-ctrl" role="group" aria-label="\$\{escapeHtml\(t\.name\)\}">/.test(RENDER), "a chat's buttons sit in a group named after the chat");
  for (const [cls, name, said] of [['thread-pin-btn', "${t.pinned?'Unpin':'Pin'}", 'Pin or Unpin'], ['thread-folder-btn', 'Move to folder'],
                                   ['thread-tag-btn', 'Tags'], ['thread-export-btn', 'Export'], ['thread-edit-btn', 'Rename'], ['thread-del-btn', 'Delete']]) {
    const tag = (RENDER.match(new RegExp('<button class="thread-ctrl-btn ' + cls + '[^>]*>')) || [''])[0];
    ok(tag.includes(`aria-label="${name}"`), `a chat's ${cls} is named "${said || name}"`, tag.slice(0, 200));
  }
  ok(/aria-label="Rename folder \$\{escapeHtml\(folder\.name\)\}"/.test(RENDER) && /aria-label="Delete folder \$\{escapeHtml\(folder\.name\)\}"/.test(RENDER),
     "a folder's buttons name the folder");
  ok(/class="pop-add-btn" aria-label="Add"/.test(RENDER), 'the tag editor\'s + is "Add"');
  ok(['Previous branch', 'Next branch', 'Previous wording', 'Next wording', 'Previous variant', 'Next variant'].every(n => DASH.includes(`aria-label="${n}"`)),
     'the branch, wording and variant arrows have names');
  ok(/class="attach-chip-x"[^>]*aria-label="Remove"/.test(UTILS), 'an attachment\'s × is "Remove"');
  ok(/els\.toggle\.title = name;\s*els\.toggle\.setAttribute\('aria-label', name\);/.test(read('js/27-files-panel.js')),
     'the Files button\'s name keeps its count, as its tooltip does');
  ok(/if \(title && !\/\[A-Za-z0-9\]\/\.test\(label\)\) b\.setAttribute\('aria-label', title\);/.test(GROUPS),
     'a group editor button that shows only a symbol is named by its title');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
