/* @gobbonet-split js/21-data.js
   Moved verbatim from chat.html lines 11703-11915.
   export / import / purge
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   DATA MANAGEMENT — Export / Import / Purge
   Threads and character cards can be exported individually or as
   part of a full backup. Import merges threads/cards by ID so
   existing data is preserved. Full backup replaces everything.
================================================================ */

/* ================================================================
   SERVER PRESETS — the [ui] table from gobbonet.toml

   The config file has always been the server's: URLs, ports, paths, GPU
   layers. The things people actually change day to day live in CONFIG, in the
   browser, and had no file representation at all — so setting a machine up for
   someone meant walking them through the panel on every device they own.

   [ui] is that missing half. It seeds browser settings from the config file.

   ── SEED, NOT LOCK ──────────────────────────────────────────────
   This is the decision everything else follows from.

   An override would mean the file wins on every boot, and a setting changed in
   CONFIG would silently revert on reload — a UI that argues with the user is
   worse than no file. Writing the panel's changes BACK to the file has the
   mirror problem: a phone would be rewriting a file on the server, and two
   devices with different preferences would fight over it.

   So the file answers a narrower question, and answers it honestly: what does
   a device start with before anyone has chosen. A device with no settings of
   its own takes the presets. A device that has its own keeps them, and is
   offered the presets with the differences shown. Nothing is overwritten
   without being asked, and the file never claims to describe a state it is not
   maintaining.

   ── WHY VALIDATION IS HERE AND NOT IN GO ────────────────────────
   DEFAULT_SETTINGS in js/04-state.js is the definition of what a setting is.
   Checking against it means a setting added tomorrow is presettable the day it
   lands, with nothing to update — and that a typo or a wrong type is caught by
   the only thing that actually knows. The Go side carries the table without
   interpreting it, so neither side has to track what the other added.
================================================================ */

// The [ui] table exactly as the server sent it, before validation, so the UI
// can show what was rejected as well as what was taken.
let serverPresets = { raw: {}, valid: {}, unknown: [], mistyped: [], loaded: false };

/** toml_case and camelCase both accepted.
 *
 *  A config file written in snake_case is what anyone editing TOML will
 *  produce, and the frontend's keys are camelCase. Rejecting `stream_replies`
 *  because the JS calls it `streamReplies` would be technically correct and
 *  uselessly pedantic — the user would have no way to know which spelling this
 *  one wanted. */
function _presetKeyToSetting(key) {
  const k = String(key || '').trim();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) return k;
  const camel = k.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, camel)) return camel;
  return null;
}

/** Sort the server's table into what can be used and what cannot.
 *
 *  A rejected key is reported rather than dropped. An ignored typo in a config
 *  file is the kind of thing that costs someone an evening. */
function validateServerPresets(raw) {
  const valid = {}, unknown = [], mistyped = [];
  for (const key of Object.keys(raw || {})) {
    const setting = _presetKeyToSetting(key);
    if (!setting) { unknown.push(key); continue; }
    const value = raw[key];
    const want = typeof DEFAULT_SETTINGS[setting];
    let got = typeof value;
    // TOML has one number type and JSON does not distinguish int from float,
    // so a whole number arriving for a numeric setting is not a type error.
    if (want === 'number' && got === 'number') got = 'number';
    if (got !== want) {
      mistyped.push({ key, expected: want, got: Array.isArray(value) ? 'array' : got });
      continue;
    }
    valid[setting] = value;
  }
  return { raw: raw || {}, valid, unknown, mistyped, loaded: true };
}

/** Fetch the [ui] table. Never throws: a server too old to have the route, or
 *  a page opened from file://, simply has no presets. */
async function loadServerPresets() {
  if (!IS_SERVED) { serverPresets.loaded = true; return serverPresets; }
  try {
    const resp = await fetch(window.location.origin + '/ui-defaults.json', { cache: 'no-store' });
    if (!resp.ok) { serverPresets.loaded = true; return serverPresets; }
    const data = await resp.json();
    serverPresets = validateServerPresets(data && data.ui);
  } catch (e) {
    serverPresets.loaded = true;
  }
  if (serverPresets.unknown.length || serverPresets.mistyped.length) {
    console.warn('[presets] ignored entries in the [ui] section of gobbonet.toml:',
      { unknown: serverPresets.unknown, mistyped: serverPresets.mistyped });
  }
  return serverPresets;
}

