/* GobboNet 1.8.0, round 4 -- console check for card tools (roadmap #9,
 * PR #71) and model links (roadmap #10, issue #52).
 *
 * Paste into the browser console with GobboNet open and signed in, on the PC
 * GobboNet runs on. Under a minute. What it touches:
 *
 *   - Two short requests to your model: one offering a made-up get_time tool,
 *     to see whether this model and engine can call tools at all, and one
 *     streamed reply it cancels after the first words, to hold a reply in
 *     flight while it asks for an automatic model switch, which the server
 *     must refuse. Nothing is saved to any chat. If that reply ends before
 *     the switch is asked for, the switch is skipped, not sent.
 *   - The Card Tools limits are changed in memory for a moment and put back;
 *     nothing is saved. Your characters, chats and settings are not changed.
 *
 * By hand, after it (it says so at the end): a character that offers a tool,
 * and a chat that brings its model back.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 4] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 4: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const call = async (path, body) => {
    const opts = body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, opts);
    let json = {};
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  };
  const $ = id => document.getElementById(id);
  const has = name => typeof window[name] === 'function' || (() => { try { return typeof eval(name) === 'function'; } catch (e) { return false; } })();

  if (!has('cardToolLimit') || !has('isPlainModelFile')) {
    log('FAIL', 'this page is older than round 4 (no cardToolLimit / isPlainModelFile). Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- #9 card tools -----------------------------------------------------
  log('INFO', '--- Card Tools ---');
  check(!!$('card-tools-group') && ['set-tool-max-rounds', 'set-tool-timeout', 'set-tool-result-max', 'set-tool-args-max'].every(id => $(id)),
    'CONFIG > Characters & Chat has the Card Tools box and its four limits');
  check(!!$('card-tools-enabled') && /Card Tools/.test(($('tip-card-tools') || {}).textContent || ''),
    "the character editor has \"Let the model call this card's tools\", and its note points at Card Tools");
  const keys = ['toolMaxRounds', 'toolTimeoutSeconds', 'toolResultMaxChars', 'toolArgsMaxKB'];
  log('INFO', 'limits in use: ' + keys.map(k => k + ' ' + cardToolLimit(k)).join(', '));
  {
    const saved = {};
    for (const k of keys) saved[k] = state.settings[k];
    try {
      Object.assign(state.settings, { toolMaxRounds: 0, toolTimeoutSeconds: 1e12, toolResultMaxChars: 1, toolArgsMaxKB: 'x' });
      check(cardToolLimit('toolMaxRounds') === 1 && cardToolLimit('toolTimeoutSeconds') === 3600 &&
        cardToolLimit('toolResultMaxChars') === 500 && cardToolLimit('toolArgsMaxKB') === 64,
        'each limit holds to its floor and ceiling, and nonsense means the default (tried in memory, not saved)');
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete state.settings[k]; else state.settings[k] = saved[k]; }
    }
    check(keys.every(k => state.settings[k] === saved[k]), 'and the settings are back as they were');
  }
  {
    const blob = { characterCards: [{ id: 'x', customCodeEnabled: false, toolsEnabled: true }] };
    neutralizeUntrustedCode(blob);
    check(blob.characterCards[0].toolsEnabled === false, 'a restored or imported card with only the tools box ticked arrives with it off');
  }
  const ticked = (state.characterCards || []).filter(c => c.toolsEnabled === true);
  log('INFO', ticked.length ? `characters with tools on: ${ticked.map(c => c.name).join(', ')}` : 'no character has tools switched on');
  const active = getActiveCard();
  if (active && liveCardTools().length) log('INFO', `${active.name}'s code offers: ${liveCardTools().join(', ')}${cardToolDefs(active).length ? ' (offered to the model)' : ' (not offered: both boxes must be on)'}`);

  // Can this model call tools? One short, non-streamed request.
  try {
    const probe = await call('/llm/v1/chat/completions', {
      model: typeof getRequestModelName === 'function' ? getRequestModelName() : 'local',
      messages: [{ role: 'user', content: 'What time is it? Use the get_time tool to find out.' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: { type: 'object', properties: {} } } }],
      max_tokens: 96, temperature: 0, stream: false
    });
    const text = JSON.stringify(probe.body).slice(0, 300);
    const msg = probe.body && probe.body.choices && probe.body.choices[0] && probe.body.choices[0].message;
    if (/requires --jinja/i.test(text)) {
      log('INFO', 'the engine runs this model without --jinja, so it cannot use tools: a card with tools gets one plain reply and a note');
    } else if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      check(msg.tool_calls[0].function && msg.tool_calls[0].function.name === 'get_time',
        'this model and engine can call tools: it asked for get_time');
    } else if (probe.status === 200) {
      log('INFO', 'the model answered in text instead of calling the tool; it may not be trained for tool use (Qwen3, Llama 3.x and GLM-4.5 are)');
    } else {
      log('INFO', `the probe got ${probe.status}: ${text}`);
    }
  } catch (e) {
    log('INFO', 'could not send the tool probe: ' + (e && e.message));
  }

  // ---- #10 model links ---------------------------------------------------
  log('INFO', '--- Model links ---');
  check(!!$('model-follow') && !!$('card-preferred-model') && !!document.querySelector('input[name="set-model-follow"][value="ask"]'),
    'the bar, "Model for this character", and CONFIG > Model Switching are there');
  log('INFO', 'Model Switching is set to: ' + modelFollowMode());
  check(isPlainModelFile('Model-Q4_K_M.gguf') && !isPlainModelFile('../x.gguf') && !isPlainModelFile('C:x.gguf') &&
    !isPlainModelFile('sub/x.gguf') && !isPlainModelFile('x.gguf:s'), 'the page holds model names to the server\'s rule');
  {
    const card = { name: 'c', preferredModel: 'b.gguf' };
    const a = linkedModelFor({ model: 'a.gguf' }, card), b = linkedModelFor({}, card), c = linkedModelFor({ model: '../a.gguf' }, { preferredModel: '' });
    check(a.file === 'a.gguf' && b.file === 'b.gguf' && c === null, 'precedence: the chat\'s own model, then the character\'s link, then nothing');
  }
  const bad = [].concat((state.threads || []).filter(t => t.model && !isPlainModelFile(t.model)).map(t => 'chat ' + t.name),
                        (state.characterCards || []).filter(c => c.preferredModel && !isPlainModelFile(c.preferredModel)).map(c => 'character ' + c.name));
  check(bad.length === 0, 'every stored model link is a plain file name' + (bad.length ? ' -- not: ' + bad.join(', ') : ''));

  let list = null, status = null;
  try { list = (await call('/models-list.json')).body; status = (await call('/swap-status')).body; } catch (e) {}
  if (!list || list.mode === 'remote') {
    log('INFO', 'remote mode (or no model list): GobboNet does not switch models here, so the rest is skipped. The editor hides "Model for this character" here.');
    return done();
  }
  const installed = new Set((list.models || []).map(m => m.file));
  const remembered = (state.threads || []).filter(t => t.model);
  const linked = (state.characterCards || []).filter(c => c.preferredModel);
  log('INFO', `${remembered.length} chat(s) remember a model; ${linked.length} character(s) are linked to one` +
    (linked.filter(c => !installed.has(c.preferredModel)).length ? `, ${linked.filter(c => !installed.has(c.preferredModel)).length} of them not installed here` : ''));
  log('INFO', `loaded now: ${status && status.file}, phase ${status && status.phase}`);
  check(status && status.busy !== true, '/swap-status is not busy when nothing is being written');

  const refused = await call('/swap-model', { file: '../elsewhere.gguf', auto: true });
  check(refused.status === 400, 'an automatic switch to a name outside the models folder is refused (400)');

  if (status && status.phase === 'ready' && isPlainModelFile(status.file)) {
    // Hold a reply in flight, then ask for an automatic switch to the model
    // that is already loaded: the server must answer 409 busy.
    const ac = new AbortController();
    let streaming = false;
    const reply = fetch('/llm/v1/chat/completions', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'local', stream: true, max_tokens: 400, temperature: 0.7,
        messages: [{ role: 'user', content: 'Count slowly from one to one hundred in words, one number per line.' }] })
    }).then(async r => {
      const rd = r.body.getReader();
      while (true) { const { done: d } = await rd.read(); streaming = true; if (d) break; }
    }).catch(() => {});
    const t0 = Date.now();
    while (!streaming && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 100));
    const during = (await call('/swap-status')).body;
    if (streaming && during.busy === true) {
      check(true, '/swap-status says busy while a reply streams');
      const auto = await call('/swap-model', { file: status.file, auto: true });
      check(auto.status === 409 && auto.body.busy === true, `an automatic switch during the reply is refused: 409 busy (got ${auto.status})`);
    } else {
      log('INFO', 'the reply ended (or never started) before the switch could be asked for, so it was not sent');
    }
    ac.abort();
    await reply;
    await new Promise(r => setTimeout(r, 500));
    const after = (await call('/swap-status')).body;
    check(after.file === status.file, `the loaded model is still ${status.file}`);
  }

  log('INFO', 'By hand: in a character\'s editor pick "Model for this character", save, start a new chat with it: a bar offers the switch. ' +
    'Reply once, switch models from the menu, open another chat and come back: it offers its model again.');
  log('INFO', 'By hand, with a tool-capable model: paste the roll_dice example from the custom code box\'s help into a test character, tick ' +
    'both boxes, and ask "roll 2d6 with your dice tool". The reply shows "used roll_dice" above its text.');
  return done();
})();
