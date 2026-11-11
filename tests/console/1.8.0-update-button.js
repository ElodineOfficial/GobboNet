/* GobboNet 1.8.0 -- console check for the update button: ABOUT > THIS BUILD >
 * CHECK FOR UPDATES, UPDATE NOW and RESTART NOW.
 *
 * Paste into the browser console with GobboNet open and signed in -- on the
 * PC, and once from a phone if you use one.
 *
 * It asks for an update check, which is exactly what pressing the button
 * does: this server asks GitHub for the list of releases. It installs
 * nothing and restarts nothing. The two requests it makes to the install and
 * restart routes name a build that does not exist, or are skipped, so that
 * they can only be refused.
 *
 * To see the whole flow, use the buttons in ABOUT afterwards.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [update button] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 update button: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';
  const json = async (path, init) => {
    const r = await fetch(location.origin + path, Object.assign({ cache: 'no-store' }, init || {}));
    let body = null;
    try { body = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, body };
  };

  if (!fn('checkForUpdates') || !fn('installUpdate') || !fn('restartIntoUpdate')) {
    log('FAIL', 'this page has no checkForUpdates: it is older than 1.8.0. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the button ----------------------------------------------------------------
  log('INFO', '--- The button ---');
  const build = document.getElementById('about-build');
  const btn = document.getElementById('about-update-btn');
  check(!!build && !!btn && build.contains(btn) && !btn.disabled, 'CHECK FOR UPDATES is in ABOUT > THIS BUILD, and pressable');
  check(!!document.getElementById('about-update') && !!document.getElementById('tip-update'), 'the answer area and its "?" note are there');
  const earlier = performance.getEntriesByType('resource').filter(e => /\/update\/check/.test(e.name)).length;
  log('INFO', earlier ? `the button was pressed ${earlier} time(s) on this page before now` : 'nothing has asked for an update check on this page yet (it only happens when the button is pressed)');

  // ---- status ----------------------------------------------------------------------
  log('INFO', '--- This server ---');
  const health = await json('/health-fileserver');
  const st = await json('/update/status');
  if (st.status === 404) {
    log('FAIL', 'the server has no /update/status: the gobbonet program file is older than this page. Replace it and restart GobboNet.');
    return done();
  }
  check(st.status === 200 && st.body && 'state' in st.body, '/update/status answers');
  log('INFO', 'install state: ' + (st.body && st.body.state ? st.body.state + (st.body.build ? ' (' + st.body.build + ')' : '') : 'none since GobboNet started'));

  // ---- a check -----------------------------------------------------------------------
  log('INFO', '--- A check (this server asks GitHub) ---');
  const t0 = performance.now();
  const c = await json('/update/check');
  check(c.status === 200 && c.body && typeof c.body.status === 'string', '/update/check answers (' + Math.round(performance.now() - t0) + ' ms)');
  const b = c.body || {};
  const known = ['available', 'current', 'manual', 'unverifiable', 'off', 'dev', 'error'];
  check(known.includes(b.status), 'status: ' + b.status + (b.error ? ' -- ' + b.error : ''));
  check(b.current && health.body && b.current.build === health.body.version,
    'it compares against the build that is running: ' + (b.current && b.current.build) + ', serial ' + (b.current && b.current.serial));
  log('INFO', 'this install: ' + (b.install ? b.install.kind + ' (' + b.install.target + ')' + (b.install.reason ? ' -- ' + b.install.reason : '') : '?'));
  log('INFO', 'this device is ' + (b.on_this_pc ? 'the PC GobboNet runs on: it can install' : 'not the PC GobboNet runs on: it can check, not install'));
  log('INFO', 'signing key built in: ' + (b.signing_key ? 'yes' : 'NO -- this build can say a release exists but installs nothing (docs/UPDATES.md)'));
  (b.notes || []).forEach(n => log('INFO', 'skipped: ' + n));

  if (b.offer) {
    const o = b.offer, cur = b.current || {};
    log('INFO', 'offered: ' + o.build + ' (serial ' + o.serial + ') from ' + o.tag + (o.size ? ', ' + o.size + ' bytes' : '') + (o.hotfix ? ' -- a fix for the version you have' : ''));
    const parts = v => String(v || '').split('-')[0].split('.').map(Number);
    const cmp = (a, z) => { const x = parts(a), y = parts(z); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; } return 0; };
    const base = cmp(o.version, cur.version);
    check(base > 0 || (base === 0 && o.serial > cur.serial && o.build !== cur.build),
      'never backwards: what is offered is a later release, or a later build of this one');
  }

  // ---- what may not happen from here --------------------------------------------------
  log('INFO', '--- Requests that must be refused ---');
  const bogus = await json('/update/install', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build: '0.0.0-go-console', serial: 1 }) });
  if (b.on_this_pc) {
    check([409, 502].includes(bogus.status), 'installing a build nobody offered is refused (' + bogus.status + ': ' + (bogus.body && bogus.body.error) + ')');
  } else {
    check(bogus.status === 403, 'installing from this device is refused (' + bogus.status + ')');
  }
  if (st.body && st.body.state === 'installed') {
    log('INFO', 'an update is installed and waiting, so the restart route is not tried: RESTART NOW in ABOUT finishes it');
  } else {
    const r = await json('/update/restart', { method: 'POST' });
    check(b.on_this_pc ? r.status === 409 : r.status === 403, 'RESTART NOW with nothing installed is refused (' + r.status + ')');
  }
  return done();
})();