/** Which presets this device is not currently following. */
function serverPresetDiff() {
  const out = [];
  for (const key of Object.keys(serverPresets.valid)) {
    const mine = state.settings ? state.settings[key] : undefined;
    if (mine !== serverPresets.valid[key]) {
      out.push({ key, preset: serverPresets.valid[key], mine });
    }
  }
  return out;
}

/** Take the presets on a device that has never chosen for itself.
 *
 *  `hadOwnSettings` comes from the loader: true when a saved blob was found
 *  with settings in it. A device that has been used before is left alone and
 *  offered the presets instead — see applyServerPresets. */
function seedSettingsFromServerPresets(hadOwnSettings) {
  if (hadOwnSettings) return 0;
  const keys = Object.keys(serverPresets.valid);
  if (!keys.length) return 0;
  for (const key of keys) state.settings[key] = serverPresets.valid[key];
  console.log('[presets] first run on this device — took ' + keys.length +
              ' setting(s) from the server config.');
  return keys.length;
}

/** Apply the presets on request, from the DATA panel. */
function applyServerPresets() {
  const diff = serverPresetDiff();
  if (!diff.length) return 0;
  for (const d of diff) state.settings[d.key] = d.preset;
  saveState();
  // Two settings have live effects that a re-render alone will not pick up.
  if (typeof scrollPinnedToBottom !== 'undefined' && autoScrollMode() === 'always') {
    scrollPinnedToBottom = true;
  }
  try { render(); } catch (e) {}
  try { updateFollowButton(); } catch (e) {}
  return diff.length;
}

/** Every key that can go in [ui], with the value this device has right now.
 *
 *  Generated from DEFAULT_SETTINGS rather than written down anywhere, so it is
 *  a list that cannot go stale: a setting added next release appears here the
 *  day it lands. This is what the config file's comment points at instead of
 *  listing keys itself. */
function serverPresetKeyReference() {
  return Object.keys(DEFAULT_SETTINGS).sort().map(key => ({
    key,
    toml: key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()),
    type: typeof DEFAULT_SETTINGS[key],
    shipped: DEFAULT_SETTINGS[key],
    mine: state.settings ? state.settings[key] : undefined,
    preset: Object.prototype.hasOwnProperty.call(serverPresets.valid, key)
      ? serverPresets.valid[key] : undefined,
  }));
}

/** Trigger a JSON file download. */
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportData(type) {
  const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (type === 'threads') {
    downloadJSON({ gobbonet_export: 'threads', version: 1, exported: Date.now(), threads: state.threads },
      `gobbonet-threads-${ts}.json`);
  } else if (type === 'cards') {
    downloadJSON({ gobbonet_export: 'cards', version: 1, exported: Date.now(), characterCards: state.characterCards },
      `gobbonet-characters-${ts}.json`);
  } else if (type === 'personas') {
    downloadJSON({ gobbonet_export: 'personas', version: 1, exported: Date.now(), personaCards: state.personaCards },
      `gobbonet-personas-${ts}.json`);
  } else if (type === 'all') {
    // Full state snapshot — strip nothing, keep it complete
    downloadJSON({
      gobbonet_export: 'full',
      version: 1,
      exported: Date.now(),
      threads: state.threads,
      activeThreadId: state.activeThreadId,
      settings: state.settings,
      characterCards: state.characterCards,
      activeCardId: state.activeCardId,
      personaCards: state.personaCards,
      activePersonaId: state.activePersonaId,
      schedules: state.schedules,
      folders: state.folders,
      extensions: state.extensions,
      searchEnabled: state.searchEnabled,
      macros: state.macros
    }, `gobbonet-backup-${ts}.json`);
  }
}

/* ================================================================
   SINGLE-ITEM EXPORT

   The bulk buttons above are all-or-nothing, which is the wrong shape for the
   two things people actually want to move around: one conversation, and one
   character.

   Both write the SAME envelope the bulk exports write, with one element in the
   array. That is not laziness -- it means the existing Threads / Characters
   import buttons read them with no special case, and a file exported from one
   build imports into another without a version negotiation. Import already
   merges by id and skips what it has, so a single-item file is just a smaller
   merge.
================================================================ */

