# v1.7 — item 1: LaTeX rendering

Round 6. Items 1–10 of the old numbering are in the tree and untouched; this
is item 1 of the revised roadmap.

| Files | Net |
|---|---|
| `js/18-utils.js`, `css/16-math.css` (new), `chat.html` | +510 / −2 |
| `test-math-render.mjs`, `math-preview.html` (new) | dev only |

Two fixes landed after first-pass testing on a real model — see **Two bugs
found in use** below. Both are in this same patch.

**178 assertions, 0 failures.** All five earlier suites still pass
(42 + 52 + 10 + 29 + 14).

---

## Confirmed against the tree first

All four integration claims in the roadmap hold at the current HEAD:

- `escapeHtml` (`js/18-utils.js:104`) touches only `& < > " '`. Backslashes,
  carets, underscores and dollars arrive intact. ✓
- No `_` emphasis in their markdown — only `*` and `**`
  (`js/18-utils.js:376-377`). Subscripts don't collide. ✓
- `$` carries no meaning anywhere in `parseMarkdown`. ✓
- The fenced-block handler captures the language tag. ✓

One correction to the plan, not the diagnosis: the roadmap says the fence
handler "is a natural hook", which is right, but the new pass has to run
**before** it. Its `(\w*)` matches `latex` perfectly well and would print the
source. The math replace is inserted above it at `js/18-utils.js:307`.

## Where the code lives, and why not its own file

The roadmap's framing implies a standalone module, and I started there. It
can't go at the end of the load order: `js/24-boot.js:14` is an
`(async function boot(){...})()` IIFE that runs at load, and its continuation
after the first `await` lands in a microtask — before the next `<script>` tag
is fetched. A renderer defined after it would be undefined when the first
message renders. Inserting a file mid-order means renumbering, and this
codebase treats "number = load order" as a contract.

So it's a banner-delimited section in `js/18-utils.js` directly above
`parseMarkdown` — its only caller, in the file the roadmap points at. The file
goes 694 → 1148 lines, in line with `js/10-chat.js`. CSS has no load-order
hazard and does get its own file, `css/16-math.css`.

`stage-web.sh` counts `js/` and `css/` files against what `chat.html`
references and refuses to stage a mismatch. Adding one CSS file and one link
keeps it balanced: 24 js / 24 refs, 16 css / 16 refs. Checked.

## The escaping boundary — the one genuinely new hazard

`parseMarkdown` escapes the **whole message** at line 295, before it looks for
fences. So a fence body reaches the renderer with its `< > & " '` already
entities. That forces a choice, and both obvious options are wrong:

- Parse the escaped text directly, and the tokenizer sees `&`, `l`, `t`, `;`
  as four characters. Wrap each in a span and the browser prints a literal
  `&lt;`.
- Emit without re-escaping, and you have an XSS hole.

The renderer takes **raw** LaTeX and re-escapes every leaf itself, so
`renderMathHtml()` is safe to call from anywhere. `mathDecodeEntities()` is
the thin adapter at the one boundary — the exact inverse of `escapeHtml`,
decoding `&amp;` **last** so `&amp;lt;` yields the literal text `&lt;` rather
than being decoded twice into `<`. Its output goes straight into the tokenizer
and comes back through `escapeHtml`; it never builds HTML. That ordering is
asserted directly (section B).

Adding anything named like an unescape function to a codebase that just
finished escaping hardening deserves the scrutiny — hence the comment block
at the definition and the tests.

## Two rules the renderer holds

1. **Every character that reaches the output goes through `escapeHtml`** —
   including the fixed symbol table, so there is one rule to audit rather than
   a list of trusted sources.
2. **Class names are fixed literals.** `\mathbb` maps to `bb` via a table;
   nothing from input is ever interpolated into a tag, attribute or style.

Nothing touches `innerHTML`, nothing evaluates anything. A thrown exception
falls back to escaped source rather than blanking the message.

## A bug the tests found in my own code

`mathSourceSafe` originally chained six `.replace()` calls. The `*` step emits
`&#42;`, and the later `#` step then rewrote the `#` **inside that entity**,
producing `&&#35;42;`. Same class of ordering bug as decoding `&amp;` last,
found by asserting the property rather than the symptom. It's a single-pass
replace now, with the trap written down at the definition.

