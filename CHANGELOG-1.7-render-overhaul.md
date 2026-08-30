# v1.7 — Message rendering: code blocks, tables, lists, maths

*Four things were reported: code boxes rendering badly, LaTeX rendering
inconsistently, columns and grids not rendering cleanly, and a general sense
that output should look better than it did. All four turned out to share one
cause.*

---

## The one bug underneath all of it

`parseMarkdown` was a flat chain of about twenty regex `.replace()` calls over
one string. Once a fence had become `<pre><code>…</code></pre>`, that HTML was
still just text in the variable, so **every later pass ran over the code too**.
Two passes walked tags to protect themselves. The other ten did not.

That single fact produced most of the report:

**A blank line broke a code block apart.** `\n\n+ -> </p><p>` ran inside the
`<pre>`. Per the HTML parsing spec the stray `</p>` synthesises an empty
paragraph, the `<p>` opens a real one inside `<code>`, and the following
`</code>` is then **ignored** — `p` is "special", so the any-other-end-tag step
bails. A blank line in a code sample became a paragraph box carrying
`margin-bottom: 10px`. That is most code samples.

**Copy returned code with no line breaks at all.** `\n -> <br>` ran inside the
`<pre>` too, and `copyCodeBlock` reads `textContent`, where `<br>` contributes
nothing. `def f(x):\n    return x` came back as `def f(x):    return x`.

**Markdown ate code characters.** `int a = b * c * d;` rendered as
`b <em> c </em> d` — the asterisks *deleted*, on screen and in the clipboard.
`**important**` in a comment went bold. `- item` became a bullet. Bare URLs
became links. Headings fired on every line but the first.

The author had already diagnosed this. `js/18-utils.js:724` says the real fix
is "a protect mechanism in parseMarkdown", worked around it locally for the
maths source view, and left it as its own item. This is that item.

### The fix

Extract fenced content **before** any of the rest runs, leave an inert
placeholder, put the rendered block back at the very end.

```
1. extract fences from the RAW text     (raw, so the highlighter sees real bytes)
2. escapeHtml everything left over
3. block structure — headings, tables, lists, quotes, rules
4. inline formatting, per text run only
5. restore placeholders
```

Step 4 is the point: inline passes now run on one text run at a time, never on
a whole message, so they are **structurally incapable** of reaching inside a
code block. Not patched — unable.

The placeholder is `U+E000 <nonce> . <index> U+E001` with a fresh random nonce
per call. Private-use codepoints so `escapeHtml` leaves them alone, and a nonce
so a user who types the sentinel characters cannot forge a slot and inject
stored HTML. There is a test for that.

---

## Fence forms that never worked

The old scanner was one regex. The new one is a line scanner, so fence syntax
is decided in one place, and it picks up four cases that used to fail outright:

| | Before | Now |
|---|---|---|
| `` ```js\r\n `` (CRLF) | raw text, backticks visible | renders |
| `~~~js` | raw text | renders |
| ` ````js ` | rendered, plus a stray loose backtick | renders cleanly |
| indented fence (inside a list) | raw text | renders, indent stripped |
| unclosed fence | raw backticks until the model closed it | renders immediately |

That last one matters more than it looks. `14-scroll.js:338` re-runs
`parseMarkdown` over the whole message on **every streamed token**, so until
the closing fence arrived the user watched unstyled text and visible backticks,
and the box snapped in at the end. An unclosed fence now runs to the end of the
message — which is both what CommonMark says and what makes the box appear as
soon as the fence opens.

---

## Columns and grids

**Tables did not exist.** Not partially — at all. `| Name | Size |` rendered as
literal pipes joined by `<br>`. There is now a GFM table parser: header row,
alignment from the delimiter row (`:---`, `:---:`, `---:`), ragged rows padded
to the header width, escaped pipes kept inside their cell, and inline
formatting inside cells. The wrapper scrolls, not the table, so a wide table
cannot stretch the conversation column.

**Lists were cosmetic.** `- x` became the *character* `&bull;` — no `<ul>`, no
indent, no hanging indent when a line wrapped, and nested items lost their
indentation entirely because HTML collapses leading spaces. `1. x` was replaced
with `$1. $2`, a substitution that does nothing at all. There are real `<ul>`
and `<ol>` now, nested by indent width, with task lists (`- [x]`) and
continuation lines.

Worth knowing: `.message-content ul, ol, li` at `css/04-chat.css:237` has been
dead since it was written, because no tag ever reached it. It works now.

**Also new:** blockquotes (nesting, and lists inside them), horizontal rules,
strikethrough, `***bold italic***`, and headings 4–6. Headings are real `<h1>`–
`<h6>` elements with classes instead of an inline-styled `<strong>` followed by
a `<br>`, so they have block spacing and a stylesheet can reach them.

One subtlety that cost some time: blockquote is the **only** block marker
`escapeHtml` touches. By the time the block pass runs, `>` is already `&gt;`.
Matching a literal `>` meant blockquotes silently never fired.

---

## LaTeX

**Only ```` ```latex ```` fences rendered.** `$$…$$`, `\[…\]`, `$…$` and
`\(…\)` all came out as raw text — and those are how models emit maths most of
the time. `$$…$$` and `\[…\]` now render as display blocks and `\(…\)` inline.

