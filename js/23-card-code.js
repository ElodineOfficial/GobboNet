/* @gobbonet-split js/23-card-code.js
   Hand-written module -- NOT produced by refactor-split.py.
   Per-character custom code: a small hook API scoped to one card.
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CARD CODE — per-character scripting

   The extensions system (19-extensions.js) injects <script> tags that
   live for the whole session and affect everything. This is the
   opposite: a small piece of JavaScript attached to ONE character
   card, which runs when that card is active and is torn down the
   moment you switch away.

   The code is evaluated once per activation as the body of a function
   that receives a single argument. It registers hooks and returns:

       gobbo.on('send',  ctx => ctx.text.toUpperCase());
       gobbo.on('reply', ctx => ctx.text.replace(/\bthee\b/g, 'you'));
       gobbo.on('activate', () => gobbo.notify('Ready.'));

   WHY IT IS NOT SANDBOXED
   The code runs with the same access as the page, because there is no
   honest way to sandbox it and pretending otherwise would be worse
   than saying so plainly. It is your machine, your card, your code.
   What matters instead is that it cannot *break* anything: every hook
   call is wrapped, a throwing hook is disabled rather than retried,
   and a card whose code fails still chats normally.

   IMPORTED CARDS NEVER AUTO-RUN. A card downloaded from anywhere else
   arrives with its code present but disabled, every time, no matter
   what the file says. You opt in by opening the editor and ticking the
   box yourself. See applyImportedCardCode() at the bottom.
================================================================ */

/* Live hook registry for the currently active card. Rebuilt on every
   activation, discarded on every switch — nothing survives a card
   change, which is what keeps one card's logic out of another's. */
let _cardHooks = null;
let _cardCodeCardId = null;
let _cardCodeError = null;

/* Only names that are genuinely invoked belong here. 'context' used to be
   listed and never fired anywhere -- on() accepted it without complaint, so
   a script registering for it looked correct and did nothing. An API that
   advertises a hook it does not call is worse than one that lacks it: the
   failure is silent and reads as your bug. It is wired up now. */
const CARD_HOOK_NAMES = ['activate', 'deactivate', 'send', 'reply', 'context'];

/** Per-card persistent scratch space, keyed by card id. Survives reloads
 *  because it rides along in state; cleared when the card is deleted. */
function _cardStore(cardId) {
  if (!state._cardCodeStore) state._cardCodeStore = {};
  if (!state._cardCodeStore[cardId]) state._cardCodeStore[cardId] = {};
  return state._cardCodeStore[cardId];
}

/**
 * Tear down the active card's code. Calls its 'deactivate' hook (once,
 * guarded) and drops every registered handler.
 */
function teardownCardCode() {
  if (_cardHooks) {
    runCardHook('deactivate', {});
  }
  _cardHooks = null;
  _cardCodeCardId = null;
  _cardCodeError = null;
  updateCardCodeStatus();
}

/**
 * Evaluate the active card's code and register its hooks.
 * Safe to call repeatedly — it always tears down first.
 */
