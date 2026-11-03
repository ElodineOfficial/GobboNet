/* GobboNet 1.7.9 — console check for patch step 9 (F8, UNDO).
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). Takes about 15 seconds: one check waits out the 10-second
 * window on purpose.
 *
 * It touches nothing of yours. It makes its own throwaway things -- a chat
 * called "Undo probe", a folder, a tag, two messages, a copy of your active
 * character and persona, a macro, a scheduled message, an extension entry in
 * an unsaved draft, and a backup row that only exists in the list -- deletes
 * each one, takes it back, and removes all of them at the end. It never asks
 * the server to delete a backup. Your active chat, character and persona are
 * put back. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (cond, msg) => log(cond ? 'PASS' : 'FAIL', 'F8', msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const toast = () => $('undo-toast');
  const shown = () => !!toast() && toast().classList.contains('visible');
  const toastText = () => (toast() && toast().querySelector('.undo-toast-text') || {}).textContent || '';
  const clickUndo = async () => { toast().querySelector('.undo-toast-btn').click(); await wait(30); };
  const ctrlZ = async (target) => {
    (target || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(30);
  };

  if (typeof undoable !== 'function') {
    log('FAIL', 'F8', 'this page has no UNDO (undoable() is missing) -- is it the 1.7.9 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (undoHoldsSync()) {
    log('INFO', 'F8', 'you have a delete waiting on its UNDO right now. Let it finish (10 s) or undo it, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  // What has to look the same at the end.
  const before = {
    activeThreadId: state.activeThreadId, activeCardId: state.activeCardId, activePersonaId: state.activePersonaId,
    threads: state.threads.map(t => t.id).join(), folders: (state.folders || []).map(f => f.id).join(),
    cards: state.characterCards.map(c => c.id).join(), personas: state.personaCards.map(p => p.id).join(),
    macros: JSON.stringify(state.macros || []), schedules: (state.schedules || []).map(s => s.id).join(),
    extensions: JSON.stringify(state.extensions || null),
    hadCodeStore: Object.prototype.hasOwnProperty.call(state, '_cardCodeStore'),
  };
  const made = { thread: null, folder: null, card: null, persona: null, macro: 'undo_probe_179', sched: null };

  try {
    // ── Chats, messages, folders, tags ──────────────────────────────────────
    createThread();
    const thread = getActiveThread();
    made.thread = thread.id;
    thread.name = 'Undo probe <img src=x onerror="window.__undoXss=1">';
    thread.messages.push({ role: 'user', content: 'Undo probe: first', timestamp: Date.now() },
                         { role: 'assistant', content: 'Undo probe: second', timestamp: Date.now() });
    saveState(); render();
    await wait(1200);   // let the save reach storage

    deleteMessage(1);
    check(thread.messages.length === 1 && shown() && toastText() === 'Deleted the reply',
      `deleting a message offers UNDO ("${toastText()}")`);
    check(undoHoldsSync(), 'while UNDO is offered, nothing is pushed to your other devices');
    if (typeof stateSync !== 'undefined' && typeof flushStateSync === 'function') {
      const was = stateSync.pendingPush;
      await flushStateSync();
      check(stateSync.pendingPush === true, 'a push asked for in the meantime waits for the window to close');
      if (!was) stateSync.pendingPush = was;
    }
    const box = $('msg-input');
    if (box) { box.focus(); await ctrlZ(box); }
    check(thread.messages.length === 1 && shown(), 'Ctrl+Z in the message box is left to the box (it undoes typing)');
    if (box) box.blur();
    await ctrlZ(document.body);
    check(thread.messages.length === 2 && thread.messages[1].content === 'Undo probe: second' && !shown(),
      'Ctrl+Z anywhere else brings the message back, in its place');

    made.folder = createFolder('Undo probe folder').id;
    thread.folderId = made.folder; saveState(); renderSidebar();
    deleteFolder(made.folder);
    check(!state.folders.some(f => f.id === made.folder) && thread.folderId === null && /Deleted folder/.test(toastText()),
      'deleting a folder offers UNDO, and its chats move out');
    await clickUndo();
    check(state.folders.some(f => f.id === made.folder) && thread.folderId === made.folder,
      'the UNDO button brings the folder back with its chat in it');

    // Tags ask first instead of offering UNDO (Elodine's call, after step 15).
    addTag(thread.id, 'undoprobe');
    const nativeAsk = window.confirm;
    let askedTag = 0;
    try {
      window.confirm = () => { askedTag++; return false; };
      removeTag(thread.id, 'undoprobe');
      check(askedTag === 1 && thread.tags.includes('undoprobe') && !shown(), 'removing a tag asks first; "Cancel" keeps it');
      window.confirm = () => { askedTag++; return true; };
      removeTag(thread.id, 'undoprobe');
      check(askedTag === 2 && !thread.tags.includes('undoprobe') && !shown(), '"OK" removes it, with no UNDO toast');
    } finally { window.confirm = nativeAsk; }
    if (typeof closePopover === 'function') closePopover();

    let hadRecord = null;
    if (typeof STORAGE_BACKEND !== 'undefined' && STORAGE_BACKEND === 'idb') {
      try { hadRecord = !!(await idbGet('threads', thread.id)); } catch (_) {}
    }
    deleteThread(thread.id);
    check(!state.threads.some(t => t.id === thread.id) && /^Deleted chat "/.test(toastText()), 'deleting a chat offers UNDO');
    check(/<img/.test(toastText()) && !toast().querySelector('img') && !window.__undoXss,
      'a name with markup in it is shown as text, never run');
    if (hadRecord) {
      let still = false;
      try { still = !!(await idbGet('threads', thread.id)); } catch (_) {}
      check(still, 'the chat stays in browser storage until the window closes (so a crash cannot lose it)');
    } else {
      log('INFO', 'F8', 'browser storage is not IndexedDB here, or the save had not landed; skipped the storage check');
    }
    await clickUndo();
    const back = state.threads.findIndex(t => t.id === thread.id);
    check(back === 0 && state.activeThreadId === thread.id && thread.messages.length === 2,
      'UNDO brings the chat back to its place, open again, with its messages');
    check(!!document.querySelector(`[data-thread-id="${CSS.escape(thread.id)}"]`), 'and it is in the sidebar again');

    // ── The window closes by itself ─────────────────────────────────────────
    deleteMessage(1);
    log('INFO', 'F8', 'waiting out the 10-second window once...');
    await wait(10400);
    check(!shown() && !undoHoldsSync() && undoLast() === false && thread.messages.length === 1,
      'after 10 s the toast goes, the delete is final, and UNDO has nothing to take back');

    // ── Characters and memory files ─────────────────────────────────────────
    openCharacters();
    copyCard(state.activeCardId);
    const card = state.characterCards[state.characterCards.length - 1];
    made.card = card.id;
    state._cardCodeStore = state._cardCodeStore || {};
    state._cardCodeStore[card.id] = { probe: 1 };
    editCard(card.id);
    const put = memoryPutFile([], 'undo-probe.md', 'probe text');
    _memoryEditorSet(put.files);
    removeCardMemoryFile(0);
    check(_memoryEditorFiles().length === 0 && /Removed memory file "undo-probe.md"/.test(toastText()),
      'removing a memory file offers UNDO');
    await clickUndo();
    check(_memoryEditorFiles().some(f => f.name === 'undo-probe.md') && /restored/.test(($('card-memory-readout') || {}).textContent || ''),
      'and UNDO puts it back in the editor');

    const cardAt = state.characterCards.findIndex(c => c.id === card.id);
    deleteCard();   // the editor's DELETE
    check(!state.characterCards.some(c => c.id === card.id) && /^Deleted character "/.test(toastText()),
      "deleting a character from its editor offers UNDO");
    check(!!state._cardCodeStore[card.id], "its card-code scratch space is kept until the delete is final");
    await clickUndo();
    check(state.characterCards.findIndex(c => c.id === card.id) === cardAt && state.activeCardId === before.activeCardId,
      'UNDO brings the character back to its place; your active character is unchanged');

    deleteCardById(card.id);   // the list's delete
    check(!state.characterCards.some(c => c.id === card.id) && shown(), 'deleting a character from the list offers UNDO');
    await ctrlZ();
    check(state.characterCards.some(c => c.id === card.id), 'and Ctrl+Z brings it back');

    copyPersona(state.activePersonaId);
    const persona = state.personaCards[state.personaCards.length - 1];
    made.persona = persona.id;
    editPersona(persona.id);
    deletePersona();
    check(!state.personaCards.some(p => p.id === persona.id) && /^Deleted persona "/.test(toastText()),
      'deleting a persona from its editor offers UNDO');
    await clickUndo();
    check(state.personaCards.some(p => p.id === persona.id) && state.activePersonaId === before.activePersonaId,
      'UNDO brings the persona back; your active persona is unchanged');
    deletePersonaById(persona.id);
    check(!state.personaCards.some(p => p.id === persona.id) && shown(), 'deleting a persona from the list offers UNDO');
    await clickUndo();
    check(state.personaCards.some(p => p.id === persona.id), 'and UNDO brings it back');
    closeCharacters();

    // ── Macros, schedules ──────────────────────────────────────────────────
    state.macros = state.macros || [];
    state.macros.push({ trigger: made.macro, text: 'probe' });
    saveState();
    const nativeConfirm = window.confirm;
    let asked = false;
    window.confirm = () => { asked = true; return true; };
    try { deleteMacro(made.macro); } finally { window.confirm = nativeConfirm; }
    check(!asked && !state.macros.some(m => m.trigger === made.macro) && /Deleted macro \{\{undo_probe_179\}\}/.test(toastText()),
      'deleting a macro no longer asks "are you sure"; it offers UNDO');
    await clickUndo();
    check(state.macros.some(m => m.trigger === made.macro), 'and UNDO brings it back');

    const later = new Date(Date.now() + 3 * 3600e3);
    const hhmm = String(later.getHours()).padStart(2, '0') + ':' + String(later.getMinutes()).padStart(2, '0');
    made.sched = generateId();
    state.schedules = state.schedules || [];
    state.schedules.push({ id: made.sched, time: hhmm, prompt: 'Undo probe', threadId: thread.id, recurring: 'none', useSearch: false, lastFired: null });
    saveState();
    // Scheduled messages ask first instead of offering UNDO.
    {
      const nativeAsk2 = window.confirm;
      let askedSched = 0;
      try {
        window.confirm = () => { askedSched++; return false; };
        deleteSched(made.sched);
        check(askedSched === 1 && state.schedules.some(s => s.id === made.sched) && !shown(),
          'deleting a scheduled message asks first; "Cancel" keeps it');
      } finally { window.confirm = nativeAsk2; }
    }

    // ── Extensions (a draft) and backups (the server) ──────────────────────
    openExtensions();
    addExtEntry('styles');
    const entry = _extDraft.styles[_extDraft.styles.length - 1];
    entry.name = 'undo-probe.css';
    renderExtEntries();
    removeExtEntry('styles', entry.id);
    check(!_extDraft.styles.some(e => e.id === entry.id) && /Removed stylesheet "undo-probe.css"/.test(toastText()),
      'removing an extension entry offers UNDO');
    await clickUndo();
    check(_extDraft.styles.some(e => e.id === entry.id), 'and UNDO puts it back in the panel');
    removeExtEntry('styles', entry.id);
    closeExtensions();
    check(!undoHoldsSync() && !shown() && JSON.stringify(state.extensions || null) === before.extensions,
      'closing the panel makes the removal final, and your saved extensions are untouched');

    const fake = 'zz-undo-probe';
    await onDeleteSyncProfile(fake, fake, false);
    check(_syncProfilesPendingDelete.has(fake) && /^Deleted backup "zz-undo-probe"/.test(toastText()),
      'deleting a server backup offers UNDO and hides the row; nothing is sent yet');
    await clickUndo();
    check(!_syncProfilesPendingDelete.has(fake), 'and UNDO keeps the backup (the server was never asked)');

    // ── Only one at a time ─────────────────────────────────────────────────
    deleteMacro(made.macro);
    deleteFolder(made.folder);
    check(!state.macros.some(m => m.trigger === made.macro) && /Deleted folder/.test(toastText()),
      'a second delete makes the first one final; the toast is for the newest');
    await clickUndo();
    check(state.folders.some(f => f.id === made.folder) && !state.macros.some(m => m.trigger === made.macro),
      'UNDO then takes back only the newest');
    made.macro = null;
  } catch (e) {
    log('FAIL', 'F8', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    // Remove every probe for good, then put your view back.
    try { commitPendingUndo(); } catch (_) {}
    try {
      if (made.sched) state.schedules = state.schedules.filter(s => s.id !== made.sched);
      if (made.macro) state.macros = (state.macros || []).filter(m => m.trigger !== made.macro);
      if (made.persona) state.personaCards = state.personaCards.filter(p => p.id !== made.persona);
      if (made.card) {
        state.characterCards = state.characterCards.filter(c => c.id !== made.card);
        if (state._cardCodeStore) delete state._cardCodeStore[made.card];
        if (!before.hadCodeStore && state._cardCodeStore && !Object.keys(state._cardCodeStore).length) delete state._cardCodeStore;
      }
      if (made.folder) {
        state.folders = state.folders.filter(f => f.id !== made.folder);
        for (const t of state.threads) if (t.folderId === made.folder) t.folderId = null;
      }
      if (made.thread) {
        state.threads = state.threads.filter(t => t.id !== made.thread);
        if (typeof STORAGE_BACKEND !== 'undefined' && STORAGE_BACKEND === 'idb') { try { await idbDelete('threads', made.thread); } catch (_) {} }
      }
      if (before.activeThreadId == null || state.threads.some(t => t.id === before.activeThreadId)) state.activeThreadId = before.activeThreadId;
      state.activeCardId = before.activeCardId;
      state.activePersonaId = before.activePersonaId;
      try { $('char-modal').classList.remove('open'); $('ext-modal').classList.remove('open'); } catch (_) {}
      if (typeof closePopover === 'function') closePopover();
      saveState();
      render();
      try { renderSchedList(); updateSchedCount(); } catch (_) {}
      try { applyCardCode(); } catch (_) {}
    } catch (e) { log('FAIL', 'F8', 'cleanup threw: ' + (e && e.message)); }
  }

  const now = {
    activeThreadId: state.activeThreadId, activeCardId: state.activeCardId, activePersonaId: state.activePersonaId,
    threads: state.threads.map(t => t.id).join(), folders: (state.folders || []).map(f => f.id).join(),
    cards: state.characterCards.map(c => c.id).join(), personas: state.personaCards.map(p => p.id).join(),
    macros: JSON.stringify(state.macros || []), schedules: (state.schedules || []).map(s => s.id).join(),
    extensions: JSON.stringify(state.extensions || null),
    hadCodeStore: Object.prototype.hasOwnProperty.call(state, '_cardCodeStore'),
  };
  const drift = Object.keys(before).filter(k => before[k] !== now[k]);
  check(!drift.length, 'everything the check made is gone, and your chats, characters and settings are as they were' +
    (drift.length ? ' -- changed: ' + drift.join(', ') : ''));
  check(!undoHoldsSync() && !shown(), 'nothing is left waiting on UNDO');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 9: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