`$…$` is gated, because this is a roleplay app and currency beats algebra in it
by a wide margin. A single-dollar pair is only claimed when the content carries
a backslash, caret, underscore or brace, or is a lone variable name. So
`$x^2$`, `$\alpha$` and `$x$` render, while `It cost $5, then $10 later`,
`I paid $20 and got $5 back` and `costs $5 - $3 net` are all left exactly as
typed. Each of those has a test.

**Environments now render.** Measured against twenty expressions a chat model
actually emits: **15/20 before, 20/20 now**. All five that used to fail were
environments — `pmatrix`, `bmatrix`, `align`, `cases` — which are precisely the
columns and grids of maths.

A LaTeX environment body *is* a grid (rows split on `\\`, cells on `&`), so CSS
grid does the layout with no table markup and no measuring. `matrix`,
`pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix`, `Vmatrix`, `cases`, `aligned`,
`align`, `split`, `gathered` and `array` are supported. `aligned` puts odd
columns flush right and even flush left, so the `=` signs line up the way TeX
does it.

Delimiters are **drawn, not typeset**: brackets, parens and bars are CSS
borders, which stretch with the grid for free. That closes part of the "growing
delimiters" gap the renderer has always had — a glyph does not grow with its
contents. Braces are the one shape borders cannot draw, so those are a scaled
glyph.

The decline gate was left alone and still works by arithmetic rather than by a
list: `\begin{tikzpicture}` leaves `\begin` and `\end` unknown, the ratio gate
sees 2/2, and the block falls through to plain source. That is tested with the
matrix case swapped out for a genuinely unimplemented environment.

---

## Syntax highlighting

No dependency. highlight.js is ~120KB minified for the common languages and
Prism is not much better once you add the grammars people paste; both are more
code than this whole file, for a client whose artefacts have to fit an NSIS
installer.

It is deliberately a lexer, not a parser: comments, strings, numbers, keywords,
builtins and call sites, which is where essentially all of the legibility
comes from. About 40 language aliases across 15 families, plus a separate pass
for HTML/XML because running an identifier lexer over markup would colour every
word of the body text.

