/* GobboNet 1.7.9 — console check for patch step 11 (F4, the first-run tour).
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console), with no panel open. Takes about 10 seconds.
 *
 * It shows the offer, presses Skip, walks all six stops with the keyboard,
 * and replays the tour from CONFIG -> Basics. CONFIG is opened and closed
 * without saving. The one thing it changes, whether this profile has "seen"
 * the tour, is put back the way it was. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const check = (cond, msg) => log(cond ? 'PASS' : 'FAIL', 'F4', msg);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const q = sel => document.querySelector(sel);
  const root = () => $('tour-root');
  const showing = () => !!root() && !root().hidden;
  const title = () => (q('#tour-root .tour-title') || {}).textContent || '';
  const count = () => (q('#tour-root .tour-count') || {}).textContent || '';
  const spotOn = () => { const s = q('#tour-root .tour-spot'); return !!s && !s.classList.contains('tour-spot-none') && s.offsetWidth > 0; };
  const key = async (k, opts = {}) => {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
    await wait(350);
  };

  if (typeof startTour !== 'function') {
    log('FAIL', 'F4', 'this page has no tour (startTour() is missing) -- is it the 1.7.9 build?');
    return { passes: 0, fails: 1, results: out };
  }
  if (tourActive()) endTour('end');
  if (q('.modal-backdrop.open')) {
    log('INFO', 'F4', 'close the open panel first, then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  const seenBefore = !!state.settings.tourSeen;
  const sidebarBefore = !!state.sidebarOpen;
  const resBefore = performance.getEntriesByType('resource').length;

  try {
    // ── Targets ────────────────────────────────────────────────────────────
    const names = [...new Set(TOUR_STEPS.flatMap(s => s.targets))];
    const counts = names.map(n => [n, document.querySelectorAll(`[data-tour="${n}"]`).length]);
    const bad = counts.filter(([n, c]) => c !== 1 && !(n === 'help' && c === 0 && state.activeThreadId));
    check(!bad.length, `every target is on the page exactly once: ${names.join(', ')}` + (bad.length ? ' -- wrong: ' + JSON.stringify(bad) : ''));
    log('INFO', 'F4', 'on this profile the offer would ' + (tourShouldOffer() ? 'be shown' : 'not be shown') +
      (state.settings.tourSeen ? ' (the tour was already seen)' : (tourShouldOffer() ? '' : ' (this profile already has conversations)')));

    // ── The offer, and Skip ───────────────────────────────────────────────
    state.settings.tourSeen = false;
    offerTour();
    await wait(150);
    check(showing() && title() === 'New to GobboNet?' && /Show me around/i.test(q('#tour-root .tour-next').textContent) && /Skip/i.test(q('#tour-root .tour-end').textContent),
      'the offer asks once: "Show me around" or "Skip"');
    check(document.activeElement === q('#tour-root .tour-next'), 'and "Show me around" has the keyboard focus');
    const card = q('#tour-root .tour-card');
    check(card.getAttribute('role') === 'dialog' && card.getAttribute('aria-modal') === 'true', 'it is a proper dialog for screen readers');
    q('#tour-root .tour-end').click();
    await wait(100);
    check(!showing() && state.settings.tourSeen === true && !tourShouldOffer(), 'Skip closes it and is remembered: it will not be offered again');

    // ── The six stops ─────────────────────────────────────────────────────
    const before = document.activeElement;
    startTour();
    await wait(600);
    const seen = [];
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      seen.push({ title: title(), count: count(), spot: spotOn(), target: _tour && _tour.targetName });
      if (i === 4) {
        check($('settings-modal').classList.contains('open') && _tour.targetName === 'phone', 'the phone stop opens CONFIG and points at Phone & Other Devices');
      }
      if (i === 0) {
        const t = _tour.target, r = t && t.getBoundingClientRect();
        const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        check(!!hit && !!hit.closest('#tour-root'), 'the control under the spotlight cannot be clicked mid-tour (the tour is a look, not a click-through)');
        await key('Tab'); await key('Tab'); await key('Tab'); await key('Tab');
        check(card.contains(document.activeElement), 'Tab keeps the focus inside the tour card');
      }
      if (i === 1) { await key('ArrowLeft'); check(count() === '1 of 6', 'Left arrow goes back'); await key('ArrowRight'); }
      if (i < TOUR_STEPS.length - 1) await key('ArrowRight');
    }
    const titles = seen.map(s => s.title);
    check(JSON.stringify(titles) === JSON.stringify(TOUR_STEPS.map(s => s.title)),
      'six stops in order: ' + titles.join(' / '));
    check(seen.every((s, i) => s.count === `${i + 1} of 6`), 'each says where you are (1 of 6 ... 6 of 6)');
    const dark = seen.filter(s => !s.spot).map(s => s.title);
    check(!dark.length, 'every stop shines on a real control' + (dark.length ? ' -- none for: ' + dark.join(', ') : ''));
    log('INFO', 'F4', 'pointed at: ' + seen.map(s => s.target).join(', '));
    check(!$('settings-modal').classList.contains('open'), 'leaving the phone stop closed CONFIG again');
    check(/Done/i.test(q('#tour-root .tour-next').textContent), 'the last stop says Done');
    q('#tour-root .tour-next').click();
    await wait(150);
    check(!showing() && !tourActive(), 'Done ends the tour');
    check(!!state.sidebarOpen === sidebarBefore, 'the sidebar is back the way it was');
    check(document.activeElement === before || !document.contains(before), 'the keyboard focus goes back to where it was');

    // ── Esc ───────────────────────────────────────────────────────────────
    startTour();
    await wait(300);
    for (let i = 0; i < 4; i++) await key('ArrowRight');   // stop 5 has CONFIG open
    await key('Escape');
    check(!showing() && !$('settings-modal').classList.contains('open'), 'Esc ends the tour, CONFIG it opened included');

    // ── Replay from CONFIG -> Basics ──────────────────────────────────────
    openSettings();
    await wait(200);
    const btn = $('cfg-tour-btn');
    const basics = q('[data-cfg-section="basics"]');
    check(!!btn && basics && basics.contains(btn), 'CONFIG -> Basics has SHOW ME AROUND');
    btn.click();
    await wait(500);
    check(!$('settings-modal').classList.contains('open') && showing() && count() === '1 of 6', 'it closes CONFIG and starts the tour from the first stop');
    endTour('end');
    await wait(100);

    // ── Private ───────────────────────────────────────────────────────────
    const during = performance.getEntriesByType('resource').slice(resBefore).map(e => e.name);
    const outside = during.filter(u => { try { return new URL(u).origin !== location.origin; } catch (_) { return true; } });
    check(!outside.length, 'nothing outside GobboNet was contacted' + (outside.length ? ' -- it was: ' + outside.join(', ') : ''));
    log('INFO', 'F4', during.length
      ? `GobboNet's own requests meanwhile (CONFIG reading its panels, saving "seen"): ${[...new Set(during.map(u => new URL(u).pathname))].join(', ')}`
      : 'no requests at all');
  } catch (e) {
    log('FAIL', 'F4', 'threw: ' + (e && e.message));
    console.error(e);
  } finally {
    try { if (tourActive()) endTour('end'); } catch (_) {}
    try { $('settings-modal').classList.remove('open'); } catch (_) {}
    if (!!state.sidebarOpen !== sidebarBefore) { state.sidebarOpen = sidebarBefore; try { updateSidebarVisibility(); } catch (_) {} }
    state.settings.tourSeen = seenBefore;
    try { saveState(); } catch (_) {}
  }
  check(state.settings.tourSeen === seenBefore, 'whether this profile has seen the tour is back the way it was');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 11: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
