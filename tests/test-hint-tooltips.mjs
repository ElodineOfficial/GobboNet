/**
 * Feature notes: one visible sentence, the rest behind a "?" tooltip.
 *
 * The notes under CONFIG and character-editor features had grown into
 * paragraphs. Each long one is now a one-sentence summary with a "?" button;
 * the original note, word for word, sits in a hidden <div class="tip-body">
 * that the button names in aria-describedby. js/18-utils.js shows it on hover,
 * focus, click or tap (see HINT TOOLTIPS there).
 *
 *   A. Every "?" is wired to its own hidden note, right after the line.
 *   B. Each visible line is one short sentence, and the note says more.
 *   C. Warnings stay visible: they are in the line, not only in the note.
 *   D. The script and styles the markup depends on.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const HTML = read('chat.html');
const UTILS = read('js/18-utils.js');
const CSS = read('css/13-components.css');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 700) : '')); }
};
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();

// Each tooltip: the visible line, its button, and the hidden note after it.
const RE = /<div([^>]*)class="form-hint"([^>]*)>((?:(?!<\/div>).)*?)<button type="button" class="tip-btn" aria-label="([^"]*)" aria-describedby="([^"]*)" aria-expanded="false">\?<\/button><\/div>\s*<div class="tip-body" id="([^"]*)" hidden>([\s\S]*?)<\/div>\n/g;
const tips = [...HTML.matchAll(RE)].map(m => ({ line: m[3], label: m[4], ref: m[5], id: m[6], body: m[7], at: m.index }));
const buttons = (HTML.match(/class="tip-btn"/g) || []).length;

/* ================================================================ A */
console.log('\n=== A. every "?" has its note ===');
{
  ok(tips.length >= 40, `${tips.length} feature notes have a "?"`);
  ok(tips.length === buttons, 'every "?" button in the page follows the same pattern', `${tips.length} matched of ${buttons}`);
  ok(tips.every(t => t.ref === t.id), 'each button names the note right after it (aria-describedby)', tips.filter(t => t.ref !== t.id).map(t => t.ref));
  const ids = tips.map(t => t.id);
  ok(new Set(ids).size === ids.length && ids.every(id => (HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1),
     'each note id is unique in the page');
  ok(tips.every(t => /^More about \S/.test(t.label)), 'each button is labelled "More about …" for screen readers');
  // A button inside a <label> would tick the label's checkbox when clicked.
  const inLabel = tips.filter(t => {
    const before = HTML.slice(0, t.at);
    return before.lastIndexOf('<label') > before.lastIndexOf('</label>');
  });
  ok(inLabel.length === 0, 'no "?" sits inside a <label>', inLabel.map(t => t.id));
}

/* ================================================================ B */
console.log('\n=== B. one sentence visible, the rest in the note ===');
{
  const sentences = (s) => (text(s).match(/[.!?](?=\s|$)/g) || []).length;
  const notOne = tips.filter(t => sentences(t.line) !== 1);
  ok(notOne.length === 0, 'every visible line is exactly one sentence', notOne.map(t => text(t.line)));
  const long = tips.filter(t => text(t.line).length > 130);
  ok(long.length === 0, 'and short: 130 characters at most', long.map(t => text(t.line)));
  const thin = tips.filter(t => text(t.body).length <= text(t.line).length);
  ok(thin.length === 0, 'every note says more than its line', thin.map(t => t.id));
  // Long notes that are still out in the open, outside a tooltip.
  const open = [...HTML.matchAll(/<div([^>]*)class="form-hint"([^>]*)>([\s\S]*?)<\/div>/g)]
    .filter(m => !/tip-btn/.test(m[3]) && !/display:flex/.test(m[1] + m[2]) && !/id="(card-ctx-hint|sync-profile-hint)"/.test(m[1] + m[2]))
    .map(m => text(m[3])).filter(t => t.length > 120 && (t.match(/[.!?](?=\s|$)/g) || []).length > 1);
  // The sign-in prompt is a message, not a feature note, and stays as written.
  const signin = between(HTML, 'id="unlock-modal"', '</form>');
  ok(open.every(t => signin.includes(t.slice(0, 40))), 'no other long, multi-sentence note is left open (the sign-in prompt aside)', open);
}

/* ================================================================ C */
console.log('\n=== C. warnings stay in sight ===');
{
  const lineOf = (id) => (tips.find(t => t.id === id) || {}).line || '';
  ok(/changing these restarts the model/.test(lineOf('tip-performance')), 'Performance: "changing these restarts the model"');
  ok(/imported cards arrive with it switched off/.test(lineOf('tip-card-code')), 'custom code: imported cards arrive with it switched off');
  ok(/a full backup replaces everything/.test(lineOf('tip-data-import')), 'import: a full backup replaces everything');
  ok(/http:\/\//.test(lineOf('tip-phone')), 'phone: type it with http://');
  ok(/your IP address/.test(lineOf('tip-remote-images')), 'remote images: loading one tells that server your IP address');
  ok(/stay on this machine/.test(lineOf('tip-privacy')) && /optional/.test(lineOf('tip-privacy')), 'privacy: what goes online, and that it is optional');
  ok(/offers <strong>UNDO for 10 seconds<\/strong>; after that it is gone, so export first if you want a backup\./.test(HTML.replace(/<div class="tip-body"[\s\S]*?<\/div>\n/g, '')),
     'PURGE: the warning (UNDO for 10 seconds, then gone; export first) is a visible note, not a tooltip');
}

/* ================================================================ D */
console.log('\n=== D. the script and styles it needs ===');
{
  ok(/function showHintTip\(btn, pin\)/.test(UTILS) && /function hideHintTip\(\)/.test(UTILS), 'show and hide are in js/18-utils.js');
  ok(/getAttribute\('aria-describedby'\)/.test(UTILS), 'the popup finds its note through aria-describedby');
  ok(/cloneNode\(true\)/.test(between(UTILS, 'function showHintTip', 'function hideHintTip')) && !/innerHTML/.test(between(UTILS, 'HINT TOOLTIPS', 'function hideHintTip')),
     'the note is cloned into the popup, never parsed from a string');
  ok(/document\.body\.appendChild\(pop\)/.test(UTILS) && /position: fixed/.test(between(CSS, '#tip-pop {', '}')),
     'one popup on <body>, fixed, so a scrolling window cannot clip it');
  ok(/e\.key === 'Escape'/.test(UTILS) && /stopPropagation\(\);\s+\/\/ close the tooltip, not the modal/.test(UTILS), 'Escape closes the tooltip and not the window under it');
  ok(/\.tip-btn::after \{ content: ""; position: absolute; inset: -8px; \}/.test(CSS), 'the 16px "?" has a ~32px touch target');
  ok(/\.tip-btn:focus-visible/.test(CSS), 'and a visible keyboard focus ring');
}

function between(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) { console.error('could not locate ' + JSON.stringify(from)); process.exit(1); }
  return src.slice(a, b);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
