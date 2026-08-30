/* @gobbonet-split js/18-utils.js
   Moved verbatim from chat.html lines 10768-11310.
   utilities, colour picker, attachments, input, file blocks
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   UTILITIES
================================================================ */
function copyMessage(index) {
  const thread = getActiveThread();
  if (!thread || !thread.messages[index]) return;
  const m = thread.messages[index];
  const text = m.content || m.reasoning || '';

  // Find the Copy button for this message so we can flash feedback on it.
  // The button lives inside .message[data-index] or we fall back to the event target.
  function flashBtn(success) {
    const msgEl = document.querySelector(`.message[data-index="${index}"]`);
    const btn = msgEl && msgEl.querySelector('.msg-action-btn[onclick*="copyMessage"]');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = success ? '✓ OK' : '✗ ERR';
    btn.style.opacity = '0.7';
    setTimeout(() => { btn.textContent = orig; btn.style.opacity = ''; }, 1400);
  }

  // Modern async API (HTTPS / secure contexts)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flashBtn(true)).catch(() => {
      execCommandFallback();
    });
    return;
  }
  execCommandFallback();

  // Legacy fallback — works on HTTP and older mobile browsers
  function execCommandFallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flashBtn(ok);
    } catch (e) {
      flashBtn(false);
    }
  }
}

/**
 * Copy the text of a code/file block to the clipboard.
 * `btn` is the clicked Copy button; we read the sibling <pre><code> within
 * the same .code-block / .file-block container. Reading from the DOM (rather
 * than passing the code as an onclick arg) sidesteps any escaping headaches
 * with code that contains quotes, backticks, or angle brackets.
 */
function copyCodeBlock(btn) {
  // .math-block is included so its Copy button yields the LaTeX source
  // rather than the rendered glyphs — the source pre is the only
  // <pre><code> in that block, so the existing lookup finds it unchanged.
  const block = btn.closest('.code-block, .file-block, .math-block');
  const codeEl = block && block.querySelector('pre code');
  if (!codeEl) return;
  const text = codeEl.textContent;

  function flash(success) {
    const orig = btn.textContent;
    btn.textContent = success ? '✓ Copied' : '✗ Failed';
    btn.classList.toggle('code-copy-ok', success);
    btn.classList.toggle('code-copy-err', !success);
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('code-copy-ok', 'code-copy-err');
    }, 1400);
  }

  // Modern async clipboard (secure contexts)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(true)).catch(execCommandFallback);
    return;
  }
  execCommandFallback();

  // Legacy fallback — works on plain HTTP / older mobile browsers, which
  // matters here since Gobbonet is typically served over LAN http://.
  function execCommandFallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flash(ok);
    } catch (e) {
      flash(false);
    }
  }
}

function escapeHtml(str) {
  // textContent -> innerHTML handles &, <, > but NOT " or ' -- the HTML5
  // text-node serializer deliberately leaves attribute-delimiter characters
  // alone (they're only special in attribute context, not text). We add
  // them ourselves so the same escaped string is safe in BOTH contexts:
  // inside <span>...</span> and inside href="...". Browsers decode &quot;
  // and &#39; back to " and ' in either context, so no display regression.
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// For a value going into an inline handler: onclick="fn('${...}')".
//
// escapeHtml alone is NOT enough there. The HTML parser decodes character
// references in an attribute value BEFORE the JS is compiled, so escapeHtml's
// &#39; turns back into a real ' and closes the string literal -- the classic
// way an "escaped" id or filename still ends up executing. Escape for the JS
// layer first (backslash before quotes, or we'd double-escape our own output),
// then run escapeHtml over the result for the attribute layer. \r \n and the
// two Unicode line separators are terminators inside a JS string literal.
function escapeJsString(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeJsAttr(str) {
  return escapeHtml(escapeJsString(str));
}

// Colors ride into style="color:${...}" attributes from character cards, which
// can arrive from an imported file or a synced peer. Escaping is the wrong tool
// for a CSS context -- allowlist the shapes a color picker actually produces and
// drop anything else, so there is no value that reaches the CSS parser at all.
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/;
function safeCssColor(value, fallback) {
  const s = String(value == null ? '' : value).trim();
  if (CSS_COLOR_RE.test(s)) return s;
  return fallback || '';
}

/**
 * The single gate for every image URL that reaches the DOM: avatars, card
 * backgrounds, attachment thumbnails.
 *
 * Inline image data (data:) and locally-created object URLs (blob:) are always
 * fine -- the bytes are already on this machine and nothing is fetched.
 *
 * http(s) is different. A card can arrive from an imported file or a synced
 * peer, and an <img src> pointing at a remote host beacons the viewer's IP the
 * moment it renders. In an app whose whole premise is that nothing leaves the
 * machine, that is a real leak, and it fires without a click. So it is gated
 * on an explicit opt-in that defaults to off.
 *
 * file: is dropped outright. A page served over http from launch.bat cannot
 * load file: URLs -- browsers block the cross-scheme reference -- so it has
 * never worked here and removing it is not a regression.
 *
 * Returns '' for anything not permitted. Callers must treat '' as "no image"
 * and fall back, never render an empty src.
 */
function safeImageUrl(value) {
  const s = String(value == null ? '' : value).trim();
  // Raster formats only. svg+xml is deliberately absent: an SVG is a document
  // rather than a bitmap, and while <img> blocks script inside one, widening a
  // security allowlist for a format nothing here produces is a bad trade.
  if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=\s]*$/i.test(s)) return s;
  if (/^blob:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) {
    return (typeof state !== 'undefined' && state && state.settings && state.settings.allowRemoteImages) ? s : '';
  }
  return '';
}

/** True when a value is a remote URL the current setting is suppressing.
 *  Drives the one-time notice and the per-card editor hint. */
function isSuppressedRemoteImage(value) {
  const s = String(value == null ? '' : value).trim();
  return /^https?:\/\//i.test(s) &&
         !(typeof state !== 'undefined' && state && state.settings && state.settings.allowRemoteImages);
}

// Retained under its original name for the attachment path, which only ever
// holds locally-produced data:/blob: URLs.
function safeDataUrl(value) {
  return safeImageUrl(value);
}

function parseSearchData(raw) {
  if (!raw) return '';
  // Parse the structured format: - Title: content\n  Source: url\n
  const lines = raw.split('\n');
  let html = '';
  let currentTitle = '';
  let currentContent = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      // Flush previous entry
      if (currentTitle) html += buildSearchEntry(currentTitle, currentContent, '');
      // Parse "- Title: content"
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 2) {
        currentTitle = trimmed.slice(2, colonIdx).trim();
        currentContent = trimmed.slice(colonIdx + 1).trim();
      } else {
        currentTitle = trimmed.slice(2);
        currentContent = '';
      }
    } else if (trimmed.startsWith('Source:')) {
      const url = trimmed.slice(7).trim();
      html += buildSearchEntry(currentTitle, currentContent, url);
      currentTitle = '';
      currentContent = '';
    }
  }
  // Flush last entry if no Source line
  if (currentTitle) html += buildSearchEntry(currentTitle, currentContent, '');
  
  return html || escapeHtml(raw).replace(/\n/g, '<br>');
}

function buildSearchEntry(title, content, url) {
  const safeTitle = escapeHtml(title);
  const safeContent = escapeHtml(content);
  if (url) {
    const safeUrl = escapeHtml(url);
    // Only allow http(s) URLs to prevent javascript: XSS.
    // Use safeUrl (HTML-escaped) in the href so a literal " in the URL
    // can't break out of the attribute and inject event handlers.
    // The browser decodes entities natively inside href, so &amp; etc.
    // still navigate correctly.
    if (/^https?:\/\//i.test(url)) {
      return `<div class="search-entry"><a href="${safeUrl}" target="_blank" rel="noopener" class="search-entry-title">${safeTitle}</a><div class="search-entry-content">${safeContent}</div><div class="search-entry-url">${safeUrl}</div></div>`;
    }
    return `<div class="search-entry"><div class="search-entry-title">${safeTitle}</div><div class="search-entry-content">${safeContent}</div><div class="search-entry-url">${safeUrl}</div></div>`;
  }
  return `<div class="search-entry"><div class="search-entry-title">${safeTitle}</div><div class="search-entry-content">${safeContent}</div></div>`;
}

/* Quote styles a model might use for speech.
 *
 * Three things this has to survive, all of which broke earlier versions:
 *
 * 1. ESCAPING ASYMMETRY. escapeHtml() turns " into &quot; and leaves every
 *    other quote character as a literal, so the straight case must match
 *    the entity and the rest must match the raw character.
 *
 * 2. MIXED DELIMITERS. A model will open with " and close with ” in the
 *    same breath, or drift from straight to curly halfway down a message.
 *    Requiring a matching pair made colouring look random. The double-quote
 *    family below therefore accepts any opener paired with any closer,
 *    which also gets German „...“ for free -- there, “ is the CLOSING mark.
 *
 * 3. RUNAWAY MATCHES. [\s\S]+? crosses newlines, so one unpaired quote
 *    could pair with another five lines later and colour the narration in
 *    between. The inner text is bounded to 400 characters and forbidden
 *    from crossing a blank line, so a stray quote fails to match instead of
 *    painting half the message.
 *
 * Single curly quotes are deliberately absent: ’ is far more often an
 * apostrophe than a closing quote, and treating it as a delimiter would
 * mis-colour more text than it fixed.
 */
const DIALOG_INNER = '(?:(?!\\n\\n)[\\s\\S]){1,400}?';
const DIALOG_QUOTE_RE = new RegExp(
  // CJK corner brackets - unambiguous, so matched as strict pairs.
  '\\u300c' + DIALOG_INNER + '\\u300d' + '|' +   // 「...」
  '\\u300e' + DIALOG_INNER + '\\u300f' + '|' +   // 『...』
  // Guillemets, both widths.
  '\\u00ab' + DIALOG_INNER + '\\u00bb' + '|' +   // «...»
  '\\u2039' + DIALOG_INNER + '\\u203a' + '|' +   // ‹...›
  // Double-quote family: any opener, any closer. Covers "...", “...”,
  // German „...“, and every mixed combination a model produces.
  '(?:&quot;|[\\u201c\\u201e\\u201f])' + DIALOG_INNER + '(?:&quot;|[\\u201d\\u201c\\u201f])',
  'g'
);

