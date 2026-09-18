/**
 * Executes the REAL char-modal dismiss handlers from js/22-scheduler.js in a
 * minimal fake DOM, across the device / pointer / target matrix.
 * Asserts on whether closeCharacters() actually fired.
 *
 * TWO RULES ARE UNDER TEST, and they are separate on purpose:
 *
 *   STICKY    -- a user setting. Governs whether a CASUAL gesture (single
 *                backdrop click, Escape) may dismiss the modal.
 *   THE GUARD -- not a setting. Governs whether ANY dismissal may destroy
 *                unsaved work, and stays silent when there is none.
 *
 * Section A is the original matrix from v1.7 item 8, unchanged: sticky on,
 * editor clean, and every answer must be exactly what it always was -- the
 * guard is invisible when there is nothing to guard. The rest is v1.7.4
 * item 2.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

// '..' not '.': these live in tests/ and read the frontend from the repo
// root, so the base has to climb out of this directory.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/22-scheduler.js', 'utf8');

// Pull out just the char-modal block and the Escape handler; the rest of the
// file is the scheduler and needs a far larger fake DOM to load.
const start = SRC.indexOf('/* \u2500\u2500 Character modal: sticky');
const endMark = "document.getElementById('sched-modal')";
const escStart = SRC.indexOf('function _charEditorEl()');
const escEnd = SRC.indexOf('function openAbout()');
if (start < 0 || escStart < 0 || escEnd < 0) {
  console.error('could not locate the char-modal block in js/22-scheduler.js');
  process.exit(1);
}
const block = SRC.slice(start, SRC.indexOf(endMark, start));
const escBlock = SRC.slice(escStart, escEnd);

let closed = [];
let confirmLog = [];
let confirmAnswer = true;

function makeEl(id) {
  return { id, style: {}, _h: {}, _cls: new Set(), textContent: '',
    classList: {
      add(c) { this._o._cls.add(c); },
      remove(c) { this._o._cls.delete(c); },
      contains(c) { return this._o._cls.has(c); },
    },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    fire(t, ev) {
      // A closed modal is display:none and receives nothing further. Without
      // this, the trailing click+dblclick of a real double-click would keep
      // arriving at a modal that is already gone.
      if (this._closed) return;
      (this._h[t] || []).forEach(fn => fn(ev));
    } };
}

/* An editor whose fields the fingerprint can actually read. The real
   fingerprint walks querySelectorAll('input, textarea, select'), so the fake
   returns a field list of the same shape. */
function makeEditor(id, fields) {
  const el = makeEl(id);
  el._fields = fields.map(f => ({ type: 'text', value: '', checked: false, ...f }));
  el.querySelectorAll = () => el._fields;
  el.field = (fid) => el._fields.find(f => f.id === fid);
  return el;
}

// 'absent' rather than undefined: a default parameter fires on undefined, so
// there would be no way to express "the key is not in the settings blob".
function build({ hasFinePointer, sticky = true } = {}) {
  closed = [];
  confirmLog = [];
  const els = {
    'char-modal': makeEl('char-modal'),
    'card-editor': makeEditor('card-editor', [
      { id: 'card-name', value: 'Archivist' },
      { id: 'card-personality', value: 'Dry, precise.' },
      { id: 'card-lore-enabled', type: 'checkbox', checked: true },
      { id: 'card-avatar-file', type: 'file', value: 'C:\\fakepath\\a.png' },
    ]),
    'persona-editor': makeEditor('persona-editor', [
      { id: 'persona-name', value: 'Anonymous' },
      { id: 'persona-description', value: '' },
    ]),
    'char-dismiss-notice': makeEl('char-dismiss-notice'),
  };
  for (const el of Object.values(els)) el.classList._o = el;
  // The editors' own fields are reachable by id too, for _charEditorName().
  for (const edId of ['card-editor', 'persona-editor']) {
    for (const f of els[edId]._fields) els[f.id] = f;
  }
  els['card-editor'].style.display = 'none';
  els['persona-editor'].style.display = 'none';

  const docHandlers = {};
  const ctx = {
    console,
    state: { settings: sticky === 'absent' ? {} : { stickyCards: sticky } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: (msg) => { confirmLog.push(msg); return confirmAnswer; },
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener: (t, fn) => { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    },
    window: {
      matchMedia: (q) => ({ matches: q === '(any-pointer: fine)' ? hasFinePointer : false }),
    },
    closeCharacters: () => { closed.push('characters'); els['char-modal']._closed = true; },
    closeSettings: () => closed.push('settings'),
    closeScheduler: () => closed.push('scheduler'),
    closeExtensions: () => closed.push('ext'),
    closeDataManager: () => closed.push('data'),
    closeAbout: () => closed.push('about'),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\n' + escBlock, ctx);

  const h = { ctx, els, docHandlers };
  h.openEditor = (which = 'card') => {
    els[which + '-editor'].style.display = '';
    ctx.charEditorOpened();
  };
  h.type = (fieldId, value) => {
    for (const edId of ['card-editor', 'persona-editor']) {
      const f = els[edId].field(fieldId);
      if (f) { f.value = value; return; }
    }
    throw new Error('no such field: ' + fieldId);
  };
  h.notice = () => (els['char-dismiss-notice'].classList.contains('show')
    ? els['char-dismiss-notice'].textContent : null);
  h.escape = () => (docHandlers.keydown || []).forEach(fn => fn({ key: 'Escape' }));
  return h;
}

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); }
};

