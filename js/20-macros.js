/* @gobbonet-split js/20-macros.js
   Moved verbatim from chat.html lines 11555-11702.
   custom macros
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CUSTOM MACROS — CRUD
================================================================ */
let _editingMacroTrigger = null; // null = new macro, string = editing existing

function renderMacroList() {
  const list = document.getElementById('macro-list');
  if (!list) return;
  const macros = state.macros || [];
  if (macros.length === 0) {
    list.innerHTML = '<div class="ext-status-empty">// no custom macros — add one below</div>';
    return;
  }
  list.innerHTML = macros.map(m => `
    <div class="macro-row">
      <span class="macro-trigger">{{${escapeHtml(m.trigger)}}}</span>
      <span class="macro-preview">${escapeHtml(m.text.length > 64 ? m.text.slice(0, 61) + '...' : m.text)}</span>
      <div class="macro-actions">
        <button class="btn btn-sm" onclick="editMacro('${escapeJsAttr(m.trigger)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMacro('${escapeJsAttr(m.trigger)}')">Del</button>
      </div>
    </div>
  `).join('');
}

function showMacroEditor(triggerName) {
  _editingMacroTrigger = triggerName || null;
  const triggerInput = document.getElementById('macro-trigger');
  const textInput    = document.getElementById('macro-text');
  if (triggerName) {
    const m = (state.macros || []).find(x => x.trigger === triggerName);
    triggerInput.value    = m ? m.trigger : '';
    triggerInput.readOnly = true; // trigger is the key — rename = delete + add
    textInput.value       = m ? m.text : '';
  } else {
    triggerInput.value    = '';
    triggerInput.readOnly = false;
    textInput.value       = '';
  }
  document.getElementById('macro-editor').style.display = '';
  document.getElementById('macro-add-btn').style.display = 'none';
  updateMacroPreview();
  triggerInput.focus();
}

/** The name someone meant when they typed a trigger (1.8.0, issue #69).
 *  People type a macro the way they will use it -- {{skip}}, or {{SYSTEM:}}
 *  copied from the 1.7.9 notes -- so one pair of braces and a trailing colon
 *  are taken off rather than refused. Only one pair: {{{{x}}}} is still a
 *  mistake. What is left goes through the same checks as before. */
function normaliseTrigger(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (t.startsWith('{{')) t = t.slice(2);
  if (t.endsWith('}}')) t = t.slice(0, -2);
  t = t.trim();
  if (t.endsWith(':')) t = t.slice(0, -1);
  return t.trim();
}

const MACRO_TRIGGER_RE = /^[a-zA-Z0-9_]+$/;

/** One line under the name field when it will be saved differently from how
 *  it was typed, so the braces coming off is never a surprise. Silent when
 *  the name is already bare, or when it would be refused anyway. */
function updateMacroTriggerNote() {
  const note = document.getElementById('macro-trigger-note');
  if (!note) return;
  const typed = (document.getElementById('macro-trigger').value || '').trim();
  const name = normaliseTrigger(typed);
  if (name && name !== typed && MACRO_TRIGGER_RE.test(name)) {
    note.textContent = 'Saves as {{' + name + '}}. Type the word only; the braces are added for you.';
    note.hidden = false;
  } else {
    note.textContent = '';
    note.hidden = true;
  }
}

/** Under the editor: what {{name: some text}} would become, as the model
 *  gets it, so passing text to a macro (1.7.9) explains itself. */
function updateMacroPreview() {
  updateMacroTriggerNote();
  const out = document.getElementById('macro-preview');
  if (!out) return;
  const name = normaliseTrigger(document.getElementById('macro-trigger').value) || 'name';
  const text = document.getElementById('macro-text').value || '';
  if (!text.trim()) { out.textContent = ''; return; }
  MACRO_INPUT_RE.lastIndex = 0;
  const sample = MACRO_INPUT_RE.test(text) && /\{\{\s*input[1-9]\s*\}\}/i.test(text) ? 'first | second' : 'your text here';
  out.textContent = 'Preview \u2014 {{' + name + ': ' + sample + '}} becomes:\n' + macroExpand({ text }, sample);
}

function editMacro(trigger) {
  showMacroEditor(trigger);
}

