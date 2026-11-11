/* GobboNet 1.8.0, round 1 -- console check for macro names typed with braces
 * (issue #69, PR #73).
 *
 * Paste into the browser console with GobboNet open and signed in. Under a
 * second. It saves nothing: the editor is driven for real, but while it runs
 * saveState() and alert() are swapped for stand-ins, the throwaway macros
 * (zz_...) are taken out again before anything else can run, and the editor is
 * put back as it was. Each check prints PASS, FAIL or INFO.
 *
 * Round 1's other two items (#51's engine check, and `bash` in the build docs)
 * change docs and build scripts only, so there is nothing of theirs to check in
 * the page.
 */
(() => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 1] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 1: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };

  log('INFO', 'page build: ' + (typeof GOBBONET_UI_VERSION !== 'undefined' ? GOBBONET_UI_VERSION : '(no stamp)') +
    ' -- the stamp stays 1.7.9 until the release round');
  if (typeof normaliseTrigger !== 'function' || typeof saveMacroEdit !== 'function') {
    log('FAIL', 'normaliseTrigger() is missing: this page is not the round-1 build. Rebuild or re-extract, then reload with Ctrl+F5.');
    return done();
  }

  // 1. The rule itself.
  const table = [['{{skip}}', 'skip'], ['{{ skip }}', 'skip'], ['skip:', 'skip'], ['{{SYSTEM:}}', 'SYSTEM'],
    ['skip', 'skip'], ['{{a b}}', 'a b'], ['{{{{skip}}}}', '{{skip}}']];
  for (const [typed, want] of table) check(normaliseTrigger(typed) === want, `"${typed}" is read as "${want}"`);

  // 2. The markup this build ships.
  const field = document.getElementById('macro-trigger');
  const note = document.getElementById('macro-trigger-note');
  const editorEl = document.getElementById('macro-editor');
  const addBtn = document.getElementById('macro-add-btn');
  const textEl = document.getElementById('macro-text');
  const preview = document.getElementById('macro-preview');
  check(!!(field && note && editorEl && addBtn && textEl && preview), 'the macro editor and its new note are in the page');
  if (!(field && note && editorEl && addBtn && textEl && preview)) return done();
  const hint = field.parentElement.querySelector('.form-hint:not(#macro-trigger-note):not([style*="inline"])');
  check(!!hint && /rosebud/.test(hint.textContent) && /\{\{rosebud\}\}/.test(hint.textContent), 'the hint under "Trigger name" gives the rosebud example (PR #73)');
  check(note.getAttribute('aria-live') === 'polite', 'the note is read out by screen readers when it appears');

  // 3. Drive the editor. Everything from here to the finally is synchronous,
  //    so nothing else on the page runs while the throwaway macros exist.
  const before = JSON.stringify((state.macros || []).map(m => [m.trigger, m.text]));
  const saved = { editor: editorEl.style.display, add: addBtn.style.display, trigger: field.value, readOnly: field.readOnly,
    text: textEl.value, editing: _editingMacroTrigger };
  const realSave = window.saveState, realAlert = window.alert;
  const alerts = []; let saves = 0;
  const type = (name, text) => {
    showMacroEditor();
    field.value = name; textEl.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    window.saveState = () => { saves++; };
    window.alert = m => { alerts.push(String(m)); };

    type('{{zz_brace_check}}', 'round 1 check');
    check(note.hidden === false && getComputedStyle(note).display !== 'none' &&
      note.textContent === 'Saves as {{zz_brace_check}}. Type the word only; the braces are added for you.',
      'typing {{zz_brace_check}} shows "Saves as {{zz_brace_check}}..." under the field');
    check(preview.textContent.startsWith('Preview — {{zz_brace_check: your text here}} becomes:') && !preview.textContent.includes('{{{{'),
      'the preview uses the bare name, with no doubled braces');
    saveMacroEdit();
    const made = (state.macros || []).filter(m => m.trigger === 'zz_brace_check');
    check(made.length === 1 && made[0].text === 'round 1 check' && alerts.length === 0 && saves === 1,
      'SAVE MACRO stores it as zz_brace_check, with no alert (1.7.9 refused this)');
    check(editorEl.style.display === 'none' && note.hidden === true, 'the editor closes and the note is cleared');

    alerts.length = 0; saves = 0;
    type('{{zz_brace_check}}', 'again');
    saveMacroEdit();
    check(/already exists/.test(alerts.join()) && (state.macros || []).filter(m => m.trigger === 'zz_brace_check').length === 1 && saves === 0,
      'the same name in braces again is refused as a duplicate, not added twice');

    alerts.length = 0;
    type('{{zz bad}}', 'x');
    check(note.hidden === true, 'a name that would be refused shows no "Saves as" note');
    saveMacroEdit();
    check(/Enter the name without braces\.\nExample: rosebud becomes \{\{rosebud\}\}/.test(alerts.join()) && field.value === 'zz bad' && saves === 0,
      '{{zz bad}} is refused with PR #73\'s wording, and the box shows "zz bad"');

    alerts.length = 0;
    type('{{char}}', 'x');
    saveMacroEdit();
    check(/built-in macro/.test(alerts.join()) && saves === 0, '{{char}} is still refused as a built-in name');
  } catch (e) {
    log('FAIL', 'the editor threw: ' + (e && e.message));
  } finally {
    state.macros = (state.macros || []).filter(m => !/^zz_/.test(m.trigger));
    window.saveState = realSave;
    window.alert = realAlert;
    cancelMacroEdit();
    _editingMacroTrigger = saved.editing;
    field.value = saved.trigger; field.readOnly = saved.readOnly; textEl.value = saved.text;
    editorEl.style.display = saved.editor; addBtn.style.display = saved.add;
    if (saved.editor !== 'none') updateMacroPreview();
    renderMacroList();
  }
  check(JSON.stringify((state.macros || []).map(m => [m.trigger, m.text])) === before, 'your macros are exactly as they were; nothing was saved');
  check(window.saveState === realSave && window.alert === realAlert, 'saveState() and alert() are the page\'s own again');
  return done();
})();
