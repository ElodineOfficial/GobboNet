/* @gobbonet-split js/19-extensions.js
   Moved verbatim from chat.html lines 11311-11554.
   custom CSS / JS overrides
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   EXTENSIONS — custom CSS + JS overrides
   Users can inject a stylesheet (URL or raw CSS) and a script
   (URL or inline JS) that are persisted in localStorage and
   re-applied every boot. All injected elements get the class
   'gobbonet-ext' so they can be cleanly removed/replaced.
================================================================ */

/* ================================================================
   MODS (1.7.9, F1)

   Mods are folders on the PC running GobboNet (internal/mods): each one a
   mod.json and the stylesheets and scripts it lists, each with its own
   switch, loaded in order. The old single blob of stylesheets and scripts
   (state.extensions) became one of them, "My extensions", and this panel's
   editor now edits that mod.

     GET  /mods                     the list, in load order
     GET  /mods/<id>/files/<path>   a file a mod lists
     GET/PUT /mods/<id>/source      My extensions' content (PUT: this PC only)
     POST /mods/<id>/enable         on (this PC only) / off (any device)
     POST /mods/<id>/move, DELETE /mods/<id>, POST /mods/<id>/restore
     POST /mods/import-legacy       the old blob -> My extensions (this PC only)

   Why the server, and why "this PC only": mods are code that runs in every
   browser that opens this GobboNet. In 1.7.8 that code lived inside the
   synced chat state, which any paired device can overwrite. Now it lives in
   a folder, is written and switched on only from the PC itself, and never
   travels in /state (redactedStateMeta sends an empty extensions list).

   A page opened from file://, or a phone that still holds extensions from
   before 1.7.9 it cannot move (only the PC can), keeps running that old blob
   exactly as 1.7.8 did, so nothing anyone had stops working.
================================================================ */
let _mods = { list: [], canManage: false, dir: '', loaded: false, legacyHere: false, myExt: null };

async function loadMods() {
  if (!IS_SERVED) return _mods;
  try {
    const r = await fetch('/mods', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      _mods.list = Array.isArray(j.mods) ? j.mods : [];
      _mods.canManage = !!j.canManage;
      _mods.dir = typeof j.dir === 'string' ? j.dir : '';
      _mods.loaded = true;
    }
  } catch (_) { /* no server: the list stays as it was */ }
  return _mods;
}

/** The pre-1.7.9 extensions blob has something in it. */
function legacyExtLive(ext) { return !!ext && extEntryCount(ext) > 0; }

/** Move this browser's old extensions into the mod "My extensions", once.
 *  On the PC it lands with its switch as it was (the blob in a browser's own
 *  storage was switched on by that browser's user: restores and imports
 *  switch code off first). Anywhere else the server refuses, and the blob
 *  keeps running here as before. */
async function migrateLegacyExtensions() {
  if (!IS_SERVED || !legacyExtLive(state.extensions)) return false;
  const ext = state.extensions;
  const pick = l => (Array.isArray(l) ? l : []).map(e => ({ name: e.name || '', url: e.url || '', raw: e.raw || '' }));
  try {
    const r = await fetch('/mods/import-legacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!ext.enabled, styles: pick(ext.styles), scripts: pick(ext.scripts) })
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      state.extensions = { enabled: false, styles: [], scripts: [] };
      saveState();
      _mods.legacyHere = false;
      console.log('[mods] your extensions are now the mod "' + (j.id || 'my-extensions') + '"' +
                  (j.created ? '' : ' (it already held them)') + '.');
      return true;
    }
    if (r.status === 403) _mods.legacyHere = true;
  } catch (_) { /* try again next time */ }
  return false;
}

function modFileURL(m, f) {
  return '/mods/' + encodeURIComponent(m.id) + '/files/' +
    String(f.path).split('/').map(encodeURIComponent).join('/') + '?v=' + encodeURIComponent(m.hash || '');
}

/** Apply mods and (where it still applies) the old blob. Kept under its old
 *  name: boot, import and the panel call it. */
function applyExtensions() { return applyMods(); }

/** ?nomods in the address: this page load runs no mods at all, so a mod that
 *  breaks the page can still be switched off from the MODS panel. */
function modsSafeMode() {
  try { return new URLSearchParams(location.search).has('nomods'); } catch (_) { return false; }
}

