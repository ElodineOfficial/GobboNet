/**
 * The idle stand-down control in CONFIG — roadmap item 6, client half.
 *
 * The mechanism is server-side and tested in Go
 * (internal/supervisor/standdown_test.go for the decision rule,
 * internal/server/standdown_endpoint_test.go for the endpoint). This covers
 * the one thing only the browser can get wrong.
 *
 * THE CONTROL MUST ALWAYS BE VISIBLE, AND MUST SAY WHEN IT CANNOT WORK.
 *
 * It used to hide itself entirely unless the server manages llama.cpp — in
 * remote mode that process belongs to someone else and stopping it is not ours
 * to do, so the server reports `supported: false`. The reasoning was that a
 * switch which does nothing gets blamed when the VRAM stays pinned.
 *
 * That traded one problem for a worse one. An invisible feature is
 * indistinguishable from a feature that was never built, and what it actually
 * produced was someone opening CONFIG, finding nothing, and asking whether the
 * whole thing had been implemented. A setting nobody can find is not a
 * conservative default, it is a missing setting.
 *
 * So: always present, disabled when it cannot act, with the reason next to it.
 * Nobody flips a switch that does nothing, and nobody wonders whether the
 * switch exists.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');

const a = SRC.indexOf('/* ================================================================\n   IDLE STAND-DOWN PANEL');
if (a < 0) { console.error('could not locate the stand-down panel in js/15-cards.js'); process.exit(1); }
const BLOCK = SRC.slice(a);

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* The panel now asks TWO endpoints, and which one answers what is the whole
 * point of the change, so the harness has to be able to answer them
 * differently.
 *
 * `health` defaults to a Go server reporting a version, because that is the
 * normal install and every pre-existing case below was written against it.
 * Pass `health: { status: 'ok', pid: 1, hotswap: true }` for the PowerShell
 * file server -- the absence of `version` is what identifies it -- or
 * `health: null` for a server that does not answer at all.
 *
 * `urls` records every path asked for, in order, so a test can assert that the
 * page did not go on to ask a question it had already been answered. */
const GO_HEALTH = { status: 'ok', version: '1.7.5-go-abc1234', pid: 1, hotswap: true, mode: 'local' };

function build({ served = true, reply = null, status = 200, health = GO_HEALTH } = {}) {
  const els = {};
  const mk = (id) => (els[id] = { id, style: {}, value: '', textContent: '', dataset: {}, disabled: false });
  ['standdown-group', 'set-standdown-minutes', 'standdown-apply', 'standdown-status'].forEach(mk);
  const posts = [];
  const urls = [];
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    IS_SERVED: served,
    window: { location: { origin: 'http://192.168.1.5:8080' } },
    document: { getElementById: (id) => els[id] || null },
    Math, JSON, parseInt, Object, String, Number,
    fetch: async (url, opts) => {
      urls.push(String(url).replace('http://192.168.1.5:8080', ''));
      if (opts && opts.method === 'POST') posts.push(JSON.parse(opts.body));
      if (String(url).endsWith('/health-fileserver')) {
        if (health === null) throw new Error('unreachable');
        return { ok: true, status: 200, json: async () => health };
      }
      if (reply === null) throw new Error('unreachable');
      return { ok: status >= 200 && status < 300, status, json: async () => reply };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, posts, urls };
}

