/**
 * The [ui] section of gobbonet.toml — roadmap item 10.
 *
 * The config file has always been the server's: URLs, ports, paths, GPU
 * layers, 25 keys of it. The things people change day to day live in CONFIG,
 * in the browser, and had no file representation at all. [ui] is that missing
 * half.
 *
 * SEED, NOT LOCK — and that is the decision everything here tests.
 *
 * An override would mean the file wins on every boot, so a setting changed in
 * CONFIG silently reverts on reload; a UI that argues with the user is worse
 * than no file. Writing the panel's changes back has the mirror problem: a
 * phone rewriting a file on the server, and two devices fighting over it. So
 * the file answers a narrower question honestly — what does a device start
 * with before anyone has chosen. Section C is that rule.
 *
 * VALIDATION LIVES IN THE BROWSER, and section B is why: DEFAULT_SETTINGS is
 * the definition of what a setting is, so checking against it means a setting
 * added next release is presettable the day it lands, with no second list in
 * Go to keep in step.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/21-data.js', 'utf8');

const a = SRC.indexOf('/* ================================================================\n   SERVER PRESETS');
const b = SRC.indexOf('/** Trigger a JSON file download. */');
if (a < 0 || b < 0) {
  console.error('could not locate the server-presets block in js/21-data.js');
  process.exit(1);
}
const BLOCK = SRC.slice(a, b);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

// A stand-in for DEFAULT_SETTINGS with one of each type, including a camelCase
// name whose snake_case spelling has to resolve.
const DEFAULTS = {
  streamReplies: true,
  stickyCards: true,
  autoScroll: 'smart',
  tokenLimit: 24576,
  allowRemoteImages: false,
};

function build({ ui, settings, served = true } = {}) {
  const fetched = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    IS_SERVED: served,
    window: { location: { origin: 'http://192.168.1.5:8080' } },
    DEFAULT_SETTINGS: { ...DEFAULTS },
    state: { settings: { ...DEFAULTS, ...(settings || {}) } },
    Object, Array, JSON, String, Number, Boolean, Math,
    saveState: () => {}, render: () => {}, updateFollowButton: () => {},
    autoScrollMode: () => 'smart',
    fetch: async (url) => {
      fetched.push(String(url));
      if (ui === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ui: ui || {} }) };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  const get = (e) => vm.runInContext(e, ctx);
  return { ctx, get, fetched };
}

/* ================================================================
   A. FETCHING
================================================================ */
console.log('\n=== A. reading the table ===');
{
  let h = build({ ui: { stream_replies: false } });
  await h.ctx.loadServerPresets();
  eq(h.fetched[0], 'http://192.168.1.5:8080/ui-defaults.json', 'the route is same-origin');
  eq(h.get('serverPresets').valid.streamReplies, false, 'and the value arrives');

  // A server too old to have the route must not break boot.
  h = build({ ui: null });
  await h.ctx.loadServerPresets();
  eq(Object.keys(h.get('serverPresets').valid).length, 0, 'a 404 means no presets, not an error');
  ok(h.get('serverPresets').loaded, 'and the load is still marked done');

  h = build({ served: false });
  await h.ctx.loadServerPresets();
  eq(h.fetched.length, 0, 'file:// asks for nothing');

  h = build({ ui: {} });
  await h.ctx.loadServerPresets();
  eq(Object.keys(h.get('serverPresets').valid).length, 0, 'an empty [ui] table is fine');
}

