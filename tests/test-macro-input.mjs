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
  vm.runInContext(slice(M, 'function updateMacroPreview()', '\nfunction editMacro('), ctx);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