function applyCardCode() {
  teardownCardCode();

  const card = (typeof getActiveCard === 'function') ? getActiveCard() : null;
  if (!card || !card.customCodeEnabled) { updateCardCodeStatus(); return; }

  const src = (card.customCode || '').trim();
  if (!src) { updateCardCodeStatus(); return; }

  const hooks = {};
  const api = {
    card: card,
    on(name, fn) {
      if (!CARD_HOOK_NAMES.includes(name)) {
        console.warn('[card-code] unknown hook:', name,
                     '- expected one of', CARD_HOOK_NAMES.join(', '));
        return;
      }
      if (typeof fn !== 'function') {
        console.warn('[card-code] hook "' + name + '" needs a function');
        return;
      }
      (hooks[name] = hooks[name] || []).push(fn);
    },
    store: _cardStore(card.id),
    save() { try { saveState(); } catch (e) {} },

    /* The active thread, for reading. Card code that wants to count turns
       or look at what was said needs this; without it every non-trivial
       script has to reach past the API into globals and guess at internals. */
    get thread() {
      try { return getActiveThread(); } catch (e) { return null; }
    },

    /* Run fn once every n replies. This was the single most obvious thing
       to want and it took a counter in store plus a modulo every time, so
       it lives here instead. */
    every(n, fn) {
      if (typeof n !== 'number' || n < 1 || typeof fn !== 'function') {
        console.warn('[card-code] every(n, fn) wants a positive number and a function');
        return;
      }
      api.on('reply', (ctx) => {
        const st = _cardStore(card.id);
        st._everyCount = (st._everyCount || 0) + 1;
        if (st._everyCount % n === 0) { try { fn(ctx); } catch (e) { throw e; } }
      });
    },

    /* Ask the same local model the chat is using, and get the text back.
       Card code could not previously do this at all, which is why any
       script that wanted the model to summarise, track or classify
       something was impossible to write -- the obvious guesses
       (gobbo.generate, gobbo.complete) simply did not exist.

       Includes the reasoning-recovery fix from summarizeForLore: when
       llama-server splits reasoning_content, the whole reply can land in
       the reasoning bucket with content empty. Anything calling a model
       from this app has to handle that or it silently gets nothing. */
    async ask(prompt, opts) {
      opts = opts || {};
      const msgs = [];
      if (opts.system) msgs.push({ role: 'system', content: String(opts.system) });
      msgs.push({ role: 'user', content: String(prompt == null ? '' : prompt) });
      try {
        const resp = await privacyFetch(LLAMA_URL + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'local',
            messages: msgs,
            stream: false,
            max_tokens: opts.maxTokens || 600,
            temperature: (typeof opts.temperature === 'number') ? opts.temperature : 0.4
          })
        });
        if (!resp.ok) {
          console.error('[card-code] ask() failed: HTTP ' + resp.status);
          return '';
        }
        const data = await resp.json();
        const m = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
        let out = (m.content || '').trim();
        if (!out && m.reasoning_content) out = String(m.reasoning_content).trim();
        return out;
      } catch (e) {
        console.error('[card-code] ask() threw:', e);
        return '';
      }
    },

    /* Drop a collapsed note into the transcript.

       It is stored on the thread so it survives a reload, and marked
       .archived so the model never sees it -- the same flag the rolling
       archive uses. That combination is what "hidden message behind a
       spoiler box, like the lore" actually requires, and there was no way
       to express it before. */
    note(text, opts) {
      opts = opts || {};
      const t = api.thread;
      if (!t || !Array.isArray(t.messages)) return null;
      const msg = {
        role: 'system',
        content: String(text == null ? '' : text),
        timestamp: Date.now(),
        archived: true,          // kept in the UI, never sent to the model
        cardNote: true,
        cardNoteLabel: String(opts.label || (card.name + ' note')),
        cardNoteOpen: !!opts.open
      };
      t.messages.push(msg);
      try { saveState(); } catch (e) {}
      try { render(); } catch (e) {}
      return msg;
    },
    log(...args) { console.log('[card:' + card.name + ']', ...args); },
    notify(msg) {
      try {
        if (typeof showModelSwitchToast === 'function') showModelSwitchToast(String(msg));
        else console.log('[card:' + card.name + ']', msg);
      } catch (e) { console.log('[card:' + card.name + ']', msg); }
    },
  };

  try {
    // Function() rather than eval so the code cannot reach this scope's
    // locals and accidentally clobber the registry it is registering into.
    const fn = new Function('gobbo', '"use strict";\n' + src);
    fn(api);
    _cardHooks = hooks;
    _cardCodeCardId = card.id;
    _cardCodeError = null;
    const n = Object.keys(hooks).reduce((a, k) => a + hooks[k].length, 0);
    console.log('[card-code] "' + card.name + '" loaded, ' + n + ' hook(s):',
                liveCardHooks().join(', ') || 'none');
    runCardHook('activate', { card });
  } catch (err) {
    _cardHooks = null;
    _cardCodeError = String(err && err.message ? err.message : err);
    console.error('[card-code] "' + card.name + '" failed to load:', err);
  }
  updateCardCodeStatus();
}

/**
 * Invoke every handler registered for a hook.
 *
 * Returns the last non-undefined return value, so a 'send' or 'reply'
 * handler can rewrite the text by returning a string. A handler that
 * throws is REMOVED rather than left to throw on every turn — one bad
 * line should cost you that hook, not the conversation.
 */
function runCardHook(name, ctx) {
  if (!_cardHooks || !_cardHooks[name]) return undefined;
  let result;
  const list = _cardHooks[name];
  for (let i = 0; i < list.length; i++) {
    try {
      const r = list[i](ctx);
      if (r !== undefined) result = r;
    } catch (err) {
      console.error('[card-code] hook "' + name + '" threw, disabling it:', err);
      _cardCodeError = name + ': ' + (err && err.message ? err.message : err);
      list.splice(i, 1);
      i--;
      updateCardCodeStatus();
    }
  }
  return result;
}

