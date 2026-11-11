/* GobboNet 1.8.0 -- console check for Auto Reroll: a character's reply that
 * uses one of its off-limits words is written again.
 *
 * Paste into the browser console with GobboNet open and signed in.
 *
 * As it is, it changes nothing: it checks the page has the feature, runs the
 * matcher on a few sentences, and looks at the card editor.
 *
 * With a model loaded, run this first to also try it on the real model:
 *
 *     window.GN_REROLL_TEST = true
 *
 * That opens a new chat called "Auto Reroll test" with the active character
 * and sends two short messages. For the first, it makes "the" off-limits with
 * 2 tries: nearly every English reply uses "the", so both rerolls should
 * happen and the last reply should be kept and marked. For the second, it
 * makes a word nobody writes off-limits: one reply, no reroll. The
 * character's own Auto Reroll settings are put back afterwards, pass or fail;
 * the test chat stays for you to look at, and can be deleted.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [auto reroll] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 auto reroll: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';

  if (!fn('runGenerationWithReroll') || !fn('autoRerollMatchers') || !fn('findOffLimitsWord')) {
    log('FAIL', 'this page has no runGenerationWithReroll / autoRerollMatchers: it is older than Auto Reroll. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the matcher -----------------------------------------------------------
  log('INFO', '--- Matching ---');
  const m = autoRerollMatchers('chuckl*\nnod\na mix of\n—');
  const hit = (t, s) => { const h = findOffLimitsWord(t, m, 0, !!s); return h ? h.match : null; };
  check(hit('He nodded.') === null && hit('A quick nod.') === 'nod', 'whole words: "nod" does not catch "nodded"');
  check(hit('She chuckled.') === 'chuckled', '"chuckl*" catches "chuckled"');
  check(hit('A MIX\nof things') === 'MIX\nof' || /mix/i.test(hit('A MIX\nof things') || ''), 'a phrase, in any case, across a line break');
  check(hit('Wait—no') === '—', 'an em dash on its own line catches every em dash');
  check(hit('he gave a nod', true) === null, 'while streaming, a word at the very end waits for the next character');

  // ---- the editor --------------------------------------------------------------
  log('INFO', '--- The card editor ---');
  const box = document.getElementById('card-auto-reroll-group');
  check(!!box && !!document.getElementById('card-auto-reroll-words') && !!document.getElementById('card-auto-reroll-max'), 'the Auto Reroll box is in the card editor');
  const pointer = document.getElementById('banned-reroll-pointer');
  check(!!pointer && /best supplement/.test(pointer.textContent) && !!pointer.querySelector('button'),
    'Banned Phrases (logit bias) points to it as the best supplement, with GO TO AUTO REROLL');
  const card = getActiveCard();
  log('INFO', `the active character, ${card.name}: Auto Reroll is ${card.autoRerollEnabled === true ? 'on' : 'off'}` +
    (card.autoRerollWords ? `, ${autoRerollMatchers(card.autoRerollWords).length} word(s), ${autoRerollMaxOf(card)} tries` : ''));

  // ---- the real model ----------------------------------------------------------
  if (!window.GN_REROLL_TEST) {
    log('INFO', 'To try it on the loaded model: run  window.GN_REROLL_TEST = true  and paste this again.');
  } else if (isGenerating) {
    log('FAIL', 'a reply is being written: wait for it to finish, then paste this again.');
  } else {
    const keep = { autoRerollEnabled: card.autoRerollEnabled, autoRerollWords: card.autoRerollWords, autoRerollMax: card.autoRerollMax, temperature: card.temperature };
    const toasts = [];
    const origToast = window.showModelSwitchToast;
    window.showModelSwitchToast = (msg, kind, ms) => { if (/^Auto reroll/.test(msg)) toasts.push(msg); return origToast(msg, kind, ms); };
    const ask = async (text) => {
      await sendMessage(text);
      while (isGenerating) await new Promise(r => setTimeout(r, 200));
      const th = getActiveThread();
      return th.messages[th.messages.length - 1];
    };
    try {
      createThread();
      const th = getActiveThread();
      th.name = 'Auto Reroll test';
      log('INFO', '--- On the real model (a few replies; on a CPU this can take a minute or two) ---');

      Object.assign(card, { autoRerollEnabled: true, autoRerollWords: 'the', autoRerollMax: 2 });
      if (!(Number(card.temperature) > 0)) card.temperature = 0.8;
      const a = await ask('Write two short sentences about the sea.');
      const ar = a.autoReroll || {};
      log('INFO', `reply: "${String(a.content || '').slice(0, 120)}"`);
      if (/\bthe\b/i.test(a.content || '')) {
        check(ar.rerolls === 2 && ar.kept === 'tries', `"the" in every try: rerolled twice and the last kept (rerolls ${ar.rerolls}, kept "${ar.kept}")`);
        check(toasts.length === 2, `and it said so each time (${toasts.length} notices)`);
      } else {
        // Rare, but a model may write a reply without "the" at some try.
        check(!ar.kept, `the reply that was kept has no "the" in it, after ${ar.rerolls || 0} reroll(s)`);
      }
      if (ar.rerolls || ar.kept) {
        const badge = [...document.querySelectorAll('.gen-reroll-badge')].pop();
        check(!!badge && /↻/.test(badge.textContent), `the reply's header shows ${badge ? badge.textContent : 'no badge'}`);
      }
      check(!/\*\(generation stopped\)\*/.test(a.content || ''), 'the reply is a finished one, not marked as stopped');

      toasts.length = 0;
      Object.assign(card, { autoRerollWords: 'xylophonically', autoRerollMax: 2 });
      const b = await ask('Say hello in five words.');
      check(!b.autoReroll && toasts.length === 0, 'a word it never writes: one reply, no reroll, no mark');
    } catch (e) {
      log('FAIL', 'the live test stopped: ' + (e && e.message));
    } finally {
      Object.assign(card, keep);
      window.showModelSwitchToast = origToast;
      saveState();
      log('INFO', `${card.name}'s Auto Reroll settings are back as they were.`);
    }
  }

  log('INFO', '--- By hand ---');
  log('INFO', '1. Characters > edit a character > Auto Reroll: tick it, add a word your model overuses, Tries 3, SAVE, and chat. A reply that uses it is stopped and written again; its header shows ↻ and how many times.');
  log('INFO', '2. Banned Phrases > GO TO AUTO REROLL takes you to the box; ADD MY BANNED PHRASES copies that list across.');
  log('INFO', '3. With a thinking model: put a word in the list that the thinking uses but the reply does not. No reroll: only the reply is checked.');
  log('INFO', '4. Press Stop while it is rerolling: it stops, and does not start another try.');
  return done();
})();
