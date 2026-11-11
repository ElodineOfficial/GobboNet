/* GobboNet 1.8.0, round 8 -- console check for the embedding server that
 * GobboNet now starts and watches itself (roadmap #15, PR #56).
 *
 * Paste into the browser console with GobboNet open and signed in. A second
 * or two. It changes nothing: it reads /health-fileserver, asks the embedding
 * server for one embedding if it is running, and redraws two lines of the
 * page from what it found. The end of the output lists what to try by hand.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 8] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 8: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';

  if (!fn('refreshEmbedState') || !fn('embedStateText') || !fn('loadPrivacyEmbedLine')) {
    log('FAIL', 'this page has no refreshEmbedState / embedStateText / loadPrivacyEmbedLine: it is older than round 8. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- what the server says -----------------------------------------------
  log('INFO', '--- The embedding server ---');
  const h = await (await fetch('/health-fileserver', { cache: 'no-store' })).json();
  const STATES = ['running', 'starting', 'restarting', 'standby', 'failed', 'external', 'off'];
  check(STATES.includes(h.embed), `/health-fileserver reports it: embed = "${h.embed}"`);
  if (h.embed_detail) log('INFO', `and why: ${h.embed_detail}`);
  check(h.embed === 'running' || h.embed === 'off' || h.embed === 'external' || !!h.embed_detail,
    'any state other than running, off or external comes with a reason');

  if (h.embed === 'running' || h.embed === 'external') {
    let vec = null;
    try {
      const r = await fetch('/embed/v1/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'search_query: round 8', model: 'embed' }) });
      const j = await r.json();
      vec = j && j.data && j.data[0] && j.data[0].embedding;
    } catch (e) { /* reported below */ }
    check(Array.isArray(vec) && vec.length > 0, `it answers: an embedding of ${Array.isArray(vec) ? vec.length : 0} numbers came back through /embed`);
  } else if (h.embed === 'standby') {
    log('INFO', 'it is resting with the chat model; send a message and run this again to see it running.');
  }

  // ---- what the page says -------------------------------------------------
  log('INFO', '--- What the page says ---');
  const st = await refreshEmbedState();
  const t = embedStateText(st);
  check(st.state === h.embed && t.text.length > 0, `the page reads the same state, and has words for it: "${t.text}"`);
  await loadPrivacyEmbedLine();
  const line = document.getElementById('privacy-embed');
  check(!!line && line.textContent === t.text && line.style.display !== 'none',
    'CONFIG > Privacy Status shows that sentence');
  check(t.short.length > 0 && /^by meaning: /.test(t.short), `the line under the RAG Storybook ends "${t.short}"`);
  if (h.embed === 'failed' && /no embedding model at/.test(h.embed_detail || '')) {
    log('INFO', 'No embedding model yet: on Windows run "Setup or add a model" once; on Linux run gobbonet setup and choose Download Nomic.');
  }

  log('INFO', '--- By hand ---');
  log('INFO', '1. Windows: start GobboNet from the Start menu (not launch.bat), then run this again: embed should be "running". Up to 1.7.9 a Start-menu launch started no embedding server.');
  log('INFO', '2. End the embedding server in Task Manager (llama-server.exe whose command line has --embeddings, or kill it on Linux). The console says "[embed] restarting" and it is back within seconds.');
  log('INFO', '3. gobbonet doctor has an EMBEDDING SERVER section: mode, model, whether it matches its pin, and whether it answers.');
  log('INFO', '4. With Idle Stand-Down on, after it fires embed is "standby"; your next message brings both back.');
  return done();
})();
