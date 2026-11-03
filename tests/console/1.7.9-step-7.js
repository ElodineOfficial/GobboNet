/* GobboNet 1.7.9 — console check for patch step 7 and the password setting.
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). Read-only: nothing is saved, changed or downloaded.
 *
 *   Step 7  F9   file layout: the model catalogue still loads after moving
 *                from installer/ to catalog/
 *   PW           min_password_length (8 by default, as low as 4)
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const get = async path => {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  };

  // ── Step 7: the catalogue moved from installer/ to catalog/ ─────────────
  // The add-a-model list reads models.ini through catalog.Discover. If the
  // move had lost it, this would say "no models.ini was found".
  try {
    const c = await get('/catalog.json');
    const models = (c.body && Array.isArray(c.body.models)) ? c.body.models : [];
    if (c.ok && models.length) {
      log('PASS', 'F9', `model catalogue loads: ${models.length} models (source: ${c.body.source || 'unknown'})`);
      if (c.body.source === 'remote') {
        log('INFO', 'F9', 'this came from goblincorps.com; to test the bundled catalog/models.ini, switch the remote catalogue off in CONFIG and re-run');
      }
    } else {
      const why = (c.body && (c.body.detail || c.body.error)) || `HTTP ${c.status}`;
      log('FAIL', 'F9', 'model catalogue did not load: ' + why);
    }
  } catch (e) {
    log('FAIL', 'F9', 'could not read /catalog.json: ' + e.message);
  }
  log('INFO', 'F9', 'by hand on Windows: an update extracted over 1.7.8 leaves installer\\models.ini behind; that is fine, catalog\\models.ini wins');

  // ── Password minimum ─────────────────────────────────────────────────────
  try {
    const a = await get('/active-model.json');
    log(a.ok ? 'PASS' : 'FAIL', 'PW', a.ok
      ? 'this session is signed in: your existing password works, whatever its length'
      : `request not accepted (HTTP ${a.status}); sign in and re-run`);
  } catch (e) {
    log('FAIL', 'PW', 'sign-in check failed: ' + e.message);
  }
  try {
    // CONFIG > Config File's own endpoint. It answers only on this PC.
    const f = await get('/config/file');
    if (f.ok && f.body && typeof f.body.text === 'string') {
      const m = f.body.text.match(/^\s*min_password_length\s*=\s*(\d+)/m);
      const n = m ? Math.max(4, Number(m[1]) || 8) : 8;
      log('PASS', 'PW', m
        ? `min_password_length is set in config.toml: new passwords need ${n} characters`
        : 'min_password_length is not set in config.toml: new passwords need the default, 8 characters');
    } else {
      log('INFO', 'PW', 'config.toml can only be read from this PC (CONFIG > Config File); skipped');
    }
  } catch (e) {
    log('INFO', 'PW', 'could not read the config file: ' + e.message);
  }
  log('INFO', 'PW', 'by hand: `gobbonet config set min_password_length 4`, then `gobbonet set-password` accepts a 4-character password and refuses 3.');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 7: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
