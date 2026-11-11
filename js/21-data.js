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
   SERVER PRESETS — the [ui] table from config.toml

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
    console.warn('[presets] ignored entries in the [ui] section of config.toml:',
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
  // `version` is the envelope: what shape THIS file is. `schemaVersion` is
  // what shape the state inside it is (js/04-state.js), and the two move
  // independently -- an export file whose wrapper never changes can still
  // carry conversations from any era of the app.
  if (type === 'threads') {
    downloadJSON({ gobbonet_export: 'threads', version: 1, schemaVersion: STATE_SCHEMA_VERSION,
      exported: Date.now(), threads: state.threads, folders: _threadFolders(state.threads) },
      `gobbonet-threads-${ts}.json`);
  } else if (type === 'cards') {
    // Groups travel with the characters they are made of (1.8.0).
    downloadJSON({ gobbonet_export: 'cards', version: 1, exported: Date.now(), characterCards: state.characterCards,
      groups: state.groups || [] },
      `gobbonet-characters-${ts}.json`);
  } else if (type === 'personas') {
    downloadJSON({ gobbonet_export: 'personas', version: 1, exported: Date.now(), personaCards: state.personaCards },
      `gobbonet-personas-${ts}.json`);
  } else if (type === 'all') {
    // Full state snapshot — strip nothing, keep it complete
    downloadJSON({
      gobbonet_export: 'full',
      version: 1,
      schemaVersion: STATE_SCHEMA_VERSION,
      exported: Date.now(),
      threads: state.threads,
      activeThreadId: state.activeThreadId,
      settings: state.settings,
      characterCards: state.characterCards,
      activeCardId: state.activeCardId,
      personaCards: state.personaCards,
      activePersonaId: state.activePersonaId,
      groups: state.groups || [],
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
  // A group chat brings its group, and every member of it -- one who has not
  // spoken yet is still part of the chat the file describes (1.8.0).
  const group = (typeof threadGroup === 'function') ? threadGroup(thread) : null;
  if (group) for (const m of group.members) cardIds.add(m.cardId);
  const cards = (state.characterCards || []).filter(c => cardIds.has(c.id));
  const personas = (state.personaCards || []).filter(p => personaIds.has(p.id));

  const stem = _exportSlug(thread.name) || 'thread';
  const out = {
    gobbonet_export: 'threads',
    version: 1,
    schemaVersion: STATE_SCHEMA_VERSION,
    exported: Date.now(),
    threads: [thread],
    folders: _threadFolders([thread]),
    characterCards: cards,
    personaCards: personas
  };
  if (group) out.groups = [group];
  downloadJSON(out, `gobbonet-thread-${stem}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Export one group with the characters in it, in the envelope the
 *  Characters import already reads (1.8.0). */
function exportGroup(id, event) {
  if (event) event.stopPropagation();
  const group = (state.groups || []).find(g => g && g.id === id);
  if (!group) return;
  const ids = new Set(group.members.map(m => m.cardId));
  const stem = _exportSlug(group.name) || 'group';
  downloadJSON({
    gobbonet_export: 'cards',
    version: 1,
    exported: Date.now(),
    characterCards: (state.characterCards || []).filter(c => ids.has(c.id)),
    groups: [group]
  }, `gobbonet-group-${stem}-${new Date().toISOString().slice(0, 10)}.json`);
}

/** Merge groups out of an imported file: one whose id is already here is
 *  left alone, like a character. Each is read through normalizeGroup, so a
 *  file cannot bring a field this build does not know. Returns how many
 *  were added. */
function _mergeImportedGroups(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  if (!Array.isArray(state.groups)) state.groups = [];
  const have = new Set(state.groups.map(g => g.id));
  const add = normalizeGroups(list).filter(g => !have.has(g.id));
  if (add.length) state.groups = [...state.groups, ...add];
  return add.length;
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
      const neutralized = neutralizeUntrustedCode({ characterCards: add });   // no typeof guard: fail closed
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

  // After the characters, so a group's members are here when it arrives.
  const groupsAdded = _mergeImportedGroups(data.groups);
  if (groupsAdded) parts.push(`${groupsAdded} group(s)`);

  return parts.length ? ' Also added ' + parts.join(', ') + '.' : '';
}

/** The folders a set of threads sits in, for a threads export (issue #61).
 *
 *  A thread carries its folder by id only. Exported without the folder, it
 *  arrived on another install pointing at an id that did not exist there, and
 *  the sidebar drew it nowhere -- imported, counted, and invisible. Only id and
 *  name travel: `collapsed` is how one person's sidebar happens to look. */
function _threadFolders(threads) {
  const used = new Set((threads || []).map(t => t && t.folderId).filter(Boolean));
  return (state.folders || [])
    .filter(f => f && used.has(f.id))
    .map(f => ({ id: f.id, name: f.name }));
}

/** Give imported threads a folder that exists here (issue #61).
 *
 *  For each new thread whose folder is not on this install, in order:
 *    1. a local folder with the same name takes it -- recreating "Campaigns"
 *       by hand and importing into it is what people try first, and matching
 *       by id alone made that silently not work;
 *    2. otherwise the folder from the file is created, keeping its id, so a
 *       second thread from the same folder lands beside the first;
 *    3. a file with no folder record for it (every export before this fix)
 *       puts the thread in the unfiled list.
 *  Runs before the threads are added, on the imported copies only; threads
 *  already here are not touched. */
function _placeImportedThreads(threads, exportedFolders) {
  if (!Array.isArray(state.folders)) state.folders = [];
  const fromFile = new Map((Array.isArray(exportedFolders) ? exportedFolders : [])
    .filter(f => f && typeof f.id === 'string' && f.id && typeof f.name === 'string')
    .map(f => [f.id, f]));
  let created = 0, unfiled = 0;
  for (const t of threads) {
    if (!t || !t.folderId) continue;
    if (state.folders.some(f => f.id === t.folderId)) continue;
    const src = fromFile.get(t.folderId);
    const name = src ? src.name.trim() : '';
    if (!name) { t.folderId = null; unfiled++; continue; }
    const sameName = state.folders.find(f => String(f.name || '').trim() === name);
    if (sameName) { t.folderId = sameName.id; continue; }
    state.folders.push({ id: src.id, name, collapsed: false });
    created++;
  }
  const parts = [];
  if (created) parts.push(` Recreated ${created} folder(s).`);
  if (unfiled) parts.push(` ${unfiled} thread(s) had no matching folder and are in the unfiled list.`);
  return parts.join('');
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
      const folderNote = _placeImportedThreads(newThreads, data.folders);
      state.threads = [...state.threads, ...newThreads];

      // A single-thread export carries the characters and personas the
      // conversation was actually held with (see exportThread). Merge them by
      // the same rule: anything whose id is already here is left alone, so a
      // recipient who owns that character keeps their own copy. Older files
      // have no such keys and this does nothing.
      const castNote = _mergeBundledCast(data);

      saveState(); render();
      showStatus(`✓ Imported ${newThreads.length} thread(s). ${data.threads.length - newThreads.length} skipped (already exist).` + folderNote + castNote, true);

    } else if (type === 'cards') {
      if (!Array.isArray(data.characterCards)) { showStatus('✗ No characterCards array found.', false); return; }
      // Merge: add cards whose ID doesn't already exist
      const existingIds = new Set(state.characterCards.map(c => c.id));
      const newCards = data.characterCards.filter(c => !existingIds.has(c.id));
      // Same rule as the PNG card import and the full-backup restore: a card
      // from a file someone sent you does not get to arrive pre-armed. Wrapped
      // in a bare object because neutralizeUntrustedCode works on a state-shaped
      // blob; only the cards being merged are touched.
      const neutralizedCards = neutralizeUntrustedCode({ characterCards: newCards });   // no typeof guard: fail closed
      state.characterCards = [...state.characterCards, ...newCards];
      // A group export is its members plus the group (exportGroup).
      const groupsAdded = _mergeImportedGroups(data.groups);
      saveState(); render();
      const cardCodeNote = neutralizedCards.cards
        ? ` ${neutralizedCards.cards} carried custom code — kept, but switched OFF.`
        : '';
      const groupNote = groupsAdded ? ` Also added ${groupsAdded} group(s).` : '';
      showStatus(`✓ Imported ${newCards.length} character(s). ${data.characterCards.length - newCards.length} skipped (already exist).` + cardCodeNote + groupNote, true);

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
      state.groups         = normalizeGroups(data.groups);
      state.schedules      = data.schedules      || [];
      state.folders        = data.folders        || [];
      state.extensions     = migrateExtensions(data.extensions);
      // A backup file comes from wherever the user got it, and applyExtensions()
      // below injects <script> from it while boot runs card code. Same rule as
      // the character-card import: the content is kept, the run flags are not.
      // state.characterCards was assigned earlier in this function, so the cards
      // are present by the time this runs.
      const neutralized = neutralizeUntrustedCode(state);   // no typeof guard: fail closed
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

/* PURGE (1.7.9): it still asks first, because it wipes a whole kind of data
   at once, and then offers UNDO for 10 seconds like every other delete in
   DATA.

   The wipe itself happens AT ONCE, exactly as before -- the stored records
   are destroyed, not merely hidden -- so a purge cannot be half-done by the
   page closing during the UNDO window. UNDO puts the previous state back in
   memory and saves it in full, which rewrites every conversation record.
   Meanwhile nothing is pushed to the server or other devices
   (undoHoldsSync): they learn of the purge only when it is final. */
const _PURGE_FIELDS = ['threads', 'activeThreadId', 'settings', 'characterCards', 'activeCardId',
  'personaCards', 'activePersonaId', 'groups', 'schedules', 'folders', 'extensions', 'searchEnabled',
  'macros', 'seededDefaultMacros', 'sidebarOpen', '_cardCodeStore'];

function _purgeSnapshot(fields) {
  const snap = {};
  for (const f of fields) snap[f] = state[f];
  return snap;
}

function _offerPurgeUndo(label, snap, extra) {
  undoable({
    label,
    undo: () => {
      for (const f of Object.keys(snap)) state[f] = snap[f];
      if (extra && extra.undo) { try { extra.undo(); } catch (e) { console.warn('[purge] undo', e); } }
      saveState();
      try { if (snap.extensions) applyExtensions(); } catch (_) {}
      render();
    },
  });
}

async function purgeData(type) {
  if (type === 'threads') {
    if (!confirm(`Delete ALL ${state.threads.length} thread(s)? UNDO is offered for 10 seconds afterwards.`)) return;
    const snap = _purgeSnapshot(['threads', 'activeThreadId']);
    state.threads = [];
    state.activeThreadId = null;
    // Destroy first, then write the clean baseline. Saving an empty array does
    // not delete anything -- the bulk put iterates zero times and every stored
    // thread survives. See wipeLocalStorageAll.
    try { await idbClearStore('threads'); } catch (e) { console.warn('[purge] threads', e); }
    saveState(); render();
    _offerPurgeUndo('Purged ' + snap.threads.length + ' thread(s)', snap);
  } else if (type === 'cards') {
    const _groupCount = (state.groups || []).length;
    if (!confirm('Reset all character cards to the built-in default?' +
        (_groupCount ? ' Your ' + _groupCount + ' group(s) go with them.' : '') +
        ' UNDO is offered for 10 seconds afterwards.')) return;
    // Groups go with the characters they were made of (1.8.0).
    const snap = _purgeSnapshot(['characterCards', 'activeCardId', 'groups']);
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId = 'default';
    state.groups = [];
    saveState(); render();
    _offerPurgeUndo('Reset all characters', snap);
  } else if (type === 'personas') {
    if (!confirm('Reset all personas to the built-in Anonymous default? UNDO is offered for 10 seconds afterwards.')) return;
    const snap = _purgeSnapshot(['personaCards', 'activePersonaId']);
    state.personaCards = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    saveState(); render();
    _offerPurgeUndo('Reset all personas', snap);
  } else if (type === 'all') {
    if (!confirm('PURGE ALL DATA? This will delete every thread, character, persona, schedule, folder, setting, and extension. Full factory reset. UNDO is offered for 10 seconds afterwards.\n\nAre you absolutely sure?')) return;
    const snap = _purgeSnapshot(_PURGE_FIELDS);
    // What wipeLocalStorageAll clears outside state, so UNDO can put it back.
    const kept = { ls: {}, recovery: legacyBrowserRecovery, recoveryMsg: storageRecoveryMessage };
    for (const k of ['gobbonet_chat_state', 'gemma4_chat_state', 'gobbonet_sync_meta', 'gobbonet_before_upgrade_recovery']) {
      try { const v = localStorage.getItem(k); if (v !== null) kept.ls[k] = v; } catch (_) {}
    }
    state.threads        = [];
    state.activeThreadId = null;
    state.settings       = { ...DEFAULT_SETTINGS };
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId   = 'default';
    state.personaCards   = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    state.groups         = [];
    state.schedules      = [];
    state.folders        = [];
    state.extensions     = { ...DEFAULT_EXTENSIONS };
    state.searchEnabled  = false;

    // These three are persisted by buildStateBlob but were not being reset, so
    // they survived a "factory reset":
    //
    //   macros              user-authored text expansions -- content, not
    //                       preference, and the one that actually matters
    //   seededDefaultMacros bookkeeping for the above; left stale it stops the
    //                       built-in macros from re-seeding on next boot
    //   sidebarOpen         a UI preference, reset for consistency with the
    //                       rest of a full reset
    //
    // There was a fourth, threadOrder: a list of thread ids, every one of them
    // just deleted. It needs no resetting now because it no longer exists --
    // the order is a number on each conversation, and emptying state.threads
    // takes it with them.
    state.macros              = DEFAULT_MACROS.map(m => ({ ...m }));
    state.seededDefaultMacros = DEFAULT_MACROS.map(m => m.trigger);
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
    _offerPurgeUndo('Purged all data', snap, {
      undo: () => {
        for (const k of Object.keys(kept.ls)) { try { localStorage.setItem(k, kept.ls[k]); } catch (_) {} }
        legacyBrowserRecovery = kept.recovery;
        storageRecoveryMessage = kept.recoveryMsg;
      },
    });
  }
}


/* ================================================================
   DATA MANAGER MODAL
================================================================ */
function openDataManager() {
  renderUpgradeRecovery();
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
    if (_syncProfilesPendingDelete.has(label)) continue;   // waiting out UNDO
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

// Backups whose DELETE is waiting out its UNDO window, hidden from the list.
const _syncProfilesPendingDelete = new Set();

async function onDeleteSyncProfile(name, label, isCurrent) {
  // 1.7.9: no confirm. The server DELETE is not sent until the UNDO window
  // closes; until then the backup only disappears from this list. Deleting the
  // backup this device uses does not touch the chats here, and the next save
  // recreates it -- the status line says so, since the confirm no longer does.
  _syncProfilesPendingDelete.add(label);
  refreshSyncProfileList();
  _syncStatusLine('The "' + label + '" backup will be deleted from the server.' +
                  (isCurrent ? ' Your chats on this device are not affected.' : ''), 'ok');
  undoable({
    label: 'Deleted backup "' + String(label).slice(0, 40) + '"',
    undo: () => {
      _syncProfilesPendingDelete.delete(label);
      _syncStatusLine('Kept the "' + label + '" backup.', 'ok');
      refreshSyncProfileList();
    },
    commit: async () => {
      const ok = await deleteSyncProfile(name);
      _syncProfilesPendingDelete.delete(label);
      _syncStatusLine(ok ? 'Deleted the "' + label + '" backup from the server.' +
                           (isCurrent ? ' It is recreated the next time this device saves.' : '')
                         : 'Could not delete that backup.',
                      ok ? 'ok' : 'err');
      refreshSyncProfileList();
    },
  });
}

function closeDataManager() {
  document.getElementById('data-modal').classList.remove('open');
}


/* UPGRADE RECOVERY — discovered data stays reachable without file hunting. */
let upgradeServerProfiles = [];
let upgradeRecoveryStatus = '';
let upgradeRecoveryBusy = false;
async function checkUpgradeRecovery() {
  if (typeof syncEnabled === 'function' && syncEnabled()) {
    try {
      const resp = await fetch(STATE_SYNC_BASE + '/migration', { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.recovery_profiles)) {
          upgradeServerProfiles = data.recovery_profiles.filter(x => typeof x === 'string' && /^legacy-[a-f0-9]{16}$/.test(x));
        }
      }
    } catch (_) { /* the regular state check reports connection failures */ }
  }
  renderUpgradeRecovery();
}
function renderUpgradeRecovery() {
  const box = document.getElementById('upgrade-recovery');
  if (!box) return;
  const browser = typeof legacyBrowserRecovery !== 'undefined' && legacyBrowserRecovery;
  const message = typeof storageRecoveryMessage === 'string' ? storageRecoveryMessage : '';
  const available = !!browser || upgradeServerProfiles.length > 0;
  box.style.display = available || message || upgradeRecoveryStatus ? '' : 'none';
  document.getElementById('upgrade-recovery-message').textContent = upgradeRecoveryStatus || message || 'Older history was preserved separately from your current history. Choose a recovery copy below.';
  document.getElementById('upgrade-recovery-browser').style.display = browser ? '' : 'none';
  const select = document.getElementById('upgrade-recovery-profile');
  select.textContent = '';
  for (const name of upgradeServerProfiles) {
    const option = document.createElement('option');
    option.value = option.textContent = name;
    select.appendChild(option);
  }
  document.getElementById('upgrade-recovery-server').style.display = upgradeServerProfiles.length ? '' : 'none';
  // DATA marks that it holds a recovery with an amber dot and a tooltip. It
  // used to read "// DATA — RECOVERY", which is wider than its half of the
  // sidebar row and ran out past the sidebar's edge.
  const badge = document.getElementById('data-btn');
  if (badge) {
    badge.textContent = '// DATA';
    const flagged = !!(available || message);
    if (badge.classList) badge.classList.toggle('has-recovery', flagged);
    badge.title = flagged ? 'Older history or a storage notice: open DATA, Upgrade recovery'
                          : 'Export, import, and purge your data';
  }
  // The bar under the chat header. Visible on mobile too, where the sidebar
  // may be closed -- unless it was hidden for exactly what it would say now.
  const notice = document.getElementById('upgrade-recovery-notice');
  if (notice) notice.style.display = (available || message) && !recoveryNoticeDismissed() ? '' : 'none';
  const text = document.getElementById('upgrade-recovery-notice-text');
  if (text) text.textContent = message || 'Older history from before an upgrade was kept separately. Nothing is lost.';
}

/* Hiding the bar. The older copies are kept for good, so without this the bar
   came back on every load, for ever. Hidden, it stays hidden for the same
   offer -- the same older browser copy and the same server recovery copies --
   and comes back when that changes. A storage warning (the message) is hidden
   for this visit only: it says something is wrong now, and next time it may be
   something else. DATA's badge and its Upgrade recovery section stay. */
const RECOVERY_NOTICE_KEY = 'gobbonet_recovery_notice_hidden';
let _recoveryNoticeHiddenNow = false;
function recoveryNoticeSignature() {
  const browser = typeof legacyBrowserRecovery !== 'undefined' && legacyBrowserRecovery;
  const message = typeof storageRecoveryMessage === 'string' ? storageRecoveryMessage : '';
  return JSON.stringify([browser ? String(browser.raw || '').length : 0, upgradeServerProfiles.slice().sort(), message]);
}
function recoveryNoticeDismissed() {
  if (_recoveryNoticeHiddenNow) return true;
  const message = typeof storageRecoveryMessage === 'string' ? storageRecoveryMessage : '';
  if (message) return false;
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(RECOVERY_NOTICE_KEY) === recoveryNoticeSignature(); }
  catch (_) { return false; }
}
function dismissUpgradeRecoveryNotice() {
  _recoveryNoticeHiddenNow = true;
  const message = typeof storageRecoveryMessage === 'string' ? storageRecoveryMessage : '';
  if (!message) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(RECOVERY_NOTICE_KEY, recoveryNoticeSignature()); } catch (_) {}
  }
  renderUpgradeRecovery();
}
async function preserveBeforeUpgradeRecovery() {
  const blob = buildStateBlob();
  if (STORAGE_BACKEND === 'idb') {
    const previous = await idbGet('meta', 'pre-recovery');
    if (previous) await idbPut('meta', previous, 'pre-recovery-' + Date.now());
    await idbPut('meta', blob, 'pre-recovery');
  }
  else localStorage.setItem('gobbonet_before_upgrade_recovery', JSON.stringify(blob));
  // Cancel delayed writes of the snapshot we are replacing.
  if (_idbFullSaveTimer) clearTimeout(_idbFullSaveTimer);
  _idbFullSaveTimer = null; _idbPendingBlob = null;
  if (stateSync.pushTimer) clearTimeout(stateSync.pushTimer);
  stateSync.pushTimer = null; stateSync.pendingPush = false;
}
async function recoverUpgradeHistory(kind) {
  if (upgradeRecoveryBusy) return;
  if (isGenerating) { alert('Stop the current reply before recovering history.'); return; }
  if (!confirm('Load this older history? Your current browser history will be kept as a recovery copy. Existing server profiles and the original older files will remain intact.')) return;
  upgradeRecoveryBusy = true;
  try {
    await preserveBeforeUpgradeRecovery();
    if (kind === 'browser') {
      if (!legacyBrowserRecovery) throw new Error('The older browser copy is unavailable.');
      const blob = JSON.parse(legacyBrowserRecovery.raw);
      validateServerSnapshot(blob);
      neutralizeUntrustedCode(blob);   // no typeof guard: fail closed
      // Restore locally first; never let recovery replace a shared server copy.
      syncTarget = { mode: 'off', profile: '' }; persistSyncTarget();
      if (!applyLoadedState(blob)) throw new Error('Could not read the older history.');
      if (STORAGE_BACKEND === 'idb') await idbWriteSnapshot(buildStateBlob(), true);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStateBlob()));
      storageLoadFailed = false;
      stateSync.status = 'off';
      render(); applyAvatarScale(); applyActiveCardBackground();
    } else {
      const profile = document.getElementById('upgrade-recovery-profile').value;
      if (!upgradeServerProfiles.includes(profile)) throw new Error('Choose an available recovery profile.');
      const previous = { ...syncTarget };
      syncTarget = { mode: 'profile', profile }; persistSyncTarget();
      if (!await restoreFromServer({ inPlace: true, silent: true })) {
        syncTarget = previous; persistSyncTarget();
        throw new Error('Could not load that recovery profile. Your previous sync target is unchanged.');
      }
    }
    invalidateLedger();
    upgradeRecoveryStatus = kind === 'browser'
      ? 'Older history restored on this device. Sync is off to protect other copies; choose sharing under DEVICE SYNC when ready.'
      : 'Older history loaded from its separate recovery profile. Your other server history remains intact.';
    updateSyncIndicator(); renderSyncTargetPanel();
  } catch (e) {
    upgradeRecoveryStatus = 'Recovery could not finish: ' + e.message + ' The original copies are preserved.';
  }
  upgradeRecoveryBusy = false;
  renderUpgradeRecovery();
}
async function downloadBeforeUpgradeRecovery() {
  try {
    const blob = STORAGE_BACKEND === 'idb' ? await idbGet('meta', 'pre-recovery')
      : JSON.parse(localStorage.getItem('gobbonet_before_upgrade_recovery') || 'null');
    if (!blob) { alert('No recovery has replaced this browser history yet.'); return; }
    downloadJSON({ ...blob, gobbonet_export: 'full', version: 1 }, 'gobbonet-before-recovery.json');
  } catch (e) { alert('Could not read the safety copy: ' + e.message); }
}
