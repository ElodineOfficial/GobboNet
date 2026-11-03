/**
 * 1.7.9 step 5 — PR #5 (neoliminal): code that arrives from outside this device
 * (server restore, backup files, card files, recovered history) always lands
 * switched OFF.
 *
 * The behaviour of neutralizeUntrustedCode itself, and the fail-closed restore,
 * are driven for real in test-state-handshake.mjs. This file pins the wiring:
 * every path that brings cards or extensions in from outside calls the
 * quarantine, and none of them can skip it.
 */
import fs from 'fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/js/${f}`, 'utf8');
const all = fs.readdirSync(`${ROOT}/js`).filter(f => f.endsWith('.js')).map(f => [f, read(f)]);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
};

/** Body of `function name(` up to the next top-level function. */
function body(text, name) {
  const start = text.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/^(?:async )?function [A-Za-z_$][\w$]*\(/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

console.log('no silent skip');
const guarded = all.filter(([, t]) => /typeof\s+neutralizeUntrustedCode/.test(t)).map(([f]) => f);
ok(guarded.length === 0,
  'no `typeof neutralizeUntrustedCode` guard anywhere (a missing quarantine must fail, not pass)' +
  (guarded.length ? ' — found in ' + guarded.join(', ') : ''));

console.log('every way in calls the quarantine');
const paths = [
  ['06-state-sync.js', 'restoreFromServer', 'server restore and profile switch (/state)'],
  ['21-data.js', 'recoverUpgradeHistory', 'recovered pre-upgrade history'],
];
for (const [file, fn, what] of paths) {
  const b = body(read(file), fn);
  ok(b && /neutralizeUntrustedCode\(/.test(b), `${what}: ${fn}() calls neutralizeUntrustedCode`);
}
// importData has one branch per backup type; three of them can carry cards.
const data = read('21-data.js');
const calls = (data.match(/neutralizeUntrustedCode\(/g) || []).length;
ok(calls >= 4, `21-data.js quarantines cards import, folder/character import, full backup and recovery (${calls} calls)`);
const full = data.slice(data.indexOf("state.extensions     = migrateExtensions(data.extensions);"));
ok(full.indexOf('neutralizeUntrustedCode(state)') >= 0 &&
   full.indexOf('neutralizeUntrustedCode(state)') < full.indexOf('applyExtensions();'),
   'full backup: the quarantine runs before applyExtensions() injects anything');
const cardIO = read('16-card-io.js');
ok(/applyImportedCardCode\(card,/.test(cardIO), 'card files (PNG / JSON / zip) go through applyImportedCardCode');
const cardCode = read('23-card-code.js');
ok(/card\.customCodeEnabled = false;/.test(body(cardCode, 'applyImportedCardCode')),
   'applyImportedCardCode always clears customCodeEnabled');

console.log('nothing else writes cards or extensions from outside');
// The only places allowed to assign state.characterCards / state.extensions
// wholesale. Anything new here is a new way in and needs the quarantine.
const ALLOWED = new Set([
  '05-persistence.js',   // this device's own storage
  '15-cards.js',         // the editor, acting for the person at the keyboard
  '19-extensions.js',    // the extensions panel, same
  '21-data.js',          // imports (quarantined above) and PURGE
]);
const writers = all.filter(([f, t]) => /state\.(characterCards|extensions)\s*=(?!=)/.test(t)).map(([f]) => f);
const unexpected = writers.filter(f => !ALLOWED.has(f));
ok(unexpected.length === 0, 'state.characterCards / state.extensions are only replaced by known writers' +
  (unexpected.length ? ' — new writer(s): ' + unexpected.join(', ') : ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
