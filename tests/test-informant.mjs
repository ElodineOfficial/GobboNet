/**
 * 1.7.9 F5 — the Gobbonet Informant, rewritten for 1.7.9 as shipped
 * (default-characters.json), and UPDATE for a default character already
 * added (js/14-scroll.js, js/13-dashboard.js).
 *
 * A. The card loads: valid JSON, installable, the three defaults present.
 * B. Under budget: small enough to sit in a 4,096-token context beside a
 *    conversation, by the app's own token estimate.
 * C. It names every 1.7.9 feature: UNDO, the tour, the CONFIG sections and
 *    search, mods and endorsed mods, the catalogue and found models, phones.
 * D. The rule: it answers from its notes and says "I don't know, check
 *    TROUBLESHOOTING.md" rather than guessing -- said first and last.
 * E. Every on-screen name it quotes exists in the page, and the claims the
 *    1.7.8 text got wrong are gone.
 * F. UPDATE: a default character already added, whose prompt differs from
 *    the shipped one, is updated in place (the user's look and extras kept)
 *    with UNDO; one already up to date is left alone; no blocking alert.
 * G. Notes in the page the rewrite found stale.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const HTML = read('chat.html');
const JS = fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js')).map(f => read('js/' + f)).join('\n');
const decode = s => s.replace(/&amp;/g, '&').replace(/&hellip;/g, '…').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const UI = decode(HTML) + '\n' + JS;
const VERSION = read('VERSION').trim();

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + String(extra).slice(0, 500) : '')); }
};

console.log('\n=== A. the card loads ===');
let cards = [];
try { cards = JSON.parse(read('default-characters.json')); } catch (e) { ok(false, 'default-characters.json is valid JSON', e.message); }
ok(Array.isArray(cards) && ['CodeGoblin', 'Gobbonet Informant', 'The DM'].every(n => cards.some(c => c.name === n)), 'the three default characters are there');
const inf = cards.find(c => c.name === 'Gobbonet Informant') || {};
const style = String(inf.writingStyle || ''), pers = String(inf.personality || '');
ok(style && pers && inf.icon && inf.desc && inf.desc.length <= 72, 'the Informant has a prompt, a personality, an icon and a description that fits its tile');
ok(typeof inf.temperature === 'number' && inf.temperature <= 0.4, `a low temperature (${inf.temperature}), so a small model sticks to its notes`);
// The release it describes is VERSION's (1.8.0: it was a literal 1.7.9 until
// the bump, which left the check behind for the next one to trip on).
ok(style.includes('GobboNet ' + VERSION + ',') && inf.desc.includes('GobboNet ' + VERSION + '.'), `it says which GobboNet it describes (${VERSION})`, inf.desc);

console.log('\n=== B. under budget ===');
{
  // The app's own estimate (js/07-prompt.js), so this matches the context meter.
  const ctx = {};
  vm.createContext(ctx);
  const p = read('js/07-prompt.js');
  vm.runInContext(p.slice(p.indexOf('function estimateTokens('), p.indexOf('function estimateMessagesTokens(')), ctx);
  const tokens = ctx.estimateTokens(style) + 4 + ctx.estimateTokens(pers) + 4;
  ok(tokens <= 1500, `prompt and personality are about ${tokens} tokens (budget 1,500)`);
  ok(4096 - tokens >= 2500, `a 4,096-token context keeps ${4096 - tokens} for the conversation and the reply`);
  ok(style.length <= 6000, `${style.length} characters (1.7.8's was 7,248)`);
}

console.log('\n=== C. it names every 1.7.9 and 1.8.0 feature ===');
{
  const want = {
    'UNDO (step 9)': ['UNDO', 'Ctrl+Z', '10 seconds'],
    'the tour (step 11)': ['SHOW ME AROUND'],
    'CONFIG sections and search (step 10)': ['Basics', 'Characters & Chat', 'Model & Performance', 'Devices & Network', 'Advanced', 'Find a setting'],
    'the catalogue (step 12)': ['BROWSE CATALOGUE', 'LIGHT', 'MEDIUM', 'HEAVY', 'MOE', 'Unverified'],
    'found models (issue 12)': ['FOUND ON THIS COMPUTER', 'USE IT'],
    'mods (step 13)': ['YOUR MODS', 'own switch', 'only on the PC', 'My extensions'],
    'endorsed mods (step 14)': ['ENDORSED MODS', 'BROWSE ENDORSED MODS', 'INSTALL', '18+', 'switches itself off', '?nomods'],
    'phones and the LAN (steps 7-8)': ['Phone & Other Devices', 'setup-lan.bat', 'password'],
    'banned phrases': ['Banned Phrases:', 'CHECK', 'Bias Strength'],
    'memory and lore': ['Lore System', 'Memory Files', 'RAG Storybook'],
    'UPDATE for default characters (this step)': ['UPDATE brings one you added up to the new version'],
    // 1.8.0, at the version bump: each feature by the names on screen.
    'the Files panel (1.8.0)': ['📄', 'Files panel', 'USE IN MY NEXT MESSAGE'],
    'group chats (1.8.0)': ['+ GROUP', 'GROUPS', '▶ NEXT', 'AUTO'],
    'Auto Reroll (1.8.0)': ['Auto Reroll', 'Off-limits'],
    'model links (1.8.0, #52)': ['Model for this character', 'Model Switching'],
    'card tools (1.8.0, PR #71)': ["Let the model call this card's tools"],
    'why a model failed to load (1.8.0, #67)': ['CHECK FILE', 'the chat says why'],
    'the GPU menu (1.8.0, #72)': ['GPU (which graphics card)'],
    'open_browser (1.8.0, PR #58)': ['When GobboNet Starts'],
    'MCP servers (1.8.0, #42)': ['MCP Servers', '+ ADD SERVER'],
    'the update button (1.8.0)': ['CHECK FOR UPDATES', 'UPDATE NOW', 'RESTART NOW', 'update checks'],
    'a switch for each entry in My extensions (1.8.0)': ['each entry with its own switch'],
  };
  for (const [what, words] of Object.entries(want)) {
    const missing = words.filter(w => !style.includes(w));
    ok(missing.length === 0, what, 'missing: ' + missing.join(', '));
  }
}

console.log('\n=== D. it says "I don\'t know" rather than guessing ===');
{
  const lines = style.split('\n').filter(Boolean);
  const head = lines.slice(0, 6).join('\n');
  ok(/Answer only from the notes below/.test(head) && /I don't know/.test(head) && /TROUBLESHOOTING\.md/.test(head) && /Never guess/.test(head),
    'the rule comes first: only the notes; otherwise "I don\'t know", TROUBLESHOOTING.md; never guess');
  ok(/don't know/.test(lines[lines.length - 1]) && /TROUBLESHOOTING\.md/.test(lines[lines.length - 1]), 'and again last, where a small model weighs it most');
  ok(/TROUBLESHOOTING\.md/.test(pers) && /don't know/.test(pers), 'the personality, sent with every reply, repeats it');
  ok(fs.existsSync(ROOT + '/TROUBLESHOOTING.md'), 'TROUBLESHOOTING.md exists to point at');
}

console.log('\n=== E. every name it quotes is on screen; the old mistakes are gone ===');
{
  // Every run of two or more capitalised words, and every single CAPS word of
  // four or more letters, outside the section headings, must be somewhere in
  // the page or its scripts.
  const ALLOW = new Set(['RULES', 'JSON', 'JavaScript', 'CSS', 'GPU', 'CPU', 'KV', 'PC', 'AI', 'TROUBLESHOOTING', 'HOME', 'UNDO', 'PURGE', 'DATA', 'SCHED', 'CONFIG', 'MODS', 'CHARS', 'ABOUT', 'INSTALL', 'UPDATE']);
  const body = style.split('\n').filter(l => !/^[A-Z][A-Z ()/.&]+$/.test(l.trim())).join('\n');
  const names = new Set();
  // A run: a capitalised word, then one or more more ("BROWSE ENDORSED MODS",
  // "+ IMPORT .MD"); or a single CAPS word of four letters or more.
  const RUN = /(?:[+⑂⌂] )?[A-Z][A-Z0-9_+-]*(?![a-z])(?: (?:&|\.?[A-Z0-9][A-Z0-9_+-]*(?![a-z])))*(?: \.?[A-Z0-9][A-Z0-9_+-]*(?![a-z]))|\b[A-Z][A-Z_]{3,}\b/g;
  for (const m of body.matchAll(RUN)) {
    const n = m[0].trim();
    if (!ALLOW.has(n)) names.add(n);
  }
  const absent = [...names].filter(n => !UI.includes(n));
  ok(names.size >= 20 && [...names].some(n => n === 'BROWSE ENDORSED MODS') && [...names].some(n => n === '+ IMPORT .MD') && [...names].some(n => n === 'SAVE & RESTART MODEL'), `it found ${names.size} on-screen names to check, whole (e.g. BROWSE ENDORSED MODS)`, [...names].join(' | '));
  ok(absent.length === 0, `all ${names.size} on-screen names it quotes exist in the page`, absent.join(' | '));
  const paths = [...style.matchAll(/(?:CONFIG|MODS) > [^.:;,]+?(?= >|[.:;,]| shows| searches| lists)/g)].map(m => m[0]);
  const parts = new Set(paths.flatMap(p => p.split(' > ').slice(1)));
  const missingPart = [...parts].filter(p => !UI.includes(p.trim()));
  ok(paths.length >= 5 && missingPart.length === 0, `every "CONFIG > …" path it gives exists (${paths.length} paths)`, missingPart.join(' | '));
  for (const m of ['{{char}}', '{{user}}', '{{current_DAT}}', '{{continue}}', '{{fast_forward}}', '{{auto_continue_']) {
    ok(style.includes(m) && (JS.includes(m.replace(/[{}]/g, '')) || UI.includes(m)), 'the macro ' + m + ' exists');
  }
  const gone = {
    'right-click menus (there are none)': /Right-click/i,
    '"no undo" on delete': /No undo/i,
    'one master switch for mods': /master toggle/i,
    '"search is the only thing online"': /ONLY thing that uses the internet/,
    'the removed search proxy': /proxy|11435/,
    'a periodic personality reminder': /now and then|periodically/,
  };
  for (const [what, re] of Object.entries(gone)) ok(!re.test(style), 'gone: ' + what);
}

console.log('\n=== F. UPDATE for a default character already added ===');
{
  const SRC = read('js/14-scroll.js');
  const from = SRC.indexOf('function installDefaultChar(');
  const to = SRC.indexOf('function toggleSidebar(');
  const preset = { name: 'Gobbonet Informant', writingStyle: 'NEW style', personality: 'NEW pers', temperature: 0.3, textColor: '#00ff41' };
  const make = cardsIn => {
    const ctx = {
      state: { characterCards: cardsIn },
      defaultCharacters: [preset],
      DEFAULT_CARD: { bannedPhrases: '', customCode: '' },
      generateId: () => 'new-id',
      saves: 0, renders: 0, alerts: 0, undo: null,
      alert: () => { ctx.alerts++; },
    };
    ctx.saveState = () => { ctx.saves++; };
    ctx.render = () => { ctx.renders++; };
    ctx.undoable = o => { ctx.undo = o; };
    vm.createContext(ctx);
    vm.runInContext(SRC.slice(from, to), ctx);
    return ctx;
  };
  let c = make([]);
  ok(c.defaultCharState(preset) === 'new', 'not added: + ADD');
  c.installDefaultChar(0);
  ok(c.state.characterCards.length === 1 && c.state.characterCards[0].writingStyle === 'NEW style' && c.state.characterCards[0].temperature === 0.3, '+ ADD installs it');
  ok(c.defaultCharState(preset) === 'same', 'then it shows as ADDED');
  c.installDefaultChar(0);
  ok(c.state.characterCards.length === 1 && c.alerts === 0 && !c.undo, 'clicking an ADDED one again makes no copy and no blocking alert');

  const old = { id: 'mine', name: 'Gobbonet Informant', writingStyle: 'OLD 1.7.8 style', personality: 'old', temperature: 0.5,
    avatar: 'me.png', textColor: '#ff00ff', bannedPhrases: 'delve', customCode: 'x()', carouselEnabled: true, carouselPrompts: 'mine', memoryFiles: [{ n: 1 }] };
  c = make([JSON.parse(JSON.stringify(old)), { id: 'other', name: 'Someone else', writingStyle: 'x' }]);
  ok(c.defaultCharState(preset) === 'update', 'added in 1.7.8, prompt differs: UPDATE');
  c.installDefaultChar(0);
  const u = c.state.characterCards[0];
  ok(c.state.characterCards.length === 2 && u.id === 'mine' && u.writingStyle === 'NEW style' && u.personality === 'NEW pers' && u.temperature === 0.3,
    'UPDATE replaces the prompt and samplers in place, same card');
  ok(u.avatar === 'me.png' && u.textColor === '#ff00ff' && u.bannedPhrases === 'delve' && u.customCode === 'x()' &&
     u.carouselEnabled === true && u.carouselPrompts === 'mine' && u.memoryFiles.length === 1,
    'and keeps the user\'s avatar, colours, banned phrases, code, carousel and memory files');
  ok(c.undo && /Updated "Gobbonet Informant"/.test(c.undo.label) && c.defaultCharState(preset) === 'same', 'with UNDO offered, and now it is ADDED');
  c.undo.undo();
  ok(JSON.stringify(c.state.characterCards[0]) === JSON.stringify(old) && c.state.characterCards[1].id === 'other', 'UNDO puts the card back exactly as it was');

  const DASH = read('js/13-dashboard.js');
  ok(/defaultCharState\(p\)/.test(DASH) && /landing-preset-badge-update">UPDATE</.test(DASH) && /">ADDED</.test(DASH) && /\+ ADD</.test(DASH),
    'the home screen shows + ADD, UPDATE or ADDED');
  ok(!/already in your character list/.test(SRC), 'the old "already in your character list" alert is gone');
  ok(/\.landing-preset-badge-update/.test(read('css/09-dashboard.css')), 'UPDATE has its own badge style');
}

console.log('\n=== G. stale notes in the page ===');
{
  ok(!/Injected periodically/.test(HTML) && /Sent with every reply, near the top/.test(HTML), 'the Personality hint says what happens now (sent every reply)');
  const tip = (HTML.match(/<div class="tip-body" id="tip-search-key" hidden>([\s\S]*?)<\/div>/) || [])[1] || '';
  ok(tip && !/11435|search proxy/.test(tip), 'the search-key note no longer mentions the removed proxy on :11435');
  ok(/only web search, model and mod lists, and update checks go online/.test(HTML), 'Privacy Status counts the endorsed mod list (and, since 1.8.0, the update check)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
