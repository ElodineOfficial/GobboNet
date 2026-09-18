/**
 * "Which build am I on?" — roadmap item 8.
 *
 * The ABOUT panel did not contain a version at all. Worse, the one string in
 * the app that claimed to identify the frontend — the build stamp in
 * js/01-config.js — read '1.6.0-no-encoded-payload' for the whole of 1.7.x.
 * It was wrong by two minor releases and nothing noticed, which is what a
 * constant that is only correct when someone remembers eventually does.
 *
 * So section A is the point of this file: the page's version and the VERSION
 * file are asserted equal. That is the mechanism behind "stays updated" — not
 * a note asking someone to bump it, a test that fails when they don't.
 *
 * SECTION B is the other half. The panel shows ONE number — it used to show
 * three, and on a healthy install two of them restated the third, which is
 * what got them culled.
 *
 * What the extra numbers were for has not gone away: the server's version and
 * the page's answer different questions, namely what the binary is and which
 * copy of the frontend this browser actually executed. A browser holding a
 * cached script shows the server cheerfully reporting the new release while
 * the user looks at last week's code, and that is indistinguishable from a
 * real regression unless something says so.
 *
 * So the pair now lives in the WARNING, which is hidden while they agree and
 * therefore costs nothing on the install where it has nothing to report. That
 * is the whole point of the change: the information appears where it is
 * useful rather than on every panel open.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CONFIG_SRC = fs.readFileSync(ROOT + '/js/01-config.js', 'utf8');
const SCHED_SRC = fs.readFileSync(ROOT + '/js/22-scheduler.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const VERSION_FILE = fs.readFileSync(ROOT + '/VERSION', 'utf8').trim();

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* ================================================================
   A. THE STAMP CANNOT GO STALE
================================================================ */
console.log('\n=== A. the page version matches the VERSION file ===');
{
  const m = /const GOBBONET_UI_VERSION = '([^']*)'/.exec(CONFIG_SRC);
  ok(!!m, 'js/01-config.js declares GOBBONET_UI_VERSION');
  const declared = m ? m[1] : null;

  ok(/^\d+\.\d+\.\d+/.test(VERSION_FILE), 'the VERSION file holds a release number', VERSION_FILE);
  eq(declared, VERSION_FILE,
     'the page stamp equals the VERSION file — bump BOTH, or this fails');

  // The string it replaced is the cautionary tale; it must not come back.
  ok(!/CHAT_HTML_BUILD/.test(CONFIG_SRC),
     'the old hand-maintained build stamp is gone');
  // The old value is still named in the comment above the constant, on
  // purpose -- it is the reason the comment exists. What must not come back is
  // it being ASSIGNED to anything.
  ok(!/=\s*'1\.6\.0-no-encoded-payload'/.test(CONFIG_SRC),
     'and the 1.6.0 value it was stuck on is no longer assigned anywhere');
}

/* ================================================================
   B. TWO NUMBERS, AND WHAT IT MEANS WHEN THEY DIFFER
================================================================ */
console.log('\n=== B. server version vs page version ===');

const a = SCHED_SRC.indexOf('/* ================================================================\n   ABOUT — "which build am I on?"');
const b = SCHED_SRC.indexOf('function closeAbout()');
if (a < 0 || b < 0) {
  console.error('could not locate the About build block in js/22-scheduler.js');
  process.exit(1);
}
const BLOCK = SCHED_SRC.slice(a, b);

function build({ served = true, health = null, pageVersion = VERSION_FILE,
                 hostname = '192.168.1.5', protocol = 'http:' } = {}) {
  const els = {};
  const mk = (id) => (els[id] = { id, textContent: '', hidden: false, style: {} });
  ['about-version', 'about-version-page', 'about-version-server',
   'about-server-row', 'about-version-warn', 'about-model-line'].forEach(mk);
  els['about-modal'] = { classList: { add() {}, remove() {} } };
  els['about-model-line'].textContent = 'Local GGUF (detecting...)';

  let copied = null;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    IS_SERVED: served,
    GOBBONET_UI_VERSION: pageVersion,
    STORAGE_BACKEND: 'idb',
    syncTargetLabel: () => 'phone',
    window: { location: { origin: 'http://192.168.1.5:8080', hostname, protocol } },
    navigator: {
      userAgent: 'TestBrowser/1.0',
      clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } },
    },
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({ style: {}, select() {}, setSelectionRange() {} }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    setTimeout: () => 0,
    Math, JSON, Object, String, Number, Boolean, RegExp, Promise, Error,
    fetch: async () => (health === null
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => health }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, copied: () => copied, get: (e) => vm.runInContext(e, ctx) };
}

