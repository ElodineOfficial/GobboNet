/* GobboNet 1.8.0 -- console check for group chats: several characters in
 * one conversation, taking turns.
 *
 * Paste into the browser console with GobboNet open and signed in.
 *
 * As it is, it changes nothing: it checks the page has the + GROUP button,
 * the bar and the editor, then works out turn orders, a member's prompt and
 * the tidying of a reply on a made-up group that is never saved.
 *
 * With a model loaded and at least one group made (// CHARS > + NEW GROUP),
 * run this first to also start a chat with a group, send one message and
 * check who answers. It leaves one chat behind, named "Group chat test":
 *
 *     window.GN_GROUP_TEST = true            // your first group
 *     window.GN_GROUP_TEST = 'Group name'    // or this one
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [group chats] ${msg}`, style, '');
  };
  const check = (c, msg, detail) => log(c ? 'PASS' : 'FAIL', c || detail === undefined ? msg : msg + ' -- got: ' + JSON.stringify(detail).slice(0, 300));
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 group chats: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!fn('normalizeGroup') || !fn('groupListPick') || !fn('groupPromptContext') || !fn('renderGroupBar')) {
    log('FAIL', 'this page has no normalizeGroup / groupListPick: it is older than group chats. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the page ------------------------------------------------------------------
  log('INFO', '--- The page ---');
  const newGroup = document.getElementById('new-group-btn');
  const newThread = document.querySelector('.sidebar-new-row [data-tour="new-chat"]');
  check(!!newGroup && /GROUP/.test(newGroup.textContent) && !!newThread && /THREAD/.test(newThread.textContent),
        'the sidebar has + THREAD and + GROUP side by side');
  check(!!document.getElementById('group-bar'), 'the chat has the group bar (hidden unless the chat is a group\'s)');
  check(!!document.getElementById('group-grid') && !!document.getElementById('group-editor') && !!document.getElementById('group-order'),
        '// CHARS has the GROUPS section and the group editor');
  check(Array.isArray(state.groups), 'groups are part of what is saved');
  const mine = Array.isArray(state.groups) ? state.groups : [];
  log('INFO', mine.length
    ? `you have ${mine.length} group(s): ` + mine.slice(0, 6).map(g => `"${g.name}" (${groupMembers(g).length} member(s), ${g.order})`).join(', ')
    : 'you have no groups yet: // CHARS > + NEW GROUP makes one');

  // ---- the rules, on a made-up group that is never saved -----------------------
  log('INFO', '--- Turn order, the prompt and tidying, on a made-up group (nothing is saved) ---');
  const keepCards = state.characterCards, keepGroups = state.groups;
  try {
    const mk = (id, name, about) => Object.assign({}, DEFAULT_CARD, { id, name, personality: about, greeting: '', writingStyle: 'You are ' + name + '.' });
    state.characterCards = keepCards.concat([
      mk('gn-gt-a', 'Juniper', 'Juniper keeps the inn.'), mk('gn-gt-b', 'Marlow', 'Marlow is a travelling tinker.'), mk('gn-gt-c', 'Tobias Reed', 'Tobias is the ferryman.')]);
    const make = (over) => normalizeGroup(Object.assign({ id: 'gn-gt-group', name: 'Console test',
      members: [{ cardId: 'gn-gt-a' }, { cardId: 'gn-gt-b' }, { cardId: 'gn-gt-c' }] }, over || {}));
    const chat = (g, ...said) => ({ id: 'gn-gt-thread', groupId: g.id, groupName: g.name, cardId: 'gn-gt-a', personaId: state.activePersonaId,
      messages: said.map(([who, text]) => who === 'you' ? { role: 'user', content: text, personaId: state.activePersonaId } : { role: 'assistant', content: text, cardId: who }) });
    const who = (pick) => !pick ? 'nobody' : pick.user ? 'you' : pick.card.name;
    const use = (g) => { state.groups = keepGroups.concat([g]); return g; };

    let g = use(make());
    check(who(groupListPick(chat(g), g, 0)) === 'Juniper', 'turn order: in an empty chat the first member begins');
    check(who(groupListPick(chat(g, ['you', 'hi'], ['gn-gt-a', 'hello']), g, 1)) === 'Marlow', 'then the next one down');
    check(who(groupListPick(chat(g, ['you', 'hi'], ['gn-gt-c', 'hello']), g, 0)) === 'Juniper', 'and round to the top after the last');
    g = use(make({ members: [{ cardId: 'gn-gt-a' }, { cardId: 'gn-gt-b', muted: true }, { cardId: 'gn-gt-c' }] }));
    check(who(groupListPick(chat(g, ['you', 'hi'], ['gn-gt-a', 'hello']), g, 1)) === 'Tobias Reed', 'a muted member is passed over');
    g = use(make({ userInOrder: true, userSlot: 3 }));
    check(who(groupListPick(chat(g, ['you', 'hi'], ['gn-gt-c', 'hello']), g, 3)) === 'you', 'with a place in the order, the round stops at you');

    g = use(make({ order: 'natural', members: [{ cardId: 'gn-gt-a', talk: 0 }, { cardId: 'gn-gt-b', talk: 0 }, { cardId: 'gn-gt-c', talk: 0 }] }));
    const named = groupNaturalQueue(chat(g, ['you', 'Tobias, then Marlow: what do you two make of it?']), g);
    check(named.join() === 'gn-gt-c,gn-gt-b', 'natural order: the members you name reply, in the order named ("Tobias" finds Tobias Reed)', named);

    const names = [{ key: 'a', name: 'Juniper' }, { key: 'b', name: 'Marlow' }, { key: 'c', name: 'Tobias Reed' }];
    check(groupParseChoice('Marlow', names) === 'b' && groupParseChoice('I think **Tobias** should answer.', names) === 'c' && groupParseChoice('Hard to say.', names) === null,
          'the DM\'s answer is read as a name on its list, or as no answer');

    g = use(make({ scenario: 'A wet night at the inn.' }));
    const t = chat(g, ['you', 'Evening.'], ['gn-gt-a', 'Sit by the fire.'], ['gn-gt-b', 'Mind my pack.']);
    const me = state.characterCards.find(c => c.id === 'gn-gt-a');
    const ctx = groupPromptContext(t, me, getActivePersona());
    check(/^\[Group chat: Console test\]/.test(ctx.block) && /- Marlow: Marlow is a travelling tinker\./.test(ctx.block) && /- Tobias Reed:/.test(ctx.block) && !/- Juniper/.test(ctx.block),
          'a member is told who else is in the chat, with a line about each');
    check(/\[Scene\]\nA wet night at the inn\./.test(ctx.block), 'and the scene');
    const own = ctx.present(t.messages[1]), other = ctx.present(t.messages[2]), you = ctx.present(t.messages[0]);
    check(own.role === 'assistant' && own.prefix === '' && other.role === 'user' && other.prefix === 'Marlow: ' && you.role === 'user' && /: $/.test(you.prefix),
          'its own messages are its side of the conversation; everyone else\'s are the other side, with their name in front');
    check(/^It is Juniper’s turn\./.test(ctx.nudge) && /Do not write for Marlow, Tobias Reed/.test(ctx.nudge), 'the prompt ends by saying whose turn it is');
    const stops = groupStopParams({}, t, me).stop || [];
    if (typeof _remoteMode !== 'undefined' && _remoteMode) log('INFO', 'remote server: no name stop strings are sent (a remote API may allow only four); a run-on reply is trimmed afterwards instead');
    else check(stops.includes('\nMarlow:') && stops.includes('\nTobias Reed:') && !stops.includes('\nJuniper:'), 'stop strings: the other members\' names, not its own', stops);
    const reply = { role: 'assistant', cardId: 'gn-gt-a', content: 'Juniper: Sit down, both of you.\n\nMarlow: Gladly.' };
    groupCleanReply(reply, t, me);
    check(reply.content === 'Sit down, both of you.', 'a reply loses its own name label, and ends where it starts writing as someone else', reply.content);
  } catch (e) {
    log('FAIL', 'the checks on the made-up group threw: ' + (e && e.message));
  } finally {
    state.characterCards = keepCards;
    state.groups = keepGroups;
  }
  check(!state.characterCards.some(c => /^gn-gt-/.test(c.id)) && !state.groups.some(g => g.id === 'gn-gt-group'), 'the made-up group and its characters are gone again');

  // ---- a real round, on request --------------------------------------------------
  const want = window.GN_GROUP_TEST;
  if (!want) {
    log('INFO', 'To try a real round: load a model, make a group, then run  window.GN_GROUP_TEST = true  and paste this again.');
    return done();
  }
  log('INFO', '--- A round with your model ---');
  const group = typeof want === 'string' ? mine.find(x => x.name === want) : mine[0];
  if (!group) { log('FAIL', typeof want === 'string' ? `no group is named "${want}"` : 'there is no group to chat with: make one in // CHARS > + NEW GROUP'); return done(); }
  const active = groupActiveMembers(group);
  if (!active.length) { log('FAIL', `"${group.name}" has no member that takes turns (all muted, or their characters were deleted)`); return done(); }
  if (typeof serverConnected !== 'undefined' && !serverConnected) { log('FAIL', 'no model is connected: load one, then run this again'); return done(); }
  const busy = () => groupBusy() || (typeof _groupRound !== 'undefined' && !!_groupRound);
  if (busy()) { log('FAIL', 'a reply is being written: wait for it, then run this again'); return done(); }

  const thread = startGroupChat(group.id);
  if (!thread) { log('FAIL', 'could not start a chat with the group (is its editor open with unsaved changes?)'); return done(); }
  const greeted = thread.messages.length;
  check(document.getElementById('group-bar').style.display !== 'none' && document.querySelectorAll('#group-bar .group-chip').length >= active.length,
        `a chat with "${group.name}" opened, with the bar and a chip for each member`);
  log('INFO', `order: ${group.order}; ${active.length} member(s) take turns; ${greeted} greeting(s) opened the chat`);

  const waitIdle = async (limitMs) => {
    const end = Date.now() + limitMs;
    await sleep(600);
    while (Date.now() < end) { if (!busy()) { await sleep(400); if (!busy()) return true; } await sleep(500); }
    return false;
  };
  const input = document.getElementById('msg-input');
  input.value = 'Hello, everyone. In one sentence each: who are you?';
  sendMessage();
  let finished = await waitIdle(10 * 60 * 1000);
  if (group.order === 'manual') {
    check(thread.messages.slice(greeted).filter(m => m.role === 'assistant').length === 0, 'manual order: nobody replies until a member is clicked');
    await groupTalk(active[0].card.id);
    finished = await waitIdle(10 * 60 * 1000);
  }
  if (!finished) { log('FAIL', 'the round did not finish in ten minutes'); return done(); }

  const replies = thread.messages.slice(greeted).filter(m => m.role === 'assistant');
  const speakers = replies.map(m => (state.characterCards.find(c => c.id === m.cardId) || { name: '?' }).name);
  log('INFO', 'who answered: ' + (speakers.join(', ') || 'nobody'));
  check(replies.length >= 1, 'at least one member answered');
  check(replies.every(m => groupMembers(group).some(p => p.card.id === m.cardId)), 'every reply is from a member of the group');
  check(replies.length <= groupRoundCap(group, active.length), 'no more replies than the round allows', replies.length);
  if (group.order === 'list' && !group.userInOrder) {
    // The order carries on after whoever spoke last, so after the last
    // greeting if the chat opened with any.
    const cap = groupRoundCap(group, active.length);
    const greeter = thread.messages.slice(0, greeted).filter(m => m.role === 'assistant').map(m => m.cardId).pop();
    const after = greeter ? active.findIndex(p => p.card.id === greeter) : -1;
    if (greeter && after < 0) log('INFO', 'the last greeting was from a member that does not take turns, so the exact order is not checked');
    else {
      const expect = Array.from({ length: cap }, (_, k) => active[(after + 1 + k) % active.length].card.name);
      check(speakers.join('|') === expect.join('|'), 'turn order: the members answered in turn: ' + expect.join(', '), speakers);
    }
  }
  if (!group.allowSelf) check(replies.every((m, i) => i === 0 || m.cardId !== replies[i - 1].cardId), 'nobody spoke twice in a row');
  const labelled = replies.filter(m => { const n = (state.characterCards.find(c => c.id === m.cardId) || {}).name || ''; return n && m.content.trim().toLowerCase().startsWith(n.toLowerCase() + ':'); });
  check(labelled.length === 0, 'no reply begins with its own name label');
  check(replies.every(m => (m.content || '').trim()), 'no reply is empty');
  replies.forEach((m, i) => log('INFO', `${speakers[i]}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 110)}`));
  thread.name = 'Group chat test';
  saveState();
  if (fn('render')) render();
  log('INFO', 'The chat is left open as "Group chat test" so the replies can be read; delete it from the sidebar when done.');
  return done();
})();
