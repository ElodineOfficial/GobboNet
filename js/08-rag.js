/* @gobbonet-split js/08-rag.js
   Moved verbatim from chat.html lines 5500-6419.
   retrieval engine and telemetry
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   RAG ENGINE  (Stage 1 — dual retriever + telemetry)

   Two retrievers feed context on demand, integrated at the single
   injection seam (buildContextMessages). Everything below is
   degrade-safe: if the embed server is down Retriever A and the
   semantic backstop silently switch off and weighted-tag Retriever
   B carries on; if a card has no storybook the whole thing no-ops.

     Retriever A — general / semantic. Entity descriptions + freeform
       prose chunks are embedded once (cached by content hash) and
       cosine-scored against the recent window each turn.
     Retriever B — structured / weighted-tag. A thematic pull fires
       when the SUMMED weight of matched tags >= fire_threshold;
       entity + subtree granularity; one-hop relational expansion
       gated by offscreen_default; warmth/decay kills flicker.

   The unified ranker merges A+B, dedupes (an entity from both
   sources costs budget once), ranks by score x arc-role, fills a
   retrieval budget carved from the existing context budget, and
   pushes survivors as system messages. Every decision is logged
   into the per-turn telemetry record (Part 1 of the design) and
   emitted on the 'gobbonet:retrieval' event for Stage 2 to consume.
================================================================ */

/* Fast, dependency-free string hash (FNV-1a, 32-bit, hex). Used as a
   cache key for embedding vectors and as window.hash for telemetry. We
   deliberately avoid SubtleCrypto here: it needs a secure context, and
   the LAN deployment serves plain http, where crypto.subtle is absent. */
function ragHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/* Parse a tag list into [{term, weight}]. Bare terms default to weight
   1.0. Every way people write a weight is read:
     divine [0.8]   divine (0.8)   divine: 0.8     (weight after the term)
     .8 divine      0.8 divine     1.0 angel       (weight first, 1.7.9)
   A leading number counts as a weight only when it looks like one (0, 1, or
   a decimal), so "7 seas" stays a term. The whole list may itself be in
   [brackets]. This grammar is retrieval control data: parsed at load and
   never sent to the model as prose. */
const RAG_WEIGHT_NUM = '(?:\\d*\\.\\d+|\\d+(?:\\.\\d*)?)';
function parseWeightedTags(value) {
  if (!value) return [];
  let v = String(value).trim();
  if (/^\[[\s\S]*\]$/.test(v)) v = v.slice(1, -1);
  const num = w => { const f = parseFloat(w); return isFinite(f) && f >= 0 ? f : 1.0; };
  return v.split(',').map(raw => {
    const s = raw.trim();
    if (!s) return null;
    let m = s.match(new RegExp('^(.*?)\\s*(?:\\[\\s*(' + RAG_WEIGHT_NUM + ')\\s*\\]|\\(\\s*(' + RAG_WEIGHT_NUM + ')\\s*\\)|:\\s*(' + RAG_WEIGHT_NUM + '))\\s*$'));
    if (m && m[1].trim()) return { term: m[1].trim(), weight: num(m[2] || m[3] || m[4]) };
    m = s.match(/^(0|1|\d*\.\d+|1\.0*)\s+(\S[\s\S]*)$/);
    if (m) return { term: m[2].trim(), weight: num(m[1]) };
    return { term: s, weight: 1.0 };
  }).filter(Boolean);
}

/* The reserved directive suffixes, locked by the schema commitment. A line
   "<id>_<suffix>: value" routes to structured control data; "<id>." prefixes
   address subtrees (entity.subtree). Anything that is not a recognized
   directive (and not a section header) is prose for Retriever A. */
