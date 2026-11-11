# 1.8.0 — Classifier-free guidance: checked against the pinned engine

Issue #51 (EternalBlueFlame). Roadmap item #1. No code change.

## What was asked

#51 asked for classifier-free guidance (CFG): score each token with the real
prompt and with a negative one, and steer away from the second. 1.7.8 answered
the common case, "stop writing X", with Banned Phrases (`logit_bias`, see
`CHANGELOG-1.7.8-banned-phrases.md`), and recorded that llama-server could not
do real CFG. That note was written against the 1.7.8 engine. The 1.8.0 plan
asked for it to be confirmed against the engine 1.8.0 actually pins.

## What b10456 offers

Read from llama.cpp's source at tag `b10456`, the build `engine.sha256` pins:

- **No guidance for chat models.** The only `cfg_scale` in the tree is
  `--diffusion-cfg-scale` (`common/arg.cpp`, `common/common.h`), for diffusion
  language models. Nothing in the server's completion or chat path takes a
  negative prompt or a guidance scale. llama.cpp's old CLI flags of that shape
  (`--cfg-negative-prompt`, `--cfg-scale`) are not in this build.
- **No full logits over HTTP.** `n_probs` and `post_sampling_probs`
  (`tools/server/README.md`) return at most the top N tokens per position. CFG
  mixes the whole distribution twice per token.
- Faking it from the page would mean two full requests per token, and patching
  the engine would break its SHA-256 pin, which every download relies on.

So real CFG cannot ship in 1.8.0. Banned Phrases stays the tool for it.

## The change

- `AGENTS.md`, Banned phrases: the note now names the engine build it was
  checked against and says to look again when `engine.sha256` moves.
- #51 is answered on the issue with the above.
- If llama-server gains a guidance field upstream, GobboNet would pick it up
  with a normal engine-pin bump and a capability check, as it already does for
  `--fit`, and show the setting only when the engine supports it.

## Tests

None: nothing in the shipped code changed.
