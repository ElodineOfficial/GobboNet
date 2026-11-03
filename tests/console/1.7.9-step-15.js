/* GobboNet 1.7.9 -- console check for patch step 15 (F5, the Informant).
 *
 * Paste into the browser console with GobboNet open and signed in, on the
 * home screen (no chat open, no panel open). About 3 seconds.
 *
 * It reads the shipped Informant (default-characters.json) and checks it is
 * the 1.7.9 text, under budget, says "I don't know" rather than guessing, and
 * names only buttons that exist. With a model loaded it also counts the card
 * with that model's own tokenizer. It reports whether YOUR Informant is
 * added, up to date, or offered an UPDATE -- and does not touch it. UPDATE
 * and its UNDO are checked on a throwaway character (zz-check preset),
 * removed again at the end. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', 'F5', msg);
  const info = msg => log('INFO', 'F5', msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  if (typeof defaultCharState !== 'function' || typeof updateDefaultChar !== 'function') {
    log('FAIL', 'F5', 'this page has no default-character UPDATE (defaultCharState() is missing) -- is it the 1.7.9 step 15 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (document.querySelector('.modal-backdrop.open') || (typeof tourActive === 'function' && tourActive()) || getActiveThread()) {
    info('go to the home screen (⌂) with no panel open first, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  const PROBE = 'zz-check preset';
  const presetsBefore = defaultCharacters.length;
  try {
    // ── The shipped card ───────────────────────────────────────────────
    const shipped = await (await fetch('default-characters.json', { cache: 'no-store' })).json();
    const inf = shipped.find(c => c.name === 'Gobbonet Informant') || {};
    const style = String(inf.writingStyle || ''), pers = String(inf.personality || '');
    check(/GobboNet 1\.7\.9/.test(style), 'the shipped Informant describes GobboNet 1.7.9');
    const lines = style.split('\n').filter(Boolean);
    check(/Answer only from the notes below/.test(lines.slice(0, 6).join('\n')) && /TROUBLESHOOTING\.md/.test(lines.slice(0, 6).join('\n')) &&
      /don't know/.test(lines[lines.length - 1]), 'it answers from its notes, and says "I don\'t know, check TROUBLESHOOTING.md" first and last');
    const est = estimateTokens(style) + estimateTokens(pers) + 8;
    check(est <= 1500, `about ${est} tokens by GobboNet's estimate (budget 1,500; 1.7.8's was about 1,840)`);
    try {
      const r = await fetch('/llm/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: style + '\n' + pers }) });
      const n = r.ok ? ((await r.json()).tokens || []).length : 0;
      if (n) check(n < 2000, `${n} tokens with the loaded model's own tokenizer, leaving most of even a 4,096-token context`);
      else info('no model is loaded, so the real token count was skipped.');
    } catch (_) { info('no model is loaded, so the real token count was skipped.'); }

    // Every on-screen name it quotes is in this page or its scripts.
    let corpus = document.documentElement.outerHTML;
    for (const s of document.scripts) if (s.src && new URL(s.src).origin === location.origin) {
      try { corpus += await (await fetch(s.src, { cache: 'no-store' })).text(); } catch (_) {}
    }
    corpus = corpus.replace(/&amp;/g, '&');
    const body = style.split('\n').filter(l => !/^[A-Z][A-Z ()/.&]+$/.test(l.trim())).join('\n');
    const RUN = /(?:[+⑂⌂] )?[A-Z][A-Z0-9_+-]*(?![a-z])(?: (?:&|\.?[A-Z0-9][A-Z0-9_+-]*(?![a-z])))*(?: \.?[A-Z0-9][A-Z0-9_+-]*(?![a-z]))|\b[A-Z][A-Z_]{3,}\b/g;
    const SKIP = new Set(['RULES', 'JSON', 'TROUBLESHOOTING', 'HOME', 'UNDO', 'PURGE', 'DATA', 'SCHED', 'CONFIG', 'MODS', 'CHARS', 'ABOUT', 'INSTALL', 'UPDATE']);
    const names = [...new Set([...body.matchAll(RUN)].map(m => m[0].trim()))].filter(n => !SKIP.has(n));
    const absent = names.filter(n => !corpus.includes(n));
    check(names.length >= 20 && absent.length === 0, `all ${names.length} button and section names it quotes exist in this page${absent.length ? ' -- missing: ' + absent.join(', ') : ''}`);

    // ── Your own Informant, untouched ──────────────────────────────────
    const preset = defaultCharacters.find(p => p.name === 'Gobbonet Informant');
    const st = preset ? defaultCharState(preset) : 'none';
    info({ new: 'you have not added the Informant; + ADD on the home screen adds it.',
           same: 'your Informant is the 1.7.9 version.',
           update: 'your Informant is an older version (or you edited it): UPDATE on the home screen brings it to 1.7.9, with UNDO.',
           none: 'the Informant is not among the default characters here.' }[st]);
    const tile = [...document.querySelectorAll('.landing-preset-card')].find(e => /Gobbonet Informant/.test(e.textContent));
    const want = { new: '+ ADD', same: 'ADDED', update: 'UPDATE' }[st];
    if (tile && want) check(tile.querySelector('.landing-preset-badge').textContent === want, `the home screen shows ${want} for it`);

    // ── UPDATE and UNDO, on a throwaway ────────────────────────────────
    defaultCharacters.push({ name: PROBE, writingStyle: 'zz new style', personality: 'zz new', temperature: 0.3 });
    state.characterCards.push({ ...DEFAULT_CARD, id: 'zz-check-preset', name: PROBE, writingStyle: 'zz OLD style', personality: 'zz old',
      temperature: 0.9, textColor: '#123456', bannedPhrases: 'zzword' });
    const idx = defaultCharacters.length - 1;
    render();
    await wait(200);
    const t = () => [...document.querySelectorAll('.landing-preset-card')].find(e => e.textContent.includes(PROBE));
    check(t() && t().querySelector('.landing-preset-badge').textContent === 'UPDATE', 'an older copy of a default character shows UPDATE');
    t().click();
    await wait(200);
    const c = state.characterCards.find(x => x.id === 'zz-check-preset');
    check(c.writingStyle === 'zz new style' && c.temperature === 0.3 && c.textColor === '#123456' && c.bannedPhrases === 'zzword',
      'UPDATE brings its prompt and samplers up to date, keeping its colour and banned phrases');
    const toast = document.getElementById('undo-toast');
    check(toast && toast.classList.contains('visible') && /Updated "zz-check preset"/.test(toast.textContent), 'and offers UNDO');
    toast.querySelector('.undo-toast-btn').click();
    await wait(200);
    const back = state.characterCards.find(x => x.id === 'zz-check-preset');
    check(back.writingStyle === 'zz OLD style' && back.temperature === 0.9 && t().querySelector('.landing-preset-badge').textContent === 'UPDATE',
      'UNDO puts it back exactly, and UPDATE is offered again');
    const count = state.characterCards.filter(x => x.name === PROBE).length;
    t().click();
    await wait(200);
    if (typeof commitPendingUndo === 'function') commitPendingUndo();
    t().click();   // now ADDED: nothing happens
    await wait(200);
    check(state.characterCards.filter(x => x.name === PROBE).length === count && t().querySelector('.landing-preset-badge').textContent === 'ADDED',
      'once up to date it says ADDED, and clicking it adds no copy');

    // ── Notes in the page ──────────────────────────────────────────────
    check(!/Injected periodically/.test(document.body.innerHTML) && /only web search and the model and mod lists go online/.test(document.body.innerHTML),
      'the Personality hint and Privacy Status say what 1.7.9 does');
  } catch (e) {
    log('FAIL', 'F5', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    if (typeof commitPendingUndo === 'function') commitPendingUndo();
    state.characterCards = state.characterCards.filter(x => x.name !== PROBE);
    defaultCharacters.length = presetsBefore;
    saveState();
    render();
  }
  check(!state.characterCards.some(x => x.name === PROBE) && defaultCharacters.length === presetsBefore,
    'the throwaway character is gone; your characters are as they were');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 15: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
