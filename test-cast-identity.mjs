/**
 * Item 10 — the agent icon shows the character that produced the message.
 *
 * Drives the REAL makeCastResolver / createThread / forkAt from js/09-threads.js
 * in a minimal fake DOM, plus source-level guards that the render path and the
 * send paths actually use them.
 *
 * The matrix that matters is the fallback chain: message stamp → thread stamp →
 * tombstone → active card. Every rung is exercised, including the two rungs a
 * pre-1.7 backup lands on.
 */
import fs from 'fs';
import vm from 'vm';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const THREADS = fs.readFileSync(ROOT + '/js/09-threads.js', 'utf8');

// makeCastResolver + createThread come as one block; forkAt is above them.
const resolverBlock = THREADS.slice(
  THREADS.indexOf('/* ── Who said this?'),
  THREADS.indexOf('/**\n * Activity-based ordering')
);
const forkBlock = THREADS.slice(
  THREADS.indexOf('function forkAt('),
  THREADS.indexOf('/** All fork threads that branched')
);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};
const eq = (a, b, label) => ok(a === b, label + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const CARD_A = { id: 'ca', name: 'Assistant', avatar: 'A.png', textColor: '#111111', dialogColor: '#222222' };
const CARD_B = { id: 'cb', name: 'CodeGoblin', avatar: 'B.png', textColor: '#333333', dialogColor: '#444444' };
const PER_1 = { id: 'p1', name: 'Elodine', avatar: 'E.png', textColor: '#555555', dialogColor: '#666666' };
const PER_2 = { id: 'p2', name: 'Ghost', avatar: 'G.png', textColor: '#777777', dialogColor: '#888888' };

function build({ cards = [CARD_A, CARD_B], personas = [PER_1, PER_2],
                 activeCardId = 'ca', activePersonaId = 'p1' } = {}) {
  const ctx = {
    console,
    state: {
      threads: [],
      characterCards: cards.map(c => ({ ...c })),
      personaCards: personas.map(p => ({ ...p })),
      activeCardId, activePersonaId,
      activeThreadId: null,
      sidebarOpen: false,
    },
    DEFAULT_CARD: { id: 'default', name: 'Assistant', avatar: '', textColor: '#aaaaaa', dialogColor: '#bbbbbb' },
    DEFAULT_PERSONA: { id: 'default-persona', name: 'Anonymous', avatar: '', textColor: '#cccccc', dialogColor: '#dddddd' },
    window: { innerWidth: 1400 },
    document: { getElementById: () => ({ focus: () => {}, style: {}, value: '', scrollHeight: 0 }) },
    saveState: () => {},
    render: () => {},
    renderSidebar: () => {},
    applyActiveCardBackground: () => {},
    updateSidebarVisibility: () => {},
    scrollToBottom: () => {},
    injectGreeting: () => {},
    getAllForksOf: () => [],
    generateId: () => 'gen' + (build._n = (build._n || 0) + 1),
  };
  ctx.getActiveCard = () =>
    ctx.state.characterCards.find(c => c.id === ctx.state.activeCardId) ||
    ctx.state.characterCards[0] || ctx.DEFAULT_CARD;
  ctx.getActivePersona = () =>
    ctx.state.personaCards.find(p => p.id === ctx.state.activePersonaId) ||
    ctx.state.personaCards[0] || { ...ctx.DEFAULT_PERSONA };
  ctx.getActiveThread = () => ctx.state.threads.find(t => t.id === ctx.state.activeThreadId) || null;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(resolverBlock + '\n' + forkBlock, ctx);
  return ctx;
}

console.log('\n=== A. the reported bug: an old thread keeps its own face ===');
{
  const ctx = build();
  // A thread started under CodeGoblin, with its replies stamped.
  const thread = { id: 't1', cardId: 'cb', cardName: 'CodeGoblin', personaId: 'p1', personaName: 'Elodine',
    messages: [
      { role: 'user', content: 'hi', personaId: 'p1' },
      { role: 'assistant', content: 'yo', cardId: 'cb' },
    ] };
  // ...viewed while Assistant is the selected card. This is issue #19's setup.
  ctx.state.activeCardId = 'ca';
  const cast = ctx.makeCastResolver(thread);
  eq(cast.cardFor(thread.messages[1]).name, 'CodeGoblin', 'assistant turn keeps the card that wrote it');
  eq(cast.cardFor(thread.messages[1]).avatar, 'B.png', 'and its avatar');
  eq(cast.cardFor(thread.messages[1]).dialogColor, '#444444', 'and its dialogue colour');
  eq(ctx.getActiveCard().name, 'Assistant', 'while the active card is still something else');
}

console.log('\n=== B. fallback chain, rung by rung ===');
{
  const ctx = build();
  const thread = { id: 't1', cardId: 'cb', cardName: 'CodeGoblin', messages: [] };
  const cast = ctx.makeCastResolver(thread);

  eq(cast.cardFor({ role: 'assistant', cardId: 'ca' }).name, 'Assistant', '1. message stamp wins');
  eq(cast.cardFor({ role: 'assistant' }).name, 'CodeGoblin', '2. unstamped message falls to the thread stamp');

  // 3. tombstone: the card was deleted out from under the thread.
  ctx.state.characterCards = [{ ...CARD_A }];
  const cast2 = ctx.makeCastResolver(thread);
  eq(cast2.cardFor({ role: 'assistant' }).name, 'CodeGoblin', '3. deleted card falls to the tombstone name');
  eq(cast2.cardFor({ role: 'assistant' }).avatar, '', '   tombstone renders a neutral avatar, not the active one');
  eq(cast2.cardFor({ role: 'assistant' }).id, null, '   tombstone is not mistaken for a real card');

  // 4. legacy thread: no stamps anywhere. Must behave exactly as pre-1.7.
  const legacy = { id: 't0', messages: [{ role: 'assistant', content: 'old' }] };
  const cast3 = ctx.makeCastResolver(legacy);
  eq(cast3.cardFor(legacy.messages[0]).name, 'Assistant', '4. legacy thread falls to the active card (unchanged behaviour)');
}

console.log('\n=== C. a thread that legitimately switched cards ===');
{
  const ctx = build();
  const thread = { id: 't1', cardId: 'ca', cardName: 'Assistant', messages: [
    { role: 'assistant', content: 'first', cardId: 'ca' },
    { role: 'assistant', content: 'second', cardId: 'cb' },
    { role: 'assistant', content: 'unstamped' },
  ] };
  const cast = ctx.makeCastResolver(thread);
  eq(cast.cardFor(thread.messages[0]).name, 'Assistant', 'turn 1 renders as Assistant');
  eq(cast.cardFor(thread.messages[1]).name, 'CodeGoblin', 'turn 2 renders as CodeGoblin in the same thread');
  eq(cast.cardFor(thread.messages[2]).name, 'Assistant', 'unstamped turn uses the thread stamp, not the neighbour');
}

console.log('\n=== D. personas resolve the same way ===');
{
  const ctx = build();
  const thread = { id: 't1', personaId: 'p2', personaName: 'Ghost', messages: [] };
  ctx.state.activePersonaId = 'p1';
  const cast = ctx.makeCastResolver(thread);
  eq(cast.personaFor({ role: 'user', personaId: 'p2' }).name, 'Ghost', 'user turn keeps the persona that wrote it');
  eq(cast.personaFor({ role: 'user' }).name, 'Ghost', 'unstamped user turn falls to the thread stamp');

  ctx.state.personaCards = [{ ...PER_1 }];
  eq(ctx.makeCastResolver(thread).personaFor({ role: 'user' }).name, 'Ghost', 'deleted persona falls to the tombstone');

  const legacy = { id: 't0', messages: [] };
  eq(ctx.makeCastResolver(legacy).personaFor({ role: 'user' }).name, 'Elodine', 'legacy thread uses the active persona');

  // Card and persona resolve independently. Fresh context: the tombstone case
  // above deleted p2, which would put this on a different rung.
  const ctx2 = build();
  const mixed = { id: 't2', cardId: 'cb', personaId: 'p2', messages: [] };
  const c = ctx2.makeCastResolver(mixed);
  eq(c.cardFor({}).name, 'CodeGoblin', 'card side unaffected by persona state');
  eq(c.personaFor({}).name, 'Ghost', 'persona side unaffected by card state');
}

console.log('\n=== E. no personas at all ===');
{
  const ctx = build({ personas: [] });
  const thread = { id: 't1', messages: [] };
  eq(ctx.makeCastResolver(thread).personaFor({ role: 'user' }).name, 'Anonymous', 'empty roster falls to DEFAULT_PERSONA');
  const stamped = { id: 't2', personaId: 'gone', messages: [] };
  eq(ctx.makeCastResolver(stamped).personaFor({ role: 'user' }).name, 'Anonymous', 'stamp pointing at nothing, no tombstone: active persona');
}

console.log('\n=== F. createThread stamps identity ===');
{
  const ctx = build();
  ctx.state.activeCardId = 'cb';
  ctx.state.activePersonaId = 'p2';
  ctx.createThread();
  const t = ctx.state.threads[0];
  eq(t.cardId, 'cb', 'thread records the card it was started under');
  eq(t.cardName, 'CodeGoblin', 'thread records the tombstone name');
  eq(t.personaId, 'p2', 'thread records the persona');
  eq(t.personaName, 'Ghost', 'thread records the persona tombstone name');

  // Switching cards afterwards must not retroactively change the thread.
  ctx.state.activeCardId = 'ca';
  eq(ctx.state.threads[0].cardId, 'cb', 'switching the active card leaves the thread stamp alone');
  eq(ctx.makeCastResolver(t).cardFor({ role: 'assistant' }).name, 'CodeGoblin', 'and the thread still renders as CodeGoblin');
}

console.log('\n=== G. forks inherit from the source, not from whoever is active ===');
{
  const ctx = build();
  const src = { id: 't1', name: 'Deep Dive', cardId: 'cb', cardName: 'CodeGoblin',
    personaId: 'p2', personaName: 'Ghost', folderId: null, tags: [], lore: 'x',
    messages: [
      { role: 'user', content: 'q', personaId: 'p2' },
      { role: 'assistant', content: 'a', cardId: 'cb' },
      { role: 'user', content: 'q2', personaId: 'p2' },
    ] };
  ctx.state.threads = [src];
  ctx.state.activeThreadId = 't1';
  ctx.state.activeCardId = 'ca';          // user has since switched away
  ctx.state.activePersonaId = 'p1';

  ctx.forkAt(2);
  const fork = ctx.state.threads[0];
  ok(fork.id !== 't1', 'fork is a new thread');
  eq(fork.cardId, 'cb', 'fork inherits the source card, not the active one');
  eq(fork.cardName, 'CodeGoblin', 'fork inherits the tombstone name');
  eq(fork.personaId, 'p2', 'fork inherits the source persona');
  eq(fork.messages.length, 2, 'fork copied the shared history');
  eq(fork.messages[1].cardId, 'cb', 'copied messages keep their own stamps');
  eq(ctx.makeCastResolver(fork).cardFor(fork.messages[1]).name, 'CodeGoblin', 'fork renders as CodeGoblin throughout');
}

console.log('\n=== H. render path actually uses the resolver ===');
{
  const DASH = fs.readFileSync(ROOT + '/js/13-dashboard.js', 'utf8');
  const body = DASH.slice(DASH.indexOf('const cast = makeCastResolver'), DASH.indexOf('function updateContextInfo'));
  ok(/const msgCard = cast\.cardFor\(m\)/.test(body), 'renderMessages resolves the card per message');
  ok(/const msgPersona = cast\.personaFor\(m\)/.test(body), 'renderMessages resolves the persona per message');
  ok(!/renderAvatar\(card\.avatar/.test(body), 'the list-level card avatar is gone');
  ok(!/renderAvatar\(persona\.avatar/.test(body), 'the list-level persona avatar is gone');
  ok(!/const aiTextColor\s*=/.test(body), 'the four list-level colour consts are gone');
  ok(/translateTemplates\(displayContent, cardName, userName, true\)/.test(body) &&
     /const cardName = msgCard\.name/.test(body),
     '{{char}} expands to the message\'s own card, not the active one');
}

console.log('\n=== I. every send path stamps ===');
{
  const CHAT = fs.readFileSync(ROOT + '/js/10-chat.js', 'utf8');
  const PROMPT = fs.readFileSync(ROOT + '/js/07-prompt.js', 'utf8');
  const SCHED = fs.readFileSync(ROOT + '/js/22-scheduler.js', 'utf8');

  ok(/role: 'user', content: storedContent, timestamp: Date\.now\(\),\s*\n\s*personaId: getActivePersona\(\)\.id/.test(CHAT),
     'sendMessage stamps the user turn');
  ok(/genStartedAt: Date\.now\(\), cardId: card\.id/.test(CHAT),
     'sendMessage stamps the assistant turn');
  ok(/assistantMsg\.cardId = card\.id/.test(CHAT),
     'reroll re-stamps: new text, current card');
  ok(/role: 'assistant', content: '', timestamp: Date\.now\(\), cardId: card\.id/.test(CHAT),
     'regenerate stamps a fresh assistant turn');
  ok(/timestamp: ts,[\s\S]{0,220}cardId: card\.id/.test(PROMPT),
     'injectGreeting stamps the opening message');
  ok(/scheduled: true,\s*\n\s*personaId: getActivePersona\(\)\.id/.test(SCHED),
     'the scheduler stamps its injected user turn');

  // The one deliberate omission.
  const recovery = CHAT.slice(CHAT.indexOf('async function finalizeJobIntoThread'));
  ok(/Deliberately unstamped/.test(recovery),
     'the resume-after-reload recovery path is documented as intentionally unstamped');
}

console.log('\n=== J. the new fields survive a save ===');
{
  const PERSIST = fs.readFileSync(ROOT + '/js/05-persistence.js', 'utf8');
  const clean = PERSIST.slice(PERSIST.indexOf('function cleanThread'), PERSIST.indexOf('function buildStateBlob'));
  ok(/\.\.\.t,/.test(clean), 'cleanThread spreads the thread, so cardId/cardName persist');
  ok(!/delete clean\.cardId|delete clean\.personaId/.test(clean), 'no message stamp is stripped on save');
  ok(/cardId \/ personaId are deliberately NOT backfilled/.test(PERSIST),
     'the no-backfill decision is recorded at the migration site');

  // Round-trip a stamped thread the way a save/load does.
  const t = { id: 't', cardId: 'cb', cardName: 'CodeGoblin', personaId: 'p2', personaName: 'Ghost',
              messages: [{ role: 'assistant', content: 'a', cardId: 'cb' }] };
  const back = JSON.parse(JSON.stringify(t));
  eq(back.cardId, 'cb', 'thread stamp round-trips through JSON');
  eq(back.messages[0].cardId, 'cb', 'message stamp round-trips through JSON');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
