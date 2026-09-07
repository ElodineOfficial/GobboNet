# v1.7.3 — three leftovers, reimplemented

*Closes PR #30. All three found by **John McCardle** ([@jmccardle](https://github.com/jmccardle)).*

Reimplemented rather than merged, per the contributing note — the fixes below
are his findings in this codebase's own shapes, and the PR's branch was cut
against 1.6.0. The diagnoses were correct as filed; two of them turned out to be
worse than the one-line summaries suggested.

---

## 1. One Y answered two questions — and the second one ran a binary

> *"one Y = two answers answered at the same time."*

`:prompt_yn` shared a single `_YN` variable across every confirmation in
`launch.bat` and never cleared it:

```bat
set "%~2=N"
set /p "_YN=%~1 (Y/N): "        <- no clear before this
if /i "!_YN!"=="Y" set "%~2=Y"
```

`set /p` **does not touch its variable when the user submits an empty line.** It
leaves whatever was there before. So a `Y` typed at any prompt stayed in `_YN`
and was re-read as the answer to the next one.

The pair that makes this serious sits about a hundred lines apart:

- `Download llama.cpp now?` → **everyone answers Y**
- `Extract and run this UNVERIFIED download?` → the gate that exists to make
  someone consciously accept an unverified executable

That second prompt is reached only when no SHA-256 is pinned for the build that
just came down. Its entire purpose is to be a conscious decision. It was being
satisfied by a keystroke aimed at a different question, and **the gate failed
open**.

**Fixed** by clearing `_YN` before the read and again after, so an empty answer
can no longer inherit and a stale one cannot outlive the call. That covers all
six call sites.

**Also hardened**, because clearing alone does not close everything. It fixes
the stale-value path; it does not fix type-ahead. A user who mashed `Y` and
Enter while the 300 MB download ran still has that sitting in the console buffer
when the next prompt paints, and `cmd` has no portable way to flush it. So the
one prompt where a wrong answer runs an unverified binary now uses
`:prompt_confirm`, which demands the whole word `YES`. A buffered `Y` is not
`YES`, so it fails closed and the user is asked again by a prompt they can
actually see. The other five prompts are unchanged Y/N.

## 2. A path sanitizer that silently rewrote paths

`identify-model.ps1` ran `MODEL_CHAT_TEMPLATE_FILE` — a **filesystem path** —
through `ConvertTo-BatchSafe`, the *argument* sanitizer, which strips
`% ! ^ & < > | "`.

The first four of those are **legal in Windows paths**. This did not fail
loudly. It handed back a different path. A sidecar template named
`Qwen3 & Friends.jinja`, a model under a folder like `Models & Templates`, or a
user whose account name contains `!` all produced a path pointing at a file that
does not exist — and the symptom was llama-server refusing a template that is
plainly sitting right there.

`fileserver.ps1` had already learned this: it carries `ConvertTo-CmdArgSafe`
*and* a deliberately gentler `ConvertTo-CmdPathSafe`, with a comment explaining
why. `identify-model.ps1` never got the matching half. That is exactly what
McCardle meant by *"completes the same sanitizer logic already used in
fileserver.ps1."*

**Fixed** with `ConvertTo-BatchPathSafe`. The security requirement is unchanged
and is met by less: these values land inside `set "VAR=..."` in a generated
`.cmd` that `launch.bat` CALLs, so what must be impossible is escaping those
quotes or starting a new line. That is exactly two characters — `"` and CR/LF —
and both are **illegal in Windows filenames**, so removing them cannot cost a
legitimate path anything.

## 3. A gate that validated the scheme and nothing else

> *"safeImageUrl's blob could pass unsanitized output. We can sanitize it before
> sending it to other call sites."*

Correct, and the shape of it is worth spelling out. The three branches were not
equally careful:

| Branch | Check |
|---|---|
| `data:` | anchored end to end, explicit character class — nothing but base64 survives |
| `https?:` | `/^https?:\/\//i` — **prefix only** |
| `blob:` | `/^blob:/i` — **prefix only** |

Neither of the last two was anchored, so both returned the entire rest of the
string unexamined. `blob:x" onerror="alert(1)` passed the gate.

Nothing is exploitable through today's call sites — every one escapes on the way
out, `escapeHtml` for `src` attributes and quote-escaping for the CSS background.
But the function is *named* `safeImageUrl` and is the designated gate, so a
future caller that reasonably trusts its output would inherit an unvalidated
string. That is the whole of McCardle's "before sending it to other call sites."

**Fixed** so the contract the name implies is the contract it keeps. `safeUrlBody`
refuses whitespace, control characters, both quote marks, angle brackets and
backslash — the characters that terminate a URL context. Parentheses, `&`, `?`,
`%` and `=` stay legal, because they appear in real image URLs and a quoted CSS
string tolerates them.

The **http(s) branch is fixed alongside it**, unreported. It is the same defect,
and fixing only the branch that got filed is how `identify-model.ps1` ended up
one sanitizer short in the first place.

`sameOriginBlob` additionally refuses a `blob:` URL carrying somebody else's
http(s) origin — that did not come from this page and the browser will not
resolve it anyway. `blob:null/…` is untouched, since that is what `file://` mode
produces and the attachment path depends on it.

---

## Tests

`tests/test-prompt-safety.py` — 34 invariants over items 1 and 2. Neither can be
exercised on CI: `launch.bat` needs an interactive Windows console, and
`identify-model.ps1` needs a real GGUF and a PowerShell host.

The PR closed with a suggestion worth taking up:

> *"which suggests there's several more 'pretty darn neat' CI/CD things that can
> be done to validate GobboNet's PowerShell portions."*

It proposed parsing the PowerShell with its own AST under
`mcr.microsoft.com/powershell`. This file does the same job statically, so it
needs no container and runs anywhere the rest of the suite does. It asserts every
emitted `MODEL_*` value is either sanitized or numerically cast, that
`*_FILE` fields use the **path** sanitizer specifically, and that the path
sanitizer does not strip characters legal in Windows paths.

`tests/test-image-url-gate.mjs` — 37 assertions driving the real `safeImageUrl`,
ending with a corpus check that nothing it returns can carry a character capable
of ending an attribute or a `url()`.

Both were verified against the pre-fix code: reverting item 1 trips 3
assertions, item 2 trips 1, and item 3 trips 16.