let _applySeq = 0;
async function applyMods() {
  const seq = ++_applySeq;
  if (IS_SERVED) {
    await migrateLegacyExtensions();
    await loadMods();
  }
  if (seq !== _applySeq) return;   // a newer apply has started; it wins
  if (modsSafeMode()) {
    document.querySelectorAll('.gobbonet-ext').forEach(el => el.remove());
    if (!_mods.safeSaid) { _mods.safeSaid = true; console.log('[mods] ?nomods: no mods are loaded on this page.'); }
    updateExtStatusDot();
    return;
  }

  // What should be on the page, keyed so an element already loaded is kept:
  // re-adding a script would run it a second time.
  const want = [];
  for (const m of _mods.list) {
    if (!m || !m.enabled || m.error) continue;
    for (const f of (m.files || [])) {
      if (f.type !== 'css' && f.type !== 'js') continue;
      const src = f.path ? modFileURL(m, f) : String(f.url || '').trim();
      if (!src) continue;
      want.push({ key: 'mod:' + m.id + ':' + src, kind: f.type, src, name: m.name + (f.name ? ': ' + f.name : ''), mod: m.id, remote: !f.path });
    }
  }
  const keep = new Set(want.map(w => w.key));
  document.querySelectorAll('.gobbonet-ext').forEach(el => {
    if (!keep.has(el.getAttribute('data-ext-key'))) el.remove();   // CSS goes at once; a script that ran stays run until reload
  });
  const have = new Set([...document.querySelectorAll('.gobbonet-ext')].map(el => el.getAttribute('data-ext-key')));
  for (const w of want) {
    if (have.has(w.key)) continue;
    let el;
    if (w.kind === 'css') {
      el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = w.src;
    } else {
      el = document.createElement('script');
      el.src = w.src;
      el.async = false;   // dynamically added scripts run in the order added
      if (w.remote) {
        // A URL entry: the network may simply be down, so say so and leave
        // the switch alone.
        el.onerror = () => console.error('[mods] could not load ' + w.src + ' (' + w.name + ')');
      } else {
        // A mod's own file: one that is missing or throws while it first runs
        // switches its mod off (modFailed), so a broken mod cannot keep
        // breaking the page. Errors later, from its event handlers, do not.
        _modPending.set(el, w);
        el.onload = () => _modPending.delete(el);
        el.onerror = () => { _modPending.delete(el); modFailed(w.mod, 'its file ' + w.src.split('?')[0].split('/').pop() + ' could not be loaded'); };
      }
    }
    el.className = 'gobbonet-ext';
    el.setAttribute('data-ext-key', w.key);
    el.setAttribute('data-ext-type', (w.kind === 'css' ? 'css' : 'js') + (w.remote ? '-url' : '-mod'));
    el.setAttribute('data-ext-name', w.name);
    el.setAttribute('data-mod-id', w.mod);
    document.head.appendChild(el);
  }
  if (want.length) console.log('[mods] loaded ' + want.length + ' file(s) from ' +
    new Set(want.map(w => w.mod)).size + ' mod(s)');

  // The old blob, where it could not be moved (a phone, a file:// page).
  if (state.extensions && state.extensions.enabled && legacyExtLive(state.extensions)) {
    injectLegacyExtensions(state.extensions);
  }
  updateExtStatusDot();
}

/** 1.7.8's applyExtensions, for the old blob only. */
function injectLegacyExtensions(ext) {
  document.querySelectorAll('.gobbonet-ext[data-ext-key^="legacy:"]').forEach(el => el.remove());
  const styles  = Array.isArray(ext.styles)  ? ext.styles  : [];
  const scripts = Array.isArray(ext.scripts) ? ext.scripts : [];

  // ── Stylesheets (in order). Each entry: URL <link> then inline <style>. ──
  styles.forEach((entry, i) => {
    const label = entry.name || ('stylesheet ' + (i + 1));
    if (entry.url && entry.url.trim()) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = entry.url.trim();
      link.className = 'gobbonet-ext';
      link.setAttribute('data-ext-key', 'legacy:css-url:' + i);
      link.setAttribute('data-ext-type', 'css-url');
      link.setAttribute('data-ext-name', label);
      document.head.appendChild(link);
      console.log('[ext] Loaded CSS URL:', entry.url.trim());
    }
    if (entry.raw && entry.raw.trim()) {
      const style = document.createElement('style');
      style.className = 'gobbonet-ext';
      style.setAttribute('data-ext-key', 'legacy:css-raw:' + i);
      style.setAttribute('data-ext-type', 'css-raw');
      style.setAttribute('data-ext-name', label);
      style.textContent = entry.raw;
      document.head.appendChild(style);
      console.log('[ext] Injected inline CSS (' + entry.raw.length + ' chars)');
    }
  });

  // ── Scripts (in order). URL <script src defer> then inline <script>. ──
  scripts.forEach((entry, i) => {
    const label = entry.name || ('script ' + (i + 1));
    if (entry.url && entry.url.trim()) {
      const script = document.createElement('script');
      script.src = entry.url.trim();
      script.className = 'gobbonet-ext';
      script.setAttribute('data-ext-key', 'legacy:js-url:' + i);
      script.setAttribute('data-ext-type', 'js-url');
      script.setAttribute('data-ext-name', label);
      script.defer = true;
      script.onerror = () => console.error('[ext] Failed to load script URL:', entry.url.trim());
      document.head.appendChild(script);
      console.log('[ext] Loading script URL:', entry.url.trim());
    }
    if (entry.raw && entry.raw.trim()) {
      const script = document.createElement('script');
      script.className = 'gobbonet-ext';
      script.setAttribute('data-ext-key', 'legacy:js-raw:' + i);
      script.setAttribute('data-ext-type', 'js-raw');
      script.setAttribute('data-ext-name', label);
      script.textContent = entry.raw;
      document.head.appendChild(script);
      console.log('[ext] Executed inline script (' + entry.raw.length + ' chars)');
    }
  });

}

