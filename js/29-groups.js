/* ================================================================
   GROUP CHATS (1.8.0)

   Several characters in one conversation. A group (js/04-state.js, GROUPS)
   is a cast list with rules for whose turn it is; a chat started from one
   carries thread.groupId (js/09-threads.js). This file is the rest:

     1. Reading a group      who is in it, and who still exists
     2. Whose turn           turn order, natural, shuffle, manual, and the DM
     3. What a member reads  the conversation as one member sees it
     4. A round              one member after another, until it is your turn
     5. The bar in the chat  who is next, mute, "reply now", NEXT and AUTO
     6. Starting a chat      the + GROUP button and the home screen
     7. CAST                 the Groups list and its editor
     8. Catching up          with a first render that ran before this file

   HOW A REPLY IS MADE. Nothing about generation is new. sendMessage and
   regenerateFromThread (js/10-chat.js) ask this file which member answers
   and generate exactly as they do for one character, with that member's own
   card: its prompt, samplers, banned phrases, Auto Reroll, storybook, memory
   files, tools and custom code. When the reply is finished they call
   groupAfterReply(), which starts the next member's reply or ends the round.

   WHOSE TURN IS NEVER STORED. It is worked out from the conversation: who
   spoke last, and where that puts us in the order. So deleting a message,
   rerolling, editing or branching cannot leave a pointer pointing at
   nothing, and sending a message stays an append for sync. What a round
   needs while it runs (how many have replied, who is queued) lives in
   memory and is gone with the page; a reload never restarts one.

   WHAT A MEMBER READS. One model plays every member, one at a time. For the
   member whose turn it is, its own earlier messages are the assistant's;
   everything else -- your messages and the other members' -- is given as the
   other side of the conversation, each message starting with its speaker's
   name. A short block says who else is present, and the prompt ends by
   saying whose turn it is. See groupPromptContext().

   Text from a card, a group or a persona reaches the page only through
   textContent, and the handlers here are attached with addEventListener.
================================================================ */

/* ----------------------------------------------------------------
   1. READING A GROUP
---------------------------------------------------------------- */

function groupById(id) {
  return (Array.isArray(state.groups) ? state.groups : []).find(g => g && g.id === id) || null;
}

/** The members whose character still exists, in turn order:
 *  [{ member, card, index }], index being the place in group.members. */
function groupMembers(group) {
  if (!group || !Array.isArray(group.members)) return [];
  const byId = new Map((state.characterCards || []).map(c => [c.id, c]));
  const out = [];
  group.members.forEach((member, index) => {
    const card = member && byId.get(member.cardId);
    if (card) out.push({ member, card, index });
  });
  return out;
}

/** The members who take turns: present and not muted. */
function groupActiveMembers(group) {
  return groupMembers(group).filter(p => !p.member.muted);
}

/** The first member present: the group's face where one card is needed. */
function groupHostCard(group) {
  const present = groupMembers(group);
  return present.length ? present[0].card : null;
}

function _groupEscapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where `name` is first mentioned in `text` as a whole word, or -1. A name
 *  of several words is also found by its first word when that is at least
 *  three characters: "Captain Reyes" answers to "Captain". */
function groupMentionIndex(text, name) {
  const hay = String(text || '');
  const full = String(name || '').trim();
  if (!hay || !full) return -1;
  const forms = [full];
  const first = full.split(/\s+/)[0];
  if (first !== full && first.length >= 3) forms.push(first);
  let best = -1;
  for (const form of forms) {
    let re;
    try {
      re = new RegExp('(^|[^\\p{L}\\p{N}_])' + _groupEscapeRe(form) + '(?![\\p{L}\\p{N}_])', 'iu');
    } catch (e) { continue; }
    const m = re.exec(hay);
    if (!m) continue;
    const at = m.index + m[1].length;
    if (best < 0 || at < best) best = at;
  }
  return best;
}

/* ----------------------------------------------------------------
   2. WHOSE TURN
---------------------------------------------------------------- */

// Replaced in tests, so that "natural" and "shuffle" can be checked.
let _groupRng = Math.random;

function groupShuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(_groupRng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** The messages that are turns: yours and the characters', not the notes
 *  card code leaves in a chat. */
function _groupTurns(thread) {
  const msgs = (thread && Array.isArray(thread.messages)) ? thread.messages : [];
  return msgs.filter(m => m && !m.cardNote && (m.role === 'user' || m.role === 'assistant'));
}

/** Who wrote the last turn: 'user', a card id, or null in an empty chat. */
function groupLastSpeakerId(thread) {
  const turns = _groupTurns(thread);
  if (!turns.length) return null;
  const last = turns[turns.length - 1];
  if (last.role === 'user') return 'user';
  return last.cardId || thread.cardId || null;
}

/** Where, among `present`, the last character to speak sits; -1 if none of
 *  them has spoken. Messages by a former member are passed over. */
function _groupLastCharacterAt(thread, present) {
  const at = new Map(present.map((p, i) => [p.card.id, i]));
  const turns = _groupTurns(thread);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== 'assistant') continue;
    const id = turns[i].cardId || thread.cardId;
    if (at.has(id)) return at.get(id);
  }
  return -1;
}

/** How many replies a round may hold: the group's own number, or everyone
 *  who takes turns, once. */
function groupRoundCap(group, activeCount) {
  const own = parseInt(group && group.maxReplies, 10) || 0;
  return own > 0 ? own : Math.max(1, activeCount);
}

/** Turn order. The members speak in the order they are listed, round and
 *  round, carrying on after whoever spoke last. With you in the order, the
 *  round stops when it comes to your place -- except at the start of a
 *  round, which is you having spoken or passed.
 *
 *  `count` is how many have replied in this round so far. Returns
 *  { card }, { user: true } when it is your turn, or null when nobody can
 *  speak. */
function groupListPick(thread, group, count) {
  const present = groupMembers(group);
  const n = present.length;
  if (!n || !present.some(p => !p.member.muted)) return null;
  // userSlot counts members that come before you; some may be gone.
  const slot = group.userInOrder
    ? present.filter(p => p.index < group.userSlot).length % n
    : -1;
  let at = _groupLastCharacterAt(thread, present);
  if (at < 0) at = ((slot >= 0 ? slot : 0) - 1 + n) % n;   // nobody yet: begin after you, or at the top
  for (let step = 0; step < n; step++) {
    at = (at + 1) % n;
    if (count > 0 && slot >= 0 && at === slot) return { user: true };
    if (!present[at].member.muted) return { card: present[at].card };
  }
  return null;
}

/** Natural order, as SillyTavern's: members the last message names answer
 *  first, in the order they are named; then each of the others joins in or
 *  not by its talkativeness; and if that leaves nobody, one at random. The
 *  author of the message does not answer themselves unless the group lets
 *  the same character speak twice in a row. Returns card ids. */
function groupNaturalQueue(thread, group) {
  const active = groupActiveMembers(group);
  if (!active.length) return [];
  const turns = _groupTurns(thread);
  const trigger = turns.length ? turns[turns.length - 1] : null;
  const author = (trigger && trigger.role === 'assistant') ? (trigger.cardId || thread.cardId) : null;
  const text = trigger ? String(trigger.content || '') : '';
  const others = active.filter(p => group.allowSelf || p.card.id !== author);
  const pool = others.length ? others : active;

  const named = pool
    .map(p => ({ id: p.card.id, at: groupMentionIndex(text, p.card.name) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  const queue = named.map(x => x.id);

  for (const p of groupShuffled(pool.filter(p => !queue.includes(p.card.id)))) {
    if (_groupRng() * 100 < p.member.talk) queue.push(p.card.id);
  }
  if (!queue.length) queue.push(pool[Math.floor(_groupRng() * pool.length)].card.id);
  return queue;
}

/** Shuffle: everyone who takes turns, once, in a random order. */
function groupShuffleQueue(thread, group) {
  const queue = groupShuffled(groupActiveMembers(group)).map(p => p.card.id);
  if (!group.allowSelf && queue.length > 1 && queue[0] === groupLastSpeakerId(thread)) {
    queue.push(queue.shift());
  }
  return queue;
}

/* ---- The DM --------------------------------------------------------
   "DM decides" asks the model, in a short request of its own, who is best
   to respond next. It is told who is present, what the group's owner wrote
   about how to choose, and the last few messages; it answers with one name.
   With you in the turn order it may choose you, which ends the round.

   It writes nothing into the chat and its answer is never shown as a
   message. An answer that names nobody on the list, a failed request or a
   timeout falls back to the turn order, and the bar says so. */

const GROUP_DM_PROMPT =
  'You are the DM of a group chat: the one who decides whose turn it is. ' +
  'You never write what the characters say.\n' +
  'Read the conversation and choose who should speak next, so that it moves like a real conversation: ' +
  'whoever was just spoken to or asked something, whoever the moment concerns most, ' +
  'or someone who has been quiet for too long. Do not keep choosing the same speaker.\n' +
  'Answer with one name from the list you are given, written exactly as it is there, and nothing else.';

const GROUP_DM_TIMEOUT_MS = 45000;
const GROUP_DM_MAX_TOKENS = 300;
const GROUP_DM_MESSAGES = 14;       // how much of the chat the DM is shown
const GROUP_DM_MESSAGE_CHARS = 600; // of each message, its end
const GROUP_DM_TOTAL_CHARS = 7000;

function _groupClip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const body = stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20));
  return body.trim() + '…';
}