// Simulate an interaction: pointerdown of a given type, then click/dblclick.
function interact(h, { hasFinePointer, pointerType, event, targetId }) {
  const { els } = h;
  const bd = els['char-modal'];
  bd.fire('pointerdown', { pointerType });
  bd.fire(event, { target: { id: targetId } });
}

/* A real double-click delivers click, click, dblclick -- in that order, to
   the same element. A handler that assumes only the dblclick arrives will run
   the guard three times, or leave a notice over a modal that is closing. */
function realDblclick(h, { pointerType, targetId }) {
  const bd = h.els['char-modal'];
  bd.fire('pointerdown', { pointerType });
  bd.fire('click', { target: { id: targetId } });
  bd.fire('click', { target: { id: targetId } });
  bd.fire('dblclick', { target: { id: targetId } });
}

/* ================================================================
   A. THE ORIGINAL MATRIX -- sticky on, nothing unsaved
================================================================ */
console.log('\n=== Desktop, mouse (fine pointer) ===');
{
  let h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('single click on backdrop does NOT close', closed.length === 0, closed.join(','));

  h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'dblclick', targetId: 'char-modal' });
  check('double click on backdrop DOES close', closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'dblclick', targetId: 'card-name' });
  check('double click INSIDE the modal does not close (word selection)',
        closed.length === 0, closed.join(','));
}

console.log('\n=== Phone / tablet (no fine pointer at all) ===');
{
  let h = build({ hasFinePointer: false });
  interact(h, { pointerType: 'touch', event: 'click', targetId: 'char-modal' });
  check('tap on backdrop does nothing', closed.length === 0, closed.join(','));

  h = build({ hasFinePointer: false });
  interact(h, { pointerType: 'touch', event: 'dblclick', targetId: 'char-modal' });
  check('double-TAP on backdrop does nothing either', closed.length === 0, closed.join(','));
}

console.log('\n=== Touchscreen laptop (fine pointer AND touch) ===');
{
  // This is the device the roadmap calls out, and the one
  // matchMedia('(pointer: coarse)') would have got wrong.
  let h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'touch', event: 'dblclick', targetId: 'char-modal' });
  check('double-TAP with a finger does NOT close', closed.length === 0, closed.join(','));

  h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'dblclick', targetId: 'char-modal' });
  check('double CLICK with the mouse DOES close', closed.includes('characters'), closed.join(','));

  // And the same machine must switch behaviour between interactions.
  h = build({ hasFinePointer: true });
  const bd = h.els['char-modal'];
  bd.fire('pointerdown', { pointerType: 'touch' });
  bd.fire('dblclick', { target: { id: 'char-modal' } });
  const afterTouch = closed.length;
  bd.fire('pointerdown', { pointerType: 'mouse' });
  bd.fire('dblclick', { target: { id: 'char-modal' } });
  check('same session: finger does not close, then mouse does',
        afterTouch === 0 && closed.length === 1, `${afterTouch} then ${closed.length}`);
}