/* ================================================================
   MATH RENDERER

   ~110 symbols and a recursive-descent parser for the subset of LaTeX a
   chat model actually emits. No dependency, no CDN, no vendored fonts —
   which is the point: this ships inside the NSIS installer and the Linux
   packages, and the privacy premise means it can never fetch anything.

   SCOPE. This renders maths recognisably, not perfectly. Known gaps, all
   deliberate:
     - No matrix or aligned environments (\begin{pmatrix} etc). They fall
       through to the unknown-command path and show their source.
     - No growing delimiters. \left( \frac{a}{b} \right) draws fixed-size
       parens; real TeX scales them to the fraction.
     - No nested script shrinking (scriptstyle / scriptscriptstyle).
     - Spacing is approximate. TeX distinguishes operators, relations and
       punctuation and spaces each differently; we give relations and
       binary operators a flat margin and leave it there.
   The trade is deliberate: "recognisably correct" with a readable 300
   lines beats "typographically perfect" with 280 KB of parser plus a
   megabyte of Computer Modern.

   SECURITY. This consumes model output, imported character cards, and
   synced state from paired LAN devices — the same untrusted inputs the
   escaping work covered. Two rules hold throughout, and every function
   below obeys them:
     1. Every character that reaches the output goes through escapeHtml().
        No exceptions, including the fixed symbol table, so there is one
        rule to audit rather than a list of trusted sources.
     2. Class names are fixed literals. Nothing from the input is ever
        interpolated into a tag, an attribute, or a style.
   Nothing here touches innerHTML and nothing evaluates anything.
================================================================ */

/* Command → the character it prints. Fixed table; nothing is computed. */
const MATH_SYMBOLS = {
  // Greek, lower
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // Greek, upper
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Relations
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', in: '∈', notin: '∉',
  ni: '∋', perp: '⊥', parallel: '∥', mid: '∣', doteq: '≐',
  // Binary operators
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  circ: '∘', bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘',
  odot: '⊙', cap: '∩', cup: '∪', setminus: '∖', wedge: '∧', vee: '∨',
  triangleq: '≜',
  // Arrows
  rightarrow: '→', to: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', implies: '⟹', Leftarrow: '⇐', Leftrightarrow: '⇔',
  iff: '⟺', mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵',
  uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
  // Misc symbols
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  nexists: '∄', emptyset: '∅', varnothing: '∅', neg: '¬', lnot: '¬',
  angle: '∠', triangle: '△', square: '□', diamond: '⋄', dagger: '†',
  prime: '′', ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  surd: '√', top: '⊤', bot: '⊥', flat: '♭', sharp: '♯', natural: '♮',
  checkmark: '✓', dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  degree: '°', percent: '%',
  // Delimiters that arrive as commands
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  lbrace: '{', rbrace: '}', vert: '|', Vert: '‖', backslash: '\\',
};

/* Big operators. Scripts attached to these stack above and below rather
   than sitting beside, which is the single biggest visual cue that maths
   is being typeset rather than printed. */
const MATH_BIGOPS = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
  bigvee: '⋁', bigwedge: '⋀', bigsqcup: '⨆', lim: 'lim', limsup: 'lim sup',
  liminf: 'lim inf', max: 'max', min: 'min', sup: 'sup', inf: 'inf',
  argmax: 'arg max', argmin: 'arg min',
};

/* Function names: upright roman, not italic. \sin x, not 𝑠𝑖𝑛 𝑥. */
const MATH_FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'det', 'dim',
  'ker', 'deg', 'gcd', 'hom', 'arg', 'Pr', 'mod', 'bmod',
]);

/* Accents: command → the mark drawn over the base. */
const MATH_ACCENTS = {
  hat: '^', widehat: '^', tilde: '~', widetilde: '~', bar: '‾', overline: '‾',
  vec: '→', dot: '·', ddot: '··', acute: '´', grave: '`', check: 'ˇ',
  breve: '˘', mathring: '˚',
};

/* Alphabet styling. Values are class-name suffixes, chosen from this fixed
   table only — never taken from input. */
const MATH_FONTS = {
  mathcal: 'cal', mathbb: 'bb', mathbf: 'bf', mathrm: 'rm', mathit: 'it',
  mathsf: 'sf', mathtt: 'tt', mathfrak: 'frak', boldsymbol: 'bf',
  textbf: 'bf', textit: 'it', textrm: 'rm', operatorname: 'rm',
};

/* Explicit spacing commands → em widths. */
const MATH_SPACES = {
  ',': 0.17, ':': 0.22, ';': 0.28, '!': -0.17, ' ': 0.25,
  quad: 1, qquad: 2, thinspace: 0.17, enspace: 0.5,
};

/* Characters TeX puts air around. Approximate — see SCOPE above. */
const MATH_SPACED = new Set([
  '+', '−', '=', '<', '>', '±', '∓', '×', '÷', '≤', '≥', '≠', '≈', '≡',
  '→', '←', '↔', '⇒', '⇐', '⇔', '∈', '∉', '⊂', '⊃', '⊆', '⊇', '∪', '∩',
  '∧', '∨', '⊕', '⊗', '∼', '≃', '≅', '∝', '≪', '≫', '⟹', '⟸', '⟺', '↦',
]);

/* Inverse of escapeHtml, and nothing more.
 *
 * parseMarkdown escapes the whole message before it looks for fences, so by
 * the time a ```latex body reaches the renderer its `< > & " '` are already
 * entities. The renderer parses raw LaTeX and re-escapes every leaf itself
 * (rule 1 above), so it needs the raw text back.
 *
 * This exists for that one boundary. It must never be used to build HTML —
 * its output goes straight into the tokenizer and comes back out through
 * escapeHtml. &amp; is decoded LAST so "&amp;lt;" ends up as the literal
 * text "&lt;" rather than being decoded twice into "<".
 */
function mathDecodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ── Tokenizer ──────────────────────────────────────────────────── */

function mathTokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const rest = src.slice(i + 1);
      const word = /^[a-zA-Z]+/.exec(rest);
      if (word) { out.push({ t: 'cmd', v: word[0] }); i += 1 + word[0].length; continue; }
      // \\ is a line break; \{ \$ \% and friends are literal characters.
      const next = src[i + 1];
      if (next === '\\') { out.push({ t: 'br' }); i += 2; continue; }
      if (next === undefined) { out.push({ t: 'chr', v: '\\' }); i += 1; continue; }
      if (Object.prototype.hasOwnProperty.call(MATH_SPACES, next)) {
        out.push({ t: 'space', v: MATH_SPACES[next] }); i += 2; continue;
      }
      out.push({ t: 'chr', v: next, literal: true }); i += 2; continue;
    }
    if (c === '{') { out.push({ t: '{' }); i++; continue; }
    if (c === '}') { out.push({ t: '}' }); i++; continue; }
    if (c === '^') { out.push({ t: '^' }); i++; continue; }
    if (c === '_') { out.push({ t: '_' }); i++; continue; }
    if (c === '\n') { out.push({ t: 'br' }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }  // math mode eats whitespace
    if (c === '-') { out.push({ t: 'chr', v: '−' }); i++; continue; }   // proper minus
    if (c === '*') { out.push({ t: 'chr', v: '∗' }); i++; continue; }   // never emit a literal *
    if (c === "'") { out.push({ t: 'chr', v: '′' }); i++; continue; }
    out.push({ t: 'chr', v: c }); i++;
  }
  return out;
}

/* ── Environments ───────────────────────────────────────────────
 *
 * Matrices, cases and aligned equations: the "columns and grids" of maths,
 * and until now every one of them was declined. \begin{pmatrix} parsed as
 * two unknown commands, the ratio gate saw 2/2 unknown and correctly handed
 * the block to the plain code renderer. The gate was right; the gap was that
 * nothing implemented them.
 *
 * A LaTeX environment body IS a grid -- rows split on \\, cells on & -- so
 * CSS grid does the layout natively and there is no table markup, no
 * absolute positioning and no measuring.
 *
 * Every value here is a FIXED class-name fragment. The environment name
 * selects a row from this table; it is never interpolated into the output.
 * `align` is the column alignment, `l`/`r` the delimiter shapes.
 */
const MATH_ENVS = {
  matrix:      { align: 'c', l: '',       r: ''       },
  pmatrix:     { align: 'c', l: 'paren-l', r: 'paren-r' },
  bmatrix:     { align: 'c', l: 'brack-l', r: 'brack-r' },
  Bmatrix:     { align: 'c', l: 'brace-l', r: 'brace-r' },
  vmatrix:     { align: 'c', l: 'bar',     r: 'bar'     },
  Vmatrix:     { align: 'c', l: 'dbar',    r: 'dbar'    },
  smallmatrix: { align: 'c', l: '',        r: ''        },
  array:       { align: 'c', l: '',        r: ''        },
  cases:       { align: 'l', l: 'brace-l', r: ''        },
  aligned:     { align: 'rl', l: '',       r: ''        },
  align:       { align: 'rl', l: '',       r: ''        },
  alignat:     { align: 'rl', l: '',       r: ''        },
  split:       { align: 'rl', l: '',       r: ''        },
  gathered:    { align: 'c', l: '',        r: ''        },
  gather:      { align: 'c', l: '',        r: ''        },
};

/* Grid column counts and delimiter heights are expressed as fixed classes
   rather than an inline style, so the "nothing from input reaches an
   attribute" rule survives. Ten columns and eight rows cover every matrix a
   chat model has any business emitting; beyond that the extra cells wrap,
   which is degraded but still legible. */
const MATH_ENV_MAX_COLS = 10;
const MATH_ENV_MAX_ROWS = 8;

/* ── Parser ─────────────────────────────────────────────────────── */
/* Produces a node array. Node kinds: chr, sym, op, fn, frac, sqrt, accent,
   font, text, space, br, group, script, env, unknown. */

