/* ================================================================
   THE UPDATE BUTTON (1.8.0)

   ABOUT > THIS BUILD > CHECK FOR UPDATES, then UPDATE NOW and RESTART NOW.

   The page never talks to GitHub. It asks this server (/update/check), and
   the server asks GitHub -- only then, never on its own, which is the promise
   PRIVATE BY DESIGN makes in the same panel. Everything that decides what is
   safe to install happens in the server (internal/update): the signature
   built into the program, the SHA-256 of every download, and the rule that
   nothing older than the running build is ever offered. What the page adds
   is the question the person answers before anything is downloaded.

   Installing and restarting are for a browser on the PC GobboNet runs on;
   the server refuses them from anywhere else, and the page says so instead
   of offering a button that would fail. Messages are written with
   textContent, and every button is made here with addEventListener, so
   nothing the server or a release says is ever read as markup.
================================================================ */

let _updateCheck = null;   // the last /update/check answer
let _updatePoll = null;    // the install's status poll
let _updateWaiting = false; // RESTART NOW is waiting for the new program

const UPDATE_NOTES_MAX = 600;
const UPDATE_RESTART_WAIT_MS = 180000;

function _updateEls() {
  return {
    box: document.getElementById('about-update'),
    line: document.getElementById('about-update-line'),
    notes: document.getElementById('about-update-notes'),
    barWrap: document.getElementById('about-update-bar-wrap'),
    bar: document.getElementById('about-update-bar'),
    actions: document.getElementById('about-update-actions'),
    btn: document.getElementById('about-update-btn')
  };
}

/* Shows one state: a line, an optional note under it, and buttons.
   kind is '', 'ok', 'warn' or 'error'. actions: [{label, onClick, fill, title}]. */
function _updateShow(line, opts) {
  const o = opts || {};
  const el = _updateEls();
  if (!el.box) return;
  el.box.hidden = false;
  el.line.textContent = line;
  el.line.className = 'about-update-line' + (o.kind ? ' about-update-' + o.kind : '');
  const notes = String(o.notes || '').trim();
  el.notes.hidden = !notes;
  el.notes.textContent = notes.length > UPDATE_NOTES_MAX ? notes.slice(0, UPDATE_NOTES_MAX) + '…' : notes;
  const showBar = typeof o.progress === 'number';
  el.barWrap.hidden = !showBar;
  if (showBar) el.bar.style.width = Math.max(0, Math.min(100, o.progress)) + '%';
  el.actions.replaceChildren();
  (o.actions || []).forEach(a => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm' + (a.fill ? ' btn-fill' : '');
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.addEventListener('click', a.onClick);
    el.actions.appendChild(b);
  });
}

/* Only an https address is opened, in a new tab with noopener and
   noreferrer, as MODS and DISCORD are (openAboutLink). */
function _updateLinkAction(label, url) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return null;
  return { label: label, title: url, onClick: () => openAboutLink(url) };
}

/* A message from the server, ended with exactly one full stop. */
function _updateSentence(msg) {
  return String(msg || 'unknown error').replace(/[.\s]+$/, '') + '.';
}

function _updateSize(n) {
  return (typeof n === 'number' && n > 0 && typeof formatBytes === 'function') ? formatBytes(n) : '';
}

async function checkForUpdates(btn) {
  const el = _updateEls();
  const button = btn || el.btn;
  if (button) button.disabled = true;
  _updateShow('Checking for updates…');
  let body = null;
  try {
    const resp = await fetch(window.location.origin + '/update/check', { cache: 'no-store' });
    if (resp.status === 404) {
      _updateShow('This GobboNet server is older than 1.8.0 and cannot check for updates. Replace the gobbonet program file by hand.', { kind: 'warn' });
      return;
    }
    body = await resp.json().catch(() => null);
    if (!resp.ok || !body) throw new Error((body && body.error) || ('HTTP ' + resp.status));
  } catch (e) {
    _updateShow('Couldn’t check for updates: ' + _updateSentence((e && e.message) || e), { kind: 'error',
      actions: [{ label: 'TRY AGAIN', onClick: () => checkForUpdates() }] });
    return;
  } finally {
    if (button) button.disabled = false;
  }
  _updateCheck = body;
  renderUpdateCheck(body);
}

