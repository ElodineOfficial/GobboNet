/* GobboNet 1.7.9 — console check for patch step 10 (F3, CONFIG sections).
 *
 * Paste into the browser console on a running, signed-in GobboNet chat page
 * (F12 -> Console). It opens CONFIG, tries the search, and closes CONFIG
 * WITHOUT saving. The one thing it touches, whether Advanced is open, is put
 * back the way it was. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, step, msg) => {
    out.push({ status, step, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [${step}] ${msg}`, style, '');
  };
  const tick = () => new Promise(r => setTimeout(r, 30));
  const $ = id => document.getElementById(id);
  const visible = el => !!el && !el.closest('.cfg-hide') && !(el.closest('details') && !el.closest('details').open && !el.matches('summary'));
  const type = async (box, text) => { box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })); await tick(); };

  // The first-run tour (step 11) sits over everything and owns Esc while it
  // is up, so CONFIG cannot be driven underneath it.
  if (typeof tourActive === 'function' && tourActive()) {
    log('INFO', 'F3', 'the GobboNet tour is showing. Answer it (Show me around or Skip), then run this again.');
    return { passes: 0, fails: 0, results: out };
  }

  let savedPref = null;
  try { savedPref = localStorage.getItem('gobbonet.cfg.advancedOpen'); } catch (_) {}

  try {
    openSettings();
    await tick();
    const modal = $('settings-modal');
    const adv = $('cfg-advanced');
    const box = $('cfg-search');

    // ── Layout ────────────────────────────────────────────────────────────
    const titles = [...modal.querySelectorAll('.cfg-section-title')].map(t => t.firstChild.textContent.trim());
    const want = ['Basics', 'Characters & Chat', 'Model & Performance', 'Devices & Network', 'Advanced'];
    log(JSON.stringify(titles) === JSON.stringify(want) ? 'PASS' : 'FAIL', 'F3', 'five sections, in order: ' + titles.join(' / '));
    const KEY = ['set-avatar-scale', 'set-stream-replies', 'set-auto-continue-delay', 'set-sticky-cards', 'set-apikey',
      'set-retrieval-near-end', 'perf-ctx', 'perf-gpu', 'perf-kv', 'lan-host', 'lan-port', 'set-network-hosts',
      'config-file-group', 'set-allow-remote-images', 'set-cot-timeout-enabled', 'set-lore-timeout',
      'add-model-block', 'set-standdown-minutes'];
    const lost = KEY.filter(id => !modal.contains($(id)));
    log(!lost.length ? 'PASS' : 'FAIL', 'F3', `every setting is still in CONFIG (${KEY.length} spot-checked)` + (lost.length ? ': missing ' + lost.join(', ') : ''));
    log(adv.open === (savedPref === '1') ? 'PASS' : 'FAIL', 'F3',
      `Advanced opened as you last left it (${adv.open ? 'open' : 'closed'}; closed unless you opened it before)`);
    const privacy = [...modal.querySelectorAll('.modal > .form-group')].pop();
    log(privacy && /Privacy Status/.test(privacy.textContent) ? 'PASS' : 'FAIL', 'F3', 'Privacy Status stays last, outside the sections');

    // ── Search ────────────────────────────────────────────────────────────
    adv.open = false; await tick();
    await type(box, 'stand-down');
    const sd = $('standdown-group');
    const shownBlocks = [...modal.querySelectorAll('.cfg-section > .form-group, .modal > .form-group')].filter(el => !el.classList.contains('cfg-hide'));
    log(visible(sd) && shownBlocks.length === 1 ? 'PASS' : 'FAIL', 'F3', `"stand-down" finds Idle Stand-Down and only it (${shownBlocks.length} shown)`);
    log(/1 setting match/.test($('cfg-search-empty').textContent) ? 'PASS' : 'FAIL', 'F3', `and says so: "${$('cfg-search-empty').textContent}"`);
    log([...modal.querySelectorAll('.cfg-section')].filter(s => !s.classList.contains('cfg-hide')).length === 1 ? 'PASS' : 'FAIL', 'F3', 'sections with no match are hidden');

    await type(box, 'config.toml');
    log(adv.open && visible($('config-file-group')) ? 'PASS' : 'FAIL', 'F3', '"config.toml" opens Advanced to show Config File');
    await type(box, 'lorebook snippets');
    log(visible($('prompt-order-group')) ? 'PASS' : 'FAIL', 'F3', 'words from a "?" note find their setting too ("lorebook snippets" -> Prompt Order)');
    await type(box, 'zzqx no such setting');
    log(/No setting matches/.test($('cfg-search-empty').textContent) ? 'PASS' : 'FAIL', 'F3', 'nothing found says so');

    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    const hidden = modal.querySelectorAll('.cfg-hide').length;
    log(box.value === '' && hidden === 0 ? 'PASS' : 'FAIL', 'F3', 'Esc clears the search and every setting is back');
    log(modal.classList.contains('open') ? 'PASS' : 'FAIL', 'F3', 'that Esc cleared the box without closing CONFIG');
    await tick();
    log(adv.open === false ? 'PASS' : 'FAIL', 'F3', 'Advanced went back to closed: opening it for a match was not a choice');
    let after = null;
    try { after = localStorage.getItem('gobbonet.cfg.advancedOpen'); } catch (_) {}
    log(after === savedPref || (savedPref === null && after === '0') ? 'PASS' : 'FAIL', 'F3', 'and searching did not change what is remembered');

    // ── Remembered ────────────────────────────────────────────────────────
    adv.open = true; await tick();
    let mem = null;
    try { mem = localStorage.getItem('gobbonet.cfg.advancedOpen'); } catch (_) {}
    log(mem === '1' ? 'PASS' : 'INFO', 'F3', mem === '1' ? 'opening Advanced by hand is remembered' : 'browser storage is unavailable here; Advanced will start closed each time');
  } catch (e) {
    log('FAIL', 'F3', 'threw: ' + e.message);
  } finally {
    try {
      if (savedPref === null) localStorage.removeItem('gobbonet.cfg.advancedOpen');
      else localStorage.setItem('gobbonet.cfg.advancedOpen', savedPref);
    } catch (_) {}
    const box = $('cfg-search');
    if (box && box.value) { box.value = ''; filterConfig(''); }
    $('settings-modal').classList.remove('open');   // closed, not saved
  }

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 step 10: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
