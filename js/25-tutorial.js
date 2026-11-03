/* @gobbonet-split js/25-tutorial.js
   The optional first-run tour (1.7.9, F4). Loads after 24-boot.js and waits
   on window.GobboNet.ready, so it never runs before the page has its state.
   @end-split-header */

/* ================================================================
   TOUR (1.7.9, F4)

   Six stops, each a spotlight on the real control and one sentence: pick a
   character, send a message, the model menu, CONFIG, your phone, and where
   help lives.

   Optional. A fresh profile is offered it once ("Show me around" / "Skip"),
   and either answer is remembered in state.settings.tourSeen, which syncs, so
   a second device does not ask again. A profile that already has a
   conversation of its own is never offered it: upgrading from 1.7.8 does not
   interrupt anyone. CONFIG -> Basics replays it at any time. Because tourSeen
   is a setting, `tour_seen = true` in config.toml's [ui] section turns the
   offer off on every new device (see seedSettingsFromServerPresets).

   Private. Everything here is in this file and the page's own CSS. It fetches
   nothing and records nothing except "seen".

   Stable targets. Each stop names data-tour="..." attributes, never a CSS
   class or a position, so moving controls around (as F3 did with CONFIG)
   cannot break it. A stop lists fallbacks in order: on the home screen there
   is no message box yet, so "send a message" points at + NEW_THREAD instead.
   A stop whose targets are all missing still shows, centred, rather than
   being skipped. tests/test-tutorial.mjs checks every name exists.
================================================================ */

const TOUR_STEPS = [
  {
    title: 'Pick a character',
    targets: ['characters'],
    text: () => 'CHARS holds the characters you talk to and your own persona, and it is where you make new ones.',
  },
  {
    title: 'Send a message',
    targets: ['message', 'new-chat'],
    text: (t) => t === 'message'
      ? 'Type here and press Enter to send; Shift+Enter starts a new line.'
      : '+ NEW_THREAD starts a chat with your character; then type at the bottom and press Enter to send.',
  },
  {
    title: 'Choose a model',
    targets: ['model'],
    text: () => 'This menu switches the AI model whenever you like, with no restart.',
  },
  {
    title: 'Settings',
    targets: ['config'],
    text: () => 'CONFIG holds every setting, sorted into sections, with a search box at the top to find any of them.',
  },
  {
    title: 'Your phone',
    targets: ['phone'],
    opens: 'config',
    text: () => 'Phone & Other Devices, under Devices & Network in CONFIG, lets you use GobboNet from your phone or another computer on your network.',
  },
  {
    title: 'Getting help',
    targets: ['help', 'home'],
    text: (t) => {
      const NAME = 'Gobbonet Informant';
      const installed = (state.characterCards || []).some(c => c && c.name === NAME);
      const offered = (typeof defaultCharacters !== 'undefined' ? defaultCharacters : []).some(c => c && c.name === NAME);
      if (installed) return 'For questions about GobboNet, pick the ' + NAME + ' in CHARS and start a chat with it.';
      if (!offered) return 'For questions about GobboNet, see TROUBLESHOOTING.md in the install folder or the Discord link in ABOUT.';
      return t === 'help'
        ? 'For questions about GobboNet, add the ' + NAME + ' here with + ADD and start a chat with it.'
        : 'For questions about GobboNet, the home screen (\u2302) has the ' + NAME + ', which answers them.';
    },
  },
];

let _tour = null;   // { mode: 'offer'|'tour', step, el, target, openedConfig, openedSidebar, returnFocus }

/* ── Should a fresh profile be offered the tour? ─────────────────── */
function tourShouldOffer() {
  if (_tour) return false;
  if (!state || !state.settings || state.settings.tourSeen) return false;
  if (typeof stateSync !== 'undefined' && stateSync && stateSync.status === 'locked') return false;
  if (typeof document !== 'undefined') {
    if (document.visibilityState === 'hidden') return false;
    if (document.querySelector('.modal-backdrop.open')) return false;   // never on top of another panel or the sign-in
  }
  // A conversation of the user's own means this is not a first run.
  const used = (state.threads || []).some(t => t && Array.isArray(t.messages) && t.messages.some(m => m && m.role === 'user'));
  return !used;
}

function _tourMarkSeen() {
  if (state.settings.tourSeen) return;
  state.settings.tourSeen = true;
  try { saveState(); } catch (e) { console.warn('[tour] could not save "seen":', e && e.message); }
}