function mathParse(tokens) {
  let pos = 0;

  function atEnd() { return pos >= tokens.length; }

  /* One atom, before any ^ / _ are attached. */
  function parseAtom() {
    const tk = tokens[pos];
    if (!tk) return null;

    if (tk.t === '{') { pos++; return { k: 'group', body: parseUntilClose() }; }
    if (tk.t === '}') { pos++; return null; }             // stray close — drop it
    if (tk.t === 'br') { pos++; return { k: 'br' }; }
    if (tk.t === 'space') { pos++; return { k: 'space', em: tk.v }; }
    if (tk.t === 'chr') { pos++; return { k: 'chr', v: tk.v, literal: !!tk.literal }; }
    if (tk.t === '^' || tk.t === '_') return null;        // handled by the caller

    // tk.t === 'cmd'
    const name = tk.v;
    pos++;

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      return { k: 'frac', num: parseArg(), den: parseArg() };
    }
    if (name === 'binom' || name === 'dbinom') {
      return { k: 'binom', top: parseArg(), bot: parseArg() };
    }
    if (name === 'sqrt') {
      const root = parseOptionalArg();
      return { k: 'sqrt', root, body: parseArg() };
    }
    if (name === 'text' || name === 'textnormal' || name === 'mbox') {
      return { k: 'text', v: parseRawArg() };
    }
    if (Object.prototype.hasOwnProperty.call(MATH_ACCENTS, name)) {
      return { k: 'accent', mark: MATH_ACCENTS[name], body: parseArg() };
    }
    if (Object.prototype.hasOwnProperty.call(MATH_FONTS, name)) {
      return { k: 'font', cls: MATH_FONTS[name], body: parseArg() };
    }
    if (Object.prototype.hasOwnProperty.call(MATH_BIGOPS, name)) {
      return { k: 'op', v: MATH_BIGOPS[name] };
    }
    if (MATH_FUNCS.has(name)) return { k: 'fn', v: name };
    if (Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, name)) {
      return { k: 'sym', v: MATH_SYMBOLS[name] };
    }
    if (Object.prototype.hasOwnProperty.call(MATH_SPACES, name)) {
      return { k: 'space', em: MATH_SPACES[name] };
    }
    // \left and \right: consume the command, keep the delimiter at its
    // natural size. Documented gap — see SCOPE.
    if (name === 'left' || name === 'right' || name === 'bigl' || name === 'bigr' ||
        name === 'big' || name === 'Big' || name === 'biggl' || name === 'biggr') {
      const d = tokens[pos];
      if (d && (d.t === 'chr' || d.t === 'cmd')) {
        pos++;
        if (d.t === 'chr') return d.v === '.' ? { k: 'space', em: 0 } : { k: 'chr', v: d.v };
        const sym = MATH_SYMBOLS[d.v];
        return sym ? { k: 'sym', v: sym } : { k: 'unknown', v: d.v };
      }
      return { k: 'space', em: 0 };
    }
    if (name === 'displaystyle' || name === 'textstyle' || name === 'limits' ||
        name === 'nolimits' || name === 'scriptstyle') {
      return { k: 'space', em: 0 };   // acknowledged and ignored
    }
    if (name === 'begin') {
      const env = parseRawArg().trim().replace(/\*$/, '');
      if (!Object.prototype.hasOwnProperty.call(MATH_ENVS, env)) {
        // An environment nobody has implemented. Returned as an unknown
        // command WITHOUT consuming its body, so the matching \end lands as
        // unknown too and renderMathBlock's ratio gate declines the block by
        // arithmetic -- exactly as it did before any environment was
        // supported. A half-typeset tikzpicture is worse than the source.
        return { k: 'unknown', v: 'begin' };
      }
      // \begin{array}{ccc} carries a column spec. Read and discard it: the
      // grid takes its column count from the widest row, which is the same
      // answer when the spec is right and a better one when it is not.
      if (env === 'array' || env === 'alignat') parseRawArg();
      return { k: 'env', env, rows: parseEnvRows() };
    }
    if (name === 'end') { parseRawArg(); return null; }
    return { k: 'unknown', v: name };
  }

  /* Rows of an environment body, split on \\ and cells split on &.
     Stops at \end{...}, or at the end of input if the author never wrote
     one -- an unterminated environment should still render what it has. */
  function parseEnvRows() {
    const rows = [];
    let row = [];
    let cell = [];
    while (!atEnd()) {
      const tk = tokens[pos];
      if (tk.t === 'cmd' && tk.v === 'end') { pos++; parseRawArg(); break; }
      if (tk.t === 'br') { pos++; row.push(cell); rows.push(row); row = []; cell = []; continue; }
      // A literal \& is an ampersand in a cell, not a separator.
      if (tk.t === 'chr' && tk.v === '&' && !tk.literal) { pos++; row.push(cell); cell = []; continue; }
      const node = parseOne();
      if (node) cell.push(node); else pos++;
    }
    row.push(cell);
    rows.push(row);
    // A trailing \\ produces one empty row; drop it rather than drawing a
    // blank line inside the brackets.
    while (rows.length > 1 && rows[rows.length - 1].every(c => c.length === 0)) rows.pop();
    return rows;
  }

  /* An argument: either a braced group or the single next atom. */
  function parseArg() {
    if (tokens[pos] && tokens[pos].t === '{') { pos++; return parseUntilClose(); }
    const a = parseAtom();
    return a ? [a] : [];
  }

  /* \sqrt[3]{x} — the bracketed index. Raw scan; it is never HTML. */
  function parseOptionalArg() {
    if (!tokens[pos] || tokens[pos].t !== 'chr' || tokens[pos].v !== '[') return null;
    pos++;
    const body = [];
    while (!atEnd() && !(tokens[pos].t === 'chr' && tokens[pos].v === ']')) {
      const a = parseAtom();
      if (a) body.push(a); else pos++;
    }
    if (!atEnd()) pos++;   // the ]
    return body;
  }

  /* \text{...} keeps its spaces, so it is read off the tokens as characters
     rather than parsed as maths. */
  function parseRawArg() {
    let s = '';
    if (!tokens[pos] || tokens[pos].t !== '{') {
      const a = tokens[pos];
      if (a && a.t === 'chr') { pos++; return a.v; }
      return '';
    }
    pos++;
    let depth = 1;
    while (!atEnd()) {
      const tk = tokens[pos];
      if (tk.t === '{') depth++;
      else if (tk.t === '}') { depth--; if (depth === 0) { pos++; break; } }
      if (depth > 0) {
        if (tk.t === 'chr') s += tk.v;
        else if (tk.t === 'cmd') s += ' ';
        else if (tk.t === 'space') s += ' ';
        else if (tk.t === '^') s += '^';
        else if (tk.t === '_') s += '_';
      }
      pos++;
    }
    return s;
  }

  function parseUntilClose() {
    const body = [];
    while (!atEnd() && tokens[pos].t !== '}') {
      const node = parseOne();
      if (node) body.push(node); else pos++;
    }
    if (!atEnd()) pos++;   // the }
    return body;
  }

  /* One atom plus any scripts hanging off it. x_i^2 and x^2_i both land
     as a single script node with sub and sup. */
  function parseOne() {
    const base = parseAtom();
    if (!base) return null;
    let sub = null, sup = null;
    while (!atEnd() && (tokens[pos].t === '^' || tokens[pos].t === '_')) {
      const which = tokens[pos].t;
      pos++;
      const arg = parseArg();
      if (which === '^') sup = arg; else sub = arg;
    }
    if (!sub && !sup) return base;
    return { k: 'script', base, sub, sup };
  }

  const out = [];
  while (!atEnd()) {
    const node = parseOne();
    if (node) out.push(node); else pos++;
  }
  return out;
}

/* ── Emitter ────────────────────────────────────────────────────── */
/* Every leaf goes through escapeHtml. Every class name is a literal. */

function mathEmit(nodes) {
  return (nodes || []).map(mathEmitNode).join('');
}

function mathEmitNode(n) {
  switch (n.k) {
    case 'chr': {
      const ch = escapeHtml(n.v);
      // A single unstyled letter is a variable and italicises; digits,
      // punctuation and anything escaped with a backslash do not.
      if (!n.literal && /^[a-zA-Z]$/.test(n.v)) return `<i class="math-var">${ch}</i>`;
      if (MATH_SPACED.has(n.v)) return `<span class="math-bin">${ch}</span>`;
      return ch;
    }
    case 'sym': {
      const ch = escapeHtml(n.v);
      return MATH_SPACED.has(n.v) ? `<span class="math-bin">${ch}</span>` : ch;
    }
    case 'fn':  return `<span class="math-fn">${escapeHtml(n.v)}</span>`;
    case 'op':  return `<span class="math-bigop">${escapeHtml(n.v)}</span>`;
    case 'text': return `<span class="math-text">${escapeHtml(n.v)}</span>`;
    case 'br':  return '<br>';
    case 'space':
      if (!n.em) return '';
      return `<span class="math-space" style="width:${(Math.round(n.em * 100) / 100)}em"></span>`;
    case 'group': return mathEmit(n.body);
    case 'frac':
      return '<span class="math-frac">' +
               `<span class="math-num">${mathEmit(n.num)}</span>` +
               `<span class="math-den">${mathEmit(n.den)}</span>` +
             '</span>';
    case 'binom':
      return '<span class="math-binom">(' +
               `<span class="math-binom-stack"><span>${mathEmit(n.top)}</span>` +
               `<span>${mathEmit(n.bot)}</span></span>` +
             ')</span>';
    case 'sqrt':
      return '<span class="math-sqrt">' +
               (n.root ? `<span class="math-root">${mathEmit(n.root)}</span>` : '') +
               '<span class="math-radical">&#8730;</span>' +
               `<span class="math-radicand">${mathEmit(n.body)}</span>` +
             '</span>';
    case 'accent':
      return '<span class="math-accent">' +
               `<span class="math-mark">${escapeHtml(n.mark)}</span>` +
               `<span class="math-acc-base">${mathEmit(n.body)}</span>` +
             '</span>';
    case 'font':
      // n.cls comes from MATH_FONTS, never from input.
      return `<span class="math-f-${n.cls}">${mathEmit(n.body)}</span>`;
    case 'script': {
      const base = mathEmitNode(n.base);
      // Big operators take their scripts stacked above and below.
      if (n.base.k === 'op') {
        return '<span class="math-limits">' +
                 `<span class="math-upper">${n.sup ? mathEmit(n.sup) : ''}</span>` +
                 base +
                 `<span class="math-lower">${n.sub ? mathEmit(n.sub) : ''}</span>` +
               '</span>';
      }
      if (n.sub && n.sup) {
        return base + '<span class="math-subsup">' +
                 `<span class="math-sup">${mathEmit(n.sup)}</span>` +
                 `<span class="math-sub">${mathEmit(n.sub)}</span>` +
               '</span>';
      }
      if (n.sup) return base + `<sup class="math-sup-i">${mathEmit(n.sup)}</sup>`;
      return base + `<sub class="math-sub-i">${mathEmit(n.sub)}</sub>`;
    }
    case 'env': {
      const spec = MATH_ENVS[n.env] || MATH_ENVS.matrix;
      const rows = n.rows.length ? n.rows : [[[]]];
      let cols = 1;
      for (const r of rows) cols = Math.max(cols, r.length);
      cols = Math.min(cols, MATH_ENV_MAX_COLS);
      const rowCls = Math.min(rows.length, MATH_ENV_MAX_ROWS);

      let cells = '';
      for (const r of rows) {
        for (let c = 0; c < cols; c++) {
          cells += `<span class="math-cell">${mathEmit(r[c] || [])}</span>`;
        }
      }
      const delim = (side) => side
        ? `<span class="math-delim math-d-${side}"></span>`
        : '';
      // math-env-rows-N scales the drawn delimiters to the grid's height.
      return `<span class="math-env math-env-rows-${rowCls}">` +
               delim(spec.l) +
               `<span class="math-grid math-al-${spec.align} math-cols-${cols}">${cells}</span>` +
               delim(spec.r) +
             '</span>';
    }
    case 'unknown':
      // The failure mode: show the source, highlighted, exactly as the user
      // sees it today. escapeHtml on the command name is not optional —
      // this is the one path that echoes input back verbatim.
      return `<span class="math-unknown">\\${escapeHtml(n.v)}</span>`;
    default:
      return '';
  }
}

