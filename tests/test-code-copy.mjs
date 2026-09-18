/**
 * The Copy button on a code block, end to end.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * "Copying code removes linebreaks." The first half of that was fixed when
 * parseMarkdown stopped running its passes over fenced content: `\n -> <br>`
 * no longer reaches inside a <pre>, and <br> contributes nothing to
 * textContent, so that was where the welded-together lines came from.
 *
 * The second half survived, because it arrives by a different road. A fence
 * the scanner DECLINES is not inert -- it falls straight through to the
 * paragraph pass, and gets exactly the `\n -> <br>` treatment the fix was
 * meant to prevent. Three shapes were declined:
 *
 *   - a fence indented four spaces or more, which is how most models indent
 *     code inside a numbered list
 *   - the same at six or eight, in nested lists
 *   - a fence inside a blockquote
 *
 * There was no Copy button on those at all, and hand-selecting them returned
 * code with every level of indentation collapsed, because a <p> is
 * white-space:normal.
 *
 * WHAT THIS DRIVES
 * ----------------
 * The real parseMarkdown and the real copyCodeBlock out of js/18-utils.js, over
 * a small node tree built from the rendered HTML. tests/ has no install step and
 * is not going to get one, so the DOM here is about sixty lines of shim rather
 * than a dependency -- enough for childNodes / nodeType / closest /
 * querySelector, which is all copyCodeBlock touches.
 *
 * The shim decodes character references in text nodes, which matters more than
 * it sounds: code content is HTML-escaped on the way in, so a test that skipped
 * decoding would assert on `&lt;div&gt;` and pass while the clipboard got
 * something else entirely.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const UTILS = fs.readFileSync(ROOT + '/js/18-utils.js', 'utf8');

/* The two regions of 18-utils.js this needs: the clipboard pair, and the
   markdown renderer. Sliced by landmark rather than line number so an edit
   elsewhere in the file does not silently shift what gets tested. */
const COPY_SRC = UTILS.slice(
  UTILS.indexOf('function codeBlockText'),
  UTILS.indexOf('function escapeHtml')
);
const MD_SRC = UTILS.slice(
  UTILS.indexOf('/* ================================================================\n   MATH RENDERER'),
  UTILS.indexOf('/* ================================================================\n   COLOR PICKER HELPERS')
);

if (!COPY_SRC || !MD_SRC) {
  console.error('could not locate codeBlockText / the markdown renderer in js/18-utils.js');
  process.exit(1);
}

/* ================================================================
   A DOM, of sorts
================================================================ */

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source',
  'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/* One pass, not a chain of .replace() calls: decoding &amp; before &lt; turns
   the literal text `&amp;lt;` into `<`, which is the classic double-decode. */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const n = (body[1] === 'x' || body[1] === 'X')
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function hasClass(el, cls) {
  return (' ' + (el.attrs.class || '') + ' ').indexOf(' ' + cls + ' ') !== -1;
}

function matchOne(el, sel) {
  return sel[0] === '.' ? hasClass(el, sel.slice(1))
                        : el.tagName.toLowerCase() === sel.toLowerCase();
}

/* Only what copyCodeBlock asks for: a comma list of class selectors for
   closest(), and a two-part descendant selector ("pre code") for
   querySelector(). Anything richer would be shim for its own sake. */