/** Count of non-empty entries across both lists. */
function extEntryCount(ext) {
  if (!ext) return 0;
  const live = e => e && ((e.url && e.url.trim()) || (e.raw && e.raw.trim()));
  return (Array.isArray(ext.styles)  ? ext.styles.filter(live).length  : 0)
       + (Array.isArray(ext.scripts) ? ext.scripts.filter(live).length : 0);
}

/** Dot in the sidebar MODS button -- green when anything is switched on. */
function updateExtStatusDot() {
  const dot = document.getElementById('ext-status-dot');
  if (!dot) return;
  const legacy = state.extensions && state.extensions.enabled && extEntryCount(state.extensions) > 0;
  const active = legacy || _mods.list.some(m => m && m.enabled && !m.error);
  dot.textContent = active ? ' ●' : '';
  dot.style.color = 'var(--green-neon)';
}

/* ── The panel ─────────────────────────────────────────────────────── */

// Working copy of My extensions while the panel is open. Edits change the
// draft; SAVE writes it to the mod, CANCEL throws it away.
let _extDraft = { styles: [], scripts: [] };
let _extDraftTouched = false;
const MY_EXT_ID = 'my-extensions';

function _draftFrom(src) {
  const mk = (l, kind) => (Array.isArray(l) ? l : []).map((e, i) => ({
    id: e.id || ('ext_' + kind + '_' + i + '_' + Date.now().toString(36)),
    name: e.name || '', url: e.url || '', raw: e.raw || ''
  }));
  return { styles: mk(src && src.styles, 'css'), scripts: mk(src && src.scripts, 'js') };
}

/** Where the editor's content comes from: the My extensions mod when there
 *  is a server, the old blob otherwise (file://, or a device that still holds
 *  one it could not move). */
function _myExtSourceLocal() {
  if (!IS_SERVED || _mods.legacyHere) return { source: state.extensions || {}, enabled: !!(state.extensions && state.extensions.enabled) };
  const mod = _mods.list.find(m => m.id === MY_EXT_ID);
  return { source: _mods.myExt || {}, enabled: !!(mod && mod.enabled) };
}

async function _refreshMyExt() {
  if (!IS_SERVED) return;
  try {
    const r = await fetch('/mods/' + MY_EXT_ID + '/source', { cache: 'no-store' });
    _mods.myExt = r.ok ? await r.json() : { styles: [], scripts: [] };
  } catch (_) { /* keep what we had */ }
}

function openExtensions() {
  const cur = _myExtSourceLocal();
  document.getElementById('ext-enabled').checked = cur.enabled;
  _extDraft = _draftFrom(cur.source);
  _extDraftTouched = false;
  updateExtStatusLabel();
  renderExtEntries();
  renderModList();
  renderEndorsedList();
  renderExtStatusList();
  renderMacroList();
  const modal = document.getElementById('ext-modal');
  modal.classList.add('open');
  if (!modal._touchWatch) {   // typing counts as editing: a late refresh must not overwrite it
    modal._touchWatch = true;
    modal.addEventListener('input', (e) => { if (e.target && e.target.closest && e.target.closest('.ext-entry')) _extDraftTouched = true; });
  }
  // Then ask the server for the latest, and redraw only what nobody has
  // started editing.
  if (IS_SERVED) {
    Promise.all([loadMods(), _refreshMyExt()]).then(() => {
      renderModList();
      if (_extDraftTouched) return;
      const fresh = _myExtSourceLocal();
      document.getElementById('ext-enabled').checked = fresh.enabled;
      _extDraft = _draftFrom(fresh.source);
      updateExtStatusLabel();
      renderExtEntries();
      applyExtEditLock();
    });
  }
  applyExtEditLock();
}

