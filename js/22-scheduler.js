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
 *
 * ── TWO RULES, NOT ONE ───────────────────────────────────────────────
 *
 * Sticky used to be the whole mechanism, and it was doing two jobs badly:
 *
 *   STICKY decides whether a CASUAL gesture may dismiss -- a single backdrop
 *   click, or Escape. It is a user setting (state.settings.stickyCards),
 *   because whether a stray click should cost you the modal is taste.
 *
 *   THE GUARD decides whether ANY dismissal may destroy work. It is not a
 *   setting, because losing a half-written character is not taste. It only
 *   speaks up when the editor actually has unsaved changes, so a user who
 *   turns sticky off and closes an untouched editor sees no friction at all.
 *
 * Separating them fixes two things that were wrong before.
 *
 * The old rule refused EVERY dismissal while an editor was open, whether or
 * not anything was at stake -- so opening a card to read it and clicking away
 * was blocked for nothing. And it refused them SILENTLY: the click did not
 * close the modal and did not say why, which is also why nobody ever
 * discovered that double-click was the way out. That is what _charNotice is
 * for.
 *
 * The second is worse. Escape and the backdrop were both blocked to protect
 * unsaved edits -- and then the Cancel button inside the editor discarded
 * them without asking. The protection had a hole in it that the UI pointed
 * at. cancelCardEdit() and cancelPersonaEdit() now go through the same guard,
 * which is the point of having one.
 */
let _charBackdropPointer = 'mouse';
let _charEditorClean = null;
let _charNoticeTimer = null;

