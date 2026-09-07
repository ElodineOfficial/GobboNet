/* @gobbonet-split js/22-scheduler.js
   Moved verbatim from chat.html lines 11916-12143.
   timed prompts
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SCHEDULER — send prompts at specific times
================================================================ */
let editingSchedId = null;

function openScheduler() {
  editingSchedId = null;
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
  renderSchedList();
  document.getElementById('sched-modal').classList.add('open');
}

function closeScheduler() {
  document.getElementById('sched-modal').classList.remove('open');
}

function renderSchedList() {
  const list = document.getElementById('sched-list');
  if (state.schedules.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--cyan-dim);padding:16px;font-size:13px;">No scheduled prompts.<br>Schedules run while the chat is open.</div>';
    return;
  }
  list.innerHTML = state.schedules.map(s => {
    const thread = state.threads.find(t => t.id === s.threadId);
    const threadName = thread ? escapeHtml(thread.name) : '(deleted thread)';
    const typeLabel = s.recurring === 'daily' ? 'DAILY' : 'ONCE';
    const searchLabel = s.useSearch ? ' 🔍' : '';
    return `
      <div class="card-item" onclick="editSchedItem('${escapeJsAttr(s.id)}')">
        <div class="card-info">
          <div class="card-name">${escapeHtml(s.time)} — ${typeLabel}${searchLabel}</div>
          <div class="card-desc">${escapeHtml(s.prompt.slice(0, 60))} → ${threadName}</div>
        </div>
        <div class="card-actions">
          <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editSchedItem('${escapeJsAttr(s.id)}')">Edit</button>
          <button class="msg-action-btn" onclick="event.stopPropagation();copySched('${escapeJsAttr(s.id)}')" title="Duplicate this schedule">Copy</button>
          <button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deleteSched('${escapeJsAttr(s.id)}')">Del</button>
        </div>
      </div>`;
  }).join('');
}

function createSched() {
  editingSchedId = '__new__';
  document.getElementById('sched-time').value = '';
  document.getElementById('sched-prompt').value = '';
  document.getElementById('sched-recurring').value = 'once';
  document.getElementById('sched-search').value = 'off';

  // Populate thread dropdown.
  //
  // The id is escaped as well as the name. A thread id is generated locally
  // in the normal case, but it is not a value we control: js/21-data.js
  // takes ids verbatim from an imported backup with no validation, and
  // js/06-state-sync.js restores state from /state, which any paired LAN
  // device can write. An id carrying a quote would close the value=""
  // attribute and everything after it becomes markup.
  const sel = document.getElementById('sched-thread');
  sel.innerHTML = state.threads.map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === state.activeThreadId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  document.getElementById('sched-editor').style.display = '';
  document.getElementById('sched-footer').style.display = 'none';
}

function editSchedItem(id) {
  const s = state.schedules.find(x => x.id === id);
  if (!s) return;
  editingSchedId = id;
  document.getElementById('sched-time').value = s.time;
  document.getElementById('sched-prompt').value = s.prompt;
  document.getElementById('sched-recurring').value = s.recurring || 'once';
  document.getElementById('sched-search').value = s.useSearch ? 'on' : 'off';

  // Same escaping as createSched above, same reason.
  const sel = document.getElementById('sched-thread');
  sel.innerHTML = state.threads.map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === s.threadId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  document.getElementById('sched-editor').style.display = '';
  document.getElementById('sched-footer').style.display = 'none';
}

function saveSched() {
  const time = document.getElementById('sched-time').value;
  const prompt = document.getElementById('sched-prompt').value.trim();
  const threadId = document.getElementById('sched-thread').value;
  const recurring = document.getElementById('sched-recurring').value;
  const useSearch = document.getElementById('sched-search').value === 'on';

  if (!time || !prompt || !threadId) return;

  if (editingSchedId === '__new__') {
    state.schedules.push({
      id: generateId(),
      time,
      prompt,
      threadId,
      recurring,
      useSearch,
      lastFired: null
    });
  } else {
    const s = state.schedules.find(x => x.id === editingSchedId);
    if (s) {
      s.time = time;
      s.prompt = prompt;
      s.threadId = threadId;
      s.recurring = recurring;
      s.useSearch = useSearch;
    }
  }

  editingSchedId = null;
  saveState();
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
  renderSchedList();
  updateSchedCount();
}

function cancelSchedEdit() {
  editingSchedId = null;
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
}

function deleteSched(id) {
  state.schedules = state.schedules.filter(s => s.id !== id);
  saveState();
  renderSchedList();
  updateSchedCount();
}

function copySched(id) {
  const src = state.schedules.find(s => s.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), lastFired: null };
  state.schedules.push(copy);
  saveState();
  renderSchedList();
  updateSchedCount();
}

function updateSchedCount() {
  const el = document.getElementById('sched-count');
  if (el) el.textContent = state.schedules.length > 0 ? `(${state.schedules.length})` : '';
}

