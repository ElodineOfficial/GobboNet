/**
 * Tool calling for card-code tools.
 *
 * A card's custom code can offer the model functions with
 *     gobbo.tool(name, { description, parameters }, fn)
 * and, when the card's "Let the model call this card's tools" box is ticked,
 * each request carries them as the OpenAI `tools` array. llama-server (run
 * with --jinja) parses the model's calls into `tool_calls` deltas; the page
 * runs them and asks again, up to five requests per reply.
 *
 * What this holds:
 *   A. Registration: bad names, duplicates and a missing schema are warned
 *      about and skipped, like on(); good tools become OpenAI definitions.
 *   B. Nothing is offered unless the switch is exactly true AND the code is
 *      on; imported cards and restored state arrive with the switch off.
 *   C. Streamed tool_calls deltas split across chunks are joined per call
 *      index, two calls in parallel; a non-streamed reply works too.
 *   D. The loop: the exact message shape sent per round, the five-request
 *      limit dropping `tools`, the retry when the engine has no --jinja,
 *      Stop between rounds, and no tools meaning one unchanged request.
 *   E. runCardTool: a tool that throws or times out answers with an error
 *      string, bad JSON and unknown tools too; objects are stringified and
 *      capped.
 *   F. Wiring: both chat requests go through the loop, the editor and the
 *      defaults carry the switch, variants keep their own calls, the reply
 *      shows a collapsed block.
 *   G. After independent review: consent is re-checked mid-reply and a call
 *      is refused once another card owns the registry; a /state blob with
 *      only toolsEnabled set is still neutralised; a round cut by the token
 *      limit runs nothing; tool results have a per-reply budget; the text of
 *      finished rounds survives a reload (toolPrefix); fragments without an
 *      index still join per call; scratch fields never persist.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8');
const CARDCODE = read('js/23-card-code.js');
const MODEL = read('js/02-model.js');
const GEN = read('js/03-generation.js');
const CHAT = read('js/10-chat.js');
const CARDS = read('js/15-cards.js');
const STATE = read('js/04-state.js');
const DASH = read('js/13-dashboard.js');
const HTML = read('chat.html');
const CSS = read('css/13-components.css');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

const fnBody = (src, sig, file) => {
  const a = src.indexOf(sig);
  if (a < 0) { console.error(`could not locate ${sig} in ${file}`); process.exit(1); }
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
};
const constLine = (src, name, file) => {
  const m = src.match(new RegExp('^const ' + name + ' = [^\\n]*;', 'm'));
  if (!m) { console.error(`could not locate const ${name} in ${file}`); process.exit(1); }
  return m[0];
};

/* ================================================================
   A. REGISTRATION
================================================================ */
console.log('\n=== A. gobbo.tool registers, validates and skips ===');

function cardCodeContext(card) {
  const warnings = [];
  const ctx = {
    console: { log() {}, warn(...a) { warnings.push(a.join(' ')); }, error(...a) { warnings.push(a.join(' ')); } },
    state: { _cardCodeStore: {} },
    getActiveCard: () => card,
    getActiveThread: () => ({ id: 't', messages: [] }),
    saveState() {}, render() {},
    document: { getElementById: () => ({ textContent: '', style: {} }) },
    setTimeout, clearTimeout, AbortController,
  };
  vm.createContext(ctx);
  vm.runInContext(CARDCODE, ctx);
  ctx.__warnings = warnings;
  return ctx;
}

