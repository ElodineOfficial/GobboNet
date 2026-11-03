/* GobboNet 1.7.9 -- console check for the RAG Storybook fix.
 *
 * Paste into the browser console with GobboNet open and signed in. About a
 * second. It changes nothing: the storybook it tests lives on a throwaway
 * card object that is never saved, in a chat that is never created.
 *
 * Both ways of writing lore must fire:
 *   # Selah, [.7 wing, .3 light, 1.0 angel]   (labelled, weighted tags)
 *   Selah is an angel wandering the world...   (plain text)
 * with the embedding model running or not. Each check prints PASS, FAIL or INFO.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [RAG] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);

  if (typeof parseStorybook !== 'function' || typeof ragParseHeaderLine !== 'function') {
    log('FAIL', 'this page does not have the storybook fix (ragParseHeaderLine() is missing).');
    return { passes: 0, fails: 1, results: out };
  }
  const LABELLED = `# Selah, [.7 wing, .3 light, 1.0 angel]
Sometimes called ‘Neighbor’ by his friends in town, Selah is secretly an angel walking the mortal realm. He is relatively indifferent to most things and tries not to get involved in human affairs.`;
  const PLAIN = `Selah is an angel wandering the world as a human. He sometimes holds a light ethereal glow to him, but he never would simply show his wings. He is relatively indifferent to most things and tries not to get involved in human affairs. Some of his friends in town call him ‘Neighbor’.`;

  // ── How each is read ───────────────────────────────────────────────
  const a = parseStorybook(LABELLED);
  const e = a.entities.Selah;
  check(a.order.length === 1 && e && e.tags.map(t => t.term + ':' + t.weight).join(',') === 'wing:0.7,light:0.3,angel:1',
    'the labelled form is one entry, Selah, with tags wing 0.7, light 0.3, angel 1.0');
  check(e && /^Sometimes called/.test(e.prose) && !/\[/.test(e.prose), 'its header line is not part of what the model reads');
  const b = parseStorybook(PLAIN);
  check(b.proseChunks.length === 1 && (b.proseChunks[0].names || []).includes('Selah') && (b.proseChunks[0].names || []).includes('Neighbor'),
    'the plain form is one entry, with Selah and Neighbor found as names');

  // ── What fires (the real retriever, with your settings) ────────────
  const s = state.settings || {};
  if (!s.retrievalEnabled) info();
  function info() { log('INFO', 'retrieval is switched off in your settings, so nothing fires in a real chat; the checks below turn it on for themselves only.'); }
  const saved = { retrievalEnabled: s.retrievalEnabled, retrieverB: s.retrieverB };
  s.retrievalEnabled = true; s.retrieverB = true;
  let n = 0;
  const fire = async (book, text, words) => {
    const card = { id: 'zz-rag-check-' + (n++), ragStorybook: book, ragWordsToFire: words || 1 };
    const thread = { id: 'zz-rag-check-' + (n++), messages: [{ role: 'user', content: text }] };
    const r = await runRetrieval(thread, card, 4000, {});
    return r.injections.length;
  };
  try {
    check(await fire(LABELLED, 'Have you seen Selah around town?') === 1, 'labelled: saying "Selah" fires it');
    check(await fire(LABELLED, 'They say an angel lives among us.') === 1, 'labelled: angel (1.0) fires it alone');
    check(await fire(LABELLED, 'A light shone and I saw wings.') === 1, 'labelled: wing + light (0.7 + 0.3 = 1.0) fire it, and "wings" counts as wing');
    check(await fire(LABELLED, 'I saw a wing.') === 0, 'labelled: wing alone (0.7) does not');
    check(await fire(PLAIN, 'Have you seen Selah around town?') === 1, 'plain: saying "Selah" fires it');
    check(await fire(PLAIN, 'Ask the Neighbor.') === 1, 'plain: so does "Neighbor"');
    check(await fire(PLAIN, 'They say an angel lives among us.') === 1, 'plain: one of its words fires it (the default)');
    check(await fire(PLAIN, 'They say an angel lives among us.', 2) === 0 && await fire(PLAIN, 'A light shone and I saw a wing.', 2) === 1,
      'plain, set to 2 words: one does not, two do');
    check(await fire(PLAIN, 'Let us go fishing at the lake.') === 0, 'plain: an unrelated line does not');
    const embedOn = (window.__gobboTelemetry || []).slice(-1)[0];
    log('INFO', embedOn && embedOn.config && embedOn.config.embed_available
      ? 'the embedding model is running: entries are also matched by meaning.'
      : 'the embedding model is not running: names and words carry it, as checked above.');
  } finally {
    s.retrievalEnabled = saved.retrievalEnabled; s.retrieverB = saved.retrieverB;
  }

  // ── Saving a character no longer throws ────────────────────────────
  check(typeof saveCard === 'function' && !/_offerCardUndo|_card\b/.test(String(saveCard)),
    'saving a character ends cleanly (the stray UNDO line from step 9 is gone)');

  const fails = out.filter(o => o.status === 'FAIL').length;
  const passes = out.filter(o => o.status === 'PASS').length;
  console.log(`%c1.7.9 RAG fix: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
  return { passes, fails, results: out };
})();