/* ================================================================
   A. THE CONTROL ONLY APPEARS WHERE IT WORKS
================================================================ */
console.log('\n=== A. visibility ===');
{
  let h = build({ reply: { supported: true, minutes: 5, stood_down: false } });
  await h.ctx.loadStandDownPanel();
  eq(h.els['standdown-group'].style.display, '', 'shown when the server manages llama.cpp');
  eq(h.els['set-standdown-minutes'].value, 5, 'and filled with the server\u2019s value');

  // Every case below is one where the control CANNOT act. None of them may
  // hide it, and all of them must say why -- that sentence is the whole
  // difference between "greyed out for a reason" and "was this ever built?".
  const cannotAct = async (h, label, expect) => {
    await h.ctx.loadStandDownPanel();
    eq(h.els['standdown-group'].style.display, '', label + ': still visible');
    ok(h.els['set-standdown-minutes'].disabled, label + ': the field is disabled');
    ok(h.els['standdown-apply'].disabled, label + ': and so is APPLY');
    ok(expect.test(h.els['standdown-status'].textContent), label + ': and says why',
       h.els['standdown-status'].textContent);
  };

  // Remote mode. The server owns this fact; the page cannot work it out.
  await cannotAct(build({ reply: { supported: false, minutes: 5 } }),
                  'remote mode', /somewhere else|belongs to whoever/i);

  // A Go server too old to have the route.
  await cannotAct(build({ reply: {}, status: 404 }), 'old program file',
                  /does not have the idle stand-down setting/i);
  {
    const h = build({ reply: {}, status: 404 });
    await h.ctx.loadStandDownPanel();
    const t = h.els['standdown-status'].textContent;
    // One file to replace, and it is named. The old wording pointed at "the
    // gobbonet program file beside web/", which named a folder that no longer
    // exists in an install and never existed in a source-ZIP one.
    ok(/replace the gobbonet program file/i.test(t),
       'old program file: names the one file to replace', t);
    ok(/chat page is built into it/i.test(t),
       'old program file: and says that is the whole update', t);
    ok(!/web\//.test(t),
       'old program file: and no longer sends the reader looking for web/', t);
    ok(/1\.7\.5/.test(t),
       'old program file: and says which version they have', t);
    ok(/runs in the server, not the browser/.test(t),
       'old program file: and why the page cannot do it alone', t);
  }

  // THE CASE THE OLD WORDING GOT WRONG. GobboNet started from launch.bat on
  // Windows is served by fileserver.ps1, which has no /standdown and no
  // version. The old panel read the 404 and told the reader their binary was
  // old and to replace it beside web/ -- an install made from the source ZIP
  // has neither of those things, so the advice could not be followed.
  for (const [label, PS_HEALTH] of [
    // Before 1.7.5 it sent no version, and that absence is still the tell.
    ['pre-1.7.5 ps1', { status: 'ok', pid: 4242, hotswap: true }],
    // Since 1.7.5 it names itself AND sends a version, so the panel must not
    // go back to trusting a version alone.
    ['1.7.5 ps1', { status: 'ok', server: 'fileserver.ps1', version: '1.7.5', pid: 4242, hotswap: true }],
  ]) {
    await cannotAct(build({ reply: {}, status: 404, health: PS_HEALTH }),
                    'PowerShell file server (' + label + ')', /PowerShell file server/i);
    const h = build({ reply: {}, status: 404, health: PS_HEALTH });
    await h.ctx.loadStandDownPanel();
    const t = h.els['standdown-status'].textContent;
    ok(/fileserver\.ps1/.test(t),
       'PowerShell: names the program that is actually serving the page', t);
    ok(/start GobboNet with the gobbonet program file/i.test(t),
       'PowerShell: and the action that gets the feature', t);
    ok(!/older than these web files/i.test(t),
       'PowerShell: and does not claim the server is merely out of date', t);
    ok(!/replace both together/i.test(t),
       'PowerShell: and does not ask for a web/ folder this install has not got', t);
    // It knows from /health-fileserver alone; asking /standdown as well would
    // be a request whose answer cannot change the advice.
    eq(h.urls.filter((u) => u === '/standdown').length, 0,
       'PowerShell: and does not bother asking /standdown');
  }

  // Unreachable: neither endpoint answers.
  await cannotAct(build({ reply: null, health: null }), 'unreachable', /Could not reach/i);

  // Health is unreachable but /standdown answers. That is not a real install,
  // it is a transient, and the panel must not conclude "PowerShell" from a
  // missing health reply -- only from one that arrives WITHOUT a version.
  {
    const h = build({ reply: { supported: true, minutes: 7, stood_down: false }, health: null });
    await h.ctx.loadStandDownPanel();
    ok(!h.els['set-standdown-minutes'].disabled,
       'a missing health reply does not disable a working control');
    eq(h.els['set-standdown-minutes'].value, 7, 'and the setting still loads');
  }

  // A server error on /standdown is reported as one, not as a missing feature.
  await cannotAct(build({ reply: { error: 'boom' }, status: 500 }), 'server error',
                  /could not read this setting \(error 500\)/i);

  // file://, where there is no server at all.
  const f = build({ served: false });
  await cannotAct(f, 'file://', /Opened from a file/i);
  eq(f.posts.length, 0, 'and file:// asks the server nothing');
}

/* ================================================================
   B. WHAT IT SAYS
================================================================ */
console.log('\n=== B. state the user can act on ===');
{
  let h = build({ reply: { supported: true, minutes: 5, stood_down: true } });
  await h.ctx.loadStandDownPanel();
  ok(/unloaded right now/.test(h.els['standdown-status'].textContent),
     'says when the model is currently unloaded', h.els['standdown-status'].textContent);
  ok(/next message will reload/.test(h.els['standdown-status'].textContent),
     'and that the next message brings it back \u2014 so the delay is expected, not a fault');

  h = build({ reply: { supported: true, minutes: 0, stood_down: false } });
  await h.ctx.loadStandDownPanel();
  ok(/stays loaded/.test(h.els['standdown-status'].textContent),
     'says plainly when it is off', h.els['standdown-status'].textContent);
}

