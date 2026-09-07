# v1.7.3 — asking the upstream what it is serving

*Closes #47, #48 and #27.*

---

## Three reports, one bug

- **#48** (KMaheshBhat) asked whether GobboNet can point at a llama.cpp server
  it does not manage.
- **#47** (nephitejnf) did exactly that on Artix, and the model dropdown said
  **None**.
- **#27** (joeypent69) did it against Ollama and could not select between models
  he already had installed.

The answer to #48 was always **yes** — `server_exe = ""` plus `llm_url` is remote
mode, and it has worked for several releases. Nothing in the README said so, and
the two people who found it anyway hit #47 and #27 immediately.

## What was actually wrong

The header dropdown is built from `ModelsListPayload`, which scans `model_dir`
for `.gguf` files. In remote mode there are no local files — the models live on
the other machine, or inside Ollama's blob store — so the scan correctly
returned nothing and the UI correctly rendered nothing.

Every layer behaved. The user got an empty dropdown pointed at a server with
eight models loaded.

```
grep -rn "v1/models" --include=*.go .   →   no matches
```

**Nothing anywhere in the Go server ever asked the upstream what it was
serving.** That is the whole defect, and it produced three differently-worded
reports because the symptom looks different depending on what you plugged in.

Compounding it, the model name went out hardcoded from five places:

```
js/03-generation.js  js/07-prompt.js  js/10-chat.js ×2  js/23-card-code.js
    model: 'local',
```

which is why the workaround #27 had been living with was `ollama cp <model> local`
— aliasing a real model to the one literal name GobboNet would ever ask for.

## What changed

**`internal/server/upstream_models.go`** asks `{llm_url}/v1/models` in remote
mode. Both engines answer the same OpenAI-shaped endpoint — llama.cpp reports
the model it has loaded, Ollama reports everything installed and loads on demand
— so one request covers both.

**The dropdown** now lists what the upstream reports, alongside any local GGUFs.
The local scan still runs and still wins on a name collision: a remote install
can legitimately have files in `model_dir`, and `ModelDirUsable` is already
documented as independent of `Mode` for that reason.

**Selecting a remote model does not restart anything.** There is no
llama-server of ours to swap, so the selection only changes which name the next
request carries. Ollama loads on demand, so the switch takes effect on the next
message with no wait. Posting `/swap-model` for a server we do not manage would
have asked it to kill a process that isn't ours.

**`getRequestModelName()`** replaces the five hardcoded sites. Local mode returns
`'local'` verbatim, so nothing changes for installs that already worked —
llama-server serves one model and ignores the field. Remote mode returns the
selected id, and the `ollama cp` workaround is no longer needed.

## Two things fixed on the way past

**The status badge.** `/health` is llama.cpp's endpoint, not OpenAI's. Ollama
does not implement it, so `upstreamOK()` answered 404 forever and the badge sat
red while chat streamed perfectly (noted in #27's thread). It now falls back to
a successful `/v1/models` — consulted only when `/health` did not already say
yes, so a llama.cpp upstream still costs exactly one request.

**"No models" now says which kind.** An empty dropdown had two very different
causes and the user could not tell them apart, which is most of why #47 was hard
to act on:

- `Upstream unreachable` — we could not ask (`upstream_error` in the payload).
- `Upstream reports no models` — we asked, and it genuinely has nothing loaded.

**`llm_url` is normalised.** It is documented as the server root, but both
engines *print* URLs carrying `/v1`, and people paste what they were shown.
Appending blindly gave `/v1/v1/models` → 404 → "the upstream has no models",
which is the exact failure this change exists to remove.

## Not changed

- Local mode. Same scan, same hot-swap, same `'local'` on the wire.
- `/swap-model`. Untouched, and still the only path that restarts an engine.
- The API key stays config-side and never reaches the browser. It **is** sent to
  `/v1/models`, because a remote llama.cpp behind `--api-key` answers 401, and
  an unauthenticated request would present as "the server has no models" —
  landing the user back on the original bug by a different route.

## Tests

`internal/server/upstream_models_test.go` — 9 cases, pinned against **real**
llama.cpp and Ollama response bodies rather than one invented shape, plus base
URL normalisation, the auth header, garbage responses, and the
error-vs-empty distinction.

`tests/test-remote-models.mjs` — 18 assertions driving the real
`loadModelsList` / `onHeaderModelChange` / `getRequestModelName` in a fake DOM:
remote lists populate, remote selection sends no swap, **local mode is
byte-for-byte unchanged**, local swap still fires, and both empty-state
wordings. It ends with source guards that no request path has drifted back to a
hardcoded name.

`tests/test-lore-compression.mjs` and `tests/test-lore-model.mjs` gained a
`getRequestModelName` stub. They evaluate `07-prompt.js` on its own, so they
need the globals it expects from earlier files — the same reason they already
stub `activeModel` and `escapeHtml`. Both caught the new dependency immediately,
which is what they are for.
