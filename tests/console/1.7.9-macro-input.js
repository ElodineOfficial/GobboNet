/* GobboNet 1.7.9 -- console check for macros that take text.
 *
 * Paste into the browser console with GobboNet open and signed in. About a
 * second. It changes nothing: it uses your macros as they are, and tries a
 * throwaway macro that is added and removed in memory only, never saved.
 *
 *   {{SYSTEM:}}  Foo bar baz quux
 * must reach the model as the out-of-character directive, then
 *   Foo bar baz quux
 * on its own line. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [macros] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);

  if (typeof macroExpand !== 'function' || typeof resolveMacros !== 'function') {
    log('FAIL', 'this page cannot pass text to macros (macroExpand() is missing) -- is it the build with that change?');
    return { passes: 0, fails: 1, results: out };
  }
  const model = t => translateTemplates(t, 'Gob', 'Elo');
  const sys = (state.macros || []).find(m => m.trigger.toLowerCase() === 'system');
  if (!sys) {
    log('INFO', 'you have no SYSTEM macro (deleted, or renamed). The checks below use a throwaway one.');
  } else {
    log('INFO', 'your SYSTEM macro: "' + sys.text.slice(0, 80) + (sys.text.length > 80 ? '…' : '') + '"');
    check(model('{{SYSTEM:}}  Foo bar baz quux') === macroExpand(sys, 'Foo bar baz quux'), '{{SYSTEM:}}  Foo bar baz quux expands with your SYSTEM macro');
  }
  const DIRECTIVE = 'The following is an out of character directive. Do not acknowledge or respond to this in the scene:';
  const probe = [{ trigger: 'zz_ooc_check', text: DIRECTIVE }, { trigger: 'zz_slot_check', text: 'A={{input1}} B={{input2}} all={{input}}' }];
  state.macros = (state.macros || []).concat(probe);
  try {
    check(model('{{zz_ooc_check:}}  Foo bar baz quux') === DIRECTIVE + '\nFoo bar baz quux', 'the colon form: directive, then "Foo bar baz quux" on its own line');
    check(model('{{zz_ooc_check: Foo bar baz quux}}') === DIRECTIVE + '\nFoo bar baz quux', 'the braces form: the same');
    check(model('x {{zz_ooc_check:}} rest\nnext line') === 'x ' + DIRECTIVE + '\nrest\nnext line', 'the colon form takes only the rest of its line');
    check(model('{{zz_slot_check: one | two}}') === 'A=one B=two all=one | two', '{{input}}, {{input1}} and {{input2}} are filled');
    check(model('{{zz_ooc_check: {{user}} lies}}') === DIRECTIVE + '\nElo lies', '{{user}} works inside the passed text');
    check(translateTemplates('{{zz_ooc_check:}} Foo', 'Gob', 'Elo', true) === '{{zz_ooc_check:}} Foo', 'the chat bubble keeps the short form');
    check(model('{{zz_not_a_macro: hi}}') === '{{zz_not_a_macro: hi}}', 'an unknown name is left as typed');
    check(RESERVED_MACROS.has('input') && RESERVED_MACROS.has('input1'), 'input and input1..9 cannot be used as macro names');
  } finally {
    state.macros = state.macros.filter(m => !probe.includes(m));
  }
  check(!(state.macros || []).some(m => /^zz_/.test(m.trigger)), 'the throwaway macros are gone; yours are as they were');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 macro input: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
