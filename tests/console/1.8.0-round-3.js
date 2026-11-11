/* GobboNet 1.8.0, round 3 -- console check for open_browser (roadmap #7,
 * PR #58) and the separate data and models folders (roadmap #8, issue #68).
 *
 * Paste into the browser console with GobboNet open and signed in, on the PC
 * and then on a phone. A few seconds. What it touches:
 *
 *   - open_browser is flipped and put straight back (two writes to
 *     config.toml; its comments are kept). It ends as it started, and says so.
 *   - Model Folders is saved unchanged (nothing is written) and sent folders
 *     the server must refuse (nothing is written). Your folders stay as they are.
 *
 * Not reachable from here: the Linux setup's two-folder Install location step
 * (run `gobbonet setup --force` on Linux to see it), `config get --json`, and
 * the uninstall change. Those are covered by tests/test-setup-folders.py,
 * tests/test-linux-installer.py and cmd/gobbonet/uninstall_test.go.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 3] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 3: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const call = async (path, body) => {
    const opts = body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
    const r = await fetch(path, opts);
    let json = {};
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const $ = id => document.getElementById(id);

  // ---- #7 open_browser -------------------------------------------------
  log('INFO', '--- When GobboNet Starts (open_browser) ---');
  let first;
  try { first = await call('/launch-settings'); } catch (e) {
    log('FAIL', 'could not reach /launch-settings: ' + (e && e.message) + ' -- signed in?');
    return done();
  }
  if (first.status === 404) {
    log('FAIL', '/launch-settings is not there: this gobbonet program file is older than round 3. Replace it with the one from the zip.');
    return done();
  }
  check(first.status === 200 && typeof first.body.open_browser === 'boolean',
    `/launch-settings answers open_browser = ${first.body.open_browser}`);
  const was = first.body.open_browser;
  const box = $('set-open-browser');
  check(!!box && !!$('open-browser-group') && !!$('tip-open-browser'), 'CONFIG > Basics has the When GobboNet Starts box, with its "?"');
  if (box && typeof loadOpenBrowserPanel === 'function') {
    await loadOpenBrowserPanel();
    check(box.checked === was && !box.disabled, `the box shows what config.toml says (${was ? 'ticked' : 'unticked'})`);
  }
  if (typeof was === 'boolean') {
    const flip = await call('/launch-settings', { open_browser: !was });
    const seen = await call('/launch-settings');
    check(flip.status === 200 && flip.body.open_browser === !was && seen.body.open_browser === !was,
      `saving ${!was} from this device is written and read back (any signed-in device may)`);
    const back = await call('/launch-settings', { open_browser: was });
    const after = await call('/launch-settings');
    check(back.status === 200 && after.body.open_browser === was, `and put back to ${was}: nothing left changed`);
    if (after.body.open_browser !== was) log('INFO', `open_browser is now ${after.body.open_browser}; set it back in CONFIG > Basics.`);
    if (box && typeof loadOpenBrowserPanel === 'function') await loadOpenBrowserPanel();
  }
  const bad = await call('/launch-settings', {});
  check(bad.status === 400, 'a save without open_browser is refused (400)');

  // ---- #8 model folders --------------------------------------------------
  log('INFO', '--- Model Folders (model_dir, model_dirs, scan_hf_cache) ---');
  const mf = await call('/model-folders');
  if (mf.status === 404) {
    log('FAIL', '/model-folders is not there: this gobbonet program file is older than round 3.');
    return done();
  }
  check(mf.status === 200, '/model-folders answers');
  check(!!$('model-folders-group') && !!$('set-model-dir') && !!$('set-model-dirs') && !!$('set-scan-hf-cache') && !!$('model-folders-save'),
    'CONFIG > Model & Performance has the Model Folders box');
  if (typeof loadModelFoldersPanel === 'function') await loadModelFoldersPanel();
  const fields = $('model-folders-fields');

  if (!mf.body.editable) {
    // A phone, another computer, or a server with no config file.
    const text = JSON.stringify(mf.body);
    check(!('model_dir' in mf.body) && (mf.body.model_dirs || []).length === 0, 'this device is sent no folder paths');
    log('INFO', 'reason given: ' + (mf.body.reason || '(none)'));
    check(/only be changed from the PC|without a config file/.test(mf.body.reason || ''), 'it is told where they can be changed');
    check(!!fields && fields.style.display === 'none' && /PC|config/.test(($('model-folders-status') || {}).textContent || ''),
      'the box hides its fields and says why');
    const refused = await call('/model-folders', { scan_hf_cache: !!mf.body.scan_hf_cache });
    check(refused.status === 403, `a save from this device is refused (403, got ${refused.status})`);
    log('INFO', 'Run this again in a browser on the PC GobboNet runs on, to check the editable side.');
    return done();
  }

  const v = mf.body;
  log('INFO', `models folder: ${v.model_dir}; extra folders: ${v.model_dirs.length ? v.model_dirs.join(' | ') : '(none)'}; HuggingFace cache: ${v.scan_hf_cache}`);
  check(typeof v.model_dir === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(v.model_dir), 'model_dir is a full path');
  check(Array.isArray(v.model_dirs) && typeof v.scan_hf_cache === 'boolean', 'model_dirs is a list, scan_hf_cache a true/false');
  if (v.restart_needed) log('INFO', 'config.toml has changes this server has not started with yet (restart_needed).');
  if (v.env_override) log('INFO', `${v.env_override} is set where GobboNet started, and wins over model_dir.`);
  check(!!fields && fields.style.display !== 'none' && $('set-model-dir').value === v.model_dir &&
    $('set-model-dirs').value === v.model_dirs.join('\n') && $('set-scan-hf-cache').checked === v.scan_hf_cache,
    'the box shows what config.toml says');

  const same = await call('/model-folders', { model_dir: v.model_dir, model_dirs: v.model_dirs, scan_hf_cache: v.scan_hf_cache });
  check(same.status === 200 && !same.body.saved, 'saving the same folders writes nothing (no "saved" in the answer)');
  const r1 = await call('/model-folders', { model_dir: 'models' });
  check(r1.status === 400 && /full path/.test(r1.body.error || ''), `a relative models folder is refused: "${r1.body.error || r1.status}"`);
  const r2 = await call('/model-folders', { model_dirs: ['relative/folder'], scan_hf_cache: !v.scan_hf_cache });
  check(r2.status === 400, 'a relative extra folder is refused, and the HuggingFace change beside it is not saved either');
  const r3 = await call('/model-folders', 'not json');
  check(r3.status === 400, 'a body that is not JSON is refused');
  const end = await call('/model-folders');
  check(end.body.model_dir === v.model_dir && JSON.stringify(end.body.model_dirs) === JSON.stringify(v.model_dirs) &&
    end.body.scan_hf_cache === v.scan_hf_cache, 'config.toml still says what it said at the start');

  // What the folders feed: the model menu and Found on this computer.
  try {
    const list = await (await fetch('/models-list.json', { cache: 'no-store' })).json();
    if (list.mode !== 'remote') log('INFO', `the model menu lists ${(list.models || []).length} model(s) from the models folder`);
    const local = await (await fetch('/local-models.json', { cache: 'no-store' })).json();
    if (!v.restart_needed) {
      const roots = (local.roots || []).filter(r => r.source === 'model_dirs').length;
      check(roots === v.model_dirs.length, `Found on this computer looks in the ${v.model_dirs.length} extra folder(s) (${roots} root(s))`);
      check(local.modelDir === v.model_dir, 'and links into the same models folder');
    }
  } catch (e) {
    log('INFO', 'could not read the model menu or Found on this computer: ' + (e && e.message));
  }
  return done();
})();