/* ================================================================
   B. VALIDATION

   The keys are the browser's, so the browser is the only thing that can say
   whether one exists and what type it should be.
================================================================ */
console.log('\n=== B. what is accepted ===');
{
  const h = build();
  const V = h.ctx.validateServerPresets;

  // Both spellings, because a config file written by hand will be snake_case
  // and the JS names are camelCase. Rejecting one would be correct and
  // useless -- the user has no way to know which this one wanted.
  eq(V({ stream_replies: false }).valid.streamReplies, false, 'snake_case resolves');
  eq(V({ streamReplies: false }).valid.streamReplies, false, 'camelCase resolves');
  eq(V({ auto_scroll: 'off' }).valid.autoScroll, 'off', 'so does a multi-word key');
  eq(V({ token_limit: 8192 }).valid.tokenLimit, 8192, 'numbers come through');

  // An unknown key is reported, never merged. Merging it would put a typo into
  // state.settings, which then syncs to every other device.
  let r = V({ stream_replys: true });
  eq(Object.keys(r.valid).length, 0, 'a typo is not accepted');
  eq(r.unknown[0], 'stream_replys', 'and is named so it can be fixed');

  r = V({ auto_scroll: 42 });
  eq(Object.keys(r.valid).length, 0, 'a wrong type is not accepted');
  eq(r.mistyped[0].expected, 'string', 'and says what was wanted');
  eq(r.mistyped[0].got, 'number', 'and what arrived');

  r = V({ sticky_cards: 'yes' });
  eq(r.mistyped[0].expected, 'boolean', 'a string where a boolean belongs is caught');
  r = V({ token_limit: [1, 2] });
  eq(r.mistyped[0].got, 'array', 'an array is reported as an array, not as "object"');

  // A good key alongside a bad one still works -- one typo must not throw the
  // whole file away.
  r = V({ stream_replies: false, nonsense: 1 });
  eq(r.valid.streamReplies, false, 'a valid entry survives an invalid neighbour');
  eq(r.unknown.length, 1, 'and the invalid one is still reported');

  // Nothing from the file may reach a key the app does not define.
  r = V({ __proto__: 'x', constructor: 'y', toString: 'z' });
  eq(Object.keys(r.valid).length, 0, 'inherited property names are not settings');
}

/* ================================================================
   C. SEED, NOT LOCK
================================================================ */
console.log('\n=== C. whose settings win ===');
{
  // A device that has never been used takes the presets.
  let h = build({ ui: { auto_scroll: 'off', token_limit: 8192 } });
  await h.ctx.loadServerPresets();
  eq(h.ctx.seedSettingsFromServerPresets(false), 2, 'a fresh device takes the presets');
  eq(h.ctx.state.settings.autoScroll, 'off', 'and uses them');
  eq(h.ctx.state.settings.tokenLimit, 8192, 'all of them');

  // A device that has its own settings keeps them. This is the whole
  // difference between a seed and a lock.
  h = build({ ui: { auto_scroll: 'off' }, settings: { autoScroll: 'always' } });
  await h.ctx.loadServerPresets();
  eq(h.ctx.seedSettingsFromServerPresets(true), 0, 'a used device takes nothing automatically');
  eq(h.ctx.state.settings.autoScroll, 'always', 'and keeps what it chose');

  // ...but is told, and can take them on request.
  const diff = h.ctx.serverPresetDiff();
  eq(diff.length, 1, 'the difference is visible');
  eq(diff[0].key, 'autoScroll', 'by name');
  eq(diff[0].mine, 'always', 'with what this device has');
  eq(diff[0].preset, 'off', 'and what the file wants');
  eq(h.ctx.applyServerPresets(), 1, 'applying takes it');
  eq(h.ctx.state.settings.autoScroll, 'off', 'and the setting changes');
  eq(h.ctx.serverPresetDiff().length, 0, 'leaving nothing different');

  // Settings the file says nothing about are never touched.
  h = build({ ui: { auto_scroll: 'off' }, settings: { stickyCards: false } });
  await h.ctx.loadServerPresets();
  h.ctx.applyServerPresets();
  eq(h.ctx.state.settings.stickyCards, false, 'a setting not in the file is left alone');

  // Nothing to do is not an error.
  h = build({ ui: {} });
  await h.ctx.loadServerPresets();
  eq(h.ctx.applyServerPresets(), 0, 'applying with no presets does nothing');
  eq(h.ctx.seedSettingsFromServerPresets(false), 0, 'and neither does seeding');
}

