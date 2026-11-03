/* GobboNet 1.7.9 -- console check for patch step 12 (F2 + issue #12):
 * the catalogue's tiers and UNVERIFIED second click, and "Found on this
 * computer".
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console), with no panel open. It opens Add a Model, looks, and
 * closes it. It never downloads and never links anything: it checks that the
 * server REFUSES an unverified download without the second yes, and only does
 * that when nothing is downloading. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (cond, step, msg) => log(cond ? 'PASS' : 'FAIL', step, msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const json = async (url, opts) => { const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {})); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  if (typeof loadLocalModels !== 'function' || typeof catalogTier !== 'function') {
    log('FAIL', 'F2', 'this page has no catalogue tiers or "Found on this computer" -- is it the 1.7.9 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (document.querySelector('.modal-backdrop.open') || (typeof tourActive === 'function' && tourActive())) {
    log('INFO', 'F2', 'close the open panel (or answer the tour) first, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }
  const filterBefore = JSON.stringify(_catalogFilter);

  try {
    // ── The catalogue ───────────────────────────────────────────────────
    const cat = await json('/catalog.json');
    check(cat.status === 200 && Array.isArray(cat.body.models), 'F2', `the catalogue answers (${(cat.body.models || []).length} models, from the ${cat.body.source || '?'} list)`);
    const models = cat.body.models || [];
    check(models.length > 0 && models.every(m => ['small', 'mid', 'large', 'moe'].includes(m.tier) && typeof m.verified === 'boolean'),
      'F2', 'every entry says its tier and whether its checksum is pinned');
    if (cat.body.source === 'bundled') {
      check(models.length === 16, 'F2', `the list that ships with 1.7.9 has 16 models (${models.length})`);
    } else {
      log('INFO', 'F2', `this is the ${cat.body.source} list from goblincorps.com; until the 1.7.9 list is uploaded there it has ${models.length} models, not 16`);
    }
    const pinned = models.filter(m => m.verified).map(m => m.display);
    log('INFO', 'F2', `pinned: ${pinned.length ? pinned.join(', ') : 'none yet'}; unverified: ${models.length - pinned.length}`);

    openModelCatalog();
    for (let i = 0; i < 50 && !document.querySelector('#model-catalog-list .catalog-entry'); i++) await wait(100);
    await wait(300);
    const heads = [...document.querySelectorAll('#model-catalog-list .catalog-tier > span:first-child')].map(e => e.textContent);
    const ORDER = ['LIGHT', 'MEDIUM', 'HEAVY', 'MIXTURE OF EXPERTS'];
    check(heads.length > 0 && heads.every((h, i) => ORDER.indexOf(h) >= 0 && (i === 0 || ORDER.indexOf(h) > ORDER.indexOf(heads[i - 1]))),
      'F2', 'the list is grouped under tier headings, in order: ' + heads.join(' / '));
    const rows = [...document.querySelectorAll('#model-catalog-list .catalog-entry')];
    check(rows.length === models.length, 'F2', `every model has a row (${rows.length})`);

    const rowOf = name => rows.find(r => r.querySelector('.catalog-entry-name').textContent === name);
    const un = models.find(m => !m.verified && !m.installed);
    const pin = models.find(m => m.verified && !m.installed);
    if (pin) {
      check(!rowOf(pin.display).querySelector('.catalog-entry-note'), 'F2', `a pinned entry (${pin.display}) carries no warning`);
    }
    if (un) {
      const r = rowOf(un.display);
      check(/Unverified/.test((r.querySelector('.catalog-entry-note') || {}).textContent || ''), 'F2', `an unpinned entry (${un.display}) says Unverified`);
      // First click: arms, sends nothing.
      const realFetch = window.fetch;
      let posts = 0;
      window.fetch = function (url, opts) { if (String(url).startsWith('/model-download') && opts && opts.method === 'POST') posts++; return realFetch.apply(this, arguments); };
      try {
        r.querySelector('button').click();
        await wait(150);
      } finally { window.fetch = realFetch; }
      // The list re-renders on that click, so look it up again rather than
      // reading the row that was replaced.
      const armed = [...document.querySelectorAll('#model-catalog-list .catalog-entry')].find(x => x.querySelector('.catalog-entry-name').textContent === un.display);
      check(posts === 0 && /CLICK AGAIN/.test(armed.querySelector('button').textContent), 'F2', 'its first click asks for a second one and sends nothing');
      _catalogArmed = null; renderCatalogList();   // disarm: this check never clicks twice

      // The server enforces it too.
      const dl = await json('/model-download');
      if (dl.body.state === 'running') {
        log('INFO', 'F2', 'a download is running, so the server-side refusal was not tried');
      } else {
        const res = await json('/model-download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: un.index }) });
        check(res.status === 409 && res.body.needsConfirm === true, 'F2', 'the server refuses an unverified download without the second yes (409)');
        const after = await json('/model-download');
        check(after.body.state !== 'running', 'F2', 'and nothing started');
      }
    } else {
      log('INFO', 'F2', 'every entry is pinned, so there is no second click to check');
    }

    setCatalogFilter('size', 'moe');
    const moeRows = [...document.querySelectorAll('#model-catalog-list .catalog-entry .catalog-entry-name')].map(e => e.textContent);
    const moeWant = models.filter(m => m.tier === 'moe').map(m => m.display);
    check(moeRows.length === moeWant.length && moeRows.every(n => moeWant.includes(n)), 'F2', `MOE shows the Mixture-of-Experts models only (${moeRows.join(', ') || 'none'})`);

    // ── Found on this computer ──────────────────────────────────────────
    const local = await json('/local-models.json');
    check(local.status === 200 && Array.isArray(local.body.roots), 'I12', 'the server reports where it looked');
    (local.body.roots || []).forEach(r => log('INFO', 'I12', `${r.exists ? 'looked in' : 'not there'}: ${r.path} (${r.source})`));
    for (let i = 0; i < 30 && !document.querySelector('#model-catalog-local .catalog-tier'); i++) await wait(100);
    const lh = document.querySelector('#model-catalog-local .catalog-tier');
    check(!!lh && /FOUND ON THIS COMPUTER/.test(lh.textContent), 'I12', 'Add a Model has a FOUND ON THIS COMPUTER section: "' + (lh ? lh.textContent : '') + '"');
    const found = local.body.found || [];
    const lrows = [...document.querySelectorAll('#model-catalog-local .catalog-entry')];
    check(lrows.length === found.length, 'I12', `one row per model found (${found.length})`);
    const want = { new: 'USE IT', linked: 'IN YOUR MODELS', 'name-taken': 'NAME IN USE' };
    check(found.every((f, i) => lrows[i] && lrows[i].querySelector('button').textContent === want[f.state]), 'I12', 'each row’s button matches what the server says about it');
    found.forEach(f => log('INFO', 'I12', `${f.repo ? f.repo + ' · ' : ''}${f.name} (${f.sizeGB.toFixed(1)} GB, ${f.state})`));
    if (!found.length) log('INFO', 'I12', 'nothing found. To try it: put a .gguf in a folder and list it as model_dirs = ["that folder"] in config.toml, or let huggingface-cli download one.');
    else log('INFO', 'I12', 'this check does not press USE IT; press it yourself to link one in (it is a link, not a copy).');
  } catch (e) {
    log('FAIL', 'F2', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    try { _catalogArmed = null; } catch (_) {}
    try { const f = JSON.parse(filterBefore); setCatalogFilter('type', f.type); setCatalogFilter('size', f.size); } catch (_) {}
    try { closeModelCatalog(); } catch (_) {}
  }

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 12: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