/* ── Finding a target ────────────────────────────────────────────── */
function tourTarget(name) {
  const el = document.querySelector('[data-tour="' + name + '"]');
  if (!el) return null;
  if (!el.getClientRects().length) return null;          // display:none, or inside something hidden
  const closed = el.closest('details:not([open])');
  if (closed && !el.matches('summary')) return null;
  return el;
}
function _tourResolve(step) {
  for (const name of step.targets) {
    // A sidebar control counts as present even while the sidebar is closed:
    // the tour opens it for that stop.
    const el = document.querySelector('[data-tour="' + name + '"]');
    if (!el) continue;
    if (el.closest('#sidebar')) return { name, el };
    if (step.opens === 'config' && el.closest('#settings-modal')) return { name, el };
    const live = tourTarget(name);
    if (live) return { name, el: live };
  }
  return { name: null, el: null };
}

/* ── The overlay ─────────────────────────────────────────────────── */
function _tourBuild() {
  let root = document.getElementById('tour-root');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'tour-root';
  root.className = 'tour-root';
  root.hidden = true;
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.setAttribute('aria-describedby', 'tour-text');
  const count = document.createElement('div');
  count.className = 'tour-count';
  const title = document.createElement('h2');
  title.className = 'tour-title';
  title.id = 'tour-title';
  const text = document.createElement('p');
  text.className = 'tour-text';
  text.id = 'tour-text';
  const note = document.createElement('p');
  note.className = 'tour-note';
  const actions = document.createElement('div');
  actions.className = 'tour-actions';
  const mk = (cls, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  const end = mk('btn btn-sm tour-end', 'End tour', () => endTour(_tour && _tour.mode === 'offer' ? 'skip' : 'end'));
  const spacer = document.createElement('span');
  spacer.className = 'tour-spacer';
  const back = mk('btn btn-sm tour-back', 'Back', () => tourBack());
  const next = mk('btn btn-fill btn-sm tour-next', 'Next', () => tourNext());
  actions.append(end, spacer, back, next);
  card.append(count, title, text, note, actions);
  const live = document.createElement('div');
  live.className = 'tour-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(spot, card, live);
  // The shade takes every click, so nothing behind it changes mid-tour.
  root.addEventListener('mousedown', (e) => { if (!card.contains(e.target)) e.preventDefault(); });
  document.body.appendChild(root);
  return root;
}

function _tourParts() {
  const root = _tourBuild();
  return {
    root,
    spot: root.querySelector('.tour-spot'),
    card: root.querySelector('.tour-card'),
    count: root.querySelector('.tour-count'),
    title: root.querySelector('.tour-title'),
    text: root.querySelector('.tour-text'),
    note: root.querySelector('.tour-note'),
    end: root.querySelector('.tour-end'),
    back: root.querySelector('.tour-back'),
    next: root.querySelector('.tour-next'),
    live: root.querySelector('.tour-live'),
  };
}

/* The part of el that can actually be seen: its box cut down to every
   scrolling box around it (CONFIG's panel, the sidebar), so a tall box in a
   panel is not outlined past the panel's edge. */
function _tourVisibleRect(el) {
  const b = el.getBoundingClientRect();
  let top = b.top, left = b.left, bottom = b.bottom, right = b.right;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (!/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) continue;
    const c = a.getBoundingClientRect();
    top = Math.max(top, c.top); left = Math.max(left, c.left);
    bottom = Math.min(bottom, c.bottom); right = Math.min(right, c.right);
  }
  if (bottom <= top || right <= left) return null;
  return { top, left, bottom, right, width: right - left, height: bottom - top };
}