// Timer: checks every 30s if any schedule is due
function checkSchedules() {
  if (isGenerating || !serverConnected) return;

  const now = new Date();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const today = now.toDateString();

  for (const s of state.schedules) {
    if (s.time !== currentTime) continue;
    if (s.lastFired === today) continue;

    // Time match and hasn't fired today — execute
    const thread = state.threads.find(t => t.id === s.threadId);
    if (!thread) continue;

    s.lastFired = today;

    // Switch to the target thread
    state.activeThreadId = s.threadId;

    // Inject the prompt as a user message
    thread.messages.push({ role: 'user', content: s.prompt, timestamp: Date.now(), scheduled: true,
                           personaId: getActivePersona().id });

    // Auto-name if first message
    if (thread.messages.length === 1) {
      thread.name = s.prompt.slice(0, 50) + (s.prompt.length > 50 ? '...' : '');
    }

    saveState();
    render();
    scrollToBottom();

    // Send to AI (with optional search)
    const schedRef = s;
    (async () => {
      await regenerateFromThread({ withSearch: schedRef.useSearch });
      // Remove one-time schedules after firing
      if (schedRef.recurring !== 'daily') {
        state.schedules = state.schedules.filter(x => x.id !== schedRef.id);
        saveState();
        updateSchedCount();
      }
    })();

    break; // Only fire one per check cycle
  }
}

// Close modals
// Close popover on outside click
document.addEventListener('click', e => {
  if (_popover && !_popover.contains(e.target)) closePopover();
});

document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') closeSettings();
});
/* ── Character modal: sticky, dblclick to exit, button-only on touch ──
 *
 * The other modals above keep single-click-outside-to-close. This one does
 * not, because it is the one holding a long editing form: a stray click on
 * the backdrop while writing a character's personality used to discard the
 * modal, and the editor's fields go with it.
 *
 * WHY NOT matchMedia('(pointer: coarse)'), which is the obvious answer:
 * that reports the PRIMARY pointer, so a touchscreen laptop with a trackpad
 * reports 'fine' and would get mouse behaviour for finger taps -- the exact
 * device the requirement calls out. '(any-pointer: coarse)' has the mirror
 * problem: it is true for a laptop with a touchscreen the user never uses,
 * which would then refuse to close by mouse.
 *
 * The event knows better than the device does. pointerdown carries the
 * pointerType of the actual interaction, so a finger and a mouse on the SAME
 * machine get the right behaviour each time, with no guessing. The media
 * query survives only as a backstop for a device with no fine pointer at
 * all, in case a dblclick somehow arrives from a double-tap.
 */
let _charBackdropPointer = 'mouse';
(function initCharModalDismiss() {
  const backdrop = document.getElementById('char-modal');
  if (!backdrop) return;

  backdrop.addEventListener('pointerdown', (e) => {
    _charBackdropPointer = e.pointerType || 'mouse';
  }, true);

  backdrop.addEventListener('dblclick', (e) => {
    // Backdrop only. A double-click inside the modal is someone selecting a
    // word in a textarea, which must never close anything.
    if (e.target.id !== 'char-modal') return;

    // No fine pointer anywhere on this device: phone or tablet. The close
    // button is the only way out, by design.
    if (window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches) return;

    // A fine pointer exists, but this particular interaction was a finger.
    if (_charBackdropPointer === 'touch') return;

    closeCharacters();
  });
})();
document.getElementById('sched-modal').addEventListener('click', (e) => {
  if (e.target.id === 'sched-modal') closeScheduler();
});
document.getElementById('ext-modal').addEventListener('click', (e) => {
  if (e.target.id === 'ext-modal') closeExtensions();
});
document.getElementById('data-modal').addEventListener('click', (e) => {
  if (e.target.id === 'data-modal') closeDataManager();
});
document.getElementById('about-modal').addEventListener('click', (e) => {
  if (e.target.id === 'about-modal') closeAbout();
});
/* Is one of the character modal's editors open, as opposed to the list view?
   Both are toggled by style.display ('' open, 'none' closed), so this reads
   the same state the code that sets it does. */
function _charEditorIsOpen() {
  const shown = (id) => {
    const el = document.getElementById(id);
    return !!el && el.style.display !== 'none';
  };
  return shown('card-editor') || shown('persona-editor');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSettings();
  // Sticky applies to Escape too, but only while an editor is open.
  //
  // Escape is a deliberate keypress rather than a stray click, so it is not
  // obviously in scope. It lands on the same data loss though:
  // closeCharacters() saves nothing and openCharacters() rebuilds the list
  // view, so a half-written character is simply gone. And Escape is easy to
  // press by accident in a long textarea -- dismissing an autocomplete, or
  // leaving a browser find bar.
  //
  // Closing from the LIST view costs nothing, so that still works, and every
  // other modal is untouched.
  if (!_charEditorIsOpen()) closeCharacters();
  closeScheduler(); closeExtensions(); closeDataManager(); closeAbout();
});

function openAbout() {
  document.getElementById('about-modal').classList.add('open');
}
function closeAbout() {
  document.getElementById('about-modal').classList.remove('open');
}

