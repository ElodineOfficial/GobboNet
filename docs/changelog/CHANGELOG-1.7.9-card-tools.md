# 1.7.9 — Tool calling for card-code tools

A card's custom code can now offer the model functions, and the model can call
them. Nothing is built in: every tool is written by the card's author, in the
same `customCode` box as the hooks, and offered only when the card's owner
ticks a box.

## What was there

GobboNet never sent a `tools` array, so no model could call anything. The
engine already supported it: llama-server runs with `--jinja` for most
families, parses a model's calls into `tool_calls`, and `/llm/jobs` forwards
the request body byte for byte. This is a frontend-only change; no Go code
moved.

## The change

**A new card-code call**, next to `gobbo.on`, `gobbo.ask` and `gobbo.note`:

```js
gobbo.tool('roll_dice', {
  description: 'Roll dice and return each die and the total',
  parameters: { type: 'object', properties: {
    count: { type: 'integer' }, sides: { type: 'integer' } }, required: ['sides'] }
}, (args, ctx) => { /* ... */ return { rolls, total }; });
```

- The name must match `[A-Za-z0-9_-]{1,64}` and be unique; `parameters` is a
  JSON Schema object. Bad input is warned about and skipped, the same way
  `on()` treats an unknown hook. `ctx` carries `card`, `thread` and `signal`.
- The return value goes back to the model as a string: a string as is, anything
  else JSON-stringified, cut at 8,000 characters. A tool that throws, hangs past
  30 s, gets bad JSON or does not exist answers the model with `error: ...` and
  stays registered, so the model can recover. Every call is logged as
  `[card-tool]`.

**A per-character switch**, under the custom code box: *Let the model call this
card's tools*, off by default. Its field is `toolsEnabled`, read as `=== true`,
so a card from an older install, another app or an import offers nothing.
Imports and restored state blobs clear it, as they already clear
`customCodeEnabled`. The status line under the code box lists the registered
tools next to the hooks.

**The loop**, `runGenerationWithTools` in `js/03-generation.js`, now wraps the
transport for both chat requests (send and regenerate):

1. With no tool definitions it is exactly one `runGenerationStream` call with
   the request body unchanged.
2. Otherwise the body carries `tools`. The stream feeder collects `tool_calls`
   deltas on the message, joined per call index (`extractToolCallDeltas` in
   `js/02-model.js`, `mergeToolCallDeltas`).
3. When a round ends in calls, the parser state for that round is settled, each
   call runs in the page, and `{ role: 'assistant', content, tool_calls }` plus
   one `{ role: 'tool', tool_call_id, content }` per call are appended **after**
   the built context. `buildContextMessages` runs
   `normalizeMessagesForStrictTemplates`, which would drop them, and putting
   them at the end keeps llama-server's cached prompt prefix intact.
4. At most five requests per reply; the fifth goes without `tools`, so the model
   has to answer in text.
5. Stop works between rounds: the abort signal is handed to the tool and
   checked after it, and a cancelled job counts the same.
