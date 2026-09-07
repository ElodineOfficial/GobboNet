/**
 * PR #30 item 3 — safeImageUrl is the gate, so its output must be safe on its
 * own.
 *
 * Reported by John McCardle: the blob: branch tested the scheme and returned
 * the rest of the string unexamined. The http(s) branch had the same defect and
 * is covered here too.
 *
 * Drives the REAL safeImageUrl / safeUrlBody / sameOriginBlob out of
 * js/18-utils.js. The point of every assertion below is that the return value
 * is safe WITHOUT the caller adding escaping — today's callers all escape, but
 * the name promises the gate holds by itself.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const UTILS = fs.readFileSync(ROOT + '/js/18-utils.js', 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};
const eq = (a, b, label) =>
  ok(a === b, label + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

function load({ allowRemoteImages = false, origin = 'http://127.0.0.1:9066' } = {}) {
  const ctx = {
    console, Date, Math, JSON, String, Number, Array, Object, RegExp,
    parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
    state: { settings: { allowRemoteImages } },
    location: origin ? { origin } : undefined,
    document: { createElement: () => ({ style: {}, dataset: {} }) },
    window: { location: { origin } }
  };
  vm.createContext(ctx);
  vm.runInContext(UTILS, ctx);
  return ctx;
}

/* Characters that end a src="" or a CSS url(). If any of these survive the
   gate, an unescaping caller is one refactor away from an injection. */
const BREAKOUT = ['"', "'", '<', '>', '\\', ' ', '\t', '\n', '\r', '\u0000'];

console.log('\nblob: — the reported case');
{
  const u = load();
  eq(u.safeImageUrl('blob:http://127.0.0.1:9066/550e8400-e29b-41d4-a716-446655440000'),
     'blob:http://127.0.0.1:9066/550e8400-e29b-41d4-a716-446655440000',
     'a real same-origin blob still passes');
  eq(u.safeImageUrl('blob:null/550e8400-e29b-41d4-a716-446655440000'),
     'blob:null/550e8400-e29b-41d4-a716-446655440000',
     'blob:null passes — that is what file:// mode produces');

  for (const c of BREAKOUT) {
    eq(u.safeImageUrl(`blob:http://127.0.0.1:9066/x${c}y`), '',
       `blob carrying ${JSON.stringify(c)} is refused`);
  }
}

console.log('\nblob: — the attribute-breakout shapes specifically');
{
  const u = load();
  const attacks = [
    'blob:x" onerror="alert(1)',
    'blob:x\'><script>alert(1)</script>',
    'blob:x\nhttps://evil.com/y',
    'blob:\\\\evil\\share\\x'
  ];
  for (const a of attacks) {
    eq(u.safeImageUrl(a), '', `refused: ${JSON.stringify(a.slice(0, 34))}`);
  }
}

console.log('\nblob: — foreign origin');
{
  const u = load({ origin: 'http://127.0.0.1:9066' });
  eq(u.safeImageUrl('blob:https://evil.com/550e8400-e29b-41d4-a716-446655440000'), '',
     "a blob naming someone else's origin is refused");
  // Abstain rather than guess when there is nothing to compare against.
  const noloc = load({ origin: null });
  ok(noloc.safeImageUrl('blob:https://example.com/abc') !== '',
     'with no location available the origin check abstains');
}

console.log('\nhttp(s) — the same defect, fixed alongside');
{
  const on = load({ allowRemoteImages: true });
  eq(on.safeImageUrl('https://example.com/cat.png'), 'https://example.com/cat.png',
     'an ordinary remote image still passes when the setting allows it');
  eq(on.safeImageUrl('https://example.com/a(1).png?w=2&h=3'),
     'https://example.com/a(1).png?w=2&h=3',
     'parens, ? and & stay legal — they appear in real image URLs');
  for (const c of ['"', "'", '<', '>', ' ', '\n']) {
    eq(on.safeImageUrl(`https://example.com/x${c}y.png`), '',
       `remote URL carrying ${JSON.stringify(c)} is refused`);
  }
}

console.log('\nthe remote-image setting still gates, and still gates first');
{
  const off = load({ allowRemoteImages: false });
  eq(off.safeImageUrl('https://example.com/cat.png'), '', 'setting off suppresses a clean remote URL');
  const on = load({ allowRemoteImages: true });
  eq(on.safeImageUrl('https://example.com/x"y.png'), '',
     'setting on does NOT re-admit a malformed one');
}

console.log('\nunchanged behaviour');
{
  const u = load();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  eq(u.safeImageUrl(png), png, 'data: images still pass');
  eq(u.safeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), '',
     'svg+xml is still refused');
  eq(u.safeImageUrl('file:///C:/Windows/x.png'), '', 'file: is still refused');
  eq(u.safeImageUrl('javascript:alert(1)'), '', 'javascript: is still refused');
  eq(u.safeImageUrl(''), '', 'empty string');
  eq(u.safeImageUrl(null), '', 'null');
  eq(u.safeImageUrl(undefined), '', 'undefined');
  eq(u.safeDataUrl(png), png, 'the safeDataUrl alias still routes through the gate');
}

console.log('\nno output can ever carry a breakout character');
{
  const u = load({ allowRemoteImages: true });
  const corpus = [
    'blob:http://127.0.0.1:9066/ok', 'blob:null/ok', 'blob:https://evil.com/x',
    'https://example.com/ok.png', 'data:image/png;base64,AAAA',
    'blob:x" onerror="y', 'https://e.com/a b', 'blob:a\rb', "https://e.com/x'y"
  ];
  let leaked = 0;
  for (const c of corpus) {
    const out = u.safeImageUrl(c);
    if (out && BREAKOUT.some(b => out.includes(b))) leaked++;
  }
  eq(leaked, 0, 'across the whole corpus, nothing returned contains a breakout character');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