/** On a device that is not the PC, My extensions can be read, not changed. */
function applyExtEditLock() {
  const locked = IS_SERVED && _mods.loaded && !_mods.canManage;
  const modal = document.getElementById('ext-modal');
  if (!modal) return;
  modal.classList.toggle('mods-readonly', locked);
  const save = document.getElementById('ext-save-btn');
  if (save) save.disabled = locked;
  const clear = document.getElementById('ext-clear-btn');
  if (clear) clear.disabled = locked;
}

function closeExtensions() {
  commitPendingUndo();   // a removed entry's UNDO cannot outlive the draft it is in
  document.getElementById('ext-modal').classList.remove('open');
}

function _extNote(text, isError) {
  const el = document.getElementById('mods-note');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
  el.classList.toggle('mods-note-error', !!isError);
}

async function saveExtensions() {
  commitPendingUndo();   // SAVE takes the draft as it stands
  syncExtDraftFromDOM();
  const trim = e => ({
    id:   e.id || generateId(),
    name: (e.name || '').trim(),
    url:  (e.url || '').trim(),
    raw:  e.raw || ''
  });
  const live = e => e.url.trim() || e.raw.trim() || e.name;
  const draft = {
    enabled: document.getElementById('ext-enabled').checked,
    styles:  _extDraft.styles.map(trim).filter(live),
    scripts: _extDraft.scripts.map(trim).filter(live)
  };
  if (!IS_SERVED || _mods.legacyHere) {
    // No server to keep mods (file://), or a device that still runs its old
    // blob: the 1.7.8 path, in this browser only.
    state.extensions = draft;
    saveState();
    applyExtensions();
    closeExtensions();
    return true;
  }
  if (!_mods.canManage) {
    _extNote('My extensions can only be changed from GobboNet on the PC it runs on.', true);
    return false;
  }
  const strip = l => l.map(e => ({ name: e.name, url: e.url, raw: e.raw }));
  try {
    const r = await fetch('/mods/' + MY_EXT_ID + '/source', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My extensions', styles: strip(draft.styles), scripts: strip(draft.scripts), enabled: draft.enabled })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { _extNote(j.error || ('Could not save (HTTP ' + r.status + ').'), true); return false; }
  } catch (e) {
    _extNote('Could not reach the server: ' + e.message, true);
    return false;
  }
  _mods.myExt = { styles: strip(draft.styles), scripts: strip(draft.scripts) };
  closeExtensions();
  await applyExtensions();
  return true;
}

async function clearAllExtensions() {
  if (!confirm('Clear My extensions? This removes every stylesheet and script in it.')) return;
  document.getElementById('ext-enabled').checked = false;
  _extDraft = { styles: [], scripts: [] };
  renderExtEntries();
  await saveExtensions();
}

/* ── The mod list ── */

function renderModList() {
  const box = document.getElementById('mods-list');
  if (!box) return;
  box.textContent = '';
  if (!IS_SERVED) {
    box.textContent = 'Mods need GobboNet’s server; this page was opened as a file. My extensions below still works here.';
    return;
  }
  const list = _mods.list.filter(Boolean);
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'form-hint';
    d.textContent = 'No mods yet. My extensions below becomes one when you save it.';
    box.appendChild(d);
  }
  list.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mod-row' + (m.enabled ? ' mod-on' : '') + (m.error ? ' mod-broken' : '');
    row.setAttribute('data-mod-id', m.id);

    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'mod-switch';
    sw.checked = !!m.enabled;
    sw.setAttribute('aria-label', 'Switch ' + (m.name || m.id) + (m.enabled ? ' off' : ' on'));
    sw.disabled = !!m.error || (!_mods.canManage && !m.enabled);
    sw.onchange = () => setModEnabled(m.id, sw.checked);
    row.appendChild(sw);

    const body = document.createElement('div');
    body.className = 'mod-body';
    const name = document.createElement('div');
    name.className = 'mod-name';
    name.textContent = (m.name || m.id) + (m.version ? '  v' + m.version : '');
    body.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'mod-meta';
    const files = (m.files || []).filter(f => f.type === 'css' || f.type === 'js');
    const origin = { editor: 'made in this panel', legacy: 'your extensions from before 1.7.9', endorsed: 'endorsed' }[m.origin] || 'added by hand';
    meta.textContent = (m.description ? m.description + ' · ' : '') +
      files.length + (files.length === 1 ? ' file' : ' files') + ' · ' + origin + (m.author ? ' · by ' + m.author : '');
    body.appendChild(meta);
    if (m.error) {
      const err = document.createElement('div');
      err.className = 'mod-error';
      err.textContent = 'Cannot load: ' + m.error;
      body.appendChild(err);
    }
    row.appendChild(body);

    if (_mods.canManage) {
      const tools = document.createElement('div');
      tools.className = 'mod-tools';
      const mk = (label, title, fn, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', title + ': ' + (m.name || m.id));
        b.disabled = !!disabled;
        b.onclick = fn;
        tools.appendChild(b);
        return b;
      };
      mk('↑', 'Load earlier', () => moveMod(m.id, -1), i === 0);
      mk('↓', 'Load later', () => moveMod(m.id, 1), i === list.length - 1);
      mk('Remove', 'Remove this mod', () => removeMod(m.id, m.name || m.id)).classList.add('btn-danger');
      row.appendChild(tools);
    }
    box.appendChild(row);
  });

  const hint = document.getElementById('mods-where');
  if (hint) {
    hint.textContent = _mods.canManage
      ? 'Mods live in ' + (_mods.dir || 'the mods folder') + '. Drop a folder with a mod.json in it there to add one; it starts switched off.'
      : 'Mods are managed from GobboNet on the PC it runs on. From here you can switch one off.';
  }
  if (_mods.legacyHere) {
    _extNote('This device still runs its extensions from before 1.7.9. Open GobboNet once on the PC it ' +
             'runs on, and they become the mod My extensions.', false);
  }
}

