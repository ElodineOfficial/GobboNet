/* GobboNet 1.8.0 -- console check for the release number, the Informant's
 * notes, and the update key.
 *
 * Paste into the browser console with GobboNet open and signed in, on an
 * install from GobboNetSetup-1_8_0.exe or the 1.8.0 zip. About two seconds.
 * As it is, it reads only and asks nothing of the internet.
 *
 * Checks that the page, the server and the About panel all say 1.8.0 and
 * agree with each other; that the Gobbonet Informant shipped with this build
 * is 1.8.0's, and whether yours is; and that this build has the update
 * signing key built in.
 *
 * To also ask GitHub whether a newer release exists, and whether this
 * install could install it (what CHECK FOR UPDATES does), run this first:
 *
 *     window.GN_UPDATE_CHECK = true
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [1.8.0] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 version: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };

  // ---- the release number, on both halves and in ABOUT ----------------------
  const page = typeof GOBBONET_UI_VERSION === 'string' ? GOBBONET_UI_VERSION : '(none)';
  check(page === '1.8.0', `the page says ${page}`);
  let server = '';
  try {
    const r = await fetch('/health-fileserver', { cache: 'no-store' });
    if (r.ok) server = String((await r.json()).version || '');
  } catch (_) {}
  check(/^1\.8\.0-go-[0-9a-z.]+$/.test(server), `the server says ${server || '(nothing)'}`);
  check(server.split('-go-')[0] === page, 'the two halves are the same release');
  if (/dirty/.test(server)) log('INFO', 'this server was built from a modified tree (-dirty); a released build never is.');

  if (typeof openAbout === 'function') {
    openAbout();
    let shown = '';
    for (let i = 0; i < 20 && !/\d/.test(shown); i++) {
      await new Promise(r => setTimeout(r, 100));
      shown = (document.getElementById('about-version') || {}).textContent || '';
    }
    const warn = document.getElementById('about-version-warn');
    check(shown.trim() === '1.8.0' && (!warn || !warn.textContent.trim() || warn.hidden || getComputedStyle(warn).display === 'none'),
      `ABOUT shows ${shown.trim() || '(nothing)'} with no version warning`);
    check(!!document.getElementById('about-update-btn'), 'ABOUT has CHECK FOR UPDATES');
    if (typeof closeAbout === 'function') closeAbout();
    else document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  } else {
    log('FAIL', 'this page has no ABOUT panel to read');
  }

  // ---- the Informant ---------------------------------------------------------
  const presets = (typeof defaultCharacters !== 'undefined' && Array.isArray(defaultCharacters)) ? defaultCharacters : [];
  const shipped = presets.find(c => c && c.name === 'Gobbonet Informant');
  check(!!shipped && /GobboNet 1\.8\.0\./.test(shipped.desc || '') && /guide to GobboNet 1\.8\.0,/.test(shipped.writingStyle || ''),
    'the Gobbonet Informant shipped with this build is 1.8.0\'s');
  if (shipped && /CHECK FOR UPDATES/.test(shipped.writingStyle || '') && /Files panel/.test(shipped.writingStyle || ''))
    log('PASS', 'its notes cover 1.8.0 (the Files panel, CHECK FOR UPDATES, and the rest)');
  if (shipped && typeof defaultCharState === 'function') {
    const st = defaultCharState(shipped);
    log('INFO', st === 'new' ? 'you have not added the Informant (home screen, DEFAULT CHARACTERS, + ADD)'
      : st === 'same' ? 'your Informant is already 1.8.0\'s'
      : 'your Informant is an older one: its tile on the home screen says UPDATE');
  }

  // ---- the update key, and (if asked) GitHub ------------------------------------
  if (!window.GN_UPDATE_CHECK) {
    log('INFO', 'Not asking GitHub. To check for a newer release and whether this install can take it, run  window.GN_UPDATE_CHECK = true  and paste this again.');
    return done();
  }
  log('INFO', 'asking GitHub, as CHECK FOR UPDATES does');
  let body = null;
  try {
    const r = await fetch('/update/check', { cache: 'no-store' });
    body = await r.json();
    if (!r.ok && !body) throw new Error('HTTP ' + r.status);
  } catch (e) {
    log('FAIL', '/update/check did not answer: ' + (e && e.message));
    return done();
  }
  check(body.signing_key === true, 'this build has the update signing key built in, so it can install a signed release');
  const inst = body.install || {};
  log('INFO', `this install: ${inst.kind || '?'} (${inst.target || '?'})${inst.can_install ? ', which the button can update' : ' -- ' + (inst.reason || 'the button links the release page instead')}`);
  const said = {
    off: 'update checks are switched off (update_releases_url = "" in config.toml)',
    dev: 'an unstamped build: nothing to compare it with, so nothing was asked',
    current: 'no newer release is out yet',
    error: 'the check could not finish: ' + (body.error || '?'),
  }[body.status];
  if (said) log('INFO', said);
  if (body.offer) log('INFO', `newer: ${body.offer.build} (${body.offer.hotfix ? 'a fix of this release' : 'a newer release'})${body.offer.installable ? ', installable here with UPDATE NOW' : ' -- ' + (body.reason || 'get it from the release page')}`);
  return done();
})();