6. **No `--jinja`:** the page cannot tell how the engine was started. If the
   first request fails with llama-server's refusal (`tools param requires
   --jinja flag`), it is retried once without tools and the reply gets the note
   *this model can't use tools*. The legacy direct stream now includes the
   engine's error body in its message so the same check works there.

**Showing and storing calls.** `assistantMsg.toolCalls` holds
`{ name, args, result, error, ms }` per call. It is synced and backed up with
the message, saved and restored per variant next to `searchData`, and cleared
on reroll. The reply renders a collapsed block, *🔧 used roll_dice* or *used N
tools*, between the reasoning block and the text, with arguments and results in
`<pre>` through `escapeHtml()`. It has its own classes (`.tool-block`), not
`.cot-block`, because the streaming painter in `js/14-scroll.js` finds a reply's
reasoning block by that class.

**Later turns** send only the final text of earlier replies, as reasoning is
handled today; earlier tool calls are not sent again.

**Resume after navigation.** A detached job that ends in tool calls while the
page is away is not continued: the tools live in this page's card code. The
calls are recorded as not run and the reply gets *tool call interrupted by
leaving the page — reroll to retry*. Continuing after a resume is a possible
follow-up.

One small parser change: the implicit-think give-up in `finalizeStreamMessage`
now judges only the text the current parse added (`contentAtStart`,
`reasoningAtStart` on the parse state), so a later round parsing onto a message
that already holds text behaves like a fresh reply. For a fresh reply both are
0 and nothing changes.

## Hardened after independent review

Before the PR, the committed branch went to a panel of nine models from
different vendors, one at a time, each with read-only tools on the checkout
(two more lanes failed to answer and are reported as such). What they found
and what changed:

- **Consent is re-checked mid-reply** (three lanes). `activateCard` has no
  generation guard, so switching characters while a reply ran swapped the
  registry and the loop would have run the new card's same-named tool without
  its consent; unticking the box and saving mid-turn kept offering tools.
  Now `cardToolDefs(card)` is read before every request and before any call
  runs, and `runCardTool` refuses a call whose card no longer owns the
  registry. The loop also passes its own thread to the tool, since the chat
  on screen may be another one.
- **A `/state` blob with only `toolsEnabled` set survived restore**: the
  neutraliser counted only `customCodeEnabled`, and the restore re-serialises
  the blob only when something was counted. Either flag counts now.
- **A reload between rounds replays onto the finished rounds' text.** The
  loop keeps it on the message as `toolPrefix` while a later round runs;
  `finalizeJobIntoThread` starts from it instead of a blank, and the boot
  sweep notes a loop that died with the page (there is no job between rounds).
- **A round cut by the token limit runs nothing**: `finish_reason: length`
  means the arguments may be cut too. (Three lanes had asked for the field to
  be used or removed.)
- **Tool results have a per-reply budget** (`TOOL_RESULT_BUDGET`, 24,000
  characters); past it, the next request goes without `tools`. Three lanes
  pointed out that appended rounds bypass the context budget. The exact
  accounting is still a follow-up.
- **Arguments:** refused over 64 KB, the stored copy cut at 8,000 characters
  like results, and the help comment, tooltip and shipped example now say the
  arguments are the model's and must be checked before acting on them. The
  tooltip also says custom code must be on and that text the model reads can
  steer when a tool runs.
- **Timeouts abort the tool's own signal.** Each call gets an
  `AbortController` that follows Stop and fires on timeout, so a tool that
  watches `ctx.signal` can stop; one that does not keeps running, and the
  model is told it timed out.
- **Smaller:** fragments without an `index` join by id or by "a named
  fragment starts a call" (llama-server always sends the index, per
  `tools/server/server-chat.cpp`); the no-jinja match is the engine's own
  phrase, `requires --jinja` (`tools/server/server-common.cpp`); the test-only
  `opts.tools` parameter is gone; `_pendingToolCalls` and `_finishReason`
  joined `RUNTIME_MESSAGE_FIELDS` so they never reach storage; the chunk
  prefilter no longer parses every text line twice; a synthesised call id is
  nine alphanumerics, the shape strict Mistral templates accept; the round's
  reasoning goes back as `reasoning_content` on the appended assistant turn
  (Harmony and Qwen3 templates read it); the mid-round repaint keeps the
  reader's scroll position; the resume note says "start the reply again".
- **Declined, with reasons:** a `docs/TOOLS.md` (card code has no docs page
  either; the help comment is the API by design); schema validation of
  arguments (card authors validate; a follow-up); continuing a tool loop after
  a resume (the tools live in the page); re-sending earlier turns' tool calls.
- **For the maintainer, out of scope:** llama.cpp's server now defaults
  `use_jinja` to true (`common/common.h`), and the Go supervisor only ever
  adds `--jinja`, never `--no-jinja`, so the families the launcher means to
  run without it may already be running with it on the pinned engine.

## Honest limits

- **Only works with `--jinja`.** Families the launcher runs without it (Mistral
  Nemo merges, the 2024 GLM-4-9B) get one plain reply and the note.
- **One model tried.** The live run below used one Qwen3.8 model behind a
  non-llama.cpp OpenAI-compatible server. Which other families call tools
  well, and how llama-server itself streams the deltas, was not tried; the
  delta shape and the refusal wording were read in llama.cpp's source.
- **Context.** Appended rounds sit outside the context budget; the per-reply
  result budget bounds them but does not measure tokens. The legacy
  `fileserver.ps1` path forwards the body unchanged and was not run.
- **The fifth request** goes without tools, so the model answers in text as
  it would in any tool-less request; a model that tries to call anyway gets
  no parsed call and no note.
- **The tool block** is painted between rounds and stays through the next
  round's streaming; it is not updated token by token.
- **Round text.** The text a model emits alongside its calls stays in the reply
  ahead of the next round's text, separated by a blank line.
- **No resume continuation**, as above.

## Pinned by

**`tests/test-card-tools.mjs`** (new, 93 assertions), loading the real files in
`vm`:

- registration checks (bad name, duplicate, missing schema, missing function);
- no `tools` unless the switch is exactly true and the code is on; imports and
  restored blobs clear the switch; teardown empties the registry;
- joining `tool_calls` deltas split across chunks, two calls in parallel,
  non-streamed replies, calls without an id or name;
- a faked transport running two rounds of calls then text, with the exact
  message shape sent each round and the caller's body left untouched;
- the five-request limit dropping `tools`; the no-jinja retry and its note,
  and that other errors are not retried; Stop between rounds on both
  transports; no tools meaning one byte-identical request;
- `runCardTool`: throw, timeout, bad JSON, unknown tool, object results, the
  8,000-character cap, an aborted signal;
- wiring: both call sites, the editor row and tooltip, new and default cards,
  variants, the reroll clears, the rendered block and its escaping.

The full suites were run: every `tests/*.mjs` and `tests/*.py`, then
`stage-web.sh` and `go test ./...`.

## Verified live, Linux

`gobbonet serve` in remote mode (`server_exe = ""`, `llm_url` pointing at a
LAN inference box serving Qwen3.8-Flash-Next through an OpenAI-compatible
API with streamed `tool_calls`), the page driven headless in Chrome with the
`roll_dice` example from the code box's help comment on the active card and
both boxes ticked:

- "Roll 2d6 for me with your dice tool": the model called `roll_dice` with
  `{"count":2,"sides":6}`, the page ran it, the second request carried the
  assistant turn and the tool message, and the reply used the result
  ("Rolled 2d6: 4 + 4 = 8"). The reply shows *🔧 used roll_dice* between the
  chain-of-thought block and the text; the transport was the detached job.
- Reroll made a new variant with its own call and result; flipping back
  restored the first variant's call and block.
- Stop pressed while a deliberately slow tool ran: the tool got the abort
  signal, no further request was sent, and the reply reads *(generation
  stopped)*.
- No page errors.
- The same run was repeated after the review hardening with the same
  results: a call, a reply built on it, the block, per-variant calls on
  reroll, and Stop mid-tool ending the loop with no further request.

Not tried: a model run without `--jinja` (the fallback note is pinned by the
test only), llama-server's own streamed deltas, and a Windows console.
