/* GobboNet 1.8.1 -- console check for the Linux setup's port step, run again
 * just after GobboNet was closed (.deb, .rpm, AppImage and ZIP).
 *
 * Paste it into the console of the SETUP page (http://127.0.0.1:<port>/ that
 * `gobbonet setup` opens), not the chat. To try the case it fixes:
 *   1. Start GobboNet and open the chat in your browser.
 *   2. Close GobboNet (pkill -x gobbonet), and within a minute run setup
 *      again: `gobbonet setup` (ZIP: ./gobbonet setup; AppImage:
 *      ./GobboNet-*-x86_64.AppImage setup).
 *   3. On the setup page press F12, Console, and paste this -- within that
 *      minute.
 *
 * It sends two port choices, as the Continue button on the port step does:
 *   - the setup page's own port, which is in use, so it must be refused, in
 *     words; nothing is saved;
 *   - the port already in your settings (9066 unless you changed it). If it
 *     is accepted, that same number is saved again -- nothing changes. If it
 *     is refused, the script checks whether anything is really answering on
 *     it, which is what decides whether the refusal was right.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [setup port] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.1 setup port: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const choose = async (port) => {
    const r = await fetch('/api/port', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) });
    let body = {};
    try { body = await r.json(); } catch (_) {}
    return { status: r.status, error: String(body.error || '') };
  };
  // Is anything answering on this port? A request the page cannot read, but
  // that fails outright when nothing is listening.
  const answering = async (port) => {
    try { await fetch(`http://127.0.0.1:${port}/login`, { mode: 'no-cors', cache: 'no-store' }); return true; }
    catch (_) { return false; }
  };

  if (location.hostname !== '127.0.0.1' || !document.getElementById('web-port') || !document.getElementById('save-port')) {
    log('FAIL', 'this is not the Linux setup page. Run `gobbonet setup`, and paste this into the console of the page it opens.');
    return done();
  }

  let saved = null;
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    saved = Number(s.listen_port);
  } catch (_) {}
  log('INFO', `the setup page is on port ${location.port}; the port in your settings is ${saved || '(unknown)'}`);

  // ---- a port that really is in use: this page's own ---------------------------
  log('INFO', '--- A port something is listening on ---');
  const own = Number(location.port);
  const busy = await choose(own);
  if (/Errno/.test(busy.error)) {
    log('FAIL', `this setup is 1.8.0's, older than the fix: it answered "${busy.error}". Install the update (it replaces gobbonet-setup.py too), then run \`gobbonet setup\` again.`);
    return done();
  }
  check(busy.status === 400 && /already in use/.test(busy.error) && busy.error.includes(String(own)),
    `port ${own} is refused, in words: "${busy.error}"`);

  // ---- the port in your settings ------------------------------------------------
  log('INFO', '--- The port in your settings ---');
  if (!(saved >= 1024 && saved <= 65535) || saved === own) {
    log('INFO', 'no usable saved port to try; type one into the Port box and press Continue instead.');
    return done();
  }
  const mine = await choose(saved);
  const live = await answering(saved);
  if (mine.status === 200) {
    check(!live, `port ${saved} is accepted${live ? ', but something IS answering on it' : ', and nothing is listening on it'}`);
    log('INFO', `if GobboNet was closed less than a minute ago, this is the case that used to say "[Errno 98] Address already in use".`);
  } else if (/already in use/.test(mine.error)) {
    check(live, live
      ? `port ${saved} is refused, rightly: something is still answering on it (a GobboNet still running?). Close it and run this again.`
      : `port ${saved} is refused, but nothing is answering on it -- the bug this fix is for. Its answer: "${mine.error}"`);
  } else {
    log('FAIL', `port ${saved}: unexpected answer ${mine.status} "${mine.error}"`);
  }

  log('INFO', `By eye: type ${own} into the Port box and press Continue. It should say "Port ${own} is already in use, ..." in words. Then type your real port back in to carry on.`);
  return done();
})();