**An unknown language is returned as plain escaped text, untouched.** That is
not only caution about mangling — test L in the maths suite asserts that a
declined ```` ```latex ```` block is byte-identical to an untagged fence, and
that only holds if neither is highlighted.

**Performance.** Lexing is the expensive half of rendering, and the whole
message re-renders on every streamed token, so a reply with three finished code
blocks would re-lex all three sixty times a second for three identical answers.
`highlightCode` is memoised on the exact source, bounded at 64 entries with
oldest-out eviction. Measured on a 6.5KB message (240-line Python block, 12-row
table, maths, 40-item list):

| | ms per render |
|---|---|
| old renderer | 0.14 |
| new, no cache | 2.00 |
| new, with cache | 0.67 |

Streaming that whole message token by token costs 543ms of render in total.
Being honest about the trade: the new renderer is ~5x the old one's cost,
because the old one was fast largely by not doing the work correctly. 0.67ms
per frame is not a number anyone will feel.

---

## Verify

**Client: 491 assertions across 8 suites, all passing** (up from 388).

`test-markdown-render.mjs` is new — **103 assertions** running the real
`parseMarkdown`:

| Section | Covers |
|---|---|
| A | code survives every markdown pass; Copy is byte-exact |
| A2 | a forged placeholder cannot inject stored HTML |
| B | CRLF, tilde, four-backtick, indented, nested fences |
| B2 | an unclosed fence renders the same as a closed one |
| C | tables: alignment, ragged rows, escaped pipes, inline content |
| D | lists: nesting, ordered, tasks, continuation lines |
| E | quotes, rules, headings, strikethrough |
| F | every maths delimiter form, and the currency cases that must not render |
| G | highlighting, including that unknown languages stay plain |
| H | regressions: emphasis, dialogue colour, links, paragraphs, escaping |
| I | 24 malformed inputs and 60-deep nesting, no throw, no hang |
| J | the escaping boundary — see below |

**Section J is the one that matters.** This rewrite moved the escaping boundary
twice: the pipeline reordered around `escapeHtml`, and the highlighter now
slices raw source and escapes each slice. So the output is **audited against an
allowlist**, not spot-checked against payloads — every tag in the output is
parsed and anything outside the permitted set of tags, attributes and the three
known `onclick` handlers is a failure. 26 payloads, each run with and without a
dialogue colour, plus four hostile colour values. That catches a class of bug
rather than the examples I happened to think of.

`test-math-render.mjs` is **188 assertions**, up from 178. Two of its sections
changed, both because a documented gap closed:

- **Section E** asserted matrices fall through to highlighted source. They no
  longer do, so the assertions are inverted and extended (grid layout, cell
  splitting, escaped `\&`, alignment, delimiters) — the gap is closed, not the
  test relaxed. It still asserts that an *unimplemented* environment falls
  through, using `tikzpicture`.
- **Section M** asserted no backticks survive a nested fence. That was true only
  because the old scanner closed at the first ``` and threw the rest away. The
  scanner is CommonMark-correct now and keeps them, so the assertion is the
  meaningful property instead: they end up inside a `<pre>` as inert escaped
  text, never loose in the message, and never typeset as maths.

A related fix came out of that: `mathWorthRendering` now declines a body
containing a fence marker. Without it, ```` ```latex ```` on its own line
inside an outer block was typeset — three literal backticks italicised letter
by letter in the middle of the equation.

**Go:** untouched by this change. `go build`, `go vet` clean; `go test ./...`
passes except `TestJobLifecycleAgainstDeadUpstream`, the pre-existing race that
fails identically on the untouched tree.

**`stage-web.sh` reconciles**: 24 js / 17 css against `chat.html`, with the new
`css/17-markdown.css` linked.

---

## Still needs a human at a browser

The suite proves the HTML is correct and that nothing executes. It cannot tell
you whether it *looks* right. **`render-preview.html`** is for that — open it,
no build step, and it loads the real `js/18-utils.js` and the real stylesheets
so it cannot drift from what ships. (`math-preview.html` is still the tool for
atom-level maths detail; this one is about whole messages.)

Worth looking at specifically:

1. **Matrix delimiters.** The brackets are CSS borders and the braces a scaled
   glyph. The brace scale steps (`math-env-rows-2` … `-8`) are a guess and
   almost certainly want adjusting against your font stack.
2. **`aligned` blocks.** Check the `=` signs actually line up across rows.
3. **Table density.** Padding and the uppercase header treatment are a first
   pass; narrow the window to check the horizontal scroll and the mobile rules.
4. **Highlighter colours.** Six token classes against the panel background.
   `tok-com` at `#6b7f8a` is the one most likely to be too dim.
5. **Inline maths on a text line.** `$x^2$` mid-paragraph must not push the
   line height around.