const GOOD_CODE = `
gobbo.tool('roll_dice', { description: 'Roll dice',
  parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] } },
  (args) => ({ rolls: [4, 3], total: 7, sides: args.sides }));
gobbo.tool('get_time', { description: 'Clock', parameters: { type: 'object', properties: {} } },
  () => 'noon');
gobbo.tool('bad name!', { description: 'x', parameters: { type: 'object' } }, () => 1);
gobbo.tool('roll_dice', { description: 'dup', parameters: { type: 'object' } }, () => 2);
gobbo.tool('no_schema', { description: 'x' }, () => 3);
gobbo.tool('array_schema', { description: 'x', parameters: [] }, () => 3);
gobbo.tool('no_fn', { description: 'x', parameters: { type: 'object' } });
gobbo.tool('throws', { description: 'x', parameters: { type: 'object' } }, () => { throw new Error('boom'); });
gobbo.tool('hangs', { description: 'x', parameters: { type: 'object' } }, () => new Promise(() => {}));
gobbo.tool('big', { description: 'x', parameters: { type: 'object' } }, () => 'x'.repeat(9000));
gobbo.tool('nothing', { description: 'x', parameters: { type: 'object' } }, () => undefined);
gobbo.on('reply', ctx => ctx.text);
`;
const card = { id: 'c1', name: 'Tester', customCodeEnabled: true, toolsEnabled: true, customCode: GOOD_CODE };
const A = cardCodeContext(card);
A.applyCardCode();
{
  eq(A.liveCardTools().join(','), 'roll_dice,get_time,throws,hangs,big,nothing', 'good tools register, in order');
  ok(A.__warnings.some(w => /tool name must match/.test(w)), 'a bad name is warned about and skipped');
  ok(A.__warnings.some(w => /already registered/.test(w)), 'a duplicate name is warned about and skipped');
  ok(A.__warnings.some(w => /needs a JSON Schema object/.test(w)), 'a missing schema is warned about and skipped');
  ok(A.__warnings.some(w => /needs a function/.test(w)), 'a missing function is warned about and skipped');
  eq(vm.runInContext('_cardCodeError', A), null, 'none of that counts as the card failing to load');
  const defs = A.cardToolDefs(card);
  eq(defs.length, 6, 'cardToolDefs lists every registered tool');
  eq(JSON.stringify(defs[0]), JSON.stringify({ type: 'function', function: {
    name: 'roll_dice', description: 'Roll dice',
    parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] } } }),
    'each one is an OpenAI function definition with the schema as given');
  const status = { textContent: '', style: {} };
  A.document.getElementById = () => status;
  A.updateCardCodeStatus();
  ok(/hooks: reply/.test(status.textContent) && /tools: roll_dice, get_time/.test(status.textContent),
     'the status line names the tools next to the hooks', status.textContent);
}

/* ================================================================
   B. OFF MEANS NOTHING IS SENT
================================================================ */
console.log('\n=== B. no tools unless the switch is exactly true and the code is on ===');
{
  eq(A.cardToolDefs({ ...card, toolsEnabled: false }).length, 0, 'switch off → []');
  eq(A.cardToolDefs({ ...card, toolsEnabled: undefined }).length, 0, 'no field (older or imported card) → []');
  eq(A.cardToolDefs({ ...card, toolsEnabled: 1 }).length, 0, 'only an explicit true counts');
  eq(A.cardToolDefs({ ...card, customCodeEnabled: false }).length, 0, 'code off → []');
  eq(A.cardToolDefs({ ...card, id: 'other' }).length, 0, 'another card does not borrow the live registry');
  eq(A.cardToolDefs(null).length, 0, 'no card → []');

  const imported = A.applyImportedCardCode({ id: 'i', name: 'Imp', toolsEnabled: true }, GOOD_CODE);
  eq(imported.customCodeEnabled, false, 'an imported card arrives with its code off');
  eq(imported.toolsEnabled, false, 'and its tools switch off, however the file was saved');
  const blob = { characterCards: [{ id: 'x', customCodeEnabled: true, toolsEnabled: true }] };
  A.neutralizeUntrustedCode(blob);
  eq(blob.characterCards[0].toolsEnabled, false, 'a restored state blob has the tools switch cleared too');
  const only = { characterCards: [{ id: 'y', customCodeEnabled: false, toolsEnabled: true }] };
  const n = A.neutralizeUntrustedCode(only);
  eq(n.cards, 1, 'a card with only the tools switch set counts as changed, so the restore re-serialises it');
  eq(only.characterCards[0].toolsEnabled, false, 'and its switch is cleared');

  A.teardownCardCode();
  eq(A.liveCardTools().length, 0, 'teardown drops the registry');
  eq(A.cardToolDefs(card).length, 0, 'and nothing is offered after a card switch');
  A.applyCardCode();   // back on for section E
}

