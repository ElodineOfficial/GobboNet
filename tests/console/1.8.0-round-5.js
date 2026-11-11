/* GobboNet 1.8.0, round 5 -- console check for why a model failed to load
 * and CHECK FILE (roadmap #11, issue #67), and the GPU menu (roadmap #12,
 * issue #72).
 *
 * Paste into the browser console with GobboNet open and signed in. A few
 * seconds. It changes nothing: every request it sends that could change
 * something is one the server must refuse, and it reads the rest. It does not
 * run CHECK FILE on a real model (that reads the whole file); the end of the
 * output says how to try that, and the GPU menu, by hand.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 5] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 5: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
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
  const fn = name => typeof window[name] === 'function';

  if (!fn('attachLoadFailure') || !fn('loadGpuChoice') || !fn('startCatalogCheck')) {
    log('FAIL', 'this page is older than round 5 (no attachLoadFailure / loadGpuChoice / startCatalogCheck). Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- #11 why a load failed --------------------------------------------
  log('INFO', '--- Why a model failed to load ---');
  const st = (await call('/swap-status')).body;
  log('INFO', `the engine: phase ${st.phase}, model ${st.file || '(none)'}`);
  if (st.phase === 'error') {
    check(typeof st.message === 'string' && st.message.length > 0, '/swap-status carries the engine\'s own line');
    if (st.cause) {
      check(typeof st.advice === 'string' && st.advice.length > 20 && st.log === 'llama-server.log',
        `the last load failed with a known cause (${st.cause}): "${st.advice}"`);
    } else {
      log('INFO', 'the last load failed with no known cause; the line itself is shown: ' + st.message);
    }
    check(!/exiting due to model loading error/i.test(st.message) || !st.cause, 'llama.cpp\'s sign-off is not the reason given when a real one was said');
  } else {
    check(!st.cause && !st.advice, 'no failure: no cause or advice on /swap-status');
  }
  {
    const text = loadFailureText({ cause: 'out_of_memory', file: 'big.gguf', advice: 'Not enough GPU or system memory for this model.', line: 'alloc_tensor_range: failed to allocate `x` buffer' });
    check(text.startsWith('**The model did not load.** (`big.gguf`) Not enough GPU') && text.includes("`alloc_tensor_range: failed to allocate 'x' buffer`") &&
      text.includes('llama-server.log'), 'the chat\'s wording: the sentence, the engine\'s line as text, and where the log is');
  }
  {
    const saved = [serverConnected, serverOfflinePhase, serverOfflineReason, serverOfflineAdvice];
    try {
      serverConnected = false; serverOfflinePhase = 'error'; serverOfflineReason = '<b>raw</b> line'; serverOfflineAdvice = 'Plain words.';
      const pill = offlineStatusHtml(), det = offlineDetailsHtml();
      check(pill.includes('OFFLINE — Plain words.') && det.includes('&lt;b&gt;raw&lt;/b&gt; line') && !det.includes('<b>'),
        'the landing page: the sentence on the pill, the line under details, escaped (tried in memory)');
    } finally {
      [serverConnected, serverOfflinePhase, serverOfflineReason, serverOfflineAdvice] = saved;
    }
  }

  // ---- #11 CHECK FILE -----------------------------------------------------
  log('INFO', '--- CHECK FILE ---');
  const chk = await call('/model-check');
  check(chk.status === 200 && ['idle', 'running', 'done', 'error'].includes(chk.body.state), `/model-check answers (${chk.body.state})`);
  const bad1 = await call('/model-check', { file: '../x.gguf' });
  check(bad1.status === 400, 'a file name instead of a catalogue index is refused (400)');
  const bad2 = await call('/model-check', { index: -1 });
  check(bad2.status === 404 || bad2.status === 409, `an index that is not in the catalogue is refused (${bad2.status})`);
  const bad3 = await call('/model-check', { index: 1, source: 'elsewhere' });
  check(bad3.status === 400, 'only "catalogue" and "huggingface" are references');

  // ---- #12 which GPU -----------------------------------------------------
  log('INFO', '--- Which GPU ---');
  const g = await call('/gpu');
  check(g.status === 200, '/gpu answers');
  const v = g.body;
  if (v.remote) {
    log('INFO', 'remote mode: no engine runs here, so there is no GPU to choose, and the menu is hidden');
    check(!!document.getElementById('perf-device-group'), 'the GPU menu is in the page (hidden here)');
    return done();
  }
  check(Array.isArray(v.devices), `the engine lists ${v.devices.length} GPU(s)` + (v.probe_error ? ' -- it could not list them: ' + v.probe_error : ''));
  for (const d of v.devices) log('INFO', `  ${d.id}: ${d.name}, ${d.total_mib} MiB, ${d.integrated ? 'integrated' : 'dedicated'}`);
  log('INFO', `gpu_device in config.toml: ${v.gpu_device}; the next start uses: ${v.in_use || 'automatic'}` + (v.warning ? ' -- ' + v.warning : ''));
  if (v.linux) log('INFO', `PRIME offload: ${v.gpu_prime_offload ? 'on' : 'off'}${v.prime_offered ? ' (offered: the engine sees only an integrated GPU)' : ''}`);
  if (v.engine_build) log('INFO', `engine build: ${v.engine_build}${v.engine_build_reason ? ' -- ' + v.engine_build_reason : ''}`);
  const injected = await call('/gpu', { gpu_device: 'Vulkan0; rm -rf ~' });
  check(injected.status === 400, 'a device name with a shell command in it is refused (400), and nothing is saved');
  const stale = await call('/gpu', { gpu_device: 'CUDA99' });
  check(stale.status === 400 && /not among this engine's devices|could not be checked/.test(stale.body.error || ''),
    'a device the engine does not have is refused, by name');
  const after = (await call('/gpu')).body;
  check(after.gpu_device === v.gpu_device && after.gpu_prime_offload === v.gpu_prime_offload, 'the saved choice is unchanged');
  if (typeof loadGpuChoice === 'function' && document.getElementById('perf-device')) {
    await loadGpuChoice();
    const opts = [...document.getElementById('perf-device').options].map(o => o.value);
    check(opts[0] === 'auto' && opts[opts.length - 1] === 'none' && v.devices.every(d => opts.includes(d.id)),
      'CONFIG > Performance > GPU lists Automatic, each device, and None');
  }

  log('INFO', 'By hand: Add a Model > an installed model > CHECK FILE (reads the whole file; nothing is sent). A model with no pinned checksum offers "Ask HuggingFace", which sends one request to huggingface.co.');
  log('INFO', 'By hand: CONFIG > Model & Performance > Performance > GPU, pick a card, SAVE & RESTART MODEL; then run gobbonet doctor on the PC and read its GPU and LAST MODEL LOAD sections.');
  return done();
})();
