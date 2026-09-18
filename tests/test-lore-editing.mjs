/**
 * Hand-editing the lore summary — roadmap item 11.
 *
 * Promoted from a user mod that worked well. Two things had to change on the
 * way in, and both are what the tests below are mostly about.
 *
 * THE RACE. A compression pass reads the current summary, hands it to a model,
 * and `await`s — seconds, on a local model — then writes the result back. Once
 * the summary is editable, the user can rewrite it inside that window, and the
 * naive write replaces their text with something derived from the version they
 * were replacing. Nothing anywhere would say it happened. Section A is that,
 * and it is the reason this is a feature rather than the mod with the file
 * moved.
 *
 * THE PANEL. The mod replaced the inspector's whole body with a textarea,
 * which hides the size-across-passes table and the failure notes — the exact
 * evidence someone needs in front of them while deciding what to correct. One
 * renderer with two modes keeps it.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const PROMPT_SRC = fs.readFileSync(ROOT + '/js/07-prompt.js', 'utf8');
const DASH_SRC = fs.readFileSync(ROOT + '/js/13-dashboard.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const RAG_SRC = fs.readFileSync(ROOT + '/js/08-rag.js', 'utf8');

const slice = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to) : src.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error('could not locate ' + what);
    process.exit(1);
  }
  return src.slice(a, b);
};

const MERGE = slice(PROMPT_SRC, 'function getThreadLore(thread)',
                    '/* Maximum chars we', 'the lore accessors in js/07-prompt.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

function mergeCtx() {
  const ctx = { console: { warn() {}, log() {}, error() {} }, String, Object };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(MERGE, ctx);
  return ctx;
}

/* ================================================================
   A. A PASS MUST NOT EAT A HAND EDIT
================================================================ */
console.log('\n=== A. merging a pass against an edit ===');
{
  const ctx = mergeCtx();

  // Nothing happened underneath: an ordinary write.
  let t = { lore: 'Beat one.' };
  let r = ctx.mergeLoreAfterPass(t, 'Beat one.', 'Beat one.\nBeat two.');
  eq(t.lore, 'Beat one.\nBeat two.', 'with no edit, the pass writes its result');
  eq(r.merged, false, 'and reports no merge');
  eq(r.dropped, false, 'and nothing dropped');

  // The user rewrote the summary while the pass was in flight. Both survive.
  t = { lore: 'Beat one, CORRECTED by hand.' };
  r = ctx.mergeLoreAfterPass(t, 'Beat one.', 'Beat one.\nBeat two.');
  ok(/CORRECTED by hand/.test(t.lore), 'an edit made during the pass survives', t.lore);
  ok(/Beat two\./.test(t.lore), 'and the beat the pass produced is kept too', t.lore);
  ok(!/^Beat one\.\n/.test(t.lore), 'the superseded original is not reinstated', t.lore);
  eq(r.merged, true, 'and the merge is reported');

  // The pass rewrote rather than appended -- the LORE_MAX_CHARS trim does
  // this, since it cuts the front off. The beat cannot be separated out, so
  // the human's text wins: one generated sentence lost beats a lost paragraph.
  t = { lore: 'My careful rewrite.' };
  r = ctx.mergeLoreAfterPass(t, 'Beat one.', 'Trimmed opening. Beat two.');
  eq(t.lore, 'My careful rewrite.', 'an unsplittable pass keeps the human text');
  eq(r.dropped, true, 'and says the beat was dropped');
  eq(r.merged, false, 'rather than claiming a merge');

  // Editing to empty is a real intent -- "this summary is wrong, start over" --
  // and must not read as "no edit".
  t = { lore: '' };
  r = ctx.mergeLoreAfterPass(t, 'Beat one.', 'Beat one.\nBeat two.');
  eq(t.lore, '\nBeat two.'.replace(/^\n/, '\n'), 'clearing the summary still takes the new beat');
  ok(!/Beat one/.test(t.lore), 'without resurrecting what was cleared', t.lore);

  // A pass that produced nothing new must not damage an edit.
  t = { lore: 'Edited.' };
  r = ctx.mergeLoreAfterPass(t, 'Beat one.', 'Beat one.');
  eq(t.lore, 'Edited.', 'a pass with no new material leaves the edit alone');

  // First lore ever, no prior: ordinary write.
  t = { lore: '' };
  r = ctx.mergeLoreAfterPass(t, '', 'Beat one.');
  eq(t.lore, 'Beat one.', 'the first pass on an empty thread writes normally');
  eq(r.merged, false, 'with no merge reported');

  // A thread with no lore property at all.
  t = {};
  ctx.mergeLoreAfterPass(t, '', 'Beat one.');
  eq(t.lore, 'Beat one.', 'a thread with no lore field is handled');
}

/* ================================================================
   B. THE EDITOR
================================================================ */
console.log('\n=== B. the editor ===');