/** A filesystem-safe stem from a user-chosen name. */
function _exportSlug(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/** Every character and persona id a thread actually refers to.
 *
 *  Not just thread.cardId. Since the cast work, each message can carry its own
 *  cardId/personaId, which is what lets a thread that changed hands halfway
 *  through still show the right name and avatar against each turn. A thread
 *  exported without those cards would import somewhere else and render every
 *  one of those turns as whoever happened to be active -- the precise
 *  confusion makeCastResolver() exists to prevent, reintroduced by the export
 *  format. */
function _threadCastIds(thread) {
  const cardIds = new Set();
  const personaIds = new Set();
  if (!thread) return { cardIds, personaIds };
  if (thread.cardId) cardIds.add(thread.cardId);
  if (thread.personaId) personaIds.add(thread.personaId);
  for (const m of (thread.messages || [])) {
    if (m && m.cardId) cardIds.add(m.cardId);
    if (m && m.personaId) personaIds.add(m.personaId);
  }
  return { cardIds, personaIds };
}

/** Export one conversation, with the characters it was actually held with.
 *
 *  Bundling is what makes the file useful rather than merely valid. On import
 *  the cards are merged by id like any other, so a recipient who already has
 *  the character keeps their own copy and nothing is overwritten. */
function exportThread(id, event) {
  if (event) event.stopPropagation();
  const thread = state.threads.find(t => t.id === id);
  if (!thread) return;

  const { cardIds, personaIds } = _threadCastIds(thread);
  const cards = (state.characterCards || []).filter(c => cardIds.has(c.id));
  const personas = (state.personaCards || []).filter(p => personaIds.has(p.id));

  const stem = _exportSlug(thread.name) || 'thread';
  downloadJSON({
    gobbonet_export: 'threads',
    version: 1,
    exported: Date.now(),
    threads: [thread],
    characterCards: cards,
    personaCards: personas
  }, `gobbonet-thread-${stem}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Export one character in GobboNet's own format.
 *
 *  Distinct from EXPORT V3 / FOR SHARING in the editor, and both are worth
 *  having. Those write a Character Card V3, which every other frontend reads
 *  and which flattens several fields on the way out -- system prompt, scenario
 *  and example messages all land in `description`, because that is what the
 *  spec has room for. This writes the card as it actually is, so a round trip
 *  through it changes nothing: card code, lore, storybook, sampler overrides
 *  and all. Portable versus lossless, and the tooltips say which is which. */
function exportCharacter(id, event) {
  if (event) event.stopPropagation();
  const card = (state.characterCards || []).find(c => c.id === id);
  if (!card) return;
  const stem = _exportSlug(card.name) || 'character';
  downloadJSON({
    gobbonet_export: 'cards',
    version: 1,
    exported: Date.now(),
    characterCards: [card]
  }, `gobbonet-character-${stem}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Merge any characters/personas bundled alongside a thread export.
 *  Returns a short sentence for the status line, or '' if there was nothing.
 *
 *  Same neutralisation rule as the character import and the full restore: a
 *  card out of a file someone sent you does not get to arrive pre-armed with
 *  its custom code switched on. */
function _mergeBundledCast(data) {
  const parts = [];

  if (Array.isArray(data.characterCards) && data.characterCards.length) {
    const have = new Set(state.characterCards.map(c => c.id));
    const add = data.characterCards.filter(c => c && !have.has(c.id));
    if (add.length) {
      const neutralized = (typeof neutralizeUntrustedCode === 'function')
        ? neutralizeUntrustedCode({ characterCards: add })
        : { cards: 0 };
      state.characterCards = [...state.characterCards, ...add];
      parts.push(`${add.length} character(s)`);
      if (neutralized.cards) {
        parts.push(`${neutralized.cards} of them carried custom code — kept, but switched OFF`);
      }
    }
  }

  if (Array.isArray(data.personaCards) && data.personaCards.length) {
    const have = new Set(state.personaCards.map(p => p.id));
    const add = data.personaCards
      .filter(p => p && !have.has(p.id))
      .map(p => ({ ...DEFAULT_PERSONA, ...p }));
    if (add.length) {
      state.personaCards = [...state.personaCards, ...add];
      parts.push(`${add.length} persona(s)`);
    }
  }

  return parts.length ? ' Also added ' + parts.join(', ') + '.' : '';
}

function importData(fileInput, type) {
  const file = fileInput.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-status');

  const showStatus = (msg, ok) => {
    statusEl.style.display = '';
    statusEl.textContent = msg;
    statusEl.className = 'data-import-status ' + (ok ? 'data-import-ok' : 'data-import-err');
    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
  };

  const reader = new FileReader();
  reader.onload = function(e) {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch(err) {
      showStatus('✗ Invalid JSON file: ' + err.message, false);
      return;
    }

    if (!data.gobbonet_export) {
      showStatus('✗ Not a Gobbonet export file.', false);
      return;
    }

    if (type === 'threads') {
      if (!Array.isArray(data.threads)) { showStatus('✗ No threads array found.', false); return; }
      // Merge: add threads whose ID doesn't already exist
      const existingIds = new Set(state.threads.map(t => t.id));
      const newThreads = data.threads.filter(t => !existingIds.has(t.id));
      state.threads = [...state.threads, ...newThreads];

      // A single-thread export carries the characters and personas the
      // conversation was actually held with (see exportThread). Merge them by
      // the same rule: anything whose id is already here is left alone, so a
      // recipient who owns that character keeps their own copy. Older files
      // have no such keys and this does nothing.
      const castNote = _mergeBundledCast(data);

      saveState(); render();
      showStatus(`✓ Imported ${newThreads.length} thread(s). ${data.threads.length - newThreads.length} skipped (already exist).` + castNote, true);

    } else if (type === 'cards') {
      if (!Array.isArray(data.characterCards)) { showStatus('✗ No characterCards array found.', false); return; }
      // Merge: add cards whose ID doesn't already exist
      const existingIds = new Set(state.characterCards.map(c => c.id));
      const newCards = data.characterCards.filter(c => !existingIds.has(c.id));
      // Same rule as the PNG card import and the full-backup restore: a card
      // from a file someone sent you does not get to arrive pre-armed. Wrapped
      // in a bare object because neutralizeUntrustedCode works on a state-shaped
      // blob; only the cards being merged are touched.
      const neutralizedCards = (typeof neutralizeUntrustedCode === 'function')
        ? neutralizeUntrustedCode({ characterCards: newCards })
        : { cards: 0, extensions: false };
      state.characterCards = [...state.characterCards, ...newCards];
      saveState(); render();
      const cardCodeNote = neutralizedCards.cards
        ? ` ${neutralizedCards.cards} carried custom code — kept, but switched OFF.`
        : '';
      showStatus(`✓ Imported ${newCards.length} character(s). ${data.characterCards.length - newCards.length} skipped (already exist).` + cardCodeNote, true);

    } else if (type === 'personas') {
      if (!Array.isArray(data.personaCards)) { showStatus('✗ No personaCards array found.', false); return; }
      const existingIds = new Set(state.personaCards.map(p => p.id));
      const newPersonas = data.personaCards
        .filter(p => !existingIds.has(p.id))
        // Patch incoming entries with any missing defaults so older exports
        // don't drop us into an editor with undefined fields.
        .map(p => ({ ...DEFAULT_PERSONA, ...p }));
      state.personaCards = [...state.personaCards, ...newPersonas];
      saveState(); render();
      showStatus(`✓ Imported ${newPersonas.length} persona(s). ${data.personaCards.length - newPersonas.length} skipped (already exist).`, true);

    } else if (type === 'all') {
      if (data.gobbonet_export !== 'full') {
        showStatus('✗ This file is not a full backup (use the specific import buttons for threads/characters/personas).', false);
        return;
      }
      if (!confirm('Full backup import will REPLACE all your current threads, characters, personas, settings, and schedules. Continue?')) return;
      state.threads        = data.threads        || [];
      state.activeThreadId = data.activeThreadId || null;
      state.settings       = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      state.characterCards = data.characterCards || [{ ...DEFAULT_CARD }];
      state.activeCardId   = data.activeCardId   || 'default';
      // Personas: honor whatever's in the backup; if a pre-persona backup
      // is imported, run the same identity migration the loader uses so
      // the user's name/avatar/colors carry over instead of being lost.
      if (Array.isArray(data.personaCards) && data.personaCards.length > 0) {
        state.personaCards = data.personaCards.map(p => ({ ...DEFAULT_PERSONA, ...p }));
        state.activePersonaId = data.activePersonaId || state.personaCards[0].id;
      } else {
        const legacy = data.settings || {};
        const legacyName = legacy.userName;
        const personaName = (legacyName && legacyName !== 'Guest') ? legacyName : 'Anonymous';
        state.personaCards = [{
          ...DEFAULT_PERSONA,
          name: personaName,
          avatar: legacy.userAvatar || '',
          textColor: legacy.userTextColor || '',
          dialogColor: legacy.userDialogColor || ''
        }];
        state.activePersonaId = state.personaCards[0].id;
        // Strip the moved-out fields from the imported settings too.
        delete state.settings.userName;
        delete state.settings.userAvatar;
        delete state.settings.userTextColor;
        delete state.settings.userDialogColor;
      }
      state.schedules      = data.schedules      || [];
      state.folders        = data.folders        || [];
      state.extensions     = migrateExtensions(data.extensions);
      // A backup file comes from wherever the user got it, and applyExtensions()
      // below injects <script> from it while boot runs card code. Same rule as
      // the character-card import: the content is kept, the run flags are not.
      // state.characterCards was assigned earlier in this function, so the cards
      // are present by the time this runs.
      const neutralized = (typeof neutralizeUntrustedCode === 'function')
        ? neutralizeUntrustedCode(state)
        : { cards: 0, extensions: false };
      state.macros         = Array.isArray(data.macros) ? data.macros : DEFAULT_MACROS.map(m => ({ ...m }));
      state.searchEnabled  = data.searchEnabled  || false;
      saveState();
      applyExtensions();
      render();
      const codeNote = (neutralized.cards || neutralized.extensions)
        ? ' Custom code in the backup was kept but left switched OFF — review it before enabling.'
        : '';
      showStatus('✓ Full backup restored successfully.' + codeNote, true);
    }

    // Reset the file input so the same file can be re-imported if needed
    fileInput.value = '';
  };
  reader.readAsText(file);
}

async function purgeData(type) {
  if (type === 'threads') {
    if (!confirm(`Delete ALL ${state.threads.length} thread(s)? This cannot be undone.`)) return;
    state.threads = [];
    state.activeThreadId = null;
    // Destroy first, then write the clean baseline. Saving an empty array does
    // not delete anything -- the bulk put iterates zero times and every stored
    // thread survives. See wipeLocalStorageAll.
    try { await idbClearStore('threads'); } catch (e) { console.warn('[purge] threads', e); }
    saveState(); render();
  } else if (type === 'cards') {
    if (!confirm('Reset all character cards to the built-in default? This cannot be undone.')) return;
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId = 'default';
    saveState(); render();
  } else if (type === 'personas') {
    if (!confirm('Reset all personas to the built-in Anonymous default? This cannot be undone.')) return;
    state.personaCards = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    saveState(); render();
  } else if (type === 'all') {
    if (!confirm('PURGE ALL DATA? This will delete every thread, character, persona, schedule, folder, setting, and extension. Full factory reset. Cannot be undone.\n\nAre you absolutely sure?')) return;
    state.threads        = [];
    state.activeThreadId = null;
    state.settings       = { ...DEFAULT_SETTINGS };
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId   = 'default';
    state.personaCards   = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    state.schedules      = [];
    state.folders        = [];
    state.extensions     = { ...DEFAULT_EXTENSIONS };
    state.searchEnabled  = false;

    // These four are persisted by buildStateBlob but were not being reset, so
    // they survived a "factory reset":
    //
    //   macros              user-authored text expansions -- content, not
    //                       preference, and the one that actually matters
    //   seededDefaultMacros bookkeeping for the above; left stale it stops the
    //                       built-in macros from re-seeding on next boot
    //   threadOrder         ordering by thread id, every one of which was just
    //                       deleted -- dangling references to purged data
    //   sidebarOpen         a UI preference, reset for consistency with the
    //                       rest of a full reset
    state.macros              = DEFAULT_MACROS.map(m => ({ ...m }));
    state.seededDefaultMacros = DEFAULT_MACROS.map(m => m.trigger);
    state.threadOrder         = [];
    state.sidebarOpen         = true;

    // Not persisted, but it is per-card scratch space written by card code and
    // therefore derived from conversations. It lives in memory until reload;
    // clearing it here means the purge is complete without one.
    state._cardCodeStore = {};

    // Destroy, THEN write the clean baseline. This order is load-bearing.
    //
    // Saving first re-seeds the meta record from an already-empty state, the
    // wipe then removes it, and the next boot falls through to the localStorage
    // migration branch looking for a key the wipe also deleted. Harmless, but
    // it takes the long way round for no reason.
    //
    // The reason this call has to exist at all: assigning [] to state.threads
    // and saving does not delete anything. The bulk put iterates the empty
    // array zero times, so every stored thread survives and can come back on
    // the next reload. PURGE ALL was reporting success while keeping the
    // entire history -- the worst possible failure for the one button whose
    // whole purpose is destroying data.
    const failed = await wipeLocalStorageAll();

    saveState();
    applyExtensions();
    render();

    // A purge that half-worked is worse than one that says what it missed.
    if (failed && failed.length) {
      alert('Purge finished, but these could not be cleared:\n\n  ' +
            failed.join('\n  ') +
            '\n\nClose any other GobboNet tabs and purge again. ' +
            'A tab holding the database open will block it.');
    }
    // Close modal after full purge so the user sees the clean state
    closeDataManager();
  }
}

/* ================================================================
   DATA MANAGER MODAL
================================================================ */
function openDataManager() {
  // Reset import status each time the modal opens
  const statusEl = document.getElementById('import-status');
  if (statusEl) statusEl.style.display = 'none';
  renderServerPresetPanel();
  renderSyncTargetPanel();
  document.getElementById('data-modal').classList.add('open');
}

/* ================================================================
   SERVER PRESETS PANEL

   Shows three things, because all three are ways this can be confusing:
   what the file presets, where this device differs from it, and what the file
   asked for that could not be used.
================================================================ */

function _presetValueText(v) {
  if (v === undefined) return '\u2014';
  return typeof v === 'string' ? '"' + v + '"' : String(v);
}

function renderServerPresetPanel() {
  const body = document.getElementById('server-presets-body');
  if (!body) return;
  body.innerHTML = '';

  if (!IS_SERVED) {
    body.innerHTML = '<div class="form-hint">Opened from a file rather than the GobboNet server, so there is no config file to read.</div>';
  } else if (!Object.keys(serverPresets.valid).length &&
             !serverPresets.unknown.length && !serverPresets.mistyped.length) {
    body.innerHTML = '<div class="form-hint">No <code>[ui]</code> section in this server\u2019s config file. Nothing is being preset.</div>';
  } else {
    const diff = serverPresetDiff();
    const list = document.createElement('div');
    list.className = 'preset-rows';
    for (const key of Object.keys(serverPresets.valid).sort()) {
      const differs = diff.some(d => d.key === key);
      const row = document.createElement('div');
      row.className = 'preset-row';
      row.dataset.differs = differs ? 'true' : 'false';
      const name = document.createElement('span');
      name.className = 'preset-key';
      name.textContent = key;
      const val = document.createElement('span');
      val.className = 'preset-val';
      // Showing only the preset value when they agree, and both when they do
      // not, keeps the interesting rows the ones that read differently.
      val.textContent = differs
        ? _presetValueText(state.settings[key]) + '  \u2192  ' + _presetValueText(serverPresets.valid[key])
        : _presetValueText(serverPresets.valid[key]);
      row.appendChild(name);
      row.appendChild(val);
      list.appendChild(row);
    }
    body.appendChild(list);

    const note = document.createElement('div');
    note.className = 'preset-note';
    if (diff.length) {
      note.textContent = diff.length + ' of these differ from what this device is using.';
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = 'USE THE PRESETS ON THIS DEVICE';
      btn.addEventListener('click', () => {
        const n = applyServerPresets();
        renderServerPresetPanel();
        const after = document.querySelector('#server-presets-body .preset-note');
        if (after) after.textContent = 'Applied ' + n + ' setting(s) to this device.';
      });
      body.appendChild(note);
      body.appendChild(btn);
    } else {
      note.textContent = 'This device matches the server\u2019s presets.';
      body.appendChild(note);
    }
  }

  // Anything the file asked for that could not be used. Reported rather than
  // dropped: an ignored typo in a config file costs someone an evening.
  for (const [items, label] of [
    [serverPresets.unknown.map(k => k), 'not a setting'],
    [serverPresets.mistyped.map(m => m.key + ' (wanted ' + m.expected + ', got ' + m.got + ')'), 'wrong type'],
  ]) {
    if (!items.length) continue;
    const warn = document.createElement('div');
    warn.className = 'preset-warn';
    warn.textContent = 'Ignored \u2014 ' + label + ': ' + items.join(', ');
    body.appendChild(warn);
  }

  const keys = document.getElementById('server-presets-keys');
  if (keys) {
    keys.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'preset-rows';
    for (const entry of serverPresetKeyReference()) {
      const row = document.createElement('div');
      row.className = 'preset-row';
      const name = document.createElement('span');
      name.className = 'preset-key';
      name.textContent = entry.toml;
      const val = document.createElement('span');
      val.className = 'preset-val';
      val.textContent = entry.type + ' \u00b7 now ' + _presetValueText(entry.mine);
      row.appendChild(name);
      row.appendChild(val);
      list.appendChild(row);
    }
    keys.appendChild(list);
  }
}

/* ================================================================
   DEVICE SYNC PANEL

   The controls for which server-side backup this device uses. The state they
   reflect lives in js/06-state-sync.js, which is the module that owns it --
   this is rendering and nothing else, so there is one place where a target can
   actually change and one place that can get it wrong.
================================================================ */

function _syncStatusLine(msg, tone) {
  const el = document.getElementById('sync-target-status');
  if (!el) return;
  el.textContent = msg || '';
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

/** Paint the radios, the name field and the server listing from live state. */
function renderSyncTargetPanel() {
  const rows = document.getElementById('sync-target-rows');
  if (!rows) return;

  // On file:// there is no server to sync with at all. Say so plainly rather
  // than offering three choices that would all do nothing.
  if (!STATE_SYNC_AVAILABLE) {
    rows.querySelectorAll('input').forEach(el => { el.disabled = true; });
    const apply = document.getElementById('sync-profile-apply');
    if (apply) apply.disabled = true;
    _syncStatusLine('Opened from a file rather than the GobboNet server, so there is nothing to sync with.');
    const list = document.getElementById('sync-profile-list');
    if (list) list.innerHTML = '';
    return;
  }

  rows.querySelectorAll('input[name="sync-target-mode"]').forEach(el => {
    el.checked = (el.value === syncTarget.mode);
  });
  const nameEl = document.getElementById('sync-profile-name');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = syncTarget.profile || '';
  _syncTargetRowVisibility();
  _syncStatusLine(_syncTargetSummary());
  refreshSyncProfileList();
}

function _syncTargetSummary() {
  if (syncTarget.mode === 'off') return 'This device is not sending anything to the server.';
  if (syncTarget.mode === 'profile') {
    return 'This device syncs with the profile "' + syncTarget.profile + '".';
  }
  return 'This device syncs with the shared backup, along with every other device.';
}

/** The name field only makes sense for the profile mode. */
function _syncTargetRowVisibility() {
  const chosen = document.querySelector('input[name="sync-target-mode"]:checked');
  const isProfile = !!chosen && chosen.value === 'profile';
  const row = document.getElementById('sync-profile-name-row');
  const hint = document.getElementById('sync-profile-hint');
  if (row) row.style.display = isProfile ? '' : 'none';
  if (hint) hint.style.display = isProfile ? '' : 'none';
}

function onSyncProfileNameInput() {
  const el = document.getElementById('sync-profile-name');
  if (!el) return;
  const raw = el.value;
  const ok = raw === '' || !!normalizeSyncProfile(raw);
  // aria-invalid rather than a colour class: the border is styled off it, and
  // a screen reader gets told the same thing the border is saying.
  if (ok) el.removeAttribute('aria-invalid'); else el.setAttribute('aria-invalid', 'true');
  const apply = document.getElementById('sync-profile-apply');
  if (apply) apply.disabled = !normalizeSyncProfile(raw);
}

/** Shared and Off apply as soon as they are picked. A profile does not: the
 *  name is still being typed, so it waits for the button. */
async function onSyncTargetModeChange() {
  _syncTargetRowVisibility();
  const chosen = document.querySelector('input[name="sync-target-mode"]:checked');
  if (!chosen) return;
  if (chosen.value === 'profile') {
    onSyncProfileNameInput();
    const el = document.getElementById('sync-profile-name');
    if (el) el.focus();
    _syncStatusLine('Name the profile for this device, then choose USE THIS PROFILE.');
    return;
  }
  await _applyAndReport(chosen.value, '');
}

async function onSyncTargetApply() {
  const el = document.getElementById('sync-profile-name');
  const name = el ? el.value : '';
  if (!normalizeSyncProfile(name)) {
    _syncStatusLine('That name will not work \u2014 use lower-case letters, numbers, - or _.', 'err');
    return;
  }
  await _applyAndReport('profile', name);
}

async function _applyAndReport(mode, name) {
  let result;
  try {
    result = await applySyncTarget(mode, name);
  } catch (e) {
    _syncStatusLine('Could not switch: ' + (e && e.message ? e.message : 'unknown error'), 'err');
    return;
  }
  const messages = {
    unchanged: [_syncTargetSummary(), null],
    invalid:   ['That target is not usable.', 'err'],
    off:       ['Sync is off. This device keeps its chats to itself \u2014 nothing is sent, and nothing will be restored from the server.', 'ok'],
    seeded:    ['Done. This device now syncs with ' + syncTargetLabel() + ', and its chats have been copied there.', 'ok'],
    pushed:    ['Done. This device now syncs with ' + syncTargetLabel() + ', and the backup there has been replaced with what is on this device.', 'ok'],
    // restoreFromServer reloads the page on success, so this line is mostly
    // seen when the restore failed and left us where we were.
    restoring: ['Loading that backup\u2026', null]
  };
  const [msg, tone] = messages[result] || [_syncTargetSummary(), null];
  _syncStatusLine(msg, tone);
  renderSyncTargetPanel();
}

function _syncAgo(mtime) {
  if (!mtime) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - mtime) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs + ' hr ago';
  return Math.round(hrs / 24) + ' days ago';
}

/** What is actually on the server, so a profile made on one device can be
 *  found from another without remembering its name. */
async function refreshSyncProfileList() {
  const list = document.getElementById('sync-profile-list');
  if (!list) return;
  const profiles = await fetchSyncProfiles();
  if (!profiles.length) {
    list.innerHTML = '<div class="form-hint">Nothing stored on the server yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const p of profiles) {
    const label = p.shared ? 'shared' : p.name;
    const isCurrent = !syncIsOff() && label === syncTargetLabel();

    const row = document.createElement('div');
    row.className = 'sync-profile-item';
    row.dataset.current = isCurrent ? 'true' : 'false';

    const name = document.createElement('span');
    name.className = 'spi-name';
    name.textContent = label;
    row.appendChild(name);

    if (isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'spi-tag';
      tag.textContent = 'THIS DEVICE';
      row.appendChild(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'spi-meta';
    meta.textContent = Math.max(1, Math.round((p.size || 0) / 1024)) + ' KB \u00b7 ' + _syncAgo(p.mtime);
    row.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger';
    del.textContent = 'DELETE';
    del.title = 'Remove this backup from the server';
    del.addEventListener('click', () => onDeleteSyncProfile(p.shared ? '' : p.name, label, isCurrent));
    row.appendChild(del);

    list.appendChild(row);
  }
}

async function onDeleteSyncProfile(name, label, isCurrent) {
  // Deleting the backup this device is using does not delete the chats on this
  // device -- and the next save would immediately recreate it. Say both, or
  // the button reads as far more destructive than it is.
  const extra = isCurrent
    ? '\n\nThis is the backup this device uses. Your chats on this device are not affected, ' +
      'and the backup will be recreated the next time this device saves.'
    : '';
  if (!confirm('Delete the "' + label + '" backup from the server?' + extra +
               '\n\nThis cannot be undone.')) return;
  const ok = await deleteSyncProfile(name);
  _syncStatusLine(ok ? 'Deleted the "' + label + '" backup from the server.'
                     : 'Could not delete that backup.',
                  ok ? 'ok' : 'err');
  refreshSyncProfileList();
}

function closeDataManager() {
  document.getElementById('data-modal').classList.remove('open');
}