/* ================================================================
   C. JOINING STREAMED DELTAS
================================================================ */
console.log('\n=== C. tool_calls deltas split across chunks are joined per call ===');
{
  const ctx = { JSON, Date, Array, console };
  vm.createContext(ctx);
  vm.runInContext(fnBody(MODEL, 'function extractToolCallDeltas(rawLine)', 'js/02-model.js')
                + fnBody(GEN, 'function mergeToolCallDeltas(msg, delta)', 'js/03-generation.js')
                + fnBody(GEN, 'function takePendingToolCalls(msg)', 'js/03-generation.js'), ctx);
  const sse = (obj) => 'data: ' + JSON.stringify({ choices: [obj] });
  const msg = { content: '' };
  const lines = [
    sse({ delta: { role: 'assistant', content: 'Rolling.' } }),
    sse({ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'roll_dice', arguments: '' } }] } }),
    sse({ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{' } }] } }),
    sse({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sid' } }] } }),
    sse({ delta: { tool_calls: [{ index: 0, function: { arguments: 'es": 6}' } }, { index: 1, function: { arguments: '}' } }] } }),
    sse({ delta: {}, finish_reason: 'tool_calls' }),
    'data: [DONE]'
  ];
  eq(ctx.extractToolCallDeltas(lines[0]), null, 'a plain content line yields nothing');
  for (const l of lines) ctx.mergeToolCallDeltas(msg, ctx.extractToolCallDeltas(l));
  eq(msg._finishReason, 'tool_calls', 'finish_reason is kept');
  const calls = ctx.takePendingToolCalls(msg);
  eq(JSON.stringify(calls), JSON.stringify([
    { id: 'call_a', name: 'roll_dice', arguments: '{"sides": 6}' },
    { id: 'call_b', name: 'get_time', arguments: '{}' }
  ]), 'two parallel calls, each with its own id, name and joined arguments');
  eq(msg._pendingToolCalls, undefined, 'taking the calls clears the scratch field');

  const whole = { content: '' };
  ctx.mergeToolCallDeltas(whole, ctx.extractToolCallDeltas(sse({ message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'get_time', arguments: { tz: 'UTC' } } }] },
    finish_reason: 'tool_calls' })));
  const w = ctx.takePendingToolCalls(whole);
  eq(JSON.stringify(w), JSON.stringify([{ id: 'c9', name: 'get_time', arguments: '{"tz":"UTC"}' }]),
     'a non-streamed reply works, and object arguments are stringified');

  const noId = { content: '' };
  ctx.mergeToolCallDeltas(noId, ctx.extractToolCallDeltas(sse({ delta: { tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] } })));
  ok(/^[a-z0-9]{9}$/.test(ctx.takePendingToolCalls(noId)[0].id), 'a call without an id gets a nine-alphanumeric one (the shape strict templates accept)');

  const nameless = { content: '' };
  ctx.mergeToolCallDeltas(nameless, ctx.extractToolCallDeltas(sse({ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } })));
  eq(ctx.takePendingToolCalls(nameless).length, 0, 'a fragment that never got a name is dropped');

  // A server that omits `index` (llama-server never does: server-chat.cpp
  // tags every fragment). A named fragment starts a call, a bare one
  // continues the last, and an id still finds its call.
  const noIdx = { content: '' };
  for (const l of [
    sse({ delta: { tool_calls: [{ id: 'p', function: { name: 'roll_dice', arguments: '{"si' } }] } }),
    sse({ delta: { tool_calls: [{ function: { arguments: 'des":6}' } }] } }),
    sse({ delta: { tool_calls: [{ id: 'q', function: { name: 'get_time', arguments: '' } }] } }),
    sse({ delta: { tool_calls: [{ id: 'p', function: { arguments: '' } }] } }),
    sse({ delta: { tool_calls: [{ function: { arguments: '{}' } }] } }),
  ]) ctx.mergeToolCallDeltas(noIdx, ctx.extractToolCallDeltas(l));
  eq(JSON.stringify(ctx.takePendingToolCalls(noIdx)), JSON.stringify([
    { id: 'p', name: 'roll_dice', arguments: '{"sides":6}' },
    { id: 'q', name: 'get_time', arguments: '{}' }
  ]), 'without an index, call 2 does not swallow call 1: name starts a call, bare fragments continue the last');

  eq(ctx.extractToolCallDeltas(sse({ delta: { content: 'hi' }, finish_reason: null })), null,
     'a text chunk with "finish_reason":null is not parsed a second time');
  eq(JSON.stringify(ctx.extractToolCallDeltas(sse({ delta: {}, finish_reason: 'length' }))),
     '{"toolCalls":[],"finishReason":"length"}', 'a real finish_reason is reported');
}

