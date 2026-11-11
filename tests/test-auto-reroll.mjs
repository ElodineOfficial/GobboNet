/**
 * 1.8.0: Auto Reroll. A character's reply that uses one of its off-limits
 * words is written again; the reasoning is never checked.
 *
 * Run for real: the matcher, the stream feeder, the reroll loop and
 * stopGeneration (js/03-generation.js, js/10-chat.js), against a scripted
 * model fed through the same SSE lines llama-server sends. Then the badge,
 * the card editor box and the pointer from Banned Phrases.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const slice = (src, from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('cannot find ' + from);
  return src.slice(a, b);
};
const GEN = read('js/03-generation.js');
const CHAT = read('js/10-chat.js');
const MODEL = read('js/02-model.js');
const STATE = read('js/04-state.js');
const DASH = read('js/13-dashboard.js');
const CARDS = read('js/15-cards.js');
const IO = read('js/16-card-io.js');
const SYNC = read('js/06-state-sync.js');
const HTML = read('chat.html');

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };

// --- the generation code, in one context -----------------------------------
function world() {
  const toasts = [];
  const ctx = {
    console: { log() {}, warn() {}, error: console.error }, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    LLAMA_URL: '/llm', IS_SERVED: true,
    document: { visibilityState: 'visible', getElementById: () => null },
    showModelSwitchToast: (m) => toasts.push(m),
    renderStreamingUpdate() {}, renderMessages() {}, scrollToBottom() {}, saveState() {}, renderSidebar() {},
    privacyFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    cancelAutoContinue() {}, cardToolDefs: () => [], captureScrollAnchor() {}, settleScrollAfterGeneration() {},
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let isGenerating = false, abortController = null, autoContinue = null, scrollPinnedToBottom = true;
    let activeModel = { thinkingFormat: 'none' };
    let state = { settings: {}, activeThreadId: 't1' };
    let _card = null; function getActiveCard() { return _card; }
  ` + slice(MODEL, 'function extractTokenFromLine', '/**\n * The tool-call half')
    + slice(MODEL, 'function extractToolCallDeltas', '\n}\n') + '\n}\n'
    + slice(STATE, 'function resolveSmartLimit', '\n}\n') + '\n}\n'
    + 'function estimateTokens(text) { if (!text) return 0; return Math.ceil(text.split(/\\s+/).filter(Boolean).length * (1000 / 700)); }\n'
    + GEN + '\n' + slice(CHAT, 'function stopGeneration', '/* ====') + `
    this.setCard = c => { _card = c; };
    this.setModel = m => { activeModel = m; };
    this.ac = () => abortController;
    this.newAc = () => { abortController = new AbortController(); };
    this.turn = () => _autoRerollTurn;
  `, ctx);
  return { ctx, toasts };
}

/* A scripted model. Each try is { chunks, reasoning?, tool?, userStopAt? }.
   Replaces runGenerationStream; everything above it is the real code. */
function script(w, tries) {
  const calls = [];
  w.ctx.runGenerationStream = async (thread, msg) => {
    const t = tries.shift() || { chunks: ['(no more tries scripted)'] };
    const rec = { consumed: 0, abortedAtStart: !!(w.ctx.ac() && w.ctx.ac().signal.aborted), total: t.chunks.length };
    calls.push(rec);
    const feeder = w.ctx.makeStreamFeeder(msg, thread);
    const enc = new TextEncoder();
    for (let i = 0; i < t.chunks.length; i++) {
      if (w.ctx.ac() && w.ctx.ac().signal.aborted) return { errored: false, aborted: true, jobMode: false };
      if (t.userStopAt === i) w.ctx.stopGeneration();
      if (t.reasoningFirst && i === 0) feeder.feed(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: t.reasoningFirst } }] }) + '\n\n'));
      feeder.feed(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: t.chunks[i] } }] }) + '\n\n'));
      rec.consumed++;
    }
    if (t.tool) msg.toolCalls = [{ name: 'roll', source: 'card' }];
    feeder.flush();
    return { errored: false, aborted: !!(w.ctx.ac() && w.ctx.ac().signal.aborted), jobMode: false };
  };
  return calls;
}