const RAG_DIRECTIVE_RE = /^([A-Za-z0-9][A-Za-z0-9_.\- ]*?)_(tags|relation(?:_[A-Za-z0-9]+)?|role_in_arcs|use(?:_[A-Za-z0-9]+)?|offscreen_default)\s*:\s*(.*)$/i;
// Bare directive (inside a "# entity" section): "tags: ...", "relation: ...".
const RAG_BARE_DIRECTIVE_RE = /^(tags|relation(?:_[A-Za-z0-9]+)?|role_in_arcs|use(?:_[A-Za-z0-9]+)?|offscreen_default)\s*:\s*(.*)$/i;
// Section header forms: "# selah", "== selah ==", "[selah]". "." = subtree.
const RAG_HEADER_RE = /^(?:#{1,3}\s*|\=\=\s*|\[)\s*([A-Za-z0-9][A-Za-z0-9_.\- ]*?)\s*(?:\=\=|\])?\s*$/;
// A header name: letters (any language), digits, spaces, ' . - _ ; at most 60
// characters. "# Chapter 1: The Fall" is not one (the colon), so a Markdown
// heading in pasted notes is not mistaken for an entry unless it is a name.
const RAG_HEADER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.'\u2019 \-]{0,59}$/u;

/* A header line, with its tags on the same line if it has them (1.7.9):
     # Selah                              an entry named Selah
     # Selah, [.7 wing, .3 light, 1.0 angel]
     # Selah [wing (0.7), light (0.3), angel]
     # Selah: [.7 wing, .3 light, 1.0 angel]
   plus the older "== selah ==" and "[selah]". Returns { name, tags } or null. */
function ragParseHeaderLine(line) {
  const t = line.trim();
  let m = t.match(/^#{1,3}\s*(.+)$/);
  if (m) {
    let rest = m[1].trim(), tags = [];
    const open = rest.indexOf('[');
    if (open > 0 && rest.endsWith(']')) {
      tags = parseWeightedTags(rest.slice(open + 1, -1));
      rest = rest.slice(0, open).replace(/[\s,:;\u2014\u2013-]+$/, '').trim();
    }
    rest = rest.replace(/\s*#+$/, '').trim();   // "# Selah #" (closing hashes)
    if (!RAG_HEADER_NAME_RE.test(rest)) return null;
    return { name: rest, tags };
  }
  if (t.includes(':')) return null;
  m = t.match(RAG_HEADER_RE);
  return m ? { name: m[1].trim(), tags: [] } : null;
}

function ragNewEntity(id) {
  return {
    id, kind: id.includes('.') ? 'subtree' : 'entity',
    parent: id.includes('.') ? id.split('.')[0] : null,
    tags: [], relations: [], roleInArcs: '', usePrinciples: '',
    offscreenDefault: false, prose: ''
  };
}

/* Parse the whole storybook field. Routes structured lines to entities/
   subtrees (Retriever B) and plain prose to chunks (Retriever A). Supports
   BOTH the flat form ("selah_tags: angel [1.0]") and the sectioned form
   ("# selah" header, then bare "tags: ..." + prose lines). */
function parseStorybook(raw) {
  const result = { entities: {}, order: [], proseChunks: [],
                   counts: { entities: 0, subtrees: 0, tags: 0, proseChunks: 0 } };
  if (!raw || !raw.trim()) return result;

  // One entry per name whatever its case: "# Selah" and "selah_tags:" are the
  // same entry. The first spelling seen is the one shown.
  const byLower = {};
  const ensure = (name) => {
    const key = name.toLowerCase();
    const id = byLower[key] || (byLower[key] = name);
    if (!result.entities[id]) { result.entities[id] = ragNewEntity(id); result.order.push(id); }
    return result.entities[id];
  };
  const applyDirective = (ent, suffix, value) => {
    const s = suffix.toLowerCase();
    if (s === 'tags') ent.tags = ent.tags.concat(parseWeightedTags(value));
    else if (s === 'role_in_arcs') ent.roleInArcs = value.trim();
    else if (s === 'offscreen_default') ent.offscreenDefault = /^(1|true|yes|on)$/i.test(value.trim());
    else if (s.startsWith('relation')) ent.relations = ent.relations.concat(
      value.split(',').map(v => v.trim()).filter(Boolean));
    else if (s.startsWith('use')) ent.usePrinciples = (ent.usePrinciples ? ent.usePrinciples + ' ' : '') + value.trim();
  };

  let current = null;          // active section entity id
  let proseBuf = [];           // un-attributed prose accumulating into a chunk
  // Plain text becomes entries of up to RAG_ENTRY_SENTENCES sentences, so a
  // text dump with no blank lines is still many small entries, and only the
  // ones a scene touches are sent.
  const flushProse = () => {
    const text = proseBuf.join('\n').trim();
    for (const part of ragSplitEntries(text)) {
      result.proseChunks.push({ id: 'doc:' + result.proseChunks.length, text: part });
    }
    proseBuf = [];
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { // blank line ends an un-attributed prose chunk
      if (!current) flushProse();
      continue;
    }
    // A horizontal rule (---, ===, ___, ***) closes the current section so
    // following prose becomes standalone docs again. The escape hatch for
    // "structured entities, THEN general world prose for the semantic side."
    if (/^\s*([-=_*])\1{2,}\s*$/.test(line)) {
      if (!current) flushProse();
      current = null;
      continue;
    }
    let m;
    if ((m = line.match(RAG_DIRECTIVE_RE))) {
      const ent = ensure(m[1].trim());
      applyDirective(ent, m[2], m[3]);
      current = ent.id;
      continue;
    }
    if (current && (m = line.match(RAG_BARE_DIRECTIVE_RE))) {
      applyDirective(result.entities[current], m[1], m[2]);
      continue;
    }
    const header = ragParseHeaderLine(line);
    if (header) {
      if (!current) flushProse();
      const ent = ensure(header.name);
      if (header.tags.length) ent.tags = ent.tags.concat(header.tags);
      current = ent.id;
      continue;
    }
    // Plain prose. Attributed to the current section entity, else a doc chunk.
    if (current) {
      const ent = result.entities[current];
      ent.prose = ent.prose ? ent.prose + '\n' + line : line;
    } else {
      proseBuf.push(line);
    }
  }
  flushProse();

  for (const id of result.order) {
    const e = result.entities[id];
    if (e.kind === 'subtree') result.counts.subtrees++; else result.counts.entities++;
    result.counts.tags += e.tags.length;
  }
  result.counts.proseChunks = result.proseChunks.length
    + result.order.filter(id => result.entities[id].prose).length;
  result.counts.plainEntries = result.proseChunks.length;
  ragAutoTriggers(result);
  return result;
}

/* ---- Plain-text entries (1.7.9) ----------------------------------------
   A storybook that is just prose has to work with nothing else running:
   the embedding model is optional. Each plain entry gets triggers of its own,
   worked out from its text the way a power user would write them:
     - names (Selah, 'Neighbor') fire it on their own, like a header does;
     - its distinctive words are tags too. By default one of them in the
       conversation fires it, the way lorebooks usually behave; a character
       can ask for two or three (card.ragWordsToFire) to be more specific.
       A word other entries share counts for less.
   Common words never count. With the embedding model running, entries are
   also matched by meaning, as before. */
const RAG_ENTRY_SENTENCES = 4;
const RAG_WORDS_TO_FIRE_MAX = 5;

/** How many distinctive words a card's plain entries need: 1 (default) to 5. */
function ragWordsToFireOf(card) {
  const n = Math.round(Number(card && card.ragWordsToFire));
  return isFinite(n) && n >= 1 ? Math.min(n, RAG_WORDS_TO_FIRE_MAX) : 1;
}
const RAG_ABBREV_RE = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|Prof|Capt|Lt|Col|Gen|Sgt|vs|etc|e\.g|i\.e)\.$/i;

function ragSentences(text) {
  const out = [];
  let buf = '';
  const parts = String(text || '').split(/(?<=[.!?\u2026]["'\u2019\u201d)\]]*)\s+/);
  for (const p of parts) {
    buf = buf ? buf + ' ' + p : p;
    if (RAG_ABBREV_RE.test(buf.trim())) continue;   // "Dr. Vale" is one sentence
    out.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function ragSplitEntries(text) {
  const out = [];
  for (const para of String(text || '').split(/\n\s*\n/)) {
    const s = ragSentences(para.replace(/\s*\n\s*/g, ' ').trim());
    for (let i = 0; i < s.length; i += RAG_ENTRY_SENTENCES) out.push(s.slice(i, i + RAG_ENTRY_SENTENCES).join(' '));
  }
  return out.filter(x => x.trim());
}

/* Light stemming, so a tag or name matches the forms people write:
   wing/wings, angel/angels, glow/glowing/glowed, Selah/Selah's. Applied to
   tags, names and the conversation alike. */
function ragStem(w) {
  let t = String(w).toLowerCase().replace(/[\u2019']s$/, '').replace(/[\u2019']/g, '');
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed') && !t.endsWith('eed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1);
  return t;
}
function ragTokens(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}_'\u2019\-]*/gu) || []).map(ragStem);
}
/* " a b c " form, so a phrase is found only on whole (stemmed) words. */
function ragNormText(text) { return ' ' + ragTokens(text).join(' ') + ' '; }
function ragPhraseHit(normText, phrase) {
  const p = ragTokens(phrase).join(' ');
  return !!p && normText.includes(' ' + p + ' ');
}

// Words too common to say what an entry is about. A plain entry's word tags
// skip these (and RAG_STOPWORDS, and anything under four letters).
const RAG_WEAK_WORDS = new Set(('always never sometime sometimes often usually really simply mostly almost '
  + 'quite rather relatively little large small great good bad thing something nothing everything anything '
  + 'people person time day year way make take give come goe look seem feel tri call find keep hold tell '
  + 'ask show turn leave put mean become begin help talk around away across through toward towards within '
  + 'without behind beside between among another every enough whole part place world life hand head eye '
  + 'first last long high right left next sure true real able need use used know also though although '
  + 'however perhap maybe instead together alone himself herself itself themselve yourself myself').split(' '));
const RAG_OPENERS = new Set(('the a an and but or so yet for nor he she it they we you i his her its their '
  + 'our your my this that these those there here then when while after before since because although if '
  + 'though once some sometimes often usually always never many most few all each every one no not '
  + 'as at by in on of to with from into over under upon during until unless whether what which who whom '
  + 'whose where why how even still just only also perhaps maybe however instead later now today '
  + 'yesterday tomorrow meanwhile soon long being').split(' '));

/* Names in plain text: words written with a capital in the middle of a
   sentence anywhere in the storybook (Neighbor, Velmora), and capitalised
   words that open a sentence, are not common openers, and are never written
   in lower case anywhere (Selah). */
function ragBookNames(book) {
  const texts = book.proseChunks.map(c => c.text).concat(book.order.map(id => book.entities[id].prose || ''));
  const lowerSeen = new Set(), mid = new Set(), initial = new Set();
  for (const text of texts) {
    for (const sentence of ragSentences(text)) {
      const words = sentence.match(/[\p{L}][\p{L}'\u2019\-]*/gu) || [];
      words.forEach((w, i) => {
        const bare = w.replace(/[\u2019'\-]+$/, '').replace(/[\u2019']s$/, '');
        if (/^\p{Ll}/u.test(bare)) { lowerSeen.add(bare.toLowerCase()); return; }
        if (!/^\p{Lu}/u.test(bare) || bare.length < 3 || /^\p{Lu}+$/u.test(bare) && bare.length < 4) return;
        (i === 0 ? initial : mid).add(bare);
      });
    }
  }
  const names = new Set();
  for (const w of mid) if (!RAG_OPENERS.has(w.toLowerCase()) && !RAG_STOPWORDS.has(w.toLowerCase())) names.add(w);
  for (const w of initial) {
    const l = w.toLowerCase();
    if (!RAG_OPENERS.has(l) && !RAG_STOPWORDS.has(l) && !lowerSeen.has(l)) names.add(w);
  }
  return names;
}

function ragAutoTriggers(book) {
  const names = ragBookNames(book);
  const df = new Map();
  const wordsOf = book.proseChunks.map(c => {
    const set = new Set();
    for (const t of ragTokens(c.text)) {
      if (t.length >= 4 && !RAG_STOPWORDS.has(t) && !RAG_WEAK_WORDS.has(t) && !/^\d+$/.test(t)) set.add(t);
    }
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    return set;
  });
  book.proseChunks.forEach((c, i) => {
    const own = [], norm = ragNormText(c.text);
    for (const n of names) if (ragPhraseHit(norm, n)) own.push(n);
    c.names = own;
    const nameStems = new Set(own.map(n => ragTokens(n).join(' ')));
    c.words = [];
    for (const w of wordsOf[i]) {
      if (nameStems.has(w)) continue;
      // 1 for a word only this entry has, 1/2 for one two entries share...
      // divided again at retrieval by the words the card asks for.
      c.words.push({ term: w, weight: 1 / (df.get(w) || 1) });
    }
  });
}

/* Parse-and-cache on the card. Re-parses only when the raw text changes
   (keyed by hash) so the hot path doesn't re-parse a 40KB bible per turn. */
function getCardStorybook(card) {
  const raw = (card && card.ragStorybook) || '';
  const h = ragHash(raw);
  if (!card._storybook || card._storybook._hash !== h) {
    const parsed = parseStorybook(raw);
    parsed._hash = h;
    try { Object.defineProperty(card, '_storybook', { value: parsed, writable: true, enumerable: false, configurable: true }); }
    catch (e) { card._storybook = parsed; }
  }
  return card._storybook;
}

/* ---- Embedding client (Retriever A). Degrade-safe: any failure returns
   null and the caller proceeds tag-only. ---- */
const RAG_EMBED_PREFIX = { document: 'search_document: ', query: 'search_query: ' };
const _ragVecMem = new Map();      // hash -> Float32-ish array (in-memory mirror)
let _ragEmbedDimWarned = false;

async function ragEmbedRaw(text, mode) {
  // Returns a vector array, or null on any failure (server down, 401, etc.).
  if (!text || !text.trim()) return null;
  const prefix = RAG_EMBED_PREFIX[mode] || '';
  try {
    const resp = await fetch(EMBED_URL + '/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: prefix + text, model: 'embed' })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const vec = data && data.data && data.data[0] && data.data[0].embedding;
    return Array.isArray(vec) && vec.length ? vec : null;
  } catch (e) {
    return null;
  }
}

async function ragEmbedCached(text, mode) {
  // Document embeddings are cached by content hash (in-mem + IndexedDB).
  // Query embeddings are per-turn and not cached.
  if (mode === 'query') return await ragEmbedRaw(text, 'query');
  const h = ragHash('d:' + text);
  if (_ragVecMem.has(h)) return _ragVecMem.get(h);
  try {
    if (STORAGE_BACKEND === 'idb' && _idb) {
      const rec = await idbGet('vectors', h);
      if (rec && rec.vec) { _ragVecMem.set(h, rec.vec); return rec.vec; }
    }
  } catch (e) { /* cache miss */ }
  const vec = await ragEmbedRaw(text, 'document');
  if (vec) {
    _ragVecMem.set(h, vec);
    try { if (STORAGE_BACKEND === 'idb' && _idb) await idbPut('vectors', { hash: h, vec, ts: Date.now() }); } catch (e) {}
  }
  return vec;
}

function ragCosine(a, b) {
  if (!a || !b || a.length !== b.length) {
    if (a && b && a.length !== b.length && !_ragEmbedDimWarned) {
      console.warn('[rag] embedding dimension mismatch — stale cache from a different embed model? Clearing.');
      _ragEmbedDimWarned = true;
      _ragVecMem.clear();
      try { if (STORAGE_BACKEND === 'idb' && _idb) idbTx('vectors','readwrite').clear(); } catch (e) {}
    }
    return 0;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* Build the embeddable "doc" pool for a card: every entity/subtree that has
   description prose, plus every standalone prose chunk. Returns [{id, kind,
   parent, text, entityId}]. Embedding itself is lazy + cached per item. */
function ragBuildDocPool(book) {
  const docs = [];
  for (const id of book.order) {
    const e = book.entities[id];
    if (e.prose && e.prose.trim()) {
      docs.push({ id, kind: e.kind, parent: e.parent, text: e.prose, entityId: id });
    }
  }
  for (const c of book.proseChunks) {
    docs.push({ id: c.id, kind: 'doc', parent: null, text: c.text, entityId: null });
  }
  return docs;
}

/* ================================================================
   MEMORY FILES (issue #41)

   A character could already WRITE a file -- a ```file:notes.md block gets a
   Save button -- but never read one back. card.memoryFiles is a list of
   { name, text, updated } notes the character keeps: imported in the card
   editor, or saved straight from a file block it wrote ("Save to memory").

   They are NOT appended to the storybook. parseStorybook reads "# heading"
   as a new entity, and nearly every .md file starts with one, so a pasted
   note would turn into a tag-less entity per heading. Instead each file is
   split at its own headings into prose chunks that join Retriever A's doc
   pool beside the storybook's. Only the parts that match the conversation
   enter context, labelled with the file and section they came from.

   Matching is by meaning through the local embedding model when it is
   running. When it is not -- Nomic is optional, and Retriever A can be
   switched off -- memory chunks fall back to shared words, so a character
   without the embedding model still reads its notes rather than silently
   ignoring them. Everything here runs in the page or on this machine's own
   embed server; nothing about a memory file leaves the machine.
================================================================ */
const MEMORY_LIMITS = Object.freeze({ fileChars: 100000, files: 20, totalChars: 400000, nameChars: 100 });
const MEMORY_EXT_RE = /\.(md|markdown|txt)$/i;
const MEMORY_CHUNK_TARGET = 1200;   // characters packed into one chunk
const MEMORY_CHUNK_MAX = 2000;      // a single paragraph longer than this is split

/* A file name, never a path: the last segment, no control or reserved
   characters, no leading dots, an .md/.markdown/.txt extension, length-capped.
   '' when nothing usable is left. */
function memoryFileName(raw) {
  let n = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').pop();
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().replace(/^\.+/, '').trim();
  if (!n) return '';
  if (!MEMORY_EXT_RE.test(n)) n += '.md';
  if (n.length > MEMORY_LIMITS.nameChars) {
    const ext = n.match(MEMORY_EXT_RE)[0];
    n = n.slice(0, MEMORY_LIMITS.nameChars - ext.length).trim() + ext;
  }
  return n;
}

/* A card's memory files, validated. Read through this everywhere rather than
   card.memoryFiles directly: the field arrives from imports, backups and
   other devices, and a malformed entry must be skipped, not crash a turn. */
function cardMemoryFiles(card) {
  const raw = card && Array.isArray(card.memoryFiles) ? card.memoryFiles : [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f.name !== 'string' || typeof f.text !== 'string') continue;
    const name = memoryFileName(f.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, text: f.text, updated: Number(f.updated) || 0 });
  }
  return out;
}

/* Add a file, or replace the one with the same name (case-insensitive),
   within MEMORY_LIMITS. Returns { ok, files, replaced, name } or
   { ok: false, error }. `files` is a new array; the input is not touched. */
function memoryPutFile(files, name, text, now) {
  const clean = memoryFileName(name);
  if (!clean) return { ok: false, error: 'A memory file needs a name.' };
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!body.trim()) return { ok: false, error: clean + ' is empty.' };
  if (body.indexOf('\u0000') >= 0) return { ok: false, error: clean + ' is not a text file.' };
  if (body.length > MEMORY_LIMITS.fileChars) {
    return { ok: false, error: clean + ' is ' + body.length.toLocaleString() + ' characters; a memory file can hold up to '
      + MEMORY_LIMITS.fileChars.toLocaleString() + '.' };
  }
  const list = cardMemoryFiles({ memoryFiles: files });
  const i = list.findIndex(f => f.name.toLowerCase() === clean.toLowerCase());
  const others = list.filter((_, j) => j !== i);
  if (i < 0 && others.length >= MEMORY_LIMITS.files) {
    return { ok: false, error: 'This character already has ' + MEMORY_LIMITS.files + ' memory files. Remove one first.' };
  }
  const total = others.reduce((n, f) => n + f.text.length, 0) + body.length;
  if (total > MEMORY_LIMITS.totalChars) {
    return { ok: false, error: 'That would give this character ' + total.toLocaleString() + ' characters of memory; the limit is '
      + MEMORY_LIMITS.totalChars.toLocaleString() + '. Remove or shorten a file first.' };
  }
  const entry = { name: clean, text: body, updated: now || Date.now() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  return { ok: true, files: list, replaced: i >= 0, name: clean };
}

/* Split one file into retrieval chunks: at its headings first (outside code
   fences, so a "# comment" in a shell block is not a heading), then by
   paragraph, packing paragraphs up to MEMORY_CHUNK_TARGET characters. Each
   chunk keeps the heading path it sits under ("Quests > Open"), which both
   labels the injection and helps the match. Cached by content. */
const _memoryChunkCache = new Map();
function memoryFileChunks(file) {
  const key = ragHash(file.name + '\u0000' + file.text);
  if (_memoryChunkCache.has(key)) return _memoryChunkCache.get(key);

  const sections = [];          // { heading, paras: [] }
  const stack = [];             // [{ level, title }]
  let paras = [], para = [], inFence = false;
  const endPara = () => { if (para.join('\n').trim()) paras.push(para.join('\n').trim()); para = []; };
  const endSection = () => {
    endPara();
    if (paras.length) sections.push({ heading: stack.map(s => s.title).join(' › '), paras });
    paras = [];
  };
  for (const line of file.text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; para.push(line); continue; }
    const h = !inFence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      endSection();
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2].trim() });
      continue;
    }
    if (!inFence && !line.trim()) { endPara(); continue; }
    para.push(line);
  }
  endSection();

  // A paragraph over the max is cut at sentence ends, else at the max.
  const pieces = (p) => {
    if (p.length <= MEMORY_CHUNK_MAX) return [p];
    const out = [];
    let rest = p;
    while (rest.length > MEMORY_CHUNK_MAX) {
      const head = rest.slice(0, MEMORY_CHUNK_MAX);
      const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.lastIndexOf('? '), head.lastIndexOf('! '));
      const at = cut > MEMORY_CHUNK_MAX / 2 ? cut + 1 : MEMORY_CHUNK_MAX;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
  };

  const chunks = [];
  for (const s of sections) {
    let buf = '';
    const flush = () => {
      if (!buf.trim()) return;
      chunks.push({ id: 'mem:' + file.name + '#' + chunks.length, file: file.name, heading: s.heading, text: buf.trim() });
      buf = '';
    };
    for (const p of s.paras.flatMap(pieces)) {
      if (buf && buf.length + p.length + 2 > MEMORY_CHUNK_TARGET) flush();
      buf += (buf ? '\n\n' : '') + p;
    }
    flush();
  }
  _memoryChunkCache.set(key, chunks);
  if (_memoryChunkCache.size > 200) _memoryChunkCache.delete(_memoryChunkCache.keys().next().value);
  return chunks;
}

/* The card's memory chunks as retrieval docs. `text` is what gets embedded
   (file and heading included, so "check your notes" can match); `payload`
   is what is injected, under `label`. */
function ragMemoryDocs(card) {
  const docs = [];
  for (const f of cardMemoryFiles(card)) {
    for (const c of memoryFileChunks(f)) {
      const where = c.file + (c.heading ? ' › ' + c.heading : '');
      docs.push({ id: c.id, kind: 'memory', parent: null, entityId: null,
                  text: where + '\n' + c.text, payload: c.text, label: 'Memory file: ' + where });
    }
  }
  return docs;
}

/* Shared-word scoring, the fallback when there is no embedding to compare.
   Distinct words of three letters or more, minus the commonest English ones;
   the score is the cosine of the two word sets. */
const RAG_STOPWORDS = new Set(('the and for are but not you your yours with this that these those have has had '
  + 'from they them their there what when where which who whom will would could should about into than then '
  + 'just like been were was its our out can all any also only over some such very more most much many other '
  + 'each here how why yes did does doing done get got let may might must shall too off own same she her him '
  + 'his hers one two now new say said see seen way well back still even want know think going because '
  + 'while after before again once under upon onto being').split(' '));
function ragKeywords(text) {
  const out = new Set();
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'\-]*/gu) || [];
  for (const w of words) {
    const t = w.replace(/^['\-]+|['\-]+$/g, '').replace(/'s$/, '');
    if (t.length >= 3 && !RAG_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}
function ragKeywordScore(queryWords, docText) {
  const d = ragKeywords(docText);
  if (!queryWords.size || !d.size) return { shared: 0, score: 0 };
  let shared = 0;
  for (const w of queryWords) if (d.has(w)) shared++;
  return { shared, score: shared / Math.sqrt(queryWords.size * d.size) };
}

/* The one system line that tells the model its memory files exist and how to
   change one. Only for a card that has some; '' otherwise, so no other card's
   prompt changes by a byte. */
function cardMemoryIndexText(card) {
  const files = cardMemoryFiles(card);
  if (!files.length) return '';
  return '[Memory files]\nYou keep these files: ' + files.map(f => f.name).join(', ') + '. '
    + 'When part of one matters, it is included as [Memory file: ...]. To change one, write the whole file again in a '
    + '```file:' + files[0].name + ' block with the same name, and the user can save it back to your memory.';
}

/* Opportunistic ingest: embed-and-cache all of a card's docs ahead of time
   (fire-and-forget). Called on card save so the first chat turn isn't the one
   paying the indexing cost. Silently no-ops if the embed server is down.
   Memory files are embedded too (issue #41). */
async function ragIngestCard(card) {
  try {
    if (!state.settings.retrievalEnabled || !state.settings.retrieverA) return;
    const book = getCardStorybook(card);
    const docs = ragBuildDocPool(book).concat(ragMemoryDocs(card));
    for (const d of docs) { await ragEmbedCached(d.text, 'document'); }
  } catch (e) { /* degrade silently */ }
}

/* Per-thread warmth state (anti-flicker). Kept in-memory only — it is
   session-scoped flicker control, not worth syncing into /state. */
const _ragWarmth = new Map(); // threadId -> { entityId: remainingTurns }
function ragWarmthFor(threadId) {
  if (!_ragWarmth.has(threadId)) _ragWarmth.set(threadId, {});
  return _ragWarmth.get(threadId);
}

/* Emit a telemetry record: dispatch the event Stage 2 subscribes to, push
   onto the in-memory ring buffer, and best-effort persist to IndexedDB. This
   is the non-negotiable contract built on day one. */
const RAG_TELEMETRY_RING = 200;
function ragEmitRecord(record) {
  try {
    if (!window.__gobboTelemetry) window.__gobboTelemetry = [];
    window.__gobboTelemetry.push(record);
    if (window.__gobboTelemetry.length > RAG_TELEMETRY_RING) {
      window.__gobboTelemetry.splice(0, window.__gobboTelemetry.length - RAG_TELEMETRY_RING);
    }
  } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('gobbonet:retrieval', { detail: record })); } catch (e) {}
  // Best-effort durable append (ring-buffered). Stage 2's tracker reads these.
  (async () => {
    try {
      if (STORAGE_BACKEND !== 'idb' || !_idb) return;
      await idbPut('telemetry', record);
      const keys = await idbGetAllKeys('telemetry');
      if (keys.length > RAG_TELEMETRY_RING) {
        const excess = keys.slice(0, keys.length - RAG_TELEMETRY_RING);
        for (const k of excess) { try { await idbDelete('telemetry', k); } catch (e) {} }
      }
    } catch (e) {}
  })();
}

let _ragTurnSeq = 0;

/* The unified retrieval pipeline. Returns:
     { injections: [{ entityId, text, tokenCost }], record, retrievalTokens }
   `freeForRetrieval` is the token headroom the budgeter has left after
   system + lore + live + reserves; we never spend more than that, regardless
   of the configured retrievalBudgetTokens ceiling. Never throws. */
async function runRetrieval(thread, card, freeForRetrieval, budgetSnapshot) {
  const cfg = state.settings;
  const record = {
    turn_id: 't_' + Date.now().toString(36) + '_' + (_ragTurnSeq++),
    thread_id: thread.id,
    ts: Date.now(),
    model_id: (activeModel && (activeModel.id || activeModel.name)) || 'unknown',
    config: {
      retriever_a: !!cfg.retrieverA,
      retriever_b: !!cfg.retrieverB,
      fire_threshold: cfg.fireThreshold,
      warmth_turns: cfg.warmthTurns,
      expansion_depth: cfg.expansionDepth,
      semantic_backstop: !!cfg.semanticBackstop,
      embed_available: false,          // set true below if a query embed succeeds
      top_k_a: cfg.topKA,
      retrieval_budget_tokens: cfg.retrievalBudgetTokens,
      near_end: !!cfg.retrievalNearEnd
    },
    window: { messages_scanned: 0, tokens_scanned: 0, hash: '' },
    budget: budgetSnapshot,
    candidates: [],
    shadow: [],
    post: { ttft_ms: null, retrieval_latency_ms: 0, per_candidate_usage: [] },
    flags: { turn_rating: null, barged_in: [], missing: [] },
    cards_in_play: []
  };

  const injections = [];
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Single exit point: every path (early no-op, normal, or error) routes
  // through here so the per-turn record is emitted exactly once with latency
  // filled in. Honors the "one record per generation turn" contract.
  const finish = () => {
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    record.post.retrieval_latency_ms = Math.round(t1 - t0);
    if (typeof record.budget.retrieval_tokens !== 'number') record.budget.retrieval_tokens = 0;
    ragEmitRecord(record);
    return { injections, record, retrievalTokens: record.budget.retrieval_tokens || 0 };
  };

  try {
    if (!cfg.retrievalEnabled) { record.budget.retrieval_tokens = 0; return finish(); }

    const book = getCardStorybook(card);
    const memoryDocs = ragMemoryDocs(card);
    record.cards_in_play.push({
      card_id: card.id,
      tag_count: book.order.reduce((n, id) => n + book.entities[id].tags.length, 0),
      weight_total: book.order.reduce((n, id) => n + book.entities[id].tags.reduce((s, t) => s + t.weight, 0), 0),
      subtree_count: book.counts.subtrees,
      memory_chunks: memoryDocs.length
    });

    // Nothing authored → still emit a (cheap) record so the per-turn contract
    // holds, but skip all the work.
    const hasContent = book.order.length > 0 || book.proseChunks.length > 0 || memoryDocs.length > 0;
    if (!hasContent) { record.budget.retrieval_tokens = 0; return finish(); }

    // ---- recent window (trigger surface) ----
    const live = thread.messages.filter(m => !m.archived);
    const win = live.slice(-Math.max(1, cfg.retrievalWindowMsgs || 4));
    const windowText = win.map(m => m.content || m.reasoning || '').join('\n');
    const windowLower = windowText.toLowerCase();
    record.window.messages_scanned = win.length;
    record.window.tokens_scanned = estimateTokens(windowText);
    record.window.hash = 'fnv:' + ragHash(windowText);

    // candidate accumulator keyed by cand_id; each value collects how it was hit
    const cand = {}; // id -> { id, kind, parent, triggers:Set, matched_tags, weight_sum, semScore, offscreen, role, use, prose }
    const touch = (id) => {
      const e = book.entities[id];
      if (!cand[id]) cand[id] = {
        id, kind: e ? e.kind : 'doc', parent: e ? e.parent : null,
        triggers: new Set(), matched_tags: [], weight_sum: 0, semScore: 0,
        offscreen: e ? e.offscreenDefault : false,
        role: e ? e.roleInArcs : '', use: e ? e.usePrinciples : '',
        prose: e ? e.prose : ''
      };
      return cand[id];
    };

    // per-entity weight sums (also used for the shadow recompute)
    const weightSums = {}; // id -> { sum, matched:[{term,weight}], identityHit:bool, nameHit:bool }

    // ---- Retriever B: weighted-tag firing ----
    // Matching is on whole, lightly stemmed words (ragNormText), so "wing"
    // finds "wings" and "Selah" finds "Selah's". A sum of exactly the
    // threshold fires: .7 + .3 is 1.0, whatever floating point says.
    const thr = cfg.fireThreshold - 1e-9;
    const windowNorm = ragNormText(windowText);
    if (cfg.retrieverB) {
      for (const id of book.order) {
        const e = book.entities[id];
        let sum = 0; const matched = []; let identityHit = false;
        for (const t of e.tags) {
          if (ragPhraseHit(windowNorm, t.term)) {
            matched.push({ term: t.term, weight: t.weight });
            sum += t.weight;
            if (t.weight >= thr) identityHit = true;
          }
        }
        // The entry's name -- its header, or the id of a flat entry -- is its
        // primary trigger (1.7.9): saying it fires the entry, tags or no tags,
        // and also lifts offscreen suppression.
        const leaf = id.split('.').pop().replace(/_/g, ' ');
        const nameHit = ragPhraseHit(windowNorm, leaf);
        weightSums[id] = { sum, matched, identityHit, nameHit };

        if (sum >= thr || nameHit) {
          const c = touch(id);
          c.matched_tags = matched;
          c.weight_sum = sum;
          if (sum >= thr) c.triggers.add(identityHit ? 'identity' : 'thematic_cluster');
          if (nameHit) c.triggers.add('name');
          c._nameHit = nameHit;
        }
      }

      // Plain-text entries: a name in them fires one outright; otherwise its
      // word tags add up like any other tags, each worth 1/N of the threshold
      // where N is the words the card asks for (ragWordsToFire, default 1).
      // Word-only fires are capped at top-k, strongest first, so a long reply
      // cannot pull in everything.
      const wordsNeeded = ragWordsToFireOf(card);
      const wordFires = [];
      for (const ch of book.proseChunks) {
        const names = (ch.names || []).filter(n => ragPhraseHit(windowNorm, n));
        let sum = 0; const matched = [];
        for (const t of (ch.words || [])) {
          if (windowNorm.includes(' ' + t.term + ' ')) {
            const w = t.weight * cfg.fireThreshold / wordsNeeded;   // unrounded: 3 x 1/3 must reach 1
            matched.push({ term: t.term, weight: +w.toFixed(3) }); sum += w;
          }
        }
        if (names.length) {
          const c = touch(ch.id);
          c.prose = ch.text; c.triggers.add('name'); c._nameHit = true;
          c.matched_tags = names.map(n => ({ term: n, weight: 1 })).concat(matched);
          c.weight_sum = sum;
        } else if (sum >= thr) {
          wordFires.push({ ch, sum, matched });
        }
      }
      wordFires.sort((a, b) => b.sum - a.sum);
      for (const f of wordFires.slice(0, cfg.topKA || 5)) {
        const c = touch(f.ch.id);
        c.prose = f.ch.text; c.triggers.add('keyword');
        c.matched_tags = f.matched; c.weight_sum = f.sum;
      }
    }

    // ---- Retriever A: semantic (+ backstop). Query embed is the only
    //      per-turn embed call; doc vectors are cached from ingest. ----
    const docs = ragBuildDocPool(book).concat(memoryDocs);
    if (cfg.retrieverA && docs.length) {
      const qvec = await ragEmbedRaw(windowText, 'query');
      if (qvec) {
        record.config.embed_available = true;
        const scored = [];
        for (const d of docs) {
          const dv = await ragEmbedCached(d.text, 'document');
          if (!dv) continue;
          const sim = ragCosine(qvec, dv);
          scored.push({ d, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const SEM_FLOOR = 0.25;
        let taken = 0;
        for (const s of scored) {
          if (s.sim < SEM_FLOOR) break;
          if (taken >= (cfg.topKA || 5)) break;
          taken++;
          const targetId = s.d.entityId || s.d.id;
          const c = touch(targetId);
          c.semScore = Math.max(c.semScore, s.sim);
          c.triggers.add('semantic'); // also serves as the backstop for B entities
          if (s.d.entityId == null) c.prose = s.d.payload || s.d.text; // standalone doc payload
          if (s.d.kind === 'memory') { c.kind = 'memory'; c.label = s.d.label; }
        }
      }
    }

    // ---- memory files without embeddings: shared words (issue #41) ----
    // Only when there is no semantic match to be had -- Retriever A off, or
    // the embed server not answering -- and only for memory chunks: the
    // storybook keeps exactly the behaviour it had. A chunk needs two
    // distinct shared words, so one common word in passing does not pull a
    // whole section in.
    if (memoryDocs.length && !record.config.embed_available) {
      const qWords = ragKeywords(windowText);
      const hits = [];
      for (const d of memoryDocs) {
        const k = ragKeywordScore(qWords, d.text);
        if (k.shared >= 2 && k.score >= 0.05) hits.push({ d, k });
      }
      hits.sort((a, b) => b.k.score - a.k.score);
      for (const h of hits.slice(0, cfg.topKA || 5)) {
        const c = touch(h.d.id);
        c.kind = 'memory';
        c.label = h.d.label;
        c.prose = h.d.payload;
        c.semScore = Math.max(c.semScore, Math.min(0.8, 0.3 + h.k.score));
        c.triggers.add('keyword');
      }
      record.config.memory_keyword_fallback = true;
    }

    // ---- relational one-hop expansion (gated by offscreen_default) ----
    if (cfg.expansionDepth >= 1 && cfg.retrieverB) {
      const fired = Object.keys(cand).filter(id => cand[id].triggers.has('identity')
        || cand[id].triggers.has('thematic_cluster'));
      for (const id of fired) {
        const e = book.entities[id];
        if (!e) continue;
        for (const rel of e.relations) {
          const nid = book.entities[rel] ? rel : (book.order.find(o => o.split('.').pop() === rel) || rel);
          const ne = book.entities[nid];
          if (!ne) continue;
          if (ne.offscreenDefault) continue;       // suppressor gates the pull
          if (cand[nid]) continue;                  // already a candidate
          const c = touch(nid);
          c.triggers.add('relational');
        }
      }
    }

    // ---- warmth/decay (anti-flicker): decrement, then re-light fired ----
    const warmth = ragWarmthFor(thread.id);
    for (const id of Object.keys(warmth)) { warmth[id] -= 1; if (warmth[id] <= 0) delete warmth[id]; }
    // entities that fired this turn (and survive suppression) get re-lit below;
    // warm-but-not-fired entities are surfaced as 'warmth' candidates here.
    for (const id of Object.keys(warmth)) {
      if (!cand[id] && book.entities[id]) {
        const c = touch(id);
        c.triggers.add('warmth');
      }
    }

    // ---- score, suppress, dedupe ----
    const roleBoost = (role) => role && role.trim() ? 1.15 : 1.0;
    const triggerType = (c) => {
      if (c.triggers.has('identity')) return 'identity';
      if (c.triggers.has('name')) return 'name';
      if (c.triggers.has('thematic_cluster')) return 'thematic_cluster';
      if (c.triggers.has('relational')) return 'relational';
      if (c.triggers.has('semantic')) return 'semantic';
      if (c.triggers.has('keyword')) return 'keyword';
      if (c.triggers.has('warmth')) return 'warmth';
      return 'manual';
    };

    const ranked = [];
    for (const id of Object.keys(cand)) {
      const c = cand[id];
      const tt = triggerType(c);
      // base score: blend normalized weight-sum and semantic similarity
      const wScore = c.weight_sum > 0 ? Math.min(1, c.weight_sum / (cfg.fireThreshold * 2)) : 0;
      // Named outright: as sure a pull as there is.
      const nScore = c.triggers.has('name') ? 1 : 0;
      let base = Math.max(wScore, c.semScore, nScore);
      if (tt === 'warmth' || tt === 'relational') base *= 0.6; // dampen sticky/expanded pulls
      const score = +(base * roleBoost(c.role)).toFixed(4);

      // offscreen suppression: a thematic-only hit on an offscreen entity is
      // vetoed unless an identity tag, an explicit name mention, or a fired
      // subtree justifies it. Subtrees themselves are never suppressed.
      let suppressed = false;
      if (c.offscreen && c.kind === 'entity') {
        const onlyThematic = c.triggers.has('thematic_cluster')
          && !c.triggers.has('identity') && !c._nameHit;
        const subtreeFired = Object.keys(cand).some(o => cand[o].parent === id
          && (cand[o].triggers.has('identity') || cand[o].triggers.has('thematic_cluster')));
        if (onlyThematic && !subtreeFired) suppressed = true;
      }

      ranked.push({ c, id, tt, score, suppressed });
    }

    // dedupe note: a single id already collapses A+B hits into one candidate,
    // so budget is spent once. If the same entity surfaced via both, its
    // record carries multiple trigger flags; the canonical trigger_type is the
    // strongest one. (No separate dup rows needed — one id, one budget charge.)
    ranked.sort((a, b) => b.score - a.score);

    // ---- budget fill ----
    const retrievalCeiling = Math.max(0, Math.min(cfg.retrievalBudgetTokens || 0, Math.floor(freeForRetrieval)));
    let spent = 0;
    for (const r of ranked) {
      const e = book.entities[r.id];
      let payload = (r.c.prose || (e && e.prose) || '').trim();
      const usePrinciples = e && e.usePrinciples ? e.usePrinciples.trim() : '';
      if (!payload && !usePrinciples) { // nothing to inject (tags-only entity, no desc)
        record.candidates.push(_ragCandRow(r, 0, false, 'no_payload'));
        continue;
      }
      let injectText = payload;
      if (usePrinciples) injectText += (injectText ? '\n' : '') + '[Render guidance] ' + usePrinciples;
      const tokenCost = estimateTokens(injectText) + 4;

      if (r.suppressed) {
        record.candidates.push(_ragCandRow(r, tokenCost, false, 'offscreen_suppressed', !!usePrinciples));
        continue;
      }
      if (spent + tokenCost > retrievalCeiling) {
        record.candidates.push(_ragCandRow(r, tokenCost, false, 'budget', !!usePrinciples));
        continue;
      }
      spent += tokenCost;
      injections.push({ entityId: r.id, text: injectText, tokenCost, label: r.c.label || null });
      record.candidates.push(_ragCandRow(r, tokenCost, true, null, !!usePrinciples));
      // re-light warmth for anything actually included via a real fire
      if (r.tt === 'identity' || r.tt === 'name' || r.tt === 'thematic_cluster' || r.tt === 'semantic') {
        warmth[r.id] = cfg.warmthTurns;
      }
    }
    record.budget.retrieval_tokens = spent;

    // ---- shadow: cheap counterfactuals from the SAME window ----
    const firedAt = (thr) => book.order.filter(id => weightSums[id] && weightSums[id].sum >= thr);
    const baseFired = firedAt(cfg.fireThreshold);
    const tokAt = (ids) => ids.reduce((n, id) => {
      const e = book.entities[id]; return n + (e && e.prose ? estimateTokens(e.prose) + 4 : 0);
    }, 0);
    record.shadow.push({ config_delta: { fire_threshold: +(cfg.fireThreshold * 0.5).toFixed(2) },
      would_fire: firedAt(cfg.fireThreshold * 0.5),
      extra_tokens: tokAt(firedAt(cfg.fireThreshold * 0.5)) - tokAt(baseFired) });
    record.shadow.push({ config_delta: { fire_threshold: +(cfg.fireThreshold * 1.5).toFixed(2) },
      would_fire: firedAt(cfg.fireThreshold * 1.5),
      extra_tokens: tokAt(firedAt(cfg.fireThreshold * 1.5)) - tokAt(baseFired) });

    return finish();
  } catch (err) {
    console.warn('[rag] retrieval failed (degrading to no injection):', err && err.message);
    record.error = String(err && err.message || err);
  }

  return finish();
}

/* Build one candidates[] row for the telemetry record. */
function _ragCandRow(r, tokenCost, included, evictionReason, useAttached) {
  return {
    cand_id: r.id,
    kind: r.c.kind,
    parent_entity: r.c.parent,
    trigger_type: r.tt,
    matched_tags: r.c.matched_tags,
    weight_sum: +(r.c.weight_sum || 0).toFixed(3),
    score: r.score,
    offscreen_default: !!r.c.offscreen,
    included: !!included,
    eviction_reason: evictionReason,
    use_principles_attached: !!useAttached,
    token_cost: tokenCost
  };
}

/* Confined weight-annotation scrub. ONLY strips a trailing " [n.n]" that
   directly follows one of the supplied tag terms — never a blanket bracket
   strip (that would eat legitimate [stage directions], [redacted], dice
   notation). Used by translateTemplates as a safety net for the rare case
   where a tag term with its weight leaks into injected prose. */
function ragScrubWeightAnnotations(text, terms) {
  if (!text || !terms || !terms.length) return text;
  let out = text;
  for (const term of terms) {
    if (!term) continue;
    const t = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(' + t + ')\\s*\\[\\s*[\\d.]+\\s*\\]', 'gi'), '$1');
  }
  return out;
}

async function buildContextMessages(thread, card, opts) {
  opts = opts || {};
  // Per-card, falling back to the model's detected context.
  const tokenLimit = resolveContextLimit(card);
  // The four fractions below are the character's own since roadmap 1.7.7
  // #6d (card -> setting -> the old constants), resolved and range-checked
  // in resolveContextBudget (js/04-state.js). The comments describe what
  // each one does; the numbers in them are the defaults.
  const ctxBudget = resolveContextBudget(card);
  const budget = Math.floor(tokenLimit * ctxBudget.input);

  // Post-compression landing zone, as a fraction of budget. The gap
  // between this and 1.0 = headroom before the NEXT compression fires.
  //   0.65 → ~25% headroom
  //   higher → smaller savings per pass, more frequent compressions
  //   lower  → bigger savings per pass, longer between compressions
  const TARGET_FACTOR = ctxBudget.land;            // default 0.65

  // Trailing token reserve: the most-recent slice of the conversation
  // we promise to keep verbatim no matter what. Expressed as a fraction
  // of the budget so it scales with the configured context size — at
  // 16k this is ~3.1k tokens of recent talk, at 100k it's ~19.5k. Both
  // are sensible "don't compress what the model needs to respond to
  // the next turn" floors.
  const RECENT_RESERVE_FACTOR = ctxBudget.keep;    // default 0.22
  const recentReserve = Math.floor(budget * RECENT_RESERVE_FACTOR);

  // Response reserve: how much of the budget we hold back as guaranteed
  // room for the model's REPLY. Without this, compression only fires
  // when the INPUT crosses 90% of CTX — leaving as little as one short
  // user message's worth of room for the response. On turns where the
  // user just said "ok" or "go on", the AI started generating with ~10%
  // of CTX (or less) for output and a long reply got truncated mid-token
  // because the tiny user message didn't push the input over the line.
  //
  // The fix is to make the compression trigger output-aware: fire when
  // there isn't enough room left for a meaningful reply, not just when
  // the input has overflowed. Expressed as a fraction of budget so it
  // scales with context size:
  //   at 16K CTX  → ~2.9K output tokens reserved at trigger
  //   at 32K CTX  → ~5.9K
  //   at 100K CTX → ~18K
  //
  // Combined with the existing 10%-of-CTX physical margin (budget vs
  // tokenLimit), the AI is guaranteed ~30% of CTX worth of output room
  // at the moment compression fires, and substantially more right after
  // compression lands at TARGET_FACTOR. NOTE: the hard trim safety net
  // further down still keys off `budget` (the real physical ceiling) —
  // this reserve is a softer trigger, not a new physical limit.
  const RESPONSE_RESERVE_FACTOR = ctxBudget.reply;  // default 0.20
  const responseReserve = Math.floor(budget * RESPONSE_RESERVE_FACTOR);
  const effectiveBudget = budget - responseReserve;

  // ---- Fixed (per-build) context overhead ----
  // Writing style is the primary behavioural directive. It is emitted as
  // the LAST system block (see assembly below) so it lands freshest under
  // recency-weighted templates, but its token cost is fixed regardless.
  const writingStyleTokens = estimateTokens(card.writingStyle) + 4;

  // Personality is now a PERSISTENT block (position 2), established on every
  // turn rather than re-injected on a cadence. Counted whenever present.
  const personalityText = (card.personality || '').trim();
  const personalityTokens = personalityText ? estimateTokens(personalityText) + 4 : 0;

  // Authored world/setting lore (card.startingLore): small, always-on,
  // pulled FRESH from the card each build and emitted as the position-1
  // block. Kept distinct from the running conversation summary below — the
  // two are no longer blended into a single field.
  const authoredLore = (card.loreEnabled && card.startingLore) ? card.startingLore.trim() : '';
  const authoredLoreTokens = authoredLore ? estimateTokens(authoredLore) + 4 : 0;

  // Persona injection (USER info). The cadence is unchanged; only its
  // POSITION moves — it now lands LAST, immediately before the final user
  // message, because the model weights the tail of the prompt most. Anchored
  // on user message 1 too so the model knows who it's talking to from turn 1.
  // injectionFrequency === 0 disables injection (name/colors still apply).
  const totalUserMsgs = thread.messages.filter(m => m.role === 'user').length;
  const personaForBuild = getActivePersona();
  const personaFreq = (typeof personaForBuild.injectionFrequency === 'number')
    ? personaForBuild.injectionFrequency
    : 5;
  const personaDesc = (personaForBuild.description || '').trim();
  const needsPersonaInject = personaFreq > 0
    && personaDesc
    && (totalUserMsgs === 1
        || (totalUserMsgs > 1 && totalUserMsgs % personaFreq === 0));
  const personaPromptText = needsPersonaInject
    ? `[Persona: ${personaForBuild.name || 'Anonymous'}]\n${personaDesc}`
    : '';
  const personaTokens = needsPersonaInject ? estimateTokens(personaPromptText) + 4 : 0;

  // Running conversation summary (thread.lore — now summary-ONLY; authored
  // lore is never folded in). Emitted as the position-3 block.
  let summary = getThreadLore(thread);
  const summaryTokens = (summary && card.loreEnabled) ? estimateTokens(summary) + 4 : 0;

  // The one-line index of the card's memory files (issue #41): their names,
  // and how to change one. Empty -- and free -- for a card that has none.
  const memoryIndexText = cardMemoryIndexText(card);
  const memoryIndexTokens = memoryIndexText ? estimateTokens(memoryIndexText) + 4 : 0;

  let usedTokens = writingStyleTokens + personalityTokens + authoredLoreTokens
                 + personaTokens + summaryTokens + memoryIndexTokens;

  // Live (non-archived) messages — what we'd send if no compression
  // happened this turn. Pre-compute per-message token costs so we can
  // walk back from the tail accumulating into the reserve.
  let liveMsgs = thread.messages.filter(m => !m.archived);
  const liveCosts = liveMsgs.map(m =>
    estimateTokens(m.content || '') + estimateTokens(m.reasoning || '') + 4
    + (m.attachmentText ? estimateTokens(m.attachmentText) : 0)
  );
  const liveTokens = liveCosts.reduce((a, b) => a + b, 0);
  const projected  = usedTokens + liveTokens;

  // Trigger: would sending right now leave too little room for the
  // model's reply? `effectiveBudget` = `budget` minus the response
  // reserve, so we fire earlier than the raw input ceiling and the AI
  // always has at least responseReserve worth of output headroom.
  const shouldSummarize = card.loreEnabled && projected > effectiveBudget && liveMsgs.length > 1;

  if (shouldSummarize) {
    // How many tokens do we want to free? Aim to land at TARGET_FACTOR
    // of budget. Reserve some headroom for the lore that's about to
    // grow, so we don't immediately bounce back over the line.
    const summaryReserve = Math.max(summaryTokens, 1024);
    const targetTotal    = Math.floor(budget * TARGET_FACTOR);
    const fixedOverhead  = writingStyleTokens + personalityTokens + authoredLoreTokens + personaTokens
                         + memoryIndexTokens;
    const targetLive     = Math.max(0, targetTotal - fixedOverhead - summaryReserve);
    const tokensToFree   = Math.max(0, liveTokens - targetLive);

    // Walk back from the tail accumulating the trailing reserve. The
    // index `firstArchivable` is the boundary: everything BEFORE it is
    // a candidate to archive; everything from it onward stays verbatim.
    let tailTokens = 0;
    let firstArchivable = liveMsgs.length;
    for (let i = liveMsgs.length - 1; i >= 0; i--) {
      if (tailTokens + liveCosts[i] > recentReserve && i < liveMsgs.length - 1) {
        firstArchivable = i + 1;
        break;
      }
      tailTokens += liveCosts[i];
      firstArchivable = i;
    }

    // Walk oldest-first within the archivable range, marking messages
    // until we've freed enough — or run out of archivable candidates.
    const toArchive = [];
    let freed = 0;
    for (let i = 0; i < firstArchivable; i++) {
      const m = liveMsgs[i];
      m.archived = true;
      toArchive.push(m);
      freed += liveCosts[i];
      if (freed >= tokensToFree) break;
    }

    // Safety net: selection found nothing, but we are over the PHYSICAL
    // ceiling.
    //
    // firstArchivable can land on 0 when the trailing reserve covers the
    // whole live window — which happens when the fixed overhead (a big
    // storybook, a long authored lore, a fat writing style) is eating most
    // of the budget rather than the conversation being long. The old code
    // did nothing at all in that case: no archive, no fold, no note. The
    // hard trim further down then quietly shifted those same messages out
    // of the payload to make the request fit, leaving the model a hole it
    // could not see and the user no record that anything had gone.
    //
    // So when the live window alone is over `budget`, take the oldest
    // messages anyway and let compression have them. They are leaving the
    // context either way; the only question is whether they leave as a
    // summarised beat or as silence. Floor of two verbatim messages so the
    // model always has the exchange it is replying to, and we stop as soon
    // as we are back under the ceiling rather than clearing the board.
    if (toArchive.length === 0 && (usedTokens + liveTokens) > budget && liveMsgs.length > 2) {
      for (let i = 0; i < liveMsgs.length - 2; i++) {
        const m = liveMsgs[i];
        m.archived = true;
        toArchive.push(m);
        freed += liveCosts[i];
        if ((usedTokens + liveTokens - freed) <= budget) break;
      }
      if (toArchive.length) {
        console.warn('[lore] the trailing reserve covered the whole live window but '
          + 'the context is over budget — folding the ' + toArchive.length
          + ' oldest message' + (toArchive.length === 1 ? '' : 's')
          + ' anyway rather than dropping them silently.');
      }
    }

    if (toArchive.length > 0) {
      // Fold the just-archived chunk into the running summary (with any prior).
      const _loreBefore = summary || '';
      // Pass the card's authored lore too, so the model can see the premise
      // it must not restate. Only the generated beats come back and get
      // stored -- authored lore stays the card's, untouched.
      const _authored = (card && card.loreEnabled && card.startingLore)
        ? card.startingLore.trim() : '';
      // tokenLimit is the fallback context budget, used only when the
      // server does not report its own n_ctx (file:// mode, proxy down,
      // older llama-server). It can overestimate -- it is clamped to the
      // model's TRAINING context, not the --ctx-size the server was
      // started with -- which is why summarizeForLore still treats a 400
      // as the no-room case rather than trusting this number.
      const _produced = await compressWithCardModel(summary, toArchive, _authored, tokenLimit, card);
      // Not setThreadLore directly: the await above is seconds long on a local
      // model, and the summary is hand-editable, so what is stored now may no
      // longer be what this pass started from. See mergeLoreAfterPass.
      const _merge = mergeLoreAfterPass(thread, _loreBefore, _produced);
      summary = _merge.lore;

      // Record what this pass actually did. Without a before/after size you
      // cannot tell a summary that is absorbing new events from one that is
      // simply accreting — which is exactly how the repeated-location bug
      // hid: every pass "worked", and only the growth curve showed it was
      // appending rather than rewriting.
      //
      // Snapshots are capped at the last 6 passes so a long thread does not
      // carry an unbounded audit trail around in state.
      try {
        if (!Array.isArray(thread.loreLog)) thread.loreLog = [];
        thread.loreLog.push({
          at: Date.now(),
          folded: toArchive.length,
          before: _loreBefore.length,
          after: (summary || '').length,
          summary: summary || '',
          // null when the pass produced a summary; a reason string when it
          // gave up. A row with before === after AND a reason is a failure
          // wearing the same clothes as a no-op.
          why: (typeof _loreLastOutcome !== 'undefined') ? _loreLastOutcome : null,
          // The inspector used to infer failure from after === 0. That no
          // longer holds: a failed pass now writes a gap marker, so
          // `after` is non-zero and the row would read as a note rather
          // than a fault. Record the verdict instead of deriving it.
          // Absent on rows written before this change, which is why the
          // inspector keeps the old check as a fallback.
          failed: (typeof _loreLastKind !== 'undefined')
                  && _loreLastKind !== 'ok' && _loreLastKind !== 'skip',
          // Set when the summary was hand-edited while this pass was in
          // flight. Recorded rather than left to be noticed: a row whose
          // `after` does not follow from its `before` otherwise looks like
          // the pass misbehaving.
          editedDuringPass: _merge.merged || _merge.dropped || false,
          beatDropped: _merge.dropped || false
        });
        while (thread.loreLog.length > 6) thread.loreLog.shift();
      } catch (e) { /* telemetry must never break a turn */ }

      // Persistent marker so the user can see the compression event while
      // the post-compression COT streams in. summarizeForLore's transient
      // "compressing..." indicator goes away the moment it returns; without
      // this, the only surviving record is the small "📝 N folded into lore"
      // divider near the TOP of the chat, which is easy to miss when the
      // user's eye is on the streaming reply at the bottom. Read by
      // renderMessages; cleared at the start of the next user turn.
      // Carries the VERDICT, not just the count. The banner used to say
      // "folded N older messages into the summary" on every pass that
      // archived anything -- including the ones that archived those
      // messages and then failed to summarise them. That is the most
      // misleading moment in the whole feature: the user is told their
      // history was preserved at the exact instant it was dropped.
      const _kind = (typeof _loreLastKind !== 'undefined') ? _loreLastKind : 'ok';
      pendingLoreCompressionNote = {
        count: toArchive.length,
        threadId: thread.id,
        kind: _kind,
        reason: (_kind === 'ok' || _kind === 'skip')
          ? null
          : ((typeof _loreLastOutcome !== 'undefined' && _loreLastOutcome)
             || 'compression did not complete')
      };

      // Recompute post-archive state. usedTokens now reflects the new
      // (typically smaller) lore — this is what gets returned to the
      // caller as tokensUsed so the status bar shows reality.
      liveMsgs = thread.messages.filter(m => !m.archived);
      usedTokens = writingStyleTokens + personalityTokens + authoredLoreTokens + personaTokens
                 + (summary ? estimateTokens(summary) + 4 : 0) + memoryIndexTokens;
      saveState();
      renderMessages();   // surface the dimming + lore divider immediately
    }
  }

  // Trim safety net — pathological case where the LIVE window alone
  // still exceeds budget (one giant pasted message, lore disabled, or
  // the trailing reserve itself is over budget). We trim what we send
  // to the API but do NOT archive these — they remain visible and
  // unfaded in the scrollback.
  let finalRecent = [...liveMsgs];
  let recentTotal = estimateMessagesTokens(finalRecent);
  while (finalRecent.length > 2 && (usedTokens + recentTotal) > budget) {
    finalRecent.shift();
    recentTotal = estimateMessagesTokens(finalRecent);
  }

  // Assemble in ascending priority — the model weights what arrives LAST, so
  // the order is: lore -> personality -> summary -> RAG -> writing style, then
  // the conversation, then (just before the final user turn) the response
  // direction and the USER's persona. Lock in character/user names at call
  // time so translateTemplates can't race with a card switch mid-build.
  //
  // PROMPT ORDER (CONFIG > Prompt Order, settings.retrievalNearEnd). The
  // engine keeps the last prompt it read and reuses it up to the first
  // character that differs; everything after that point is read again. The
  // retrieved snippets change from turn to turn, so with them up top almost
  // the whole prompt -- the conversation included -- is read again on every
  // message. With the setting on they go just before the newest message,
  // next to the response direction and persona that already sit there, so
  // only the end of the prompt changes. Off keeps the order above.
  //
  // FUTURE: the whole order is meant to become the user's to arrange. Until
  // then this one switch moves the one block that changes most.
  const charName = card.name || 'Assistant';
  const userName = personaForBuild.name || 'Anonymous';

  const apiMessages = [];

  // ---- 1. LORE (authored world/setting; fresh from the card) ----
  if (authoredLore) {
    apiMessages.push({ role: 'system',
      content: '[Lore]\n' + translateTemplates(authoredLore, charName, userName) });
  }

  // ---- 2. PERSONALITY (+ character identity) — persistent every turn ----
  {
    let personalityBlock = `[Character: ${charName}]`;
    if (personalityText) personalityBlock += '\n' + translateTemplates(personalityText, charName, userName);
    apiMessages.push({ role: 'system', content: personalityBlock });
  }

  // ---- 3. AUTO-SUMMARY (running summary of older, archived turns) ----
  if (summary && card.loreEnabled) {
    apiMessages.push({ role: 'system',
      content: '[Story so far \u2014 summary of earlier messages]\n' + translateTemplates(summary, charName, userName) });
  }

  // ---- RAG retrieval (Stage 1) ----
  // Carve the retrieval budget from the SAME accounting the budgeter already
  // uses: whatever room is left after system + lore + live convo, minus the
  // response reserve so retrieved lore never eats the model's reply headroom.
  // runRetrieval never throws; on any failure it returns no injections and
  // still emits a telemetry record. Diagnostic builds (gobboDiag) suppress
  // emission + warmth mutation via opts.diag.
  let retrievalTokens = 0;
  const ragMsgs = [];
  if (!opts.diag) {
    const summaryTokensNow = (summary && card.loreEnabled) ? estimateTokens(summary) + 4 : 0;
    const budgetSnapshot = {
      token_limit: tokenLimit,
      budget: budget,
      system_tokens: writingStyleTokens + personalityTokens + memoryIndexTokens,
      lore_summary_tokens: authoredLoreTokens + summaryTokensNow,
      live_convo_tokens: recentTotal,
      retrieval_tokens: 0,
      free_tokens: Math.max(0, budget - usedTokens - recentTotal)
    };
    const freeForRetrieval = Math.max(0, budget - usedTokens - recentTotal - responseReserve);
    try {
      const ret = await runRetrieval(thread, card, freeForRetrieval, budgetSnapshot);
      retrievalTokens = ret.retrievalTokens || 0;
      for (const inj of ret.injections) {
        // Tag terms (with their authored weights) are control data and must
        // never reach the model. The confined scrub strips a trailing
        // " [n.n]" only when it directly follows one of THIS card's tag
        // terms — legitimate [brackets] in story prose are left untouched.
        const allTerms = [];
        try {
          const bk = getCardStorybook(card);
          for (const id of bk.order) for (const t of bk.entities[id].tags) allTerms.push(t.term);
        } catch (e) {}
        const scrubbed = ragScrubWeightAnnotations(inj.text, allTerms);
        ragMsgs.push({
          role: 'system',
          content: '[' + (inj.label || (/^doc:/.test(inj.entityId) ? 'Storybook' : 'Storybook: ' + inj.entityId)) + ']\n' + translateTemplates(scrubbed, charName, userName)
        });
      }
    } catch (e) {
      console.warn('[rag] injection skipped:', e && e.message);
    }
  }
  // Near the end only when there is a user message to put them in front of;
  // otherwise (nothing sent yet) where they have always been.
  const ragBeforeIdx = (state.settings && state.settings.retrievalNearEnd === true)
    ? finalRecent.map(m => m.role).lastIndexOf('user') : -1;
  if (ragBeforeIdx < 0) apiMessages.push(...ragMsgs);

  // ---- 4b. MEMORY FILES index (issue #41) — after the retrieved parts
  // (or, with Prompt Order on, before them: its wording, "is included as",
  // holds either way), before the writing style. Only for a card that has
  // memory files. ----
  if (memoryIndexText) {
    apiMessages.push({ role: 'system', content: memoryIndexText });
  }

  // ---- 5. WRITING STYLE (primary directive) — emitted LAST among the
  // system blocks so it sits freshest right before the conversation. ----
  apiMessages.push({ role: 'system', content: translateTemplates(card.writingStyle, charName, userName) });

  // Pick a carousel line once per context build (mutates card index for sequential mode)
  const carouselLine = pickCarouselLine(card);
  if (carouselLine) {
    // Save the updated index (sequential mode incremented it)
    saveState();
  }

  for (let i = 0; i < finalRecent.length; i++) {
    const m = finalRecent[i];
    const isLastUserMsg = m.role === 'user' && i === finalRecent.length - 1;
    // The snippets, when the setting puts them near the end: ahead of the
    // response direction and persona, so those stay closest to the message.
    // The last user message may be followed by an empty reply slot (a
    // reroll), which is why this is its own index and not isLastUserMsg.
    if (i === ragBeforeIdx) apiMessages.push(...ragMsgs);
    // Just before the final user turn, in ascending priority: the optional
    // per-response narrative nudge, then the USER's persona LAST so it sits
    // immediately against the user message (recency = highest weight). The
    // old periodic personality reminder is gone — personality is now a
    // persistent block up top (position 2).
    if (carouselLine && isLastUserMsg) {
      apiMessages.push({ role: 'system', content: '[Narrative direction for this response]\n' + translateTemplates(carouselLine, charName, userName) });
    }
    if (needsPersonaInject && isLastUserMsg) {
      apiMessages.push({ role: 'system', content: translateTemplates(personaPromptText, charName, userName) });
    }
    // Use content for the API. If content is empty but reasoning exists
    // (older messages from before the parser split was working), fall back
    // to reasoning. Standard practice for thinking-style models is to send
    // only the final response back in history, not the chain-of-thought.
    let msgContent = translateTemplates(m.content || (m.role === 'assistant' ? m.reasoning : '') || '', charName, userName);
    if (m.attachmentText) msgContent = m.attachmentText + msgContent;
    if (m.searchData) msgContent += '\n' + m.searchData;
    apiMessages.push({ role: m.role, content: msgContent });
  }

  const finalApiMessages = normalizeMessagesForStrictTemplates(apiMessages);

  // The 'context' hook, firing for real. It has been in the advertised hook
  // list since day one and was invoked nowhere, so a card registering for it
  // got silence -- and on() accepted the registration, so it looked correct.
  //
  // Handlers run AFTER normalisation and may mutate the array in place. A
  // handler that throws is disabled by runCardHook and the turn proceeds
  // with the array untouched.
  try {
    runCardHook('context', { messages: finalApiMessages, thread: thread });
  } catch (e) { console.error('[card-code] context hook:', e); }

  // Diagnostic: log the shape and sizes we're about to send. If you ever
  // see consecutive same-role entries or a leading non-system non-user,
  // the normalization missed an edge case. roleSeq is the at-a-glance
  // version; the full object below has content lengths for sanity.
  if (typeof console !== 'undefined' && console.debug) {
    const roleSeq = finalApiMessages.map(m => m.role[0]).join('');  // e.g. "suaua"
    console.debug(
      `[chat] sending ${finalApiMessages.length} msgs to /llm (roles: ${roleSeq})`,
      finalApiMessages.map(m => ({ role: m.role, chars: (m.content || '').length }))
    );
  }

  return {
    apiMessages: finalApiMessages,
    tokensUsed: usedTokens + recentTotal + retrievalTokens,
    budget
  };
}

