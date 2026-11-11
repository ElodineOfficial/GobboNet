/* @gobbonet-split js/17-personas.js
   Moved verbatim from chat.html lines 10516-10767.
   personas, {{char}} / {{user}} translation
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   PERSONAS — character cards for {{user}}
   Mirror of the character card system. Stores name/avatar/colors and
   a description that gets injected as a system message every N user
   messages (see buildContextMessages for the injection cadence).
================================================================ */
let editingPersonaId = null;

function renderPersonaGrid() {
  const grid = document.getElementById('persona-grid');
  if (!grid) return;
  if (!Array.isArray(state.personaCards) || state.personaCards.length === 0) {
    grid.innerHTML = '<div class="landing-empty" style="padding:10px 4px;">No personas yet. Click below to add one.</div>';
    return;
  }
  const total = state.personaCards.length;
  grid.innerHTML = state.personaCards.map((p, i) => {
    const av = renderAvatar(p.avatar, p.name);
    const freq = (typeof p.injectionFrequency === 'number') ? p.injectionFrequency : 5;
    const freqLabel = freq === 0
      ? 'description silent'
      : freq === 1
        ? 'shared every turn'
        : `shared every ${freq} msgs`;
    const desc = (p.description || '').trim();
    const subline = desc
      ? `${escapeHtml(desc.slice(0, 50))}${desc.length > 50 ? '\u2026' : ''} \u00b7 ${freqLabel}`
      : freqLabel;
    return `
    <div class="card-item ${p.id === state.activePersonaId ? 'active' : ''}" onclick="activatePersona('${escapeJsAttr(p.id)}')">
      ${moveColumnHtml(p.id, p.name, i, total, 'movePersona')}
      <div class="card-avatar">${av}</div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(p.name || 'Unnamed')}</div>
        <div class="card-desc">${subline}</div>
      </div>
      <div class="card-actions">
        <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editPersona('${escapeJsAttr(p.id)}')">Edit</button>
        <button class="msg-action-btn" onclick="event.stopPropagation();copyPersona('${escapeJsAttr(p.id)}')" title="Duplicate this persona">Copy</button>
        ${state.personaCards.length > 1 ? `<button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deletePersonaById('${escapeJsAttr(p.id)}')" title="Delete this persona">Del</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* Reorder engine is shared with character cards — see moveCastEntry() in
   js/15-cards.js, which loads first. Array position is the order here too:
   personaCards persists as an array in the same blob, so nothing extra is
   needed to make it stick. */
function movePersona(id, delta, btn) {
  moveCastEntry(state.personaCards, id, delta, 'persona-grid', renderPersonaGrid, btn);
}

function activatePersona(id) {
  state.activePersonaId = id;
  saveState();
  renderPersonaGrid();
  renderMessages();
}

function createPersona() {
  const persona = {
    ...DEFAULT_PERSONA,
    id: generateId(),
    name: 'New Persona',
    description: '',
    injectionFrequency: 5
  };
  state.personaCards.push(persona);
  saveState();
  editPersona(persona.id);
}

function editPersona(id) {
  const persona = state.personaCards.find(p => p.id === id);
  if (!persona) return;
  editingPersonaId = id;
  document.getElementById('persona-name').value = persona.name || '';
  document.getElementById('persona-avatar').value = persona.avatar || '';
  document.getElementById('persona-description').value = persona.description || '';
  const freq = (typeof persona.injectionFrequency === 'number') ? persona.injectionFrequency : 5;
  document.getElementById('persona-frequency').value = freq;
  // Color pickers
  const ptc = persona.textColor   || FALLBACK_PERSONA_TEXT_COLOR;
  const pdc = persona.dialogColor || FALLBACK_PERSONA_DIALOG_COLOR;
  document.getElementById('persona-textcolor').value = ptc;
  document.getElementById('persona-textcolor-hex').value = ptc;
  document.getElementById('persona-dialogcolor').value = pdc;
  document.getElementById('persona-dialogcolor-hex').value = pdc;
  previewPersonaColors();
  // Reveal editor, hide list
  document.getElementById('char-modal-list').style.display = 'none';
  document.getElementById('persona-editor').style.display = '';
  document.getElementById('char-close-row').style.display = 'none';
  document.getElementById('persona-delete-btn').style.display = state.personaCards.length > 1 ? '' : 'none';
  previewAvatar('persona-avatar', 'persona-avatar-preview');
  // Clean snapshot, taken once the fields are populated -- same contract as
  // the character editor. See charEditorOpened in js/22-scheduler.js.
  charEditorOpened();
}

function savePersona() {
  const persona = state.personaCards.find(p => p.id === editingPersonaId);
  if (!persona) return;
  persona.name = document.getElementById('persona-name').value.trim() || 'Anonymous';
  persona.avatar = document.getElementById('persona-avatar').value.trim();
  persona.description = document.getElementById('persona-description').value;
  // Clamp frequency to a sane range. 0 disables injection but keeps identity.
  const rawFreq = parseInt(document.getElementById('persona-frequency').value, 10);
  persona.injectionFrequency = Number.isFinite(rawFreq) ? Math.max(0, Math.min(50, rawFreq)) : 5;
  persona.textColor = document.getElementById('persona-textcolor').value;
  persona.dialogColor = document.getElementById('persona-dialogcolor').value;
  editingPersonaId = null;
  saveState();
  charEditorClosed();
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function cancelPersonaEdit() {
  // Same guard the character editor's Cancel goes through, for the same
  // reason: this is the destructive way out, and it used to be the one that
  // asked nothing.
  if (!charDismissGuard()) return;
  // Discard a freshly-created persona that the user backed out of without
  // touching anything — matches the same nicety we have for character cards.
  const persona = state.personaCards.find(p => p.id === editingPersonaId);
  if (persona && !persona.description && persona.name === 'New Persona') {
    state.personaCards = state.personaCards.filter(p => p.id !== editingPersonaId);
    saveState();
  }
  editingPersonaId = null;
  charEditorClosed();
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function deletePersona() {
  if (state.personaCards.length <= 1) return;
  const _at = state.personaCards.findIndex(p => p.id === editingPersonaId);
  const _persona = state.personaCards[_at];
  const _wasActive = state.activePersonaId === editingPersonaId;
  state.personaCards = state.personaCards.filter(p => p.id !== editingPersonaId);
  if (state.activePersonaId === editingPersonaId) state.activePersonaId = state.personaCards[0].id;
  editingPersonaId = null;
  saveState();
  charEditorClosed();
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
  if (_persona) _offerPersonaUndo(_persona, _at, _wasActive);
}

/** UNDO for a deleted persona (1.7.9). */
function _offerPersonaUndo(persona, at, wasActive) {
  undoable({
    label: 'Deleted persona "' + String(persona.name || 'Unnamed').slice(0, 40) + '"',
    undo: () => {
      if (!state.personaCards.some(p => p.id === persona.id)) {
        state.personaCards.splice(Math.min(at, state.personaCards.length), 0, persona);
      }
      if (wasActive) state.activePersonaId = persona.id;
      renderPersonaGrid(); renderCardGrid();
      try { renderMessages(); } catch (_) {}
    },
  });
}

function copyPersona(id) {
  const src = state.personaCards.find(p => p.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), name: src.name + ' (Copy)' };
  state.personaCards.push(copy);
  saveState();
  renderPersonaGrid();
}

function deletePersonaById(id) {
  if (state.personaCards.length <= 1) return;
  const at = state.personaCards.findIndex(p => p.id === id);
  if (at < 0) return;
  const persona = state.personaCards[at];
  const wasActive = state.activePersonaId === id;
  state.personaCards = state.personaCards.filter(p => p.id !== id);
  if (wasActive) state.activePersonaId = state.personaCards[0].id;
  saveState();
  renderPersonaGrid();
  renderMessages();
  _offerPersonaUndo(persona, at, wasActive);
}

function pickCardBg(color) {
  // Legacy — no longer used
}

function previewBg() {
  const url = document.getElementById('card-bg').value.trim();
  const preview = document.getElementById('card-bg-preview');
  if (url) {
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    preview.innerHTML = '--';
  }
}

function handleBgFile(fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('card-bg').value = e.target.result;
    previewBg();
  };
  reader.readAsDataURL(file);
}

/* ================================================================
   TEMPLATE TRANSLATION — {{char}} and {{user}}
   Applied to all content sent to the API so character prompts
   can be written with universal placeholders.
   Pass charName/userName explicitly to avoid race conditions
   with async card switching.
================================================================ */
function getCurrentDateTimeString() {
  const now = new Date();
  return now.toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

/**
 * Resolves all user-defined custom macros in text.
 * Called after the hardcoded macros so user macros can't shadow them.
 *
 * A macro can also take text (1.7.9), two ways:
 *   {{SYSTEM: Foo bar baz}}      the text inside the braces
 *   {{SYSTEM:}} Foo bar baz      the rest of that line
 * In the macro's own text, {{input}} is where the passed text goes (as often
 * as it appears), and {{input1}}, {{input2}}... are its parts split at "|".
 * A macro with no {{input}} gets the passed text on a new line after it, so
 * "The following is an out of character directive..." plus {{SYSTEM: ...}}
 * needs nothing new. A plain {{SYSTEM}} still works; its placeholders come
 * out empty. Names are matched without regard to case, as before.
 */
const MACRO_INPUT_RE = /\{\{\s*input(\d?)\s*\}\}/gi;

function macroFind(name) {
  const key = String(name).toLowerCase();
  return (state.macros || []).find(m => m && typeof m.trigger === 'string' && m.trigger.toLowerCase() === key) || null;
}

/** One macro's expansion with the text passed to it ('' for the plain form). */
function macroExpand(macro, input) {
  const text = String(macro.text || '');
  const arg = String(input || '').trim();
  const parts = arg.split('|').map(s => s.trim());
  MACRO_INPUT_RE.lastIndex = 0;
  if (MACRO_INPUT_RE.test(text)) {
    return text.replace(MACRO_INPUT_RE, (_, n) => n ? (parts[Number(n) - 1] || '') : arg);
  }
  return arg ? text + '\n' + arg : text;
}

function resolveMacros(text) {
  if (!text || !state.macros || !state.macros.length) return text;
  // 1. Plain {{name}}, as before -- first, so a plain macro can sit inside
  //    the text passed to another ({{SYSTEM: {{continue}}}}).
  for (const macro of state.macros) {
    if (!macro || typeof macro.trigger !== 'string') continue;
    const escaped = macro.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\{\\{' + escaped + '\\}\\}', 'gi');
    text = text.replace(re, () => macroExpand(macro, ''));
  }
  // 2. {{name:}} rest of the line.
  text = text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*:\s*\}\}[ \t]*([^\n]*)/g, (whole, name, rest) => {
    const m = macroFind(name);
    return m ? macroExpand(m, rest) : whole;
  });
  // 3. {{name: text}}, which may run over several lines.
  text = text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*:([\s\S]*?)\}\}/g, (whole, name, arg) => {
    const m = macroFind(name);
    return m ? macroExpand(m, arg) : whole;
  });
  return text;
}

