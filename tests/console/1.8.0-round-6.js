/* GobboNet 1.8.0, round 6 -- console check for the legacy PowerShell server's
 * removal (roadmap #13).
 *
 * Paste into the browser console with GobboNet open and signed in. A couple of
 * seconds. It changes nothing on the server: it only reads. To see what the
 * page says when a 1.7 PowerShell server is the one answering, it answers the
 * page's own /health-fileserver question itself for a moment, in this tab only,
 * then puts everything back. The end of the output says what to try by hand on
 * Windows.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 6] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 6: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const get = async (path) => {
    const r = await fetch(path, { cache: 'no-store' });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const text = id => (document.getElementById(id) || {}).textContent || '';
  const fn = name => typeof window[name] === 'function';

  if (!fn('loadStandDownPanel') || !fn('loadLanPanel') || !fn('renderAboutBuild')) {
    log('FAIL', 'this page has no loadStandDownPanel / loadLanPanel / renderAboutBuild. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- who is answering ---------------------------------------------------
  log('INFO', '--- The server ---');
  const h = await get('/health-fileserver');
  check(h.status === 200 && h.body && h.body.server === 'gobbonet' && !!h.body.version,
    `gobbonet.exe is the server (server=${h.body && h.body.server}, version=${h.body && h.body.version})`);
  const models = await get('/models-list.json');
  check(models.status === 200 && models.body && 'active' in models.body,
    '/models-list.json comes from the server\'s own scan (launch.bat no longer writes one)');
  const active = await get('/active-model.json');
  check(active.status === 200 && active.body && typeof active.body.defaultCtx === 'number',
    '/active-model.json comes from the server too');

  // ---- the normal case says nothing about a PowerShell server -------------
  log('INFO', '--- What the page says normally ---');
  await loadStandDownPanel();
  check(!/PowerShell|fileserver/i.test(text('standdown-status')), 'Idle Stand-Down does not mention a PowerShell server');
  await loadLanPanel();
  check(!/PowerShell|fileserver/i.test(text('lan-status')), 'LAN Access does not mention one');
  renderAboutBuild();
  const warnEl = document.getElementById('about-version-warn');
  check(!!warnEl && (warnEl.hidden || !/fileserver/i.test(warnEl.textContent)), 'About shows no PowerShell-server warning');

  // ---- and what it says if a 1.7 copy were answering -----------------------
  log('INFO', '--- If a PowerShell server left running from 1.7 answered (this tab only) ---');
  const realFetch = window.fetch;
  const fake = { status: 'ok', server: 'fileserver.ps1', version: '1.7.9', pid: 4242, hotswap: true };
  const savedHealth = _aboutHealth, savedState = _aboutHealthState;
  try {
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/health-fileserver')) {
        return new Response(JSON.stringify(fake), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    const advice = t => /run stop-gobbonet\.bat/i.test(t) && /start GobboNet again/i.test(t) && !/instead of launch\.bat/i.test(t);

    await loadStandDownPanel();
    const sd = text('standdown-status');
    check(/fileserver\.ps1/.test(sd) && advice(sd), 'Idle Stand-Down names it and says: stop-gobbonet.bat, then start again');
    check(document.getElementById('set-standdown-minutes').disabled, 'and its control is disabled meanwhile');

    await loadLanPanel();
    const lan = text('lan-status');
    check(/fileserver\.ps1/.test(lan) && advice(lan), 'LAN Access says the same');

    _aboutHealth = fake; _aboutHealthState = 'ok';
    renderAboutBuild();
    const w = document.getElementById('about-version-warn');
    check(!w.hidden && advice(w.textContent) && /gobbonet program file/i.test(w.textContent),
      'About says the same, and that the page is built into the gobbonet program file');
  } finally {
    window.fetch = realFetch;
    _aboutHealth = savedHealth; _aboutHealthState = savedState;
    await loadStandDownPanel();
    await loadLanPanel();
    renderAboutBuild();
  }
  check(!/fileserver/i.test(text('standdown-status')) && !/fileserver/i.test(text('lan-status')),
    'and everything is back as it was');

  log('INFO', '--- By hand, on Windows ---');
  log('INFO', '1. Run launch.bat with gobbonet.exe renamed: it stops before the password prompt, says gobbonet.exe is missing and keeps the window open. Rename it back.');
  log('INFO', '2. set GOBBONET_LEGACY_SERVER=1, then launch.bat: one line says it is ignored, and gobbonet.exe runs as usual.');
  log('INFO', '3. Put any file named fileserver.ps1 in the install folder and run gobbonet.exe doctor: LEFTOVERS FROM 1.7 names it at the end. Delete it after.');
  log('INFO', '4. setup-lan.bat as Administrator: no "URL reservation added" line, and an old reservation for the web port is removed (netsh http show urlacl to confirm).');
  return done();
})();