/* ================================================================
   C. APPLYING
================================================================ */
console.log('\n=== C. changing it ===');
{
  let h = build({ reply: { minutes: 15, persisted: true, stood_down: false } });
  h.els['set-standdown-minutes'].value = '15';
  await h.ctx.applyStandDown();
  eq(h.posts.length, 1, 'one request is sent');
  eq(h.posts[0].minutes, 15, 'carrying the chosen value');
  ok(/Saved/.test(h.els['standdown-status'].textContent), 'and it confirms',
     h.els['standdown-status'].textContent);
  eq(h.els['standdown-status'].dataset.tone, 'ok', 'as a success');

  // Clamped in the page as well as the server, so an impossible number never
  // becomes a request that comes back as an error the user has to interpret.
  h = build({ reply: { minutes: 0, persisted: true } });
  h.els['set-standdown-minutes'].value = '-10';
  await h.ctx.applyStandDown();
  eq(h.posts[0].minutes, 0, 'a negative value is clamped to 0');
  eq(h.els['set-standdown-minutes'].value, 0, 'and the field is corrected to match');

  h = build({ reply: { minutes: 1440, persisted: true } });
  h.els['set-standdown-minutes'].value = '99999';
  await h.ctx.applyStandDown();
  eq(h.posts[0].minutes, 1440, 'and an absurd one to a day');

  h = build({ reply: { minutes: 0, persisted: true } });
  h.els['set-standdown-minutes'].value = 'abc';
  await h.ctx.applyStandDown();
  eq(h.posts[0].minutes, 0, 'a non-number becomes 0 rather than NaN');

  // persisted:false is a read-only install. Claiming a save that did not
  // happen would send the user away believing it survives a restart.
  h = build({ reply: { minutes: 5, persisted: false } });
  h.els['set-standdown-minutes'].value = '5';
  await h.ctx.applyStandDown();
  ok(/revert on restart/.test(h.els['standdown-status'].textContent),
     'a save that did not reach the file says so', h.els['standdown-status'].textContent);
  eq(h.els['standdown-status'].dataset.tone, 'err', 'and is not reported as success');

  // A refusal from the server is surfaced, not swallowed.
  h = build({ reply: { error: 'this server does not manage llama.cpp' }, status: 409 });
  h.els['set-standdown-minutes'].value = '5';
  await h.ctx.applyStandDown();
  ok(/does not manage/.test(h.els['standdown-status'].textContent),
     'the server\u2019s reason is shown', h.els['standdown-status'].textContent);
  eq(h.els['standdown-status'].dataset.tone, 'err', 'as an error');

  h = build({ reply: null });
  h.els['set-standdown-minutes'].value = '5';
  await h.ctx.applyStandDown();
  ok(/Could not reach/.test(h.els['standdown-status'].textContent),
     'an unreachable server says so rather than failing silently');
}

/* ================================================================
   D. WIRING
================================================================ */
console.log('\n=== D. wiring ===');
{
  ok(/id="standdown-group"/.test(HTML), 'the CONFIG panel has the group');
  ok(/id="set-standdown-minutes"/.test(HTML), 'with a minutes field');
  ok(/onclick="applyStandDown\(\)"/.test(HTML), 'and an apply button');
  // Must NOT start hidden. A display:none default meant a user whose server
  // could not answer -- for any reason -- saw nothing at all and had no way to
  // tell the feature from a missing one.
  ok(!/id="standdown-group"[^>]*display:none/.test(HTML), 'and does not start hidden');

  // At the bottom of CONFIG, where it was asked for: after the last ordinary
  // setting and directly above Privacy Status, which stays last.
  const groupAt = HTML.indexOf('id="standdown-group"');
  const privacyAt = HTML.indexOf('&#128274; Privacy Status');
  const remoteImgAt = HTML.indexOf('Remote Images In Cards');
  ok(groupAt > 0 && groupAt < privacyAt, 'and sits above Privacy Status');
  ok(groupAt > remoteImgAt, 'at the bottom of the panel rather than partway up it');
  ok(/loadStandDownPanel\(\)/.test(SRC), 'openSettings fills it when CONFIG opens');

  // This setting lives on the server, so it must NOT be written by the
  // settings modal's SAVE alongside the browser's own preferences.
  const saveFn = SRC.slice(SRC.indexOf('function saveSettings('), SRC.indexOf('\n}', SRC.indexOf('function saveSettings(')));
  ok(!/standdown/i.test(saveFn), 'and SAVE does not try to write it with the browser settings');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