/* ================================================================
   D. THE KEY REFERENCE

   Generated from DEFAULT_SETTINGS, so the list in the UI cannot fall behind
   the settings the app actually has. That is why the config file's comment
   points at the panel instead of listing keys itself.
================================================================ */
console.log('\n=== D. the generated key list ===');
{
  const h = build({ ui: { auto_scroll: 'off' } });
  await h.ctx.loadServerPresets();
  const ref = h.ctx.serverPresetKeyReference();

  eq(ref.length, Object.keys(DEFAULTS).length, 'every setting appears');
  const scroll = ref.find(r => r.key === 'autoScroll');
  eq(scroll.toml, 'auto_scroll', 'with the spelling to use in the file');
  eq(scroll.type, 'string', 'its type');
  eq(scroll.preset, 'off', 'and what the server presets it to');
  const sticky = ref.find(r => r.key === 'stickyCards');
  eq(sticky.preset, undefined, 'a setting the file does not mention shows none');

  // A setting invented after this test was written must appear without anyone
  // editing a list -- which is the property being claimed.
  const h2 = build();
  h2.ctx.DEFAULT_SETTINGS.somethingNewEntirely = 7;
  h2.ctx.state.settings.somethingNewEntirely = 7;
  const ref2 = h2.ctx.serverPresetKeyReference();
  const found = ref2.find(r => r.key === 'somethingNewEntirely');
  ok(!!found, 'a newly added setting appears in the reference with no list to update');
  eq(found.toml, 'something_new_entirely', 'with its file spelling derived, not written down');
  eq(h2.ctx.validateServerPresets({ something_new_entirely: 9 }).valid.somethingNewEntirely, 9,
     'and is immediately presettable');
}

/* ================================================================
   E. WIRING
================================================================ */
console.log('\n=== E. wiring ===');
{
  const boot = fs.readFileSync(ROOT + '/js/24-boot.js', 'utf8');
  const persist = fs.readFileSync(ROOT + '/js/05-persistence.js', 'utf8');
  const html = fs.readFileSync(ROOT + '/chat.html', 'utf8');
  const server = fs.readFileSync(ROOT + '/internal/server/server.go', 'utf8');
  const cfg = fs.readFileSync(ROOT + '/internal/config/config.go', 'utf8');
  const file = fs.readFileSync(ROOT + '/internal/config/file.go', 'utf8');

  // The seed has to happen before the first render or the user watches the
  // page repaint itself, so the fetch is awaited rather than fired and
  // forgotten.
  const loadAt = boot.indexOf('await loadState()');
  const presetAt = boot.indexOf('await loadServerPresets()');
  const seedAt = boot.indexOf('seedSettingsFromServerPresets(');
  ok(loadAt >= 0 && presetAt > loadAt, 'boot loads presets after state');
  ok(seedAt > presetAt, 'and seeds after loading them');
  // The CALL, not the word: boot's header comment mentions render() several
  // lines above anything that runs, and indexOf would happily match that.
  const renderCall = /\n\s*render\(\);/.exec(boot);
  ok(renderCall && seedAt < renderCall.index, 'and before the first render',
     renderCall ? `seed@${seedAt} render@${renderCall.index}` : 'no render() call found');

  ok(/hadOwnSettings = !!\(saved\.settings/.test(persist),
     'the loader records whether this device had settings of its own');
  ok(/id="server-presets-section"/.test(html), 'the DATA modal has the panel');
  ok(/renderServerPresetPanel\(\)/.test(fs.readFileSync(ROOT + '/js/21-data.js', 'utf8')),
     'which is painted when the modal opens');

  ok(/case path == "\/ui-defaults\.json":/.test(server), 'the server serves the table');
  ok(/UI map\[string\]any `toml:"ui"`/.test(cfg), 'and carries it without interpreting it');
  ok(/reflect\.Map/.test(file),
     'config keys skips table-valued fields, so it does not advertise a command that cannot work');
  ok(/\[ui\]/.test(file), 'and the written template documents the section');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