// Stops at openLoreInspector deliberately. That function renders the whole
// panel through innerHTML and is stubbed below, because what is under test
// here is the mode switching around it -- and a function declaration inside
// this slice would shadow the stub.
const EDITOR = slice(DASH_SRC, '/* ================================================================\n   LORE EDITOR',
                     'function openLoreInspector(', 'the lore editor in js/13-dashboard.js')
             + slice(DASH_SRC, 'function closeLoreInspector()', 'function copyLoreSummary(',
                     'closeLoreInspector');

function editorCtx({ lore = 'Beat one.\nBeat two.', confirmWith = true } = {}) {
  const thread = { id: 't1', lore, loreLog: [] };
  const els = {};
  const mk = (id, extra) => (els[id] = Object.assign({ id, hidden: false, value: '', dataset: {},
    textContent: '', style: {}, focus() {}, setSelectionRange() {},
    classList: { add() { els[id]._open = true; }, remove() { els[id]._open = false; } } }, extra || {}));
  ['lore-copy-btn', 'lore-edit-btn', 'lore-cancel-btn', 'lore-save-btn', 'lore-close-btn',
   'lore-edit-meter', 'lore-inspect-modal', 'lore-inspect-body'].forEach(id => mk(id));

  let rendered = 0, saved = 0;
  const confirms = [];
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    getActiveThread: () => thread,
    getThreadLore: (t) => (t && t.lore) || '',
    setThreadLore: (t, v) => { if (t) t.lore = v; },
    LORE_MAX_CHARS: 2400,
    saveState: () => { saved++; },
    render: () => { rendered++; },
    confirm: (m) => { confirms.push(m); return confirmWith; },
    escapeHtml: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    document: { getElementById: (id) => els[id] || null },
    Math, JSON, Object, String, Number, Array, Date, RegExp,
    // A stand-in for the full inspector renderer: it only has to create or
    // remove the textarea the way the real one does, since what is under test
    // is the mode switching around it.
    openLoreInspector: (opts) => {
      rendered++;
      if (opts && opts.editing) {
        els['lore-edit-input'] = Object.assign(els['lore-edit-input'] || {}, {
          id: 'lore-edit-input', value: thread.lore || '', dataset: {},
          focus() {}, setSelectionRange() {},
        });
      } else {
        delete els['lore-edit-input'];
      }
      ctx._renderLoreActions();
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(EDITOR, ctx);
  return { ctx, els, thread, confirms, saved: () => saved, rendered: () => rendered,
           get: (e) => vm.runInContext(e, ctx) };
}

{
  const h = editorCtx();
  // Read-only to start.
  h.ctx._renderLoreActions();
  ok(!h.els['lore-edit-btn'].hidden, 'EDIT is offered in the read-only view');
  ok(h.els['lore-save-btn'].hidden, 'SAVE is not');
  ok(h.els['lore-cancel-btn'].hidden, 'nor CANCEL');
  ok(!h.els['lore-copy-btn'].hidden, 'and COPY SUMMARY is available');

  h.ctx.startLoreEdit();
  ok(h.els['lore-edit-btn'].hidden, 'editing hides EDIT');
  ok(!h.els['lore-save-btn'].hidden, 'and shows SAVE');
  ok(!h.els['lore-cancel-btn'].hidden, 'and CANCEL');
  // COPY SUMMARY is hidden rather than relabelled. The mod borrowed it and had
  // to rebuild its handler afterwards, a copy that goes wrong silently the
  // day copyLoreSummary changes.
  ok(h.els['lore-copy-btn'].hidden, 'and hides COPY SUMMARY rather than borrowing it');
  eq(h.els['lore-edit-input'].value, 'Beat one.\nBeat two.', 'the editor opens on the current text');

  // Saving writes through and asks the app to repaint -- the summary is part
  // of every later prompt, so the token figures are wrong until it does.
  h.els['lore-edit-input'].value = 'Beat one.\nBeat two, corrected.';
  h.ctx.saveLoreEdit();
  eq(h.thread.lore, 'Beat one.\nBeat two, corrected.', 'SAVE stores the edit');
  ok(h.saved() >= 1, 'and persists it');
  ok(h.rendered() >= 1, 'and repaints, because lore feeds the token budget');
  ok(!h.els['lore-edit-btn'].hidden, 'and returns to the read-only view');
}

console.log('\n=== B2. nothing is discarded without asking ===');
{
  // Cancel with no changes: no question, because there is nothing to lose.
  let h = editorCtx();
  h.ctx.startLoreEdit();
  h.ctx.cancelLoreEdit();
  eq(h.confirms.length, 0, 'CANCEL on an untouched editor asks nothing');
  eq(h.thread.lore, 'Beat one.\nBeat two.', 'and changes nothing');

  // Cancel with changes: asked, and honoured either way.
  h = editorCtx({ confirmWith: true });
  h.ctx.startLoreEdit();
  h.els['lore-edit-input'].value = 'rewritten';
  ok(h.ctx.loreEditIsDirty(), 'a changed editor reports itself dirty');
  h.ctx.cancelLoreEdit();
  eq(h.confirms.length, 1, 'CANCEL on a changed editor asks first');
  eq(h.thread.lore, 'Beat one.\nBeat two.', 'and discards when told to');
  ok(!h.els['lore-edit-btn'].hidden, 'returning to the read-only view');

  h = editorCtx({ confirmWith: false });
  h.ctx.startLoreEdit();
  h.els['lore-edit-input'].value = 'rewritten';
  h.ctx.cancelLoreEdit();
  ok(h.ctx.loreEditorIsOpen(), 'saying no keeps the editor open');

  // CLOSE is the only other way out of this modal, so it is guarded too.
  h = editorCtx({ confirmWith: false });
  h.ctx.startLoreEdit();
  h.els['lore-edit-input'].value = 'rewritten';
  h.ctx.closeLoreInspector();
  eq(h.confirms.length, 1, 'CLOSE on a changed editor asks first');
  ok(h.els['lore-inspect-modal']._open !== false, 'and saying no keeps the modal open');

  h = editorCtx({ confirmWith: true });
  h.ctx.startLoreEdit();
  h.els['lore-edit-input'].value = 'rewritten';
  h.ctx.closeLoreInspector();
  eq(h.els['lore-inspect-modal']._open, false, 'saying yes closes it');
  ok(!h.ctx.loreEditorIsOpen(), 'and leaves no editor state behind');

  // Closing a read-only panel must never ask.
  h = editorCtx();
  h.ctx.closeLoreInspector();
  eq(h.confirms.length, 0, 'closing without editing asks nothing');
}

console.log('\n=== B3. the budget meter ===');
{
  const h = editorCtx();
  h.ctx.startLoreEdit();
  h.els['lore-edit-input'].value = 'x'.repeat(100);
  h.ctx.updateLoreEditMeter();
  ok(/100 \/ 2400/.test(h.els['lore-edit-meter'].textContent), 'the count is shown against the cap',
     h.els['lore-edit-meter'].textContent);
  eq(h.els['lore-edit-meter'].dataset.over, 'false', 'and is not flagged under budget');

  // Over budget matters: the next pass trims from the FRONT, so an oversized
  // edit quietly loses its opening rather than its tail.
  h.els['lore-edit-input'].value = 'x'.repeat(2500);
  h.ctx.updateLoreEditMeter();
  eq(h.els['lore-edit-meter'].dataset.over, 'true', 'over budget is flagged');
  ok(/trims from the front/.test(h.els['lore-edit-meter'].textContent),
     'and says what will happen to it', h.els['lore-edit-meter'].textContent);
}

/* ================================================================
   C. WIRING
================================================================ */
console.log('\n=== C. wiring ===');
{
  for (const id of ['lore-edit-btn', 'lore-cancel-btn', 'lore-save-btn', 'lore-copy-btn']) {
    ok(new RegExp('id="' + id + '"').test(HTML), 'the panel has #' + id);
  }
  ok(/onclick="startLoreEdit\(\)"/.test(HTML), 'EDIT is wired');
  ok(/onclick="saveLoreEdit\(\)"/.test(HTML), 'SAVE is wired');
  ok(/onclick="cancelLoreEdit\(\)"/.test(HTML), 'CANCEL is wired');
  ok(/id="lore-cancel-btn"[^>]*hidden/.test(HTML), 'and CANCEL starts hidden');

  // The panel used to promise the log was "never rewritten". It is now.
  ok(!/never rewritten/.test(HTML), 'the panel no longer claims the log is never rewritten');
  ok(/EDIT lets you correct it by hand/.test(HTML), 'and says editing is possible');

  // The editing mode has to keep the rest of the panel, which is the evidence
  // someone is acting on while they correct it.
  const openFn = DASH_SRC.slice(DASH_SRC.indexOf('function openLoreInspector('),
                                DASH_SRC.indexOf('function closeLoreInspector('));
  ok(/lore-edit-input/.test(openFn), 'the inspector renders the editor itself');
  ok(/Size across passes/.test(openFn), 'in the same renderer that draws the history table');
  ok(/if \(editing\)/.test(openFn), 'switching on a mode rather than replacing the body');

  // The compression pass must go through the merge, not straight to the store.
  ok(/mergeLoreAfterPass\(thread, _loreBefore, _produced\)/.test(RAG_SRC),
     'the compression pass writes through mergeLoreAfterPass');
  ok(!/\n\s*setThreadLore\(thread, summary\);/.test(RAG_SRC),
     'and no longer writes the summary directly');
  ok(/editedDuringPass/.test(RAG_SRC), 'and records a collision in the pass log');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