/* ================================================================
   D. THE LOOP
================================================================ */
console.log('\n=== D. runGenerationWithTools: rounds, limit, no-jinja retry, Stop ===');

const TOOLS = [{ type: 'function', function: { name: 'roll_dice', description: 'd', parameters: { type: 'object' } } },
               { type: 'function', function: { name: 'get_time', description: 't', parameters: { type: 'object' } } }];

/* script: one entry per round -> { calls: [...], text, errorMessage } */
function loopContext(script, extra = {}) {
  const bodies = [];
  let round = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, JSON, Date, Array, Object, Promise, String,
    state: { activeThreadId: 't' },
    getActiveCard: () => card,
    cardToolDefs: () => TOOLS,
    abortController: { signal: { aborted: false } },
    currentJob: null,
    saveState() {}, renderMessages() {}, captureScrollAnchor() { return {}; }, settleScrollAfterGeneration() {},
    finalizeStreamMessage(m) { delete m._parseState; m.content = (m.content || '').trim(); },
    toolCardIds: [],
    async runCardTool(name, args, ex) {
      if (extra.onTool) extra.onTool(ctx, name, args, ex);
      ctx.toolCardIds.push(ex && ex.cardId);
      return { name, args, result: (extra.result || 'result-of-') + name, error: false, ms: 1 };
    },
    prefixes: [],
    async runGenerationStream(thread, msg, body) {
      bodies.push(JSON.parse(JSON.stringify(body)));
      ctx.prefixes.push(msg.toolPrefix ? JSON.parse(JSON.stringify(msg.toolPrefix)) : null);
      const step = script[Math.min(round, script.length - 1)]; round++;
      if (step.errorMessage) return { errored: true, aborted: false, errorMessage: step.errorMessage, jobMode: true };
      msg.content += step.text || '';
      if (step.reasoning) msg.reasoning = (msg.reasoning || '') + step.reasoning;
      if (step.calls && step.calls.length) {
        msg._pendingToolCalls = step.calls.map((c, i) => ({ index: i, id: c.id, name: c.name, arguments: c.arguments }));
      }
      if (step.finishReason) msg._finishReason = step.finishReason;
      return { errored: false, aborted: false, jobMode: true };
    },
    ...extra.ctx
  };
  vm.createContext(ctx);
  vm.runInContext(constLine(GEN, 'TOOL_MAX_ROUNDS', 'js/03-generation.js') + '\n'
    + constLine(GEN, 'TOOL_RESULT_BUDGET', 'js/03-generation.js') + '\n'
    + fnBody(GEN, 'async function _runToolRounds(thread, assistantMsg, requestBody, opts, card, tools)', 'js/03-generation.js')
    + fnBody(GEN, 'function takePendingToolCalls(msg)', 'js/03-generation.js')
    + fnBody(GEN, 'function isNoJinjaError(message)', 'js/03-generation.js')
    + fnBody(GEN, 'function toolLoopStopped()', 'js/03-generation.js')
    + fnBody(GEN, 'function recordToolCalls(msg, recs)', 'js/03-generation.js')
    + fnBody(GEN, 'async function runGenerationWithTools(thread, assistantMsg, requestBody, opts = {})', 'js/03-generation.js'), ctx);
  return { ctx, bodies };
}
const BASE = { model: 'm', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'roll 2d6' }],
               stream: true, max_tokens: -1, temperature: 0.7 };