async function turn(card, tries) {
  const w = world();
  w.ctx.setCard(card);
  const calls = script(w, tries);
  const thread = { id: 't1', messages: [] };
  const msg = { role: 'assistant', content: '', reasoning: '' };
  w.ctx.newAc();
  const outcome = await w.ctx.runGenerationWithReroll(thread, msg, { messages: [] }, { card });
  w.ctx.finalizeStreamMessage(msg);
  return { w, calls, msg, outcome };
}

const CARD = (o) => Object.assign({ id: 'c1', temperature: 0.8, autoRerollEnabled: true, autoRerollWords: 'chuckl*\nnod\na mix of\n—', autoRerollMax: 3 }, o || {});

console.log('\n=== matching ===');
{
  const { ctx } = world();
  const m = ctx.autoRerollMatchers('chuckl*\nnod\na mix of\n—\ndon\'t\n*esque\n*\n  \nSmirk\nsmirk');
  ok(m.map(x => x.entry).join('|') === "chuckl*|nod|a mix of|—|don't|*esque|Smirk", 'one entry per line; blank lines, a bare * and repeats (any case) are skipped', m.map(x => x.entry));
  const f = (t, s) => { const h = ctx.findOffLimitsWord(t, m, 0, !!s); return h ? h.match : null; };
  ok(f('He nodded.') === null && f('He gave a nod.') === 'nod', 'whole words: "nod" does not catch "nodded"');
  ok(f('She chuckled softly') === 'chuckled' && f('Kafkaesque mood') === 'Kafkaesque', '* stands for any ending, or any beginning');
  ok(f('a  Mix\nof colours') === 'a  Mix\nof', 'a phrase matches across any spaces and line breaks, in any case');
  ok(f('I don’t know') === 'don’t', 'straight and curly apostrophes match each other');
  ok(f('Wait—no') === '—', 'a line of punctuation matches anywhere, even inside a word');
  ok(f('A SMIRK.') === 'SMIRK' && f('smirks') === null, 'any case, whole word');
  ok(f('he smirk', true) === null && f('he smirk ', true) === 'smirk' && f('he smirk', false) === 'smirk',
     'while streaming, a word at the very end waits for the next character: "smirk" may yet be "smirks"');
  ok(ctx.findOffLimitsWord('a nod here, chuckling there', m).match === 'nod', 'the first word in the text is the one reported');
}

console.log('\n=== a clean reply ===');
{
  const { calls, msg, w } = await turn(CARD(), [{ chunks: ['The rain ', 'fell all ', 'night.'] }]);
  ok(calls.length === 1 && msg.content === 'The rain fell all night.' && !('autoReroll' in msg), 'one request, the reply as written, no marker');
  ok(w.toasts.length === 0, 'and nothing said about it');
}

console.log('\n=== a reply that uses a word ===');
{
  const { calls, msg, outcome, w } = await turn(CARD(), [
    { chunks: ['He ', 'chuck', 'led and ', 'said ', 'more ', 'things.'] },
    { chunks: ['He ', 'smiled.'] },
  ]);
  ok(calls.length === 2, 'it is written again: two requests', calls);
  ok(calls[0].consumed < calls[0].total, `the first was stopped where the word appeared, not left to finish (${calls[0].consumed} of ${calls[0].total} chunks)`);
  ok(msg.content === 'He smiled.' && !/chuckl/.test(msg.content), 'the reply is the second try, with nothing of the first', msg.content);
  ok(msg.autoReroll && msg.autoReroll.rerolls === 1 && msg.autoReroll.words[0] === 'chuckled' && !msg.autoReroll.kept, 'and is marked: one reroll, for "chuckled", the word as it was written', msg.autoReroll);
  ok(!outcome.aborted && !outcome.errored, 'the turn ends as a normal reply, not a stopped one', outcome);
  ok(!calls[1].abortedAtStart, 'the second try starts with a live abort controller, not the one the first stop used');
  ok(/used “chuckled”, writing it again \(1 of 3\)/.test(w.toasts[0] || ''), 'and says so as it happens', w.toasts);
  ok(w.ctx.turn() === null, 'nothing of the check is left behind');
  ok(!Object.keys(msg).some(k => k.startsWith('_')), 'and nothing is left on the message to be saved or synced', Object.keys(msg));
}