/* Render raw LaTeX to HTML. Public entry point: safe to call with any
   string from any source. Returns escaped, tag-balanced HTML. */
function renderMathHtml(src) {
  try {
    return mathEmit(mathParse(mathTokenize(String(src == null ? '' : src))));
  } catch (e) {
    // A renderer bug must not blank a message. Fall back to what the user
    // would have seen with no renderer at all.
    console.error('[math] render failed:', e);
    return `<span class="math-unknown">${escapeHtml(src)}</span>`;
  }
}

/* Make an already-escaped source string survive the rest of parseMarkdown.
 *
 * Everything after this point in parseMarkdown is a regex over the whole
 * message, and several of those passes have no idea what a <pre> is. The
 * emphasis pass turns a source line reading `a * b * c` into
 * `a <em> b </em> c` — and since Copy reads textContent, the user would be
 * handed LaTeX with the asterisks silently deleted.
 *
 * This is not a new bug: a ```js block containing `a * b * c` is mangled the
 * same way today. That is worth its own item, since the real fix is a protect
 * mechanism in parseMarkdown that would change code blocks too. Here we only
 * need our own source view to be faithful, so the five trigger characters go
 * out as numeric entities. The HTML parser decodes them back before anything
 * reads textContent, so Copy still yields the exact bytes the model sent.
 *
 * Newlines go too: \n\n+ becomes </p><p> further down, which would put
 * broken markup inside the <pre>. &#10; renders as a line break in a <pre>.
 *
 * ONE pass, not six chained replaces. Chaining re-scans its own output: the
 * * step emits &#42;, and a later # step then rewrote the # inside it to
 * give &&#35;42;. Same class of ordering bug as decoding &amp; last in
 * mathDecodeEntities, and the reason both are done deliberately.
 */
const MATH_SOURCE_ENTITIES = {
  '*': '&#42;',    // ** bold ** and * em *
  '[': '&#91;',    // [text](url)
  '#': '&#35;',    // ^### headings
  '-': '&#45;',    // ^- bullets
  '`': '&#96;',    // inline code
  '\n': '&#10;',   // \n\n -> </p><p>, \n -> <br>
};
function mathSourceSafe(escaped) {
  return String(escaped).replace(/[*[#\-`\n]/g, ch => MATH_SOURCE_ENTITIES[ch]);
}

/* ── Is this actually maths? ─────────────────────────────────────
 *
 * A ```latex fence does not promise an expression. Models cheerfully put a
 * whole document in one — \documentclass, \section, prose paragraphs, even a
 * nested fence — and a *math* renderer typesetting that produces
 * "Thisisasimpleexampleof" in italics, because math mode eats whitespace and
 * every unknown command turns amber.
 *
 * That is worse than the status quo, not equal to it. The earlier claim that
 * this "cannot render worse than doing nothing" holds per-command but not per
 * block: six amber spans and run-together prose is less readable than the
 * plain code block the user would have got before.
 *
 * So the block decides whether rendering is worth it, and hands anything else
 * back to the ordinary code-block path. Three gates, cheapest first.
 */

/* Commands that only appear in documents, never in an expression. */
const MATH_DOCUMENT_RE = new RegExp('\\\\(?:' + [
  'documentclass', 'usepackage', 'maketitle', 'tableofcontents',
  'section', 'subsection', 'subsubsection', 'chapter', 'paragraph',
  'title', 'author', 'date', 'item', 'newcommand', 'renewcommand',
  'bibliography', 'bibitem', 'include', 'input', 'pagestyle', 'footnote',
  'begin\\s*\\{\\s*(?:document|itemize|enumerate|description|verbatim|' +
    'Verbatim|lstlisting|minted|figure|table|tabular|center|quote|' +
    'abstract|thebibliography)\\s*\\}',
].join('|') + ')\\b');

/* A line of ordinary prose: four or more real words and no maths on it.
   Lines carrying \, ^ or _ are exempt, so \frac{a}{b} never trips this. */
function mathHasProseLine(src) {
  for (const line of String(src).split('\n')) {
    if (/[\\^_]/.test(line)) continue;
    const words = line.match(/[A-Za-z][A-Za-z'’-]{2,}/g);
    if (words && words.length >= 4) return true;
  }
  return false;
}

/* Nothing that could be an expression: no commands, no scripts, no grouping,
   no operators. A fence containing "hello world" is not a formula. */
function mathHasNoMath(src) {
  return !/[\\^_{}]/.test(src) && !/[+\-=<>*/±×÷≤≥≠≈]/.test(src);
}

/* Cheap gates first; the parse only runs if they pass. */
function mathWorthRendering(src) {
  if (!src) return false;
  // A fence marker inside the body means this is not one expression. It
  // happens when a model nests fences: per CommonMark the closing fence is a
  // line of backticks ALONE, so ```latex on a line of its own is content,
  // not a close -- and typesetting it produced three literal backticks
  // italicised letter by letter in the middle of the maths.
  if (/```|~~~/.test(src)) return false;
  if (MATH_DOCUMENT_RE.test(src)) return false;
  if (mathHasProseLine(src)) return false;
  if (mathHasNoMath(src)) return false;
  return true;
}

/* A ```latex fence. `body` arrives ALREADY HTML-escaped, because
   parseMarkdown escapes the whole message before it looks for fences.
   It is decoded for the parser and reused for the source view.

   Returns null to decline, which leaves the fence for the ordinary
   code-block handler — the user gets exactly what they got before this
   feature existed, which for a document is the right answer. */
function renderMathBlock(body, lang) {
  const escapedSource = String(body).replace(/^[\r\n]+|\s+$/g, '');
  const source = mathDecodeEntities(escapedSource);
  if (!mathWorthRendering(source)) return null;

  const rendered = renderMathHtml(source);

  // Last gate, and the only one that needs the parse: if most of what came
  // back is highlighted source, the render failed and a code block is
  // tidier than a wall of amber. Catches environments nobody has
  // implemented — \begin{pmatrix} included — without a list of them.
  const unknown = (rendered.match(/class="math-unknown"/g) || []).length;
  const commands = (source.match(/\\[a-zA-Z]+/g) || []).length;
  if (unknown > 0 && (commands === 0 || unknown / commands > 0.34)) return null;

  const label = String(lang).toLowerCase();
  return '<div class="math-block">' +
           '<div class="code-block-header">' +
             `<span class="code-lang">${label}</span>` +
             '<div class="code-btns">' +
               '<button class="btn btn-sm" onclick="toggleMathSource(this)">Source</button>' +
               '<button class="btn btn-sm code-copy-btn" onclick="copyCodeBlock(this)">Copy</button>' +
             '</div>' +
           '</div>' +
           `<div class="math-rendered">${rendered}</div>` +
           `<pre class="math-source"><code>${mathSourceSafe(escapedSource)}</code></pre>` +
         '</div>';
}

/* Flip a rendered block to its source and back. The renderer has known
   gaps (matrices, growing delimiters), so every block carries an escape
   hatch rather than stranding the user with a wrong picture. */
function toggleMathSource(btn) {
  const block = btn.closest('.math-block');
  if (!block) return;
  const showing = block.classList.toggle('math-show-source');
  btn.textContent = showing ? 'Rendered' : 'Source';
}

/* ================================================================
   SYNTAX HIGHLIGHTING

   No dependency. highlight.js is ~120KB minified for the common languages
   and Prism is not much better once you add the grammars people actually
   paste; both are more code than this whole file, for a chat client whose
   artefacts have to fit an NSIS installer.

   This is deliberately a lexer and not a parser. It knows about comments,
   strings, numbers, keywords and call sites, which is where essentially all
   of the legibility of highlighted code comes from. It does not know about
   scope, types or generics, and it will occasionally colour a word that is
   not a keyword in context. That is the trade, and it is the right one at
   this size.

   TWO RULES, the same two the maths emitter holds:
     1. Every character that reaches the output goes through escapeHtml.
        The tokenizer slices the RAW source and escapes each slice, so there
        is one escaping site to audit rather than a set of trusted paths.
     2. Class names are fixed literals. The language name selects a spec
        from a table; it is never interpolated into a tag or an attribute.

   An UNKNOWN language is returned as plain escaped text, untouched. That is
   not just caution about mangling: test L in test-math-render.mjs asserts
   that a declined ```latex block is byte-identical to an untagged fence, and
   that only holds if neither of them is highlighted.

   Positions, not slices. Every matcher works from an index using sticky
   regexes and startsWith(needle, i). An earlier draft did src.slice(i) per
   character, which is O(n^2) -- and this runs on every streamed token, so a
   5KB block would have re-copied megabytes per frame.
================================================================ */

const HL_KW = {
  js: 'abstract arguments as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try typeof var void while with yield satisfies keyof infer declare namespace type',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case',
  c: 'alignas alignof asm auto bool break case catch char class const constexpr continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register return short signed sizeof static static_cast struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed',
  sh: 'if then else elif fi case esac for while until do done in function return local export readonly declare source alias unset shift trap set eval exec exit break continue',
  sql: 'select from where insert into values update set delete create table drop alter add column primary key foreign references index view join inner left right outer full on group by order having limit offset union all distinct as and or not null is like between exists case when then else end asc desc count sum avg min max cast with',
  css: 'important media supports keyframes import charset font-face namespace page root and not only from to',
  json: 'true false null',
  yaml: 'true false null yes no on off',
  lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
  rb: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor',
  php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
};

const HL_BUILTIN = {
  js: 'Array Boolean Date Error JSON Map Math Number Object Promise Proxy RegExp Set String Symbol WeakMap WeakSet console document window globalThis undefined NaN Infinity parseInt parseFloat isNaN fetch setTimeout setInterval require module exports process',
  py: 'abs all any bool bytes dict dir enumerate filter float format frozenset getattr hasattr hash id input int isinstance issubclass len list map max min next object open ord print range repr reversed round set setattr sorted str sum super tuple type zip self cls __init__ __name__ __main__',
  go: 'append cap close complex copy delete len make new panic print println recover string int int8 int16 int32 int64 uint uintptr float32 float64 bool byte rune error any',
  rust: 'Vec String Option Some None Result Ok Err Box Rc Arc RefCell HashMap HashSet println format panic assert vec i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char str',
  c: 'printf sprintf fprintf malloc calloc free memcpy memset strlen strcmp strcpy size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t FILE NULL std cout cin endl vector string map',
  sh: 'echo cd ls cat grep sed awk cut sort uniq head tail wc find xargs chmod chown mkdir rm cp mv touch curl wget git make sudo apt yum systemctl docker kubectl npm node python pip',
};

function hlSet(s) { return new Set(String(s || '').split(/\s+/).filter(Boolean)); }

/* Language families. `line` and `block` are comment delimiters, `quotes` the
   string delimiters, `triple` an optional heredoc-ish triple quote. */
const HL_FAMILIES = {
  clike: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], keywords: hlSet(HL_KW.js), builtins: hlSet(HL_BUILTIN.js) },
  python: { line: ['#'], quotes: ['"', "'"], triple: ['"""', "'''"], keywords: hlSet(HL_KW.py), builtins: hlSet(HL_BUILTIN.py) },
  cfam: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], keywords: hlSet(HL_KW.c), builtins: hlSet(HL_BUILTIN.c) },
  golang: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], keywords: hlSet(HL_KW.go), builtins: hlSet(HL_BUILTIN.go) },
  rustlang: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], keywords: hlSet(HL_KW.rust), builtins: hlSet(HL_BUILTIN.rust) },
  javalang: { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], keywords: hlSet(HL_KW.java), builtins: hlSet(HL_BUILTIN.js) },
  shell: { line: ['#'], quotes: ['"', "'"], keywords: hlSet(HL_KW.sh), builtins: hlSet(HL_BUILTIN.sh) },
  sqlfam: { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], keywords: hlSet(HL_KW.sql), caseless: true },
  cssfam: { block: ['/*', '*/'], quotes: ['"', "'"], keywords: hlSet(HL_KW.css) },
  jsonfam: { quotes: ['"'], keywords: hlSet(HL_KW.json) },
  yamlfam: { line: ['#'], quotes: ['"', "'"], keywords: hlSet(HL_KW.yaml) },
  lualang: { line: ['--'], quotes: ['"', "'"], keywords: hlSet(HL_KW.lua) },
  ruby: { line: ['#'], quotes: ['"', "'"], keywords: hlSet(HL_KW.rb) },
  phplang: { line: ['//', '#'], block: ['/*', '*/'], quotes: ['"', "'"], keywords: hlSet(HL_KW.php), builtins: hlSet(HL_BUILTIN.js) },
  markup: { markup: true },
};

