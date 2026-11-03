/* GobboNet 1.7.9 -- console check for patch step 16 (the release number).
 *
 * Paste into the browser console with GobboNet open and signed in. About a
 * second. Reads only.
 *
 * Checks that the page, the server and the About panel all say 1.7.9, and
 * that they agree with each other -- the case About warns about when an
 * update replaced one half and not the other.
 * Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', '1.7.9', msg);

  const page = typeof GOBBONET_UI_VERSION === 'string' ? GOBBONET_UI_VERSION : '(none)';
  check(page === '1.7.9', `the page says ${page}`);
  let server = '';
  for (const path of ['/health-fileserver', '/health']) {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.version) { server = String(j.version); break; }
    } catch (_) {}
  }
  check(/^1\.7\.9-go-[0-9a-z.]+$/.test(server), `the server says ${server || '(nothing)'}`);
  check(server.split('-go-')[0] === page, 'the two halves are the same release');
  if (/dirty/.test(server)) log('INFO', '1.7.9', 'this server was built from a modified tree (-dirty); a released build never is.');

  if (typeof openAbout === 'function') {
    openAbout();
    let shown = '';
    for (let i = 0; i < 20 && !/\d/.test(shown); i++) {
      await new Promise(r => setTimeout(r, 100));
      shown = (document.getElementById('about-version') || {}).textContent || '';
    }
    const warn = document.getElementById('about-version-warn');
    check(shown.trim() === '1.7.9' && (!warn || !warn.textContent.trim() || warn.hidden || getComputedStyle(warn).display === 'none'),
      `ABOUT shows ${shown.trim() || '(nothing)'} with no version warning`);
    if (typeof closeAbout === 'function') closeAbout();
    else document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  }

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 16: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