console.log('\n=== every try uses one ===');
{
  const bad = () => ({ chunks: ['A ', 'nod ', 'and ', 'a ', 'long ', 'answer.'] });
  const { calls, msg, outcome } = await turn(CARD({ autoRerollMax: 2 }), [bad(), bad(), bad()]);
  ok(calls.length === 3, 'Tries 2: three requests in all', calls.length);
  ok(calls[0].consumed < calls[0].total && calls[1].consumed < calls[1].total, 'the first two are stopped at the word');
  ok(calls[2].consumed === calls[2].total && msg.content === 'A nod and a long answer.', 'the last runs to its end and is kept whole', msg.content);
  ok(msg.autoReroll && msg.autoReroll.rerolls === 2 && msg.autoReroll.kept === 'tries', 'marked: kept after two rerolls', msg.autoReroll);
  ok(!outcome.aborted, 'and it is a finished reply');
}

console.log('\n=== where a stream cannot stop ===');
{
  const { calls, msg } = await turn(CARD(), [{ chunks: ['He looked up and gave a ', 'nod'] }, { chunks: ['He looked up.'] }]);
  ok(calls.length === 2 && msg.content === 'He looked up.', 'a word that ends the reply is caught when it ends, and written again');
  const r = await turn(CARD(), [{ chunks: ['He ', 'nod', 'ded slowly.'] }]);
  ok(r.calls.length === 1 && r.msg.content === 'He nodded slowly.', '"nod" then "ded" is "nodded": no false alarm on a word cut between chunks');
  const s = await turn(CARD(), [{ chunks: ['It was a ', 'mix ', 'of ', 'things.'] }, { chunks: ['Fine.'] }]);
  ok(s.calls.length === 2, 'a phrase that arrives a word at a time is caught');
}

console.log('\n=== the reasoning is not checked ===');
{
  const { calls, msg } = await turn(CARD(), [{ reasoningFirst: 'I should not chuckle or nod here — a mix of things.', chunks: ['Hello there.'] }]);
  ok(calls.length === 1 && msg.content === 'Hello there.' && /chuckle/.test(msg.reasoning), 'off-limits words in the thinking are left alone', { content: msg.content, reasoning: msg.reasoning });
  const dsk = world();
  dsk.ctx.setModel({ thinkingFormat: 'deepseek' });
  dsk.ctx.setCard(CARD());
  const c2 = script(dsk, [{ chunks: ['<think>Maybe a', ' nod? No.</think>', 'She ', 'waved.'] }]);
  const m2 = { role: 'assistant', content: '', reasoning: '' };
  dsk.ctx.newAc();
  await dsk.ctx.runGenerationWithReroll({ id: 't1' }, m2, {}, { card: CARD() });
  ok(c2.length === 1 && m2.content === 'She waved.', 'nor inline <think> reasoning, once the parser has taken it out of the reply', m2);
}

console.log('\n=== when it does not reroll ===');
{
  const stopped = await turn(CARD(), [{ chunks: ['Once ', 'upon ', 'a ', 'nod ', 'time.'], userStopAt: 2 }, { chunks: ['never'] }]);
  ok(stopped.calls.length === 1 && stopped.outcome.aborted, 'Stop pressed: the turn ends there, and no reroll starts after it', stopped.calls.length);
  // Stop pressed in the moment between a hit and the next try.
  const lw = world();
  lw.ctx.setCard(CARD());
  const lcalls = script(lw, [{ chunks: ['A ', 'nod ', 'here.'] }, { chunks: ['never'] }]);
  lw.ctx.showModelSwitchToast = () => lw.ctx.stopGeneration();
  const lmsg = { role: 'assistant', content: '', reasoning: '' };
  lw.ctx.newAc();
  const lout = await lw.ctx.runGenerationWithReroll({ id: 't1' }, lmsg, {}, { card: CARD() });
  ok(lcalls.length === 1 && lout.aborted, 'Stop pressed between a hit and the next try: the next try never starts', { calls: lcalls.length, lout });
  const cold = await turn(CARD({ temperature: 0 }), [{ chunks: ['A ', 'nod ', 'here.'] }, { chunks: ['never'] }]);
  ok(cold.calls.length === 1 && cold.msg.content === 'A nod here.' && cold.msg.autoReroll.kept === 'temperature',
     'Temperature 0: every try would be the same, so it is checked, marked and kept', cold.msg.autoReroll);
  const off = await turn(CARD({ autoRerollEnabled: false }), [{ chunks: ['A ', 'nod.'] }]);
  ok(off.calls.length === 1 && !('autoReroll' in off.msg), 'switched off: nothing is checked');
  const empty = await turn(CARD({ autoRerollWords: '\n  \n*' }), [{ chunks: ['A nod.'] }]);
  ok(empty.calls.length === 1 && !('autoReroll' in empty.msg), 'an empty list: nothing is checked');
  const tool = await turn(CARD(), [{ chunks: ['Rolled. ', 'A nod.'], tool: true }, { chunks: ['never'] }]);
  ok(tool.calls.length === 1 && tool.msg.autoReroll && tool.msg.autoReroll.kept === 'tool', 'a reply that ran a tool is kept: a reroll would run the tool again', tool.msg.autoReroll);
}

