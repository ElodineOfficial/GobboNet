/* GobboNet 1.7.9 -- console check for patch step 13 (F1, mods).
 *
 * Paste into the browser console on the PC running GobboNet (open it at
 * http://localhost:9066), signed in, with no panel open. About 5 seconds.
 *
 * On the PC it makes two throwaway mods (zz-check-a, zz-check-b), checks they
 * load in order, that moving one changes the order, and that switching one
 * off leaves the other; it checks the old-extensions migration with a
 * throwaway blob (sent switched OFF, so its code never runs); then it removes
 * everything it made. Your own mods and extensions are not touched.
 * On another device it only reads, and says what it could not check there.
 * Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', 'F1', msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const api = async (path, method, body) => {
    const r = await fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  if (typeof applyMods !== 'function' || typeof loadMods !== 'function') {
    log('FAIL', 'F1', 'this page has no mods (applyMods() is missing) -- is it the 1.7.9 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (document.querySelector('.modal-backdrop.open') || (typeof tourActive === 'function' && tourActive())) {
    log('INFO', 'F1', 'close the open panel (or answer the tour) first, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  const PROBES = ['zz-check-a', 'zz-check-b'];
  const legacyBefore = JSON.stringify(state.extensions);
  let migratedId = null;
  let canManage = false;
  try {
    const list = await api('/mods');
    check(list.status === 200 && Array.isArray(list.body.mods), `the server lists mods (${(list.body.mods || []).length} installed)`);
    canManage = !!list.body.canManage;
    (list.body.mods || []).forEach(m => log('INFO', 'F1', `${m.enabled ? 'ON ' : 'off'} ${m.name}${m.version ? ' v' + m.version : ''}${m.error ? ' -- cannot load: ' + m.error : ''}`));
    check(!JSON.stringify(redactedStateMeta().extensions).includes('raw') || redactedStateMeta().extensions.styles.length === 0,
      'what this device sends to /state carries no code');
    const tmp = state.extensions;
    state.extensions = { enabled: true, styles: [{ id: 'x', name: '', url: '', raw: 'p{}' }], scripts: [] };
    const sent = redactedStateMeta().extensions;
    state.extensions = tmp;
    check(sent.enabled === false && sent.styles.length === 0 && sent.scripts.length === 0, 'even when this device still holds old extensions');

    if (!canManage) {
      log('INFO', 'F1', 'this is not the PC GobboNet runs on, so mods can only be switched off from here; open it at http://localhost on that PC to run the rest of this check.');
      const refused = await api('/mods/zz-check-a/source', 'PUT', { name: 'x', styles: [{ raw: 'p{}' }], scripts: [] });
      check(refused.status === 403, 'and the server refuses to take mod code from this device (403)');
    } else {
      // ── Two mods, in order ────────────────────────────────────────────
      for (const id of PROBES) {
        const tag = id.slice(-1);
        const r = await api('/mods/' + id + '/source', 'PUT', {
          name: 'Console check ' + tag.toUpperCase(),
          styles: [{ name: 'css', raw: ':root{--zz-check-' + tag + ':1}' }],
          scripts: [{ name: 'js', raw: 'window.__zzCheck=(window.__zzCheck||[]).concat("' + tag + '");' }],
          enabled: true,
        });
        check(r.status === 200, `made the throwaway mod ${id}`);
      }
      window.__zzCheck = [];
      await applyMods();
      await wait(600);
      const order = () => [...document.querySelectorAll('.gobbonet-ext[data-mod-id^="zz-check-"]')].map(e => e.getAttribute('data-mod-id') + ':' + e.tagName.toLowerCase());
      check(JSON.stringify(order()) === JSON.stringify(['zz-check-a:link', 'zz-check-a:script', 'zz-check-b:link', 'zz-check-b:script']),
        'both load, a before b, each stylesheet then script: ' + order().join(', '));
      check(JSON.stringify(window.__zzCheck) === '["a","b"]', 'their scripts ran once each, in that order (' + JSON.stringify(window.__zzCheck) + ')');
      const cs = getComputedStyle(document.documentElement);
      check(cs.getPropertyValue('--zz-check-a').trim() === '1' && cs.getPropertyValue('--zz-check-b').trim() === '1', 'both stylesheets apply');

      await api('/mods/zz-check-b/move', 'POST', { delta: -1 });
      const after = (await api('/mods')).body.mods.map(m => m.id).filter(id => PROBES.includes(id));
      check(JSON.stringify(after) === '["zz-check-b","zz-check-a"]', 'moving b up puts it before a in the load order');

      await api('/mods/zz-check-a/enable', 'POST', { enabled: false });
      await applyMods();
      await wait(200);
      const cs2 = getComputedStyle(document.documentElement);
      check(cs2.getPropertyValue('--zz-check-a').trim() === '' && cs2.getPropertyValue('--zz-check-b').trim() === '1',
        'switching a off removes its stylesheet and leaves b’s');
      check(JSON.stringify(window.__zzCheck) === '["a","b"]', 'and b’s script did not run again');

      const rm = await api('/mods/zz-check-b', 'DELETE');
      const gone = !(await api('/mods')).body.mods.some(m => m.id === 'zz-check-b');
      const back = (await api('/mods/zz-check-b/restore', 'POST')).status === 200 && (await api('/mods')).body.mods.some(m => m.id === 'zz-check-b');
      check(rm.status === 200 && gone && back, 'Remove sets a mod aside and UNDO puts it back');

      // ── The old extensions become a mod ─────────────────────────────
      const probe = { enabled: false, styles: [{ name: 'zz-check legacy', url: '', raw: '/* zz-check ' + Date.now() + ' */' }], scripts: [] };
      const mig = await api('/mods/import-legacy', 'POST', probe);
      migratedId = mig.body.id || null;
      const landed = (await api('/mods')).body.mods.find(m => m.id === migratedId);
      check(mig.status === 200 && mig.body.created && landed && /^My extensions/.test(landed.name) && landed.enabled === false,
        `an old extensions blob becomes "${landed ? landed.name : '?'}", switched as it was (off here)`);
      const again = await api('/mods/import-legacy', 'POST', probe);
      check(again.body.created === false && again.body.id === migratedId, 'and sending it again changes nothing');
    }
  } catch (e) {
    log('FAIL', 'F1', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    if (canManage) {
      for (const id of PROBES.concat(migratedId ? [migratedId] : [])) { try { await api('/mods/' + id, 'DELETE'); } catch (_) {} }
    }
    try { state.extensions = JSON.parse(legacyBefore); } catch (_) {}
    try { delete window.__zzCheck; } catch (_) {}
    try { await applyMods(); } catch (_) {}
  }
  const left = (await api('/mods')).body.mods || [];
  check(!left.some(m => PROBES.includes(m.id) || (migratedId && m.id === migratedId)) && JSON.stringify(state.extensions) === legacyBefore,
    'everything the check made is gone, and your own mods and extensions are as they were');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 13: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