6. **A long code block on a phone.** The sticky header, the negative margin
   fix, and the horizontal scroll all interact there.

## Not done, deliberately

**Setext headings** (`===` under a line), **reference-style links**,
**footnotes** and **definition lists**. None appear in model output often
enough to justify the parser surface.

**Incremental re-lexing during streaming.** The memo cache handles every block
that has stopped changing; the one still arriving is re-lexed each frame. Fixing
that properly means a resumable lexer, which is a lot of machinery for 0.67ms.

**`\left(` still draws a fixed-size delimiter.** The drawn delimiters are
environment-scoped; making `\left`/`\right` stretch around arbitrary content is
the same mechanism but needs the parser to pair them first.

---

## 1.7.1 — the 503 fixes

A support report described a 503 on the web port that survived uninstalling,
deleting the leftovers, wiping the folder and reinstalling to the default path.
Every one of those remedies was reasonable and none of them could have worked,
because nothing they touched was where the problem lived.

### Why nothing the user tried could work

`ConfigDir()` and `DataDir()` are XDG paths on **every** platform, Windows
included. Settings live in `%USERPROFILE%\.config\gobbonet`, not under
`$INSTDIR` — and neither uninstaller removed them. `setup-lan.bat` registers a
URL reservation with HTTP.SYS, which is stored in the Windows kernel and
likewise unaffected by deleting a folder. A reservation with no listener behind
it makes Windows answer that port with a 503 by itself, which is why the error
was a clean HTTP status rather than a connection failure.

### Blockers

- **`server_exe` is now cleared in both installer branches that left it.**
  Choosing a remote backend, or installing a bundle with no engine in it, set
  other keys and left a previous install's absolute `server_exe` in place. The
  "will start in remote mode" message was a claim the code did not honour.
- **Both installers now stop running processes before touching files.** The
  uninstaller went straight to deleting `gobbonet.exe`; a running server holds
  the folder open, which is the "folder is still open in another program"
  report. New `stop-gobbonet.bat`, also runnable by hand.
- **`teardown-lan.bat` removes the firewall rules and the URL reservation.**
  The commands existed in `setup-lan.bat` only as `echo` text. They now run.
  Because this is a per-user install and `netsh` needs Administrator, the
  uninstaller asks for elevation — and only when `setup-lan.bat` actually ran.
- **The uninstaller offers to clear settings and conversations**, by running
  `gobbonet uninstall`, which already knew how. This is the headline fix: it is
  what makes a reinstall genuinely start clean.
- **The Linux launcher now checks identity, not liveness.** `port_is_open` was a
  bare TCP connect, so any listener on 9066 made GobboNet decline to start and
  open a browser onto whatever owned the port. It now requires a response only
  our server gives, and says which of the two problems it hit.

### Then

- **`gobbonet.exe` owns `.gobbonet-port`**, written after the bind succeeds.
  Previously nothing wrote it, so `setup-lan.bat` could open the firewall and
  reserve a URL on one port while the server bound another — a 503 on the
  address the user was told to visit, while the server ran fine elsewhere.
- **A stale `server_exe` self-heals.** If the configured path is gone but a
  `llama-server` sits beside the running binary, it is adopted and written back.
  Still fatal when there is genuinely no engine — that error was always correct,
  it was just fatal about a path the installer chose, not one the user typed.
- **Fatal startup errors are written to `startup-error.log`** beside the config,
  and the message says where. On Windows these landed in a console window that
  closed immediately.
- **`gobbonet doctor`** prints the config path, both data directories, ports,
  who owns them, `server_exe` status and — on Windows — any URL reservation on
  the port, with the command to clear it. Every remedy in that support report
  was a guess because nothing would tell the user where to look.

### Note for maintainers

`TestJobLifecycleAgainstDeadUpstream` fails when `GOMAXPROCS=1`: its poll loop
spins 200 times with no sleep, so on a single-P scheduler it can exhaust every
iteration before the job goroutine finishes its dial. It passes from 2 upward.
Not touched here, but a loaded CI runner could hit it.
