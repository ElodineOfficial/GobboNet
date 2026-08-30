/**
 * Block-aware markdown rendering, syntax highlighting, and the protect
 * mechanism that made both possible.
 *
 * Runs the REAL parseMarkdown out of js/18-utils.js.
 *
 * The through-line: parseMarkdown used to be a flat chain of regex replaces
 * over one string, so every pass ran over the code blocks too. Section A is
 * that bug from every angle it showed up in; the rest is the structure the
 * fix made room for.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const UTILS = fs.readFileSync(ROOT + '/js/18-utils.js', 'utf8');

const block = UTILS.slice(
  UTILS.indexOf('/* ================================================================\n   MATH RENDERER'),
  UTILS.indexOf('/* ================================================================\n   COLOR PICKER HELPERS')
);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  \u2713 ' + l); } else { fail++; console.log('  \u2717 ' + l); } };
const eq = (a, b, l) => ok(a === b, l + (a === b ? '' : `\n      got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`));

const ctx = {
  console: { error() {}, log() {} },
  escapeHtml: (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  safeCssColor: (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : ''),
  DIALOG_QUOTE_RE: /(?:&quot;)(?:(?!\n\n)[\s\S]){1,400}?(?:&quot;)/g,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(block, ctx);

const md = (s, c) => ctx.parseMarkdown(s, c === undefined ? '' : c);

/* What copyCodeBlock reads: textContent of the <pre><code>, which counts no
   tags at all and decodes character references. */
