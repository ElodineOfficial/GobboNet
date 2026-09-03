# v1.7 — Cydonia speaks French

*Closes #20. Supersedes #40, whose conclusion was right and whose scope was
narrower than the bug.*

---

## Symptom

Load Cydonia 24B and the character stops being the character. It answers in
French and cites research papers. From #20:

> my Tifa bot was speaking French and citing research papers to me

The fine-tune is intact. It just never realises it is in a conversation, so
what shows through is the *base* Mistral model — and Mistral's pretraining is
heavy on French and academic prose.

The reporter found the workaround themselves: set `useJinja=1` and blank the
chat template.

---

## Cause

One space.

GobboNet forced llama.cpp's built-in `mistral-v7`. The correct template for
these models is `mistral-v7-tekken`. Here is the entire difference between
them, from `src/llama-chat.cpp`:

```cpp
const char * trailing_space =
    tmpl == LLM_CHAT_TEMPLATE_MISTRAL_V7 ? " " : "";
...
ss << "[SYSTEM_PROMPT]" << trailing_space << content << "[/SYSTEM_PROMPT]";
ss << "[INST]"          << trailing_space << content << "[/INST]";
```

`mistral-v7` emits `[INST] Hello`. The tekken variant emits `[INST]Hello`. On
a Tekken tokenizer that space merges into the following token and shifts every
boundary after it, so the delimiters the fine-tune was trained to recognise
never quite appear. The model concludes it is not in an instruct conversation
and falls back to base behaviour.

llama.cpp's own source comment points at the right variant, linking
Mistral-Small-3.1-24B-Instruct to the **v7-tekken** section of the model card.

---

## Why the wrong one was chosen

The old comment was explicit, which is what made it checkable. Paraphrased: use
`mistral-v7` and not `mistral-v7-tekken`, because the tekken name is missing
from llama.cpp's built-in table on shipped builds, and a name llama.cpp does
not recognise gets treated as literal template *body* — rendering a constant
~8-token string for every request. It named a build: *"e.g. b8941, the one this
project ships"*.

Checked at that exact tag. `src/llama-chat.cpp` line 38:

```cpp
{ "mistral-v7-tekken", LLM_CHAT_TEMPLATE_MISTRAL_V7_TEKKEN },
```

It is there. The name landed between b5300 and b5600 — thousands of builds
before b8941, and before b9294 (pinned for Windows) and b10456 (pinned for
Linux). **No engine this project has ever shipped lacks that name.**

The concern was real once. It was written down as present-tense fact, and the
claim outlived its truth in three files.

The same comment called the trailing space *"harmless for inference."* That
sentence is the bug.

**A naive fix would not have worked.** Both `fileserver.ps1` and
`supervisor.go` *unconditionally* rewrote `mistral-v7-tekken` back to
`mistral-v7` on the way to llama-server, so even a user setting it by hand was
silently overridden. Four places, not two.

---

## Fix

PR #40's answer — always use the embedded template for anything matching
`cydonia|asmodeus|mistral-small` — reaches the right result but discards a real
concern. Mergekit children copy `tokenizer_config` from whichever parent
mergekit happened to pick, so their embedded template can be malformed. That is
why the override existed.

There is no need to guess, because **the classifier already reads
`tokenizer.chat_template` out of the GGUF header** — in both the Go and
PowerShell paths. The name-based override simply returned before anything
looked at it.

So it looks:

- **Embedded template present and plausible** → use it (`useJinja=1`, blank
  template). Right by construction for a fine-tune: Cydonia v4.3 descends from
  a single parent, `mistralai/Mistral-Small-3.2-24B-Instruct-2506`, so its
  `tokenizer_config` is that parent's.
- **Otherwise** → `mistral-v7-tekken`, correctly spaced for the tokenizer these
  models use.

"Plausible" is three cheap checks that are hard to pass by accident: Jinja
control flow (`{%` or `{{`), a Mistral delimiter (`[INST]`), and length ≥ 80.
Deliberately not a Jinja parse — llama.cpp compiles the template itself and
refuses to start on one it cannot, so a stricter check here would only
duplicate the engine's opinion and add a second place to be wrong.

The first check is also what catches the failure the old comment described: a
bare template *name* arriving where a template body was expected.

Both rewrites are gone. The classifier decides; the layers below carry that
decision rather than second-guessing it.

---

## Files changed

| File | Change |
|---|---|
| `internal/models/classify.go` | Inspect the embedded template; fall back to `mistral-v7-tekken`; new `usableEmbeddedTemplate()` |
| `internal/supervisor/supervisor.go` | Removed the tekken → v7 rewrite |
| `identify-model.ps1` | Same decision; new `Test-UsableEmbeddedTemplate` |
| `fileserver.ps1` | Safety net uses tekken and no longer clobbers a `jinja=1` decision; removed the rewrite |
| `internal/models/classify_test.go` | Four classifier cases, a helper unit test, and a new built-in-name invariant |

The Go and PowerShell helpers must agree, or the launcher and the Go server
will disagree about the same file. Both carry a note saying so.

---

## About that test

One existing case asserted `mistral-v7-tekken` must **never** survive
classification — encoding the premise above as a rule. It could not simply be
deleted: it was reaching for something real, namely *never hand llama.cpp a
name it does not know*, because that failure is silent and looks like the model
has lost its mind.

So it is replaced by a test of the real invariant.
`TestBuiltinTemplateNamesAreRecognised` checks every built-in name the
classifier can emit against llama.cpp's actual registered table, taken from
**b9294** — the older of the two pinned engines, deliberately, since a name
valid only on the newer one would still be a bug on Windows. Confirmed to fail
when a bogus name is injected.

---

## Not changed

**The Nemo safety net in `fileserver.ps1`** has the same shape as the Cydonia
one did — it fires on `$useJinja -or -not $chatTemplate` and forces
`$useJinja = $false`, so it would clobber a deliberate `jinja=1` from a hash
derivation or sidecar. Nobody has reported it, no Nemo model is known to hit
it, and changing template selection for a family on suspicion is how #20
happened. Recorded, not touched.

---

## Verification

- Classifier tests cover the four cases that matter: no embedded template
  (mergekit → tekken builtin), a real Mistral template (→ jinja), a stub that
  is a bare name (→ builtin), and a valid Jinja template from another family
  (→ builtin).
- `usableEmbeddedTemplate` unit-tested over six inputs including each check
  failing alone.
- The built-in-name invariant confirmed to catch an injected bad name.
- `gofmt` clean, `go build`, `go vet`, all 11 Go packages pass.
- PowerShell brace/paren balance unchanged in both edited files, helper defined
  before use, line endings still LF exactly as they were.
- Batch linter clean, `models.ini` unchanged, all 9 `.mjs` suites pass.

What still needs real hardware: loading Cydonia 24B and seeing the character
hold. No 24B model ran here. The mechanism was read from llama.cpp's source at
both pinned tags and the reporter confirmed the workaround on their own
machine, but the token-boundary explanation is inference from code, not
something measured.
