/* GobboNet 1.8.1 -- console check for the release: the number, the
 * Informant, the 1.8.1 fixes a page shows, and the update key.
 *
 * Paste into the browser console (F12, Console) with GobboNet open and
 * signed in: on an install from GobboNetSetup-1_8_1.exe, the 1.8.1 zip, or a
 * 1.8.1 Linux package. A few seconds. It reads, and changes nothing that
 * stays: the search switch is flipped and put back, the Files button is
 * tried in memory and then by going HOME and back, and the lore part runs the
 * page's own compression against a stand-in model in memory (it answers only
 * the summary request and the context-size check) and stores nothing.
 *   1. The page, the server and ABOUT all say 1.8.1 and agree; which build
 *      and which system; the Informant shipped with it is 1.8.1's.
 *   2. The Files button shows only in a chat with files (open one that has
 *      a file for the HOME-and-back part).
 *   3. Web search (the magnifier) belongs to this device.
 *   4. Lore System writes an entry of three words or fewer again.
 * Run it on the phone too: 3 and 4 matter there most. The Linux setup page
 * has its own checks (tests/console/1.8.1-setup-port.js and
 * 1.8.1-linux-setup-openssl.js).
 *
 * To also ask GitHub whether a newer release exists, and whether this
 * install could install it (what CHECK FOR UPDATES does), run this first:
 *
 *     window.GN_UPDATE_CHECK = true
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [1.8.1] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.1 check: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };

  const fn = name => typeof window[name] === 'function';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- 1. the release number, on both halves and in ABOUT -------------------
  const page = typeof GOBBONET_UI_VERSION === 'string' ? GOBBONET_UI_VERSION : '(none)';
  check(page === '1.8.1', `the page says ${page}`);
  let server = '';
  try {
    const r = await fetch('/health-fileserver', { cache: 'no-store' });
    if (r.ok) server = String((await r.json()).version || '');
  } catch (_) {}
  check(/^1\.8\.1-go-[0-9a-z.]+$/.test(server), `the server says ${server || '(nothing)'}`);
  check(server.split('-go-')[0] === page, 'the two halves are the same release');
  if (/dirty/.test(server)) log('INFO', 'this server was built from a modified tree (-dirty); a released build never is.');

  try {
    const g = await (await fetch('/gpu', { cache: 'no-store' })).json();
    if (g.linux === false) {
      log('INFO', 'on Windows');
      check(!g.engine_openssl, 'no OpenSSL note: that fallback is for the Linux AppImage and ZIP only');
    } else if (g.linux === true) {
      log('INFO', g.engine_openssl === 'bundled' ? 'on Linux; the engine uses the OpenSSL 3 this AppImage or zip carries (the system has none)'
        : g.engine_openssl === 'system' ? 'on Linux; the engine uses the system\'s OpenSSL 3'
        : 'on Linux; no OpenSSL note (a .deb or .rpm, or started with gobbonet serve rather than its launcher)');
    }
  } catch (_) { /* /gpu not readable here: nothing to report */ }

  if (typeof openAbout === 'function') {
    openAbout();
    let shown = '';
    for (let i = 0; i < 20 && !/\d/.test(shown); i++) {
      await new Promise(r => setTimeout(r, 100));
      shown = (document.getElementById('about-version') || {}).textContent || '';
    }
    const warn = document.getElementById('about-version-warn');
    check(shown.trim() === '1.8.1' && (!warn || !warn.textContent.trim() || warn.hidden || getComputedStyle(warn).display === 'none'),
      `ABOUT shows ${shown.trim() || '(nothing)'} with no version warning`);
    check(!!document.getElementById('about-update-btn'), 'ABOUT has CHECK FOR UPDATES');
    if (typeof closeAbout === 'function') closeAbout();
    else document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  } else {
    log('FAIL', 'this page has no ABOUT panel to read');
  }

  // ---- the Informant ---------------------------------------------------------
  const presets = (typeof defaultCharacters !== 'undefined' && Array.isArray(defaultCharacters)) ? defaultCharacters : [];
  const shipped = presets.find(c => c && c.name === 'Gobbonet Informant');
  check(!!shipped && /GobboNet 1\.8\.1\./.test(shipped.desc || '') && /guide to GobboNet 1\.8\.1,/.test(shipped.writingStyle || ''),
    'the Gobbonet Informant shipped with this build is 1.8.1\'s');
  if (shipped && /CHECK FOR UPDATES/.test(shipped.writingStyle || '') && /Files panel/.test(shipped.writingStyle || '') && /Chats with files show \u{1F4C4} in the top bar/u.test(shipped.writingStyle || '') && /Web search: \u{1F50D} by the input \(per device\)/u.test(shipped.writingStyle || ''))
    log('PASS', 'its notes cover 1.8.0 and 1.8.1 (the Files panel and its button, CHECK FOR UPDATES, web search per device, and the rest)');
  if (shipped && typeof defaultCharState === 'function') {
    const st = defaultCharState(shipped);
    log('INFO', st === 'new' ? 'you have not added the Informant (home screen, DEFAULT CHARACTERS, + ADD)'
      : st === 'same' ? 'your Informant is already 1.8.1\'s'
      : 'your Informant is an older one: its tile on the home screen says UPDATE');
  }

  const btn = document.getElementById('files-toggle');
  const count = document.getElementById('files-count');
  if (!btn || !count) { log('FAIL', 'the \u{1F4C4} button is missing from the top bar'); return done(); }
  if (!fn('_filesShowToggle')) { log('FAIL', 'this page is older than 1.8.1 (no _filesShowToggle). Install 1.8.1, restart GobboNet and reload.'); return done(); }
  log('INFO', `${innerWidth < 900 ? 'a narrow (phone-sized) window' : 'a wide window'}`);
  // Hidden must mean not drawn: the attribute, and what this browser does with it.
  const shown = () => !btn.hidden && getComputedStyle(btn).display !== 'none';
  const say = s => (s ? 'shown' : 'hidden');

  // ---- 1. right now ------------------------------------------------------------
  log('INFO', '--- 2. The Files button: what the page shows now ---');
  const realThread = getActiveThread();
  const realFiles = realThread ? scanConversationFiles(realThread).length : 0;
  const wasOpen = filesPanelIsOpen();
  log('INFO', realThread
    ? `a chat is open ("${String(realThread.title || realThread.name || realThread.id).slice(0, 40)}") with ${realFiles} file(s); the panel is ${wasOpen ? 'open' : 'closed'}`
    : `the home screen; the panel is ${wasOpen ? 'open' : 'closed'}`);
  check(shown() === (wasOpen || realFiles > 0), `the button is ${say(shown())}, as it should be`);
  check(btn.hidden === (getComputedStyle(btn).display === 'none'), 'hidden and drawn agree in this browser (display: none exactly when hidden)');

  // ---- 2. every case, in memory -----------------------------------------------
  log('INFO', '--- 2. The Files button: the rule, tried in memory ---');
  const F = '```';
  const EMPTY = { id: 'gn-files-button-check-empty', messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello. No files here.' }] };
  const WITH = { id: 'gn-files-button-check-files', messages: [
    { role: 'user', content: 'Write the plan down.' }, { role: 'assistant', content: F + 'file:plan.md\n# Plan\n- one\n' + F }] };
  const realGet = window.getActiveThread;
  const r = {};
  let err = null;
  // All of it in one synchronous run: nothing else on the page can render the
  // stand-in chats, and getActiveThread is the real one again before anything can.
  try {
    const at = (t) => { window.getActiveThread = () => t; filesPanelSync(); return shown(); };
    if (wasOpen) toggleFilesPanel(false);
    r.home = at(null);
    r.empty = at(EMPTY);
    r.withFiles = at(WITH);
    r.count = count.textContent;
    toggleFilesPanel(true);
    r.openEmpty = at(EMPTY);
    r.openHome = at(null);
    at(EMPTY); toggleFilesPanel(false); r.closedEmpty = shown();
    at(WITH); toggleFilesPanel(true); toggleFilesPanel(false); r.closedWith = shown();
  } catch (e) {
    err = e;
  } finally {
    window.getActiveThread = realGet;
    try { toggleFilesPanel(wasOpen); filesPanelSync(true); } catch (_) {}
  }
  if (err) log('FAIL', 'the in-memory run threw: ' + (err && err.message));
  check(r.home === false, `home screen, panel closed: ${say(r.home)}`);
  check(r.empty === false, `a chat with no files: ${say(r.empty)}`);
  check(r.withFiles === true && r.count === '1', `a chat with one file: ${say(r.withFiles)}, counting "${r.count}"`);
  check(r.openEmpty === true, `panel open, then a chat with no files: ${say(r.openEmpty)} (so it can be closed where it was opened)`);
  check(r.openHome === true, `panel open on the home screen: ${say(r.openHome)}`);
  check(r.closedEmpty === false, `closing the panel in a chat with no files: ${say(r.closedEmpty)}`);
  check(r.closedWith === true, `closing the panel in a chat with files: ${say(r.closedWith)}`);
  check(filesPanelIsOpen() === wasOpen && shown() === (wasOpen || realFiles > 0), 'put back as it was');

  // ---- 3. the real page, home and back -----------------------------------------
  log('INFO', '--- 2. The Files button: the real page, home and back ---');
  const tid = state.activeThreadId;
  const busy = (typeof isGenerating !== 'undefined' && isGenerating) ||
               (typeof autoContinue !== 'undefined' && autoContinue) ||
               (typeof _groupRound !== 'undefined' && _groupRound);
  if (!tid) {
    log('INFO', 'no chat is open, so this part is skipped. Open a chat (one with files, then one without) and run it again.');
  } else if (busy) {
    log('INFO', 'a reply is being written, so this part is skipped. Run it again when it has finished.');
  } else if (!fn('goHome') || !fn('switchThread')) {
    log('FAIL', 'goHome / switchThread are missing');
  } else {
    goHome();
    await sleep(400);
    check(shown() === wasOpen, `after HOME: ${say(shown())}${wasOpen ? ' (the panel is open)' : ''}`);
    switchThread(tid);
    await sleep(400);
    check(state.activeThreadId === tid, 'back in the same chat');
    check(shown() === (wasOpen || realFiles > 0) && (realFiles ? count.textContent === String(realFiles) : true),
      `back in the chat: ${say(shown())}${realFiles ? ', counting ' + count.textContent : ''}`);
  }

  log('INFO', 'By eye: HOME shows no \u{1F4C4}; a chat with no files shows none; a chat with a file shows \u{1F4C4} and a number. Open the panel, go to a chat with no files: \u{1F4C4} stays until you close the panel.');

  // ---- 3. the search switch -----------------------------------------------------------
  log('INFO', '--- 3. The web search switch ---');
  if (!fn('showSearchSwitch') || typeof SEARCH_SWITCH_KEY !== 'string') {
    log('FAIL', 'this page is older than the fix: the 🔍 switch is still shared through sync. Install 1.8.1, restart GobboNet and reload.');
  } else {
    const btn = document.getElementById('search-toggle');
    const stored = (() => { try { return localStorage.getItem(SEARCH_SWITCH_KEY); } catch (_) { return '(unreadable)'; } })();
    log('INFO', `on this device: ${searchEnabled ? 'ON' : 'off'} (this browser keeps "${stored === null ? 'nothing yet' : stored}")`);
    check(btn && btn.classList.contains('active') === searchEnabled && btn.getAttribute('aria-pressed') === String(searchEnabled),
      'the 🔍 button shows this device\'s switch exactly');
    check(buildStateMeta().searchEnabled === false, 'what this device sends to the server says off, whatever it is set to here');
    const before = searchEnabled;
    let afterOn = null, metaOn = null, savedOn = null;
    try {
      toggleSearch();
      afterOn = (() => { try { return localStorage.getItem(SEARCH_SWITCH_KEY); } catch (_) { return null; } })();
      metaOn = buildStateMeta().searchEnabled;
      savedOn = state.searchEnabled;
    } finally {
      if (searchEnabled !== before) toggleSearch();
    }
    check(afterOn === (before ? 'off' : 'on') && metaOn === false && savedOn === false,
      'flipping it changes only this browser\'s copy, never the shared state (flipped and put back)');
    check(searchEnabled === before && btn.classList.contains('active') === before, `put back: ${before ? 'ON' : 'off'}, as it was`);
    try {
      const r = await fetch('/state', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        if (s && s.searchEnabled === true) {
          log('INFO', 'the server\'s copy still says on (a 1.8.0 device wrote it); it switches nothing on here, and the next save from a fixed device writes off.');
        } else {
          check(true, 'the server\'s copy says off');
        }
      }
    } catch (_) { /* not readable here; nothing to report */ }
  }

  // ---- 4. lore: short entries ----------------------------------------------------------
  log('INFO', '--- 4. Lore System: entries of three words or fewer ---');
  if (!fn('loreEntryWords') || typeof LORE_MIN_WORDS !== 'number' || !fn('summarizeForLore')) {
    log('FAIL', 'this page is older than the fix (no loreEntryWords). Install 1.8.1, restart GobboNet and reload.');
    return done();
  }
  check(LORE_MIN_WORDS === 3 && LORE_SHORT_REROLLS === 2, `an entry of ${LORE_MIN_WORDS} words or fewer is written again, up to ${LORE_SHORT_REROLLS} more times`);
  check(loreEntryWords('He left.') === 2 && loreEntryWords('- The end .') === 2 && loreEntryWords('They crossed the river.') === 4,
    'words counted as a reader would: bullets and bare punctuation are not words');
  check(loreEntryWords('彼は家に帰った') > 3, 'a sentence in a script without spaces is not one "word"');

  const realFetch = window.privacyFetch;
  const sse = (text) => new Response(
    text.split(' ').map(w => 'data: ' + JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] }) + '\n\n').join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const scenario = async (answers) => {
    const asked = [];
    let i = 0;
    window.privacyFetch = async (url, opts) => {
      const u = String(url);
      if (/\/v1\/chat\/completions$/.test(u)) {
        asked.push(JSON.parse(opts.body));
        return sse(answers[Math.min(i++, answers.length - 1)]);
      }
      if (/\/props$/.test(u)) {
        return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 });
      }
      return realFetch(url, opts);
    };
    try {
      const lore = await summarizeForLore('- They left the capital.',
        [{ role: 'user', content: 'We should cross before the patrols come back.' },
         { role: 'assistant', content: 'Mara took the stolen map, and they waded into the river at dawn.' }], '', 8192);
      return { lore, asked, kind: _loreLastKind, why: _loreLastOutcome || '' };
    } finally {
      window.privacyFetch = realFetch;
    }
  };
  try {
    let r = await scenario(['He left.', 'Mara crossed the river at dawn with the stolen map.']);
    check(r.asked.length === 2 && /Mara crossed the river at dawn/.test(r.lore) && !/He left/.test(r.lore),
      'a two-word entry was culled and written again; only the full one would be stored');
    check(r.asked.length === 2 && r.asked[1].temperature > r.asked[0].temperature && /too short/.test(r.asked[1].messages[1].content),
      'the second try ran warmer and was told why');
    r = await scenario(['The end.', 'Battle continues', 'Still nothing here']);
    check(r.asked.length === 3 && r.kind === 'failed' && !/The end|Battle continues|Still nothing/.test(r.lore) && /"Battle continues"/.test(r.why),
      'three short tries: nothing stored, and the reason quotes them (shown under "why?" on the Lore notice)');
    r = await scenario(['SKIP']);
    check(r.asked.length === 1 && r.kind === 'skip', 'SKIP, the model saying nothing happened, is not rerolled');
  } catch (e) {
    window.privacyFetch = realFetch;
    log('FAIL', 'the lore dry run threw: ' + (e && e.message));
  } finally {
    window.privacyFetch = realFetch;
    if (fn('renderLoreIndicator')) renderLoreIndicator('');
  }
  check(window.privacyFetch === realFetch, 'the stand-in model is gone; the page talks to the real engine again');
  log('INFO', 'By eye, search: switch \u{1F50D} on at the PC only; on the phone it stays off (reload it too), and a message sent there shows no "\u{1F50D} Web search" line.');

  // ---- 5. the update key, and (if asked) GitHub ------------------------------------
  if (!window.GN_UPDATE_CHECK) {
    log('INFO', 'Not asking GitHub. To check for a newer release and whether this install can take it, run  window.GN_UPDATE_CHECK = true  and paste this again.');
    return done();
  }
  log('INFO', 'asking GitHub, as CHECK FOR UPDATES does');
  let body = null;
  try {
    const r = await fetch('/update/check', { cache: 'no-store' });
    body = await r.json();
    if (!r.ok && !body) throw new Error('HTTP ' + r.status);
  } catch (e) {
    log('FAIL', '/update/check did not answer: ' + (e && e.message));
    return done();
  }
  check(body.signing_key === true, 'this build has the update signing key built in, so it can install a signed release');
  const inst = body.install || {};
  log('INFO', `this install: ${inst.kind || '?'} (${inst.target || '?'})${inst.can_install ? ', which the button can update' : ' -- ' + (inst.reason || 'the button links the release page instead')}`);
  const said = {
    off: 'update checks are switched off (update_releases_url = "" in config.toml)',
    dev: 'an unstamped build: nothing to compare it with, so nothing was asked',
    current: 'no newer release is out yet',
    error: 'the check could not finish: ' + (body.error || '?'),
  }[body.status];
  if (said) log('INFO', said);
  if (body.offer) log('INFO', `newer: ${body.offer.build} (${body.offer.hotfix ? 'a fix of this release' : 'a newer release'})${body.offer.installable ? ', installable here with UPDATE NOW' : ' -- ' + (body.reason || 'get it from the release page')}`);
  return done();
})();