console.log('\n=== Escape ===');
{
  let h = build({ hasFinePointer: true });
  h.escape();
  check('list view: Escape closes the character modal',
        closed.includes('characters'), closed.join(','));
  check('and still closes the other modals',
        ['settings', 'scheduler', 'ext', 'data', 'about'].every(m => closed.includes(m)),
        closed.join(','));

  h = build({ hasFinePointer: true });
  h.openEditor('card');
  h.escape();
  check('EDITING: Escape does not discard the half-written card',
        !closed.includes('characters'), closed.join(','));
  check('but other modals still respond to Escape',
        closed.includes('settings') && closed.includes('about'), closed.join(','));

  h = build({ hasFinePointer: true });
  h.openEditor('persona');
  h.escape();
  check('EDITING a persona: same protection', !closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: true });
  (h.docHandlers.keydown || []).forEach(fn => fn({ key: 'a' }));
  check('a non-Escape key does nothing', closed.length === 0, closed.join(','));
}

/* ================================================================
   B. THE REFUSAL IS NO LONGER SILENT

   A no-op the user cannot tell apart from a broken window. It is also why
   nobody found the double-click: nothing anywhere mentioned it.
================================================================ */
console.log('\n=== Notice on a refused dismissal ===');
{
  let h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('mouse, list view: refused click explains the double-click',
        /double-click/i.test(h.notice() || ''), JSON.stringify(h.notice()));

  h = build({ hasFinePointer: false });
  interact(h, { pointerType: 'touch', event: 'click', targetId: 'char-modal' });
  const touchHint = h.notice() || '';
  check('touch, list view: refused tap points at CLOSE, not double-click',
        /CLOSE/.test(touchHint) && !/double-click/i.test(touchHint), JSON.stringify(touchHint));

  h = build({ hasFinePointer: true });
  h.openEditor('card');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('mouse, editing: the hint names CANCEL / SAVE as well',
        /CANCEL/.test(h.notice() || '') && /editing/i.test(h.notice() || ''),
        JSON.stringify(h.notice()));

  // A touchscreen laptop has a fine pointer, so the media query alone would
  // hand a finger the mouse hint. The pointer type has to win, for the same
  // reason it wins in the dismiss rule itself.
  h = build({ hasFinePointer: true });
  h.openEditor('card');
  interact(h, { pointerType: 'touch', event: 'click', targetId: 'char-modal' });
  check('touchscreen laptop, finger: gets the touch hint, not the mouse one',
        !/double-click/i.test(h.notice() || ''), JSON.stringify(h.notice()));

  h = build({ hasFinePointer: true });
  h.openEditor('card');
  h.escape();
  check('Escape while editing also explains itself',
        /CANCEL/.test(h.notice() || ''), JSON.stringify(h.notice()));

  h = build({ hasFinePointer: true });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'card-name' });
  check('a click INSIDE the modal shows no notice', h.notice() === null, JSON.stringify(h.notice()));

  h = build({ hasFinePointer: true });
  realDblclick(h, { pointerType: 'mouse', targetId: 'char-modal' });
  check('a completed double-click leaves no notice over the closed modal',
        closed.includes('characters') && h.notice() === null, JSON.stringify(h.notice()));
}

/* ================================================================
   C. OPTIONAL STICKY

   Off means the modal behaves like every other one. It does NOT mean unsaved
   work becomes disposable -- that is section D.
================================================================ */
console.log('\n=== stickyCards: false ===');
{
  let h = build({ hasFinePointer: true, sticky: false });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('single click on backdrop DOES close', closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: false, sticky: false });
  interact(h, { pointerType: 'touch', event: 'click', targetId: 'char-modal' });
  check('and a tap closes it on a phone too', closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: true, sticky: false });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'card-name' });
  check('a click inside the modal still does not close', closed.length === 0, closed.join(','));

  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.escape();
  check('Escape closes an untouched editor', closed.includes('characters'), closed.join(','));

  // The real event sequence, which is where a naive handler closes once and
  // then tries again over a modal that is already gone.
  h = build({ hasFinePointer: true, sticky: false });
  realDblclick(h, { pointerType: 'mouse', targetId: 'char-modal' });
  check('a double-click closes exactly once, not twice',
        closed.filter(c => c === 'characters').length === 1, closed.join(','));

  h = build({ hasFinePointer: true, sticky: false });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('and no notice, because nothing was refused', h.notice() === null, JSON.stringify(h.notice()));

  // No key at all: every install that predates this option.
  h = build({ hasFinePointer: true, sticky: 'absent' });
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('an upgrade with no stickyCards key stays STICKY', closed.length === 0, closed.join(','));
}