(function initCharModalDismiss() {
  const backdrop = document.getElementById('char-modal');
  if (!backdrop) return;

  backdrop.addEventListener('pointerdown', (e) => {
    _charBackdropPointer = e.pointerType || 'mouse';
  }, true);

  backdrop.addEventListener('click', (e) => {
    // Backdrop only. A click inside the modal is someone using the form.
    if (e.target.id !== 'char-modal') return;

    if (charStickyEnabled()) {
      // Not a dismissal -- but say so, rather than doing nothing. A silent
      // no-op is indistinguishable from a broken modal, and it is why the
      // double-click affordance was invisible.
      _charNotice(_charDismissHint());
      return;
    }

    // Sticky off: behave like every other modal, but never eat unsaved work.
    if (!charDismissGuard()) return;
    _charNoticeClear();
    closeCharacters();
  });

  backdrop.addEventListener('dblclick', (e) => {
    // Backdrop only. A double-click inside the modal is someone selecting a
    // word in a textarea, which must never close anything.
    if (e.target.id !== 'char-modal') return;

    // Sticky off: the click handler above already dealt with the first of
    // these two clicks. Doing it again here would run the guard twice and
    // show the confirm a second time over an already-closed modal.
    if (!charStickyEnabled()) return;

    // No fine pointer anywhere on this device: phone or tablet. The close
    // button is the only way out, by design.
    if (window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches) return;

    // A fine pointer exists, but this particular interaction was a finger.
    if (_charBackdropPointer === 'touch') return;

    if (!charDismissGuard()) return;
    _charNoticeClear();
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
/* Which of the character modal's two editors is open, if either. Both are
   toggled by style.display ('' open, 'none' closed), so this reads the same
   state the code that sets it does. */
function _charEditorEl() {
  const ids = ['card-editor', 'persona-editor'];
  for (let i = 0; i < ids.length; i++) {
    const el = document.getElementById(ids[i]);
    if (el && el.style && el.style.display !== 'none') return el;
  }
  return null;
}

/* Is one of the character modal's editors open, as opposed to the list view? */
function _charEditorIsOpen() {
  return !!_charEditorEl();
}

/* Sticky governs casual dismissal only -- see the long comment above.
   `!== false` rather than a truthy test, so a settings blob saved before this
   option existed keeps the behaviour it already had instead of silently
   switching to click-to-dismiss on upgrade. */
function charStickyEnabled() {
  return !(typeof state !== 'undefined' && state && state.settings &&
           state.settings.stickyCards === false);
}

/* A fingerprint of everything the open editor currently holds.
 *
 * Deliberately generic -- every input, textarea and select inside the editor,
 * by id -- rather than a hand-written list of the forty-odd fields the card
 * editor has today. A hand-written list is a list that goes stale the next
 * time a field is added, and it goes stale SILENTLY: the new field simply
 * stops counting as unsaved work, which is the one failure this whole
 * mechanism exists to prevent. Reading the DOM means a field added tomorrow
 * is protected the day it lands, with no second place to remember.
 *
 * File inputs are skipped. Their .value is a synthetic c:\fakepath\... string
 * that says nothing about the data, and picking a file writes the real value
 * into the text field beside it -- which IS captured, so counting both would
 * only double-count.
 */
function _charEditorFingerprint() {
  const ed = _charEditorEl();
  if (!ed || typeof ed.querySelectorAll !== 'function') return null;
  const fields = ed.querySelectorAll('input, textarea, select');
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.type === 'file') continue;
    const val = (f.type === 'checkbox' || f.type === 'radio')
      ? (f.checked ? '1' : '0')
      : String(f.value == null ? '' : f.value);
    parts.push((f.id || ('#' + i)) + '\u0000' + val);
  }
  return parts.join('\u0001');
}

/* Called by 15-cards.js / 17-personas.js as the editors open and close. The
   snapshot is taken AFTER the fields are populated, so "clean" means "exactly
   as loaded" -- a freshly created card the user has not touched is clean, and
   backing out of it costs no confirm. */
function charEditorOpened() { _charEditorClean = _charEditorFingerprint(); }
function charEditorClosed() { _charEditorClean = null; }

function charEditorIsDirty() {
  if (_charEditorClean === null) return false;
  const now = _charEditorFingerprint();
  return now !== null && now !== _charEditorClean;
}

/* The name in the open editor, for the confirm text. Asking "discard your
   changes?" is a weaker question than naming what is about to be lost. */
function _charEditorName() {
  const ed = _charEditorEl();
  if (!ed) return '';
  const id = ed.id === 'persona-editor' ? 'persona-name' : 'card-name';
  const el = document.getElementById(id);
  const v = el && el.value ? String(el.value).trim() : '';
  return v;
}

/* The one gate every dismissal passes through. Returns true to proceed.
 *
 * Not a setting, and deliberately so. Sticky is taste; silently destroying a
 * half-written character is not. It stays quiet unless there is something to
 * lose, which is what makes it cheap enough to put on every path.
 */
function charDismissGuard() {
  if (!charEditorIsDirty()) return true;
  const ed = _charEditorEl();
  // A brand-new card can genuinely have an empty name field, and "discard
  // changes to this character" is wrong when the thing being discarded is a
  // persona.
  const noun = (ed && ed.id === 'persona-editor') ? 'persona' : 'character';
  const name = _charEditorName();
  const who = name ? '"' + name + '"' : 'this ' + noun;
  return confirm('Discard unsaved changes to ' + who + '?\n\nSAVE keeps them.');
}

/* Say why a dismissal was refused, and how to actually leave.
 *
 * The hint is chosen from the interaction, not the device, for the same
 * reason the dismiss rule is: a touchscreen laptop needs to tell a finger and
 * a mouse different things, and it is the pointer that knows which one just
 * arrived. */
function _charDismissHint() {
  const noFine = !!(window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches);
  const touch = _charBackdropPointer === 'touch' || noFine;
  if (_charEditorIsOpen()) {
    return touch
      ? 'Still editing \u2014 use CANCEL or SAVE below to leave.'
      : 'Still editing \u2014 double-click here to leave, or use CANCEL / SAVE.';
  }
  return touch ? 'Tap CLOSE below to leave.' : 'Double-click the backdrop to close.';
}

function _charNotice(msg) {
  const el = document.getElementById('char-dismiss-notice');
  if (!el) return;
  el.textContent = msg;
  if (el.classList) el.classList.add('show');
  if (_charNoticeTimer) clearTimeout(_charNoticeTimer);
  _charNoticeTimer = setTimeout(() => {
    if (el.classList) el.classList.remove('show');
    _charNoticeTimer = null;
  }, 3400);
}

function _charNoticeClear() {
  const el = document.getElementById('char-dismiss-notice');
  if (el && el.classList) el.classList.remove('show');
  if (_charNoticeTimer) { clearTimeout(_charNoticeTimer); _charNoticeTimer = null; }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSettings();
  // Escape is a casual gesture, so sticky governs it.
  //
  // It is a deliberate keypress rather than a stray click, so it is not
  // obviously in scope. It lands on the same data loss though:
  // closeCharacters() saves nothing and openCharacters() rebuilds the list
  // view, so a half-written character is simply gone. And Escape is easy to
  // press by accident in a long textarea -- dismissing an autocomplete, or
  // leaving a browser find bar.
  //
  // Closing from the LIST view costs nothing, so that still works whatever
  // sticky says, and every other modal is untouched.
  if (!_charEditorIsOpen()) {
    closeCharacters();
  } else if (!charStickyEnabled()) {
    if (charDismissGuard()) { _charNoticeClear(); closeCharacters(); }
  } else {
    // Refused -- but not silently. This is the case that used to leave a
    // phone user tapping Escape at a modal that would never respond.
    _charNotice(_charDismissHint());
  }
  closeScheduler(); closeExtensions(); closeDataManager(); closeAbout();
});

/* ================================================================
   ABOUT — "which build am I on?"

   There are two answers and they can disagree, which is the entire reason
   this block exists rather than one line of text.

   The SERVER version comes from the binary, stamped at link time from the
   VERSION file. The PAGE version is baked into js/01-config.js and travels
   with the script the browser actually executed. When a browser is holding a
   cached copy of the frontend, the server cheerfully reports the new release
   while the user is looking at last week's code — and that is
   indistinguishable from a real regression unless something says so out loud.

   So the panel reports both, and says plainly when they differ.
================================================================ */

// Cached between opens: the health payload changes only when the server
// restarts, and re-fetching on every open would make the panel flicker.
let _aboutHealth = null;
// 'pending' | 'ok' | 'absent'  -- 'absent' means nothing answered, which is a
// different fact from "answered but did not say", and needs a different
// sentence. Serving these files from a plain static file server produces it,
// and "unknown" on its own sends the reader looking for the wrong problem.
let _aboutHealthState = 'pending';

/** The release part of a version string: "1.2.3-go-abc1234" -> "1.2.3". */
function _releaseOf(v) {
  return String(v || '').split('-')[0].trim();
}

/** Compare two release numbers. -1 / 0 / 1, or null if either is not a
 *  release number at all (an unstamped "dev" build, say). */
function _cmpRelease(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

async function _fetchAboutHealth() {
  if (_aboutHealthState === 'ok' || !IS_SERVED) return _aboutHealth;
  try {
    const resp = await fetch(window.location.origin + '/health-fileserver', { cache: 'no-store' });
    if (resp.ok) {
      _aboutHealth = await resp.json();
      _aboutHealthState = 'ok';
    } else {
      _aboutHealthState = 'absent';
    }
  } catch (e) {
    _aboutHealthState = 'absent';
  }
  return _aboutHealth;
}

function renderAboutBuild() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const page = (typeof GOBBONET_UI_VERSION === 'string') ? GOBBONET_UI_VERSION : 'unknown';
  const server = _aboutHealth && _aboutHealth.version ? _aboutHealth.version : '';

  // One number. The server's release when there is one, because that is what a
  // release is named after; the page's otherwise, which is the only thing
  // knowable with no server to ask.
  //
  // The page and server versions used to have a row each. They agree on every
  // healthy install, so two of the three rows were restating the third. What
  // the pair is actually FOR is the case where they disagree, and that is
  // handled below by a warning that costs nothing while they agree.
  set('about-version', _releaseOf(server) || page);

  const warn = document.getElementById('about-version-warn');
  if (!warn) return;
  const sRel = _releaseOf(server);

  // WHICH WAY the two numbers differ decides what is wrong, and the two
  // answers need opposite actions. Reporting one message for both is worse
  // than reporting nothing, because half the time it sends the reader to
  // hard-refresh a page that was never the problem.
  //
  // This is not hypothetical. A build was handed over with an updated frontend
  // beside a binary that had not been rebuilt: the page was NEWER than the
  // server, two server-side features were quietly missing, and "clear your
  // cache" would have been exactly the wrong advice.
  //
  // "dev" is an unstamped local build and legitimately differs from anything,
  // so it is never flagged.
  // WHICH PROGRAM IS SERVING THIS PAGE is a separate question from which
  // version it is, and it used to be invisible. fileserver.ps1 sent no version
  // at all, so sRel was empty, cmp was null, and this warning stayed hidden
  // while the row above displayed the PAGE's stamp as the version of the whole
  // install. The reader was told they were running a current release by a
  // server that has none of that release's server-side half.
  //
  // Checked before the version comparison because it outranks it: the versions
  // can agree perfectly and the answer still be "that is the other server".
  const legacy = _aboutHealth &&
    (_aboutHealth.server === 'fileserver.ps1' || (_aboutHealthState === 'ok' && !_aboutHealth.version));
  if (legacy) {
    warn.hidden = false;
    warn.textContent =
      'This page is being served by fileserver.ps1, the older PowerShell file server that ' +
      'launch.bat starts. It works for chatting, but it does not have the parts of GobboNet ' +
      'that live in the server — idle stand-down, sync profiles and config presets are ' +
      'missing or do nothing. To get them, start GobboNet with the gobbonet program file in ' +
      'your GobboNet folder instead of launch.bat. The chat page is built into that file, so ' +
      'there is nothing else to update.';
    return;
  }

  const cmp = (sRel && sRel !== 'dev') ? _cmpRelease(sRel, page) : null;
  warn.hidden = (cmp === null || cmp === 0);
  if (cmp === 1) {
    warn.textContent =
      'This page is from ' + page + ' but the server is ' + sRel + '. ' +
      'Your browser is almost certainly holding a cached copy of the frontend — ' +
      'hard-refresh (Ctrl+Shift+R, or Cmd+Shift+R) before reporting anything, ' +
      'because a stale page behaves exactly like a broken release.';
  } else if (cmp === -1) {
    // Since 1.7.5 the chat page ships INSIDE the program file, so these two
    // numbers come from one artifact and normally cannot disagree. When they
    // do, something is deliberately serving a different page: a web_root
    // override in the config, or a browser holding one from a newer install.
    // Either way the action is one file, and it is not the browser cache.
    warn.textContent =
      'This page is from ' + page + ' but the server program is older (' + sRel + '). ' +
      'Anything that needs the server — idle stand-down, sync profiles, config presets — ' +
      'may be missing or silently do nothing. Replace the gobbonet program file in your ' +
      'GobboNet folder with the one from the download: the chat page ships inside it, so ' +
      'that one file is the whole update. Two things can also produce this without the ' +
      'program file being old — a web_root line in your config pointing at a newer page, ' +
      'or a browser still holding one — but check the program file first, because it is ' +
      'the half that carries the missing features.';
  }
}

/** A short, paste-ready summary for a bug report.
 *
 *  Deliberately excludes the address this page was opened at. The useful fact
 *  is "served over http from a LAN address", not the address itself — pasting
 *  someone's LAN IP into a public channel is a thing this should not quietly
 *  make easy. */
function aboutDiagnosticsText() {
  const page = (typeof GOBBONET_UI_VERSION === 'string') ? GOBBONET_UI_VERSION : 'unknown';
  const h = _aboutHealth || {};
  const lines = [];
  lines.push('GobboNet build info');
  lines.push('  page:    ' + page);
  lines.push('  server:  ' + (!IS_SERVED
    ? 'not running (opened from a file)'
    : (_aboutHealthState === 'absent' ? 'no GobboNet server answered' : (h.version || 'unknown'))));
  if (h.mode) lines.push('  mode:    ' + h.mode);
  if (typeof h.upstream_ok === 'boolean') lines.push('  llama:   ' + (h.upstream_ok ? 'reachable' : 'NOT reachable'));

  let model = '';
  try { model = (typeof activeModelName === 'function') ? activeModelName() : ''; } catch (e) {}
  if (!model) {
    const el = document.getElementById('about-model-line');
    model = el ? el.textContent.trim() : '';
  }
  if (model) lines.push('  model:   ' + model);

  if (typeof STORAGE_BACKEND === 'string') lines.push('  storage: ' + STORAGE_BACKEND);
  try { lines.push('  sync:    ' + syncTargetLabel()); } catch (e) {}
  lines.push('  opened:  ' + (IS_SERVED
    ? (window.location.protocol.replace(':', '') + ', ' +
       (/^(localhost|127\.|\[::1\])/.test(window.location.hostname) ? 'same machine' : 'over the network'))
    : 'file://'));
  lines.push('  browser: ' + (navigator.userAgent || 'unknown'));
  return lines.join('\n');
}

function copyAboutDiagnostics(btn) {
  const text = aboutDiagnosticsText();
  const done = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  const fallback = () => {
    // Same reason copyCodeBlock keeps one: navigator.clipboard rejects outside
    // a secure context, and reaching this over plain http on a LAN is the
    // normal way to use the app from a phone.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      if (btn) btn.textContent = 'COPY FAILED';
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

function openAbout() {
  document.getElementById('about-modal').classList.add('open');
  // Painted twice on purpose: once immediately from what is already known, so
  // the panel is never blank, and again when the server answers. The page
  // version is available with no network at all, which is the half a user
  // needs when the server is the thing that is broken.
  renderAboutBuild();
  _fetchAboutHealth().then(renderAboutBuild);
}
function closeAbout() {
  document.getElementById('about-modal').classList.remove('open');
}

