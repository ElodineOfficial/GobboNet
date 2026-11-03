# 1.7.9 — Macros that take text

*A user request after step 16:*

> I'd like to define macros like `{{SYSTEM:}}  Foo bar baz quux` and have that
> get expanded into something like: "The following is an out of character
> directive. Do not acknowledge or respond to this in the scene: Foo bar baz
> quux"

## What was there

A custom macro was a fixed-text shortcut. `{{name}}` was swapped for its saved
text before the message reached the model, and that was all. It took no
input. `{{SYSTEM:}}` did not even match: a name is letters, digits and
underscores, so the colon left it to reach the model as typed.

## The change

**Passing text to a macro, two ways:**

| Typed | Passed text |
|---|---|
| `{{SYSTEM: Foo bar baz quux}}` | what is inside the braces; anywhere in a message, over several lines if need be |
| `{{SYSTEM:}} Foo bar baz quux` | the rest of that line |

**Where the passed text goes:**
- **The simple case.** With no placeholder in the macro's text, the passed text
  goes on a new line after it. That is the request exactly, with nothing to
  learn.
- **Power users:**
  - `{{input}}` in a macro's text puts the passed text exactly there, as many
    times as it appears;
  - `{{input1}}`, `{{input2}}`… are its pieces split at `|`, so
    `{{scene: the tavern | night}}` with `Setting: {{input1}}. Time:
    {{input2}}.` gives `Setting: the tavern. Time: night.`;
  - a missing piece is left empty.

**Ready-made: `{{SYSTEM}}`.**
- It ships as a default macro whose text is the out-of-character directive.
  `{{SYSTEM:}} Foo bar baz quux` works out of the box.
- On an existing install it is added once on load, the way `{{continue}}` was
  added before it.
- It is never added as a twin of a user's own "system" macro (the check now
  ignores case, as expansion always has).
- It is not added again if the user deletes it.
- It can be edited like any other.

**Unchanged:**
- A plain `{{name}}` works as before. For a macro with placeholders, they come
  out empty.
- Names match without regard to case.
- An unknown name, with or without a colon, is left as typed.
- The chat bubble and the saved message keep what was typed. Only the model
  gets the expansion.

**Also fixed in passing:**
- `$&`, `$1` and the like in a macro's text were read as replacement patterns,
  so `It costs $5` could come out mangled. They are now taken literally.
- `{{char}}`, `{{user}}` and `{{current_DAT}}` inside a macro's own text
  reached the model as typed, because they were filled in before macros
  expanded. They are filled in afterwards too now.

**In the editor:**
- `input` and `input1`–`input9` are reserved names.
- The MODS → CUSTOM MACROS "?" note explains both forms and the placeholders.
- Under the expansion text, a live preview shows what `{{name: your text
  here}}` becomes, or what `first | second` becomes for a macro with numbered
  placeholders.

## Code

`js/17-personas.js`:
- `resolveMacros` expands plain macros first, so a plain macro can sit inside
  passed text: `{{SYSTEM: {{continue}}}}`. It then handles the rest-of-line
  form, then the braces form.
- new `macroFind` and `macroExpand`;
- `translateTemplates` fills in the names after macros expand.

`js/04-state.js` adds the `SYSTEM` default and the reserved names.
`js/05-persistence.js` makes the seeding check ignore case. `js/20-macros.js`
adds `updateMacroPreview`. `chat.html` holds the note and the preview.

## Tests

- `tests/test-macro-input.mjs`, 32 checks:
  - the request, word for word, in both forms;
  - rest-of-line only; mid-message; case; names and other macros inside the
    passed text; several lines;
  - every placeholder, missing pieces, the plain form;
  - old macros unchanged; `$` literal; unknown names left alone; the bubble's
    short form; the saved message;
  - the default, the reserved names, seeding;
  - the preview.
- **In Chromium, against the real server and engine:**
  - a fresh profile had `SYSTEM`, and an install from before got it once;
  - typing `{{SYSTEM:}}  Foo bar baz quux` sent the model the directive and
    then "Foo bar baz quux" on its own line;
  - the bubble and the saved message showed what was typed;
  - the braces form worked mid-message;
  - a macro made in the editor previewed and filled `{{input1}}` and
    `{{input2}}`;
  - a macro named `input` was refused.
- `tests/console/1.7.9-macro-input.js`, 10 checks. It changes nothing: its
  macros exist in memory only.
