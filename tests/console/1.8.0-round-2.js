/* GobboNet 1.8.0, round 2 -- console check for the swap name check
 * (roadmap #4).
 *
 * Paste into the browser console with GobboNet open and signed in. On the PC
 * or a phone, a few seconds. It changes nothing: every name it sends to
 * /swap-model is one the server must refuse before touching the engine, and
 * it checks at the end that the loaded model is the one you had.
 *
 * Round 2's other item (#62, the issue and PR templates) lives on GitHub:
 * once it is pushed, New issue on the repository offers the Bug report and
 * Feature request forms and the private security link.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 2] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 2: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const getJSON = async url => (await fetch(url, { cache: 'no-store' })).json();
  const swap = async file => {
    const r = await fetch('/swap-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    let body = {};
    try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };
  // The server's rule (internal/models/name.go), so the model menu can be held to it.
  const plainName = n => typeof n === 'string' && n.length > 5 && n.length <= 255 &&
    !/[\/\\:\x00-\x1f\x7f]/.test(n) && /\.gguf$/i.test(n);

  let list, before;
  try {
    list = await getJSON('/models-list.json');
    before = await getJSON('/swap-status');
  } catch (e) {
    log('FAIL', 'could not read /models-list.json or /swap-status: ' + (e && e.message) + ' -- signed in?');
    return done();
  }
  if (list.mode === 'remote') {
    log('INFO', 'remote mode (llm_url points at a server GobboNet does not run): there is no model swap here, so nothing to check.');
    return done();
  }
  log('INFO', `loaded model: ${before.file || '(none)'}, phase ${before.phase}`);

  // 1. Nothing you can pick is refused.
  const files = (list.models || []).map(m => m.file);
  const odd = files.filter(f => !plainName(f));
  check(odd.length === 0, `all ${files.length} model(s) in the model menu have plain .gguf names, so none is refused` +
    (odd.length ? ` -- these are not: ${odd.join(', ')}` : ''));

  // 2. Names that leave the models folder, or are not models, are refused
  //    before anything starts.
  const messages = [];
  for (const name of ['../zz-outside.gguf', '..\\zz-outside.gguf', 'zz-sub/../../zz-outside.gguf', '/etc/zz.gguf',
    'C:\\zz\\x.gguf', 'zz.gguf:stream', 'zz-notes.txt', '.gguf']) {
    const r = await swap(name);
    messages.push(r.body.message || '');
    check(r.status === 400 && r.body.phase === 'error' && /^not a model file name/.test(r.body.message || ''),
      `"${name}" is refused with 400 (got ${r.status}: ${(r.body.message || '').slice(0, 60)})`);
  }

  // 3. A plain name that is not there says so, without saying where.
  const miss = await swap('zz-round2-missing.gguf');
  messages.push(miss.body.message || '');
  check(miss.status === 400 && miss.body.message === 'model "zz-round2-missing.gguf" not found in the models folder',
    `a missing model is refused as "not found in the models folder" (got ${miss.status}: ${miss.body.message})`);
  check(messages.every(m => !/[\/\\]/.test(m.replace(/^not a model file name: .*$/, ''))),
    'no answer names a folder path on the PC');

  // 4. Nothing changed.
  const after = await getJSON('/swap-status');
  check(after.phase === before.phase && (after.file || '') === (before.file || ''),
    `the loaded model and the swap phase are as they were (${after.file || '(none)'}, ${after.phase})`);

  log('INFO', 'by hand: pick another model in the model menu. It should still load as before.');
  return done();
})();