function saveMacroEdit() {
  const field   = document.getElementById('macro-trigger');
  const trigger = normaliseTrigger(field.value);
  const text    = document.getElementById('macro-text').value.trim();
  // Show the name that is actually checked and saved, so a refusal below
  // talks about what is in the box (issue #69).
  if (!field.readOnly && field.value !== trigger) {
    field.value = trigger;
    updateMacroTriggerNote();
  }

  if (!trigger) { alert('Trigger name cannot be empty.'); return; }
  if (!MACRO_TRIGGER_RE.test(trigger)) {
    alert('Trigger may only contain letters, numbers, and underscores. Enter the name without braces.\nExample: rosebud becomes {{rosebud}}');
    return;
  }
  if (RESERVED_MACROS.has(trigger.toLowerCase())) {
    alert(`"{{${trigger}}}" is a built-in macro and cannot be overridden.`);
    return;
  }
  if (!text) { alert('Expansion text cannot be empty.'); return; }

  if (!state.macros) state.macros = [];

  if (_editingMacroTrigger) {
    // Update text of existing macro
    const m = state.macros.find(x => x.trigger === _editingMacroTrigger);
    if (m) m.text = text;
  } else {
    // New macro — guard against duplicate trigger names
    if (state.macros.find(x => x.trigger.toLowerCase() === trigger.toLowerCase())) {
      alert(`A macro named "{{${trigger}}}" already exists. Edit it to change its text.`);
      return;
    }
    state.macros.push({ trigger, text });
  }

  saveState();
  cancelMacroEdit();
  renderMacroList();
}

function cancelMacroEdit() {
  _editingMacroTrigger = null;
  document.getElementById('macro-editor').style.display = 'none';
  document.getElementById('macro-add-btn').style.display = '';
  document.getElementById('macro-trigger').readOnly = false;
  const note = document.getElementById('macro-trigger-note');
  if (note) { note.textContent = ''; note.hidden = true; }
}

function deleteMacro(trigger) {
  // No confirm any more (1.7.9): it said "This cannot be undone", and now it can.
  const list = state.macros || [];
  const at = list.findIndex(m => m.trigger === trigger);
  if (at < 0) return;
  const macro = list[at];
  state.macros = list.filter(m => m.trigger !== trigger);
  saveState();
  renderMacroList();
  undoable({
    label: 'Deleted macro {{' + String(trigger).slice(0, 30) + '}}',
    undo: () => {
      state.macros = state.macros || [];
      if (!state.macros.some(m => m.trigger === trigger)) state.macros.splice(Math.min(at, state.macros.length), 0, macro);
      renderMacroList();
    },
  });
}

function updateExtStatusLabel() {
  const enabled = document.getElementById('ext-enabled').checked;
  const label = document.getElementById('ext-toggle-label');
  if (label) label.textContent = enabled ? 'Enabled' : 'Disabled';
}

/** Preview all inline CSS from the draft stylesheets — live, without saving. */
function previewExtCSS() {
  syncExtDraftFromDOM();
  // Remove any existing preview tags
  document.querySelectorAll('.gobbonet-ext-preview').forEach(el => el.remove());
  const combined = (_extDraft.styles || [])
    .map(e => e.raw || '')
    .filter(s => s.trim())
    .join('\n\n');
  if (!combined.trim()) return;
  const style = document.createElement('style');
  style.className = 'gobbonet-ext-preview';
  style.textContent = combined;
  document.head.appendChild(style);
}

/** Build the "currently loaded extensions" status list in the modal */
function renderExtStatusList() {
  const list = document.getElementById('ext-status-list');
  if (!list) return;
  const loaded = document.querySelectorAll('.gobbonet-ext');
  if (loaded.length === 0) {
    list.innerHTML = '<div class="ext-status-empty">// no extensions currently applied</div>';
    return;
  }
  list.innerHTML = Array.from(loaded).map(el => {
    const type = el.getAttribute('data-ext-type') || el.tagName.toLowerCase();
    const name = el.getAttribute('data-ext-name') || '';
    const src = el.src || el.href || '(inline)';
    const len = el.textContent ? ` — ${el.textContent.length} chars` : '';
    const typeLabel = {
      'css-url': '&#127912; CSS URL',
      'css-raw': '&#127912; CSS inline',
      'js-url':  '&#9889; Script URL',
      'js-raw':  '&#9889; Script inline'
    }[type] || type;
    const srcText = src === '(inline)' ? '(inline)' + len : src;
    const label = name ? `${escapeHtml(name)} — ${escapeHtml(srcText)}` : escapeHtml(srcText);
    return `<div class="ext-status-item">
      <span class="ext-status-type">${typeLabel}</span>
      <span class="ext-status-src">${label}</span>
    </div>`;
  }).join('');
}