const HL_LANGS = {
  js: 'clike', javascript: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike',
  ts: 'clike', typescript: 'clike', tsx: 'clike',
  py: 'python', python: 'python', python3: 'python',
  c: 'cfam', h: 'cfam', cpp: 'cfam', 'c++': 'cfam', cc: 'cfam', hpp: 'cfam', cxx: 'cfam',
  cs: 'cfam', csharp: 'cfam', objc: 'cfam', swift: 'cfam', kotlin: 'cfam', kt: 'cfam',
  scala: 'cfam', dart: 'cfam', groovy: 'cfam',
  go: 'golang', golang: 'golang',
  rust: 'rustlang', rs: 'rustlang',
  java: 'javalang',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  fish: 'shell', ksh: 'shell', powershell: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
  sql: 'sqlfam', postgres: 'sqlfam', postgresql: 'sqlfam', mysql: 'sqlfam', sqlite: 'sqlfam',
  css: 'cssfam', scss: 'cssfam', sass: 'cssfam', less: 'cssfam',
  json: 'jsonfam', json5: 'jsonfam', jsonc: 'jsonfam',
  yaml: 'yamlfam', yml: 'yamlfam', toml: 'yamlfam', ini: 'yamlfam', conf: 'yamlfam',
  dockerfile: 'shell', makefile: 'shell', make: 'shell', nginx: 'yamlfam',
  lua: 'lualang',
  rb: 'ruby', ruby: 'ruby',
  php: 'phplang',
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', htm: 'markup',
};

const HL_NUM_RE = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const HL_ID_RE = /[A-Za-z_$][A-Za-z0-9_$-]*/y;
const HL_OP_RE = /[+\-*/%=<>!&|^~?:]+/y;
const HL_WORD_CHAR = /[A-Za-z0-9_$]/;

/* Lexing is the expensive half of rendering a message, and 14-scroll.js
 * re-runs parseMarkdown over the WHOLE message on every streamed token. A
 * reply with three finished code blocks and one still arriving would re-lex
 * all four sixty times a second, for three identical answers.
 *
 * Keyed on the exact source, so a block that has stopped changing is looked
 * up rather than re-lexed. Bounded because a long conversation would
 * otherwise hold every code block ever rendered: oldest out first, which for
 * this access pattern is the block furthest up the transcript.
 */
const HL_CACHE = new Map();
const HL_CACHE_MAX = 64;
const HL_CACHE_MAX_INPUT = 200000;   // past this, lexing is cheaper than the memory

function highlightCode(code, lang) {
  const src = String(code);
  const family = HL_FAMILIES[HL_LANGS[String(lang || '').toLowerCase()]];
  // Unknown language: plain escaped text, exactly as before highlighting
  // existed. See the note about test L at the top of this section.
  if (!family) return escapeHtml(src);

  const key = src.length <= HL_CACHE_MAX_INPUT ? lang + '\u0000' + src : null;
  if (key !== null) {
    const hit = HL_CACHE.get(key);
    // Re-insert so the most recently used entry is last, which is what makes
    // "delete the first key" an eviction rather than a coin toss.
    if (hit !== undefined) { HL_CACHE.delete(key); HL_CACHE.set(key, hit); return hit; }
  }

  let out;
  try {
    out = family.markup ? hlMarkup(src) : hlLex(src, family);
  } catch (e) {
    // A highlighter bug must never cost the user their code.
    console.error('[highlight] failed:', e);
    return escapeHtml(src);
  }

  if (key !== null) {
    HL_CACHE.set(key, out);
    if (HL_CACHE.size > HL_CACHE_MAX) HL_CACHE.delete(HL_CACHE.keys().next().value);
  }
  return out;
}

function hlLex(src, spec) {
  const n = src.length;
  let out = '';
  let i = 0;
  const emit = (cls, from, to) => {
    const text = escapeHtml(src.slice(from, to));
    out += cls ? `<span class="tok-${cls}">${text}</span>` : text;
  };

  while (i < n) {
    const ch = src[i];

    if (spec.block && src.startsWith(spec.block[0], i)) {
      const end = src.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end === -1 ? n : end + spec.block[1].length;
      emit('com', i, stop); i = stop; continue;
    }

    let lineHit = null;
    for (const lc of (spec.line || [])) if (src.startsWith(lc, i)) { lineHit = lc; break; }
    if (lineHit) {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      emit('com', i, stop); i = stop; continue;
    }

    let tripleHit = null;
    for (const t of (spec.triple || [])) if (src.startsWith(t, i)) { tripleHit = t; break; }
    if (tripleHit) {
      const end = src.indexOf(tripleHit, i + tripleHit.length);
      const stop = end === -1 ? n : end + tripleHit.length;
      emit('str', i, stop); i = stop; continue;
    }

    if (spec.quotes && spec.quotes.indexOf(ch) !== -1) {
      // Backtick strings are multi-line; single and double quotes stop at
      // the newline, so one unterminated quote cannot paint the rest of the
      // block as a string.
      const multiline = ch === '`';
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        if (src[j] === '\n' && !multiline) break;
        j++;
      }
      emit('str', i, Math.min(j, n)); i = Math.min(j, n); continue;
    }

    if (ch >= '0' && ch <= '9' && !HL_WORD_CHAR.test(src[i - 1] || '')) {
      HL_NUM_RE.lastIndex = i;
      const m = HL_NUM_RE.exec(src);
      if (m) { emit('num', i, i + m[0].length); i += m[0].length; continue; }
    }

    HL_ID_RE.lastIndex = i;
    const id = HL_ID_RE.exec(src);
    if (id) {
      const w = id[0];
      const probe = spec.caseless ? w.toLowerCase() : w;
      let cls = null;
      if (spec.keywords && spec.keywords.has(probe)) cls = 'kw';
      else if (spec.builtins && spec.builtins.has(w)) cls = 'bi';
      else if (src[i + w.length] === '(') cls = 'fn';
      emit(cls, i, i + w.length); i += w.length; continue;
    }

    HL_OP_RE.lastIndex = i;
    const op = HL_OP_RE.exec(src);
    if (op) { emit('op', i, i + op[0].length); i += op[0].length; continue; }

    emit(null, i, i + 1); i++;
  }
  return out;
}

/* Markup gets its own pass: in HTML the interesting tokens are tag names and
   attributes, and running the identifier lexer over it would colour every
   word of the body text. */
function hlMarkup(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  const emit = (cls, from, to) => {
    const text = escapeHtml(src.slice(from, to));
    out += cls ? `<span class="tok-${cls}">${text}</span>` : text;
  };

  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      const stop = end === -1 ? n : end + 3;
      emit('com', i, stop); i = stop; continue;
    }
    if (src[i] === '<') {
      const close = src.indexOf('>', i);
      const stop = close === -1 ? n : close + 1;
      // Inside the tag: name, then attribute names and quoted values.
      let j = i + 1;
      emit('op', i, j);
      if (src[j] === '/') { emit('op', j, j + 1); j++; }
      HL_ID_RE.lastIndex = j;
      const name = HL_ID_RE.exec(src);
      if (name && name.index === j) { emit('kw', j, j + name[0].length); j += name[0].length; }
      while (j < stop) {
        const c = src[j];
        if (c === '"' || c === "'") {
          let k = j + 1;
          while (k < stop && src[k] !== c) k++;
          emit('str', j, Math.min(k + 1, stop)); j = Math.min(k + 1, stop); continue;
        }
        HL_ID_RE.lastIndex = j;
        const attr = HL_ID_RE.exec(src);
        if (attr && attr.index === j && j < stop) {
          emit('bi', j, j + attr[0].length); j += attr[0].length; continue;
        }
        emit(null, j, j + 1); j++;
      }
      i = stop;
      continue;
    }
    const next = src.indexOf('<', i);
    const stop = next === -1 ? n : next;
    emit(null, i, stop);
    i = stop;
  }
  return out;
}