/* Put the spotlight on the target and the card beside it, inside the window. */
function tourPosition() {
  if (!_tour) return;
  const p = _tourParts();
  const vw = window.innerWidth, vh = window.innerHeight, M = 16, PAD = 6;
  // A re-render (a sync landing, say) can replace the control under us: find
  // it again by name rather than point at a node that left the page.
  if (_tour.target && !document.contains(_tour.target) && _tour.targetName) {
    _tour.target = document.querySelector('[data-tour="' + _tour.targetName + '"]');
  }
  const el = _tour.target;
  let r = el && el.getClientRects().length ? _tourVisibleRect(el) : null;
  if (!r || (r.width === 0 && r.height === 0)) {
    p.spot.classList.add('tour-spot-none');
    p.card.style.left = Math.max(M, (vw - p.card.offsetWidth) / 2) + 'px';
    p.card.style.top = Math.max(M, (vh - p.card.offsetHeight) / 2) + 'px';
    return;
  }
  p.spot.classList.remove('tour-spot-none');
  const s = {
    left: Math.max(0, r.left - PAD), top: Math.max(0, r.top - PAD),
    right: Math.min(vw, r.right + PAD), bottom: Math.min(vh, r.bottom + PAD),
  };
  Object.assign(p.spot.style, {
    left: s.left + 'px', top: s.top + 'px',
    width: Math.max(0, s.right - s.left) + 'px', height: Math.max(0, s.bottom - s.top) + 'px',
  });
  const cw = p.card.offsetWidth, ch = p.card.offsetHeight, GAP = 12;
  let top, left = Math.min(Math.max(M, r.left + r.width / 2 - cw / 2), vw - M - cw);
  if (vh - s.bottom >= ch + GAP + M) top = s.bottom + GAP;
  else if (s.top >= ch + GAP + M) top = s.top - GAP - ch;
  else if (vw - s.right >= cw + GAP + M) { left = s.right + GAP; top = Math.min(Math.max(M, r.top), vh - M - ch); }
  else if (s.left >= cw + GAP + M) { left = s.left - GAP - cw; top = Math.min(Math.max(M, r.top), vh - M - ch); }
  else top = vh - M - ch;   // a target as big as the window: the card sits at the bottom
  p.card.style.left = Math.max(M, left) + 'px';
  p.card.style.top = Math.max(M, top) + 'px';
}
let _tourRaf = 0;
function _tourReflow() {
  if (_tourRaf) return;
  _tourRaf = requestAnimationFrame(() => { _tourRaf = 0; tourPosition(); });
}

/* ── Opening and closing what a stop needs ───────────────────────── */
function _tourSidebar(open) {
  if (open && !state.sidebarOpen) {
    state.sidebarOpen = true;
    updateSidebarVisibility();
    _tour.openedSidebar = true;
  } else if (!open && _tour.openedSidebar) {
    state.sidebarOpen = false;
    updateSidebarVisibility();
    _tour.openedSidebar = false;
  }
}
function _tourConfig(open) {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  if (open && !modal.classList.contains('open')) {
    openSettings();
    const box = document.getElementById('cfg-search');
    if (box && box.value && typeof filterConfig === 'function') { box.value = ''; filterConfig(''); }
    _tour.openedConfig = true;
  } else if (!open && _tour.openedConfig) {
    // Opened by the tour and nothing typed into it: closed, never saved.
    modal.classList.remove('open');
    try { applyAvatarScale(); } catch (_) {}
    _tour.openedConfig = false;
  }
}

/* ── Showing a stop ──────────────────────────────────────────────── */
function _tourShow() {
  const p = _tourParts();
  p.root.hidden = false;
  document.body.classList.add('tour-open');
  if (_tour.mode === 'offer') {
    _tour.target = null;
    p.root.classList.add('tour-offering');
    p.count.textContent = '';
    p.title.textContent = 'New to GobboNet?';
    p.text.textContent = 'Take a one-minute tour: six stops, each pointing at the real control.';
    p.note.textContent = 'You can take it later from CONFIG → Basics.';
    p.end.textContent = 'Skip';
    p.back.hidden = true;
    p.next.textContent = 'Show me around';
    p.live.textContent = 'New to GobboNet? A one-minute tour is offered.';
    tourPosition();
    p.next.focus();
    return;
  }
  p.root.classList.remove('tour-offering');
  const i = _tour.step, step = TOUR_STEPS[i];
  _tourConfig(step.opens === 'config');
  const { name, el } = _tourResolve(step);
  _tourSidebar(!!(el && el.closest('#sidebar')));
  _tour.target = el;
  _tour.targetName = name;
  if (!el) console.warn('[tour] nothing to point at for "' + step.title + '" (' + step.targets.join(', ') + ')');
  const sentence = step.text(name);
  p.count.textContent = (i + 1) + ' of ' + TOUR_STEPS.length;
  p.title.textContent = step.title;
  p.text.textContent = sentence;
  p.note.textContent = '';
  p.end.textContent = 'End tour';
  p.back.hidden = false;
  p.back.disabled = i === 0;
  p.next.textContent = i === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
  p.live.textContent = 'Step ' + (i + 1) + ' of ' + TOUR_STEPS.length + ': ' + step.title + '. ' + sentence;
  // Inside CONFIG the box is brought to the top (under the pinned search row,
  // see scroll-margin in 19-tour.css) so its heading shows; elsewhere the
  // smallest scroll that brings it into view.
  if (el) {
    const inPanel = !!el.closest('.modal-backdrop');
    try { el.scrollIntoView({ block: inPanel ? 'start' : 'nearest', inline: 'nearest' }); } catch (_) {}
  }
  tourPosition();
  // The sidebar and CONFIG slide in; follow them until they settle.
  for (const ms of [60, 180, 320, 480]) setTimeout(_tourReflow, ms);
  p.next.focus();
}