function matchSelector(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let node = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (node && !matchOne(node, parts[i])) node = node.parentNode;
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

function makeElement(tag, attrs, parent) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: attrs || {},
    childNodes: [],
    parentNode: parent || null,
    textContent: '',
    classList: {
      toggle(c, on) {
        const have = hasClass(el, c);
        const want = on === undefined ? !have : !!on;
        if (want === have) return want;
        const list = (el.attrs.class || '').split(/\s+/).filter(Boolean);
        el.attrs.class = want ? list.concat(c).join(' ')
                              : list.filter(x => x !== c).join(' ');
        return want;
      },
      remove(...cs) {
        el.attrs.class = (el.attrs.class || '').split(/\s+/)
          .filter(x => x && !cs.includes(x)).join(' ');
      },
    },
    closest(sel) {
      const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
      let node = el;
      while (node) {
        if (sels.some(s => matchOne(node, s))) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
      const found = [];
      (function walk(n) {
        for (const k of n.childNodes) {
          if (k.nodeType !== 1) continue;
          if (sels.some(s => matchSelector(k, s))) found.push(k);
          walk(k);
        }
      })(el);
      return found;
    },
  };
  return el;
}

/* textContent as the browser computes it: every descendant text node
   concatenated, with element boundaries contributing nothing. Kept
   deliberately naive, because it is the behaviour codeBlockText exists to
   improve on -- if this helper "fixed" <br> too, the test could not tell the
   two apart. */
function computeText(el) {
  let s = '';
  for (const k of el.childNodes) s += k.nodeType === 3 ? k.nodeValue : computeText(k);
  return s;
}

function parseHtml(html) {
  const root = makeElement('div', {}, null);
  let node = root;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let last = 0, m;

  const text = (parent, raw) => {
    if (!raw) return;
    parent.childNodes.push({ nodeType: 3, nodeValue: decodeEntities(raw), parentNode: parent });
  };

  while ((m = re.exec(html))) {
    if (m.index > last) text(node, html.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n = node;
      while (n && n.tagName.toLowerCase() !== tag) n = n.parentNode;
      if (n && n.parentNode) node = n.parentNode;
      continue;
    }
    const el = makeElement(tag, parseAttrs(m[3]), node);
    node.childNodes.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) node = el;
  }
  if (last < html.length) text(node, html.slice(last));

  (function fill(n) {
    for (const k of n.childNodes) if (k.nodeType === 1) { fill(k); k.textContent = computeText(k); }
  })(root);
  return root;
}

/* ================================================================
   Context
================================================================ */

let clipboard = null;
let clipboardCalls = 0;

