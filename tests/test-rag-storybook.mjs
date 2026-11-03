/**
 * The RAG Storybook (js/08-rag.js), run for real: the parser and the
 * retriever, with the embedding model off (the default for most installs)
 * and with a stand-in for it.
 *
 * Reported against 1.7.9: lore written either way did not fire.
 *   # Selah, [.7 wing, .3 light, 1.0 angel]
 *   Sometimes called 'Neighbor' by his friends in town, ...
 * and a plain paragraph about Selah. The header line was not read as a
 * header at all (the comma and brackets), so its tags were lost and the line
 * went to the model as prose; the name in a header was not a trigger; and
 * plain text was only ever found by the optional embedding model.
 *
 *   A. Weighted tags: every way of writing a weight.
 *   B. The header form: name, tags on the same line, prose under it; the
 *      header line never reaches the model.
 *   C. Firing for a header entry: its name; tag sums at the threshold
 *      (.7 + .3 = 1.0); stemmed matching; below the threshold, nothing.
 *   D. Plain text: split into entries of up to four sentences; names found;
 *      a name fires an entry alone; one distinctive word fires it by default,
 *      and a character can ask for two or three (ragWordsToFire); common
 *      words never count, and a shared word counts for less.
 *   E. Everything that worked before still does: flat name_tags lines,
 *      "# name" with bare tags:, [name] and == name == headers, subtrees,
 *      offscreen suppression, relations.
 *   F. With the embedding model: meaning still matches on top.
 *   G. The editor readout, and the guide.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const P = read('js/07-prompt.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 600) : '')); }
};

// A stand-in embedding model: bag of words hashed into 64 dimensions.
const bow = (input) => {
  const v = new Array(64).fill(0);
  for (const w of String(input).toLowerCase().replace(/^search_(document|query): /, '').match(/[a-z]+/g) || []) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 64] += 1;
  }
  return { ok: true, json: async () => ({ data: [{ embedding: v }] }) };
};

function load({ embed = false, settings = {} } = {}) {
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, window: { dispatchEvent() {} }, performance,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    STORAGE_BACKEND: 'ls', _idb: null, activeModel: { id: 'm' }, EMBED_URL: 'http://embed',
    state: { settings: Object.assign({ retrievalEnabled: true, retrieverA: true, retrieverB: true, fireThreshold: 1.0, warmthTurns: 3,
      expansionDepth: 1, semanticBackstop: true, topKA: 5, retrievalBudgetTokens: 6000, retrievalWindowMsgs: 4 }, settings) },
    fetch: async (u, o) => embed ? bow(JSON.parse(o.body).input) : { ok: false },
    document: { getElementById: id => ctx._els[id] || null }, _els: {},
  };
  vm.createContext(ctx);
  vm.runInContext(P.slice(P.indexOf('function estimateTokens('), P.indexOf('function estimateMessagesTokens(')), ctx);
  vm.runInContext(P.slice(P.indexOf('function updateStorybookReadout('), P.indexOf('function renderAvatar(')), ctx);
  vm.runInContext(read('js/08-rag.js'), ctx);
  return ctx;
}
let n = 0;
async function fire(ctx, book, ...messages) {
  const opts = (typeof messages[0] === 'object') ? messages.shift() : {};
  const card = Object.assign({ id: 'c' + (n++), ragStorybook: book }, opts);
  const thread = { id: 't' + (n++), messages: messages.map(content => ({ role: 'user', content })) };
  const r = await ctx.runRetrieval(thread, card, 5000, {});
  return r.injections.map(i => i.text);
}

const SELAH_1 = `# Selah, [.7 wing, .3 light, 1.0 angel]
Sometimes called ‘Neighbor’ by his friends in town, Selah is secretly an angel walking the mortal realm. He is relatively indifferent to most things and tries not to get involved in human affairs.`;
const SELAH_2 = `Selah is an angel wandering the world as a human. He sometimes holds a light ethereal glow to him, but he never would simply show his wings. He is relatively indifferent to most things and tries not to get involved in human affairs. Some of his friends in town call him ‘Neighbor’.`;

console.log('\n=== A. weighted tags ===');
{
  const c = load();
  const t = s => JSON.stringify(c.parseWeightedTags(s).map(x => [x.term, x.weight]));
  ok(t('.7 wing, .3 light, 1.0 angel') === '[["wing",0.7],["light",0.3],["angel",1]]', 'weight first: .7 wing, .3 light, 1.0 angel', t('.7 wing, .3 light, 1.0 angel'));
  ok(t('[0.5 halo, 1 angel]') === '[["halo",0.5],["angel",1]]', 'the whole list in brackets');
  ok(t('angel [1.0], divine [0.8], heaven') === '[["angel",1],["divine",0.8],["heaven",1]]', 'weight after, in brackets; a bare term is 1.0 (as before)');
  ok(t('divine (0.8), halo: .5') === '[["divine",0.8],["halo",0.5]]', 'weight after, in parentheses or after a colon');
  ok(t('7 seas, district 9') === '[["7 seas",1],["district 9",1]]', 'a number that is not a weight stays part of the term');
  ok(t('dying companion [1.0], .6 failing health') === '[["dying companion",1],["failing health",0.6]]', 'phrases, both ways');
}

console.log('\n=== B. the header form ===');
{
  const c = load();
  const b = c.parseStorybook(SELAH_1);
  const e = b.entities.Selah;
  ok(b.order.length === 1 && e && e.kind === 'entity', 'the header line makes one entry, named Selah', b.order);
  ok(JSON.stringify(e.tags.map(x => [x.term, x.weight])) === '[["wing",0.7],["light",0.3],["angel",1]]', 'with the three tags from the header line');
  ok(/^Sometimes called/.test(e.prose) && !/\[|\.7/.test(e.prose) && b.proseChunks.length === 0, 'its prose is the text under it; the header line is not prose');
  for (const form of ['# Selah [wing (0.7), light (0.3), angel]', '# Selah: [.7 wing, .3 light, 1.0 angel]', '## Selah, [.7 wing, .3 light, angel [1.0]]']) {
    const x = c.parseStorybook(form + '\nSome prose.');
    ok(x.order[0] === 'Selah' && x.entities.Selah.tags.length === 3, 'also: ' + form, x.order);
  }
  const plain = c.parseStorybook('# Chapter 1: The Fall\nIt rained.');
  ok(plain.order.length === 0, 'a Markdown heading that is not a name (it has a colon) stays prose');
  const uni = c.parseStorybook('# Élodie Saint-Clair, [1.0 cartographer]\nShe draws maps.');
  ok(uni.order[0] === 'Élodie Saint-Clair', 'names in any language, with hyphens and spaces');
}

console.log('\n=== C. a header entry fires ===');
{
  const c = load();
  const fired = async (...m) => (await fire(c, SELAH_1, ...m)).length === 1;
  ok(await fired('Have you seen Selah around town lately?'), 'its name fires it on its own (the primary trigger)');
  ok(await fired("That was Selah's coat."), "and its name with 's");
  ok(await fired('They say an angel lives among us.'), 'a 1.0 tag fires it on its own');
  ok(await fired('A light shone and I saw a wing behind him.'), '.7 wing + .3 light = 1.0 fires it');
  ok(await fired('Light caught her wings.'), 'stemmed: "wings" matches the tag wing');
  ok(!(await fired('I saw a wing.')), '.7 alone is under 1.0: nothing');
  ok(!(await fired('Let us go fishing at the lake.')), 'an unrelated message: nothing');
  const text = (await fire(c, SELAH_1, 'Selah?'))[0];
  ok(/^Sometimes called ‘Neighbor’/.test(text) && !/#|\[|\.7 wing/.test(text), 'what is sent is the prose, never the header or its weights', text);
  const tagless = '# Selah\nHe keeps to himself.';
  ok((await fire(c, tagless, 'Where is Selah?')).length === 1, 'a header with no tags at all still fires on its name');
  const hi = load({ settings: { fireThreshold: 1.5 } });
  ok((await fire(hi, SELAH_1, 'A light shone on a wing.')).length === 0 && (await fire(hi, SELAH_1, 'An angel with a wing.')).length === 1,
    'fire_threshold still sets the bar (1.5: 1.0 is not enough, 1.7 is)');
}

console.log('\n=== D. plain text ===');
{
  const c = load();
  const b = c.parseStorybook(SELAH_2);
  ok(b.order.length === 0 && b.proseChunks.length === 1, 'a four-sentence paragraph is one entry');
  ok(JSON.stringify([...b.proseChunks[0].names].sort()) === '["Neighbor","Selah"]', 'names found in it: Selah (opens a sentence, never lower-case) and Neighbor', b.proseChunks[0].names);
  ok(!b.proseChunks[0].names.includes('Some') && !b.proseChunks[0].names.includes('He'), 'sentence openers are not names');
  const words = b.proseChunks[0].words.map(w => w.term);
  ok(words.includes('angel') && words.includes('wing') && words.includes('light') && !words.includes('never') && !words.includes('thing'),
    'distinctive words become tags; common words (never, things) do not', words);
  const fired = async (...m) => (await fire(c, SELAH_2, ...m)).length === 1;
  ok(await fired('Have you seen Selah around town lately?'), 'a name fires it');
  ok(await fired('Ask the Neighbor.'), 'so does the other name in it');
  ok(await fired('They say an angel lives among us.'), 'by default one of its words fires it, as lorebooks usually do');
  ok(!(await fired('I never show things to most people.')), 'common words never fire it');
  const two = { ragWordsToFire: 2 }, three = { ragWordsToFire: 3 };
  ok((await fire(c, SELAH_2, two, 'They say an angel lives among us.')).length === 0, 'asked for 2 words: one alone does not');
  ok((await fire(c, SELAH_2, two, 'A light shone and I saw a wing behind him.')).length === 1, 'asked for 2 words: two do');
  ok((await fire(c, SELAH_2, three, 'A light shone and I saw a wing behind him.')).length === 0
     && (await fire(c, SELAH_2, three, 'A light glow shone and I saw a wing.')).length === 1, 'asked for 3 words: two do not, three do');
  ok((await fire(c, SELAH_2, three, 'Have you seen Selah?')).length === 1, 'a name fires it whatever the setting');
  ok(c.ragWordsToFireOf({}) === 1 && c.ragWordsToFireOf({ ragWordsToFire: '2' }) === 2 && c.ragWordsToFireOf({ ragWordsToFire: 0 }) === 1
     && c.ragWordsToFireOf({ ragWordsToFire: 99 }) === 5, 'the setting reads 1 when unset or bad, and at most 5');
  const shared = 'The lighthouse keeper rows out at dawn.\n\nThe lighthouse is painted red and white.';
  ok((await fire(c, shared, 'Look at the lighthouse.')).length === 0 && (await fire(c, shared, 'The lighthouse keeper.')).length === 1,
    'a word two entries share counts for half: alone it pulls neither, with another word it pulls the right one');

  const dump = `Selah is an angel wandering the world as a human. He glows faintly at dusk. He keeps a small garden of white lilies. He never shows his wings. Velmora is the river town where he lives. Its bridges are old and crooked. The ferryman there is called Old Tam. Old Tam distrusts strangers and counts every coin twice. The Gilded Lantern is the tavern by the docks. Its cider is famous and its cellar floods every spring.`;
  const d = c.parseStorybook(dump);
  ok(d.proseChunks.length === 3 && d.proseChunks.every(ch => c.ragSentences(ch.text).length <= 4),
    'a ten-sentence dump with no blank lines becomes three entries of at most four sentences', d.proseChunks.map(ch => ch.text.slice(0, 30)));
  const got = await fire(c, dump, { ragWordsToFire: 2 }, 'We should cross into Velmora.');
  ok(got.length === 1 && /Velmora/.test(got[0]), 'a name pulls only the entry it is in', got);
  const tav = await fire(c, dump, { ragWordsToFire: 2 }, 'Meet me at the Gilded Lantern for some cider.');
  ok(tav.length === 1 && /cider is famous/.test(tav[0]), 'and only that one', tav);
  const one = await fire(c, dump, 'The cellar is dark.');
  ok(one.length === 1 && /cellar floods/.test(one[0]), 'with the default, one distinctive word pulls just the entry it is in', one);
  ok(c.ragSentences('Dr. Vale arrived. He left.').length === 2, '"Dr. Vale" does not end a sentence');
  const paras = c.parseStorybook('Selah is quiet.\n\nVelmora is loud.');
  ok(paras.proseChunks.length === 2, 'a blank line still separates entries');
}

console.log('\n=== E. what worked before still does ===');
{
  const c = load();
  const flat = `selah_tags: angel [1.0], divine [0.8], heaven, winged [1.0], halo [0.5]
selah_role_in_arcs: protagonist
selah_use_principles: speaks formally

Selah guards the gallery at night.

reinhard_tags: scholar [1.0], collector [0.7]
reinhard_offscreen_default: true
reinhard_relation_rival: selah
reinhard.marguerite_tags: dying companion [1.0], failing [0.6]`;
  const b = c.parseStorybook(flat);
  ok(b.order.join(',') === 'selah,reinhard,reinhard.marguerite' && b.entities.selah.tags.length === 5, 'flat name_tags lines parse as before', b.order);
  ok(b.entities['reinhard.marguerite'].kind === 'subtree' && b.entities.reinhard.offscreenDefault, 'subtrees and offscreen_default as before');
  ok((await fire(c, flat, 'The divine light of heaven.')).length >= 1, 'a thematic cluster (0.8 + 1.0) fires as before');
  ok((await fire(c, flat, 'He is a collector of old things.')).length === 0, 'an offscreen entity on a theme alone stays out');
  const sect = `# selah\nA winged figure.\ntags: angel [1.0], divine [0.8]\nrelation: reinhard\n\n[reinhard]\nA scholar.\ntags: scholar\n\n== mill ==\nThe old mill.`;
  const s = c.parseStorybook(sect);
  ok(s.order.join(',') === 'selah,reinhard,mill' && s.entities.selah.tags.length === 2 && s.entities.selah.relations[0] === 'reinhard',
    '"# name" with bare tags:/relation:, [name] and == name == headers, as before', s.order);
  const mixed = c.parseStorybook('# Selah, [1.0 angel]\nAn angel.\nselah_tags: halo [0.5]\nrole_in_arcs: protector');
  ok(mixed.order.length === 1 && mixed.entities.Selah.tags.length === 2 && mixed.entities.Selah.roleInArcs === 'protector',
    '"# Selah" and selah_tags: are the same entry, whatever the case');
  const hr = c.parseStorybook('# Selah\nAn angel.\n---\nThe world is old.');
  ok(hr.entities.Selah.prose === 'An angel.' && hr.proseChunks.length === 1, 'a --- line still ends a section');
}

console.log('\n=== F. with the embedding model ===');
{
  const c = load({ embed: true });
  ok((await fire(c, SELAH_2, 'They say an angel lives among us.')).length === 1, 'one word alone is matched by meaning when the model is running');
  ok((await fire(c, SELAH_1, 'Selah?')).length === 1 && (await fire(c, SELAH_2, 'Selah?')).length === 1, 'names still fire both forms');
  const off = load({ embed: true, settings: { retrieverB: false } });
  ok((await fire(off, SELAH_2, 'An angel wandering the world, holding a light glow to him.')).length === 1, 'with tag firing switched off, meaning alone still works');
}

console.log('\n=== G. the readout and the guide ===');
{
  const c = load();
  const el = { textContent: '' }, ta = { value: SELAH_1 + '\n\n---\n' + SELAH_2.replace('Selah is', 'He is') };
  c._els = { 'storybook-readout': el, 'card-rag-storybook': ta };
  c.updateStorybookReadout();
  ok(/1 named entry: Selah \(3 tags\)/.test(el.textContent) && /1 plain-text entry/.test(el.textContent), 'the readout names the entry and its tags, and counts plain entries', el.textContent);
  const html = read('chat.html');
  ok(/# Selah, \[\.7 wing, \.3 light, 1\.0 angel\]/.test(html), 'the field\'s example shows the header form');
  ok(/<select id="card-rag-words"[\s\S]{0,200}value="1">1 of its words \(default\)/.test(html), 'the card editor has the words-to-fire setting, 1 by default');
  const cards = read('js/15-cards.js'), io = read('js/16-card-io.js'), st = read('js/04-state.js');
  ok(/ragWordsToFire: 1,/.test(st) && /card\.ragWordsToFire = ragWordsToFireOf/.test(cards) && /_rw\.value = String\(ragWordsToFireOf\(card\)\)/.test(cards),
    'it is saved on the character and loaded into the editor');
  ok(/if \(wordsToFire !== 1\) g\.ragWordsToFire = wordsToFire;/.test(io) && /ragWordsToFire: ragWordsToFire,/.test(io), 'and travels with an exported card');
  ok(/\/\^doc:\/\.test\(inj\.entityId\) \? 'Storybook'/.test(read('js/08-rag.js')), 'a plain entry reaches the model as [Storybook], not its internal id');
  const guide = read('docs/RAG_INFO.md');
  ok(/# Selah, \[\.7 wing, \.3 light, 1\.0 angel\]/.test(guide) && /four sentences/.test(guide) && /without the embedding model/i.test(guide),
    'the guide documents both ways, the four-sentence entries, and plain text without the embedding model');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