function renderUpdateCheck(body) {
  const b = body || {};
  const cur = b.current || {};
  const p = b.progress || {};
  // An install already under way, or finished and waiting, outranks the check.
  if (p.state && p.state !== 'failed') { _renderUpdateProgress(p); if (p.state !== 'installed') _startUpdatePoll(); return; }

  const skipped = (Array.isArray(b.notes) && b.notes.length) ? 'Skipped: ' + b.notes.join('; ') : '';
  switch (b.status) {
    case 'off':
      _updateShow('Update checks are switched off: update_releases_url is empty in config.toml.');
      return;
    case 'dev':
      _updateShow('This is a development build (' + (cur.build || 'dev') + '), so there is no release to compare it with.');
      return;
    case 'error':
      _updateShow('Couldn’t check for updates: ' + _updateSentence(b.error), { kind: 'error',
        actions: [{ label: 'TRY AGAIN', onClick: () => checkForUpdates() }] });
      return;
    case 'current':
      _updateShow('You have the newest GobboNet (' + (cur.version || '?') + ').', { kind: 'ok', notes: skipped });
      return;
    case 'unverifiable': {
      const newest = b.newest || {};
      _updateShow('This copy of GobboNet cannot install updates itself, because it was built without the update signing key.' +
        (newest.tag ? ' The newest release on GitHub is ' + newest.tag + '.' : ''), { kind: 'warn',
        actions: [_updateLinkAction('OPEN RELEASES PAGE', newest.page_url || b.releases_page)].filter(Boolean) });
      return;
    }
  }

  const o = b.offer || {};
  const what = o.hotfix
    ? 'A fix for GobboNet ' + o.version + ' is out: build ' + o.build + ' (you have ' + (cur.build || '?') + ').'
    : 'GobboNet ' + o.version + ' is out (you have ' + (cur.version || '?') + ').';
  const page = _updateLinkAction('WHAT’S NEW', o.notes_url || o.page_url);

  if (b.status === 'manual') {
    _updateShow(what + ' ' + (b.reason || ''), { kind: 'warn', notes: o.notes,
      actions: [_updateLinkAction('OPEN RELEASE PAGE', o.page_url || b.releases_page), page].filter(Boolean) });
    return;
  }
  if (b.status !== 'available') {
    _updateShow('Couldn’t read the answer from the update check.', { kind: 'error' });
    return;
  }
  const size = _updateSize(o.size);
  if (!b.on_this_pc) {
    _updateShow(what + ' Updates are installed from GobboNet on the PC it runs on; open ABOUT there to install it.',
      { kind: 'ok', notes: o.notes, actions: [page].filter(Boolean) });
    return;
  }
  _updateShow(what + (size ? ' The download is ' + size + '.' : ''), { kind: 'ok', notes: o.notes,
    actions: [{ label: 'UPDATE NOW', fill: true, onClick: () => installUpdate() }, page].filter(Boolean) });
}

/* The question asked before anything is downloaded. */
function updateConfirmText(body) {
  const b = body || {};
  const cur = b.current || {};
  const o = b.offer || {};
  const size = _updateSize(o.size);
  // An AppImage is replaced whole, not the program inside it (1.8.0).
  const what = (b.install && b.install.kind === 'appimage') ? 'the GobboNet AppImage' : 'the gobbonet program file';
  const head = o.hotfix
    ? 'Install the fix for GobboNet ' + o.version + '?'
    : 'Update GobboNet from ' + (cur.version || '?') + ' to ' + o.version + '?';
  return head + '\n\n' +
    'This downloads ' + (size || 'the release') + ' from GitHub, checks it against the GobboNet maintainer’s ' +
    'signature, and replaces ' + what + ' (' + (cur.build || '?') + ' → ' + o.build + '). ' +
    'Your chats, characters, models and settings are not touched.\n\n' +
    'Afterwards GobboNet restarts: a reply being written stops, the model loads again, and you sign in again.';
}

async function installUpdate() {
  const b = _updateCheck;
  const o = b && b.offer;
  if (!o || !o.build) return;
  if (!confirm(updateConfirmText(b))) return;
  _updateShow('Starting the download…', { progress: 0 });
  try {
    const resp = await fetch(window.location.origin + '/update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ build: o.build, serial: o.serial })
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || ('HTTP ' + resp.status));
    _renderUpdateProgress(out);
  } catch (e) {
    _updateShow('The update did not start: ' + _updateSentence((e && e.message) || e), { kind: 'error',
      actions: [{ label: 'CHECK AGAIN', onClick: () => checkForUpdates() }] });
    return;
  }
  _startUpdatePoll();
}

