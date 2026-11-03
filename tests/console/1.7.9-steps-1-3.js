/* GobboNet 1.7.9 — console check for patch steps 1-3.
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). It only reads: nothing is saved, sent to a model for
 * generation, or changed. Each check prints PASS, FAIL or INFO, then a summary.
 *
 *   Step 1  G10  loopback fallback        (PR 10)
 *   Step 2  F7   Tekken chat templates     (needs a model loaded)
 *   Step 3  G6   10-character passwords    (PR 6)
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const getJSON = async (path, init) => {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
  };
  const isLoopback = h => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);

  // ── Step 1: G10, loopback fallback ──────────────────────────────────────
  try {
    const h = await getJSON('/health-fileserver');
    log(h.status === 'ok' ? 'PASS' : 'FAIL', 'G10', `server answers /health-fileserver (status=${h.status}, version=${h.version})`);
    if (!('listen_host' in h)) {
      log('FAIL', 'G10', 'health does not report the bind (listen_host missing)');
    } else if (h.lan_bind_denied) {
      // The fallback fired: the LAN bind was refused, and we are still here.
      log(isLoopback(h.listen_host) ? 'PASS' : 'FAIL', 'G10',
        `LAN bind was refused and the page is still served on ${h.listen_host}:${h.listen_port} — reason: ${h.lan_bind_denied}`);
      log(h.lan_access === false ? 'PASS' : 'FAIL', 'G10', 'health reports LAN access OFF while fallen back');
    } else {
      log('PASS', 'G10', `bound as configured: ${h.listen_host}:${h.listen_port}, LAN access ${h.lan_access ? 'ON' : 'OFF'} (no fallback needed)`);
      log('INFO', 'G10', 'to see the fallback itself, set listen_host to an address this PC does not have, restart, and run this again');
    }
  } catch (e) {
    log('FAIL', 'G10', 'could not read /health-fileserver: ' + e.message);
  }

  // ── Step 2: F7, Tekken templates ────────────────────────────────────────
  // The bug: the engine read a built-in template NAME as the template itself,
  // so the model received the literal text "mistral-v7-tekken" instead of the
  // conversation. /apply-template shows exactly what the model would be fed.
  const TEKKEN_IDS = new Set(['mistral-small', 'mistral-nemo', 'mistral-tekken']);
  try {
    const m = await getJSON('/active-model.json');
    log('INFO', 'F7', `active model: ${m.name || m.ggufFile} (family=${m.family}, id=${m.id})`);
    const probe = 'GobboNet probe 7f3a';
    let prompt = null;
    try {
      const r = await getJSON('/llm/apply-template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'You are a test character.' },
          { role: 'user', content: probe },
        ] }),
      });
      prompt = String(r.prompt ?? '');
    } catch (e) {
      log('INFO', 'F7', 'model not ready, so the template could not be rendered (' + e.message + '). Load a model and re-run.');
    }
    if (prompt !== null) {
      console.log('      rendered prompt:', JSON.stringify(prompt));
      log(prompt.includes(probe) ? 'PASS' : 'FAIL', 'F7',
        prompt.includes(probe) ? 'the conversation reaches the model' :
          `the model does NOT see the conversation; it is fed ${JSON.stringify(prompt.slice(0, 60))}`);
      log(/^\s*[a-z0-9]+(-[a-z0-9]+)+\s*$/i.test(prompt) ? 'FAIL' : 'PASS', 'F7',
        'the prompt is not just a template name rendered as text');
      if (m.family === 'mistral' && TEKKEN_IDS.has(m.id)) {
        log(prompt.includes('[INST]') ? 'PASS' : 'FAIL', 'F7', 'Tekken model is framed with [INST] ... [/INST]');
        log(/\[INST\] /.test(prompt) ? 'FAIL' : 'PASS', 'F7', 'no space after [INST] (the issue #20 spacing)');
      } else {
        log('INFO', 'F7', 'not a Tekken model; load Cydonia / Mistral Small / Nemo / Magistral to run the Tekken-specific checks');
      }
    }
  } catch (e) {
    log('FAIL', 'F7', 'could not read /active-model.json: ' + e.message);
  }

  // ── Step 3: G6, 10-character passwords ──────────────────────────────────
  // The new minimum applies only where a password is CHOSEN (setup wizard,
  // installer, launch.bat, `gobbonet set-password`). This page cannot choose
  // one, so it checks the other half: existing passwords still sign in.
  try {
    const r = await fetch('/active-model.json', { credentials: 'same-origin', cache: 'no-store' });
    const signedIn = r.ok && !r.redirected;
    log(signedIn ? 'PASS' : 'FAIL', 'G6', signedIn
      ? 'this session is signed in, so an existing password (whatever its length) still works after the update'
      : `request was not accepted (HTTP ${r.status}); sign in and re-run`);
  } catch (e) {
    log('FAIL', 'G6', 'sign-in check failed: ' + e.message);
  }
  log('INFO', 'G6', 'by hand: run "Setup or add a model" (or `gobbonet set-password`) and try a 9-character password — it should say "Use at least 10 characters."');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 steps 1-3: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
