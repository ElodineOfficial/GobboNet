/* GobboNet 1.8.1 -- console check for two fixes:
 *   1. Web search (🔍) belongs to each device. It was stored with the chats
 *      and synced, so switching it on at one device switched it on for every
 *      other, and a phone that never touched it searched with each message.
 *   2. Lore System culls an entry of three words or fewer and writes it again.
 *
 * Paste into the browser console (F12, Console) with GobboNet open and
 * signed in. Run it on the PC AND on the phone. A few seconds. It changes
 * nothing that stays: the search switch is flipped and put back, and the
 * lore part runs the page's own compression against a stand-in model in
 * memory -- it answers only the summary request and the context-size check,
 * everything else still goes to the real server -- and stores nothing.
 *
 * By hand, the real test of 1: switch 🔍 on at the PC only; on the phone it
 * stays off (reload it too), and a message sent there shows no
 * "🔍 Web search" line.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [search+lore] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.1 search + lore: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';

  let server = '';
  try { server = String((await (await fetch('/health-fileserver', { cache: 'no-store' })).json()).version || ''); } catch (_) {}
  log('INFO', `page ${typeof GOBBONET_UI_VERSION === 'string' ? GOBBONET_UI_VERSION : '?'}, server ${server || '(no answer)'}, ${innerWidth < 900 ? 'a narrow (phone-sized) window' : 'a wide window'}`);

  // ---- 1. the search switch -----------------------------------------------------------
  log('INFO', '--- 1. The web search switch ---');
  if (!fn('showSearchSwitch') || typeof SEARCH_SWITCH_KEY !== 'string') {
    log('FAIL', 'this page is older than the fix: the 🔍 switch is still shared through sync. Replace the program file with the one from the zip, restart GobboNet and reload.');
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

  // ---- 2. lore: short entries ----------------------------------------------------------
  log('INFO', '--- 2. Lore System: entries of three words or fewer ---');
  if (!fn('loreEntryWords') || typeof LORE_MIN_WORDS !== 'number' || !fn('summarizeForLore')) {
    log('FAIL', 'this page is older than the fix (no loreEntryWords). Replace the program file with the one from the zip, restart GobboNet and reload.');
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
  return done();
})();