async function _modPost(path, body, method) {
  const r = await fetch(path, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

async function setModEnabled(id, on) {
  _extNote('');
  try {
    await _modPost('/mods/' + encodeURIComponent(id) + '/enable', { enabled: !!on });
  } catch (e) {
    _extNote(e.message, true);
  }
  await loadMods();
  renderModList();
  await applyExtensions();
  const m = _mods.list.find(x => x.id === id);
  if (!on && m && (m.files || []).some(f => f.type === 'js')) {
    _extNote((m.name || id) + ' is off. Its stylesheets are gone now; a script that already ran stops when the page reloads.', false);
  }
}

async function moveMod(id, delta) {
  try { await _modPost('/mods/' + encodeURIComponent(id) + '/move', { delta: delta }); }
  catch (e) { _extNote(e.message, true); }
  await loadMods();
  renderModList();
  await applyExtensions();
}

async function removeMod(id, name) {
  try { await _modPost('/mods/' + encodeURIComponent(id), undefined, 'DELETE'); }
  catch (e) { _extNote(e.message, true); return; }
  await loadMods();
  renderModList();
  await applyExtensions();
  // The folder is set aside, not deleted, until GobboNet restarts.
  undoable({
    label: 'Removed mod "' + String(name).slice(0, 40) + '"',
    undo: async () => {
      try { await _modPost('/mods/' + encodeURIComponent(id) + '/restore'); }
      catch (e) { _extNote('Could not put it back: ' + e.message, true); }
      await loadMods();
      renderModList();
      await applyExtensions();
    },
  });
}

/* ── A mod that fails switches itself off (1.7.9, F6) ── */

const _modPending = new Map();       // <script> of a mod file -> its entry, until it has run
const _modFailedOnce = new Set();

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('error', (e) => {
  if (!e || !e.filename || !_modPending.size) return;
  for (const [el, w] of _modPending) {
    if (el.src === e.filename) {
      _modPending.delete(el);
      modFailed(w.mod, 'it stopped with an error while loading (' + String(e.message || 'unknown error').slice(0, 120) + ')');
      return;
    }
  }
}, true);

/** Switch a failing mod off (allowed from any device), take its files off the
 *  page, and say so once, out of the way. */
async function modFailed(id, why) {
  if (_modFailedOnce.has(id)) return;
  _modFailedOnce.add(id);
  const m = _mods.list.find(x => x && x.id === id);
  const name = (m && m.name) || id;
  document.querySelectorAll('.gobbonet-ext').forEach(el => { if (el.getAttribute('data-mod-id') === id) el.remove(); });
  let off = false;
  try { await _modPost('/mods/' + encodeURIComponent(id) + '/enable', { enabled: false }); off = true; }
  catch (_) { /* the server is away; the files are off this page either way */ }
  if (m && off) m.enabled = false;
  console.error('[mods] "' + name + '": ' + why + (off ? '. It has been switched off.' : '. It is off for this page.'));
  showModNotice(id, 'The mod “' + name + '” was switched off: ' + why + '.' +
    (off ? ' Anything it already did stays until the page reloads.' : ''));
  const modal = document.getElementById('ext-modal');
  if (modal && modal.classList.contains('open')) renderModList();
  updateExtStatusDot();
}

function showModNotice(id, text) {
  let box = document.getElementById('mod-notice');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mod-notice';
    box.setAttribute('role', 'alert');
    document.body.appendChild(box);
  }
  box.textContent = '';
  box.hidden = false;
  const t = document.createElement('div');
  t.className = 'mod-notice-text';
  t.textContent = text;
  box.appendChild(t);
  const row = document.createElement('div');
  row.className = 'mod-notice-actions';
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.textContent = label;
    b.onclick = fn;
    row.appendChild(b);
    return b;
  };
  btn('OPEN MODS', () => { box.hidden = true; openExtensions(); });
  if (_mods.canManage) {
    btn('SWITCH BACK ON', async () => {
      box.hidden = true;
      _modFailedOnce.delete(id);
      await setModEnabled(id, true);
    });
  }
  btn('DISMISS', () => { box.hidden = true; });
  box.appendChild(row);
}

