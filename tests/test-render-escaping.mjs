/**
 * 1.7.9 step 4 — PR #4 (neoliminal): values from imported files and the /state
 * sync blob are escaped at every render sink.
 *
 * Synced data is untrusted: any paired device, or anyone holding the password,
 * can write /state. A card name, thread id or message field from there must not
 * be able to break out of the markup it is placed in.
 *
 * Two halves:
 *   1. Source lint over js/: every ${...} inside an inline on*="..." handler is
 *      wrapped in escapeJsAttr/escapeJsString or is a numeric loop index, and
 *      job ids are URI-encoded before they reach a URL path.
 *   2. The real renderAvatar, escapeHtml and escapeJsAttr, run against break-out
 *      payloads.
 *
 * The browser half (a hostile card and thread rendered for real, checking that
 * nothing runs) is in tests/console/1.7.9-steps-4-6.js.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const JS_DIR = ROOT + '/js';
const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).sort();
const src = Object.fromEntries(files.map(f => [f, fs.readFileSync(`${JS_DIR}/${f}`, 'utf8')]));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
};

// ── 1. Lint ────────────────────────────────────────────────────────────────
console.log('inline handlers');
// A value is safe in a handler if it is escaped for the JS layer, or is a bare
// numeric index the code computed itself, or is a handler NAME chosen in code
// (moveColumnHtml's `fn`, which callers pass as a literal). `eid` is
// moveColumnHtml's escapeJsAttr(id), checked separately below.
const SAFE_EXPR = /^(?:escapeJsAttr|escapeJsString)\(|^(?:i|idx|index|n|k|j|fn|eid)$|^(?:i|idx|index) *[+-] *\d+$/;
const offenders = [];
for (const [f, text] of Object.entries(src)) {
  const lines = text.split('\n');
  lines.forEach((line, n) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;   // comments describe handlers, they are not handlers
    // on<event>="...${expr}..." on one line (every handler in js/ is one line).
    for (const m of line.matchAll(/\bon[a-z]+="([^"]*)"/g)) {
      for (const e of m[1].matchAll(/\$\{([^}]*)\}/g)) {
        const expr = e[1].trim();
        if (!SAFE_EXPR.test(expr)) offenders.push(`${f}:${n + 1}  ${expr}`);
      }
    }
  });
}
ok(/const eid = escapeJsAttr\(id\);/.test(src['15-cards.js']), 'moveColumnHtml builds eid with escapeJsAttr');
ok(offenders.length === 0, 'every ${...} in an inline handler is escaped or a numeric index' +
  (offenders.length ? '\n      ' + offenders.join('\n      ') : ''));

console.log('specific sinks from the PR #4 review');
ok(/<span class="message-role">\$\{escapeHtml\(roleLabel\)\}<\/span>/.test(src['13-dashboard.js']) &&
   !/<span class="message-role">\$\{roleLabel\}/.test(src['13-dashboard.js']),
   'the message header escapes the character / persona name (both render paths)');
ok(/data-t0="\$\{Number\(m\.genStartedAt\) \|\| 0\}"/.test(src['13-dashboard.js']),
   'a synced genStartedAt reaches data-t0 only as a number');
ok(/const capped = Math\.round\(Number\(m\.smartCapped\) \|\| 0\)/.test(src['13-dashboard.js']),
   'a synced smartCapped reaches the badge only as a number');
ok(/const forkAt = Math\.max\(0, Math\.floor\(Number\(thread\.forkSource\.at\) \|\| 0\)\)/.test(src['13-dashboard.js']),
   'a synced forkSource.at reaches "at message N" only as a number');
ok(/folded: Number\(raw\.folded\) \|\| 0/.test(src['13-dashboard.js']),
   'lore log counts are coerced to numbers before the table');

console.log('job ids in URL paths');
const rawJobPaths = [];
for (const [f, text] of Object.entries(src)) {
  for (const m of text.matchAll(/\$\{JOBS_URL\}\/\$\{([^}]*)\}/g)) {
    if (!/^encodeURIComponent\(/.test(m[1].trim())) rawJobPaths.push(`${f}: ${m[1]}`);
  }
}
ok(rawJobPaths.length === 0, 'every ${JOBS_URL}/${id} is URI-encoded (a synced pendingJob.id cannot walk the path)' +
  (rawJobPaths.length ? '\n      ' + rawJobPaths.join('\n      ') : ''));

// ── 2. The real helpers ──────────────────────────────────────────────────────
console.log('helpers against break-out payloads');
const utils = src['18-utils.js'];
const pick = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start) + start.length));
// escapeHtml uses the DOM's own serializer (textContent in, innerHTML out).
// This fake does what the browser does for a text node: & < > become entities.
const fakeDocument = { createElement: () => {
  let t = '';
  return { set textContent(v) { t = String(v); },
           get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
} };
const ctx = { console, document: fakeDocument };
vm.createContext(ctx);
vm.runInContext(pick(utils, 'function escapeHtml(', '\n}\n') + '\n}\n', ctx);
vm.runInContext(pick(utils, 'function escapeJsString(', '\n}\n') + '\n}\n', ctx);
vm.runInContext(pick(utils, 'function escapeJsAttr(', '\n}\n') + '\n}\n', ctx);
const prompt = src['07-prompt.js'];
vm.runInContext('function safeImageUrl(){ return ""; }\n' +
  pick(prompt, 'function renderAvatar(', '\n}\n') + '\n}\n', ctx);

const av = ctx.renderAvatar('', '<img src=x onerror=alert(1)>');
ok(av === '&lt;', `renderAvatar escapes a name's first character (got ${JSON.stringify(av)})`);
ok(ctx.renderAvatar('', '&amp') === '&amp;', 'an initial "&" is escaped too');
ok(ctx.renderAvatar('', 'tifa') === 'T', 'ordinary names are unchanged');

// escapeJsAttr: the value must survive the HTML attribute layer AND the JS
// string layer. Simulate both: decode entities as the HTML parser would, then
// confirm the JS string literal it sits in is still one literal.
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const payload of ["x');alert(1);('", 'x",alert(1),"', 'x\\\');alert(1)//', "x\n');alert(1)//", '</script><img src=x onerror=1>']) {
  const attr = ctx.escapeJsAttr(payload);
  ok(!/["]/.test(attr), `escapeJsAttr leaves no raw " in the attribute for ${JSON.stringify(payload)}`);
  let got;
  try { got = vm.runInNewContext(`'${decode(attr)}'`); } catch (e) { got = e; }
  ok(got === payload, `…and the handler sees exactly the original string`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