{
  // Matching versions: the headline is the release, and nothing is flagged.
  let h = build({ health: { version: VERSION_FILE + '-go-abc1234' } });
  await h.ctx.openAbout();
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  eq(h.els['about-version'].textContent, VERSION_FILE, 'the panel shows the release number');
  ok(h.els['about-version-warn'].hidden, 'and nothing else, because nothing disagrees');

  // SERVER AHEAD OF PAGE -- a cached frontend.
  h = build({ health: { version: '1.7.4-go-abc1234' }, pageVersion: '1.7.3' });
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  ok(!h.els['about-version-warn'].hidden, 'a mismatch is flagged');
  let warn = h.els['about-version-warn'].textContent;
  ok(/1\.7\.3/.test(warn) && /1\.7\.4/.test(warn), 'naming both numbers', warn);
  ok(/cached/i.test(warn), 'and saying what it almost certainly is', warn);
  ok(/hard-refresh/i.test(warn), 'and what to do about it', warn);

  // PAGE AHEAD OF SERVER -- the opposite fault, needing the opposite advice.
  //
  // This is not hypothetical. A build went out with an updated frontend beside
  // a binary that had not been rebuilt: two server-side features were silently
  // missing, and "clear your cache" would have sent the reader in exactly the
  // wrong direction. One message for both directions is worse than none.
  h = build({ health: { version: '1.7.3-go-abc1234' }, pageVersion: '1.7.4' });
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  ok(!h.els['about-version-warn'].hidden, 'an older server is flagged too');
  warn = h.els['about-version-warn'].textContent;
  ok(/program is older/i.test(warn), 'naming the server program as the stale half', warn);
  ok(/replace the gobbonet program file/i.test(warn), 'and what to do about it', warn);
  ok(/one file is the whole update/i.test(warn),
     'and that it is one file, now that the page ships inside it', warn);
  // The guard that matters, kept but sharpened. The original refused to mention
  // the browser cache at all here, on the grounds that "clear your cache" is
  // the advice for the OPPOSITE fault and sends the reader the wrong way.
  //
  // Since the page ships inside the program file, a cached newer page really is
  // one of the things that can produce this reading, so refusing to name it
  // would now be the inaccurate choice. What must not happen is it being
  // offered FIRST — so that is what is asserted, rather than its absence.
  ok(!/hard-refresh/i.test(warn),
     'without repeating the other direction\u2019s instruction', warn);
  {
    const prog = warn.search(/program file/i);
    const cache = warn.search(/browser/i);
    ok(prog >= 0 && (cache < 0 || prog < cache),
       'and leading with the program file rather than the browser', warn);
  }

  // THE OTHER SERVER. fileserver.ps1 is a different program in front of the
  // same page, and this panel used to be unable to say so: it sent no version,
  // so the comparison above was skipped, the warning stayed hidden, and the row
  // showed the PAGE's stamp as the version of the whole install. The reader was
  // told they were on a current release by a server carrying none of it.
  //
  // Both vintages are checked. Before 1.7.5 the absence of a version is the
  // tell; since 1.7.5 it names itself and DOES send a version, so recognising
  // it must not depend on that absence.
  for (const [label, hz] of [
    ['pre-1.7.5', { status: 'ok', pid: 7, hotswap: true }],
    ['1.7.5', { status: 'ok', server: 'fileserver.ps1', version: VERSION_FILE, pid: 7, hotswap: true }],
  ]) {
    h = build({ health: hz });
    await h.ctx._fetchAboutHealth();
    h.ctx.renderAboutBuild();
    ok(!h.els['about-version-warn'].hidden,
       label + ' PowerShell server: flagged rather than passed off as healthy');
    warn = h.els['about-version-warn'].textContent;
    ok(/fileserver\.ps1/.test(warn),
       label + ' PowerShell server: named, so the reader knows what is answering', warn);
    ok(/idle stand-down/i.test(warn),
       label + ' PowerShell server: and what is missing because of it', warn);
    ok(/gobbonet program file/i.test(warn),
       label + ' PowerShell server: and the one thing to run instead', warn);
    ok(!/hard-refresh/i.test(warn),
       label + ' PowerShell server: without blaming the browser cache', warn);
  }

  // Same release, different build metadata, is not a mismatch.
  h = build({ health: { version: '1.7.4-go-deadbee' }, pageVersion: '1.7.4' });
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  ok(h.els['about-version-warn'].hidden, 'the same release with a different sha is not flagged');

  // An unstamped local build legitimately differs from everything.
  h = build({ health: { version: 'dev' } });
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  ok(h.els['about-version-warn'].hidden, 'a "dev" server build is not flagged as stale');
  eq(h.els['about-version'].textContent, 'dev', 'and is reported as dev');

  // With no server to ask, the page's own stamp is the only thing knowable,
  // and it still has to appear. A panel that says nothing is worse than the
  // three rows that got culled.
  h = build({ health: null });
  await h.ctx._fetchAboutHealth();
  h.ctx.renderAboutBuild();
  eq(h.els['about-version'].textContent, VERSION_FILE,
     'an unreachable server still leaves the page version on screen');
  ok(h.els['about-version-warn'].hidden, 'with nothing flagged, because nothing is known to differ');

  h = build({ served: false });
  h.ctx.renderAboutBuild();
  eq(h.els['about-version'].textContent, VERSION_FILE, 'and so does file://');

  // The detail did not vanish, it moved to the pasted block, where it costs no
  // screen space and is exactly what a bug report wants.
  h = build({ health: null });
  await h.ctx._fetchAboutHealth();
  ok(/no GobboNet server answered/i.test(h.ctx.aboutDiagnosticsText()),
     'and COPY BUILD INFO still says nothing answered');
}