/* ── Endorsed mods (1.7.9, F6) ──

   GET  /mod-list.json[?refresh=1]   the list, marked against what is installed
   POST /mod-list/install {id}       download, check every SHA-256, install (this PC only)

   Nothing is fetched until BROWSE is clicked. Mods marked adult stay covered
   until the viewer says they are 18 or older, remembered on this device only. */

let _endorsed = { data: null, loading: false };
const ADULT_OK_KEY = 'gobbonet.mods.adultOk';

function endorsedAdultOk() {
  try { return localStorage.getItem(ADULT_OK_KEY) === '1'; } catch (_) { return false; }
}
function setEndorsedAdultOk(on) {
  try { if (on) localStorage.setItem(ADULT_OK_KEY, '1'); else localStorage.removeItem(ADULT_OK_KEY); } catch (_) { /* this page load only */ }
  _endorsed.adultThisPage = !!on;
  renderEndorsedList();
}

function _endorsedNote(text, isError) {
  const el = document.getElementById('endorsed-note');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
  el.classList.toggle('mods-note-error', !!isError);
}

async function browseEndorsedMods(refresh, keepNote) {
  const box = document.getElementById('endorsed-list');
  if (!IS_SERVED) {
    _endorsedNote('Endorsed mods need GobboNet’s server; this page was opened as a file.', true);
    return null;
  }
  if (_endorsed.loading) return _endorsed.data;
  _endorsed.loading = true;
  if (!keepNote) _endorsedNote('');
  if (box && !_endorsed.data) box.textContent = 'Fetching the endorsed list…';
  try {
    const r = await fetch('/mod-list.json' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    _endorsed.data = j;
  } catch (e) {
    _endorsed.data = { mods: [], error: 'Could not reach GobboNet: ' + e.message };
  } finally {
    _endorsed.loading = false;
  }
  // BROWSE becomes REFRESH once there is a list. style.display, not the
  // hidden attribute: .btn sets display, which would win over [hidden].
  const b = document.getElementById('endorsed-browse-btn');
  if (b) b.style.display = 'none';
  const rb = document.getElementById('endorsed-refresh-btn');
  if (rb) rb.style.display = '';
  renderEndorsedList();
  return _endorsed.data;
}

function renderEndorsedList() {
  const box = document.getElementById('endorsed-list');
  const d = _endorsed.data;
  if (!box || !d) return;
  box.textContent = '';
  const hint = (text, cls) => {
    const el = document.createElement('div');
    el.className = 'form-hint' + (cls ? ' ' + cls : '');
    el.textContent = text;
    box.appendChild(el);
    return el;
  };
  if (d.off) { hint((d.notes && d.notes[0]) || 'The endorsed list is switched off.'); return; }
  if (d.error) hint(d.error, 'mods-note-error');
  const mods = Array.isArray(d.mods) ? d.mods : [];
  const adultOk = endorsedAdultOk() || !!_endorsed.adultThisPage;
  const adult = mods.filter(m => m && m.adult);
  if (!d.error && !mods.length) hint('Nothing is on the endorsed list yet.');

  if (adult.length && !adultOk) {
    const cover = document.createElement('div');
    cover.className = 'endorsed-adult-cover';
    const t = document.createElement('span');
    t.textContent = adult.length + (adult.length === 1 ? ' mod is' : ' mods are') + ' marked 18+ and hidden.';
    cover.appendChild(t);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    b.id = 'endorsed-adult-btn';
    b.textContent = 'I AM 18 OR OLDER, SHOW THEM';
    b.onclick = () => setEndorsedAdultOk(true);
    cover.appendChild(b);
    box.appendChild(cover);
  }

  for (const m of mods) {
    if (!m || (m.adult && !adultOk)) continue;
    const row = document.createElement('div');
    row.className = 'mod-row endorsed-row' + (m.state === 'installed' ? ' endorsed-installed' : '');
    row.setAttribute('data-endorsed-id', m.id);
    row.style.gridTemplateColumns = '1fr auto';

    const body = document.createElement('div');
    body.className = 'mod-body';
    const name = document.createElement('div');
    name.className = 'mod-name';
    name.textContent = (m.name || m.id) + (m.version ? '  v' + m.version : '');
    if (m.adult) {
      const badge = document.createElement('span');
      badge.className = 'mod-badge';
      badge.textContent = '18+';
      name.appendChild(badge);
    }
    if (m.state === 'update') {
      const badge = document.createElement('span');
      badge.className = 'mod-badge mod-badge-update';
      badge.textContent = 'UPDATE';
      name.appendChild(badge);
    }
    body.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'mod-meta';
    meta.textContent = (m.description ? m.description + ' · ' : '') + (m.author ? 'by ' + m.author : 'endorsed') +
      (m.state === 'installed' ? ' · installed' : m.state === 'update' ? ' · you have v' + m.installed : '');
    body.appendChild(meta);
    if (m.homepage && /^https:\/\//.test(m.homepage)) {
      const a = document.createElement('a');
      a.href = m.homepage;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'mod-meta';
      a.textContent = 'More about it';
      body.appendChild(a);
    }
    const why = m.state === 'problem' ? (m.problem || 'This build cannot install it.')
      : m.state === 'taken' ? 'A mod called ' + m.id + ' is already in your mods folder and did not come from this list, so it is left alone.'
      : '';
    if (why) {
      const err = document.createElement('div');
      err.className = 'mod-error';
      err.textContent = why;
      body.appendChild(err);
    }
    row.appendChild(body);

    const tools = document.createElement('div');
    tools.className = 'mod-tools';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm';
    const label = { new: 'INSTALL', update: 'UPDATE', installed: 'INSTALLED' }[m.state] || 'UNAVAILABLE';
    b.textContent = label;
    b.setAttribute('aria-label', label + ': ' + (m.name || m.id));
    b.disabled = !d.canManage || !(m.state === 'new' || m.state === 'update');
    if (!d.canManage && (m.state === 'new' || m.state === 'update')) b.title = 'Install from GobboNet on the PC it runs on.';
    b.onclick = () => installEndorsedMod(m.id, b);
    tools.appendChild(b);
    row.appendChild(tools);
    box.appendChild(row);
  }

  if (!d.canManage && mods.length) hint('Mods are installed from GobboNet on the PC it runs on; from here you can look.');
  if (adult.length && adultOk) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-sm';
    again.textContent = 'HIDE 18+ MODS';
    again.onclick = () => setEndorsedAdultOk(false);
    box.appendChild(again);
  }
  if (d.source === 'cache' && Array.isArray(d.notes)) {
    const was = d.notes.find(n => /as it was on/.test(n));
    hint('The list could not be reached just now; this is ' + (was ? was.replace(/^showing /, '') : 'the last copy GobboNet saw') + '.');
  }
}

