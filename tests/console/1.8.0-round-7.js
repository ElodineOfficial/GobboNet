/* GobboNet 1.8.0, round 7 -- console check for the per-entry switches in
 * My extensions (from Larck Drakengold's commit 4db2469) and the pinned model
 * catalogue.
 *
 * Paste into the browser console with GobboNet open and signed in. A few
 * seconds. On the PC GobboNet runs on, if My extensions has an entry that is
 * on, it switches that one entry off and straight back on, to prove the round
 * trip; everything ends as it started. Everything else only reads.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 7] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 7: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const call = async (path, body, method) => {
    const opts = body === undefined && !method ? { cache: 'no-store' }
      : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) };
    const r = await fetch(path, opts);
    let json = {};
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const fn = name => typeof window[name] === 'function';
  const isInt = n => Number.isInteger(n);

  if (!fn('setExtEntryEnabled')) {
    log('FAIL', 'this page has no setExtEntryEnabled: it is older than round 7. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the catalogue ------------------------------------------------------
  log('INFO', '--- The model catalogue ---');
  const cat = await call('/catalog.json');
  const models = (cat.body && cat.body.models) || [];
  const unverified = models.filter(m => !m.verified).map(m => m.display);
  log('INFO', `the list comes from: ${cat.body && cat.body.source} (${models.length} models)`);
  check(models.length > 0 && unverified.length === 0,
    unverified.length ? `every catalogue model is pinned -- still UNVERIFIED: ${unverified.join(', ')}` : 'every catalogue model is pinned (no UNVERIFIED entries)');
  const borrowed = ((cat.body && cat.body.notes) || []).find(n => /SHA-256 pin for/.test(n));
  if (borrowed) log('INFO', `the served list is older than this release: ${borrowed}. Upload catalog/gobbonet_model_list.json to goblincorps.com and this note goes away.`);

  // ---- My extensions ------------------------------------------------------
  log('INFO', '--- My extensions: a switch per entry ---');
  const list = await call('/mods');
  const canManage = !!(list.body && list.body.canManage);
  const me = ((list.body && list.body.mods) || []).find(m => m.id === 'my-extensions');
  if (!me) {
    log('INFO', 'there is no My extensions yet. Open MODS, add a stylesheet, SAVE, then run this again for the rest.');
  } else {
    const code = (me.files || []).filter(f => f.type === 'css' || f.type === 'js');
    check(code.length > 0 && code.every(f => typeof f.enabled === 'boolean' && isInt(f.entryIndex)),
      `/mods says which entry each of My extensions' ${code.length} file(s) belongs to, and whether it is on`);
    const src = await call('/mods/my-extensions/source');
    const entries = [...((src.body && src.body.styles) || []).map(e => ({ ...e, kind: 'css' })), ...((src.body && src.body.scripts) || []).map(e => ({ ...e, kind: 'js' }))];
    check(entries.length > 0 && entries.every(e => typeof e.enabled === 'boolean' && isInt(e.index)),
      `the editor reads each of the ${entries.length} entries with its switch and the number it is saved under`);

    const bad1 = await call('/mods/my-extensions/entry-enable', { kind: 'css', index: 99999, enabled: false });
    check(bad1.status === 404, `an entry that does not exist is refused (${bad1.status})`);
    const bad2 = await call('/mods/my-extensions/entry-enable', { kind: 'asset', index: 0, enabled: false });
    check(bad2.status === 404, `a kind that is not css or js is refused (${bad2.status})`);
    const bad3 = await call('/mods/my-extensions/entry-enable', undefined, 'GET');
    check(bad3.status === 405, `GET is refused (${bad3.status})`);

    const target = entries.find(e => e.enabled);
    if (!canManage) {
      const on = entries.find(e => !e.enabled);
      if (on) {
        const r = await call('/mods/my-extensions/entry-enable', { kind: on.kind, index: on.index, enabled: true });
        check(r.status === 403, `from this device an entry cannot be switched on (${r.status})`);
      } else {
        log('INFO', 'not the PC GobboNet runs on: switching an entry off works here, on only there. (No off entry to try "on" with.)');
      }
    } else if (!target) {
      log('INFO', 'every entry is off; switch one on in MODS and run this again for the round trip.');
    } else {
      const label = `${target.kind === 'css' ? 'stylesheet' : 'script'} "${target.name || '#' + (target.index + 1)}"`;
      const offR = await call('/mods/my-extensions/entry-enable', { kind: target.kind, index: target.index, enabled: false });
      const afterOff = ((await call('/mods')).body.mods || []).find(m => m.id === 'my-extensions');
      const offFiles = (afterOff.files || []).filter(f => f.type === target.kind && f.entryIndex === target.index);
      const onR = await call('/mods/my-extensions/entry-enable', { kind: target.kind, index: target.index, enabled: true });
      const afterOn = ((await call('/mods')).body.mods || []).find(m => m.id === 'my-extensions');
      const onFiles = (afterOn.files || []).filter(f => f.type === target.kind && f.entryIndex === target.index);
      check(offR.status === 200 && offFiles.length > 0 && offFiles.every(f => f.enabled === false),
        `switching ${label} off marks its file(s) off, and only those`);
      check(onR.status === 200 && onFiles.every(f => f.enabled === true) && afterOn.enabled === me.enabled,
        'and switching it back on restores it; the mod\'s own switch never moved');
      if (typeof applyExtensions === 'function') await applyExtensions();
    }

    // The panel draws one switch per entry.
    if (fn('openExtensions') && fn('closeExtensions')) {
      openExtensions();
      await new Promise(r => setTimeout(r, 600));
      const boxes = document.querySelectorAll('#ext-styles-list .ext-entry-enabled, #ext-scripts-list .ext-entry-enabled').length;
      const cards = document.querySelectorAll('#ext-styles-list .ext-entry, #ext-scripts-list .ext-entry').length;
      check(cards > 0 && boxes === cards, `the MODS panel shows an Enabled switch on each of its ${cards} entries`);
      closeExtensions();
    }
  }

  log('INFO', '--- By hand ---');
  log('INFO', '1. MODS > My extensions: untick Enabled on one stylesheet. It goes at once, the others stay, and SAVE is not needed.');
  log('INFO', '2. From a phone: an entry that is on can be switched off; one that is off cannot be switched on.');
  log('INFO', '3. Add a new entry and untick it before saving: it says the switch is kept when you press SAVE.');
  return done();
})();