/* ================================================================
   C. THE COPY BUTTON

   "The simplest way to identify what version they're on" is one button that
   produces something pasteable.
================================================================ */
console.log('\n=== C. paste-ready build info ===');
{
  const stamped = VERSION_FILE + '-go-abc1234';
  const h = build({ health: { version: stamped, mode: 'managed', upstream_ok: true } });
  await h.ctx._fetchAboutHealth();
  const text = h.ctx.aboutDiagnosticsText();

  // Built from VERSION_FILE rather than a literal: a test that hardcodes a
  // release number goes stale on the next bump, which is the disease this
  // whole file exists to prevent.
  ok(text.includes('page:    ' + VERSION_FILE), 'the page version is in it', text);
  ok(text.includes('server:  ' + stamped), 'the server version too', text);

  const none = build({ health: null });
  await none.ctx._fetchAboutHealth();
  ok(/server:\s+no GobboNet server answered/.test(none.ctx.aboutDiagnosticsText()),
     'and a missing server says so in the pasted block too');
  ok(/mode:\s+managed/.test(text), 'the mode', text);
  ok(/llama:\s+reachable/.test(text), 'whether llama.cpp answered', text);
  ok(/storage:\s+idb/.test(text), 'the storage backend', text);
  ok(/sync:\s+phone/.test(text), 'and which sync target, since that now varies per device', text);
  ok(/browser:\s+TestBrowser/.test(text), 'plus the browser', text);

  // Deliberately absent. The useful fact is "reached over the network", not
  // the address — this should not quietly make it easy to paste a home LAN
  // address into a public channel.
  ok(!/192\.168/.test(text), 'the LAN address is NOT included', text);
  ok(/over the network/.test(text), 'only whether it was local or remote', text);

  const local = build({ health: { version: VERSION_FILE }, hostname: 'localhost' });
  await local.ctx._fetchAboutHealth();
  ok(/same machine/.test(local.ctx.aboutDiagnosticsText()), 'localhost is reported as same machine');

  // The button writes to the clipboard and says it did.
  const btn = { textContent: 'COPY BUILD INFO' };
  h.ctx.copyAboutDiagnostics(btn);
  await Promise.resolve();
  ok(h.copied() && /GobboNet build info/.test(h.copied()), 'the button copies the summary');
  eq(btn.textContent, 'COPIED', 'and confirms it on the button');

  // A failing clipboard must not leave a dead button: reaching this over
  // plain http on a LAN is the normal way to use the app from a phone, and
  // navigator.clipboard rejects outside a secure context.
  const h2 = build({ health: { version: VERSION_FILE } });
  h2.ctx.navigator.clipboard = { writeText: () => Promise.reject(new Error('insecure context')) };
  const btn2 = { textContent: 'COPY BUILD INFO' };
  h2.ctx.copyAboutDiagnostics(btn2);
  await Promise.resolve(); await Promise.resolve();
  eq(btn2.textContent, 'COPIED', 'a rejected clipboard falls back to execCommand');
}

/* ================================================================
   D. WIRING
================================================================ */
console.log('\n=== D. wiring ===');
{
  ok(/id="about-build"/.test(HTML), 'the ABOUT panel has a build block');
  for (const id of ['about-version', 'about-version-warn', 'about-copy-btn']) {
    ok(new RegExp('id="' + id + '"').test(HTML), '  with #' + id);
  }
  // Culled on purpose. Listed by name so re-adding a row is a deliberate act
  // rather than something that creeps back.
  for (const id of ['about-version-page', 'about-version-server', 'about-server-row']) {
    ok(!new RegExp('id="' + id + '"').test(HTML), '  and no #' + id + ' row');
  }
  const rows = (HTML.match(/class="about-build-row"/g) || []).length;
  eq(rows, 1, 'the block is one row');
  ok(/onclick="copyAboutDiagnostics\(this\)"/.test(HTML), 'and the copy button is wired');

  // It has to be paintable before the network answers, or the panel is blank
  // for anyone whose server is the thing that is broken.
  const openFn = SCHED_SRC.slice(SCHED_SRC.indexOf('function openAbout()'));
  const syncAt = openFn.indexOf('renderAboutBuild();');
  const fetchAt = openFn.indexOf('_fetchAboutHealth()');
  ok(syncAt >= 0 && fetchAt > syncAt,
     'openAbout paints from what it already knows before it asks the server');

  // The build block must come first in the panel: it is what the panel gets
  // opened for.
  const buildAt = HTML.indexOf('id="about-build"');
  const privacyAt = HTML.indexOf('PRIVATE BY DESIGN');
  ok(buildAt > 0 && buildAt < privacyAt, 'and it is the first thing in the panel');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