const ctx = {
  console: { error() {}, log() {} },
  setTimeout: () => 0,
  navigator: {
    clipboard: {
      writeText(t) { clipboardCalls++; clipboard = t; return Promise.resolve(); },
    },
  },
  document: { createElement: () => ({ style: {}, focus() {}, select() {} }) },
  escapeHtml: (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  safeCssColor: (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : ''),
  DIALOG_QUOTE_RE: /(?:&quot;)(?:(?!\n\n)[\s\S]){1,400}?(?:&quot;)/g,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(COPY_SRC + '\n' + MD_SRC, ctx);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* Render, find the nth Copy button, click it, return what reached the
   clipboard. `null` means no Copy button was rendered at all -- which is its
   own failure mode, and the one the declined fences produced. */
function copyOf(markdown, n) {
  const root = parseHtml(ctx.parseMarkdown(markdown, ''));
  const btns = root.querySelectorAll('.code-copy-btn');
  if (!btns.length) return null;
  clipboard = null;
  ctx.copyCodeBlock(btns[n || 0]);
  return clipboard;
}

const BODY = 'alpha\nbeta\ngamma';

/* ================================================================
   A. THE HOLE — fences the scanner used to decline
================================================================ */
console.log('\n=== A. a declined fence is not inert ===');
{
  // The headline case. Four spaces is what most models indent list
  // continuation by, so this is not an exotic shape -- it is the single most
  // common way a code block arrives inside instructions.
  eq(copyOf('1. Install it:\n\n    ```sh\n    npm i\n    npm run build\n    ```\n'),
     'npm i\nnpm run build',
     'a 4-space fence under a numbered list copies with its line breaks');

  eq(copyOf('- step\n\n    ```js\n    alpha\n    beta\n    gamma\n    ```'), BODY,
     'a 4-space fence under a bullet copies with its line breaks');

  eq(copyOf('1. step\n\n      ```sh\n      npm i\n      npm test\n      ```\n'),
     'npm i\nnpm test', 'six spaces too');

  eq(copyOf('- a\n  - b\n\n        ```sh\n        echo hi\n        echo bye\n        ```\n'),
     'echo hi\necho bye', 'eight spaces, under a nested list');

  eq(copyOf('> ```js\n> alpha\n> beta\n> gamma\n> ```'), BODY,
     'a blockquoted fence copies without the > prefix');

  eq(copyOf('>```js\n>alpha\n>beta\n>gamma\n>```'), BODY,
     'the space after > is optional');

  eq(copyOf('>> ```js\n>> alpha\n>> beta\n>> gamma\n>> ```'), BODY,
     'a nested blockquote works the same way');

  // The rendered shape matters as much as the clipboard: a quoted fence that
  // renders OUTSIDE its blockquote is a different bug wearing this one's
  // clothes.
  const quoted = ctx.parseMarkdown('Look:\n\n> ```sh\n> ls -la\n> pwd\n> ```\n\nDone.', '');
  ok(/<blockquote[^>]*>[\s\S]*class="code-block"[\s\S]*<\/blockquote>/.test(quoted),
     'the block lands inside the blockquote, not after it');

  // And the negative: nothing here should have taught an ordinary fence to
  // think it is quoted.
  const plain = ctx.parseMarkdown('```js\nalpha\n```', '');
  ok(!/blockquote/.test(plain), 'an unquoted fence does not grow a blockquote');
}

/* ================================================================
   B. NO NEW FALSE POSITIVES

   Uncapping the fence indent is only safe because this renderer has no
   indented-code-block rule for the looser reading to collide with. These pin
   that nothing else started looking like a fence.
================================================================ */
console.log('\n=== B. prose is still prose ===');
{
  const noBlock = (md, label) => {
    const root = parseHtml(ctx.parseMarkdown(md, ''));
    ok(!root.querySelectorAll('.code-block, .file-block').length, label);
  };
  noBlock('Here is `code` inline.\n\nAnd ``double`` too.', 'inline code opens nothing');
  noBlock('``\nalpha\n``', 'two backticks are not a fence');
  noBlock('    just indented prose\n    more of it', 'indented prose stays prose');
  noBlock('> quoted prose\n> more of it', 'a blockquote of prose opens nothing');
  noBlock('1. a\n2. b\n3. c', 'an ordinary list opens nothing');
}

/* ================================================================
   C. FENCE RULES THAT MUST NOT HAVE MOVED
================================================================ */
console.log('\n=== C. the existing fence rules still hold ===');
{
  eq(copyOf('````md\n```js\nx\n```\n````'), '```js\nx\n```',
     'a ``` line inside a ```` block is content, not a close');
  eq(copyOf('```js\nalpha\n~~~\nbeta\n```'), 'alpha\n~~~\nbeta',
     'a tilde line does not close a backtick fence');
  eq(copyOf('```go\npackage main\n\nfunc main() {}'), 'package main\n\nfunc main() {}',
     'an unclosed fence runs to the end (this is what streaming looks like)');
  eq(copyOf('> ```js\n> alpha\n> beta'), 'alpha\nbeta',
     'an unclosed QUOTED fence runs to the end too');
  eq(copyOf('```js\r\nalpha\r\nbeta\r\ngamma\r\n```'), BODY, 'CRLF');
  eq(copyOf('```file:notes.txt\n' + BODY + '\n```'), BODY, 'a file: block');
}

/* ================================================================
   D. WHAT REACHES THE CLIPBOARD

   codeBlockText exists so the clipboard stops depending on an invariant
   maintained three hundred lines away. These drive it directly, on HTML it
   would never see from the current renderer -- which is the point.
================================================================ */
console.log('\n=== D. codeBlockText is right on its own terms ===');
{
  const textOf = (html) => ctx.codeBlockText(parseHtml(html));

  eq(textOf('<code>alpha<br>beta<br>gamma</code>'), BODY,
     'a <br> counts as a newline -- textContent would weld these into one line');
  eq(parseHtml('<code>alpha<br>beta</code>').childNodes[0].textContent, 'alphabeta',
     '...and that IS what textContent does, which is why the shim keeps it naive');
  eq(textOf('<code>alpha\r\nbeta\rgamma</code>'), BODY, 'CR and CRLF fold to LF');
  eq(textOf('<code><span class="hl-kw">def</span> f():\n    <span>pass</span></code>'),
     'def f():\n    pass', 'highlighter spans contribute their text and nothing else');
  eq(textOf('<code>&lt;div&gt; &amp;&amp; &quot;x&quot;</code>'), '<div> && "x"',
     'character references are decoded, not copied literally');
  eq(textOf('<code></code>'), '', 'an empty block copies an empty string');
  eq(textOf('<code>a<br><br>b</code>'), 'a\n\nb', 'consecutive breaks are two newlines');
}

/* ================================================================
   E. THE ORIGINAL CASE, STILL FIXED
================================================================ */
console.log('\n=== E. the paragraph passes still cannot reach inside ===');
{
  eq(copyOf('```python\ndef f(x):\n    return x\n\ndef g(y):\n    return y\n```'),
     'def f(x):\n    return x\n\ndef g(y):\n    return y',
     'a blank line inside code survives to the clipboard');
  eq(copyOf('```py\na * b * c\n_x_ = 1\n**y**\n```'), 'a * b * c\n_x_ = 1\n**y**',
     'emphasis characters are not eaten');
  eq(copyOf('```md\n- a\n- b\n```'), '- a\n- b', 'bullet-looking lines are not listed');
  eq(copyOf('```\n\tindented\n  two spaces\n```'), '\tindented\n  two spaces',
     'tabs and leading spaces are byte-exact');

  const two = '```js\nalpha\nbeta\n```\n\ntext\n\n```py\ngamma\ndelta\n```';
  eq(copyOf(two, 0), 'alpha\nbeta', 'the first of two blocks copies its own body');
  eq(copyOf(two, 1), 'gamma\ndelta', 'and the second copies its own');
}

/* ================================================================
   F. THE CLIPBOARD CALL ITSELF
================================================================ */
console.log('\n=== F. plumbing ===');
{
  const root = parseHtml(ctx.parseMarkdown('```js\nalpha\nbeta\n```', ''));
  const btn = root.querySelector('.code-copy-btn');
  clipboardCalls = 0;
  ctx.copyCodeBlock(btn);
  eq(clipboardCalls, 1, 'one click writes to the clipboard exactly once');

  // A button with no block above it must not throw -- copyCodeBlock is wired
  // through an inline onclick, where an exception is a silent dead button.
  const orphan = makeElement('button', { class: 'code-copy-btn' }, null);
  let threw = false;
  try { ctx.copyCodeBlock(orphan); } catch (e) { threw = true; }
  ok(!threw, 'a Copy button with no block around it is a no-op, not a throw');

  // Section D proves codeBlockText handles <br>. This proves copyCodeBlock is
  // actually WIRED to it -- swap the call back to codeEl.textContent and
  // everything else in this file still passes, so without this the wiring is
  // untested. The renderer does not emit HTML in this shape today; that is
  // the point of asserting on it.
  const welded = parseHtml(
    '<div class="code-block"><div class="code-block-header">' +
    '<button class="code-copy-btn">Copy</button></div>' +
    '<pre><code>alpha<br>beta<br>gamma</code></pre></div>'
  );
  clipboard = null;
  ctx.copyCodeBlock(welded.querySelector('.code-copy-btn'));
  eq(clipboard, BODY, 'Copy goes through codeBlockText, so a <br> is a newline');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
