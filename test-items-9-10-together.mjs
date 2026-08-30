/**
 * Items 9 + 10 together.
 *
 * The two items touch card identity from opposite ends: item 9 makes array
 * position user-controlled, item 10 resolves identity by id. This checks the
 * seam between them, which neither item's own harness covers.
 *
 * The specific worry: item 9 made `characterCards[0]` a user-chosen card
 * rather than the oldest one, and item 10's resolver falls through to
 * getActiveCard() — which reads [0] when activeCardId dangles.
 */
import fs from 'fs';
import vm from 'vm';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const THREADS = fs.readFileSync(ROOT + '/js/09-threads.js', 'utf8');
const CARDS = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');

const resolverBlock = THREADS.slice(
  THREADS.indexOf('/* ── Who said this?'),
  THREADS.indexOf('/**\n * Activity-based ordering')
);
const orderBlock = CARDS.slice(
  CARDS.indexOf('/* ── Cast ordering'),
  CARDS.indexOf('function activateCard(')
);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  \u2713 ' + l); } else { fail++; console.log('  \u2717 ' + l); } };
const eq = (a, b, l) => ok(a === b, l + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

function build() {
  const ctx = {
    console,
    state: {
      characterCards: [
        { id: 'ca', name: 'Assistant', avatar: 'A.png' },
        { id: 'cb', name: 'CodeGoblin', avatar: 'B.png' },
        { id: 'cc', name: 'Archivist', avatar: 'C.png' },
      ],
      personaCards: [{ id: 'p1', name: 'Elodine', avatar: 'E.png' }],
      activeCardId: 'ca',
      activePersonaId: 'p1',
      threads: [],
    },
    DEFAULT_CARD: { id: 'default', name: 'Assistant', avatar: '' },
    DEFAULT_PERSONA: { id: 'default-persona', name: 'Anonymous', avatar: '' },
    // The real renderCardGrid comes in with the extracted block, so the grid
    // has to exist. Contents don't matter here — this file is about the
    // resolver seam, not the markup (test-cast-order.mjs covers that).
    document: { getElementById: () => ({ children: [], set innerHTML(_) {}, get innerHTML() { return ''; } }) },
    saveState: () => {},
    escapeHtml: s => String(s == null ? '' : s),
    escapeJsAttr: s => String(s == null ? '' : s),
    renderAvatar: () => '',
  };
  ctx.getActiveCard = () =>
    ctx.state.characterCards.find(c => c.id === ctx.state.activeCardId) ||
    ctx.state.characterCards[0] || ctx.DEFAULT_CARD;
  ctx.getActivePersona = () =>
    ctx.state.personaCards.find(p => p.id === ctx.state.activePersonaId) ||
    ctx.state.personaCards[0] || { ...ctx.DEFAULT_PERSONA };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(orderBlock + '\n' + resolverBlock, ctx);
  return ctx;
}

console.log('\n=== reordering does not re-attribute existing messages ===');
{
  const ctx = build();
  const thread = { id: 't1', cardId: 'cb', cardName: 'CodeGoblin', messages: [
    { role: 'assistant', content: 'a', cardId: 'cb' },
    { role: 'assistant', content: 'b', cardId: 'cc' },
  ] };

  const before = [
    ctx.makeCastResolver(thread).cardFor(thread.messages[0]).name,
    ctx.makeCastResolver(thread).cardFor(thread.messages[1]).name,
  ];
  eq(before[0], 'CodeGoblin', 'baseline: turn 1 is CodeGoblin');
  eq(before[1], 'Archivist', 'baseline: turn 2 is Archivist');

  // Drag the roster into a completely different order.
  ctx.moveCard('cc', -1, null);
  ctx.moveCard('cc', -1, null);
  eq(ctx.state.characterCards.map(c => c.name).join(','), 'Archivist,Assistant,CodeGoblin', 'roster reordered');

  const after = [
    ctx.makeCastResolver(thread).cardFor(thread.messages[0]).name,
    ctx.makeCastResolver(thread).cardFor(thread.messages[1]).name,
  ];
  eq(after[0], 'CodeGoblin', 'turn 1 still CodeGoblin after the reorder');
  eq(after[1], 'Archivist', 'turn 2 still Archivist after the reorder');
}

console.log('\n=== the [0] seam: reordering DOES move the legacy fallback ===');
{
  // Documented consequence, not a bug. A legacy thread has no stamp and falls
  // through to getActiveCard(); if activeCardId dangles, that reads [0], which
  // item 9 made user-controlled. The user's top card is a better answer than
  // the oldest one — but it is a behaviour change and belongs in a test.
  const ctx = build();
  const legacy = { id: 't0', messages: [{ role: 'assistant', content: 'old' }] };
  ctx.state.activeCardId = 'deleted-id';   // dangling

  eq(ctx.makeCastResolver(legacy).cardFor(legacy.messages[0]).name, 'Assistant',
     'dangling active id: legacy thread falls to the top card');

  ctx.moveCard('cc', -1, null);
  ctx.moveCard('cc', -1, null);
  eq(ctx.makeCastResolver(legacy).cardFor(legacy.messages[0]).name, 'Archivist',
     'after reordering, the fallback follows the new top card');

  // A stamped thread is immune to all of it.
  const stamped = { id: 't1', cardId: 'cb', messages: [{ role: 'assistant', cardId: 'cb' }] };
  eq(ctx.makeCastResolver(stamped).cardFor(stamped.messages[0]).name, 'CodeGoblin',
     'a stamped thread ignores both the reorder and the dangling active id');
}

console.log('\n=== deleting a reordered card still hits the tombstone ===');
{
  const ctx = build();
  const thread = { id: 't1', cardId: 'cc', cardName: 'Archivist', messages: [{ role: 'assistant', cardId: 'cc' }] };
  ctx.moveCard('cc', -1, null);            // move it, then delete it
  ctx.state.characterCards = ctx.state.characterCards.filter(c => c.id !== 'cc');
  const r = ctx.makeCastResolver(thread);
  eq(r.cardFor(thread.messages[0]).name, 'Archivist', 'tombstone survives a reorder-then-delete');
  eq(r.cardFor(thread.messages[0]).avatar, '', 'and still renders neutrally');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