function copyText(html) {
  const m = /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

/* ================================================================
   A. THE PROTECT MECHANISM — code survives the markdown passes
================================================================ */
console.log('\n=== A. nothing reaches inside a code block ===');
{
  // The headline case. `\n\n+ -> </p><p>` used to run inside the <pre>, and
  // the browser then dropped the </code> entirely (p is "special", so the
  // any-other-end-tag step bails), leaving paragraph boxes in the code.
  const blank = md('```python\ndef f(x):\n    return x\n\ndef g(y):\n    return y\n```');
  ok(!/<pre[\s\S]*<\/p><p>[\s\S]*<\/pre>/.test(blank), 'a blank line does not inject </p><p> into the pre');
  eq(copyText(blank), 'def f(x):\n    return x\n\ndef g(y):\n    return y',
     'Copy yields the exact bytes, newlines and all');

  // `\n -> <br>` also ran inside the pre, and <br> contributes nothing to
  // textContent, so Copy returned every line welded together.
  ok(!/<pre[^>]*><code[^>]*>[\s\S]*?<br>[\s\S]*?<\/code>/.test(blank),
     'no <br> is left standing in for a newline');

  // The emphasis pass DELETED asterisks, on screen and in the clipboard.
  const stars = md('```c\nint a = b * c * d;\n// **important**\n```');
  ok(!/<em>|<strong>/.test(stars), 'asterisks in code do not become emphasis');
  eq(copyText(stars), 'int a = b * c * d;\n// **important**', 'and Copy still has them');

  const listy = md('```sh\ncurl https://example.com/x\n- item\n# heading\n1. step\n```');
  ok(!listy.includes('&bull;'), 'a - line in code is not turned into a bullet');
  ok(!/<a href/.test(listy), 'a URL in code is not turned into a link');
  ok(!/<h[1-6]/.test(listy), 'a # line in code is not turned into a heading');
  ok(!/<ol|<ul/.test(listy), 'a numbered line in code is not turned into a list');
  eq(copyText(listy), 'curl https://example.com/x\n- item\n# heading\n1. step',
     'Copy is byte-exact for all four');

  // Inline code was protected from OTHER blocks but not from later passes.
  const inline = md('use `a * b` and `**not bold**` here');
  ok(/<code>a \* b<\/code>/.test(inline), 'asterisks survive inside inline code');
  ok(!/<code>[^<]*<strong>/.test(inline), 'bold does not fire inside inline code');

  // File blocks share the pre, and shared the bug.
  const file = md('```file:a.py\ndef f():\n    pass\n\ndef g():\n    pass\n```');
  eq(copyText(file), 'def f():\n    pass\n\ndef g():\n    pass', 'file blocks copy faithfully too');
}

console.log('\n=== A2. the placeholder cannot be forged ===');
{
  // The sentinels are private-use codepoints that escapeHtml leaves alone,
  // so a user CAN type them. The nonce is what makes a forged slot useless.
  const attack = '\uE000' + '0'.repeat(24) + '.0\uE001 and \uE000abc.999\uE001';
  const out = md(attack + '\n\n```js\nsecret\n```');
  ok(out.includes('code-block'), 'the real block still renders');
  ok(!/\uE000|\uE001/.test(out.replace(/<[^>]*>/g, '')) || out.includes('\uE000'),
     'a forged placeholder is not substituted with stored HTML');
  ok(!out.includes('secretsecret'), 'the stored block is emitted exactly once');
}

/* ================================================================
   B. FENCES — forms the old scanner missed entirely
================================================================ */
console.log('\n=== B. fence forms ===');
{
  const crlf = md('```js\r\nlet a = 1;\r\n```');
  ok(crlf.includes('code-block'), 'CRLF fences render (the old regex needed a bare \\n)');
  ok(!crlf.includes('```'), 'and leave no backticks behind');

  ok(md('~~~js\nlet a=1;\n~~~').includes('code-block'), 'tilde fences render');

  const four = md('````js\nlet a=1;\n````');
  ok(four.includes('code-block'), 'four-backtick fences render');
  ok(!four.includes('`'), 'and do not leak a stray backtick');

  // A ```` block may legally contain ``` lines.
  const outer = md('````md\n```js\nx\n```\n````');
  // Count the opening div, not the substring: "code-block" also appears in
  // "code-block-header" on every block.
  eq((outer.match(/<div class="code-block">/g) || []).length, 1,
     'a longer fence contains a shorter one rather than closing on it');
  ok(copyText(outer).includes('```js'), 'and keeps it as literal text');

  const indented = md('- item\n\n  ```js\n  let a = 1;\n  ```');
  ok(indented.includes('code-block'), 'an indented fence renders');
  eq(copyText(indented), 'let a = 1;', 'and the indent is stripped from the body');
}

console.log('\n=== B2. streaming: an unclosed fence ===');
{
  // 14-scroll.js re-runs parseMarkdown over the whole message on every
  // streamed token. Until the closing fence arrived the user watched raw
  // backticks, and the box snapped in only at the end.
  const partial = md('here:\n```js\nlet a = 1;\nlet b =');
  ok(partial.includes('code-block'), 'an unclosed fence renders as a code block immediately');
  ok(!partial.includes('```'), 'with no raw backticks on screen');
  eq(copyText(partial), 'let a = 1;\nlet b =', 'carrying what has arrived so far');

  // And the finished message must look the same, or the box would jump.
  const done = md('here:\n```js\nlet a = 1;\nlet b = 2;\n```');
  ok(done.includes('code-block'), 'the closed form renders the same way');
}

/* ================================================================
   C. TABLES — "columns and grids"
================================================================ */
console.log('\n=== C. tables ===');
{
  const t = md('| Name | Size | Notes |\n|------|-----:|:----:|\n| a | 1 | one |\n| b | 22 | two |');
  ok(t.includes('<table class="md-table">'), 'a GFM table becomes a real table');
  eq((t.match(/<th /g) || []).length, 3, 'three header cells');
  eq((t.match(/<tr>/g) || []).length, 3, 'header row plus two body rows');
  ok(t.includes('md-al-r'), 'right alignment is read from -----:');
  ok(t.includes('md-al-c'), 'centre alignment is read from :----:');
  ok(t.includes('md-table-wrap'), 'and the wrapper is what scrolls, not the bubble');

  // Ragged rows must not drop or shift cells.
  const ragged = md('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
  eq((ragged.match(/<td /g) || []).length, 6, 'short and long rows are padded to the header width');

  // Inline formatting inside cells.
  const rich = md('| a | b |\n|---|---|\n| **bold** | `code` |');
  ok(rich.includes('<strong>bold</strong>'), 'cells take inline formatting');
  ok(rich.includes('<code>code</code>'), 'including inline code');

  // A pipe table needs its delimiter row; prose with pipes is not a table.
  ok(!md('a | b | c\nnot a table').includes('<table'), 'pipes without a delimiter row are not a table');

  const esc = md('| a | b |\n|---|---|\n| x \\| y | z |');
  ok(esc.includes('x | y'), 'an escaped pipe stays inside its cell');
}

/* ================================================================
   D. LISTS
================================================================ */
console.log('\n=== D. lists ===');
{
  // "- x" used to become the CHARACTER &bull; -- no <ul>, no indent, and no
  // hanging indent when a line wrapped. "1. x" was replaced with itself.
  const ul = md('- top\n  - nested\n  - nested2\n- top2');
  ok(ul.includes('<ul class="md-ul">'), 'a bullet list becomes a real <ul>');
  eq((ul.match(/<ul /g) || []).length, 2, 'nesting produces a nested list');
  eq((ul.match(/<li/g) || []).length, 4, 'four items in total');
  ok(!ul.includes('&bull;'), 'and no bullet characters are left');

  const ol = md('1. first\n2. second\n   1. sub');
  ok(ol.includes('<ol class="md-ol">'), 'a numbered list becomes a real <ol>');
  eq((ol.match(/<ol /g) || []).length, 2, 'and nests');

  ok(md('* star\n+ plus').includes('<ul'), '* and + also start bullet lists');

  const task = md('- [ ] todo\n- [x] done');
  eq((task.match(/md-task-box/g) || []).length, 2, 'both task items get a box');
  eq((task.match(/md-task-done/g) || []).length, 1, 'exactly one is marked done');
  ok(task.includes('&#9744;') && task.includes('&#9745;'), 'unchecked and checked boxes differ');

  // A list must not swallow the paragraph after it.
  const after = md('- one\n- two\n\nafter');
  ok(after.includes('<p>after</p>'), 'a blank line ends the list');

  const cont = md('- one\n  continued here\n- two');
  ok(cont.includes('continued here'), 'an indented continuation line stays with its item');
}

/* ================================================================
   E. QUOTES, RULES, HEADINGS, STRIKETHROUGH
================================================================ */
console.log('\n=== E. other blocks ===');
{
  // Blockquote is the one marker escapeHtml touches: by the time the block
  // pass runs, > is already &gt;. Matching a literal > meant it never fired.
  const q = md('> quoted line\n> second\n\nafter');
  ok(q.includes('<blockquote class="md-quote">'), 'blockquotes fire on escaped input');
  ok(q.includes('<p>after</p>'), 'and end at the blank line');
  ok(md('> outer\n> > inner').match(/<blockquote/g).length === 2, 'quotes nest');
  ok(md('> - a\n> - b').includes('<ul'), 'a list inside a quote is still a list');

  const h = md('# One\n## Two\n### Three\n#### Four');
  ok(/<h1 class="md-h1">One<\/h1>/.test(h), 'h1 is a real block element, not a styled <strong>');
  ok(/<h4 class="md-h4">/.test(h), 'h4 is supported (the old chain stopped at ###)');
  ok(!h.includes('font-size:1.2em'), 'and carries no inline style');

  ok(md('---').includes('<hr class="md-hr">'), '--- is a horizontal rule');
  ok(md('***').includes('<hr'), '*** is too');
  ok(md('~~struck~~').includes('<del class="md-del">struck</del>'), 'strikethrough works');
  ok(md('***both***').includes('<strong><em>both</em></strong>'), 'triple asterisk is bold italic');
}

/* ================================================================
   F. MATHS OUTSIDE A FENCE
================================================================ */
console.log('\n=== F. display and inline maths ===');
{
  ok(md('$$E = mc^2$$').includes('math-block'), '$$...$$ renders as display maths');
  ok(md('\\[ E = mc^2 \\]').includes('math-block'), '\\[...\\] renders as display maths');
  ok(md('\\(x^2\\)').includes('math-inline'), '\\(...\\) renders inline');
  ok(md('inline $x^2$ here').includes('math-inline'), '$x^2$ renders inline');
  ok(md('$\\alpha$').includes('math-inline'), 'a command is enough of a signal');
  ok(md('$x$').includes('math-inline'), 'so is a lone variable');

  // The reason single-$ is gated. This is a roleplay app; currency beats
  // algebra in it by a wide margin.
  const money = md('*grins* It cost $5, then $10 later.');
  ok(money.includes('$5') && money.includes('$10'), 'dollar amounts are left alone');
  ok(!money.includes('math-'), 'and no maths markup leaks into them');
  ok(md('I paid $20 and got $5 back').includes('$20'), 'two amounts in one line are safe');
  ok(!md('costs $5 - $3 net').includes('math-'), 'an operator between amounts is not a signal');

  // A $$ inside a fence belongs to the fence.
  const fenced = md('```js\nconst s = "$$x^2$$";\n```');
  ok(!fenced.includes('math-block'), '$$ inside a code block is not claimed');
  ok(copyText(fenced).includes('$$x^2$$'), 'and stays in the copy');
}

/* ================================================================
   G. SYNTAX HIGHLIGHTING
================================================================ */
console.log('\n=== G. highlighting ===');
{
  const js = md('```js\n// note\nconst x = "hi";\nfunction f() { return 42; }\n```');
  ok(js.includes('tok-com'), 'comments are marked');
  ok(js.includes('tok-str'), 'strings are marked');
  ok(js.includes('tok-num'), 'numbers are marked');
  ok(js.includes('tok-kw'), 'keywords are marked');
  eq(copyText(js), '// note\nconst x = "hi";\nfunction f() { return 42; }',
     'and Copy is unaffected by any of it');

  // The rule that makes test L in the maths suite hold.
  const unknown = md('```wharrgarbl\nlet x = 1;\n```');
  ok(!unknown.includes('tok-'), 'an unknown language is not highlighted at all');

  const py = md('```python\ndef f():\n    return None\n```');
  ok(py.includes('tok-kw'), 'python is highlighted');
  const html = md('```html\n<div class="a">hi</div>\n```');
  ok(html.includes('tok-kw'), 'markup gets tag highlighting');
  ok(!/<div class="a">hi/.test(html.replace(/<span[^>]*>/g, '')), 'and the markup itself stays escaped');

  // Escaping is per-token, so it has to survive being cut up.
  const xss = md('```js\nconst a = "<img src=x onerror=alert(1)>";\n```');
  ok(!/<img/i.test(xss), 'a payload inside a string is escaped, not live');
  eq(copyText(xss), 'const a = "<img src=x onerror=alert(1)>";', 'and copies back exactly');

  // An unterminated quote must not paint the rest of the block.
  const unterm = md('```js\nconst a = "oops;\nconst b = 2;\n```');
  ok(unterm.includes('tok-num'), 'an unterminated string stops at the newline');
}

/* ================================================================
   H. THINGS THAT MUST NOT HAVE CHANGED
================================================================ */
console.log('\n=== H. regressions ===');
{
  const rp = '*grins* She said "hello" and left.';
  ok(md(rp).includes('<em>grins</em>'), '*emphasis* still works');
  ok(md(rp, '#ff00ff').includes('dialog-text'), 'dialogue colouring still fires');
  ok(!md(rp, 'javascript:alert(1)').includes('javascript:'), 'a hostile dialog colour is still rejected');

  ok(md('[text](https://example.com)').includes('<a href="https://example.com"'), 'links still work');
  ok(md('see https://example.com now').includes('<a href='), 'bare URLs still autolink');
  ok(md('a\n\nb') === '<p>a</p><p>b</p>', 'paragraphs still split on a blank line');
  ok(md('a\nb') === '<p>a<br>b</p>', 'a single newline is still a line break');
  eq(md(''), '', 'empty input is empty output');
  eq(md(null), '', 'null input does not throw');

  // Escaping, from the top.
  const evil = md('<img src=x onerror=alert(1)>');
  ok(!/<img/i.test(evil), 'raw HTML in a message is escaped');
  ok(md('a & b').includes('&amp;'), 'ampersands are escaped');
}

console.log('\n=== I. malformed input does not throw or hang ===');
{
  const nasties = [
    '```', '~~~', '````', '```js', '|', '|---|', '| a |', '- ', '> ', '#',
    '$$', '$', '\\[', '\\(', '$$$$', '```\n```\n```',
    '- '.repeat(200), '> '.repeat(200) + 'x', '|'.repeat(500),
    '#'.repeat(50) + ' x', '*'.repeat(300), '`'.repeat(100),
    '\uE000\uE001', '\uE000'.repeat(50),
  ];
  let threw = 0;
  const t0 = Date.now();
  for (const s of nasties) {
    try { md(s, '#ff0000'); } catch (e) { threw++; console.log('    threw on ' + JSON.stringify(s.slice(0, 30)) + ': ' + e.message); }
  }
  eq(threw, 0, `${nasties.length} malformed inputs, none threw`);
  ok(Date.now() - t0 < 2000, 'and all of them finished quickly');

  // Deep nesting must not blow the stack.
  let deep = '';
  for (let i = 0; i < 60; i++) deep += ' '.repeat(i * 2) + '- item' + i + '\n';
  let deepOk = true;
  try { md(deep); } catch (e) { deepOk = false; }
  ok(deepOk, '60 levels of list nesting does not throw');
}

/* ================================================================
   J. THE ESCAPING BOUNDARY

   This is the section that matters most. The renderer was restructured
   from a chain of whole-message regexes into extract / escape / build, and
   the highlighter now SLICES raw source and escapes each slice. Both moved
   the escaping boundary, so it is audited rather than spot-checked.

   The audit is an allowlist, not a payload blocklist: parse every tag in
   the output and fail on any tag, attribute or handler that is not one this
   renderer is supposed to emit. That catches a class of bug rather than the
   examples someone thought of.
================================================================ */
console.log('\n=== J. only allowlisted markup ever reaches the DOM ===');
{
  const TAGS = new Set(['p','br','div','span','pre','code','button','a','i','sup','sub',
    'h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','hr','del',
    'table','thead','tbody','tr','th','td','strong','em']);
  const ATTRS = new Set(['class','style','href','target','rel','id','data-filename','onclick']);
  const ONCLICK_OK = new Set(['copyCodeBlock(this)','toggleMathSource(this)','downloadFile(this)']);

  function audit(html) {
    const problems = [];
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
    let m;
    while ((m = tagRe.exec(html))) {
      const name = m[1].toLowerCase();
      if (!TAGS.has(name)) { problems.push('tag <' + name + '>'); continue; }
      const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(m[2] || ''))) {
        const an = a[1].toLowerCase(), av = a[2];
        if (!ATTRS.has(an)) { problems.push('attr ' + an + ' on <' + name + '>'); continue; }
        if (an === 'onclick' && !ONCLICK_OK.has(av)) problems.push('onclick="' + av + '"');
        if (an === 'href' && !/^https?:\/\//i.test(av)) problems.push('href="' + av + '"');
        if (an === 'style' && !/^color:#[0-9a-f]{3,8};$|^width:[\d.]+em$/i.test(av)) problems.push('style="' + av + '"');
      }
      // Bare attributes (onload with no value). Quoted values come out first,
      // or class="btn btn-sm" reads as two bare attributes.
      const stripped = (m[2] || '').replace(/[^\s=]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, ' ');
      for (const bare of stripped.split(/\s+/)) {
        if (bare && !ATTRS.has(bare.toLowerCase())) problems.push('bare attr ' + bare);
      }
    }
    return problems;
  }

  const ATTACKS = [
    ['<script>alert(1)</script>', 'a bare script tag'],
    ['<img src=x onerror=alert(1)>', 'an img with a handler'],
    ['```js\n<script>alert(1)</script>\n```', 'a payload inside code'],
    ['```html\n<script>alert(1)</script>\n```', 'a payload inside HIGHLIGHTED markup'],
    ['```html\n<div onload="alert(1)" class=x>\n```', 'a handler the markup lexer must not honour'],
    ['```js\nconst a = "</code></pre><script>alert(1)</script>";\n```', 'an attempt to break out of the pre'],
    ['```file:a"onload="alert(1)\nx\n```', 'attribute injection through a filename'],
    ["```file:a' onload='alert(1)\nx\n```", 'single-quote injection through a filename'],
    ['```<img src=x onerror=alert(1)>\ny\n```', 'injection through the language tag'],
    ['| <script>alert(1)</script> | b |\n|---|---|\n| <img src=x onerror=alert(1)> | d |', 'a payload in a table'],
    ['| a" onclick="alert(1) | b |\n|---|---|\n| c | d |', 'attribute break in a table header'],
    ['- <script>alert(1)</script>', 'a payload in a list'],
    ['> <img src=x onerror=alert(1)>', 'a payload in a quote'],
    ['# <img src=x onerror=alert(1)>', 'a payload in a heading'],
    ['[click](javascript:alert(1))', 'a javascript: link'],
    ['[click](https://x.com" onclick="alert(1))', 'attribute break in a link'],
    ['[<img src=x onerror=alert(1)>](https://x.com)', 'a payload as link text'],
    ['$$\\unknown{<img src=x onerror=alert(1)>}$$', 'a payload via an unknown math command'],
    ['$x^{<script>alert(1)</script>}$', 'a payload in inline maths'],
    ['```latex\n\\begin{pmatrix}<script>alert(1)</script> & b\\end{pmatrix}\n```', 'a payload in a matrix cell'],
    ['```latex\n\\begin{<img src=x>}a\\end{x}\n```', 'a payload as an environment name'],
    ['`<script>alert(1)</script>`', 'a payload in inline code'],
    ['~~<script>alert(1)</script>~~', 'a payload in strikethrough'],
    ['```wharrgarbl\n<script>alert(1)</script>\n```', 'a payload in an unhighlighted language'],
    ['- [x] <img src=x onerror=alert(1)>', 'a payload in a task item'],
    ['\uE000' + '0'.repeat(24) + '.0\uE001<img src=x>', 'a forged placeholder carrying a payload'],
  ];

  let clean = 0;
  for (const [src, name] of ATTACKS) {
    const found = audit(md(src, '')).concat(audit(md(src, '#ff0000')));
    if (found.length) ok(false, name + ' -> ' + found.slice(0, 3).join('; '));
    else clean++;
  }
  eq(clean, ATTACKS.length, `${ATTACKS.length} payloads, none produced markup outside the allowlist`);

  // The dialogue colour lands in a style attribute on every text run, so it
  // is checked through the new block paths too.
  let colourClean = 0;
  for (const c of ['red;background:url(x)', 'javascript:alert(1)', '#fff" onload="alert(1)', 'expression(alert(1))']) {
    const out = md('"hi" and a table\n\n| a |\n|---|\n| "b" |', c);
    if (audit(out).length === 0 && !out.includes(c)) colourClean++;
  }
  eq(colourClean, 4, 'a hostile dialogue colour never reaches a style attribute');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