function _startUpdatePoll() {
  if (_updatePoll) return;
  _updatePoll = setInterval(async () => {
    try {
      const resp = await fetch(window.location.origin + '/update/status', { cache: 'no-store' });
      if (!resp.ok) return;
      const p = await resp.json();
      _renderUpdateProgress(p);
      if (p.state === 'installed' || p.state === 'failed' || !p.state) _stopUpdatePoll();
    } catch (e) { /* the next tick tries again */ }
  }, 500);
}

function _stopUpdatePoll() {
  if (_updatePoll) clearInterval(_updatePoll);
  _updatePoll = null;
}

function _renderUpdateProgress(p) {
  const s = p || {};
  const pct = s.total > 0 ? (100 * s.done / s.total) : 0;
  switch (s.state) {
    case 'downloading':
      _updateShow('Downloading ' + (s.build || 'the update') + '… ' +
        (s.total > 0 ? _updateSize(s.done) + ' of ' + _updateSize(s.total) : ''), { progress: pct });
      return;
    case 'checking':
      _updateShow('Checking the download…', { progress: 100 });
      return;
    case 'installing':
      _updateShow('Putting the new version in place…', { progress: 100 });
      return;
    case 'installed':
      if (_updateWaiting) return;
      _updateShow('GobboNet ' + (s.build || '') + ' is installed. It starts when GobboNet restarts.', { kind: 'ok',
        notes: s.can_restart ? '' : 'Close GobboNet and start it again to finish the update.',
        actions: s.can_restart ? [{ label: 'RESTART NOW', fill: true, onClick: () => restartIntoUpdate(s.build) }] : [] });
      return;
    case 'failed':
      _updateShow('The update was not installed, and nothing was changed: ' + _updateSentence(s.error), { kind: 'error',
        actions: [{ label: 'CHECK AGAIN', onClick: () => checkForUpdates() }] });
      return;
  }
}

async function restartIntoUpdate(build) {
  _updateWaiting = true;
  _updateShow('Restarting GobboNet… this page reloads when it is back.', { progress: 100 });
  try {
    const resp = await fetch(window.location.origin + '/update/restart', { method: 'POST' });
    if (!resp.ok) {
      const out = await resp.json().catch(() => ({}));
      throw new Error(out.error || ('HTTP ' + resp.status));
    }
  } catch (e) {
    _updateWaiting = false;
    _updateShow('GobboNet could not restart itself: ' + _updateSentence((e && e.message) || e) + ' Close it and start it again to finish the update.', { kind: 'warn' });
    return;
  }
  return waitForUpdatedServer(build);
}

/* The new program answers /health-fileserver with its own version. Before
   the restart this one answers with the old version, while it restarts
   nothing answers, and once the new one is up a page signed in to the old
   one gets 401: sessions do not survive a restart. Either of the last two is
   the moment to reload. */
async function waitForUpdatedServer(build) {
  const started = Date.now();
  while (Date.now() - started < UPDATE_RESTART_WAIT_MS) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const resp = await fetch(window.location.origin + '/health-fileserver', { cache: 'no-store' });
      if (resp.status === 401) { location.reload(); return; }
      if (resp.ok) {
        const h = await resp.json().catch(() => ({}));
        if (h.version && h.version === build) { location.reload(); return; }
      }
    } catch (e) { /* not back yet */ }
  }
  _updateWaiting = false;
  _updateShow('GobboNet has not come back yet. If its window closed, start GobboNet again, then reload this page.', { kind: 'warn' });
}

/* ABOUT opening asks THIS server -- never GitHub -- whether an install is
   under way or waiting for a restart, so reopening the panel shows it. */
async function refreshUpdateState() {
  if (_updateWaiting) return;
  try {
    const resp = await fetch(window.location.origin + '/update/status', { cache: 'no-store' });
    if (!resp.ok) return;
    const p = await resp.json();
    if (!p || !p.state) return;
    _renderUpdateProgress(p);
    if (p.state !== 'installed' && p.state !== 'failed') _startUpdatePoll();
  } catch (e) { /* an older server, or none: nothing to show */ }
}
