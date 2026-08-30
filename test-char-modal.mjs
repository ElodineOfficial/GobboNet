/**
 * Executes the REAL char-modal dismiss handlers from js/22-scheduler.js in a
 * minimal fake DOM, across the device / pointer / target matrix.
 * Asserts on whether closeCharacters() actually fired.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/22-scheduler.js', 'utf8');

// Pull out just the char-modal block and the Escape handler; the rest of the
// file is the scheduler and needs a far larger fake DOM to load.
const start = SRC.indexOf('/* ── Character modal: sticky');
const endMark = "document.getElementById('sched-modal')";
const block = SRC.slice(start, SRC.indexOf(endMark, start));
const escStart = SRC.indexOf('function _charEditorIsOpen()');
const escEnd = SRC.indexOf('function openAbout()');
const escBlock = SRC.slice(escStart, escEnd);

let closed = [];

function makeEl(id) {
  return { id, style: {}, _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    fire(t, ev) { (this._h[t] || []).forEach(fn => fn(ev)); } };
}

function build({ hasFinePointer }) {
  closed = [];
  const els = {
    'char-modal': makeEl('char-modal'),
    'card-editor': makeEl('card-editor'),
    'persona-editor': makeEl('persona-editor'),
  };
  els['card-editor'].style.display = 'none';
  els['persona-editor'].style.display = 'none';

  const docHandlers = {};
  const ctx = {
    console,
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener: (t, fn) => { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    },
    window: {
      matchMedia: (q) => ({ matches: q === '(any-pointer: fine)' ? hasFinePointer : false }),
    },
    closeCharacters: () => closed.push('characters'),
    closeSettings: () => closed.push('settings'),
    closeScheduler: () => closed.push('scheduler'),
    closeExtensions: () => closed.push('ext'),
    closeDataManager: () => closed.push('data'),
    closeAbout: () => closed.push('about'),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\n' + escBlock, ctx);
  return { ctx, els, docHandlers };
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
  bd.fire('pointerdown', { pointerType: 'mouse' });
  bd.fire('dblclick', { target: { id: 'char-modal' } });
  const afterMouse = closed.length;
  bd.fire('pointerdown', { pointerType: 'touch' });
  bd.fire('dblclick', { target: { id: 'char-modal' } });
  check('same session: mouse closes, then finger does not',
        afterMouse === 1 && closed.length === 1, `${afterMouse} then ${closed.length}`);
}

console.log('\n=== Escape ===');
{
  let h = build({ hasFinePointer: true });
  h.docHandlers.keydown.forEach(fn => fn({ key: 'Escape' }));
  check('list view: Escape closes the character modal',
        closed.includes('characters'), closed.join(','));
  check('and still closes the other modals',
        ['settings', 'scheduler', 'ext', 'data', 'about'].every(m => closed.includes(m)),
        closed.join(','));

  h = build({ hasFinePointer: true });
  h.els['card-editor'].style.display = '';        // editing a character
  h.docHandlers.keydown.forEach(fn => fn({ key: 'Escape' }));
  check('EDITING: Escape does not discard the half-written card',
        !closed.includes('characters'), closed.join(','));
  check('but other modals still respond to Escape',
        closed.includes('settings') && closed.includes('about'), closed.join(','));

  h = build({ hasFinePointer: true });
  h.els['persona-editor'].style.display = '';     // editing a persona
  h.docHandlers.keydown.forEach(fn => fn({ key: 'Escape' }));
  check('EDITING a persona: same protection', !closed.includes('characters'), closed.join(','));

  h = build({ hasFinePointer: true });
  h.docHandlers.keydown.forEach(fn => fn({ key: 'a' }));
  check('a non-Escape key does nothing', closed.length === 0, closed.join(','));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