function translateTemplates(text, charName, userName, forDisplay) {
  if (!text) return text;
  charName = charName || (getActiveCard().name) || 'Assistant';
  userName = userName || getActivePersona().name || 'Anonymous';

  // Identity/time built-ins always resolve — the user wants to *see* the
  // real name and date filled in, in both the bubble and the model context.
  let out = text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{current_DAT\}\}/gi, getCurrentDateTimeString());

  // Display mode: leave user-defined macros and {{auto_continue}} as their
  // short tag form. The user already knows what a macro expands to, so the
  // bubble stays compact instead of dumping the full long-form prompt. The
  // model still receives the full expansion (forDisplay is false on the
  // context-build path), so behavior is unchanged for the LLM.
  if (forDisplay) return out;

  // Model path: expand everything. {{auto_continue}}/{{auto_continue_N}} →
  // full chain prompt; then user-defined macros. A macro's own text may use
  // {{char}}, {{user}} and {{current_DAT}} too (1.7.9; before, they reached
  // the model as typed), so those are filled in once more afterwards.
  return resolveMacros(
    out.replace(/\{\{auto_continue(?:_\d+)?\}\}/gi, AUTO_CONTINUE_TEXT)
  ).replace(/\{\{char\}\}/gi, () => charName)
   .replace(/\{\{user\}\}/gi, () => userName)
   .replace(/\{\{current_DAT\}\}/gi, () => getCurrentDateTimeString());
}

function applyActiveCardBackground() {
  // A group chat wears its first member's background (1.8.0): one that
  // changed with every speaker would flicker through a round.
  const _group = (typeof threadGroup === 'function' && typeof getActiveThread === 'function')
    ? threadGroup(getActiveThread()) : null;
  const card = (_group && typeof groupHostCard === 'function' && groupHostCard(_group)) || getActiveCard();
  const msgArea = document.getElementById('messages');
  if (!msgArea) return;
  // Same gate as avatars and thumbnails. safeImageUrl drops file: and
  // suppresses http(s) unless the user opted in.
  const bg = safeImageUrl(card.background);
  if (bg) {
    // Escape the CSS string delimiters too: a permitted URL can still carry a
    // quote, which would close the url() and steer the request elsewhere.
    const cssSafe = bg.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    msgArea.style.backgroundImage = `url('${cssSafe}')`;
    msgArea.style.backgroundSize = 'cover';
    msgArea.style.backgroundPosition = 'center';
    msgArea.style.backgroundRepeat = 'no-repeat';
    msgArea.style.backgroundColor = 'var(--black)';
  } else {
    msgArea.style.backgroundImage = '';
    msgArea.style.backgroundColor = 'var(--black)';
  }
}