/* ================================================================
   MARKDOWN — block extraction, block structure, inline formatting

   THE BUG THIS EXISTS TO FIX
   --------------------------
   parseMarkdown used to be a flat chain of ~20 regex .replace() calls over
   one string. Once a fence had become <pre><code>...</code></pre>, that HTML
   was still just text in the variable, so every later pass ran over the code
   too. Two passes walked tags to protect themselves; the other ten did not.
   The results were all the same bug wearing different hats:

     - `\n\n+ -> </p><p>` ran INSIDE the <pre>. Per the HTML parsing spec the
       stray </p> synthesises an empty paragraph, the <p> opens a real one
       inside <code>, and the following </code> is then IGNORED (p is
       "special", so the any-other-end-tag step bails). A blank line in a
       code sample became a paragraph box with a 10px margin.
     - `\n -> <br>` ran inside it too, and copyCodeBlock reads textContent,
       where <br> contributes nothing. Copy returned every line concatenated
       with no separators at all.
     - The emphasis pass turned `a * b * c` into `a <em> b </em> c` -- the
       asterisks DELETED, on screen and in the clipboard. Bold, bullets and
       bare URLs did the same.

   The fix is not ten patches. It is to take fenced content out of the
   string before any of that runs, leave an inert placeholder in its place,
   and put the rendered block back at the very end. mathSourceSafe's comment
   block called for exactly this and worked around it locally; this is the
   general mechanism it asked for.

   ORDER OF OPERATIONS, and why
   ----------------------------
     1. Extract fences from the RAW text. Raw, not escaped, so the syntax
        highlighter sees real characters and escapes each token itself.
     2. escapeHtml everything that is left.
     3. Block structure: headings, tables, lists, quotes, rules.
     4. Inline formatting, per text run only -- so it is structurally
        incapable of reaching inside code.
     5. Restore placeholders.

   THE PLACEHOLDER
   ---------------
   U+E000 <nonce> . <index> U+E001, with a fresh random nonce per call.
   Private-use codepoints so escapeHtml leaves them alone, and a nonce so a
   user typing the sentinel characters cannot forge a slot and inject stored
   HTML. The body is hex/alphanumeric and a dot: no *, _, #, -, backtick,
   pipe, bracket or dollar, so no later pass can match part of it.
================================================================ */

const MD_OPEN = '\uE000';
const MD_CLOSE = '\uE001';

function mdNewStore() {
  let n = '';
  for (let i = 0; i < 4; i++) n += Math.random().toString(36).slice(2, 10);
  const nonce = n.replace(/[^a-z0-9]/g, '0').slice(0, 24);
  // Both regexes are built once per message. mdIsPlaceholder is called for
  // every line of every block pass, and compiling a RegExp per line showed up
  // in the profile -- parseMarkdown re-runs on every streamed token, so a
  // per-line allocation is a per-line allocation sixty times a second.
  return {
    nonce,
    items: [],
    isRe: new RegExp('^' + MD_OPEN + nonce + '\\.\\d+' + MD_CLOSE + '$'),
    findRe: new RegExp(MD_OPEN + nonce + '\\.(\\d+)' + MD_CLOSE, 'g'),
  };
}

/* Stash rendered HTML and return its placeholder. `block` marks content that
   must not end up inside a <p>. */
function mdStash(store, html, block) {
  const i = store.items.push({ html: String(html), block: !!block }) - 1;
  return MD_OPEN + store.nonce + '.' + i + MD_CLOSE;
}

function mdIsPlaceholder(s, store) {
  return store.isRe.test(String(s).trim());
}

function mdRestore(html, store) {
  store.findRe.lastIndex = 0;
  // Two passes are not needed: stored HTML never contains a placeholder,
  // because everything stashed is already fully rendered.
  return String(html).replace(store.findRe, (whole, i) => {
    const item = store.items[+i];
    return item ? item.html : '';
  });
}

/* ── Fence extraction ────────────────────────────────────────────
 *
 * One scanner for every fenced form, because fence syntax should be decided
 * in one place. What the old regexes missed, and this does not:
 *
 *   - CRLF. /```(\w*)\n/ needs a bare \n, so ```js\r\n fell through to raw
 *     text with the backticks visible. (The math handler had been fixed for
 *     this; the code handler never was.)
 *   - ~~~ fences. Unsupported entirely.
 *   - Four or more backticks. The old regex matched three of them and left
 *     the extras loose in the output.
 *   - Indented fences, which is how a fence inside a list item arrives.
 *   - An UNCLOSED fence. This one matters more than it looks: 14-scroll.js
 *     re-runs parseMarkdown over the whole message on every streamed token,
 *     so until the model emits the closing fence the user watched raw
 *     backticks and unstyled text, and then the box snapped in at the end.
 *     An unclosed fence now runs to the end of the message, which is both
 *     what CommonMark says and what makes a code box appear immediately.
 */
const MD_MATH_TAGS = /^(?:latex|math|tex|katex|equation|displaymath)$/i;

function mdExtractFences(raw, store) {
  const lines = String(raw).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // The closing fence must be at least as long as the opening one, so a
    // ```` block can legally contain ``` lines.
    const open = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\r\n`]*?)[ \t]*\r?$/.exec(line);
    if (!open) { out.push(line); i++; continue; }

    const indent = open[1];
    const fence = open[2];
    const info = open[3].trim();
    const closeRe = new RegExp('^[ \\t]{0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*\\r?$');

    const body = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (closeRe.test(lines[j])) { closed = true; break; }
      // Strip the opening indent from each body line, so a fence inside a
      // list item does not arrive with four spaces welded to every line.
      body.push(indent && lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }

    const code = body.join('\n').replace(/\r$/, '').replace(/\s+$/, '');
    out.push(mdStash(store, mdRenderFence(info, code, closed), true));
    i = closed ? j + 1 : lines.length;
  }
  return out.join('\n');
}

/* Decide what a fence becomes. `closed` is false while a block is still
   streaming; it changes nothing about the output, and is passed only so the
   choice is visible at the one place that makes it. */
function mdRenderFence(info, code, closed) {
  const fileMatch = /^file:(.+)$/i.exec(info);
  if (fileMatch) return mdRenderFileBlock(fileMatch[1].trim(), code);

  if (MD_MATH_TAGS.test(info)) {
    // renderMathBlock takes ESCAPED source and decodes it -- its contract
    // from when parseMarkdown escaped the whole message up front. Kept
    // exactly as it was rather than changed to suit the new caller: it is
    // the one function here that echoes input back, and its escaping story
    // has tests pinned to it.
    const rendered = renderMathBlock(escapeHtml(code), info);
    if (rendered) return rendered;
    // Declined -- a document, prose, or an environment nobody implemented.
    // Falls through to a plain code block, which is what the user had before
    // the maths renderer existed.
  }
  return mdRenderCodeBlock(code, info);
}

function mdRenderCodeBlock(code, lang) {
  const label = lang ? String(lang).toLowerCase().split(/[ \t,]/)[0] : 'code';
  return '<div class="code-block">' +
           '<div class="code-block-header">' +
             `<span class="code-lang">${escapeHtml(label)}</span>` +
             '<button class="btn btn-sm code-copy-btn" onclick="copyCodeBlock(this)">Copy</button>' +
           '</div>' +
           `<pre><code>${highlightCode(code, label)}</code></pre>` +
         '</div>';
}

function mdRenderFileBlock(filename, code) {
  const fn = escapeHtml(filename);
  const id = 'file_' + Math.random().toString(36).slice(2, 8);
  return '<div class="file-block">' +
           '<div class="file-header">' +
             `<span class="file-name">&#128196; ${fn}</span>` +
             '<div class="code-btns">' +
               '<button class="btn btn-sm code-copy-btn" onclick="copyCodeBlock(this)">Copy</button>' +
               `<button class="btn btn-sm" data-filename="${fn}" onclick="downloadFile(this)">Save</button>` +
             '</div>' +
           '</div>' +
           `<pre><code id="${id}">${escapeHtml(code)}</code></pre>` +
         '</div>';
}

/* ── Display maths outside a fence ───────────────────────────────
 *
 * $$...$$ and \[...\] are how models emit display maths most of the time,
 * and until now both rendered as literal text -- the single biggest reason
 * maths "doesn't always render right". Neither delimiter is ambiguous: no
 * ordinary prose contains a doubled dollar or a backslash-bracket.
 *
 * Run AFTER fence extraction, so a $$ inside a code block is already a
 * placeholder and cannot be claimed.
 */
function mdExtractDisplayMath(raw, store) {
  return String(raw).replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (whole, a, b) => {
    const src = (a !== undefined ? a : b).trim();
    if (!src || src.length > 4000) return whole;
    // src is already escaped -- this pass runs after escapeHtml -- and
    // renderMathBlock's contract is escaped-in. Escaping again would show
    // the user &amp;amp; in the Source view.
    const html = renderMathBlock(src, 'math');
    return html ? mdStash(store, html, true) : whole;
  });
}

/* Inline maths: \(...\) always, and $...$ only when it carries a signal
 * that it is maths rather than money.
 *
 * The signal is what keeps "*grins* It cost $5, then $10 later" intact --
 * that content is "5, then " and has no backslash, caret, underscore or
 * brace in it, and is not a lone variable name. A single dollar pair with
 * none of those is left exactly as the model typed it. This is a roleplay
 * app; currency is far more common in it than inline algebra, so the rule
 * errs towards not claiming.
 */
const MD_INLINE_MATH_SIGNAL = /[\\^_{}]/;

function mdExtractInlineMath(escaped, store) {
  // \( ... \) — unambiguous, no signal needed.
  let s = String(escaped).replace(/\\\(([\s\S]{1,400}?)\\\)/g, (whole, body) => {
    const html = mdInlineMathHtml(body);
    return html ? mdStash(store, html, false) : whole;
  });
  // $ ... $ — single line, no leading/trailing space, and must look like maths.
  s = s.replace(/\$([^$\n]{1,200})\$/g, (whole, body) => {
    if (/^\s|\s$/.test(body)) return whole;
    if (!MD_INLINE_MATH_SIGNAL.test(body) && !/^[A-Za-z]$/.test(body)) return whole;
    const html = mdInlineMathHtml(body);
    return html ? mdStash(store, html, false) : whole;
  });
  return s;
}