## A pre-existing bug this had to work around

Everything after the fence hook in `parseMarkdown` is a regex over the whole
message, and several passes have no idea what a `<pre>` is. A source view
containing `a * b * c` comes out as `a <em> b </em> c`.

**This is not new.** A ```` ```js ```` block containing `a * b * c` is mangled
identically today — verified before changing anything:

```
```js  →  <pre><code>a <em> b </em> c</code></pre>
```

It matters more here because `copyCodeBlock` reads `textContent`, so Copy
would hand back LaTeX with the asterisks silently deleted. `mathSourceSafe`
emits `* [ # - ` ` ` and newlines as numeric entities inside the source `<pre>`
only; the HTML parser decodes them before anything reads `textContent`, so
Copy yields the exact bytes the model sent (asserted).

**The general case is left alone** — it's unrelated code, and the real fix is
a protect mechanism in `parseMarkdown` that would change code-block behaviour
too. Worth its own item; the mechanism is written up above `mathSourceSafe`
for whoever takes it.

## Scope: fences only, and a Source toggle

Fence-scoped per the roadmap, so `$5, then $10` and `*grins*` are untouched —
prose never reaches the math pass at all. Asserted in section H.

Beyond spec: **every block carries a Source toggle.** The roadmap's earlier
draft worried that "LaTeX in a fenced code block usually means show me the
source", and the revised one decides to render. The toggle stops that being a
guess. It also matters because the renderer has known gaps — a user who gets a
mangled matrix can see what was actually sent instead of being stranded with a
wrong picture. One word added to `copyCodeBlock`'s `closest()` selector; the
existing `pre code` lookup finds the source unchanged.

## Known gaps, unchanged from the roadmap

Matrices and aligned environments, growing delimiters (`\left(` draws
fixed-size), nested script shrinking, and real TeX spacing classes — relations
and binary operators get one flat margin. All four are written into the SCOPE
comment at the top of the section. Unknown commands degrade to highlighted
source, which is what users see today, so it cannot render worse than the
status quo.

---

## Two bugs found in use

Caught by running a real model against the shipped build, not by the suite.

### 1. The tag match was case-sensitive

`(latex|math|tex)` with no `i` flag. ```` ```LaTeX ```` — the spelling models
reach for most often — missed, and fell through to a code box.

What made it nasty to diagnose: the generic handler lowercases the tag for
display, so the code block header still read **"latex"**. The miss looked
exactly like a hit. The label is not a diagnostic and there is now a test
saying so.

Now case-insensitive, and tolerant of a trailing space after the tag and of
CRLF line endings. Aliases `katex`, `equation` and `displaymath` added, since
models emit those too. `latexish` is still correctly not claimed.

CRLF is worth a note: the generic code-block handler requires a bare `\n`, so
a CRLF ```` ```js ```` block renders as raw text today. Pre-existing, left
alone as unrelated code, but it means a CRLF message now gets *better*
treatment for maths than for code. Flagging the asymmetry rather than
widening the diff.

### 2. A whole document was being typeset as an expression

