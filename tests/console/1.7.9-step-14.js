/* GobboNet 1.7.9 -- console check for patch step 14 (F6, endorsed mods).
 *
 * Paste into the browser console on the PC running GobboNet (open it at
 * http://localhost:9066), signed in, with no panel open. About 5 seconds.
 *
 * It asks GobboNet for the endorsed list and reports what is on it (an INFO
 * if goblincorps.com has not published the list yet), checks that opening
 * MODS fetches nothing until BROWSE, and checks the 18+ cover with a made-up
 * list that is never sent anywhere. It installs NOTHING from the real list.
 * On the PC it makes one throwaway mod that throws on purpose (zz-check-fail):
 * expect one red "Uncaught Error: zz-check: deliberate" line above the
 * results. It must be switched off by itself; then it is removed.
 * Your own mods, the 18+ choice on this device and the list on screen are
 * left as they were. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', 'F6', msg);
  const info = msg => log('INFO', 'F6', msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const api = async (path, method, body) => {
    const r = await fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  if (typeof browseEndorsedMods !== 'function' || typeof modFailed !== 'function') {
    log('FAIL', 'F6', 'this page has no endorsed mods (browseEndorsedMods() is missing) -- is it the 1.7.9 step 14 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (document.querySelector('.modal-backdrop.open') || (typeof tourActive === 'function' && tourActive())) {
    info('close the open panel (or answer the tour) first, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  const PROBE = 'zz-check-fail';
  const ADULT = 'gobbonet.mods.adultOk';
  let adultBefore = null;
  try { adultBefore = localStorage.getItem(ADULT); } catch (_) {}
  const dataBefore = _endorsed.data;
  const adultPageBefore = _endorsed.adultThisPage;
  let canManage = false;
  try {
    // ── The panel ──────────────────────────────────────────────────────
    const sec = document.getElementById('endorsed-section');
    const link = sec && sec.querySelector('a[href="https://goblincorps.com/gobbonet_extras"]');
    check(!!sec && !!document.getElementById('endorsed-browse-btn') && !!link && link.rel.includes('noopener'),
      'MODS has an ENDORSED MODS section with BROWSE and a link to the extras page');

    const listFetches = () => performance.getEntriesByType('resource').filter(e => e.name.includes('/mod-list.json')).length;
    const before = listFetches();
    openExtensions();
    await wait(800);
    check(listFetches() === before, 'opening MODS fetches nothing from the endorsed list');
    closeExtensions();

    // ── The list, as GobboNet sees it ──────────────────────────────────
    const l = await api('/mod-list.json');
    canManage = !!l.body.canManage;
    check(l.status === 200 && Array.isArray(l.body.mods) && typeof l.body.url === 'string', 'GobboNet answers /mod-list.json');
    if (l.body.off) info('the endorsed list is switched off here (mod_list_url is empty in config.toml).');
    else if (l.body.error) info('the endorsed list is not reachable yet (' + l.body.url + '): ' + l.body.error);
    else {
      check(l.body.source === 'remote' || l.body.source === 'cache', `the list came from ${l.body.url} (${l.body.source === 'cache' ? 'a saved copy' : 'live'}), ${l.body.mods.length} mod(s)`);
      l.body.mods.forEach(m => info(`${m.state.toUpperCase().padEnd(9)} ${m.name} v${m.version}${m.adult ? ' (18+)' : ''}${m.installed && m.state === 'update' ? ' -- you have v' + m.installed : ''}${m.problem ? ' -- ' + m.problem : ''}`));
      check(l.body.mods.every(m => (m.files || []).every(f => /^[0-9a-f]{64}$/.test(f.sha256) && /^https:\/\//.test(f.url))),
        'every file on it is https and pinned by SHA-256');
    }
    (l.body.notes || []).forEach(n => info('note: ' + n));

    // ── Install is checked, and for this PC only ───────────────────────
    const bad = await api('/mod-list/install', 'POST', { id: '../zz' });
    const none = await api('/mod-list/install', 'POST', { id: 'zz-not-on-the-list' });
    if (canManage) {
      check(bad.status === 400 && (none.status === 404 || none.status === 502), `an id that is not on the list installs nothing (${bad.status}, ${none.status})`);
    } else {
      check(bad.status === 403 && none.status === 403, 'this device is not the PC, and the server refuses to install from here (403)');
    }

    // ── The 18+ cover, on a made-up list that never leaves this page ────
    try { localStorage.removeItem(ADULT); } catch (_) {}
    _endorsed.adultThisPage = false;
    _endorsed.data = { canManage, source: 'remote', notes: [], mods: [
      { id: 'zz-plain', name: 'zz plain', version: '1', state: 'new' },
      { id: 'zz-adult', name: 'zz adult', version: '1', state: 'new', adult: true },
    ] };
    renderEndorsedList();
    const shown = () => [...document.querySelectorAll('#endorsed-list .endorsed-row')].map(r => r.dataset.endorsedId);
    check(JSON.stringify(shown()) === '["zz-plain"]' && /marked 18\+ and hidden/.test(document.getElementById('endorsed-list').textContent),
      'a mod marked 18+ is hidden, and the list says one is');
    document.getElementById('endorsed-adult-btn').click();
    let remembered = null;
    try { remembered = localStorage.getItem(ADULT); } catch (_) {}
    check(JSON.stringify(shown()) === '["zz-plain","zz-adult"]' && remembered === '1', 'I AM 18 OR OLDER shows it, remembered on this device');

    // ── A mod that throws is switched off by itself ────────────────────
    if (canManage) {
      const made = await api('/mods/' + PROBE + '/source', 'PUT', {
        name: 'Console check fail', styles: [{ name: 'css', raw: ':root{--zz-check-fail:1}' }],
        scripts: [{ name: 'js', raw: 'throw new Error("zz-check: deliberate")' }], enabled: true,
      });
      check(made.status === 200, 'made a throwaway mod whose script throws');
      _modFailedOnce.delete(PROBE);
      await applyMods();
      let off = false;
      for (let i = 0; i < 20 && !off; i++) {
        await wait(150);
        off = (await api('/mods')).body.mods.some(m => m.id === PROBE && !m.enabled);
      }
      check(off, 'it was switched off on the server, by itself');
      check(!document.querySelector('.gobbonet-ext[data-mod-id="' + PROBE + '"]') &&
        getComputedStyle(document.documentElement).getPropertyValue('--zz-check-fail').trim() === '', 'and its files left the page');
      const n = document.getElementById('mod-notice');
      check(!!n && !n.hidden && n.getAttribute('role') === 'alert' && /Console check fail” was switched off/.test(n.textContent) &&
        [...n.querySelectorAll('button')].map(b => b.textContent).join(',') === 'OPEN MODS,SWITCH BACK ON,DISMISS',
        'a notice says which mod and why, with OPEN MODS, SWITCH BACK ON and DISMISS');
    } else {
      info('not the PC: the auto-off check needs to make a mod, so it runs on the PC only.');
    }

    if (typeof modsSafeMode === 'function') {
      check(modsSafeMode() === false || location.search.includes('nomods'), 'mods are loading normally on this page (add ?nomods to the address to load none)');
    }
  } catch (e) {
    log('FAIL', 'F6', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    if (canManage) { try { await api('/mods/' + PROBE, 'DELETE'); } catch (_) {} }
    const n = document.getElementById('mod-notice');
    if (n && /Console check fail/.test(n.textContent)) n.hidden = true;
    try { if (adultBefore === null) localStorage.removeItem(ADULT); else localStorage.setItem(ADULT, adultBefore); } catch (_) {}
    _endorsed.data = dataBefore;
    _endorsed.adultThisPage = adultPageBefore;
    if (dataBefore) renderEndorsedList();
    else { const box = document.getElementById('endorsed-list'); if (box) box.textContent = ''; }
    try { await applyMods(); } catch (_) {}
  }
  const left = (await api('/mods')).body.mods || [];
  let adultNow = null;
  try { adultNow = localStorage.getItem(ADULT); } catch (_) {}
  check(!left.some(m => m.id === PROBE) && adultNow === adultBefore, 'everything the check made is gone, and the 18+ choice is as it was');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 14: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
