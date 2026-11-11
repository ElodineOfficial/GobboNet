/**
 * Custom macros that take text (1.7.9), run for real (js/17-personas.js
 * resolveMacros / translateTemplates, js/20-macros.js preview).
 *
 * The request, verbatim:
 *   {{SYSTEM:}}  Foo bar baz quux
 * should reach the model as
 *   The following is an out of character directive. Do not acknowledge or
 *   respond to this in the scene:
 *   Foo bar baz quux
 *
 *   A. The request: both forms, ready-made, exactly that text.
 *   B. {{input}}, {{input1}}.. placeholders; plain {{name}} still works.
 *   C. What does not change: old macros, unknown names, the chat bubble,
 *      case-insensitive names, $ in macro text taken literally.
 *   D. Defaults and reserved names; seeding onto existing installs.
 *   E. The editor's hint and preview.
 *   F. Names typed with braces (1.8.0, issue #69, PR #73): {{skip}} saves as
 *      skip instead of being refused; what is still wrong is still refused.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const PERS = read('js/17-personas.js');
const STATE = read('js/04-state.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 500) : '')); }
};

const slice = (src, from, to) => src.slice(src.indexOf(from), to ? src.indexOf(to, src.indexOf(from)) : undefined);
function load(macros) {
  const els = {};
  const ctx = {
    state: { macros },
    getActiveCard: () => ({ name: 'Gob' }), getActivePersona: () => ({ name: 'Elo' }),
    document: { getElementById: id => els[id] || (els[id] = { value: '', textContent: '' }) },
    els,
  };
  vm.createContext(ctx);
  vm.runInContext(slice(STATE, 'const RESERVED_MACROS', 'const DEFAULT_MACROS') + '\n' +
    slice(STATE, 'const DEFAULT_MACROS', '\n];') + '\n];\nthis.DEFAULT_MACROS = DEFAULT_MACROS; this.RESERVED_MACROS = RESERVED_MACROS;', ctx);
  vm.runInContext('const AUTO_CONTINUE_TEXT = "[auto]";\n' + slice(PERS, 'function getCurrentDateTimeString()', 'function applyActiveCardBackground()'), ctx);
  const M = read('js/20-macros.js');
  vm.runInContext(slice(M, 'function normaliseTrigger(', '\nfunction editMacro('), ctx);
  return ctx;
}
const defaults = () => load(null).DEFAULT_MACROS.map(m => ({ ...m }));
const model = (ctx, text) => ctx.translateTemplates(text, 'Gob', 'Elo');
const DIRECTIVE = 'The following is an out of character directive. Do not acknowledge or respond to this in the scene:';

console.log('\n=== A. the request ===');
{
  const c = load(defaults());
  ok(model(c, '{{SYSTEM:}}  Foo bar baz quux') === DIRECTIVE + '\nFoo bar baz quux', '{{SYSTEM:}}  Foo bar baz quux -> the directive, then the text on its own line', model(c, '{{SYSTEM:}}  Foo bar baz quux'));
  ok(model(c, '{{SYSTEM: Foo bar baz quux}}') === DIRECTIVE + '\nFoo bar baz quux', '{{SYSTEM: Foo bar baz quux}} -> the same');
  ok(model(c, 'She waits.\n{{SYSTEM:}} Keep it short.\nAnd then?') === 'She waits.\n' + DIRECTIVE + '\nKeep it short.\nAnd then?',
     'the colon form takes the rest of that line only');
  ok(model(c, '"Hello," I say. {{SYSTEM: Make her suspicious.}} I wave.') === '"Hello," I say. ' + DIRECTIVE + '\nMake her suspicious. I wave.',
     'the braces form can sit mid-message');
  ok(model(c, '{{system: lower case}}') === DIRECTIVE + '\nlower case', 'names match whatever their case, as before');
  ok(model(c, '{{SYSTEM: {{user}} is lying}}') === DIRECTIVE + '\nElo is lying', '{{user}} and {{char}} work inside the passed text');
  ok(model(c, '{{SYSTEM: {{continue}}}}') === DIRECTIVE + '\nPlease continue the scene as all characters involved.', 'and so does another macro');
  ok(model(c, '{{SYSTEM: line one\nline two}}') === DIRECTIVE + '\nline one\nline two', 'the braces form can run over several lines');
}

console.log('\n=== B. placeholders ===');
{
  const c = load([
    { trigger: 'ooc', text: '(OOC: {{input}})' },
    { trigger: 'twice', text: '{{input}} and again {{input}}' },
    { trigger: 'scene', text: 'Setting: {{input1}}. Time: {{input2}}.' },
    { trigger: 'whisper', text: '*{{char}} whispers* {{input}}' },
  ]);
  ok(model(c, 'Hi {{ooc: brb}} there') === 'Hi (OOC: brb) there', '{{input}} puts the text exactly there, with nothing added after');
  ok(model(c, '{{twice: echo}}') === 'echo and again echo', 'every {{input}} is filled');
  ok(model(c, '{{scene: the tavern | night}}') === 'Setting: the tavern. Time: night.', '{{input1}}, {{input2}}: pieces split at |');
  ok(model(c, '{{scene: the tavern}}') === 'Setting: the tavern. Time: .', 'a missing piece is left empty');
  ok(model(c, '{{scene:}} docks | dawn') === 'Setting: docks. Time: dawn.', 'pieces work in the colon form too');
  ok(model(c, '{{ooc}}') === '(OOC: )', 'a plain {{name}} still works, placeholders empty');
  ok(model(c, '{{whisper: hush}}') === '*Gob whispers* hush', '{{char}} in the macro text still resolves');
  ok(model(c, '{{input}} by itself') === '{{input}} by itself', '{{input}} typed in a message, outside a macro, is left alone');
}

console.log('\n=== C. what does not change ===');
{
  const c = load(defaults().concat([{ trigger: 'money', text: 'It costs $5 and $& stays.' }]));
  ok(model(c, '{{continue}}') === 'Please continue the scene as all characters involved.', 'an old macro expands exactly as before');
  ok(model(c, '{{fast_forward}} now') === 'Please fast-forward to a new scene that continues the storyline naturally and appropriately. now', 'mid-message too');
  ok(model(c, '{{money}}') === 'It costs $5 and $& stays.', '$ in a macro\'s text is taken literally (it used to be read as a replacement pattern)');
  ok(model(c, '{{nope: hello}} and {{nope:}} there') === '{{nope: hello}} and {{nope:}} there', 'an unknown name with a colon is left as typed');
  ok(c.translateTemplates('{{SYSTEM:}} Foo bar', 'Gob', 'Elo', true) === '{{SYSTEM:}} Foo bar', 'the chat bubble shows the short form; only the model gets the expansion');
  ok(model(c, 'plain text, no macros') === 'plain text, no macros', 'text with no macros is untouched');
  const none = load([]);
  ok(model(none, '{{SYSTEM: x}}') === '{{SYSTEM: x}}', 'with no macros at all, nothing is touched');
  const chat = read('js/10-chat.js');
  ok(/let storedContent = workingContent\.replace\(\/\\\{\\\{current_DAT\\\}\\\}\/gi/.test(chat), 'the saved message keeps what was typed (only {{current_DAT}} is fixed at send time)');
}

console.log('\n=== D. defaults, reserved names, seeding ===');
{
  const c = load(null);
  const sys = c.DEFAULT_MACROS.find(m => m.trigger === 'SYSTEM');
  ok(sys && sys.text === DIRECTIVE, '{{SYSTEM}} ships as a default macro with the directive text');
  ok(['input', 'input1', 'input9'].every(n => c.RESERVED_MACROS.has(n)) && c.RESERVED_MACROS.has('char'), 'input and input1..9 are reserved names, like char and user');
  const pers = read('js/05-persistence.js');
  ok(/m\.trigger\.toLowerCase\(\) === def\.trigger\.toLowerCase\(\)/.test(pers),
     'on an existing install, SYSTEM is added once -- not as a twin of a "system" macro the user already has');
  ok(/if \(state\.seededDefaultMacros\.includes\(def\.trigger\)\) continue;/.test(pers), 'and never re-added after the user deletes it');
}

console.log('\n=== E. the editor ===');
{
  const c = load([]);
  c.els['macro-trigger'] = { value: 'SYSTEM' };
  c.els['macro-text'] = { value: DIRECTIVE };
  c.els['macro-preview'] = { textContent: '' };
  c.updateMacroPreview();
  ok(c.els['macro-preview'].textContent === 'Preview — {{SYSTEM: your text here}} becomes:\n' + DIRECTIVE + '\nyour text here', 'the preview shows the passed text landing after the macro', c.els['macro-preview'].textContent);
  c.els['macro-text'] = { value: 'Setting: {{input1}}. Time: {{input2}}.' };
  c.updateMacroPreview();
  ok(/\{\{SYSTEM: first \| second\}\} becomes:\nSetting: first\. Time: second\./.test(c.els['macro-preview'].textContent), 'with numbered placeholders it previews two pieces');
  const html = read('chat.html');
  ok(/oninput="updateMacroPreview\(\)"/.test(html) && /id="macro-preview"/.test(html), 'the preview updates as you type');
  ok(/<code>\{\{SYSTEM: Foo bar\}\}<\/code>, or <code>\{\{SYSTEM:\}\} Foo bar<\/code>/.test(html) && /<code>\{\{input1\}\}<\/code>/.test(html), 'the "?" note explains both forms and the placeholders');
}

console.log('\n=== F. names typed with braces (issue #69) ===');
{
  // The real saveMacroEdit()/cancelMacroEdit(), with the page's globals stubbed.
  const M = read('js/20-macros.js');
  const editor = macros => {
    const c = load(macros);
    c.alerts = []; c.saves = 0;
    c.alert = m => c.alerts.push(String(m));
    c.saveState = () => { c.saves++; };
    c.renderMacroList = () => {};
    c.els['macro-editor'] = { style: {} };
    c.els['macro-add-btn'] = { style: {} };
    vm.runInContext('let _editingMacroTrigger = null;\n' + slice(M, 'function saveMacroEdit()', '\nfunction deleteMacro('), c);
    return c;
  };
  const type = (c, typed, text = 'Skip ahead.') => {
    c.els['macro-trigger'] = { value: typed, readOnly: false };
    c.els['macro-text'] = { value: text };
    c.els['macro-trigger-note'] = { textContent: '', hidden: true };
    c.els['macro-preview'] = { textContent: '' };
    return c;
  };
  const save = (macros, typed, text) => { const c = type(editor(macros), typed, text); c.saveMacroEdit(); return c; };
  const names = c => (c.state.macros || []).map(m => m.trigger);

  const n = load([]).normaliseTrigger;
  const table = [['{{skip}}', 'skip'], ['{{ skip }}', 'skip'], ['  {{skip}}  ', 'skip'], ['skip:', 'skip'],
    ['{{SYSTEM:}}', 'SYSTEM'], ['{{SYSTEM: }}', 'SYSTEM'], ['{{skip', 'skip'], ['skip}}', 'skip'],
    ['skip', 'skip'], ['{{{{skip}}}}', '{{skip}}'], ['{{a b}}', 'a b'], ['', ''], [null, '']];
  const wrong = table.filter(([raw, want]) => n(raw) !== want);
  ok(wrong.length === 0, 'normaliseTrigger takes off one pair of braces and a trailing colon, and trims', wrong.map(([raw]) => [raw, n(raw)]));

  for (const typed of ['{{skip}}', '{{ skip }}', 'skip:', '{{skip:}}']) {
    const c = save([], typed);
    ok(names(c).join() === 'skip' && c.alerts.length === 0 && c.saves === 1,
       `"${typed}" saves as the macro skip, with no alert (1.7.9 refused it)`, { names: names(c), alerts: c.alerts });
  }
  {
    const c = save([], '{{SYSTEM:}}');
    ok(names(c).join() === 'SYSTEM' && c.alerts.length === 0, '{{SYSTEM:}}, copied from the 1.7.9 notes, saves as SYSTEM', c.alerts);
  }
  {
    const c = save([], 'skip');
    ok(names(c).join() === 'skip' && c.saves === 1, 'a bare name saves exactly as before');
  }
  {
    const c = save([], '{{a b}}');
    ok(names(c).length === 0 && c.saves === 0, '{{a b}} is still refused: a space is not allowed');
    ok(/letters, numbers, and underscores\. Enter the name without braces\.\nExample: rosebud becomes \{\{rosebud\}\}/.test(c.alerts.join()), 'with PR #73\'s wording and the rosebud example', c.alerts);
    ok(c.els['macro-trigger'].value === 'a b', 'and the box shows the name that was checked, without the braces', c.els['macro-trigger'].value);
  }
  for (const [typed, what] of [['{{char}}', 'a built-in name'], ['{{ USER }}', 'a built-in name in any case'], ['{{input1}}', 'a placeholder name']]) {
    const c = save([], typed);
    ok(names(c).length === 0 && /built-in macro and cannot be overridden/.test(c.alerts.join()), `${typed}, ${what}, is still refused`, c.alerts);
  }
  {
    const c = save([], '{{{{skip}}}}');
    ok(names(c).length === 0 && c.alerts.length === 1, 'only one pair comes off: {{{{skip}}}} is refused');
  }
  {
    const c = save(defaults(), '{{system:}}');
    ok(names(c).filter(t => t.toLowerCase() === 'system').length === 1 && /already exists/.test(c.alerts.join()),
       'a braced name that matches an existing macro is refused as a duplicate, not added twice', c.alerts);
  }
  {
    const c = editor([{ trigger: 'skip', text: 'old' }]);
    type(c, 'skip', 'new text');
    c.els['macro-trigger'].readOnly = true;
    vm.runInContext('_editingMacroTrigger = "skip";', c);
    c.saveMacroEdit();
    ok(c.state.macros.length === 1 && c.state.macros[0].text === 'new text', 'editing an existing macro still updates its text');
  }

  // The note under the field, and the preview.
  {
    const c = type(load([]), '{{skip}}');
    c.updateMacroPreview();
    ok(c.els['macro-trigger-note'].hidden === false && c.els['macro-trigger-note'].textContent === 'Saves as {{skip}}. Type the word only; the braces are added for you.',
       'typing {{skip}} shows one line saying it saves as {{skip}}', c.els['macro-trigger-note']);
    ok(c.els['macro-preview'].textContent.startsWith('Preview — {{skip: your text here}} becomes:') && !/\{\{\{\{/.test(c.els['macro-preview'].textContent),
       'and the preview uses the bare name, never {{{{skip}}: ...}}', c.els['macro-preview'].textContent);
    type(c, 'skip'); c.updateMacroPreview();
    ok(c.els['macro-trigger-note'].hidden === true && c.els['macro-trigger-note'].textContent === '', 'a bare name shows no note');
    type(c, '{{a b}}'); c.updateMacroPreview();
    ok(c.els['macro-trigger-note'].hidden === true, 'nor does a name that would be refused anyway');
  }
  {
    const c = editor([]);
    type(c, '{{skip}}'); c.updateMacroPreview(); c.cancelMacroEdit();
    ok(c.els['macro-trigger-note'].hidden === true && c.els['macro-trigger-note'].textContent === '', 'Cancel clears the note');
  }

  const html = read('chat.html');
  ok(/Enter the name without braces; for example, <code>rosebud<\/code> becomes <code>\{\{rosebud\}\}<\/code> when saved\./.test(html), 'the editor keeps PR #73\'s hint, with the rosebud example');
  ok(/<input type="text" id="macro-trigger"[^>]*>\s*<div class="form-hint" id="macro-trigger-note" aria-live="polite" hidden><\/div>/.test(html), 'the note sits under the name field, hidden until needed, and is read out when it appears');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
