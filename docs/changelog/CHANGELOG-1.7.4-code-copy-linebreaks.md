# 1.7.4 — Copy on a code block keeps its line breaks

Roadmap item 1. Filed as "copying code removes linebreaks [not sure if i fixed
this one]", which turns out to be exactly the right amount of doubt: half of it
was fixed, and the half that was not arrives by a road the fix did not cover.

## What was already fixed

`parseMarkdown` used to be a flat chain of regex `.replace()` calls over one
string, so once a fence had become `<pre><code>…</code></pre>` that HTML was
still just text in the variable and every later pass ran over the code too. The
one that mattered here was `\n -> <br>`: a `<br>` contributes nothing to
`textContent`, and `copyCodeBlock` reads `textContent`, so Copy returned every
line of the block welded together with no separator at all.

That was fixed by taking fenced content out of the string before any of those
passes run and restoring it at the end. It holds. Every fence the scanner
**recognises** copies byte-exact, blank lines and tabs and all.

## What was not

The scanner did not recognise every fence, and a fence it declines is not
inert. It falls straight through to the paragraph pass and gets the
`\n -> <br>` treatment the extraction was built to prevent — the original bug,
reached from the other side. Worse than the original, in one respect: there is
no Copy button on a declined fence at all, so the user selects it by hand, and
a `<p>` is `white-space: normal`, so every level of indentation collapses on
the way out.

Three shapes were declined.

**A fence indented four spaces or more.** The opening pattern was
`^([ \t]{0,3})`, which is CommonMark's rule for a fence at the *top level of a
document*. Inside a list item the limit is three spaces past the item's
**content column**, so this is legal markdown:

```
1. Install it:

    ```sh
    npm i
    ```
```

and four spaces is what most models indent list continuation by. This is not an
exotic shape. It is the single most common way a code block arrives inside a set
of instructions, which is the most common thing anyone asks a model for code in.

**The same at six or eight spaces**, under nested lists.

**A fence inside a blockquote** — ``> ```js `` — which is how one arrives when
the model is quoting a source.

## The change

Two edits, both in `js/18-utils.js`.

### 1. `mdFenceOpen()` — the scanner learns about containers

Split out of `mdExtractFences` so the decision lives in one readable place.

- **The indent cap is gone.** `[ \t]{0,3}` becomes `[ \t]*`, and the matching
  cap on the closing fence goes with it. This is free rather than risky:
  uncapping only creates an ambiguity if there is an indented-code-block rule
  for the looser reading to collide with, and this renderer has never had one.
  Four leading spaces have never meant anything to it. A line of three-or-more
  backticks alone is not ambiguous enough to be worth a cap.
- **A blockquote prefix is allowed in front.** `MD_FENCE_QUOTE_RE` matches
  `>` markers, each optionally followed by one space, nested or not. It matches
  a **literal** `>`, unlike `MD_QUOTE_RE` in the block pass, which runs after
  `escapeHtml` and therefore has to match `&gt;` — fence extraction happens
  first, on raw text.

Body lines inside a quoted fence get the same prefix stripped before they are
read as code or tested against the closing fence. Without that, the block runs
to the end of the message and every line reaches the clipboard with a `> `
welded to the front.

The prefix is then put **back** in front of the placeholder rather than dropped.
It is the only thing that tells the later block pass this block belongs inside a
`<blockquote>`, and by the time that pass runs `escapeHtml` has turned it into
the `&gt;` that `MD_QUOTE_RE` is looking for. Nesting falls out for free: `>>`
is peeled one level per recursion, the same as any other quoted content.

Indentation behaviour is deliberately left as it was for the shapes that already
worked: the placeholder is emitted at column 0, so the block renders after the
list rather than inside the `<li>`. That is what a 2- or 3-space fence has done
since the extraction was written, and making 4-space fences match it is the
consistent answer. Nesting blocks into list items is a rendering change, not a
clipboard one, and does not belong in this fix.

### 2. `codeBlockText()` — the clipboard stops depending on distant invariants

`copyCodeBlock` no longer reads `codeEl.textContent`. It walks the node tree,
counts a `<br>` as a newline, and folds CR and CRLF into LF.

The renderer does not put `<br>` inside a `<pre>` any more, so on today's HTML
this changes nothing. That is the point. `textContent` was *correct*, but only
because of an invariant maintained three hundred lines away, and it was one
stray `<br>` from being silently wrong in precisely the way this app already
shipped once. Counting the break here costs nothing and makes the function right
on its own terms, whatever the HTML turns out to contain.

CR folding is belt-and-braces: the HTML parser normalises CRLF when it builds
the DOM, so this only matters for a path that assembles a node tree without
going through the parser. A lone `\r` in the middle of pasted code is the kind
of thing that produces a syntax error three days later with no visible cause.

## What pins it

**`tests/test-code-copy.mjs`** (new, 36 assertions) drives the real
`parseMarkdown` and the real `copyCodeBlock` over a node tree built from the
rendered HTML. `tests/` has no install step and is not getting one, so the DOM
is about sixty lines of shim rather than a dependency — enough for the
`childNodes` / `nodeType` / `closest` / `querySelector` surface that
`copyCodeBlock` actually touches.

Two details of the shim are load-bearing:

- It **decodes character references** in text nodes. Code content is
  HTML-escaped on the way in, so a shim that skipped decoding would assert on
  `&lt;div&gt;`, pass, and tell you nothing about what reaches the clipboard.
- Its `textContent` is **deliberately naive** — element boundaries contribute
  nothing, including `<br>`. If the shim "fixed" `<br>` too, the test could not
  tell `textContent` and `codeBlockText` apart, which is the one distinction
  section D exists to make.

Both halves of the fix were checked against the unfixed code and fail without
it: reverting the scanner fails nine assertions in section A, and reverting
`copyCodeBlock` to `textContent` fails the wiring guard in section F. A test
that passes on broken code pins nothing.

**`tests/test-markdown-render.mjs`** gains section B3 (21 assertions) for the
rendering half — fence placement at 0, 1, 2, 3, 4, 6 and 8 spaces, blockquoted
and nested-blockquoted fences, and the negatives: indented prose is still not a
code block, an unquoted fence did not grow a blockquote, and a blockquote of
ordinary prose still opens nothing.

## Staging

`js/` is the source of truth and `stage-web.sh` copies it into the `web/` root
the server serves; the `linux-amd64/` bundle carries its own staged copy. Both
have been re-staged. Editing `js/` without re-staging means the running app
keeps serving the old file and nothing anywhere reports a problem, which is the
failure `stage-web.sh`'s header comment was written to prevent — and it applies
to a bugfix exactly as much as to a merge.

## Not changed

Version strings still say 1.7.3. Roadmap items 8 and 12 cover the About section
and the internal strings, and bumping early means every intermediate test build
claims to be 1.7.4, which defeats the purpose of item 8.

`copyMessage` and `copyLoreSummary` were both reviewed and left alone. Neither
reads from the DOM — they copy `m.content` and `thread.lore` directly — so
neither can lose a line break this way.
