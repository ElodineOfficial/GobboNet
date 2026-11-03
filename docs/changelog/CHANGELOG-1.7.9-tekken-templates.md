# 1.7.9 — Tekken models talk about Tekken

*Patch step 2 of 1.7.9. Fixes every Mistral Tekken model (Cydonia, Mistral
Small, Nemo, Rocinante, Magnum, and any renamed merge), and GLM-4-9B, which
hit the same bug through the `chatglm4` name.*

---

## What was happening

Load any Tekken model and send it a message. It ignores the message and talks
about the video game Tekken.

The model never saw the conversation. Everything it was fed, every turn, was
the literal text:

```
mistral-v7-tekken
```

So it answered the only thing it was given, and the strongest association for
"tekken" is the fighting game.

## Cause

The pinned engine, llama.cpp b10456, runs `llama-server` with **Jinja on by
default** (`use_jinja = true` in `common/common.h`; `--help` says
"default: enabled"). GobboNet assumed the opposite: that leaving out `--jinja`
turned it off.

With Jinja on, `llama-server` reads `--chat-template` as Jinja **source**, not
as the name of a built-in (`common_chat_templates_init` in `common/chat.cpp`).
The source `mistral-v7-tekken` contains no Jinja tags, so it renders as itself
for every request.

Every path that used a built-in template name was affected:

| Path | Name it sent |
| --- | --- |
| Go classifier, Mistral Small / Cydonia with no usable embedded template | `mistral-v7-tekken` |
| Go classifier, Nemo / Rocinante / Magnum / Violet Lotus | `mistral-v3-tekken` |
| Go classifier, GLM-4-9B variants whose template hash drifted | `chatglm4` |
| `chat_template_name` in `config.toml` | whatever was set |
| `launch.bat` and the legacy `fileserver.ps1` | the same names |

The old guard in `launch.bat` had seen this exact symptom ("the model ... rambles
about tekken") and blamed an unregistered name, so it rewrote the name to
`mistral-v7`. That hid nothing: `mistral-v7` is a name too and rendered the same
way, and it brought back issue #20's `[INST] ` spacing.

### Reproduced

On the pinned b10456 engine, with a tiny test model and GobboNet's own launch
path, `/apply-template` for one system message and one user message:

```
1.7.8 flags (no --jinja, --chat-template mistral-v7-tekken):
  {"prompt":"mistral-v7-tekken"}

1.7.9 flags (--no-jinja --chat-template mistral-v7-tekken):
  {"prompt":"[SYSTEM_PROMPT]You are Tifa.[/SYSTEM_PROMPT][INST]Hello there[/INST]"}
```

## The change

**A built-in template name always travels with `--no-jinja`, and Jinja's state
is always stated.** Nothing is left to the engine's default.

- `internal/supervisor/supervisor.go` (`BuildArgs`): a name with no template file
  forces Jinja off and sends `--no-jinja`. Otherwise `--jinja` or `--no-jinja` is
  sent explicitly. Sidecar `.jinja` files and embedded templates keep `--jinja`.
- `launch.bat`: the same rule in the `JINJA_FLAG` block. The `mistral-v7` rewrite
  is removed. Still CRLF.
- `fileserver.ps1` (legacy, deprecated in this release): the same rule.

**Tekken models are also recognised by their tokenizer**, not only by filename.
`internal/models/gguf.go` now reads `tokenizer.ggml.pre`. When it is `tekken`
and no filename rule matched (Magistral, Ministral, Devstral, a renamed merge):

- a usable embedded template is used with `--jinja`;
- otherwise `mistral-v7-tekken` if the template mentions `[SYSTEM_PROMPT]`;
- otherwise `mistral-v3-tekken`, which both Tekken eras tokenize correctly.

The new record id is `mistral-tekken`.

## Tests

- `internal/supervisor/template_args_test.go`, new:
  - every built-in name (classifier, contradictory record, config override) is
    sent with `--no-jinja` and never with `--jinja`;
  - embedded templates and sidecar files keep `--jinja`;
  - Jinja's state is always explicit.
- `internal/models/classify_test.go`: `TestTekkenByTokenizerWhateverTheName`
  covers the three routes above, and checks that a `llama-bpe` model with the
  same anonymous name is not called Mistral.
- `tests/test-tekken-template.py`, new: pins `launch.bat`'s side statically
  (the rewrite is gone, a name forces `--no-jinja`, CRLF intact).
- `tests/test-engine-args.py`: `--no-jinja` is a known, reasoned difference.
- End to end on b10456 with two tiny test models (`Cydonia-24B-tiny-test` and an
  anonymous `tekken`-tokenizer model): correct Tekken prompts, no `[INST] `
  space.
- `tests/console/1.7.9-steps-1-3.js` checks it in the browser through
  `/llm/apply-template`. On an unpatched 1.7.8 build it fails with
  `it is fed "mistral-v7-tekken"`.

**Not run:** a real Tekken model generating text, and `launch.bat` in a Windows
console.