/* Shared tail for both inline forms. `body` is escaped; renderMathHtml wants
   raw, and mathDecodeEntities is the exact inverse used everywhere else. */
function mdInlineMathHtml(body) {
  const src = mathDecodeEntities(body);
  if (!src.trim()) return null;
  const rendered = renderMathHtml(src);
  // Same arithmetic gate the block path uses: mostly-amber output is worse
  // than leaving the text alone.
  const unknown = (rendered.match(/class="math-unknown"/g) || []).length;
  const commands = (src.match(/\\[a-zA-Z]+/g) || []).length;
  if (unknown > 0 && (commands === 0 || unknown / commands > 0.34)) return null;
  return `<span class="math-inline">${rendered}</span>`;
}

/* ── Block structure ─────────────────────────────────────────────
 *
 * A line-based pass, which is what markdown actually is. Everything here
 * emits real block elements -- <table>, <ul>, <ol>, <blockquote>, <hr> --
 * where the old chain emitted a bullet CHARACTER and nothing else. The
 * ul/ol/li rules at css/04-chat.css:237 have been dead since they were
 * written, because no tag ever reached them.
 */

const MD_HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const MD_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/* Blockquote matches &gt;, not >, because escapeHtml has already run by the
   time the block pass sees these lines. It is the only block marker escaping
   touches -- #, -, *, |, ` and digits all arrive unchanged -- and matching a
   literal > here meant blockquotes silently never fired. */
const MD_QUOTE_RE = /^ {0,3}&gt; ?(.*)$/;
const MD_UL_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const MD_OL_RE = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const MD_TASK_RE = /^\[([ xX])\][ \t]+([\s\S]*)$/;

/* Heading colours were inline styles on a <strong>, so a heading was an
   inline element followed by a <br> -- no block spacing, and nothing a
   stylesheet could reach. Real <h*> tags with a class instead. */
const MD_HEADING_CLASS = ['md-h1', 'md-h2', 'md-h3', 'md-h4', 'md-h5', 'md-h6'];

function mdIndentWidth(s) {
  let w = 0;
  for (const ch of s) w += (ch === '\t' ? 4 : 1);
  return w;
}

function mdRenderBlocks(text, store, dialogColor) {
  const lines = String(text).split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const body = para.map(l => mdInline(l, store, dialogColor)).join('<br>');
    if (body.trim()) out.push(`<p>${body}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); i++; continue; }

    // A stashed block sits on its own, never inside a paragraph.
    if (mdIsPlaceholder(line, store)) { flushPara(); out.push(line.trim()); i++; continue; }

    if (MD_HR_RE.test(line)) { flushPara(); out.push('<hr class="md-hr">'); i++; continue; }

    const h = MD_HEADING_RE.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level} class="${MD_HEADING_CLASS[level - 1]}">` +
               mdInline(h[2].replace(/[ \t]+#+[ \t]*$/, ''), store, dialogColor) +
               `</h${level}>`);
      i++;
      continue;
    }

    if (MD_QUOTE_RE.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && (MD_QUOTE_RE.test(lines[i]) || (inner.length && lines[i].trim() && !mdStartsBlock(lines[i])))) {
        const m = MD_QUOTE_RE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]);
        i++;
      }
      out.push(`<blockquote class="md-quote">${mdRenderBlocks(inner.join('\n'), store, dialogColor)}</blockquote>`);
      continue;
    }

    const table = mdTryTable(lines, i, store, dialogColor);
    if (table) { flushPara(); out.push(table.html); i = table.next; continue; }

    if (MD_UL_RE.test(line) || MD_OL_RE.test(line)) {
      flushPara();
      const list = mdParseList(lines, i, store, dialogColor);
      out.push(list.html);
      i = list.next;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

/* Does this line start a block of its own? Used only to decide whether a
   lazy continuation line still belongs to the blockquote above it. */
function mdStartsBlock(line) {
  return MD_HR_RE.test(line) || MD_HEADING_RE.test(line) ||
         MD_UL_RE.test(line) || MD_OL_RE.test(line) || /^ {0,3}&gt;/.test(line);
}

/* ── Tables ──────────────────────────────────────────────────────
 *
 * Not supported at all before this: "| Name | Size |" rendered as literal
 * pipes joined by <br>. A GFM table is a header row, a delimiter row that
 * sets alignment, and body rows.
 *
 * Alignment lands as one of three FIXED class names. Nothing computed from
 * the message is ever interpolated into an attribute -- the same rule the
 * maths emitter holds.
 */
const MD_ALIGN_CLASS = { l: 'md-al-l', c: 'md-al-c', r: 'md-al-r' };

function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function mdTryTable(lines, start, store, dialogColor) {
  const head = lines[start];
  if (!head || head.indexOf('|') === -1) return null;
  const delim = lines[start + 1];
  if (!delim || !/^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/.test(delim)) return null;

  const headCells = mdSplitRow(head);
  const alignCells = mdSplitRow(delim);
  if (alignCells.length !== headCells.length) return null;

  const align = alignCells.map(c => {
    const left = c.startsWith(':'), right = c.endsWith(':');
    if (left && right) return 'c';
    if (right) return 'r';
    return 'l';
  });

  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1 &&
         !MD_HR_RE.test(lines[i]) && !mdIsPlaceholder(lines[i], store)) {
    rows.push(mdSplitRow(lines[i]));
    i++;
  }

  const cell = (tag, text, n) =>
    `<${tag} class="${MD_ALIGN_CLASS[align[n] || 'l']}">${mdInline(text || '', store, dialogColor)}</${tag}>`;

  const thead = '<thead><tr>' + headCells.map((c, n) => cell('th', c, n)).join('') + '</tr></thead>';
  const tbody = rows.length
    ? '<tbody>' + rows.map(r => {
        const cells = [];
        for (let n = 0; n < headCells.length; n++) cells.push(cell('td', r[n], n));
        return '<tr>' + cells.join('') + '</tr>';
      }).join('') + '</tbody>'
    : '';

  // The wrapper is what scrolls. A wide table inside a chat bubble must not
  // widen the bubble, or the whole conversation column stretches with it.
  return { html: `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`, next: i };
}

/* ── Lists ───────────────────────────────────────────────────────
 *
 * "- x" used to become "&bull; x": a bullet character, no <ul>, no indent,
 * no hanging indent when a line wrapped, and nested items lost their
 * indentation completely because HTML collapses leading spaces. "1. x"
 * was replaced with "$1. $2", a substitution that does nothing at all.
 *
 * Nesting is by indent width, tabs counted as 4.
 */