async function installEndorsedMod(id, btn) {
  const m = ((_endorsed.data && _endorsed.data.mods) || []).find(x => x && x.id === id);
  const name = (m && m.name) || id;
  _endorsedNote('');
  if (btn) { btn.disabled = true; btn.textContent = 'INSTALLING…'; }
  let j;
  try {
    j = await _modPost('/mod-list/install', { id: id });
  } catch (e) {
    _endorsedNote(e.message, true);
    await browseEndorsedMods(false, true);
    return null;
  }
  _modFailedOnce.delete(id);
  await loadMods();
  renderModList();
  await applyExtensions();
  _endorsedNote(j.updated
    ? 'Updated ' + name + ' to v' + j.version + '; it is still ' + (j.enabled ? 'on' : 'off') + ', as you had it.'
    : 'Installed ' + name + ' v' + j.version + ' and switched it on. Its switch is under YOUR MODS.', false);
  await browseEndorsedMods(false, true);
  return j;
}

/* ── Multi-entry list management (Stylesheets / Scripts) ── */

/** Read every entry's current field values out of the DOM into the draft. */
function syncExtDraftFromDOM() {
  ['styles', 'scripts'].forEach(kind => {
    const listEl = document.getElementById(kind === 'styles' ? 'ext-styles-list' : 'ext-scripts-list');
    if (!listEl) return;
    listEl.querySelectorAll('.ext-entry').forEach(card => {
      const id = card.getAttribute('data-ext-entry');
      const entry = _extDraft[kind].find(e => e.id === id);
      if (!entry) return;
      const nameEl = card.querySelector('.ext-entry-name');
      const urlEl  = card.querySelector('.ext-entry-url');
      const rawEl  = card.querySelector('.ext-entry-raw');
      if (nameEl) entry.name = nameEl.value;
      if (urlEl)  entry.url  = urlEl.value;
      if (rawEl)  entry.raw  = rawEl.value;
    });
  });
}

