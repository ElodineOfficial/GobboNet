/**
 * Item 1 — LaTeX rendering.
 *
 * Runs the REAL renderer and the REAL parseMarkdown out of js/18-utils.js.
 *
 * Three things are being checked, in order of how much they matter:
 *   1. Nothing executes. Every leaf goes through escapeHtml, and the
 *      unknown-command path — the one that echoes input back — is the one
 *      most worth hammering.
 *   2. A corpus of expressions a chat model actually emits renders, rather
 *      than falling through to source.
 *   3. The pass coexists with the rest of parseMarkdown: emphasis, code
 *      fences, dialogue quotes and paragraph wrapping.
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

/* escapeHtml is DOM-based in the browser. Reimplement it exactly here —
   textContent->innerHTML escapes & < >, then " and ' are added. */
const ctx = {
  console,
  escapeHtml: (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  safeCssColor: (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : ''),
  DIALOG_QUOTE_RE: /(?:&quot;)(?:(?!\n\n)[\s\S]){1,400}?(?:&quot;)/g,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(block, ctx);
// parseMarkdown itself, for the integration section.
vm.runInContext(UTILS.slice(UTILS.indexOf('function parseMarkdown(text, dialogColor) {'),
                            UTILS.indexOf('/* ================================================================\n   COLOR PICKER HELPERS')), ctx);

const render = (s) => ctx.renderMathHtml(s);
const text = (html) => html.replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8730;/g, '\u221a');

/* ================================================================
   1. SECURITY — the rules the renderer claims to hold
================================================================ */
console.log('\n=== A. nothing executes ===');
{
  const attacks = [
    ['\\unknown{<img src=x onerror=alert(1)>}',        'roadmap\'s stated case'],
    ['<script>alert(1)</script>',                       'bare script tag'],
    ['\\text{<script>alert(1)</script>}',               'script inside \\text'],
    ['\\frac{<img src=x onerror=alert(1)>}{2}',         'inside a fraction numerator'],
    ['x^{<svg onload=alert(1)>}',                       'inside a superscript'],
    ['\\mathbb{"><img src=x onerror=alert(1)>}',        'attribute-breakout attempt'],
    ['\\sqrt[<b>3</b>]{x}',                             'inside a root index'],
    ['\\hat{<iframe src=javascript:alert(1)>}',         'inside an accent'],
    ['\\<img src=x onerror=alert(1)>',                  'unknown command name is a tag'],
    ['\\onerror=alert(1)',                              'command name looks like a handler'],
  ];
  for (const [src, label] of attacks) {
    const out = render(src);
    const bad = /<(script|img|svg|iframe|b)\b/i.test(out) || /on\w+\s*=/i.test(out) ||
                /javascript:/i.test(out);
    ok(!bad, `no live markup: ${label}`);
  }
  // The payload still survives as text so the user can see what was sent.
  // Math mode eats whitespace, so it comes back without its spaces.
  const shown = text(render('\\unknown{<img src=x onerror=alert(1)>}'));
  ok(shown.includes('img') && shown.includes('onerror') && shown.includes('<'),
     'payload is shown as inert literal text, not swallowed');
}

console.log('\n=== B. no double-escaping across the parseMarkdown boundary ===');
{
  // parseMarkdown escapes the whole message first, so the fence body arrives
  // as entities. mathDecodeEntities must invert that exactly — once.
  eq(ctx.mathDecodeEntities('x &lt; y'), 'x < y', '&lt; decodes');
  eq(ctx.mathDecodeEntities('a &amp;&amp; b'), 'a && b', '&amp; decodes');
  eq(ctx.mathDecodeEntities('&amp;lt;'), '&lt;', '&amp;lt; decodes ONCE, to literal "&lt;"');
  eq(ctx.mathDecodeEntities('&quot;q&quot; &#39;s&#39;'), '"q" \'s\'', 'quote entities decode');

  // A raw < typed into a fence: escaped by parseMarkdown, decoded for the
  // parser, re-escaped on the way out. Exactly once, not twice.
  const out = ctx.parseMarkdown('```latex\nx < y\n```', '');
  ok(!out.includes('&amp;lt;'), 'a raw < in a fence is not double-escaped');
  ok(out.includes('&lt;'), 'and is still escaped exactly once in the output');
  // And a literal "&lt;" typed as text stays literal rather than becoming <.
  const lit = ctx.parseMarkdown('```latex\nx &lt; y\n```', '');
  ok(lit.includes('&amp;lt;'), 'a typed &lt; entity stays literal text');
}

/* ================================================================
   2. CORPUS — expressions a chat model actually emits
================================================================ */
console.log('\n=== C. corpus ===');
{
  // [source, substrings that must appear in the visible text, label]
  const corpus = [
    // everyday arithmetic
    ['2 + 2 = 4',                       ['2', '+', '4'],        'arithmetic'],
    ['3 \\times 4 \\div 2',             ['×', '÷'],             'times / div'],
    ['x \\pm y',                        ['±'],                  'plus-minus'],
    ['50\\%',                           ['%'],                  'escaped percent'],
    ['\\$5',                            ['$'],                  'escaped dollar'],
    // school algebra
    ['x^2 + y^2 = z^2',                 ['2', 'x', 'z'],        'superscripts'],
    ['a_1, a_2, \\ldots, a_n',          ['…', 'a'],             'subscripts + ellipsis'],
    ['x_i^2',                           ['x', 'i', '2'],        'sub and sup on one base'],
    ['\\frac{a}{b}',                    ['a', 'b'],             'fraction'],
    ['\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', ['±', '√', 'b'],    'quadratic formula'],
    ['\\sqrt{2}',                       ['√', '2'],             'square root'],
    ['\\sqrt[3]{8}',                    ['√', '3', '8'],        'cube root'],
    ['(x+1)(x-1)',                      ['(', ')', '−'],        'parens and minus'],
    ['\\frac{1}{2} + \\frac{1}{3}',     ['1', '2', '3'],        'two fractions'],
    // calculus
    ['\\int_0^1 x^2 dx',                ['∫', '0', '1'],        'definite integral'],
    ['\\int_{-\\infty}^{\\infty} e^{-x^2} dx', ['∫', '∞', 'e'], 'gaussian integral'],
    ['\\sum_{i=1}^{n} i',               ['∑', 'n', 'i'],        'summation'],
    ['\\prod_{k=1}^{n} k',              ['∏', 'k'],             'product'],
    ['\\lim_{x \\to 0} \\frac{\\sin x}{x}', ['lim', '→', 'sin'], 'limit'],
    ['\\frac{d}{dx} f(x)',              ['d', 'f'],             'derivative'],
    ['\\frac{\\partial f}{\\partial x}', ['∂', 'f'],            'partial derivative'],
    ['\\nabla f',                       ['∇'],                  'gradient'],
    // linear algebra
    ['A^T A',                           ['A', 'T'],             'transpose'],
    ['\\mathbf{v} \\cdot \\mathbf{w}',  ['v', '·', 'w'],        'dot product'],
    ['\\vec{v}',                        ['→', 'v'],             'vector accent'],
    ['\\hat{x}',                        ['^', 'x'],             'hat accent'],
    ['\\bar{x}',                        ['‾', 'x'],             'bar accent'],
    ['\\|x\\|_2',                       ['x', '2'],             'norm'],
    ['\\det(A) \\neq 0',                ['det', '≠'],           'determinant'],
    ['\\lambda_1 \\geq \\lambda_2',     ['λ', '≥'],             'eigenvalues'],
    // sets and logic
    ['x \\in \\mathbb{R}',              ['∈', 'R'],             'element of reals'],
    ['A \\cup B',                       ['∪'],                  'union'],
    ['A \\cap B \\subseteq C',          ['∩', '⊆'],             'intersection / subset'],
    ['\\forall x \\exists y',           ['∀', '∃'],             'quantifiers'],
    ['P \\Rightarrow Q',                ['⇒'],                  'implication'],
    ['\\emptyset',                      ['∅'],                  'empty set'],
    // ML / stats notation
    ['\\mathcal{L}(\\theta)',           ['L', 'θ'],             'loss function'],
    ['\\hat{y} = \\sigma(w^T x + b)',   ['^', 'σ', 'w'],        'logistic unit'],
    ['\\frac{1}{N} \\sum_{i=1}^{N} (y_i - \\hat{y}_i)^2', ['∑', 'N', '−'], 'MSE'],
    ['\\arg\\max_{\\theta} P(D \\mid \\theta)', ['arg', 'max', 'θ', '∣'], 'MAP estimate'],
    ['\\alpha \\nabla_\\theta J(\\theta)', ['α', '∇', 'J'],     'gradient step'],
    ['\\mathbb{E}[X]',                  ['E', 'X'],             'expectation'],
    ['\\sigma^2 = \\text{Var}(X)',      ['σ', 'Var'],           'variance with \\text'],
    ['p(x \\mid y) \\propto p(y \\mid x) p(x)', ['∣', '∝'],     'Bayes proportionality'],
    // greek and misc
    ['\\alpha \\beta \\gamma \\delta',  ['α', 'β', 'γ', 'δ'],   'greek lowercase'],
    ['\\Omega \\Sigma \\Delta',         ['Ω', 'Σ', 'Δ'],        'greek uppercase'],
    ['\\theta \\approx 3.14',           ['θ', '≈'],             'approx'],
    ['f: X \\to Y',                     ['→', 'f'],             'function signature'],
    ['\\log_2 n',                       ['log', '2', 'n'],      'log with base'],
  ];

  let rendered = 0;
  for (const [src, wants, label] of corpus) {
    const out = render(src);
    const vis = text(out);
    const missing = wants.filter(w => !vis.includes(w));
    const clean = !out.includes('math-unknown');
    ok(missing.length === 0 && clean,
       `${label}${missing.length ? '  missing ' + JSON.stringify(missing) : ''}${clean ? '' : '  [fell through to source]'}`);
    if (missing.length === 0 && clean) rendered++;
  }
  console.log(`  — ${rendered}/${corpus.length} rendered without falling through`);
}

console.log('\n=== D. structure, not just characters ===');
{
  ok(/math-frac[\s\S]*math-num[\s\S]*math-den/.test(render('\\frac{a}{b}')),
     'fraction emits a stacked numerator and denominator');
  ok(/math-radicand/.test(render('\\sqrt{x}')), 'root emits a radicand with an overline');
  ok(/math-limits[\s\S]*math-upper[\s\S]*math-lower/.test(render('\\sum_{i=1}^{n}')),
     'big operator stacks its limits above and below');
  ok(/math-sup-i/.test(render('x^2')) && !/math-limits/.test(render('x^2')),
     'an ordinary base takes an inline superscript, not stacked limits');
  ok(/math-subsup[\s\S]*math-sup[\s\S]*math-sub/.test(render('x_i^2')),
     'a base with both scripts stacks them rather than printing them in sequence');
  ok(/<i class="math-var">x<\/i>/.test(render('x')), 'a lone letter is italicised as a variable');
  ok(!/math-var/.test(render('\\sin')), 'a function name is not italicised');
  ok(/math-f-bb/.test(render('\\mathbb{R}')), 'alphabet commands emit their fixed class');
  ok(/math-f-cal/.test(render('\\mathcal{L}')), 'and \\mathcal likewise');
}

console.log('\n=== E. environments, and what is still a gap ===');
{
  // This section used to assert that matrices fell through to highlighted
  // source, because they did: \\begin parsed as an unknown command and the
  // ratio gate declined the block. Environments are implemented now, so the
  // assertions are inverted -- the gap is closed, not the test relaxed.
  const m = render('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
  ok(!m.includes('math-unknown'), 'a matrix no longer falls through to source');
  ok(m.includes('math-env') && m.includes('math-grid'), 'it lays out as a grid');
  ok(m.includes('math-d-paren-l') && m.includes('math-d-paren-r'), 'with its own delimiters');
  ok(m.includes('math-cols-2'), 'two columns, taken from the widest row');
  ok(!/<(script|img)\b/i.test(m), 'the environment path is still escaped');

  // Rows split on \\, cells on &.
  const cells = (m.match(/class="math-cell"/g) || []).length;
  eq(cells, 4, '2x2 gives four cells');

  // A literal \\& is content, not a separator.
  const amp = render('\\begin{matrix} a \\& b \\end{matrix}');
  eq((amp.match(/class="math-cell"/g) || []).length, 1, 'an escaped ampersand does not split a cell');

  // Alignment environments align on the relation.
  const al = render('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}');
  ok(al.includes('math-al-rl'), 'aligned uses right/left column alignment');
  ok(!al.includes('math-d-'), 'and draws no delimiters');

  ok(render('\\begin{cases} x & x>0 \\end{cases}').includes('math-d-brace-l'),
     'cases gets an opening brace and no closing one');

  // Still a gap, and still declining by arithmetic rather than by a list:
  // an environment nobody implemented leaves \\begin and \\end unknown.
  const tikz = render('\\begin{tikzpicture} \\draw (0,0); \\end{tikzpicture}');
  ok(tikz.includes('math-unknown'), 'an unimplemented environment still falls through');

  // Never worse than the status quo: unknown input must still show its text.
  const junk = render('\\somethingnobodyimplemented{q}');
  ok(text(junk).includes('somethingnobodyimplemented') && text(junk).includes('q'),
     'unknown command shows its name and its argument');
}

/* ================================================================
   3. INTEGRATION — coexistence with the rest of parseMarkdown
================================================================ */
console.log('\n=== F. fences ===');
{
  const out = ctx.parseMarkdown('```latex\n\\frac{a}{b}\n```', '');
  ok(out.includes('math-block'), '```latex renders as a math block');
  ok(out.includes('math-frac'), 'and the fraction is rendered');
  ok(out.includes('toggleMathSource'), 'with a Source toggle');
  ok(out.includes('copyCodeBlock'), 'and a Copy button');
  ok(/<pre class="math-source"><code>[\s\S]*frac/.test(out), 'source is retained for the toggle');

  ok(ctx.parseMarkdown('```math\nx^2\n```', '').includes('math-block'), '```math is accepted too');
  ok(ctx.parseMarkdown('```tex\nx^2\n```', '').includes('math-block'), '```tex is accepted too');

  const js = ctx.parseMarkdown('```js\nconst x = 1;\n```', '');
  ok(js.includes('code-block') && !js.includes('math-block'), '```js is untouched');
  const plain = ctx.parseMarkdown('```\nplain\n```', '');
  ok(plain.includes('code-block') && !plain.includes('math-block'), 'an untagged fence is untouched');
}

console.log('\n=== G. maths, emphasis and code in one message ===');
{
  const msg = 'Here is *emphasis* and **bold**:\n\n```latex\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n```\n\nAnd `inline code` after.';
  const out = ctx.parseMarkdown(msg, '');
  ok(/<em>emphasis<\/em>/.test(out), 'italic still works around a math block');
  ok(/<strong>bold<\/strong>/.test(out), 'bold still works');
  ok(/<code>inline code<\/code>/.test(out), 'inline code still works');
  ok(out.includes('math-limits'), 'the maths still rendered');
  ok(!/<p>\s*<div class="math-block">/.test(out), 'the math block is not left wrapped in a stray <p>');

  // The renderer must never emit a bare * — parseMarkdown's emphasis pass
  // runs over its output and would eat it.
  const star = render('a * b \\ast c \\star d');
  ok(!star.includes('*'), 'renderer emits no literal asterisk for the emphasis pass to catch');
  const roundTrip = ctx.parseMarkdown('```latex\na * b * c\n```', '');
  ok(!/<em>/.test(roundTrip) && !/<strong>/.test(roundTrip),
     'asterisks in the source view do not become emphasis');
  ok(roundTrip.includes('&#42;'), 'the source view neutralises them as entities');
  // Copy reads textContent, so the entities must decode back to real bytes.
  const src = /<pre class="math-source"><code>([\s\S]*?)<\/code>/.exec(roundTrip)[1];
  const asTextContent = src.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
                           .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  eq(asTextContent, 'a * b * c', 'Copy yields the exact bytes the model sent');

  ok(!/&&#/.test(roundTrip), 'entity escaping does not re-scan its own output');
  eq(ctx.mathSourceSafe('a * b # c - d'), 'a &#42; b &#35; c &#45; d',
     'each trigger character maps once, in a single pass');

  const multi = ctx.parseMarkdown('```latex\n\\frac{a}{b}\n# not a heading\n- not a bullet\n```', '');
  ok(!/<strong style="font-size:1.2em/.test(multi), 'a # line in the source is not turned into a heading');
  ok(!multi.includes('&bull;'), 'a - line in the source is not turned into a bullet');
  ok(!/<pre class="math-source">[\s\S]*<\/p><p>/.test(multi), 'blank lines do not inject </p><p> into the pre');
}

console.log('\n=== H. roleplay text is unharmed ===');
{
  // The delimiter worry from the roadmap, checked from the other side: the
  // math pass is fence-scoped, so prose must be completely untouched.
  const rp = '*grins* It cost $5, then $10 later. x_i and a^b in prose.';
  const out = ctx.parseMarkdown(rp, '');
  ok(/<em>grins<\/em>/.test(out), '*grins* still italicises');
  ok(out.includes('$5') && out.includes('$10'), 'dollar amounts are left alone');
  ok(!out.includes('math-'), 'no math markup leaks into prose');
  ok(out.includes('x_i'), 'underscores in prose are untouched');

  const dlg = ctx.parseMarkdown('"Hello there," she said.', '#ff00ff');
  ok(dlg.includes('dialog-text'), 'dialogue colouring still fires');
}

console.log('\n=== I. malformed input does not throw or hang ===');
{
  const nasty = [
    ['\\frac{a', 'unclosed brace'],
    ['}}}{{{', 'unbalanced braces'],
    ['\\frac', 'command with no arguments'],
    ['x^', 'trailing caret'],
    ['x_', 'trailing underscore'],
    ['\\', 'lone backslash'],
    ['\\sqrt[', 'unclosed optional argument'],
    ['^^^___', 'only scripts'],
    ['', 'empty string'],
    ['{'.repeat(200), 'deeply nested open braces'],
    ['\\frac{'.repeat(60) + 'x', 'deeply nested fractions'],
  ];
  for (const [src, label] of nasty) {
    let threw = false, out = '';
    const t0 = Date.now();
    try { out = render(src); } catch (e) { threw = true; }
    const ms = Date.now() - t0;
    ok(!threw && ms < 1000, `${label} — no throw, ${ms}ms`);
    ok(typeof out === 'string', `${label} — returns a string`);
  }
  ok(render(null) === '' || typeof render(null) === 'string', 'null input is tolerated');
  ok(typeof render(undefined) === 'string', 'undefined input is tolerated');
}

console.log('\n=== J. tags are balanced ===');
{
  // Unbalanced output would corrupt the rest of the message, which is a
  // worse failure than rendering the maths wrong.
  const samples = ['\\frac{a}{b}', '\\sqrt[3]{x}', '\\sum_{i=1}^{n}', 'x_i^2',
                   '\\hat{x}', '\\mathbb{R}', '\\frac{a', '}}}{{{', '\\text{hi}'];
  for (const s of samples) {
    const out = render(s);
    const open = (out.match(/<(?!\/)([a-z]+)[^>]*>/g) || []).filter(t => !/\/>$/.test(t) && !/^<br/.test(t)).length;
    const close = (out.match(/<\/[a-z]+>/g) || []).length;
    ok(open === close, `balanced tags: ${JSON.stringify(s)} (${open} open, ${close} close)`);
  }
}


console.log('\n=== K. fence tag tolerance ===');
{
  // ```LaTeX is the spelling models reach for most often, and the first cut
  // of this feature missed every one of them.
  const forms = ['latex', 'LaTeX', 'Latex', 'LATEX', 'TeX', 'tex', 'math',
                 'katex', 'equation', 'displaymath'];
  for (const tag of forms) {
    ok(ctx.parseMarkdown('```' + tag + '\n\\frac{a}{b}\n```', '').includes('math-block'),
       `tag accepted: \`\`\`${tag}`);
  }
  ok(ctx.parseMarkdown('```latex \n\\frac{a}{b}\n```', '').includes('math-block'),
     'trailing space after the tag is tolerated');
  ok(ctx.parseMarkdown('```latex\r\n\\frac{a}{b}\r\n```', '').includes('math-block'),
     'CRLF line endings are tolerated');
  ok(!ctx.parseMarkdown('```latexish\nx\n```', '').includes('math-block'),
     'a tag that merely starts with latex is NOT claimed');
  // The label is not a diagnostic: the generic handler lowercases too, so a
  // missed ```LaTeX used to show a header reading "latex" anyway.
  const lbl = /class="code-lang">([^<]*)</.exec(ctx.parseMarkdown('```LaTeX\n\\frac{a}{b}\n```', ''));
  eq(lbl[1], 'latex', 'header label is normalised to lowercase');
}

console.log('\n=== L. declining: a document is not an expression ===');
{
  // The real report. A model asked for "LaTeX in a code block" emits a whole
  // document; typesetting it gives run-together prose and a wall of amber.
  const doc = [
    'Here is an example:',
    '```latex',
    '\\documentclass{article}',
    '\\begin{document}',
    '# Example Title',
    'This is a simple example of LaTeX document.',
    '\\begin{itemize}',
    '  \\item Item 1',
    '\\end{itemize}',
    '\\end{document}',
    '```',
    'You can paste that into a compiler.',
  ].join('\n');
  const out = ctx.parseMarkdown(doc, '');
  ok(!out.includes('math-block'), 'a LaTeX document is not rendered as maths');
  ok(out.includes('code-block'), 'it falls back to an ordinary code block');
  ok(!out.includes('math-unknown'), 'and produces no amber spans');
  ok(out.includes('documentclass'), 'the source is still shown in full');

  // Each gate on its own.
  const declines = [
    ['\\documentclass{article}\nx', 'documentclass'],
    ['\\begin{document}\nx^2\n\\end{document}', 'begin{document}'],
    ['\\section{Intro}\nx^2', 'section'],
    ['\\begin{itemize}\n\\item a\n\\end{itemize}', 'itemize'],
    ['This is a simple example of a document.', 'a line of prose'],
    ['hello world', 'plain text with no maths'],
    ['\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}', 'an unimplemented environment'],
  ];
  for (const [body, label] of declines) {
    const o = ctx.parseMarkdown('```latex\n' + body + '\n```', '');
    ok(!o.includes('math-block') && o.includes('code-block'), `declines: ${label}`);
  }

  // ...and the things that must still render.
  const renders = [
    ['\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', 'quadratic formula'],
    ['\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', 'summation identity'],
    ['x^2 + y^2 = z^2', 'no commands at all'],
    ['2 + 2 = 4', 'bare arithmetic'],
    ['a * b * c', 'operators without commands'],
    ['\\int_0^1 x^2 dx', 'integral'],
    ['E = mc^2', 'short famous one'],
    ['\\mathcal{L}(\\theta) = -\\log p(y \\mid x)', 'ML notation'],
    ['\\text{Var}(X) = \\sigma^2', 'a \\text run does not read as prose'],
  ];
  for (const [body, label] of renders) {
    const o = ctx.parseMarkdown('```latex\n' + body + '\n```', '');
    ok(o.includes('math-block'), `still renders: ${label}`);
  }

  // Declining must be free: identical to life before the feature.
  const declined = ctx.parseMarkdown('```latex\n\\documentclass{article}\n```', '');
  const plain = ctx.parseMarkdown('```\n\\documentclass{article}\n```', '');
  eq(declined.replace(/>latex</, '>code<'), plain, 'a declined block is byte-identical to an untagged fence');
}

console.log('\n=== M. nested fences do not corrupt the message ===');
{
  // Same-length nested fences are ambiguous to a reader but not to the
  // spec: a closing fence is a line of backticks ALONE, so ```latex on its
  // own line is CONTENT of the outer block, not a close.
  //
  // This assertion used to be "no backticks survive into the output", which
  // was true only because the old scanner closed at the first ``` it saw
  // and threw the rest away. The scanner is CommonMark-correct now and
  // keeps them, so the meaningful property is where they end up: inside a
  // <pre> as inert escaped text, never loose in the message.
  const nested = '```latex\n\\frac{a}{b}\n```latex\nx^2\n```\n```';
  const out = ctx.parseMarkdown(nested, '');
  ok(!/<script/i.test(out), 'nothing executable emerges from the ambiguity');

  const outsidePre = out.replace(/<pre[\s\S]*?<\/pre>/g, '');
  ok(!outsidePre.includes('```'), 'no fence marker is left loose in the message');
  ok(!/math-rendered[^<]*```/.test(out), 'and none is typeset as if it were maths');

  // A body carrying a fence marker is not one expression, so the maths pass
  // declines it and the ordinary code block takes it.
  ok(out.includes('code-block'), 'the ambiguous block renders as code');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
