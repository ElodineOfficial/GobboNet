/* GobboNet 1.7.9 — console check for patch steps 4-6.
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). Nothing is saved or synced. The hostile test data lives
 * only in memory: it is drawn once into the chat area and the page is redrawn
 * from your own data straight after. Each check prints PASS, FAIL or INFO,
 * then a summary.
 *
 *   Step 4  G4   escaping in the render path        (PR 4)
 *   Step 5  G5   imported / synced code arrives OFF  (PR 5)
 *   Step 6  G15  Windows orphan processes            (PR 15, by hand)
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const src = async path => {
    const r = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.text();
  };

  // Every payload, if it ever runs, only sets this flag. Nothing else.
  window.__gn179xss = 0;
  const P = "'\"><img src=x onerror=\"window.__gn179xss=1\">";
  const PJ = "x');window.__gn179xss=1;('";

  // ── Step 4: G4, escaping ────────────────────────────────────────────────
  // 4a. Sidebar row for a thread whose id and name are hostile. Parsed in an
  //     inert <template>, so nothing in it can run while we look at it.
  try {
    const hostileThread = { id: PJ + P, name: P, messages: [], tags: [P], pinned: false };
    const tpl = document.createElement('template');
    tpl.innerHTML = renderThreadItem(hostileThread);
    const injected = tpl.content.querySelectorAll('img, [onerror], script');
    log(injected.length === 0 ? 'PASS' : 'FAIL', 'G4', `thread row: no element injected by the thread id / name / tag (${injected.length} found)`);
    // Each drag handler must call its function with exactly the id, as ONE
    // string. Compile the attribute with stand-ins for the real functions.
    const row = tpl.content.querySelector('.thread-item');
    let handlersOk = !!row;
    for (const [attr, fn] of [['onclick', 'switchThread'], ['ondragstart', 'onThreadDragStart'],
      ['ondragover', 'onThreadDragOver'], ['ondragleave', 'onThreadDragLeave'], ['ondrop', 'onThreadDrop']]) {
      const code = row && row.getAttribute(attr);
      if (!code) { handlersOk = false; continue; }
      const seen = [];
      try { new Function(fn, 'event', code)((...a) => seen.push(a[0]), {}); } catch (e) { seen.push(e); }
      if (seen.length !== 1 || seen[0] !== hostileThread.id) handlersOk = false;
    }
    log(handlersOk ? 'PASS' : 'FAIL', 'G4', 'thread row: every click / drag handler receives the hostile id as one plain string');
  } catch (e) {
    log('FAIL', 'G4', 'thread row check threw: ' + e.message);
  }

  // 4b. A conversation drawn for real: hostile character name (message
  //     header), avatar initial, and synced numeric fields. Drawn into the
  //     chat area for a moment, then the page is redrawn from your data.
  const realGetActive = window.getActiveThread;
  try {
    const hostileConvo = {
      id: 'gn179-test', name: 'GobboNet 1.7.9 escaping test', cardId: 'gn179-missing', cardName: P,
      personaId: 'gn179-missing', personaName: P,
      forkSource: { threadId: 'gn179-none', at: P },
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi', genMs: 1200, smartCapped: P, genStartedAt: P },
      ],
      loreLog: [{ at: Date.now(), folded: P, before: P, after: P }],
    };
    window.getActiveThread = () => hostileConvo;
    renderMessages();
    await new Promise(r => setTimeout(r, 300));          // give an injected <img> time to error
    const box = document.getElementById('messages');
    const roles = [...box.querySelectorAll('.message-role')].map(n => n.textContent);
    log(roles.length >= 2 && roles.every(t => t === P) ? 'PASS' : 'FAIL', 'G4',
      'message header shows the character / persona name as text, exactly as written');
    log(box.querySelectorAll('img[src="x"], [onerror]').length === 0 ? 'PASS' : 'FAIL', 'G4',
      'no element injected through the name, avatar, branch banner or reply badges');
  } catch (e) {
    log('FAIL', 'G4', 'conversation render check threw: ' + e.message);
  } finally {
    window.getActiveThread = realGetActive;
    try { render(); } catch (_) {}
  }
  log(window.__gn179xss === 0 ? 'PASS' : 'FAIL', 'G4', 'no payload ran anywhere in steps 4a-4b');

  // 4c. Source checks on the files this page actually loaded.
  try {
    const [dash, prompt, gen, threads, chat] = await Promise.all(
      ['js/13-dashboard.js', 'js/07-prompt.js', 'js/03-generation.js', 'js/09-threads.js', 'js/10-chat.js'].map(src));
    const jobRaw = [gen, threads, chat].join('\n').match(/\$\{JOBS_URL\}\/\$\{(?!encodeURIComponent)/g);
    log(!jobRaw ? 'PASS' : 'FAIL', 'G4', 'job ids are URI-encoded before they reach a URL path' + (jobRaw ? ` (${jobRaw.length} raw)` : ''));
    log(/return escapeHtml\(initial\)/.test(prompt) ? 'PASS' : 'FAIL', 'G4', 'avatar initials are escaped');
    log(/message-role">\$\{escapeHtml\(roleLabel\)\}/.test(dash) ? 'PASS' : 'FAIL', 'G4', 'loaded 13-dashboard.js is the patched one');
  } catch (e) {
    log('INFO', 'G4', 'could not read the page\'s js/ files for the source checks: ' + e.message);
  }

  // ── Step 5: G5, code arrives switched OFF ────────────────────────────────
  window.__gn179xss = 0;   // judged on its own, whatever step 4 found
  try {
    const blob = {
      characterCards: [{ id: 'a', name: 'A', customCode: 'window.__gn179xss=2', customCodeEnabled: true },
        { id: 'b', name: 'B' }, null],
      extensions: { enabled: true, scripts: [{ raw: 'window.__gn179xss=3' }] },
    };
    const r = neutralizeUntrustedCode(blob);
    log(blob.characterCards[0].customCodeEnabled === false && blob.extensions.enabled === false ? 'PASS' : 'FAIL', 'G5',
      'incoming card code and extensions are switched OFF');
    log(blob.characterCards[0].customCode === 'window.__gn179xss=2' && blob.extensions.scripts.length === 1 ? 'PASS' : 'FAIL', 'G5',
      'the code itself is kept, so it can be reviewed and switched back on');
    log(r.cards === 1 && r.extensions === true ? 'PASS' : 'FAIL', 'G5', `the summary reports what was switched off (cards=${r.cards}, extensions=${r.extensions})`);
    const empty = [neutralizeUntrustedCode(null), neutralizeUntrustedCode({})];
    log(empty.every(x => x.cards === 0 && x.extensions === false) ? 'PASS' : 'FAIL', 'G5', 'empty and missing input are handled');
  } catch (e) {
    log('FAIL', 'G5', 'neutralizeUntrustedCode is missing or threw: ' + e.message);
  }
  try {
    const [sync, data] = await Promise.all(['js/06-state-sync.js', 'js/21-data.js'].map(src));
    const guards = (sync + data).match(/typeof\s+neutralizeUntrustedCode/g);
    log(!guards ? 'PASS' : 'FAIL', 'G5', 'no silent skip: restores and imports call the quarantine directly' + (guards ? ` (${guards.length} guarded calls)` : ''));
  } catch (e) {
    log('INFO', 'G5', 'could not read js/06-state-sync.js / js/21-data.js: ' + e.message);
  }
  log(window.__gn179xss === 0 ? 'PASS' : 'FAIL', 'G5', 'no quarantined code ran');

  // ── Step 6: G15, Windows orphan processes ────────────────────────────────
  log('INFO', 'G15', 'by hand on Windows: run "Repair Windows shortcuts.bat" once, then open "Setup or add a model".');
  log('INFO', 'G15', 'pick a model, wait for the chat to open, then CLOSE the console window with its X.');
  log('INFO', 'G15', 'Task Manager > Details: no llama-server.exe and no gobbonet.exe should remain. The browser stays open.');

  delete window.__gn179xss;
  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 steps 4-6: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