console.log('\n=== the stop is not the user\'s ===');
{
  ok(/if \(!opts\.keepChain && typeof _genStopRequested !== 'undefined'\) _genStopRequested = true;/.test(CHAT),
     'stopGeneration marks every stop but the smart limit\'s and Auto Reroll\'s own');
  ok(/stopGeneration\(\{ keepChain: true, autoReroll: true \}\)/.test(GEN), 'Auto Reroll stops a try without ending an auto-continue chain');
  ok((CHAT.match(/await runGenerationWithReroll\(thread, assistantMsg, requestBody, \{ card \}\)/g) || []).length === 2 && !/await runGenerationWithTools\(thread, assistantMsg, requestBody/.test(CHAT),
     'sending and rerolling both go through it');
  ok(/if \(assistantMsg\.smartCapped \|\| autoRerollFrozen\(assistantMsg\)\) return;/.test(GEN), 'the feeder takes nothing more once a try is stopped (the job poll keeps draining)');
}

console.log('\n=== the badge ===');
{
  const ctx = { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext(slice(DASH, 'function autoRerollBadge', '\n}\n') + '\n}\n', ctx);
  const b = ctx.autoRerollBadge;
  ok(/&#8635; 2</.test(b({ rerolls: 2, words: ['nod'] })) && /2 replies were written again for using “nod”/.test(b({ rerolls: 2, words: ['nod'] })), '↻ 2, saying why');
  ok(/gen-reroll-kept/.test(b({ rerolls: 3, words: ['nod'], kept: 'tries' })) && /every try used/.test(b({ rerolls: 3, kept: 'tries' })), 'kept: the other colour, and what happened');
  ok(/&#8635; kept/.test(b({ rerolls: 0, words: ['x'], kept: 'temperature' })), 'kept without a reroll says just "kept"');
  const evil = b({ rerolls: '9"><img src=x onerror=alert(1)>', words: ['"><script>alert(1)</script>'], kept: '<b>' });
  ok(!/<script|<img|onerror="/.test(evil), 'synced values cannot break out: the count is a number, the words are escaped, the reason is one of three', evil);
  ok(b({ rerolls: 0 }) === '' && b({}) === '', 'nothing to say, no badge');
  ok(/if \(m\.autoReroll && typeof m\.autoReroll === 'object' && !isCurrentlyGenerating\) genBadges \+= autoRerollBadge\(m\.autoReroll\);/.test(DASH), 'shown in the reply\'s header once it has finished');
  ok(/v\.autoReroll     = msg\.autoReroll;/.test(CHAT) && /msg\.autoReroll = v\.autoReroll;/.test(CHAT), 'each variant keeps its own');
}

console.log('\n=== the card editor ===');
{
  const box = slice(HTML, 'id="card-auto-reroll-group"', '<div class="modal-actions">');
  ok(/id="card-auto-reroll-enabled"/.test(box) && /id="card-auto-reroll-words"/.test(box) && /id="card-auto-reroll-max" min="1" max="10"/.test(box), 'the box: a switch, the list, Tries 1 to 10');
  const hint = /<div class="form-hint">([^<]*)<button type="button" class="tip-btn" aria-label="More about Auto Reroll"/.exec(box);
  ok(hint && hint[1].split(/[.!?](\s|$)/).filter(x => x && x.trim()).length === 1 && /thinking is never checked/.test(hint[1]), 'the line before "?" is one sentence, and says the thinking is not checked', hint && hint[1]);
  const banned = slice(HTML, 'id="card-banned-phrases"', 'id="card-logit-strength"');
  ok(/Logit bias does not stop every word yet, so <strong>Auto Reroll<\/strong> is its best supplement/.test(banned) && /onclick="goToAutoReroll\(\)"/.test(banned),
     'Banned Phrases (the logit bias section) points to Auto Reroll as its best supplement, with a way there');
  ok(/Until logit bias catches every word, <strong>Auto Reroll<\/strong> is the best supplement/.test(banned), 'and its "?" says so too');
  ok(HTML.indexOf('id="card-banned-phrases"') < HTML.indexOf('id="card-auto-reroll-group"'), 'the box comes after it, below the samplers');
  ok(/card-auto-reroll-enabled'\)\.checked = \(card\.autoRerollEnabled === true\)/.test(CARDS) && /card\.autoRerollWords = document\.getElementById\('card-auto-reroll-words'\)\.value/.test(CARDS),
     'the editor loads and saves it');
  ok(/autoRerollEnabled: false,\s*autoRerollWords: '',\s*autoRerollMax: 3/.test(STATE) && /autoRerollEnabled: false,\s*autoRerollWords: '',\s*autoRerollMax: 3/.test(CARDS), 'off for every card until ticked, old and new');
  ok(/updateAutoRerollNote/.test(SYNC.slice(SYNC.indexOf('function applySamplerPreset'))), 'a sampler preset updates its note (it depends on Temperature)');

  // The note and ADD MY BANNED PHRASES, for real.
  const els = {
    'card-auto-reroll-note': { textContent: '' }, 'card-auto-reroll-enabled': { checked: true },
    'card-auto-reroll-words': { value: 'nod\nSmirk' }, 'card-auto-reroll-max': { value: '4' }, 'card-temperature': { value: '0.8' },
    'card-banned-phrases': { value: 'smirk\nsuddenly\n\nchuckle' },
  };
  const w = world();
  w.ctx.document = { getElementById: id => els[id] || null };
  w.ctx.updateAutoRerollNote();
  ok(els['card-auto-reroll-note'].textContent === 'On: a reply that uses one of these 2 words is written again, up to 4 more times.', 'the note says what it will do', els['card-auto-reroll-note'].textContent);
  w.ctx.addBannedToAutoReroll();
  ok(els['card-auto-reroll-words'].value === 'nod\nSmirk\nsuddenly\nchuckle', 'ADD MY BANNED PHRASES adds the ones not already there, in any case', els['card-auto-reroll-words'].value);
  els['card-temperature'].value = '0';
  w.ctx.updateAutoRerollNote();
  ok(/Temperature is 0/.test(els['card-auto-reroll-note'].textContent), 'at Temperature 0 it says rerolling cannot help');
  els['card-auto-reroll-enabled'].checked = false;
  w.ctx.updateAutoRerollNote();
  ok(/^Off: tick the box above to check replies for these 4 words\.$/.test(els['card-auto-reroll-note'].textContent), 'off with a list: says how to switch it on', els['card-auto-reroll-note'].textContent);
  els['card-auto-reroll-enabled'].checked = true;
  els['card-temperature'].value = '0.7';
  els['card-auto-reroll-words'].value = 'nod';
  els['card-auto-reroll-max'].value = '1';
  w.ctx.updateAutoRerollNote();
  ok(els['card-auto-reroll-note'].textContent === 'On: a reply that uses this word is written again, up to 1 more time.', 'one word, one try: said as such', els['card-auto-reroll-note'].textContent);
  ok(w.ctx.autoRerollMaxOf({ autoRerollMax: '99' }) === 10 && w.ctx.autoRerollMaxOf({ autoRerollMax: '0' }) === 1 && w.ctx.autoRerollMaxOf({}) === 3, 'Tries held to 1..10, 3 when unset');
}

console.log('\n=== shared cards ===');
{
  ok(/g\.autoReroll = \{ enabled: card\.autoRerollEnabled === true, words: card\.autoRerollWords\.slice\(0, AUTO_REROLL_MAX_WORDS_CHARS\),/.test(IO), 'an exported card carries its list');
  ok(/card\.autoRerollWords = ar\.words\.replace\(\/\\u0000\/g, ''\)\.slice\(0, AUTO_REROLL_MAX_WORDS_CHARS\);/.test(IO) && /card\.autoRerollMax = autoRerollMaxOf\(\{ autoRerollMax: ar\.tries \}\);/.test(IO),
     'an imported one is capped and its tries held to 1..10');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
