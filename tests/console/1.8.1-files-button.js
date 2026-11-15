/* GobboNet 1.8.1 -- console check for the Files button, the \u{1F4C4} in the top
 * bar: it is there only when the chat on screen has a file, or while the
 * Files panel is open.
 *
 * Paste into the browser console with GobboNet open and signed in, ideally
 * with a chat open. A few seconds. It changes nothing in your chats:
 *   1. It checks what the page shows right now.
 *   2. In memory, against the page's own code, it tries the home screen, a
 *      chat with no files, a chat with a file, the panel left open in a chat
 *      with no files and on the home screen, and closing it there. Nothing is
 *      saved; the panel is put back open or closed as it was. If the panel
 *      was showing one file, it goes back to its list.
 *   3. If a chat is open and no reply is being written, it goes to the home
 *      screen and back to that chat, as clicking HOME and then the chat
 *      would, and checks what the real page shows each time.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [files button] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.1 files button: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!fn('toggleFilesPanel') || !fn('filesPanelSync') || !fn('scanConversationFiles')) {
    log('FAIL', 'this page has no Files panel at all: it is older than 1.8.0.');
    return done();
  }
  if (!fn('_filesShowToggle')) {
    log('FAIL', 'this page is 1.8.0 without the Files button fix (no _filesShowToggle). Replace the gobbonet program file with the one from the zip, restart GobboNet and reload.');
    return done();
  }

  // ---- which build ------------------------------------------------------------
  let server = '';
  try {
    const r = await fetch('/health-fileserver', { cache: 'no-store' });
    if (r.ok) server = String((await r.json()).version || '');
  } catch (_) {}
  log('INFO', `page ${typeof GOBBONET_UI_VERSION === 'string' ? GOBBONET_UI_VERSION : '?'}, server ${server || '(no answer)'}`);

  const btn = document.getElementById('files-toggle');
  const count = document.getElementById('files-count');
  if (!btn || !count) { log('FAIL', 'the \u{1F4C4} button is missing from the top bar'); return done(); }
  // Hidden must mean not drawn: the attribute, and what this browser does with it.
  const shown = () => !btn.hidden && getComputedStyle(btn).display !== 'none';
  const say = s => (s ? 'shown' : 'hidden');

  // ---- 1. right now ------------------------------------------------------------
  log('INFO', '--- What the page shows now ---');
  const realThread = getActiveThread();
  const realFiles = realThread ? scanConversationFiles(realThread).length : 0;
  const wasOpen = filesPanelIsOpen();
  log('INFO', realThread
    ? `a chat is open ("${String(realThread.title || realThread.name || realThread.id).slice(0, 40)}") with ${realFiles} file(s); the panel is ${wasOpen ? 'open' : 'closed'}`
    : `the home screen; the panel is ${wasOpen ? 'open' : 'closed'}`);
  check(shown() === (wasOpen || realFiles > 0), `the button is ${say(shown())}, as it should be`);
  check(btn.hidden === (getComputedStyle(btn).display === 'none'), 'hidden and drawn agree in this browser (display: none exactly when hidden)');

  // ---- 2. every case, in memory -----------------------------------------------
  log('INFO', '--- The rule, tried in memory ---');
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
  if (err) { log('FAIL', 'the in-memory run threw: ' + (err && err.message)); return done(); }
  check(r.home === false, `home screen, panel closed: ${say(r.home)}`);
  check(r.empty === false, `a chat with no files: ${say(r.empty)}`);
  check(r.withFiles === true && r.count === '1', `a chat with one file: ${say(r.withFiles)}, counting "${r.count}"`);
  check(r.openEmpty === true, `panel open, then a chat with no files: ${say(r.openEmpty)} (so it can be closed where it was opened)`);
  check(r.openHome === true, `panel open on the home screen: ${say(r.openHome)}`);
  check(r.closedEmpty === false, `closing the panel in a chat with no files: ${say(r.closedEmpty)}`);
  check(r.closedWith === true, `closing the panel in a chat with files: ${say(r.closedWith)}`);
  check(filesPanelIsOpen() === wasOpen && shown() === (wasOpen || realFiles > 0), 'put back as it was');

  // ---- 3. the real page, home and back -----------------------------------------
  log('INFO', '--- The real page: home and back ---');
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
  return done();
})();
