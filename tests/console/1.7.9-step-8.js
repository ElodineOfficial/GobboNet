/* GobboNet 1.7.9 — console check for patch step 8 (PR 7, LAN permissions).
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). Read-only.
 *
 * A web page cannot see Windows firewall rules, so this checks what the page
 * can: whether LAN access is on, and whether THIS page arrived over the
 * network. Run it once on the PC and once from the phone. The Windows-side
 * checks are listed at the end, to do by hand.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const isLoopback = h => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);

  try {
    const r = await fetch('/health-fileserver', { credentials: 'same-origin', cache: 'no-store' });
    const h = await r.json();
    if (h.lan_bind_denied) {
      log('FAIL', 'G7', `LAN access is OFF: the network bind was refused (${h.lan_bind_denied}). Run setup-lan.bat as Administrator.`);
    } else {
      log('INFO', 'G7', `server bound to ${h.listen_host}:${h.listen_port}, LAN access ${h.lan_access ? 'ON' : 'OFF'}`);
    }
    if (isLoopback(location.hostname)) {
      log('INFO', 'G7', 'this page was opened on the PC itself. Open the chat on your phone and run this block there too.');
    } else {
      log('PASS', 'G7', `this page reached the server over the network (${location.host}): the firewall let this device in`);
    }
  } catch (e) {
    log('FAIL', 'G7', 'could not read /health-fileserver: ' + e.message);
  }

  [
    'By hand on Windows, as Administrator, after running setup-lan.bat:',
    '1. netsh advfirewall firewall show rule name="GobboNet-Web"  -> Profiles: Domain,Private  (Public only if you chose [A] or /public)',
    '2. netsh http show urlacl url=http://+:9066/  -> User: <your account>, not Everyone (use your port if it is not 9066)',
    '3. On a network Windows calls Public: setup-lan.bat asks [P]/[A]/[S]; [P] makes it Private and the phone connects.',
    '4. gobbonet doctor -> LAN ACCESS warns "this network is marked PUBLIC" when the rule does not cover it.',
    '5. teardown-lan.bat still removes everything setup-lan.bat added.',
  ].forEach(line => log('INFO', 'G7', line));

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 8: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
