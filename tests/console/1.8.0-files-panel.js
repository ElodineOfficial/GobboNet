/* GobboNet 1.8.0 -- console check for the Files panel: the conversation's
 * files on the right of the chat, with previews, versions and editing.
 *
 * Paste into the browser console with GobboNet open and signed in. Run it in
 * each browser you use: the important part is what YOUR browser lets a
 * preview do.
 *
 * As it is, it changes nothing in your chats: it checks the panel is there,
 * then builds one preview frame off screen, runs its scripts, and has the
 * page try to read GobboNet's chat history, the session cookie and a picture
 * from this server. All three must fail. The frame is removed afterwards.
 *
 * With a model loaded, run this first to also have a character write a file
 * twice, in a new chat called "Files panel test":
 *
 *     window.GN_FILES_TEST = true
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [files panel] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 files panel: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';

  if (!fn('toggleFilesPanel') || !fn('scanConversationFiles') || !fn('filesPreviewDocument')) {
    log('FAIL', 'this page has no toggleFilesPanel / scanConversationFiles: it is older than the Files panel. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the panel ---------------------------------------------------------------
  log('INFO', '--- The panel ---');
  const panel = document.getElementById('files-panel'), toggle = document.getElementById('files-toggle');
  check(!!panel && !!toggle && toggle.getAttribute('aria-controls') === 'files-panel', 'the panel and its \u{1F4C4} button in the top bar are there');
  check(!!document.getElementById('files-panel-group'), 'CONFIG > Characters & Chat has its Files Panel box');
  const thread = getActiveThread();
  const files = thread ? scanConversationFiles(thread) : [];
  log('INFO', thread ? `this chat has ${files.length} file(s)${files.length ? ': ' + files.slice(0, 6).map(f => f.name + (f.versions.length > 1 ? ' (' + f.versions.length + ' versions)' : '')).join(', ') : ''}` : 'no chat is open');

  // ---- what a preview can do in this browser -------------------------------------
  log('INFO', '--- What a preview can reach, in this browser ---');
  const token = 'gn' + Math.random().toString(36).slice(2);
  const page = '<!doctype html><body><img id="i" src="' + location.origin + '/favicon.ico"><script>' +
    'var r={origin:location.origin};' +
    'function send(){parent.postMessage({t:"' + token + '",r:r},"*")}' +
    'try{r.cookie=document.cookie===""?"empty":"READ"}catch(e){r.cookie="denied"}' +
    'fetch("/state").then(function(){r.relative="REACHED"},function(){r.relative="blocked"}).then(function(){' +
    'return fetch("' + location.origin + '/state").then(function(){r.absolute="REACHED"},function(){r.absolute="blocked"})}).then(function(){' +
    'var i=document.getElementById("i");r.img=(i.complete&&i.naturalWidth>0)?"LOADED":"blocked";send()});' +
    '</script></body>';
  const result = await new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');   // as RUN SCRIPTS makes it
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:100px;';
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 6000);
    const onMsg = (e) => { if (e.source === frame.contentWindow && e.data && e.data.t === token) { cleanup(); resolve(e.data.r); } };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); frame.remove(); };
    window.addEventListener('message', onMsg);
    frame.srcdoc = filesPreviewDocument(page, 'html');
    document.body.appendChild(frame);
  });
  if (!result) {
    log('FAIL', 'the test page never reported back (its scripts may not have run at all, which is safe but unexpected).');
  } else {
    check(result.origin === 'null', `the page runs as nobody (origin ${result.origin}), so it has no session here`);
    check(result.relative === 'blocked' && result.absolute === 'blocked', `it cannot read GobboNet's data: /state was ${result.relative}, and ${location.origin}/state was ${result.absolute}`);
    check(result.cookie !== 'READ', `it cannot read the session cookie (${result.cookie})`);
    check(result.img === 'blocked', `it cannot load even a picture from this server, so not from the internet either (${result.img})`);
  }

  // ---- a real model ------------------------------------------------------------------
  if (!window.GN_FILES_TEST) {
    log('INFO', 'To have the loaded model write a file twice: run  window.GN_FILES_TEST = true  and paste this again.');
  } else if (isGenerating) {
    log('FAIL', 'a reply is being written: wait for it to finish, then paste this again.');
  } else {
    log('INFO', '--- On the real model (two replies) ---');
    try {
      createThread();
      const th = getActiveThread();
      th.name = 'Files panel test';
      const ask = async (text) => { await sendMessage(text); while (isGenerating) await new Promise(r => setTimeout(r, 200)); };
      await ask('Write a file called cats.md with two short bullet points about cats. Put it in a ```file:cats.md block.');
      let f = scanConversationFiles(th).find(x => x.name.toLowerCase() === 'cats.md');
      if (!f) {
        log('INFO', 'the model did not write a ```file:cats.md block this time; try a model that follows instructions more closely, or ask it again.');
      } else {
        check(true, 'the reply wrote cats.md, and the panel lists it');
        if (window.innerWidth >= 1100 && state.settings.filesAutoOpen !== false) {
          check(!document.getElementById('files-panel').hidden && document.getElementById('files-title').textContent.toLowerCase() === 'cats.md',
            'and opened the panel on it (a wide screen, with "Open the panel when a reply writes a file" on)');
        }
        await ask('Add a third bullet point and write the whole file again, with the same name.');
        f = scanConversationFiles(th).find(x => x.name.toLowerCase() === 'cats.md');
        if (f && f.versions.length >= 2) check(true, `the second write is version ${f.versions.length} of the same file`);
        else log('INFO', 'the model did not write cats.md again; the panel shows what it has.');
        openFileInPanel(f ? f.key : null);
      }
    } catch (e) {
      log('FAIL', 'the live test stopped: ' + (e && e.message));
    }
  }

  log('INFO', '--- By hand ---');
  log('INFO', '1. Ask a character for a small web page (an HTML file). The panel shows it with scripts off; RUN SCRIPTS makes its buttons work.');
  log('INFO', '2. Open a file, EDIT it, USE IN MY NEXT MESSAGE, then send: your version becomes the next one, "attached by you".');
  log('INFO', '3. Select a few lines in CODE, then ASK ABOUT THE SELECTION: they are quoted into the message box.');
  log('INFO', '4. Drag the panel\'s left edge to resize it; it remembers the width on this device. On a phone it covers the chat, with × to close.');
  return done();
})();