/** The DM's two messages, for these candidates. */
function groupDMMessages(thread, group, candidates, allowUser, userName) {
  const cast = makeCastResolver(thread);
  const roster = candidates.map(p => {
    const about = _groupClip(translateTemplates(p.card.personality || '', p.card.name, userName), 220);
    return '- ' + (p.card.name || 'Unnamed') + (about ? ': ' + about : '');
  });
  if (allowUser) {
    roster.push('- ' + userName + ': the user, a real person. Choose ' + userName +
                ' when it is their turn to answer, act or decide.');
  }
  let sys = GROUP_DM_PROMPT + '\n\nWho can speak next:\n' + roster.join('\n');
  const scene = (group.scenario || '').trim();
  if (scene) sys += '\n\nThe scene:\n' + _groupClip(translateTemplates(scene, '', userName), 800);
  const how = (group.dmInstructions || '').trim();
  if (how) sys += '\n\nHow to choose, from the person running this chat:\n' + how;

  const lines = [];
  let total = 0;
  const turns = _groupTurns(thread).filter(m => (m.content || '').trim());
  for (let i = turns.length - 1; i >= 0 && lines.length < GROUP_DM_MESSAGES; i--) {
    const m = turns[i];
    const who = m.role === 'user' ? (cast.personaFor(m).name || userName) : (cast.cardFor(m).name || 'Someone');
    let text = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (text.length > GROUP_DM_MESSAGE_CHARS) text = '…' + text.slice(-GROUP_DM_MESSAGE_CHARS);
    const line = who + ': ' + text;
    if (total + line.length > GROUP_DM_TOTAL_CHARS && lines.length) break;
    total += line.length;
    lines.unshift(line);
  }
  const names = candidates.map(p => p.card.name || 'Unnamed');
  if (allowUser) names.push(userName);
  const user = (lines.length ? 'The conversation so far, newest last:\n\n' + lines.join('\n\n') : 'Nobody has spoken yet.') +
    '\n\nWho speaks next? Answer with one of: ' + names.join(', ');
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/** Read the DM's answer. `names` is [{ key, name }]; returns a key or null.
 *  The whole answer being a name wins; otherwise the name that appears
 *  first (or, with `last`, the one mentioned last -- for a model that
 *  thought aloud and ran out of room before answering). */
function groupParseChoice(text, names, last) {
  const clean = String(text || '').replace(/[*_`"'“”‘’[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const whole = clean.toLowerCase().replace(/[.!:,;]+$/, '').trim();
  for (const n of names) {
    if (whole === String(n.name || '').toLowerCase().trim()) return n.key;
  }
  let best = null;
  for (const n of names) {
    let at = groupMentionIndex(clean, n.name);
    if (at < 0) continue;
    if (last) {
      // The last place it is mentioned: search on from each find.
      let from = at, next;
      while ((next = groupMentionIndex(clean.slice(from + 1), n.name)) >= 0) from = from + 1 + next;
      at = from;
    }
    const better = !best || (last ? at > best.at : at < best.at) ||
                   (at === best.at && String(n.name).length > String(best.name).length);
    if (better) best = { at, key: n.key, name: n.name };
  }
  return best ? best.key : null;
}

/** One short, unseen request to the model. Returns { content, reasoning }. */
async function groupDMRequest(messages, signal) {
  const body = {
    model: getRequestModelName(),
    messages: messages,
    stream: true,
    max_tokens: GROUP_DM_MAX_TOKENS,
    temperature: 0.2
  };
  // A name is the whole answer, so the reasoning step is asked to stand down
  // (as a character with thinking switched off asks). Left out for a remote
  // server, which may refuse a field it does not know.
  if (!(typeof _remoteMode !== 'undefined' && _remoteMode)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const resp = await privacyFetch(LLAMA_URL + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal,
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  // The chat's own parser, so whatever the model does with its thinking --
  // tags, channels, reasoning_content -- ends up in .reasoning, not the answer.
  const tmp = { role: 'assistant', content: '', reasoning: '' };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const tok = extractTokenFromLine(line);
      if (tok) processStreamDelta(tmp, tok.text, tok.field);
    }
  }
  finalizeStreamMessage(tmp);
  return tmp;
}

/** Ask the DM. Returns { card }, { user: true }, { stopped: true } when
 *  Stop was pressed, or null when it gave no usable answer. */
async function groupAskDM(thread, group, round) {
  const active = groupActiveMembers(group);
  if (!active.length) return null;
  const last = groupLastSpeakerId(thread);
  let candidates = active.filter(p => group.allowSelf || p.card.id !== last);
  if (!candidates.length) candidates = active;
  const allowUser = !!group.userInOrder && round.count > 0;
  if (candidates.length === 1 && !allowUser) return { card: candidates[0].card };

  const userName = getActivePersona().name || 'Anonymous';
  const names = candidates.map(p => ({ key: p.card.id, name: p.card.name || 'Unnamed' }));
  if (allowUser) names.push({ key: 'user', name: userName });

  // Stop works here as it does on a reply: the same button, the same signal.
  const ownAbort = !abortController;
  const wasGenerating = isGenerating;
  if (ownAbort) abortController = new AbortController();
  const signal = abortController.signal;
  isGenerating = true;
  groupSetStatus('The DM is choosing who speaks…');
  try { updateInputState(); } catch (e) {}
  const timer = setTimeout(() => { try { abortController && abortController.abort(); } catch (e) {} }, GROUP_DM_TIMEOUT_MS);
  let timedOut = false;
  const t0 = Date.now();
  try {
    const out = await groupDMRequest(groupDMMessages(thread, group, candidates, allowUser, userName), signal);
    let key = groupParseChoice(out.content, names, false);
    if (!key && allowUser && /\b(the user|user|you)\b/i.test(out.content || '')) key = 'user';
    if (!key && !(out.content || '').trim()) key = groupParseChoice(out.reasoning, names, true);
    console.log('[group] DM answered ' + JSON.stringify(String(out.content || '').slice(0, 80)) +
                ' in ' + (Date.now() - t0) + ' ms -> ' + (key || 'no name on the list'));
    if (!key) return null;
    if (key === 'user') return { user: true };
    const chosen = candidates.find(p => p.card.id === key);
    return chosen ? { card: chosen.card } : null;
  } catch (e) {
    timedOut = Date.now() - t0 >= GROUP_DM_TIMEOUT_MS - 50;
    if (signal.aborted && !timedOut) return { stopped: true };
    console.warn('[group] the DM could not be asked:', e && e.message);
    return null;
  } finally {
    clearTimeout(timer);
    isGenerating = wasGenerating;
    if (ownAbort) abortController = null;
    try { updateInputState(); } catch (e) {}
  }
}

/* ----------------------------------------------------------------
   3. WHAT A MEMBER READS
---------------------------------------------------------------- */

const GROUP_ABOUT_SHORT = 300;
const GROUP_ABOUT_FULL = 2500;
const GROUP_MAX_NAME_STOPS = 12;

/** Everyone but `card`, by name: the other members, then you. */
function groupOtherNames(thread, group, card) {
  const names = [];
  for (const p of groupMembers(group)) {
    const n = (p.card.name || '').trim();
    if (p.card.id !== card.id && n && !names.includes(n)) names.push(n);
  }
  const me = (getActivePersona().name || '').trim();
  if (me && !names.includes(me) && me !== (card.name || '').trim()) names.push(me);
  return names;
}

function _groupNameList(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}

/**
 * The group's part of a prompt built for `card`, or null when the
 * conversation is not a group's. Used by buildContextMessages (js/08-rag.js):
 *
 *   block    a system block: who else is here, and the scene
 *   present  how one message is given to this member: its role, the name
 *            put in front of it, and whose name {{char}} means inside it
 *   cue      what stands in for the other side when the member's own
 *            message is the last thing said, or nothing has been said
 *   nudge    the last line: whose turn it is
 *   tokens   what block and nudge cost, for the context budget
 *   forLore  the same messages with their speakers named, for the summary
 */
function groupPromptContext(thread, card, persona) {
  const group = (typeof threadGroup === 'function') ? threadGroup(thread) : null;
  if (!group || !card) return null;
  const cast = makeCastResolver(thread);
  const me = card.name || 'Assistant';
  const userName = (persona && persona.name) || 'Anonymous';
  const level = group.introduce;
  const about = (text, name) => {
    if (level === 'names') return '';
    const full = translateTemplates(String(text || '').trim(), name, userName);
    return _groupClip(full, level === 'full' ? GROUP_ABOUT_FULL : GROUP_ABOUT_SHORT);
  };

  const others = groupMembers(group).filter(p => p.card.id !== card.id);
  const lines = others.map(p => {
    const a = about(p.card.personality, p.card.name);
    return '- ' + (p.card.name || 'Unnamed') + (a ? ': ' + a : '');
  });
  const userAbout = about(persona && persona.description, me);
  lines.push('- ' + userName + ': the user' + (userAbout ? '. ' + userAbout : ''));

  let block = '[Group chat: ' + group.name + ']\n' +
    'This is a conversation between several people. You are ' + me + '. Also here:\n' +
    lines.join('\n') + '\n' +
    'Messages from the others begin with their name. Write only as ' + me +
    ', and do not put ' + me + '’s name in front of what you write.';
  const scene = (group.scenario || '').trim();
  if (scene) block += '\n\n[Scene]\n' + translateTemplates(scene, me, userName);

  const names = groupOtherNames(thread, group, card);
  // No brackets of its own: the strict-template pass folds it onto the last
  // message as "[System: ...]" (normalizeMessagesForStrictTemplates).
  const nudge = 'It is ' + me + '’s turn. Write ' + me + '’s next message and nothing else, in ' + me +
    '’s own voice.' + (names.length ? ' Do not write for ' + _groupNameList(names) + '.' : '');

  const present = (m) => {
    if (m.role === 'user') {
      return { role: 'user', prefix: (cast.personaFor(m).name || userName) + ': ', charName: me };
    }
    const who = cast.cardFor(m);
    if (who && who.id && who.id === card.id) return { role: 'assistant', prefix: '', charName: me };
    const name = (who && who.name) || 'Someone';
    return { role: 'user', prefix: name + ': ', charName: name };
  };

  return {
    group: group,
    block: block,
    nudge: nudge,
    cue: _groupTurns(thread).some(m => (m.content || '').trim())
      ? '[The conversation continues.]' : '[The conversation begins.]',
    tokens: estimateTokens(block) + estimateTokens(nudge) + 12,
    present: present,
    forLore: (msgs) => (msgs || []).map(m => Object.assign({}, m, {
      loreSpeaker: m.role === 'user' ? (cast.personaFor(m).name || userName) : (cast.cardFor(m).name || 'Someone')
    }))
  };
}

/** The request's stop strings, with "\nName:" added for everyone but the
 *  speaker: a reply that starts writing somebody else's line ends there.
 *  Not for a remote server, which may allow only four stop strings;
 *  groupCleanReply() trims the same thing afterwards for those. */
function groupStopParams(base, thread, card) {
  const out = Object.assign({}, base || {});
  const group = (typeof threadGroup === 'function') ? threadGroup(thread) : null;
  if (!group || !card || group.stopOnOthers === false) return out;
  if (typeof _remoteMode !== 'undefined' && _remoteMode) return out;
  const stops = Array.isArray(out.stop) ? out.stop.slice() : [];
  for (const name of groupOtherNames(thread, group, card).slice(0, GROUP_MAX_NAME_STOPS)) {
    const s = '\n' + name + ':';
    if (!stops.includes(s)) stops.push(s);
  }
  if (stops.length) out.stop = stops;
  return out;
}

/** Tidy a finished group reply: drop the member's own name from the front
 *  ("Mira: ..."), which the labelled transcript teaches a model to write,
 *  and, unless the group says otherwise, end it where it begins a line as
 *  someone else. Returns true if the text changed. */
function groupCleanReply(msg, thread, card) {
  const group = (typeof threadGroup === 'function') ? threadGroup(thread) : null;
  if (!group || !card || !msg || typeof msg.content !== 'string') return false;
  const before = msg.content;
  let text = before;
  const mark = '(?:\\*\\*|__)?';
  const own = (card.name || '').trim();
  if (own) {
    text = text.replace(new RegExp('^\\s*' + mark + _groupEscapeRe(own) + mark + '\\s*:' + mark + '[ \\t]*', 'i'), '');
  }
  if (group.stopOnOthers !== false) {
    let cut = -1;
    for (const name of groupOtherNames(thread, group, card)) {
      const m = new RegExp('\\n[ \\t]*' + mark + _groupEscapeRe(name) + mark + '[ \\t]*:', 'i').exec(text);
      if (m && (cut < 0 || m.index < cut)) cut = m.index;
    }
    if (cut > 0 && text.slice(0, cut).trim()) text = text.slice(0, cut).replace(/\s+$/, '');
  }
  if (text === before) return false;
  msg.content = text;
  return true;
}

/** While a group reply streams: take the member's own name off the front as
 *  soon as it has been written in full, so "Mira: " does not sit on screen
 *  until the reply is done. Only ever at the very start of the message;
 *  groupCleanReply() does this again, and the rest, when it is finished.
 *  Called by the stream feeder (js/03-generation.js) after each piece. */
function groupLiveTrim(msg, thread) {
  if (!msg || !thread || !thread.groupId || !msg.cardId) return;
  const text = msg.content;
  if (typeof text !== 'string' || !text) return;
  const card = (state.characterCards || []).find(c => c.id === msg.cardId);
  const own = card ? String(card.name || '').trim() : '';
  if (!own || text.replace(/^\s+/, '').length > own.length + 10) return;
  const mark = '(?:\\*\\*|__)?';
  const m = new RegExp('^\\s*' + mark + _groupEscapeRe(own) + mark + '\\s*:' + mark + '[ \\t]*', 'i').exec(text);
  if (m) msg.content = text.slice(m[0].length);
}

/** A new group chat opens with its members' own greetings, in turn order:
 *  all of them, the first member's, or none (group.greetings). */
function injectGroupGreetings(thread, group) {
  if (!group || group.greetings === 'none') return;
  const members = groupActiveMembers(group);
  for (const p of (group.greetings === 'first' ? members.slice(0, 1) : members)) {
    injectGreeting(thread, p.card);
  }
}

/* ----------------------------------------------------------------
   4. A ROUND
---------------------------------------------------------------- */

/* The round in progress, or null:
     threadId, groupId
     startedBy   'user' (you sent a message), 'pass' (NEXT, or an empty
                 Enter), 'auto', or 'force' (you picked a member)
     count       replies finished in it
     cap         replies it may hold
     queue       card ids still to speak, for the orders that decide a round
                 up front; null for turn order and the DM
     speaking    the card id whose reply is being written
     picking     true while the next speaker is being chosen */
let _groupRound = null;
// True from a click on NEXT or a member until the reply it started is done,
// so a second click cannot start a second reply in the meantime.
let _groupLaunching = false;
// The member whose custom code was loaded for its turn (see groupUseCardCode).
let _groupCodeSwapped = false;
// One line the bar shows until something newer replaces it: why nobody
// replied, that AUTO stopped, that the DM's answer could not be read. It is
// about one chat, and is not shown in another.
let _groupStatus = '';
let _groupStatusFor = null;
const GROUP_TURN_GAP_MS = 150;

function _groupSay(text) {
  _groupStatus = String(text || '');
  _groupStatusFor = _groupStatus ? (state.activeThreadId || null) : null;
}

function groupSetStatus(text) {
  _groupSay(text);
  try { renderGroupBar(); } catch (e) {}
}

function groupBusy() {
  return isGenerating || _groupLaunching || !!(_groupRound && _groupRound.picking);
}

function groupBeginRound(thread, group, startedBy, forcedCardId) {
  const active = groupActiveMembers(group);
  const round = {
    threadId: thread.id, groupId: group.id, startedBy: startedBy || 'user',
    count: 0, cap: groupRoundCap(group, active.length),
    queue: null, speaking: null, picking: false
  };
  if (round.startedBy === 'force') {
    round.queue = [forcedCardId];
    round.cap = 1;
  } else if (group.order === 'natural') {
    round.queue = groupNaturalQueue(thread, group).slice(0, round.cap);
  } else if (group.order === 'shuffle') {
    round.queue = groupShuffleQueue(thread, group).slice(0, round.cap);
  }
  _groupRound = round;
  return round;
}

/** Who speaks next in `round`, or null when it is over. */
async function groupPick(thread, group, round) {
  if (round.count >= round.cap) return null;
  if (round.queue) {
    const present = groupMembers(group);
    while (round.queue.length) {
      const id = round.queue.shift();
      const p = present.find(x => x.card.id === id);
      // Muted since the round began: passed over. A member you picked
      // yourself speaks, muted or not.
      if (p && (round.startedBy === 'force' || !p.member.muted)) return p.card;
    }
    return null;
  }
  if (group.order === 'manual') return null;
  if (group.order === 'dm') {
    const choice = await groupAskDM(thread, group, round);
    if (_groupRound !== round) return null;
    if (choice && choice.stopped) { round.stopped = true; return null; }
    if (choice && choice.user) { round.endedOn = 'user'; return null; }
    if (choice && choice.card) { _groupSay(''); return choice.card; }
    _groupSay('The DM gave no clear answer, so the turn order decided.');
  }
  const pick = groupListPick(thread, group, round.count);
  if (pick && pick.user) round.endedOn = 'user';
  return (pick && pick.card) || null;
}

async function _groupPickGuarded(thread, group, round) {
  round.picking = true;
  try { renderGroupBar(); } catch (e) {}
  try { return await groupPick(thread, group, round); }
  finally { round.picking = false; }
}

/* Custom code belongs to one character at a time (js/23-card-code.js): what
   is loaded is the active card's. A member's code -- its hooks and its tools
   -- has to be the one loaded while that member replies, and the active
   card's must not run on someone else's turn. So the speaker's is loaded for
   its turn and the active card's is put back when the round ends. A card
   whose code is switched off loads nothing, as ever. */
function groupUseCardCode(card) {
  try {
    if (typeof applyCardCode !== 'function' || typeof _cardCodeCardId === 'undefined' || !card) return;
    if (_cardCodeCardId === card.id) return;
    const hasCode = card.customCodeEnabled && String(card.customCode || '').trim();
    if (!_cardCodeCardId && !hasCode) return;
    applyCardCode(card);
    _groupCodeSwapped = true;
  } catch (e) { console.error('[group] card code:', e); }
}

function groupRestoreCardCode() {
  if (!_groupCodeSwapped) return;
  _groupCodeSwapped = false;
  try { if (typeof applyCardCode === 'function') applyCardCode(); } catch (e) { console.error('[group] card code:', e); }
}

/**
 * Begin a round and say who replies first. Called by sendMessage and
 * regenerateFromThread, which then write that member's reply themselves.
 * Null means nobody replies: manual order, nobody unmuted, the DM handed
 * the turn to you, or Stop was pressed while the DM was choosing.
 *   opts.startedBy  'user' | 'pass' | 'auto' | 'force'
 *   opts.cardId     for 'force', the member picked
 */
async function groupTurnCard(thread, group, opts) {
  opts = opts || {};
  const round = groupBeginRound(thread, group, opts.startedBy, opts.cardId);
  if (round.startedBy !== 'auto') _groupSay('');
  const card = await _groupPickGuarded(thread, group, round);
  if (_groupRound !== round) return null;
  if (!card) {
    _groupRound = null;
    if (round.stopped) groupAutoOff();
    try { renderGroupBar(); } catch (e) {}
    return null;
  }
  round.speaking = card.id;
  groupUseCardCode(card);
  try { renderGroupBar(); } catch (e) {}
  return card;
}

/** The same member writes a rerolled reply again. */
function groupRerollCard(thread, group) {
  const msgs = (thread && thread.messages) || [];
  const last = msgs[msgs.length - 1];
  const id = last && last.role === 'assistant' ? (last.cardId || thread.cardId) : null;
  const card = (state.characterCards || []).find(c => c.id === id) || groupDisplayCard(thread, group);
  if (card) groupUseCardCode(card);
  return card;
}

/** A message was posted and nobody answers it. Says why, in the bar. */
function groupNobodyReplies(thread) {
  if (typeof autoContinue !== 'undefined' && autoContinue) cancelAutoContinue('nobody replies in this group');
  const group = threadGroup(thread);
  if (group && !(_groupStatus && _groupStatusFor === thread.id)) {
    if (!groupMembers(group).length) _groupSay('This group has no characters left: add one in CAST.');
    else if (!groupActiveMembers(group).length) _groupSay('Everyone in this group is muted. Click a member to have them reply.');
    else if (group.order === 'manual') _groupSay('Click a member to have them reply.');
  }
  try { renderGroupBar(); updateInputState(); } catch (e) {}
}

/**
 * A reply in a group chat has finished. Returns false when the reply was
 * not part of a round (a reroll), so the caller carries on as for any
 * chat; true when the round has taken it from here.
 */
function groupAfterReply(thread, msg, ok) {
  const round = _groupRound;
  if (!round || !thread || round.threadId !== thread.id) {
    groupRestoreCardCode();
    return false;
  }
  round.speaking = null;
  if (!ok) { groupEndRound(thread, 'stopped'); return true; }
  round.count++;
  setTimeout(() => {
    groupRunNext(round).catch(e => { console.error('[group] round:', e); groupEndRound(thread, 'error'); });
  }, GROUP_TURN_GAP_MS);
  try { renderGroupBar(); } catch (e) {}
  return true;
}

async function groupRunNext(round) {
  if (_groupRound !== round) return;
  const thread = getActiveThread();
  // A round belongs to the chat on screen: regenerateFromThread writes into
  // that one. Looked away mid-round, and it ends with the reply in progress.
  if (!thread || thread.id !== round.threadId) return groupEndRound(null, 'left');
  const group = threadGroup(thread);
  if (!group || isGenerating || _groupLaunching) return groupEndRound(thread, 'left');
  _groupLaunching = true;
  try {
    const card = await _groupPickGuarded(thread, group, round);
    if (_groupRound !== round) return;
    if (!card) return groupEndRound(thread, round.stopped ? 'stopped' : 'done');
    if (state.activeThreadId !== round.threadId) return groupEndRound(null, 'left');
    round.speaking = card.id;
    groupUseCardCode(card);
    renderGroupBar();
    await regenerateFromThread({ groupCard: card });
    // regenerateFromThread calls groupAfterReply when the reply is done. If
    // it turned back before writing one, nothing did: end the round here.
    if (_groupRound === round && round.speaking === card.id) groupEndRound(thread, 'stopped');
  } finally {
    _groupLaunching = false;
    try { renderGroupBar(); } catch (e) {}
  }
}

function groupEndRound(thread, reason) {
  const round = _groupRound;
  _groupRound = null;
  groupRestoreCardCode();
  if (reason === 'done') {
    // An {{auto_continue_N}} chain sends its next post once the whole round
    // is in, not after each member.
    if (typeof autoContinue !== 'undefined' && autoContinue) {
      try { renderGroupBar(); } catch (e) {}
      maybeContinueChain();
      return;
    }
    groupAutoAfterRound(thread, round);
  } else {
    if (typeof autoContinue !== 'undefined' && autoContinue) cancelAutoContinue('group round ' + reason);
    groupAutoOff();
  }
  try { renderGroupBar(); } catch (e) {}
}

/** The chat on screen changed: a round or AUTO belonging to another one
 *  stops (the reply being written still finishes, as in any chat). */
function groupLeftThread(newThreadId) {
  if (_groupRound && _groupRound.threadId !== newThreadId) {
    _groupRound = null;
    groupRestoreCardCode();
  }
  if (_groupAuto.threadId && _groupAuto.threadId !== newThreadId) groupAutoOff();
  _groupSay('');
}

/** Stop was pressed (js/10-chat.js): AUTO stops with the reply. */
function groupStopRequested() {
  if (_groupAuto.threadId) groupAutoOff();
}

/** Let the next member speak without saying anything yourself: the NEXT
 *  button, and Enter on an empty message box. */
async function groupPass(startedBy) {
  const thread = getActiveThread();
  const group = threadGroup(thread);
  if (!thread || !group || groupBusy()) return;
  groupAutoClearTimer();
  if (group.order === 'manual' && startedBy !== 'auto') {
    groupSetStatus('Click a member to have them reply.');
    return;
  }
  _groupLaunching = true;
  try {
    const card = await groupTurnCard(thread, group, { startedBy: startedBy || 'pass' });
    if (!card) { groupNobodyReplies(thread); if (startedBy === 'auto') groupAutoOff(); return; }
    const round = _groupRound;
    await regenerateFromThread({ groupCard: card });
    if (round && _groupRound === round && round.speaking === card.id) groupEndRound(thread, 'stopped');
  } finally {
    _groupLaunching = false;
    try { renderGroupBar(); } catch (e) {}
  }
}

/** Have one member reply now, whatever the order says and muted or not. */
async function groupTalk(cardId) {
  const thread = getActiveThread();
  const group = threadGroup(thread);
  if (!thread || !group || groupBusy()) return;
  if (!groupMembers(group).some(p => p.card.id === cardId)) return;
  groupAutoClearTimer();
  _groupLaunching = true;
  try {
    const card = await groupTurnCard(thread, group, { startedBy: 'force', cardId: cardId });
    if (!card) return;
    const round = _groupRound;
    await regenerateFromThread({ groupCard: card });
    if (round && _groupRound === round && round.speaking === card.id) groupEndRound(thread, 'stopped');
  } finally {
    _groupLaunching = false;
    try { renderGroupBar(); } catch (e) {}
  }
}

/** Mute or unmute a member from the chat. It applies to the group, so to
 *  every chat with it. */
function groupToggleMute(groupId, cardId) {
  const group = groupById(groupId);
  const m = group && group.members.find(x => x.cardId === cardId);
  if (!m) return;
  m.muted = !m.muted;
  saveState();
  renderGroupBar();
  try { if (typeof renderGroupGrid === 'function') renderGroupGrid(); } catch (e) {}
}

/* ---- AUTO ----------------------------------------------------------
   While AUTO is on, a finished round is followed by another after the
   group's delay, with nobody having to say anything: the characters carry
   on by themselves. It stops when you press it again or Stop, start typing,
   or look at another chat; when a reply fails; and after the same number of
   rounds an {{auto_continue_N}} chain is limited to (CONFIG > Auto-Continue),
   so that a forgotten tab does not keep the model busy for ever. It is never
   saved: a reload starts with it off. */
const _groupAuto = { threadId: null, timer: null, tick: null, secsLeft: 0, rounds: 0 };

function groupAutoClearTimer() {
  if (_groupAuto.timer) clearTimeout(_groupAuto.timer);
  if (_groupAuto.tick) clearInterval(_groupAuto.tick);
  _groupAuto.timer = null; _groupAuto.tick = null; _groupAuto.secsLeft = 0;
}

function groupAutoOff(why) {
  const was = !!_groupAuto.threadId;
  groupAutoClearTimer();
  _groupAuto.threadId = null;
  _groupAuto.rounds = 0;
  if (was && why) _groupSay(why);
  if (was) { try { renderGroupBar(); } catch (e) {} }
}

function toggleGroupAuto() {
  const thread = getActiveThread();
  const group = threadGroup(thread);
  if (!thread || !group) return;
  if (_groupAuto.threadId === thread.id) { groupAutoOff('AUTO is off.'); return; }
  if (group.order === 'manual') { groupSetStatus('AUTO needs an order to follow: this group is set to manual.'); return; }
  groupAutoClearTimer();
  _groupAuto.threadId = thread.id;
  _groupAuto.rounds = 0;
  _groupSay('');
  // Nothing running: start now. A round in progress carries on into AUTO.
  if (!groupBusy() && !_groupRound) groupAutoSchedule(thread, group, 0);
  renderGroupBar();
}

function groupAutoAfterRound(thread, round) {
  if (!thread || _groupAuto.threadId !== thread.id) return;
  const group = threadGroup(thread);
  if (!group || group.order === 'manual') { groupAutoOff(); return; }
  if (round && round.count === 0 && round.startedBy === 'auto') {
    groupAutoOff('AUTO stopped: nobody had anything to add.');
    return;
  }
  groupAutoSchedule(thread, group, group.autoDelaySeconds);
}

function groupAutoSchedule(thread, group, delaySeconds) {
  groupAutoClearTimer();
  const max = (typeof autoContinueMaxChain === 'function') ? autoContinueMaxChain() : 50;
  if (_groupAuto.rounds >= max) {
    groupAutoOff('AUTO stopped after ' + max + ' rounds. Press it again to carry on.');
    return;
  }
  const secs = Math.max(0, parseInt(delaySeconds, 10) || 0);
  _groupAuto.secsLeft = secs;
  if (secs > 0) {
    _groupAuto.tick = setInterval(() => {
      _groupAuto.secsLeft = Math.max(0, _groupAuto.secsLeft - 1);
      try { renderGroupBar(); } catch (e) {}
    }, 1000);
  }
  _groupAuto.timer = setTimeout(() => {
    groupAutoClearTimer();
    if (_groupAuto.threadId !== thread.id || state.activeThreadId !== thread.id) { groupAutoOff(); return; }
    if (groupBusy()) return;   // something else is being written; AUTO picks up after it
    _groupAuto.rounds++;
    groupPass('auto');
  }, secs * 1000);
  try { renderGroupBar(); } catch (e) {}
}

/* ----------------------------------------------------------------
   The card a group chat stands for where the app wants one: the context
   meter, and the conversation's background.
---------------------------------------------------------------- */

/** Whoever is replying, or will next; otherwise the first member. */
function groupDisplayCard(thread, group) {
  group = group || threadGroup(thread);
  if (!group || !thread) return null;
  const present = groupMembers(group);
  if (!present.length) return null;
  if (_groupRound && _groupRound.threadId === thread.id && _groupRound.speaking) {
    const p = present.find(x => x.card.id === _groupRound.speaking);
    if (p) return p.card;
  }
  if (group.order === 'list') {
    const pick = groupListPick(thread, group, 0);
    if (pick && pick.card) return pick.card;
  }
  return (present.find(p => !p.member.muted) || present[0]).card;
}

/** The character a conversation's next reply comes from. */
function replyCardForThread(thread) {
  const group = (typeof threadGroup === 'function') ? threadGroup(thread) : null;
  return (group && groupDisplayCard(thread, group)) || getActiveCard();
}

/* ----------------------------------------------------------------
   5. THE BAR IN THE CHAT
---------------------------------------------------------------- */

function _groupFaceNode(avatar, name) {
  const face = document.createElement('span');
  face.className = 'group-face';
  const src = safeImageUrl(avatar);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    face.appendChild(img);
  } else {
    face.textContent = String(name || '?').charAt(0).toUpperCase();
  }
  return face;
}

/** A group's picture: its own, or up to four of its members' faces. */
function groupAvatarNode(group) {
  const el = document.createElement('div');
  el.className = 'group-avatar';
  const src = safeImageUrl(group.avatar);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    el.appendChild(img);
    return el;
  }
  const faces = groupMembers(group).slice(0, 4);
  if (!faces.length) { el.textContent = String(group.name || '?').charAt(0).toUpperCase(); return el; }
  el.classList.add('group-avatar-stack', 'group-avatar-n' + faces.length);
  for (const p of faces) el.appendChild(_groupFaceNode(p.card.avatar, p.card.name));
  return el;
}

const GROUP_ORDER_LABELS = {
  list: 'turn order', natural: 'natural order', shuffle: 'shuffled',
  manual: 'manual', dm: 'DM decides'
};

/** What the bar says when nothing else is going on. */
function _groupIdleStatus(thread, group, next) {
  const active = groupActiveMembers(group);
  if (!groupMembers(group).length) return 'This group has no characters left: add one in CAST.';
  if (!active.length) return 'Everyone is muted. Click a member to have them reply.';
  switch (group.order) {
    case 'manual': return 'Manual: click a member to have them reply.';
    case 'natural': return 'Natural order: whoever you name replies, then whoever is talkative.';
    case 'shuffle': return 'Shuffled: everyone replies once, in a random order.';
    case 'dm': return 'The DM decides who replies.';
  }
  if (next && next.card) {
    return (group.userInOrder ? 'Your turn. Then: ' : 'Next: ') + (next.card.name || 'Unnamed');
  }
  return '';
}

let _groupInputHooked = false;
function _groupHookInput() {
  if (_groupInputHooked) return;
  const input = document.getElementById('msg-input');
  if (!input || typeof input.addEventListener !== 'function') return;
  _groupInputHooked = true;
  // Typing takes the conversation back: AUTO stops, as it does elsewhere.
  input.addEventListener('input', () => {
    if (_groupAuto.threadId && String(input.value || '').trim()) groupAutoOff('You started typing, so AUTO stopped.');
  });
}

function renderGroupBar() {
  const bar = document.getElementById('group-bar');
  if (!bar) return;
  const thread = getActiveThread();
  const group = (thread && typeof threadGroup === 'function') ? threadGroup(thread) : null;

  if (!thread || !group) {
    // A chat whose group was deleted says so, once, where the bar was.
    if (thread && thread.groupId) {
      bar.replaceChildren();
      const note = document.createElement('div');
      note.className = 'group-bar-status';
      note.textContent = 'The group this chat was started with' +
        (thread.groupName ? ' (' + thread.groupName + ')' : '') +
        ' was deleted, so the active character replies here now.';
      bar.appendChild(note);
      bar.style.display = '';
    } else if (bar.style.display !== 'none') {
      bar.style.display = 'none';
      bar.replaceChildren();
    }
    return;
  }
  _groupHookInput();

  const focusKey = (document.activeElement && bar.contains && bar.contains(document.activeElement))
    ? document.activeElement.getAttribute('data-gkey') : null;
  const busy = groupBusy();
  const round = (_groupRound && _groupRound.threadId === thread.id) ? _groupRound : null;
  const auto = _groupAuto.threadId === thread.id;
  const present = groupMembers(group);
  const next = (!round && group.order === 'list') ? groupListPick(thread, group, 0) : null;
  const yourTurn = !busy && !round && !auto && group.userInOrder && group.order === 'list' && !!(next && next.card);

  bar.replaceChildren();
  const row = document.createElement('div');
  row.className = 'group-bar-row';

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'group-bar-name';
  title.setAttribute('data-gkey', 'name');
  title.title = 'Edit this group: members, turn order, DM';
  title.textContent = '👥 ' + group.name;
  title.addEventListener('click', () => openGroupEditor(group.id));
  row.appendChild(title);

  const chips = document.createElement('div');
  chips.className = 'group-bar-members';
  const slot = group.userInOrder ? present.filter(p => p.index < group.userSlot).length : -1;
  const userChip = () => {
    const chip = document.createElement('span');
    chip.className = 'group-chip group-chip-user' + (yourTurn ? ' group-chip-next' : '');
    chip.appendChild(_groupFaceNode(getActivePersona().avatar, getActivePersona().name));
    const label = document.createElement('span');
    label.className = 'group-chip-label';
    label.textContent = 'You';
    chip.appendChild(label);
    chip.title = 'Your place in the turn order: the round stops here for you';
    return chip;
  };
  present.forEach((p, i) => {
    if (slot === i) chips.appendChild(userChip());
    const name = p.card.name || 'Unnamed';
    const speaking = !!(round && round.speaking === p.card.id);
    const isNext = !yourTurn && !busy && !round && !!(next && next.card && next.card.id === p.card.id);
    const chip = document.createElement('span');
    chip.className = 'group-chip' + (p.member.muted ? ' group-chip-muted' : '') +
      (speaking ? ' group-chip-speaking' : '') + (isNext ? ' group-chip-next' : '');

    const talk = document.createElement('button');
    talk.type = 'button';
    talk.className = 'group-chip-talk';
    talk.setAttribute('data-gkey', 'talk:' + p.card.id);
    talk.disabled = busy;
    talk.title = 'Have ' + name + ' reply now' + (p.member.muted ? ' (muted: skipped otherwise)' : '');
    talk.setAttribute('aria-label', talk.title);
    talk.appendChild(_groupFaceNode(p.card.avatar, name));
    const label = document.createElement('span');
    label.className = 'group-chip-label';
    label.textContent = name;
    talk.appendChild(label);
    talk.addEventListener('click', () => groupTalk(p.card.id));
    chip.appendChild(talk);

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'group-chip-mute';
    mute.setAttribute('data-gkey', 'mute:' + p.card.id);
    mute.setAttribute('aria-pressed', p.member.muted ? 'true' : 'false');
    mute.title = p.member.muted
      ? 'Unmute ' + name + ': takes turns again'
      : 'Mute ' + name + ': stays in the chat but is not picked to reply';
    mute.setAttribute('aria-label', mute.title);
    mute.textContent = p.member.muted ? '🔇' : '🔈';
    mute.addEventListener('click', () => groupToggleMute(group.id, p.card.id));
    chip.appendChild(mute);
    chips.appendChild(chip);
  });
  if (slot === present.length && slot >= 0) chips.appendChild(userChip());
  row.appendChild(chips);

  const controls = document.createElement('div');
  controls.className = 'group-bar-controls';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn-sm group-next-btn';
  nextBtn.setAttribute('data-gkey', 'next');
  nextBtn.textContent = '▶ NEXT';
  nextBtn.disabled = busy || group.order === 'manual' || !groupActiveMembers(group).length;
  nextBtn.title = group.order === 'manual'
    ? 'Manual order: click a member instead'
    : 'Let the next member reply without saying anything yourself (Enter on an empty message does the same)';
  nextBtn.addEventListener('click', () => groupPass('pass'));
  controls.appendChild(nextBtn);

  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'btn btn-sm group-auto-btn' + (auto ? ' btn-fill' : '');
  autoBtn.setAttribute('data-gkey', 'auto');
  autoBtn.setAttribute('aria-pressed', auto ? 'true' : 'false');
  autoBtn.textContent = auto ? 'AUTO ON' : 'AUTO';
  autoBtn.disabled = group.order === 'manual';
  autoBtn.title = 'The members keep talking, round after round, until you press this again, press Stop or start typing';
  autoBtn.addEventListener('click', () => toggleGroupAuto());
  controls.appendChild(autoBtn);
  row.appendChild(controls);
  bar.appendChild(row);

  let status = '';
  const said = (_groupStatus && _groupStatusFor === thread.id) ? _groupStatus : '';
  if (round && round.picking) status = said || 'Choosing who speaks…';
  else if (round && round.speaking) {
    const who = present.find(p => p.card.id === round.speaking);
    status = (who ? (who.card.name || 'Unnamed') : 'Someone') + ' is replying…';
    // Who is queued behind them, for the orders that settle a round up front;
    // otherwise how far through the round this is.
    const queued = (round.queue || [])
      .map(id => present.find(p => p.card.id === id))
      .filter(p => p && !p.member.muted)
      .map(p => p.card.name || 'Unnamed');
    if (queued.length) status += ' Then: ' + queued.join(', ') + '.';
    else if (!round.queue && round.cap > 1) status += ' (' + (round.count + 1) + ' of up to ' + round.cap + ')';
  } else if (auto && _groupAuto.timer) {
    status = 'AUTO: the next round starts' + (_groupAuto.secsLeft > 0 ? ' in ' + _groupAuto.secsLeft + ' s' : ' now') + '.';
  } else if (said) status = said;
  else status = _groupIdleStatus(thread, group, next);

  const line = document.createElement('div');
  line.className = 'group-bar-status';
  line.setAttribute('role', 'status');
  line.textContent = status;
  bar.appendChild(line);
  bar.style.display = '';

  if (focusKey) {
    const again = Array.from(bar.querySelectorAll('[data-gkey]')).find(el => el.getAttribute('data-gkey') === focusKey);
    if (again && !again.disabled) { try { again.focus({ preventScroll: true }); } catch (e) {} }
  }
}

/* ----------------------------------------------------------------
   6. STARTING A CHAT
---------------------------------------------------------------- */

/** Start a chat with a group; says why not when it has nobody in it. */
function startGroupChat(groupId) {
  if (typeof closePopover === 'function') closePopover();
  const group = groupById(groupId);
  if (!group) return null;
  if (!groupMembers(group).length) {
    openGroupEditor(group.id);
    _groupEditorNote('Add at least one character, then SAVE, to chat with this group.');
    return null;
  }
  const modal = document.getElementById('char-modal');
  if (modal && modal.classList.contains('open')) {
    if (typeof charDismissGuard === 'function' && !charDismissGuard()) return null;
    closeCharacters();
  }
  return createGroupThread(groupId);
}

/** The + GROUP button: your groups to start a chat with, and a way to make
 *  one. With no groups yet it goes straight to a new one. */
function openGroupPicker(event) {
  if (event) event.stopPropagation();
  const groups = Array.isArray(state.groups) ? state.groups : [];
  if (!groups.length) { openCharacters(); createGroup(); return; }
  closePopover();
  const anchor = event && event.currentTarget;
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { bottom: 60, left: 12, top: 40 };
  const pop = document.createElement('div');
  pop.className = 'sidebar-popover group-picker';
  const list = document.createElement('div');
  list.className = 'pop-list';
  const hint = document.createElement('div');
  hint.className = 'pop-hint';
  hint.textContent = 'Start a chat with:';
  list.appendChild(hint);
  for (const g of groups) {
    const present = groupMembers(g);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pop-item group-picker-item';
    item.appendChild(groupAvatarNode(g));
    const text = document.createElement('span');
    text.className = 'group-picker-text';
    const name = document.createElement('span');
    name.className = 'group-picker-name';
    name.textContent = g.name;
    const who = document.createElement('span');
    who.className = 'group-picker-who';
    who.textContent = present.length
      ? present.map(p => p.card.name || 'Unnamed').join(', ')
      : 'no characters yet';
    text.appendChild(name);
    text.appendChild(who);
    item.appendChild(text);
    item.addEventListener('click', () => startGroupChat(g.id));
    list.appendChild(item);
  }
  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'pop-item';
  make.textContent = '+ New group…';
  make.addEventListener('click', () => { closePopover(); openCharacters(); createGroup(); });
  list.appendChild(make);
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'pop-item';
  manage.textContent = 'Manage groups…';
  manage.addEventListener('click', () => { closePopover(); openCharacters(); _groupScrollToGrid(); });
  list.appendChild(manage);
  pop.appendChild(list);
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = rect.left + 'px';
  document.body.appendChild(pop);
  _popover = pop;
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
    if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, rect.top - pr.height - 4) + 'px';
  });
}

function _groupScrollToGrid() {
  const grid = document.getElementById('group-grid');
  if (grid && grid.scrollIntoView) { try { grid.scrollIntoView({ block: 'center' }); } catch (e) {} }
}

/** The home screen's YOUR GROUPS section, or '' with no groups. Built as
 *  markup, like the rest of that page, with every value escaped. */
function landingGroupsHtml() {
  const groups = Array.isArray(state.groups) ? state.groups : [];
  if (!groups.length) return '';
  const tiles = groups.map(g => {
    const present = groupMembers(g);
    const faces = present.slice(0, 4).map(p =>
      `<span class="group-face">${renderAvatar(p.card.avatar, p.card.name)}</span>`).join('');
    const own = safeImageUrl(g.avatar);
    const avatar = own
      ? `<div class="group-avatar"><img src="${escapeHtml(own)}" alt=""></div>`
      : `<div class="group-avatar group-avatar-stack group-avatar-n${Math.min(4, present.length) || 1}">${faces || escapeHtml(String(g.name || '?').charAt(0).toUpperCase())}</div>`;
    const who = present.length ? present.map(p => p.card.name || 'Unnamed').join(', ') : 'no characters yet';
    return `
      <div class="landing-char-card landing-group-card" onclick="startGroupChat('${escapeJsAttr(g.id)}')" title="Start a chat with this group">
        ${avatar}
        <div class="landing-char-info">
          <div class="landing-char-name">${escapeHtml(g.name)}</div>
          <div class="landing-char-desc">${escapeHtml(who)}</div>
        </div>
        <span class="landing-char-badge landing-group-badge">+ CHAT</span>
      </div>`;
  }).join('');
  return `
      <div class="landing-section">
        <div class="landing-section-header">
          <span>&#128101; YOUR GROUPS</span>
          <button class="btn btn-sm" onclick="openCharacters()">Manage</button>
        </div>
        <div class="landing-group-list">${tiles}</div>
      </div>`;
}

/* ----------------------------------------------------------------
   7. CAST: THE GROUPS LIST AND ITS EDITOR
---------------------------------------------------------------- */

let editingGroupId = null;
// The member list as it stands in the open editor; written to the group on
// SAVE. { members: [{cardId, muted, talk}], userInOrder, userSlot }
let _groupDraft = null;

function _groupSummary(group) {
  const present = groupMembers(group);
  const names = present.map(p => p.card.name || 'Unnamed');
  const gone = group.members.length - present.length;
  let who = names.length ? names.join(', ') : 'no characters yet';
  if (gone > 0) who += ' (+' + gone + ' deleted)';
  return who + ' · ' + (GROUP_ORDER_LABELS[group.order] || group.order) +
    (group.userInOrder ? ' · you take a turn' : '');
}

function _groupActionBtn(label, title, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-action-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
  return b;
}

function _groupMoveColumn(name, idx, total, onMove) {
  const col = document.createElement('div');
  col.className = 'card-move';
  for (const [dir, delta, glyph] of [['up', -1, '▲'], ['down', 1, '▼']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card-move-btn';
    b.setAttribute('data-move', dir);
    b.disabled = dir === 'up' ? idx === 0 : idx === total - 1;
    b.title = 'Move ' + dir;
    b.setAttribute('aria-label', 'Move ' + name + ' ' + dir);
    b.textContent = glyph;
    b.addEventListener('click', (e) => { e.stopPropagation(); onMove(delta, b); });
    col.appendChild(b);
  }
  return col;
}

function renderGroupGrid() {
  const grid = document.getElementById('group-grid');
  if (!grid) return;
  const groups = Array.isArray(state.groups) ? state.groups : [];
  grid.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'landing-empty';
    empty.style.padding = '10px 4px';
    empty.textContent = 'No groups yet. A group puts several of your characters in one chat.';
    grid.appendChild(empty);
    return;
  }
  groups.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'card-item';
    row.title = 'Edit this group';
    row.addEventListener('click', () => editGroup(g.id));
    if (groups.length > 1) {
      row.appendChild(_groupMoveColumn(g.name, i, groups.length, (delta, btn) =>
        moveCastEntry(state.groups, g.id, delta, 'group-grid', renderGroupGrid, btn)));
    }
    const av = document.createElement('div');
    av.className = 'card-avatar';
    av.appendChild(groupAvatarNode(g));
    row.appendChild(av);
    const info = document.createElement('div');
    info.className = 'card-info';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = g.name;
    const desc = document.createElement('div');
    desc.className = 'card-desc';
    desc.textContent = _groupSummary(g);
    info.appendChild(name);
    info.appendChild(desc);
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(_groupActionBtn('Chat', 'Start a chat with this group', 'btn-branch', () => startGroupChat(g.id)));
    actions.appendChild(_groupActionBtn('Edit', '', 'btn-edit', () => editGroup(g.id)));
    actions.appendChild(_groupActionBtn('Copy', 'Duplicate this group', '', () => copyGroup(g.id)));
    actions.appendChild(_groupActionBtn('Save', 'Export this group and its characters as JSON; DATA > Import > Characters reads it back', '', () => exportGroup(g.id)));
    actions.appendChild(_groupActionBtn('Del', 'Delete this group (its characters and chats are kept)', 'btn-delete', () => deleteGroupById(g.id)));
    row.appendChild(actions);
    grid.appendChild(row);
  });
}

function _groupShowEditor(show) {
  const ids = { 'char-modal-list': !show, 'group-editor': show, 'char-close-row': !show };
  for (const id of Object.keys(ids)) {
    const el = document.getElementById(id);
    if (el) el.style.display = ids[id] ? '' : 'none';
  }
  if (show) {
    for (const id of ['card-editor', 'persona-editor']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  }
}

function _groupEditorNote(text) {
  const el = document.getElementById('group-editor-note');
  if (el) el.textContent = String(text || '');
}

function createGroup() {
  if (!Array.isArray(state.groups)) state.groups = [];
  const group = normalizeGroup({ ...DEFAULT_GROUP, id: generateId(), name: 'New Group' });
  state.groups.push(group);
  saveState();
  editGroup(group.id);
}

/** Open CAST on one group's editor, from the chat. */
function openGroupEditor(groupId) {
  const modal = document.getElementById('char-modal');
  if (!modal || !modal.classList.contains('open')) openCharacters();
  editGroup(groupId);
}

function editGroup(id) {
  const group = groupById(id);
  if (!group) return;
  editingGroupId = id;
  _groupDraft = {
    members: group.members.map(m => ({ cardId: m.cardId, muted: !!m.muted, talk: m.talk })),
    userInOrder: !!group.userInOrder,
    userSlot: Math.min(group.userSlot || 0, group.members.length)
  };
  const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v; };
  const check = (elId, v) => { const el = document.getElementById(elId); if (el) el.checked = !!v; };
  set('group-name', group.name || '');
  set('group-avatar', group.avatar || '');
  set('group-order', group.order);
  set('group-dm-instructions', group.dmInstructions || '');
  set('group-max-replies', group.maxReplies || 0);
  check('group-allow-self', group.allowSelf);
  set('group-scenario', group.scenario || '');
  set('group-introduce', group.introduce);
  set('group-greetings', group.greetings);
  check('group-stop-on-others', group.stopOnOthers !== false);
  set('group-auto-delay', group.autoDelaySeconds);
  check('group-user-in-order', _groupDraft.userInOrder);
  _groupEditorNote('');
  _groupShowEditor(true);
  try { previewAvatar('group-avatar', 'group-avatar-preview'); } catch (e) {}
  renderGroupMemberList();
  groupEditorOrderChanged();
  // The list this replaces was scrolled down to reach the groups, and the
  // editor is longer than the window: open it at its top, on the name.
  const ed = document.getElementById('group-editor');
  const box = ed && typeof ed.closest === 'function' ? ed.closest('.modal') : null;
  if (box) box.scrollTop = 0;
  // Clean snapshot once the fields are filled: the editors' shared contract
  // (charEditorOpened in js/22-scheduler.js).
  if (typeof charEditorOpened === 'function') charEditorOpened();
}

/** The draft, as the rows the editor shows: members with "you" among them. */
function _groupDraftRows() {
  const d = _groupDraft;
  const rows = d.members.map(m => ({ member: m }));
  if (d.userInOrder) rows.splice(Math.min(Math.max(0, d.userSlot), rows.length), 0, { user: true });
  return rows;
}

function _groupDraftFromRows(rows) {
  const d = _groupDraft;
  d.members = rows.filter(r => r.member).map(r => r.member);
  const at = rows.findIndex(r => r.user);
  if (at >= 0) d.userSlot = rows.slice(0, at).filter(r => r.member).length;
  d.userSlot = Math.min(d.userSlot, d.members.length);
}

function _groupDraftChanged() {
  // The hidden field carries the member list for the unsaved-changes check,
  // which reads every field in the open editor (js/22-scheduler.js).
  const hidden = document.getElementById('group-members-json');
  if (hidden) hidden.value = JSON.stringify(_groupDraft);
  renderGroupMemberList();
}

function renderGroupMemberList() {
  const list = document.getElementById('group-member-list');
  if (!list || !_groupDraft) return;
  const hidden = document.getElementById('group-members-json');
  if (hidden) hidden.value = JSON.stringify(_groupDraft);
  const byId = new Map((state.characterCards || []).map(c => [c.id, c]));
  const orderEl = document.getElementById('group-order');
  const natural = !!orderEl && orderEl.value === 'natural';
  const rows = _groupDraftRows();
  list.replaceChildren();

  if (!_groupDraft.members.length) {
    const empty = document.createElement('div');
    empty.className = 'form-hint';
    empty.textContent = 'Nobody yet. Add characters below.';
    list.appendChild(empty);
  }
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'group-member-row' + (r.user ? ' group-member-user' : '') +
      (r.member && r.member.muted ? ' group-member-muted' : '');
    const card = r.member ? byId.get(r.member.cardId) : null;
    const name = r.user ? 'You' : (card ? (card.name || 'Unnamed') : 'Deleted character');
    if (rows.length > 1) {
      row.appendChild(_groupMoveColumn(name, i, rows.length, (delta) => {
        const to = i + delta;
        if (to < 0 || to >= rows.length) return;
        const moved = rows.splice(i, 1)[0];
        rows.splice(to, 0, moved);
        _groupDraftFromRows(rows);
        _groupDraftChanged();
      }));
    }
    const num = document.createElement('span');
    num.className = 'group-member-num';
    num.textContent = String(i + 1);
    row.appendChild(num);

    if (r.user) {
      const persona = getActivePersona();
      row.appendChild(_groupFaceNode(persona.avatar, persona.name));
      const label = document.createElement('span');
      label.className = 'group-member-name';
      label.textContent = 'You (' + (persona.name || 'Anonymous') + ')';
      row.appendChild(label);
      const note = document.createElement('span');
      note.className = 'group-member-note';
      note.textContent = 'the round stops here for you';
      row.appendChild(note);
      list.appendChild(row);
      return;
    }

    row.appendChild(_groupFaceNode(card ? card.avatar : '', name));
    const label = document.createElement('span');
    label.className = 'group-member-name';
    label.textContent = name;
    if (!card) label.title = 'This character was deleted. It is skipped; remove it, or bring the character back.';
    row.appendChild(label);

    if (natural && card) {
      const talkWrap = document.createElement('label');
      talkWrap.className = 'group-member-talk';
      talkWrap.title = 'How readily ' + name + ' joins in when nobody names them';
      const talkText = document.createElement('span');
      const talkLabel = (v) => v <= 20 ? 'quiet' : v >= 80 ? 'chatty' : 'normal';
      talkText.textContent = talkLabel(r.member.talk);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0'; range.max = '100'; range.step = '5';
      range.value = String(r.member.talk);
      range.setAttribute('aria-label', 'Talkativeness of ' + name);
      range.addEventListener('input', () => {
        r.member.talk = Math.min(100, Math.max(0, parseInt(range.value, 10) || 0));
        talkText.textContent = talkLabel(r.member.talk);
        const h = document.getElementById('group-members-json');
        if (h) h.value = JSON.stringify(_groupDraft);
      });
      talkWrap.appendChild(range);
      talkWrap.appendChild(talkText);
      row.appendChild(talkWrap);
    }

    const muteWrap = document.createElement('label');
    muteWrap.className = 'group-member-mute';
    muteWrap.title = 'Muted: stays in the chat but is not picked to reply';
    const mute = document.createElement('input');
    mute.type = 'checkbox';
    mute.checked = !!r.member.muted;
    mute.setAttribute('aria-label', 'Mute ' + name);
    mute.addEventListener('change', () => { r.member.muted = mute.checked; _groupDraftChanged(); });
    const muteText = document.createElement('span');
    muteText.textContent = 'muted';
    muteWrap.appendChild(mute);
    muteWrap.appendChild(muteText);
    row.appendChild(muteWrap);

    row.appendChild(_groupActionBtn('×', 'Remove ' + name + ' from this group', 'btn-delete', () => {
      const idx = _groupDraft.members.indexOf(r.member);
      if (idx < 0) return;
      _groupDraft.members.splice(idx, 1);
      if (_groupDraft.userSlot > idx) _groupDraft.userSlot--;
      _groupDraftChanged();
    }));
    list.appendChild(row);
  });

  // The characters that can still be added.
  const select = document.getElementById('group-add-select');
  if (select) {
    const have = new Set(_groupDraft.members.map(m => m.cardId));
    const free = (state.characterCards || []).filter(c => !have.has(c.id));
    select.replaceChildren();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = free.length ? 'Choose a character…' : 'Every character is already in this group';
    select.appendChild(first);
    for (const c of free) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || 'Unnamed';
      select.appendChild(opt);
    }
    select.disabled = !free.length || _groupDraft.members.length >= GROUP_LIMITS.members;
  }
}

function groupEditorAddMember() {
  const select = document.getElementById('group-add-select');
  if (!select || !_groupDraft || !select.value) return;
  if (_groupDraft.members.length >= GROUP_LIMITS.members) {
    _groupEditorNote('A group holds up to ' + GROUP_LIMITS.members + ' characters.');
    return;
  }
  if (_groupDraft.members.some(m => m.cardId === select.value)) return;
  // You stay last if you were last: a new member goes in ahead of you.
  const youLast = _groupDraft.userInOrder && _groupDraft.userSlot >= _groupDraft.members.length;
  _groupDraft.members.push({ cardId: select.value, muted: false, talk: 50 });
  if (youLast) _groupDraft.userSlot = _groupDraft.members.length;
  _groupEditorNote('');
  _groupDraftChanged();
}

function groupEditorAddAll() {
  if (!_groupDraft) return;
  const have = new Set(_groupDraft.members.map(m => m.cardId));
  const youLast = _groupDraft.userInOrder && _groupDraft.userSlot >= _groupDraft.members.length;
  for (const c of (state.characterCards || [])) {
    if (have.has(c.id) || _groupDraft.members.length >= GROUP_LIMITS.members) continue;
    _groupDraft.members.push({ cardId: c.id, muted: false, talk: 50 });
  }
  if (youLast) _groupDraft.userSlot = _groupDraft.members.length;
  _groupDraftChanged();
}

function groupEditorToggleUser() {
  const el = document.getElementById('group-user-in-order');
  if (!el || !_groupDraft) return;
  _groupDraft.userInOrder = !!el.checked;
  // A place at the end to start with: everyone replies, then it is your turn.
  if (_groupDraft.userInOrder) _groupDraft.userSlot = _groupDraft.members.length;
  _groupDraftChanged();
}

const GROUP_ORDER_HINTS = {
  list: 'The members reply one after another, top to bottom, carrying on after whoever spoke last.',
  natural: 'Members you name reply first; the others join in by their talkativeness, and one always replies.',
  shuffle: 'Every member replies once per round, in a new random order each time.',
  dm: 'Before each reply, a short extra request asks the model who is best to respond next.',
  manual: 'Nobody replies until you click a member in the chat; NEXT and AUTO are off.'
};

function groupEditorOrderChanged() {
  const el = document.getElementById('group-order');
  const order = el ? el.value : 'list';
  const hint = document.getElementById('group-order-hint');
  if (hint) hint.textContent = GROUP_ORDER_HINTS[order] || '';
  const show = (id, on) => { const x = document.getElementById(id); if (x) x.style.display = on ? '' : 'none'; };
  show('group-dm-wrap', order === 'dm');
  show('group-replies-wrap', order !== 'manual');
  show('group-self-wrap', order === 'natural' || order === 'shuffle' || order === 'dm');
  show('group-auto-wrap', order !== 'manual');
  renderGroupMemberList();
}

function _groupCloseEditor() {
  editingGroupId = null;
  _groupDraft = null;
  if (typeof charEditorClosed === 'function') charEditorClosed();
  _groupShowEditor(false);
  renderCardGrid();
  renderPersonaGrid();
  renderGroupGrid();
}

function saveGroup() {
  const group = groupById(editingGroupId);
  if (!group || !_groupDraft) return;
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  const checked = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
  const next = normalizeGroup({
    id: group.id,
    name: val('group-name'),
    avatar: val('group-avatar').trim(),
    members: _groupDraft.members,
    userInOrder: _groupDraft.userInOrder,
    userSlot: _groupDraft.userSlot,
    order: val('group-order'),
    maxReplies: val('group-max-replies'),
    allowSelf: checked('group-allow-self'),
    dmInstructions: val('group-dm-instructions'),
    scenario: val('group-scenario'),
    introduce: val('group-introduce'),
    greetings: val('group-greetings'),
    stopOnOthers: checked('group-stop-on-others'),
    autoDelaySeconds: val('group-auto-delay')
  });
  if (!next) return;
  Object.assign(group, next);
  saveState();
  _groupCloseEditor();
  try { render(); } catch (e) {}
}

function cancelGroupEdit() {
  if (typeof charDismissGuard === 'function' && !charDismissGuard()) return;
  // A group made a moment ago and left untouched is not kept.
  const group = groupById(editingGroupId);
  if (group && !group.members.length && group.name === 'New Group' && !group.scenario) {
    state.groups = state.groups.filter(g => g.id !== editingGroupId);
    saveState();
  }
  _groupCloseEditor();
}

/** UNDO for a deleted group. Its chats were never touched: they find the
 *  group again by id. */
function _offerGroupUndo(group, at) {
  undoable({
    label: 'Deleted group "' + String(group.name || 'Unnamed').slice(0, 40) + '"',
    undo: () => {
      if (!Array.isArray(state.groups)) state.groups = [];
      if (!state.groups.some(g => g.id === group.id)) {
        state.groups.splice(Math.min(at, state.groups.length), 0, group);
      }
      try { renderGroupGrid(); render(); } catch (e) {}
    },
  });
}

function deleteGroupById(id) {
  const at = (state.groups || []).findIndex(g => g.id === id);
  if (at < 0) return;
  const group = state.groups[at];
  state.groups = state.groups.filter(g => g.id !== id);
  if (_groupRound && _groupRound.groupId === id) { _groupRound = null; groupRestoreCardCode(); }
  saveState();
  renderGroupGrid();
  try { render(); } catch (e) {}
  _offerGroupUndo(group, at);
}

function deleteGroup() {
  const id = editingGroupId;
  if (!id) return;
  _groupCloseEditor();
  deleteGroupById(id);
}

function copyGroup(id) {
  const src = groupById(id);
  if (!src) return;
  const copy = normalizeGroup({ ...JSON.parse(JSON.stringify(src)), id: generateId(), name: (src.name + ' (Copy)').slice(0, GROUP_LIMITS.name) });
  state.groups.push(copy);
  saveState();
  renderGroupGrid();
}

/* ----------------------------------------------------------------
   8. CATCHING UP WITH THE FIRST RENDER
   This file loads after js/24-boot.js, whose first render waits only on
   the saved state and one fetch. On a slow connection that render can run
   before this file has, and its calls here (all behind typeof checks) then
   did nothing: no group bar, no YOUR GROUPS on the home screen. Once boot
   is done, draw what they would have. Usually there is nothing to do.
---------------------------------------------------------------- */
function _groupCatchUp() {
  try {
    renderGroupBar();
    const groups = Array.isArray(state.groups) ? state.groups : [];
    if (groups.length && !state.activeThreadId && !document.querySelector('.landing-group-list')) render();
  } catch (e) { console.error('[group] catch-up:', e); }
}

try {
  if (typeof window !== 'undefined' && window.GobboNet && window.GobboNet.ready &&
      typeof window.GobboNet.ready.then === 'function') {
    window.GobboNet.ready.then(_groupCatchUp, () => {});
  }
} catch (e) { /* no boot promise (a test harness): nothing to catch up with */ }
