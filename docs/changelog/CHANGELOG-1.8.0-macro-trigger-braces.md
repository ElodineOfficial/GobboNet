# 1.8.0 — Macro names typed with braces are accepted

Issue #69 (5Kwords), PR #73 (Aaron K. Clark / CryptoJones). Roadmap item #3.

## What was happening

A user who typed `{{skip}}` into the macro editor's **Trigger name** meant
`skip`. `saveMacroEdit()` (`js/20-macros.js`) checked the raw text against
`/^[a-zA-Z0-9_]+$/` and refused it with "letters, numbers, and underscores",
which says nothing about braces. The same happened to `{{SYSTEM:}}`, copied
from the 1.7.9 notes, and to `skip:`. The preview also put the braces in
twice: `{{{{skip}}: your text here}}`.

PR #73 reworded the hint and the alert. It was built on 1.7.8; its three lines
are kept here, by hand, and the editor now also does what the user meant.

## The change

- **`normaliseTrigger(raw)`** (`js/20-macros.js`) trims, takes off one leading
  `{{` and one trailing `}}`, then a trailing `:`, then trims again. Only one
  pair: `{{{{skip}}}}` is still a mistake.
- **`saveMacroEdit()`** checks and saves the normalised name. When it differs
  from what was typed, the box is rewritten to show it, so any refusal that
  follows talks about what is in the box. A macro being edited (name read-only)
  is untouched.
- **A note under the field** (`#macro-trigger-note`, `aria-live="polite"`,
  hidden until needed): "Saves as {{skip}}. Type the word only; the braces are
  added for you." It appears while typing, only when the name will be saved
  differently and would actually be accepted. CANCEL clears it.
- **The preview** uses the normalised name.
- **PR #73's wording:** the hint "Enter the name without braces; for example,
  `rosebud` becomes `{{rosebud}}` when saved." under the label, and the alert
  "Trigger may only contain letters, numbers, and underscores. Enter the name
  without braces. Example: rosebud becomes {{rosebud}}".

Nothing else changes: a name with a space or a symbol is still refused, built-in
and placeholder names (`char`, `user`, `input1`...) are still refused in braces
or not, and a braced name matching an existing macro is refused as a duplicate.

No setting: there is nothing to configure, and nothing that can run code.

## Tests

`tests/test-macro-input.mjs`, new section F (23 checks; 55 in the file), against the real
`saveMacroEdit()`, `updateMacroPreview()` and `cancelMacroEdit()`:

- `{{skip}}`, `{{ skip }}`, `skip:`, `{{skip:}}` save as `skip` with no alert;
  `{{SYSTEM:}}` saves as `SYSTEM`. On 1.7.9 all of these are refused.
- `{{a b}}`, `{{{{skip}}}}`, `{{char}}`, `{{ USER }}` and `{{input1}}` are still
  refused, with PR #73's wording where it applies; `{{system:}}` next to the
  default SYSTEM macro is a duplicate.
- The note's text, when it shows and when it does not; the preview never doubles
  the braces; the hint and the note are in `chat.html`.

Run against 1.7.9's `js/20-macros.js`, the suite stops: `normaliseTrigger` does
not exist there, and 1.7.9's `saveMacroEdit()` refuses `{{skip}}`,
`{{SYSTEM:}}` and `skip:`.

Live check: `tests/console/1.8.0-round-1.js` drives the editor on a running
page, saving nothing.

Not run here: a real browser against a running server (the console check is
for that).