function addExtEntry(kind) {
  _extDraftTouched = true;
  syncExtDraftFromDOM();
  _extDraft[kind].push({ id: generateId(), name: '', url: '', raw: '' });
  renderExtEntries();
}

function removeExtEntry(kind, id) {
  _extDraftTouched = true;
  syncExtDraftFromDOM();
  const at = _extDraft[kind].findIndex(e => e.id === id);
  if (at < 0) return;
  const entry = _extDraft[kind][at];
  _extDraft[kind] = _extDraft[kind].filter(e => e.id !== id);
  renderExtEntries();
  // A draft: SAVE or closing the panel makes it final (both commit first).
  undoable({
    label: 'Removed ' + (kind === 'scripts' ? 'script' : 'stylesheet') + ' "' + String(entry.name || 'unnamed').slice(0, 30) + '"',
    undo: () => {
      syncExtDraftFromDOM();
      if (!_extDraft[kind].some(e => e.id === id)) _extDraft[kind].splice(Math.min(at, _extDraft[kind].length), 0, entry);
      renderExtEntries();
    },
  });
}

/** In-place field update (used by file loader, which then re-renders). */
function updateExtEntry(kind, id, field, value) {
  const entry = _extDraft[kind].find(e => e.id === id);
  if (entry) entry[field] = value;
}

/** Load a .css/.js file into a specific entry's inline area. */
function handleExtFileEntry(fileInput, kind, id) {
  const file = fileInput.files[0];
  if (!file) return;
  syncExtDraftFromDOM();
  const reader = new FileReader();
  reader.onload = function(e) {
    const entry = _extDraft[kind].find(x => x.id === id);
    if (!entry) return;
    entry.raw = e.target.result;
    if (!entry.name || !entry.name.trim()) entry.name = file.name;
    renderExtEntries();
  };
  reader.readAsText(file);
}

/** Render both entry lists from the draft. */
function renderExtEntries() {
  renderExtEntryList('styles');
  renderExtEntryList('scripts');
}

function renderExtEntryList(kind) {
  const isStyle = kind === 'styles';
  const listEl = document.getElementById(isStyle ? 'ext-styles-list' : 'ext-scripts-list');
  if (!listEl) return;
  const entries = _extDraft[kind] || [];
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="ext-entry-empty">// no ${isStyle ? 'stylesheets' : 'scripts'} yet — click "Add ${isStyle ? 'stylesheet' : 'script'}" below</div>`;
    return;
  }
  const urlPh = isStyle
    ? 'http://192.168.1.x:PORT/mytheme.css  or  https://...'
    : 'http://192.168.1.x:PORT/myextension.js';
  const rawPh = isStyle
    ? ':root { --magenta: #ff6600; }&#10;.message-user { background: rgba(255,100,0,0.08); }'
    : "// Full DOM + state access&#10;document.getElementById('send-btn').textContent = 'EXECUTE';";
  const accept = isStyle ? '.css,text/css' : '.js,text/javascript';
  const fileLabel = isStyle ? 'Load .css file...' : 'Load .js file...';
  const rows = isStyle ? 5 : 6;

  listEl.innerHTML = entries.map((e, i) => `
    <div class="ext-entry ${isStyle ? '' : 'ext-entry-script'}" data-ext-entry="${escapeHtml(e.id)}">
      <div class="ext-entry-head">
        <input type="text" class="ext-entry-name" placeholder="${isStyle ? 'Stylesheet' : 'Script'} ${i + 1} name (optional)" value="${escapeHtml(e.name || '')}">
        <button class="btn btn-sm btn-danger" onclick="removeExtEntry('${escapeJsAttr(kind)}','${escapeJsAttr(e.id)}')">Remove</button>
      </div>
      <input type="text" class="ext-entry-url" placeholder="${urlPh}" value="${escapeHtml(e.url || '')}">
      <textarea class="ext-code-area ext-entry-raw" rows="${rows}" placeholder="${rawPh}">${escapeHtml(e.raw || '')}</textarea>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center;">
        <label class="avatar-file-btn" style="margin:0;">
          ${fileLabel}
          <input type="file" accept="${accept}" style="display:none" onchange="handleExtFileEntry(this,'${escapeJsAttr(kind)}','${escapeJsAttr(e.id)}')">
        </label>
        <button class="btn btn-sm" onclick="updateExtEntry('${escapeJsAttr(kind)}','${escapeJsAttr(e.id)}','raw','');renderExtEntries()">Clear inline</button>
      </div>
    </div>
  `).join('');
}