/* ================================================================
   D. THE GUARD -- unsaved work survives every path
================================================================ */
console.log('\n=== Unsaved changes ===');
{
  confirmAnswer = true;

  let h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('clean editor, sticky off: closes with no confirm',
        closed.includes('characters') && confirmLog.length === 0, confirmLog.join('|'));

  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-personality', 'Dry, precise. And newly rewritten.');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('dirty editor: the user is asked first', confirmLog.length === 1, confirmLog.join('|'));
  check('and the question names the character', /Archivist/.test(confirmLog[0] || ''), confirmLog[0]);

  confirmAnswer = false;
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-personality', 'changed');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('saying no keeps the modal open', !closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-personality', 'changed');
  h.escape();
  check('Escape on a dirty editor is refused when the user says no',
        !closed.includes('characters'), closed.join(','));

  confirmAnswer = true;
  h = build({ hasFinePointer: true });   // sticky ON
  h.openEditor('card');
  h.type('card-personality', 'changed');
  interact(h, { pointerType: 'mouse', event: 'dblclick', targetId: 'char-modal' });
  check('sticky on: a double-click over a dirty editor still asks',
        confirmLog.length === 1 && closed.includes('characters'), confirmLog.join('|'));

  // A checkbox is a change too, and the fingerprint reads .checked not .value.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.els['card-editor'].field('card-lore-enabled').checked = false;
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('a toggled checkbox counts as unsaved work', confirmLog.length === 1, confirmLog.join('|'));

  // A file input's value is a synthetic c:\fakepath\... string. Counting it
  // would report dirt for a field the user cannot type into, and the data it
  // stands for is already captured by the text field beside it.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.els['card-editor'].field('card-avatar-file').value = 'C:\\fakepath\\other.png';
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('a file input is not mistaken for unsaved work', confirmLog.length === 0, confirmLog.join('|'));

  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('persona');
  h.type('persona-description', 'A quiet archivist.');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('the persona editor is guarded the same way', confirmLog.length === 1, confirmLog.join('|'));
  check('and its confirm names the persona', /Anonymous/.test(confirmLog[0] || ''), confirmLog[0]);

  // A brand-new card can genuinely have an empty name field, and the fallback
  // wording has to match which editor is open.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-name', '');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('an unnamed card falls back to "this character"',
        /this character/.test(confirmLog[0] || ''), confirmLog[0]);

  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('persona');
  h.type('persona-name', '');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('an unnamed persona falls back to "this persona", not "this character"',
        /this persona/.test(confirmLog[0] || ''), confirmLog[0]);

  // Typing and then typing it back is not a change.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-personality', 'something else');
  h.type('card-personality', 'Dry, precise.');
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('an edit that was undone is not unsaved work',
        confirmLog.length === 0 && closed.includes('characters'), confirmLog.join('|'));

  // Leaving the editor must drop the snapshot, or it reports dirt against an
  // editor that is no longer open.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-personality', 'changed');
  h.ctx.charEditorClosed();
  h.els['card-editor'].style.display = 'none';
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('back in the list view, nothing is guarded',
        confirmLog.length === 0 && closed.includes('characters'), confirmLog.join('|'));

  // No snapshot at all -- the state a fresh page load starts in.
  h = build({ hasFinePointer: true, sticky: false });
  h.els['card-editor'].style.display = '';   // open, but never snapshotted
  interact(h, { pointerType: 'mouse', event: 'click', targetId: 'char-modal' });
  check('an editor with no snapshot is treated as clean, not dirty',
        confirmLog.length === 0 && closed.includes('characters'), confirmLog.join('|'));
}