// D1: two rounds of calls, then text
{
  const { ctx, bodies } = loopContext([
    { calls: [{ id: 'a', name: 'roll_dice', arguments: '{"sides":6}' }, { id: 'b', name: 'get_time', arguments: '{}' }], text: 'Rolling.' },
    { calls: [{ id: 'c', name: 'roll_dice', arguments: '{"sides":20}' }], text: 'Again.' },
    { text: 'You rolled 7 at noon.' }
  ]);
  const msg = { role: 'assistant', content: '', timestamp: 1 };
  const outcome = await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 3, 'three requests: calls, calls, text');
  eq(JSON.stringify(bodies[0].tools), JSON.stringify(TOOLS), 'the first request carries the tools array');
  eq(bodies[0].messages.length, 2, 'and the context messages as built');
  eq(JSON.stringify(bodies[1].messages.slice(2)), JSON.stringify([
    { role: 'assistant', content: 'Rolling.', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'roll_dice', arguments: '{"sides":6}' } },
      { id: 'b', type: 'function', function: { name: 'get_time', arguments: '{}' } } ] },
    { role: 'tool', tool_call_id: 'a', content: 'result-of-roll_dice' },
    { role: 'tool', tool_call_id: 'b', content: 'result-of-get_time' }
  ]), 'round 2 appends the assistant turn with its calls and one tool message per call');
  eq(bodies[1].messages.slice(0, 2).map(m => m.role + ':' + m.content).join('|'), 'system:S|user:roll 2d6',
     'the prefix is untouched, so llama-server can reuse its cached prompt');
  eq(JSON.stringify(bodies[2].messages.slice(5)), JSON.stringify([
    { role: 'assistant', content: 'Again.', tool_calls: [{ id: 'c', type: 'function', function: { name: 'roll_dice', arguments: '{"sides":20}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'result-of-roll_dice' }
  ]), 'round 3 appends only the second round, with only that round\'s text');
  ok(bodies.every(b => 'tools' in b), 'every request before the limit carries tools');
  ok(bodies.every(b => b.temperature === 0.7 && b.stream === true), 'sampler fields ride along unchanged');
  eq(msg.toolCalls.map(c => c.name).join(','), 'roll_dice,get_time,roll_dice', 'every call is recorded on the message');
  eq(msg.toolCalls[0].result, 'result-of-roll_dice', 'with its result');
  eq(msg.content, 'Rolling.\n\nAgain.\n\nYou rolled 7 at noon.', 'the round texts are kept, one after another');
  eq(outcome.errored, false, 'and the turn ends normally');
  eq(msg._pendingToolCalls, undefined, 'no scratch field is left on the message');
  ok(!('tools' in BASE), 'the caller\'s request body is not mutated');
  eq(JSON.stringify(ctx.prefixes), JSON.stringify([null,
    { content: 'Rolling.\n\n', reasoning: '' },
    { content: 'Rolling.\n\nAgain.\n\n', reasoning: '' }]),
     'the finished rounds\' text rides on the message as toolPrefix while a later round runs');
  eq(msg.toolPrefix, undefined, 'and toolPrefix is gone once the loop ends');
  ok(ctx.toolCardIds.every(id => id === 'c1'), 'every call is run on behalf of the card that offered the tools');
}

// D1b: the round's reasoning rides on the appended assistant turn
{
  const { ctx, bodies } = loopContext([
    { calls: [{ id: 'r', name: 'get_time', arguments: '{}' }], reasoning: 'Need the time.' },
    { text: 'Noon.' }
  ]);
  const msg = { role: 'assistant', content: '', reasoning: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies[1].messages[2].reasoning_content, 'Need the time.', 'the assistant turn carries the round\'s reasoning as reasoning_content');
  const plain = loopContext([{ calls: [{ id: 'r', name: 'get_time', arguments: '{}' }] }, { text: 'Noon.' }]);
  await plain.ctx.runGenerationWithTools({ id: 't' }, { role: 'assistant', content: '' }, BASE, { card });
  ok(!('reasoning_content' in plain.bodies[1].messages[2]), 'and no field at all when the round had none');
}

// D2: the limit
{
  const { ctx, bodies } = loopContext([{ calls: [{ id: 'z', name: 'get_time', arguments: '{}' }] }]);
  const msg = { role: 'assistant', content: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 5, 'a model that never stops calling gets five requests');
  ok(bodies.slice(0, 4).every(b => Array.isArray(b.tools)), 'the first four carry tools');
  ok(!('tools' in bodies[4]), 'the fifth has none, so the model has to answer in text');
  eq(bodies[4].messages.length, 2 + 4 * 2, 'and sees every earlier call and result');
  eq(msg.toolCalls.length, 4, 'four rounds of calls were run and recorded');
}

// D3: no --jinja
{
  const { ctx, bodies } = loopContext([
    { errorMessage: 'upstream HTTP 400: {"error":{"code":400,"message":"tools param requires --jinja flag","type":"invalid_request_error"}}' },
    { text: 'Plain reply.' }
  ]);
  const msg = { role: 'assistant', content: '' };
  const outcome = await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 2, 'the refused request is retried once');
  ok(Array.isArray(bodies[0].tools) && !('tools' in bodies[1]), 'without tools');
  eq(outcome.errored, false, 'the retry\'s outcome is the one returned');
  ok(/can't use tools/.test(outcome.note), 'with a note for the reply', outcome.note);
  eq(msg.content, 'Plain reply.', 'and the model\'s plain reply');

  const other = loopContext([{ errorMessage: 'upstream HTTP 500: out of memory' }]);
  const m2 = { role: 'assistant', content: '' };
  const o2 = await other.ctx.runGenerationWithTools({ id: 't' }, m2, BASE, { card });
  eq(other.bodies.length, 1, 'any other error is not retried');
  eq(o2.errored, true, 'and is returned as it was');
  const near = loopContext([{ errorMessage: 'upstream HTTP 500: jinja template error while rendering tools' }]);
  await near.ctx.runGenerationWithTools({ id: 't' }, { role: 'assistant', content: '' }, BASE, { card });
  eq(near.bodies.length, 1, 'an unrelated template error that mentions jinja and tools is not mistaken for the refusal');
  ok(near.ctx.isNoJinjaError('tool_choice param requires --jinja flag'), 'the tool_choice refusal is recognised too');
}

// D4: Stop between rounds
{
  const { ctx, bodies } = loopContext([{ calls: [{ id: 's', name: 'get_time', arguments: '{}' }] }], {
    onTool(c) { c.abortController.signal.aborted = true; }   // Stop pressed while the tool ran
  });
  const msg = { role: 'assistant', content: '' };
  const outcome = await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 1, 'no further request after Stop');
  eq(outcome.aborted, true, 'the outcome reads as stopped');
  eq(msg.toolCalls.length, 1, 'the call that ran is still recorded');

  const job = loopContext([{ calls: [{ id: 's', name: 'get_time', arguments: '{}' }] }], {
    onTool(c) { c.currentJob = { id: 'j', cancelSent: true }; }
  });
  await job.ctx.runGenerationWithTools({ id: 't' }, { role: 'assistant', content: '' }, BASE, { card });
  eq(job.bodies.length, 1, 'a cancelled job counts as Stop too');
}

// D5: no tools → exactly one unchanged request
{
  const { ctx, bodies } = loopContext([{ text: 'Hi.' }], { ctx: { cardToolDefs: () => [] } });
  const msg = { role: 'assistant', content: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 1, 'one request');
  eq(JSON.stringify(bodies[0]), JSON.stringify(BASE), 'byte-identical to the body the caller built: no tools field');
  ok(!/opts\.tools/.test(GEN), 'there is no way to hand the loop a tools array: cardToolDefs is the only source');
}

// D6: consent withdrawn mid-reply (box unticked, code off, or another card took the registry)
{
  let offers = 0;
  const { ctx, bodies } = loopContext(
    [{ calls: [{ id: 'w', name: 'get_time', arguments: '{}' }] }, { text: 'Fine.' }],
    { ctx: { cardToolDefs: () => (offers++ === 0 ? TOOLS : []) } });
  const msg = { role: 'assistant', content: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 1, 'consent gone after the stream: the calls are not run and no further request is sent');
  eq(msg.toolCalls, undefined, 'nothing is recorded as run');
  eq(ctx.toolCardIds.length, 0, 'runCardTool was never called');
}

// D7: a round cut by the token limit runs nothing
{
  const { ctx, bodies } = loopContext([{ calls: [{ id: 'l', name: 'roll_dice', arguments: '{"sid' }], finishReason: 'length' }]);
  const msg = { role: 'assistant', content: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 1, 'finish_reason length: the half-formed call is not run and the loop ends');
  eq(ctx.toolCardIds.length, 0, 'no tool ran');
  eq(msg._finishReason, undefined, 'the scratch field is cleared');
}

// D8: tool results have a per-reply budget
{
  const { ctx, bodies } = loopContext([{ calls: [{ id: 'b', name: 'get_time', arguments: '{}' }] }],
    { result: 'x'.repeat(13000) + '-' });
  const msg = { role: 'assistant', content: '' };
  await ctx.runGenerationWithTools({ id: 't' }, msg, BASE, { card });
  eq(bodies.length, 3, 'two rounds of 13,000-char results pass the 24,000 budget, so the third request is the last');
  ok(Array.isArray(bodies[1].tools) && !('tools' in bodies[2]), 'and it goes without tools');
  eq(msg.toolCalls.length, 2, 'the two calls that ran are recorded');
}

/* ================================================================
   E. RUNNING A TOOL
================================================================ */
console.log('\n=== E. runCardTool never throws; errors go back to the model as text ===');
{
  const r = await A.runCardTool('roll_dice', '{"sides": 6}', {});
  eq(r.result, '{"rolls":[4,3],"total":7,"sides":6}', 'an object result is JSON-stringified');
  eq(r.error, false, 'and is not an error');
  ok(typeof r.ms === 'number', 'the call is timed');
  eq((await A.runCardTool('get_time', '', {})).result, 'noon', 'empty arguments mean {} and a string comes back as is');
  eq((await A.runCardTool('nothing', '{}', {})).result, '', 'undefined becomes an empty string');
  const t = await A.runCardTool('throws', '{}', {});
  eq(t.result, 'error: boom', 'a tool that throws answers with the message');
  eq(t.error, true, 'flagged as an error');
  eq(A.liveCardTools().includes('throws'), true, 'and stays registered, unlike a throwing hook');
  const h = await A.runCardTool('hangs', '{}', { timeoutMs: 20 });
  eq(h.result, 'error: timed out after 20 ms', 'a tool that never returns times out');
  eq((await A.runCardTool('roll_dice', '{sides: 6', {})).result, 'error: arguments are not valid JSON', 'bad JSON from the model is an error result');
  eq((await A.runCardTool('nope', '{}', {})).result, 'error: unknown tool "nope"', 'an unknown name is an error result');
  const big = await A.runCardTool('big', '{}', {});
  ok(big.result.length < 8100 && /result cut at 8000/.test(big.result), 'a long result is capped at 8,000 characters');
  const ac = new AbortController(); ac.abort();
  eq((await A.runCardTool('get_time', '{}', { signal: ac.signal })).result, 'error: stopped', 'an aborted signal skips the call');
  eq((await A.runCardTool('get_time', '{}', { cardId: 'c1' })).result, 'noon', 'the owning card may run it');
  eq((await A.runCardTool('get_time', '{}', { cardId: 'someone-else' })).result,
     'error: the character changed before this call ran', 'another card\'s call is refused, not run against this registry');
  const long = await A.runCardTool('get_time', '{"pad":"' + 'y'.repeat(70000) + '"}', {});
  ok(/^error: arguments too long/.test(long.result), 'arguments over 64 KB are refused');
  ok(long.args.length < 8100 && /arguments cut at 8000/.test(long.args), 'and the stored copy is cut, like results');
  vm.runInContext(`gobbo_sig = null; _cardTools.set('watch', { name: 'watch', description: '', parameters: {},
    fn: (a, c) => new Promise(() => { c.signal.addEventListener('abort', () => { gobbo_sig = 'aborted'; }); }) })`, A);
  const w = await A.runCardTool('watch', '{}', { timeoutMs: 20 });
  eq(w.result, 'error: timed out after 20 ms', 'a tool watching its signal still times out');
  eq(vm.runInContext('gobbo_sig', A), 'aborted', 'and its ctx.signal was aborted by the timeout, so it can stop');
  eq(CARDCODE.match(/console\.log\('\[card-tool\] '/g)?.length, 1, 'every call is logged as [card-tool]');
}

/* ================================================================
   F. WIRING
================================================================ */
console.log('\n=== F. call sites, editor, defaults, variants, rendering ===');
{
  const calls = CHAT.match(/await runGenerationWithTools\(thread, assistantMsg, requestBody, \{ card \}\)/g) || [];
  eq(calls.length, 2, 'send and regenerate both go through the tool loop');
  eq((CHAT.match(/await runGenerationStream\(/g) || []).length, 1, 'only the job resume calls the transport directly');
  ok(/takePendingToolCalls\(msg\)/.test(CHAT) && /tool call interrupted by leaving the page/.test(CHAT),
     'a resumed round that ended in calls is recorded with a note');

  const box = HTML.slice(HTML.indexOf('id="card-custom-code"'), HTML.indexOf('Context &amp; Reply Length'));
  ok(/<input type="checkbox" id="card-tools-enabled">/.test(box), 'the checkbox sits under the custom code box');
  ok(/Let the model call this card's tools/.test(box), 'with the agreed label');
  ok(/aria-describedby="tip-card-tools"/.test(box) && /<div class="tip-body" id="tip-card-tools" hidden>/.test(box),
     'and a "?" tooltip in the HINT TOOLTIPS pattern');
  ok(/full page access/.test(box.slice(box.indexOf('card-tools-enabled'))), 'the visible sentence carries the warning');
  ok(/gobbo\.tool\(name, \{ description, parameters \}/.test(HTML), 'the help comment documents gobbo.tool');

  ok(/getElementById\('card-tools-enabled'\)\.checked = \(card\.toolsEnabled === true\)/.test(CARDS),
     'opening a card shows a missing field as off');
  ok(/card\.toolsEnabled = document\.getElementById\('card-tools-enabled'\)\.checked/.test(CARDS),
     'saving a card stores the checkbox');
  ok(/thinkingEnabled: true,\s*toolsEnabled: false/.test(CARDS), 'a new card starts with tools off');
  const defStart = STATE.indexOf('const DEFAULT_CARD = {');
  const defaultCard = defStart < 0 ? '' : STATE.slice(defStart, STATE.indexOf('\n};', defStart));
  ok(/\n  toolsEnabled: false,/.test(defaultCard), 'the default card has tools off');

  ok(/v\.toolCalls\s*=\s*msg\.toolCalls/.test(CHAT), 'syncActiveVariant saves the calls');
  ok(/msg\.toolCalls = v\.toolCalls;[\s\S]{0,80}delete msg\.toolCalls/.test(CHAT), 'applyVariantToMessage restores or clears them');
  ok(/toolCalls:\s*msg\.toolCalls,/.test(CHAT), 'the first reroll keeps the original\'s calls in variant 0');
  ok(/delete msg\._smartLimitAt;\s*delete msg\.toolCalls;/.test(CHAT) &&
     /delete assistantMsg\.genMs;\s*delete assistantMsg\.toolCalls;/.test(CHAT),
     'a reroll starts without the old calls (both paths)');

  ok(/<details class="tool-block">/.test(DASH) && /\$\{cotBlock\}\s*\$\{toolBlock\}\s*\$\{mainContent\}/.test(DASH),
     'the reply renders a collapsed tool block between reasoning and content');
  ok(/escapeHtml\(c\.name\)/.test(DASH) && /escapeHtml\(c\.args/.test(DASH) && /escapeHtml\(c\.result/.test(DASH),
     'name, arguments and result all go through escapeHtml');
  ok(!/class="cot-block tool-block"/.test(DASH), 'the block is not a .cot-block, which the streaming painter looks up');
  ok(/\.tool-block \{/.test(CSS) && /\.tool-call-error \.tool-call-result/.test(CSS), 'and it is styled');

  const PERSIST = read('js/05-persistence.js');
  const rf = PERSIST.match(/const RUNTIME_MESSAGE_FIELDS = \[([^\]]*)\]/);
  ok(rf && /_pendingToolCalls/.test(rf[1]) && /_finishReason/.test(rf[1]), 'the two scratch fields never reach storage or /state');
  ok(rf && !/toolPrefix/.test(rf[1]), 'toolPrefix does persist: a reload between rounds replays onto it');
  ok(/msg\.content = \(msg\.toolPrefix && msg\.toolPrefix\.content\) \|\| '';/.test(CHAT),
     'finalizeJobIntoThread starts the replay from the finished rounds\' text');
  ok(/function sweepInterruptedToolLoops\(\)/.test(CHAT) && /sweepInterruptedToolLoops\(\);\s*if \(jobsAvailable === false\)/.test(CHAT),
     'a loop that died with the page is noted by the boot sweep');
  ok(/delete msg\.toolPrefix;/.test(CHAT) && /delete assistantMsg\.toolPrefix;/.test(CHAT), 'a reroll clears a stale prefix (both paths)');
  ok(/parsed but NOT checked against the/.test(HTML) && /validate them in the tool/.test(HTML),
     'the help comment and tooltip say the arguments are the model\'s and need checking');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
