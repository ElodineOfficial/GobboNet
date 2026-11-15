/* GobboNet 1.8.1 -- console check for two Linux fixes. Run it on BOTH pages:
 *
 * 1. The SETUP page (`gobbonet setup`; ZIP: ./gobbonet setup; AppImage:
 *    ./GobboNet-*-x86_64.AppImage setup). Its Install location step used to
 *    say "The Debian package manages program files in /usr/lib/gobbonet" on
 *    the AppImage and the ZIP too. It checks the step names THIS install:
 *    inside the AppImage file, the folder the ZIP was unpacked into, or a
 *    package's own sentence. Reads only.
 *
 * 2. The CHAT page, with GobboNet started from its launcher (the menu entry,
 *    ./gobbonet, or the AppImage) after installing this update. On Fedora 45
 *    and later the AppImage's and ZIP's engine did not start: it needs OpenSSL
 *    3, which those ship only as openssl3-libs. They now bring their own and
 *    use it only when the system has none. It checks which one the engine uses
 *    and that the engine is not failing on libssl.so.3. Reads only.
 *
 * Paste into the browser console (F12, Console) on either page.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [linux] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = (what) => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.1 linux (${what}): ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const get = async (path) => {
    const r = await fetch(path, { cache: 'no-store' });
    let body = {};
    try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };

  // ---- the setup page --------------------------------------------------------------
  if (document.getElementById('web-port') && document.getElementById('location')) {
    log('INFO', '--- The setup page: the Install location step ---');
    const st = (await get('/api/state')).body;
    const p = document.querySelector('#location p');
    const text = p ? p.textContent : '';
    log('INFO', `the step says: "${text.split('. Choose')[0]}."`);
    if (!('install_kind' in st)) {
      log('FAIL', 'this setup is older than the fix (its /api/state has no install_kind). Install the update (it replaces gobbonet-setup.py), then run setup again.');
      return done('setup page');
    }
    const kind = st.install_kind, where = String(st.program_files || '');
    log('INFO', `setup says this is ${{ appimage: 'the AppImage', zip: 'an unpacked ZIP', package: 'a package (.deb or .rpm)' }[kind] || kind}, with its program files in ${where}. If that is not how you installed GobboNet, report it.`);
    if (kind === 'appimage') {
      check(text.includes(`inside the AppImage, ${where}`) && !/Debian/.test(text), 'the step names the AppImage file, and no Debian package');
    } else if (kind === 'zip') {
      check(text.includes(`the folder you unpacked, ${where}`) && !/Debian/.test(text), 'the step names the unpacked folder, and no Debian package');
    } else if (kind === 'package') {
      const fedora = /lib64/.test(where);
      check(fedora ? text.includes(`The Fedora package manages program files in ${where}`) : text.includes('The Debian package manages program files in /usr/lib/gobbonet'),
        `the step keeps the ${fedora ? 'Fedora' : 'Debian'} package's own sentence, which is right for it`);
    } else {
      log('FAIL', `unknown install_kind "${kind}"`);
    }
    log('INFO', 'By eye: press Set up GobboNet; the Install location step should open with the sentence above.');
    return done('setup page');
  }

  // ---- the chat page ---------------------------------------------------------------
  if (typeof GOBBONET_UI_VERSION !== 'string') {
    log('FAIL', 'this is neither GobboNet\'s chat page nor its setup page.');
    return done('?');
  }
  log('INFO', '--- The chat page: whose OpenSSL 3 the engine uses ---');
  let server = '';
  try { server = String((await get('/health-fileserver')).body.version || ''); } catch (_) {}
  log('INFO', `page ${GOBBONET_UI_VERSION}, server ${server || '(no answer)'}`);
  const fixed = typeof updateGpuNote === 'function' && /engine_openssl/.test(String(updateGpuNote));
  if (!fixed) {
    log('FAIL', 'this page is 1.8.0 without the OpenSSL fix. Replace the program file with the one from the zip, restart GobboNet from its launcher, and reload.');
    return done('chat page');
  }
  const gpu = await get('/gpu');
  const v = gpu.body || {};
  if (gpu.status !== 200) { log('FAIL', `/gpu answered ${gpu.status}`); return done('chat page'); }
  if (v.remote) { log('INFO', 'remote mode: no engine runs on this PC, so there is nothing to check here.'); return done('chat page'); }
  if (!v.linux) { log('INFO', 'not Linux: the OpenSSL fix is for the Linux AppImage and ZIP. Nothing to check.'); return done('chat page'); }

  check(!/libssl|libcrypto/.test(String(v.engine_build_reason || '')),
    `the launcher's engine choice: ${v.engine_build || '(none recorded)'}${v.engine_build_reason ? ' -- ' + v.engine_build_reason : ''}`);
  if (v.engine_openssl === 'bundled') {
    check(true, 'this system has no OpenSSL 3, and the engine uses the copy that came with GobboNet (openssl3/)');
    log('INFO', 'Installing your distribution\'s OpenSSL 3 (sudo dnf install openssl3-libs on Fedora) makes it use that instead, at the next start.');
  } else if (v.engine_openssl === 'system') {
    check(true, 'the engine uses this system\'s OpenSSL 3; GobboNet\'s own copy is not loaded');
  } else {
    log('FAIL', 'no record of which OpenSSL the engine uses. Start GobboNet from its launcher (the menu entry, ./gobbonet or the AppImage), not `gobbonet serve`, then reload and run this again. A .deb or .rpm records it from its 1.8.0 package with this fix.');
  }
  check(Array.isArray(v.devices) && !v.probe_error, v.probe_error
    ? `the engine could not list its devices: ${v.probe_error}`
    : `the engine starts and lists ${v.devices.length} device(s)${v.devices.length ? ': ' + v.devices.map(d => d.name).join(', ') : ''}`);
  const sw = (await get('/swap-status')).body || {};
  check(!/libssl|libcrypto/.test(String(sw.message || '')),
    sw.phase === 'error' ? `the last model load failed, but not on OpenSSL: ${sw.message}` : `the engine: ${sw.phase || '?'}${sw.file ? ', ' + sw.file : ''}`);

  // CONFIG > Performance says the same thing in words.
  if (typeof loadGpuChoice === 'function') {
    try { await loadGpuChoice(); } catch (_) {}
    const note = (document.getElementById('perf-device-note') || {}).textContent || '';
    if (v.engine_openssl === 'bundled') check(/comes with GobboNet/.test(note), 'CONFIG > Performance says the engine uses GobboNet\'s OpenSSL 3');
    else check(!/OpenSSL/.test(note), 'CONFIG > Performance says nothing about OpenSSL, as it should with the system\'s');
  }
  log('INFO', 'By eye: `gobbonet doctor` (ZIP: ./gobbonet doctor) says "openssl: GobboNet\'s own OpenSSL 3" only on a system without one.');
  return done('chat page');
})();