/* ── Public ──────────────────────────────────────────────────────── */
function offerTour() {
  if (_tour) return false;
  _tour = { mode: 'offer', step: 0, returnFocus: document.activeElement };
  _tourListen(true);
  _tourShow();
  return true;
}

function startTour() {
  if (_tour && _tour.mode === 'tour') return false;
  const returnFocus = _tour ? _tour.returnFocus : document.activeElement;
  _tour = { mode: 'tour', step: 0, returnFocus, openedConfig: false, openedSidebar: false };
  _tourMarkSeen();   // taking it counts: a tab closed half-way does not ask again
  _tourListen(true);
  _tourShow();
  return true;
}

function tourNext() {
  if (!_tour) return;
  if (_tour.mode === 'offer') { startTour(); return; }
  if (_tour.step >= TOUR_STEPS.length - 1) { endTour('done'); return; }
  _tour.step++;
  _tourShow();
}

function tourBack() {
  if (!_tour || _tour.mode !== 'tour' || _tour.step === 0) return;
  _tour.step--;
  _tourShow();
}

/** reason: 'skip' (the offer), 'end' (left part-way), 'done' (the last stop). */
function endTour(reason) {
  if (!_tour) return;
  _tourMarkSeen();
  _tourConfig(false);
  _tourSidebar(false);
  const back = _tour.returnFocus;
  _tour = null;
  _tourListen(false);
  const root = document.getElementById('tour-root');
  if (root) root.hidden = true;
  document.body.classList.remove('tour-open');
  if (back && typeof back.focus === 'function' && document.contains(back)) { try { back.focus(); } catch (_) {} }
  console.log('[tour] ' + ({ skip: 'skipped', end: 'ended early', done: 'finished' }[reason] || 'closed') +
              '. CONFIG → Basics has it any time.');
}

function tourActive() { return _tour ? _tour.mode : null; }

/* CONFIG -> Basics -> SHOW ME AROUND. Closes CONFIG the ordinary way, so an
   unsaved config.toml still asks first; if that is refused, nothing starts. */
function replayTour() {
  if (typeof closeSettings === 'function' && closeSettings() === false) return false;
  return startTour();
}

/* ── Keys and window changes ─────────────────────────────────────── */
function _tourKey(e) {
  if (!_tour) return;
  const card = document.querySelector('#tour-root .tour-card');
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    endTour(_tour.mode === 'offer' ? 'skip' : 'end');
    return;
  }
  if (e.key === 'Tab' && card) {   // keep focus inside the card
    const f = [...card.querySelectorAll('button:not([disabled]):not([hidden])')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (_tour.mode !== 'tour') return;
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); tourNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); tourBack(); }
}
let _tourListening = false;
let _tourTicker = null;
function _tourListen(on) {
  if (on === _tourListening) return;
  _tourListening = on;
  // A slow, cheap re-check too: the page re-renders on its own (a sync
  // arriving, a model list loading) with no event the tour would hear.
  if (on) _tourTicker = setInterval(_tourReflow, 500);
  else { clearInterval(_tourTicker); _tourTicker = null; }
  const m = on ? 'addEventListener' : 'removeEventListener';
  document[m]('keydown', _tourKey, true);   // capture: Esc ends the tour, not CONFIG under it
  window[m]('resize', _tourReflow);
  window[m]('scroll', _tourReflow, true);
}

/* ── First run ───────────────────────────────────────────────────── */
/* Waits for boot and the first sync to settle (a second device must hear that
   the tour was seen before deciding), then for any panel to close, then a
   moment longer. Gives up after a minute; the next load tries again. */
function _tourWhenReady() {
  const started = Date.now();
  const tick = () => {
    if (_tour || (state.settings && state.settings.tourSeen)) return;
    const booted = typeof _appBooted === 'undefined' || _appBooted;
    if (booted && tourShouldOffer()) { offerTour(); return; }
    if (Date.now() - started < 60000) setTimeout(tick, 400);
  };
  setTimeout(tick, 800);
}
if (typeof window !== 'undefined' && window.GobboNet && window.GobboNet.ready) {
  window.GobboNet.ready.then(r => { if (!r || r.ok !== false) _tourWhenReady(); }).catch(() => {});
}
