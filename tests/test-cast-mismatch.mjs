/* Issue #19, second half — the strip that says who is about to answer.
 *
 * makeCastResolver() gave every past message back the character that wrote it.
 * It could not fix the other direction: switchThread() deliberately leaves
 * activeCardId alone, so a thread full of CodeGoblin will answer as Assistant
 * and the first sign of it is the reply.
 *
 * updateCastMismatch() is the notice. These cases pin when it speaks and, more
 * importantly, when it stays quiet — a strip that cries wolf on every old
 * conversation would be worse than no strip.
 *
 *   node tests/test-cast-mismatch.mjs
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const DASH = fs.readFileSync(ROOT + '/js/13-dashboard.js', 'utf8');
const THREADS = fs.readFileSync(ROOT + '/js/09-threads.js', 'utf8');
const RENDER = fs.readFileSync(ROOT + '/js/12-render.js', 'utf8');
const CHAT_HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const CSS = fs.readFileSync(ROOT + '/css/04-chat.css', 'utf8');

const mismatchFn = DASH.slice(
  DASH.indexOf('function updateCastMismatch()'),
  DASH.indexOf('function updateContextInfo()')
);
const resolverFn = THREADS.slice(
  THREADS.indexOf('function makeCastResolver('),
  THREADS.indexOf('function createThread(')
);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};

const CARD_A = { id: 'ca', name: 'Assistant', avatar: 'A.png' };
const CARD_B = { id: 'cb', name: 'CodeGoblin', avatar: 'B.png' };

// The strip element, recorded rather than rendered.
function makeEl() {
  return { style: { display: 'none' }, innerHTML: '' };
}

function run({ thread, activeCardId = 'ca', cards = [CARD_A, CARD_B] }) {
  const el = makeEl();
  // Closures rather than methods: these are called as bare functions inside the
  // VM, where `this` is undefined.
  const state = {
    characterCards: cards.map(c => ({ ...c })),
    personaCards: [],
    activeCardId,
    activePersonaId: null,
    threads: thread ? [thread] : [],
    activeThreadId: thread ? thread.id : null,
  };
  const DEFAULT_CARD = { id: 'default', name: 'Assistant', avatar: '' };
  const DEFAULT_PERSONA = { id: 'default-persona', name: 'Anonymous', avatar: '' };
  const ctx = {
    console,
    state,
    DEFAULT_CARD,
    DEFAULT_PERSONA,
    document: { getElementById: id => (id === 'cast-mismatch' ? el : null) },
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeJsAttr: s => String(s).replace(/'/g, "\\'"),
    getActiveThread: () => state.threads.find(t => t.id === state.activeThreadId) || null,
    getActiveCard: () => state.characterCards.find(c => c.id === state.activeCardId) || DEFAULT_CARD,
    getActivePersona: () => DEFAULT_PERSONA,
  };
  vm.createContext(ctx);
  vm.runInContext(resolverFn + '\n' + mismatchFn + '\nupdateCastMismatch();', ctx);
  return el;
}

const shown = el => el.style.display !== 'none';

console.log('\n=== A. it speaks when the next reply would change hands ===');
{
  const el = run({
    thread: {
      id: 't1', cardId: 'cb',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo', cardId: 'cb' }],
    },
    activeCardId: 'ca',
  });
  ok(shown(el), 'strip is shown');
  ok(/Replying as <strong>Assistant<\/strong>/.test(el.innerHTML), 'names who will answer');
  ok(/last answered by <strong>CodeGoblin<\/strong>/.test(el.innerHTML), 'names who answered before');
  ok(/activateCard\('cb'\)/.test(el.innerHTML), 'offers a switch back to that card');
}

console.log('\n=== B. it stays quiet in every ordinary case ===');
{
  ok(!shown(run({
    thread: { id: 't', cardId: 'ca', messages: [{ role: 'assistant', content: 'a', cardId: 'ca' }] },
    activeCardId: 'ca',
  })), 'same card as last time — silent');

  ok(!shown(run({ thread: null })), 'no thread open — silent');

  ok(!shown(run({ thread: { id: 't', cardId: 'cb', messages: [] }, activeCardId: 'ca' })),
    'empty thread — silent, nothing has answered yet');

  ok(!shown(run({
    thread: { id: 't', cardId: 'cb', messages: [{ role: 'user', content: 'hi' }] },
    activeCardId: 'ca',
  })), 'user turns only — silent, no previous speaker to differ from');

  // A legacy thread predates stamping entirely. We do not know who wrote it,
  // and guessing would put this strip on every old conversation in the app.
  ok(!shown(run({
    thread: { id: 't', messages: [{ role: 'assistant', content: 'a' }] },
    activeCardId: 'ca',
  })), 'unstamped legacy thread — silent rather than guessing');
}

console.log('\n=== C. it measures against the last speaker, not the thread owner ===');
{
  // Started as CodeGoblin, handed over to Assistant ten turns ago, still
  // Assistant. Nagging here would be nagging about a decision already made.
  const el = run({
    thread: {
      id: 't', cardId: 'cb',
      messages: [
        { role: 'assistant', content: 'old', cardId: 'cb' },
        { role: 'user', content: 'switch please' },
        { role: 'assistant', content: 'new', cardId: 'ca' },
      ],
    },
    activeCardId: 'ca',
  });
  ok(!shown(el), 'thread that already changed hands and stayed — silent');

  // The reverse: back to CodeGoblin while the thread is nominally CodeGoblin's,
  // but Assistant spoke last. The next reply still changes hands.
  const el2 = run({
    thread: {
      id: 't', cardId: 'cb',
      messages: [
        { role: 'assistant', content: 'old', cardId: 'cb' },
        { role: 'assistant', content: 'new', cardId: 'ca' },
      ],
    },
    activeCardId: 'cb',
  });
  ok(shown(el2), 'switching back after someone else spoke — shown');
  ok(/last answered by <strong>Assistant<\/strong>/.test(el2.innerHTML), 'and names the actual last speaker');
}

console.log('\n=== D. a deleted character is named but not offered ===');
{
  const el = run({
    thread: {
      id: 't', cardId: 'cb', cardName: 'CodeGoblin',
      messages: [{ role: 'assistant', content: 'yo', cardId: 'cb' }],
    },
    activeCardId: 'ca',
    cards: [CARD_A],          // CodeGoblin has been deleted
  });
  ok(shown(el), 'still shown — the history is still not the active card');
  ok(/CodeGoblin/.test(el.innerHTML), 'tombstone name is used');
  ok(!/activateCard\(/.test(el.innerHTML), 'no switch button for a card that no longer exists');
}

console.log('\n=== E. names are escaped ===');
{
  const el = run({
    thread: { id: 't', cardId: 'cb', messages: [{ role: 'assistant', content: 'x', cardId: 'cb' }] },
    activeCardId: 'ca',
    cards: [{ id: 'ca', name: '<img src=x onerror="alert(1)">' }, CARD_B],
  });
  ok(!/<img/.test(el.innerHTML), 'markup in a character name does not survive into the strip');
  ok(/&lt;img/.test(el.innerHTML), 'it is escaped rather than dropped');
}

console.log('\n=== F. it is wired in ===');
{
  ok(/id="cast-mismatch"/.test(CHAT_HTML), 'chat.html has the slot');
  ok(/updateCastMismatch\(\);/.test(RENDER), 'render() calls it');
  ok(/castStrip && !hasThread/.test(DASH), 'updateInputState hides it with the composer, and only hides');
  ok(/\.cast-mismatch\s*\{/.test(CSS), 'the strip is styled');
  ok(/\.cast-mismatch-btn:hover/.test(CSS), 'the button has a hover state');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