The report. Asked for "LaTeX in a code block", the model emitted a document —
`\documentclass`, `\begin{document}`, `\section`, prose paragraphs, list
environments, and a nested ```` ```latex ```` fence inside the outer one.

Measured on that input: **6 amber spans out of 6 commands — 100% unknown** —
and because math mode eats whitespace, `This is a simple example of` rendered
as `Thisisasimpleexampleof` in italics.

**This disproves a claim in the roadmap and in my own first write-up.**
"Unknown commands degrade to highlighted source, so it cannot render worse
than the status quo" is true per *command* and false per *block*. A wall of
amber with the spaces removed is materially worse than the plain code block
the user had before.

So `renderMathBlock` now decides whether rendering is worth it and returns
`null` to decline, which leaves the fence for the ordinary code-block handler.
Four gates, cheapest first:

| Gate | Catches |
|---|---|
| Document commands (`\documentclass`, `\section`, `\item`, `\begin{itemize}`…) | documents |
| A line with 4+ real words and no `\ ^ _` on it | prose paragraphs |
| No commands, scripts, grouping or operators anywhere | `hello world` |
| After parsing: unknown commands > 34% of all commands | everything else |

The fourth gate is the one that matters, because it needs no list of things to
look for. `\begin{pmatrix}` declines by arithmetic rather than by being
enumerated — 2 commands, both unknown — and so will any environment nobody has
implemented yet.

Declining is free: a declined block is byte-identical to what an untagged
fence produces, asserted directly. The user gets exactly what they had before
this feature existed.

**Nested same-length fences remain ambiguous** and always will be — markdown
itself can't express them, and both handlers end the outer block at the inner
fence. The test only pins down that nothing leaks: no stray backticks in the
output, nothing executable out of the ambiguity.

### Still not handled, and deliberately

`$$...$$` and `\[...\]` produce plain text. That is the roadmap's fence-only
scope, not a bug — but it is worth knowing that display delimiters are how
models most often emit maths, so a good fraction of real output still won't
render. That is the inline-math item, and it's the one that needs the
delimiter false-positive work ("it cost $5, then $10 later").

## Verification

`test-math-render.mjs` — **141 assertions**, running the real renderer and the
real `parseMarkdown`.

| # | Section | Result |
|---|---|---|
| A | 10 injection attempts | no live markup; payload shown as inert text |
| B | escaping boundary | decode inverts exactly once, in both directions |
| C | 49-expression corpus | 49/49 render without falling through |
| D | structure | fractions stack, big operators take limits, `x_i^2` stacks both scripts |
| E | documented gaps | matrices fall through to escaped, legible source |
| F | fences | `latex`/`math`/`tex` render; `js` and untagged are untouched |
| G | mixed message | emphasis, bold, inline code and maths coexist |
| H | roleplay prose | `*grins*`, `$5`, `x_i` untouched; dialogue colour still fires |
| I | malformed input | 11 cases, no throw, no hang, 200-deep nesting under 1ms |
| J | tag balance | unbalanced output would corrupt the rest of the message |
| K | fence tag tolerance | 10 spellings, trailing space, CRLF; `latexish` not claimed |
| L | declining | the reported document declines; 9 expressions still render |
| M | nested fences | no stray backticks, nothing executable |

**On the corpus figure:** the roadmap's prototype scored 48/49 with
`\begin{pmatrix}` the single miss. My 49 expressions are my own — the
prototype wasn't in the upload — and matrices are tested as a known-failure
case in section E rather than counted in the corpus. So 49/49 is not the same
measurement as 48/49 and shouldn't be read as beating it.

## What needs a human at a real machine

The suite proves nothing executes and that expressions parse. It cannot tell
you whether a fraction sits on the baseline. **`math-preview.html`** is for
that — open it in a browser, no build step. It loads the real
`js/18-utils.js` and `css/16-math.css`, so it can't drift from what ships.
It's a dev tool; `stage-web.sh` copies a fixed file list and won't pick it up.

Worth looking at specifically:

1. **Radical joins.** `.math-radicand`'s `border-top` has to meet the `√`
   glyph. That join is font-dependent and the tuning is a guess.
2. **`\sqrt[3]{8}`.** The index is tucked in with `margin-right: -0.45em`.
   Almost certainly needs adjusting on a real font stack.
3. **Baselines.** Fractions and stacked limits use `vertical-align` in `em`.
   Check a line mixing `\frac{a}{b}` with ordinary text.
4. **`\mathcal` and `\mathfrak`** fall back to `cursive` / `fantasy` and will
   look different per-OS. May be better dropped to plain italic than left to
   Comic Sans on some machines.
5. **Mobile.** `.math-rendered` scrolls horizontally rather than wrapping
   mid-fraction. Check a long equation on a phone.

## Still not done: the `::`-in-a-block fix

Unchanged from three rounds. 53 sites, and the best spam candidate
(`launch.bat:2401`, in `:http_alive`, called from the health-monitor loop)
contains `>=` in its comment text, so a mechanical `::`→`rem` conversion would
create a redirection to a file named `=`. Wants its own item and one run on
real Windows.