/** Names of hooks that still have at least one live handler. A hook whose
 *  only handler threw gets emptied rather than deleted, so counting keys
 *  alone would keep reporting it as active after it stopped working. */
function liveCardHooks() {
  if (!_cardHooks) return [];
  return Object.keys(_cardHooks).filter(k => _cardHooks[k] && _cardHooks[k].length);
}

/** True when the active card has at least one working hook loaded. */
function cardCodeActive() {
  return liveCardHooks().length > 0;
}

/**
 * Text transform helper for the 'send' and 'reply' hooks. Returns the
 * original text unless a handler returned a string, and refuses a
 * non-string return rather than letting it poison the thread.
 */
function transformViaCardHook(name, text, extra) {
  if (!_cardHooks || !_cardHooks[name]) return text;
  const out = runCardHook(name, Object.assign({ text: text }, extra || {}));
  if (out === undefined || out === null) return text;
  if (typeof out !== 'string') {
    console.warn('[card-code] hook "' + name + '" returned ' + typeof out +
                 ', expected a string - ignoring it');
    return text;
  }
  return out;
}

/** Status line under the code box in the card editor. */
function updateCardCodeStatus() {
  const el = document.getElementById('card-code-status');
  if (!el) return;
  if (_cardCodeError) {
    el.textContent = 'error: ' + _cardCodeError;
    el.style.color = 'var(--red, #ff6b6b)';
  } else if (cardCodeActive()) {
    el.textContent = 'active - hooks: ' + liveCardHooks().join(', ');
    el.style.color = 'var(--green-neon, #00ff73)';
  } else {
    el.textContent = '';
  }
}

/**
 * Strip the "and run it" bit out of a whole state blob that did not originate
 * on this device.
 *
 * applyImportedCardCode below covers the character-card file import. It was the
 * only door with a lock on it. Others reach the same executors:
 *
 *   - restoreFromServer() in 06-state-sync.js writes the /state blob straight
 *     into storage and reloads. /state is password-gated, but it is one shared
 *     document every paired device can overwrite, so a compromised phone (or
 *     anyone who learned the password) could hand every other device a card
 *     with customCodeEnabled already true, or an extensions list, and boot
 *     would run it. The restore that fires when local storage is empty does
 *     not even prompt.
 *   - importData('all') in 21-data.js takes a backup file from anywhere and
 *     calls applyExtensions() in the same tick.
 *   - importData('cards') in 21-data.js merges a characterCards array from an
 *     arbitrary JSON file straight into state.
 *
 * The rule is the one applyImportedCardCode already documents: the decision to
 * run code is made by the person at the keyboard, on this device, and cannot
 * be carried in a transferred blob. Code text is preserved so it can be read
 * and opted into; only the enable flags are cleared. Restores are rare (a new
 * device, a cleared cache, a quota recovery) rather than part of the routine
 * push, so the cost is re-ticking a box once per device.
 *
 * Returns a summary so the caller can tell the user what was switched off
 * instead of doing it silently.
 */
function neutralizeUntrustedCode(blob) {
  const result = { cards: 0, extensions: false };
  if (!blob || typeof blob !== 'object') return result;

  if (Array.isArray(blob.characterCards)) {
    for (const card of blob.characterCards) {
      if (!card || typeof card !== 'object') continue;
      if (card.customCodeEnabled) result.cards++;
      card.customCodeEnabled = false;
    }
  }

  const ext = blob.extensions;
  if (ext && typeof ext === 'object' && ext.enabled) {
    ext.enabled = false;
    result.extensions = true;
  }

  if (result.cards || result.extensions) {
    console.warn('[card-code] Incoming state carried code set to run: ' +
                 result.cards + ' card(s)' +
                 (result.extensions ? ' and the extensions list' : '') +
                 '. Kept, but switched OFF. Review it and enable it here if you want it.');
  }
  return result;
}

/**
 * Strip code off a card that arrived from somewhere else.
 *
 * Called by the import path. The user's own "is this enabled" decision
 * cannot be carried in a file, because then any card you download runs
 * its author's JavaScript the moment you activate it. The code is kept
 * so it can be read and opted into; the flag is always cleared.
 */
function applyImportedCardCode(card, rawCode) {
  if (typeof rawCode === 'string' && rawCode.trim()) {
    card.customCode = rawCode;
    card.customCodeEnabled = false;
    console.warn('[card-code] imported card "' + (card.name || '?') +
                 '" carries custom code. It is DISABLED until you read it ' +
                 'and switch it on in the character editor.');
  } else {
    card.customCode = '';
    card.customCodeEnabled = false;
  }
  return card;
}