/* ================================================================
   E. THE CANCEL HOLE

   charDismissGuard() is what cancelCardEdit() and cancelPersonaEdit() call.
   Until v1.7.4 they called nothing: the backdrop and Escape were both refused
   to protect these edits, while the UI pointed at a button that dropped them
   without asking.
================================================================ */
console.log('\n=== The guard as Cancel uses it ===');
{
  confirmAnswer = true;
  let h = build({ hasFinePointer: true });
  h.openEditor('card');
  check('clean editor: Cancel proceeds without asking',
        h.ctx.charDismissGuard() === true && confirmLog.length === 0, confirmLog.join('|'));

  h = build({ hasFinePointer: true });
  h.openEditor('card');
  h.type('card-name', 'Archivist II');
  check('dirty editor: Cancel asks',
        h.ctx.charDismissGuard() === true && confirmLog.length === 1, confirmLog.join('|'));

  confirmAnswer = false;
  h = build({ hasFinePointer: true });
  h.openEditor('card');
  h.type('card-name', 'Archivist II');
  check('and saying no stops Cancel', h.ctx.charDismissGuard() === false);

  // Sticky is taste. This is not. Turning sticky off must not turn it off.
  h = build({ hasFinePointer: true, sticky: false });
  h.openEditor('card');
  h.type('card-name', 'Archivist II');
  check('the guard is independent of the sticky setting',
        h.ctx.charDismissGuard() === false);
  confirmAnswer = true;
}

/* ================================================================
   F. CALL SITES

   The editors live in other files, so these are checked statically rather
   than by standing up two more modules' worth of fake DOM.
================================================================ */
console.log('\n=== Call sites ===');
{
  const cards = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
  const personas = fs.readFileSync(ROOT + '/js/17-personas.js', 'utf8');
  const html = fs.readFileSync(ROOT + '/chat.html', 'utf8');
  const stateSrc = fs.readFileSync(ROOT + '/js/04-state.js', 'utf8');

  // Function declarations in this codebase all close on a brace at column 0,
  // so the next '\n}' is the end of the body.
  const fnBody = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? src.length : j);
  };

  check('cancelCardEdit goes through the guard',
        /charDismissGuard\(\)/.test(fnBody(cards, 'cancelCardEdit')));
  check('cancelPersonaEdit goes through the guard',
        /charDismissGuard\(\)/.test(fnBody(personas, 'cancelPersonaEdit')));
  check('editCard takes a clean snapshot',
        /charEditorOpened\(\)/.test(fnBody(cards, 'editCard')));
  check('editPersona takes a clean snapshot',
        /charEditorOpened\(\)/.test(fnBody(personas, 'editPersona')));

  // Every path that leaves an editor has to drop the snapshot, or a stale one
  // reports unsaved work from the list view.
  for (const [src, file, names] of [
    [cards, '15-cards.js', ['saveCard', 'deleteCard', 'cancelCardEdit', 'openCharacters', 'closeCharacters']],
    [personas, '17-personas.js', ['savePersona', 'deletePersona', 'cancelPersonaEdit']],
  ]) {
    for (const n of names) {
      check(`${file}: ${n} clears the snapshot`, /charEditorClosed\(\)/.test(fnBody(src, n)));
    }
  }

  check('the notice element exists in chat.html', /id="char-dismiss-notice"/.test(html));
  check('the CONFIG toggle exists in chat.html', /id="set-sticky-cards"/.test(html));
  check('openSettings and saveSettings both wire it',
        (cards.match(/set-sticky-cards/g) || []).length === 2);
  check('stickyCards defaults to true', /stickyCards:\s*true/.test(stateSrc));

  // Absent must mean sticky, so the dismiss rule tests for an explicit false
  // and the settings panel reads !== false. A truthy test on either would
  // silently switch every existing install to click-to-dismiss on upgrade.
  check('the dismiss rule tests stickyCards === false',
        /state\.settings\.stickyCards === false/.test(SRC));
  check('openSettings reads stickyCards !== false',
        /state\.settings\.stickyCards !== false/.test(cards));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