function mdParseList(lines, start, store, dialogColor) {
  const first = MD_UL_RE.exec(lines[start]) || MD_OL_RE.exec(lines[start]);
  const baseIndent = mdIndentWidth(first[1]);
  const ordered = !MD_UL_RE.test(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line inside a list is allowed; a blank line followed by a
      // non-item ends it.
      const next = lines[i + 1];
      if (next && (MD_UL_RE.test(next) || MD_OL_RE.test(next)) &&
          mdIndentWidth((MD_UL_RE.exec(next) || MD_OL_RE.exec(next))[1]) >= baseIndent) {
        i++;
        continue;
      }
      break;
    }
    const m = MD_UL_RE.exec(line) || MD_OL_RE.exec(line);
    if (m) {
      const indent = mdIndentWidth(m[1]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        const sub = mdParseList(lines, i, store, dialogColor);
        if (items.length) items[items.length - 1].children.push(sub.html);
        else items.push({ text: '', children: [sub.html], task: null });
        i = sub.next;
        continue;
      }
      const isOrdered = !MD_UL_RE.test(line);
      if (isOrdered !== ordered) break;
      const task = MD_TASK_RE.exec(m[3]);
      items.push({ text: task ? task[2] : m[3], children: [], task: task ? task[1].toLowerCase() === 'x' : null });
      i++;
      continue;
    }
    // A continuation line, indented under the current item.
    if (mdIndentWidth(/^[ \t]*/.exec(line)[0]) > baseIndent && items.length) {
      items[items.length - 1].text += '\n' + line.trim();
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const cls = ordered ? 'md-ol' : 'md-ul';
  const html = `<${tag} class="${cls}">` + items.map(it => {
    const body = it.text.split('\n').map(l => mdInline(l, store, dialogColor)).join('<br>');
    if (it.task === null) return `<li>${body}${it.children.join('')}</li>`;
    // A checkbox that cannot be clicked would be a lie about what it does;
    // this is a rendering of the model's text, not a todo widget.
    const mark = it.task ? '&#9745;' : '&#9744;';
    const doneCls = it.task ? ' md-task-done' : '';
    return `<li class="md-task${doneCls}"><span class="md-task-box">${mark}</span>${body}${it.children.join('')}</li>`;
  }).join('') + `</${tag}>`;

  return { html, next: i };
}

/* ── Inline formatting ───────────────────────────────────────────
 *
 * Runs on ONE text run at a time, never on a whole message, so it is
 * structurally incapable of reaching inside a code block: by the time this
 * is called, every fence is already a placeholder.
 *
 * Order is the old one, deliberately. Inline code first so backticked
 * content is out of reach of everything after it; then dialogue, which the
 * old chain also ran before links and emphasis.
 */
function mdInline(text, store, dialogColor) {
  let s = String(text);

  // Inline code -> placeholder. This is why `**not bold**` no longer comes
  // back as <code><strong>not bold</strong></code>: the emphasis pass never
  // sees it.
  s = s.replace(/``([^`\n]+)``/g, (whole, body) =>
    mdStash(store, `<code>${body.trim()}</code>`, false));
  s = s.replace(/`([^`\n]+)`/g, (whole, body) =>
    mdStash(store, `<code>${body}</code>`, false));

  s = mdExtractInlineMath(s, store);

  if (dialogColor) {
    s = s.replace(DIALOG_QUOTE_RE, (m) =>
      `<span class="dialog-text" style="color:${dialogColor};">${m}</span>`);
  }

  // Markdown links: [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, (_, label, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener">${label}</a>`;
  });

  // Bare URLs — any https?:// not already inside an <a>.
  s = s.replace(/(^|[^"'>\/])(https?:\/\/[^\s<\)\]"'`,]+)/g, (_, before, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    const trimmed = cleanUrl.replace(/[.,;:!?\)]+$/, '');
    const remainder = cleanUrl.slice(trimmed.length);
    const displayUrl = url.replace(/[.,;:!?\)]+$/, '');
    return `${before}<a href="${trimmed}" target="_blank" rel="noopener">${displayUrl}</a>${remainder}`;
  });

  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del class="md-del">$1</del>');
  return s;
}

function parseMarkdown(text, dialogColor) {
  if (!text) return '';
  // dialogColor rides in from a character card, which can arrive from an
  // imported file or a synced peer, and lands in a style="color:..."
  // attribute below. Allowlist it once here so no caller has to remember to.
  dialogColor = safeCssColor(dialogColor, '');

  const store = mdNewStore();
  let s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  s = mdExtractFences(s, store);      // raw, so the highlighter sees real bytes
  s = escapeHtml(s);                  // everything still in play is now text
  s = mdExtractDisplayMath(s, store);
  s = mdRenderBlocks(s, store, dialogColor);
  return mdRestore(s, store);
}

/* ================================================================
   COLOR PICKER HELPERS
================================================================ */
function syncColorHex(swatchEl, hexInputId) {
  document.getElementById(hexInputId).value = swatchEl.value;
}

function syncColorSwatch(hexEl, swatchId) {
  let val = hexEl.value.trim();
  if (val && !val.startsWith('#')) val = '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    document.getElementById(swatchId).value = val;
  }
}

function previewCardColors() {
  const tc = document.getElementById('card-textcolor')?.value || '#e0f8ff';
  const dc = document.getElementById('card-dialogcolor')?.value || '#d900ff';
  const el = document.getElementById('card-color-preview');
  if (el) {
    el.style.color = tc;
    const dialogSpan = el.querySelector('.dialog-text');
    if (dialogSpan) dialogSpan.style.color = dc;
  }
}

function previewPersonaColors() {
  const tc = document.getElementById('persona-textcolor')?.value || '#00b8ff';
  const dc = document.getElementById('persona-dialogcolor')?.value || '#00f3ff';
  const el = document.getElementById('persona-color-preview');
  if (el) {
    el.style.color = tc;
    const dialogSpan = el.querySelector('.dialog-text');
    if (dialogSpan) dialogSpan.style.color = dc;
  }
}

/* ================================================================
   FILE ATTACHMENTS — drag & drop + click-to-attach
   This is a local text model (llama.cpp), so "attaching" a text file
   means its contents get embedded into the outgoing message so the
   model can read it. Images can be attached for the human record but
   are NOT sent to the model — we mark them clearly. Everything stays
   in-browser; nothing is uploaded anywhere.
================================================================ */

// Files staged for the next send. Each: { id, name, kind, size, text|dataUrl, skipped }
let _pendingAttachments = [];

// Max characters of file text embedded per file (keeps a runaway log from
// blowing the context window). The chip notes when a file was truncated.
const ATTACH_TEXT_LIMIT = 100000;
const ATTACH_MAX_BYTES  = 8 * 1024 * 1024; // 8MB per file guard

// Extensions/MIME we treat as readable text. Anything else that isn't an
// image is attached as a reference-only chip (name recorded, not read).
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|ini|cfg|conf|toml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|r|lua|pl|swift|kt|scala|dart|vue|svelte|tex|env|gitignore|dockerfile|makefile)$/i;

function isTextFile(file) {
  if (file.type && (file.type.startsWith('text/') ||
      /(json|javascript|xml|x-sh|x-python|csv)/i.test(file.type))) return true;
  if (TEXT_EXT.test(file.name)) return true;
  // Extensionless common names
  if (/^(dockerfile|makefile|readme|license)$/i.test(file.name)) return true;
  return false;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Read a list of File objects into _pendingAttachments, then re-render. */
function addAttachments(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  files.forEach(file => {
    const id = generateId();
    const isImg = file.type && file.type.startsWith('image/');
    const base = { id, name: file.name, size: file.size };

    if (file.size > ATTACH_MAX_BYTES) {
      _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'too large (>8MB)' });
      renderAttachTray();
      return;
    }

    if (isImg) {
      // Stored for display only — local text model can't see it.
      const reader = new FileReader();
      reader.onload = e => {
        _pendingAttachments.push({ ...base, kind: 'image', dataUrl: e.target.result });
        renderAttachTray();
      };
      reader.onerror = () => { _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'read error' }); renderAttachTray(); };
      reader.readAsDataURL(file);
    } else if (isTextFile(file)) {
      const reader = new FileReader();
      reader.onload = e => {
        let text = e.target.result || '';
        let truncated = false;
        if (text.length > ATTACH_TEXT_LIMIT) {
          text = text.slice(0, ATTACH_TEXT_LIMIT);
          truncated = true;
        }
        _pendingAttachments.push({ ...base, kind: 'text', text, truncated });
        renderAttachTray();
      };
      reader.onerror = () => { _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'read error' }); renderAttachTray(); };
      reader.readAsText(file);
    } else {
      // Unknown binary — record the name only, not sent to model.
      _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'binary — not sent to model' });
      renderAttachTray();
    }
  });
}

function removeAttachment(id) {
  _pendingAttachments = _pendingAttachments.filter(a => a.id !== id);
  renderAttachTray();
}

function clearAttachments() {
  _pendingAttachments = [];
  renderAttachTray();
}

/** Render the pending-attachments tray + update the attach button state. */
function renderAttachTray() {
  const tray = document.getElementById('attach-tray');
  const btn  = document.getElementById('attach-btn');
  if (!tray) return;

  if (_pendingAttachments.length === 0) {
    tray.style.display = 'none';
    tray.innerHTML = '';
    if (btn) btn.classList.remove('has-files');
    return;
  }

  tray.style.display = 'flex';
  if (btn) btn.classList.add('has-files');

  tray.innerHTML = _pendingAttachments.map(a => {
    let cls = 'attach-chip', icon = '📄', meta = formatBytes(a.size);
    if (a.kind === 'image') { cls += ' attach-chip-img'; icon = '🖼️'; meta = 'image · not sent to model'; }
    else if (a.kind === 'skip') { cls += ' attach-chip-skip'; icon = '⚠️'; meta = a.skipped; }
    else if (a.truncated) { meta = formatBytes(a.size) + ' · truncated'; }
    return `<span class="${cls}" title="${escapeHtml(a.name)}">
      <span class="attach-chip-icon">${icon}</span>
      <span class="attach-chip-name">${escapeHtml(a.name)}</span>
      <span class="attach-chip-meta">${escapeHtml(meta)}</span>
      <button class="attach-chip-x" onclick="removeAttachment('${escapeJsAttr(a.id)}')" title="Remove">×</button>
    </span>`;
  }).join('');
}

/** Triggered by the hidden <input type=file>. */
function onAttachInput(inputEl) {
  addAttachments(inputEl.files);
  inputEl.value = ''; // allow re-selecting the same file
}

/**
 * Build the text block that gets prepended to the outgoing message so the
 * model can read attached text files. Returns '' when nothing is readable.
 * Also returns the lightweight metadata array to store on the message for
 * display chips. Call once at send time.
 */
function consumeAttachmentsForSend() {
  const atts = _pendingAttachments.slice();
  if (atts.length === 0) return { embed: '', meta: [] };

  const textParts = [];
  const meta = [];
  atts.forEach(a => {
    if (a.kind === 'text') {
      textParts.push(`----- FILE: ${a.name} -----\n${a.text}${a.truncated ? '\n[...truncated]' : ''}\n----- END FILE: ${a.name} -----`);
      meta.push({ name: a.name, kind: 'text', size: a.size, truncated: !!a.truncated });
    } else if (a.kind === 'image') {
      meta.push({ name: a.name, kind: 'image', size: a.size, dataUrl: a.dataUrl });
    } else {
      meta.push({ name: a.name, kind: 'skip', size: a.size, note: a.skipped });
    }
  });

  const embed = textParts.length
    ? `[Attached file${textParts.length > 1 ? 's' : ''}]\n${textParts.join('\n\n')}\n\n`
    : '';
  return { embed, meta };
}

/* ================================================================
   INPUT HANDLING
================================================================ */
function setupInput() {
  const input = document.getElementById('msg-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Paste images straight from the clipboard into attachments.
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addAttachments(files); }
  });

  setupDragAndDrop();
}

/**
 * Wire drag & drop over the chat area. We use a counter to handle the
 * dragenter/dragleave storm that fires as the cursor moves over child
 * elements — the overlay only hides when the count returns to zero, so it
 * doesn't flicker. dragover must call preventDefault on the document or the
 * browser treats the drop as a navigation and opens the file instead.
 */
function setupDragAndDrop() {
  const chat = document.getElementById('chat');
  const overlay = document.getElementById('drop-overlay');
  if (!chat || !overlay) return;

  let depth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  // Prevent the browser from opening dropped files anywhere on the page.
  ['dragover', 'drop'].forEach(evt =>
    window.addEventListener(evt, e => { if (hasFiles(e)) e.preventDefault(); })
  );

  chat.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('active');
  });
  chat.addEventListener('dragover', e => {
    if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  chat.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('active');
  });
  chat.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('active');
    addAttachments(e.dataTransfer.files);
  });
}

/* ================================================================
   FILE GENERATION — download .txt/.json to browser downloads
   AI outputs ```file:filename.ext blocks, rendered with Save button.
================================================================ */
// Takes the button, not an id + filename pair. The filename comes from a
// ```file:<name> fence -- i.e. from model output or from a peer's message --
// and interpolating it into onclick="downloadFile('...','<name>')" was
// exploitable: parseMarkdown had already turned ' into &#39;, but the HTML
// parser decodes character references in an attribute value BEFORE the JS is
// compiled, so the entity became a real quote again and closed the string.
// Reading it off the element -- the pattern copyCodeBlock already uses -- means
// the value never passes through a JS parser at all.
function downloadFile(btn) {
  const block = btn && btn.closest && btn.closest('.file-block');
  const el = block && block.querySelector('pre code');
  if (!el) return;
  // parseMarkdown ran escapeHtml over the whole block before this attribute was
  // built, so the value is HTML-encoded rather than raw. Decode it here or the
  // saved file is literally named "x&#39;y.txt". textContent round-trip is the
  // cheapest correct decoder and cannot execute anything.
  let filename = (btn.dataset && btn.dataset.filename) || 'download.txt';
  const dec = document.createElement('textarea');
  dec.innerHTML = filename;
  filename = dec.value || 'download.txt';
  const content = el.textContent;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

