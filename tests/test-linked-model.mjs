/**
 * Test suite for Issue #52: Linking Specific Model to Character or Chat Thread.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CONFIG_SRC = fs.readFileSync(ROOT + '/js/01-config.js', 'utf8');
const STATE_SRC = fs.readFileSync(ROOT + '/js/04-state.js', 'utf8');
const MODEL_SRC = fs.readFileSync(ROOT + '/js/02-model.js', 'utf8');
const THREADS_SRC = fs.readFileSync(ROOT + '/js/09-threads.js', 'utf8');
const CARDS_SRC = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const CARD_IO_SRC = fs.readFileSync(ROOT + '/js/16-card-io.js', 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};
const eq = (a, b, label) => ok(a === b, label + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

console.log('\n=== 1. Schema & Defaults ===');
{
  const sandbox = { console, window: {}, document: {} };
  vm.createContext(sandbox);
  vm.runInContext(STATE_SRC, sandbox);
  const defCard = vm.runInContext('DEFAULT_CARD', sandbox);
  eq(defCard.modelFile, '', 'DEFAULT_CARD has empty modelFile default');
}

console.log('\n=== 2. Thread creation & forking model inheritance ===');
{
  const swappedModels = [];
  const sandbox = {
    console,
    Date, Math, Array, Object, String, RegExp,
    window: { innerWidth: 1024 },
    document: {
      getElementById: () => ({ focus: () => {}, value: '', style: {} }),
      querySelector: () => null,
    },
    state: {
      threads: [],
      characterCards: [
        { id: 'c1', name: 'Coder', modelFile: 'coder-model.gguf' },
        { id: 'c2', name: 'General', modelFile: '' }
      ],
      personaCards: [{ id: 'p1', name: 'User' }],
      activeCardId: 'c1',
      activePersonaId: 'p1',
      activeThreadId: null,
      sidebarOpen: false
    },
    DEFAULT_CARD: { id: 'def', name: 'Def', modelFile: '' },
    DEFAULT_PERSONA: { id: 'pdef', name: 'PDef' },
    getActiveCard: () => sandbox.state.characterCards.find(c => c.id === sandbox.state.activeCardId),
    getActivePersona: () => sandbox.state.personaCards[0],
    injectGreeting: () => {},
    saveState: () => {},
    render: () => {},
    applyActiveCardBackground: () => {},
    scrollToBottom: () => {},
    switchModelToFile: (file, reason, onMissing) => { swappedModels.push(file); }
  };
  vm.createContext(sandbox);
  vm.runInContext(THREADS_SRC, sandbox);

  // Create thread with c1 (linked to coder-model.gguf)
  sandbox.createThread();
  const t1 = sandbox.state.threads[0];
  eq(t1.modelFile, 'coder-model.gguf', 'New thread inherits character modelFile');
  ok(swappedModels.includes('coder-model.gguf'), 'Creating thread triggers model check/swap');

  // Fork thread
  t1.messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }];
  sandbox.forkAt(1);
  const t2 = sandbox.state.threads[0];
  eq(t2.modelFile, 'coder-model.gguf', 'Forked thread preserves source modelFile');
}

console.log('\n=== 3. Thread switching & fallback to card model ===');
{
  let lastSwapped = null;
  const sandbox = {
    console,
    Date, Math, Array, Object, String, RegExp,
    window: { innerWidth: 1024 },
    document: {
      getElementById: () => ({ focus: () => {}, value: '', style: {} }),
      querySelector: () => null,
    },
    state: {
      threads: [
        { id: 't-explicit', name: 'Explicit', modelFile: 'special-model.gguf', cardId: 'c2' },
        { id: 't-inherited', name: 'Inherited', modelFile: '', cardId: 'c1' },
        { id: 't-none', name: 'None', modelFile: '', cardId: 'c2' }
      ],
      characterCards: [
        { id: 'c1', name: 'Coder', modelFile: 'coder-model.gguf' },
        { id: 'c2', name: 'General', modelFile: '' }
      ],
      activeThreadId: null,
      sidebarOpen: false
    },
    saveState: () => {},
    render: () => {},
    applyActiveCardBackground: () => {},
    scrollToBottom: () => {},
    switchModelToFile: (file) => { lastSwapped = file; }
  };
  vm.createContext(sandbox);
  vm.runInContext(THREADS_SRC, sandbox);

  // Switch to thread with explicit model
  sandbox.switchThread('t-explicit');
  eq(lastSwapped, 'special-model.gguf', 'switchThread uses thread.modelFile when present');

  // Switch to thread without explicit model, but whose character has one
  lastSwapped = null;
  sandbox.switchThread('t-inherited');
  eq(lastSwapped, 'coder-model.gguf', 'switchThread falls back to card.modelFile');

  // Switch to thread with no model at all
  lastSwapped = null;
  sandbox.switchThread('t-none');
  eq(lastSwapped, null, 'switchThread does not swap when no model linked');
}

console.log('\n=== 4. Character activation auto-swap ===');
{
  let lastSwapped = null;
  const sandbox = {
    console,
    Date, Math, Array, Object, String, RegExp,
    document: { getElementById: () => ({ innerHTML: '', style: {} }) },
    state: {
      characterCards: [
        { id: 'c1', name: 'Coder', modelFile: 'coder-model.gguf' },
        { id: 'c2', name: 'General', modelFile: '' }
      ],
      activeCardId: 'c2'
    },
    saveState: () => {},
    renderCardGrid: () => {},
    renderMessages: () => {},
    renderAvatar: () => '',
    escapeHtml: (s) => s || '',
    escapeJsAttr: (s) => s || '',
    applyActiveCardBackground: () => {},
    applyCardCode: () => {},
    switchModelToFile: (file) => { lastSwapped = file; }
  };
  vm.createContext(sandbox);
  vm.runInContext(CARDS_SRC, sandbox);

  sandbox.activateCard('c1');
  eq(sandbox.state.activeCardId, 'c1', 'activeCardId updated');
  eq(lastSwapped, 'coder-model.gguf', 'activateCard auto-swaps to linked model');

  lastSwapped = null;
  sandbox.activateCard('c2');
  eq(lastSwapped, null, 'activateCard with empty modelFile does not swap');
}

console.log('\n=== 5. Missing model unlinking ===');
{
  let warned = false;
  let cleared = false;
  const sandbox = {
    console: { warn: () => { warned = true; }, log: () => {} },
    Date, Math, Array, Object, String, RegExp,
    window: { location: { protocol: 'http:' } },
    document: {
      getElementById: (id) => {
        if (id === 'header-model-select') {
          return {
            options: [
              { value: 'available1.gguf' },
              { value: 'available2.gguf' }
            ]
          };
        }
        return null;
      }
    },
    _currentModelFile: 'available1.gguf',
    showModelSwitchToast: () => {},
    IS_SERVED: true
  };
  vm.createContext(sandbox);
  vm.runInContext(CONFIG_SRC, sandbox);
  vm.runInContext(MODEL_SRC, sandbox);

  // Attempt to switch to deleted model
  sandbox.switchModelToFile('deleted-model.gguf', 'test', () => { cleared = true; });
  ok(warned, 'Warns on missing model');
  ok(cleared, 'onMissing callback called to clear stale link');
}

console.log('\n=== 6. Manual model switch links to active thread ===');
{
  const sandbox = {
    console: { log: () => {}, warn: () => {} },
    Date, Math, Array, Object, String, RegExp, setTimeout, clearTimeout, Promise,
    window: { location: { protocol: 'http:' } },
    document: {
      getElementById: (id) => null
    },
    state: {
      threads: [{ id: 't1', modelFile: '' }],
      activeThreadId: 't1'
    },
    _currentModelFile: 'old.gguf',
    _selectedRemoteModel: null,
    IS_SERVED: true,
    _swapInFlight: false,
    saveState: () => {},
    loadActiveModel: async () => {},
    showModelSwitchToast: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ phase: 'ready' }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(CONFIG_SRC, sandbox);
  vm.runInContext(MODEL_SRC, sandbox);

  const sel = {
    selectedIndex: 0,
    options: [{ value: 'new-model.gguf', textContent: 'New Model', dataset: {} }],
    value: 'new-model.gguf'
  };

  const onHeaderModelChange = vm.runInContext('onHeaderModelChange', sandbox);
  await onHeaderModelChange(sel);
  eq(sandbox.state.threads[0].modelFile, 'new-model.gguf', 'Active thread modelFile updated on manual header switch');
}

console.log('\n=== 7. Card V3 Export / Import round-trips modelFile ===');
{
  const sandbox = {
    console,
    Date, Math, Array, Object, String, RegExp,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder, TextDecoder,
    state: { characterCards: [] },
    DEFAULT_CARD: { modelFile: '' },
    generateId: () => 'id123',
    applyImportedCardCode: () => {},
    FALLBACK_CARD_TEXT_COLOR: '#ffffff',
    FALLBACK_CARD_DIALOG_COLOR: '#00ffff'
  };
  vm.createContext(sandbox);
  vm.runInContext(CARD_IO_SRC, sandbox);

  const _cardToV3 = vm.runInContext('_cardToV3', sandbox);
  const _cardDataToInternal = vm.runInContext('_cardDataToInternal', sandbox);

  const originalCard = {
    name: 'Custom',
    writingStyle: 'Write well.',
    personality: 'Friendly',
    modelFile: 'special-v3.gguf'
  };

  const v3 = _cardToV3(originalCard);
  eq(v3.data.extensions.gobbonet.modelFile, 'special-v3.gguf', 'Exported V3 extensions contain modelFile');

  const parsed = _cardDataToInternal(v3.data, '3.0');
  eq(parsed.modelFile, 'special-v3.gguf', 'Imported V3 card restores modelFile');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
