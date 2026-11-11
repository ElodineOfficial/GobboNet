/* @gobbonet-split js/04-state.js
   Moved verbatim from chat.html lines 3135-3352.
   the state object and all defaults
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   STATE
================================================================ */
// Storage key — 'gobbonet_chat_state' going forward; migrate from old key if needed.
const STORAGE_KEY = 'gobbonet_chat_state';
const LEGACY_STORAGE_KEY = 'gemma4_chat_state';

/* The shape of the save blob. Stamped into every write by buildStateMeta(),
   so nothing downstream ever has to guess what it is reading -- not a later
   version of GobboNet, not the migration pass, and not a person looking at
   the file with a text editor.

     (absent)  everything up to and including 1.7.5: conversations were
               ordered by a `threadOrder` list of ids in the meta half of the
               file, and messages/settings otherwise as they are now
     1         conversations carry their own `order`; no `threadOrder`

   Absent is a real value and means "written before the stamp existed", which
   is a thing to look at, not an error -- there are files out there from the
   PowerShell era.

   Bump this when a load would have to do something DIFFERENT with an older
   file, not merely tolerate a missing field, which every version has always
   done. A bump is a promise that the migration pass knows how to get from the
   version below it to this one. */
const STATE_SCHEMA_VERSION = 1;

// What the blob we actually loaded declared. Set by applyLoadedState().
let loadedSchemaVersion = null;
// Conversations applyLoadedState() pinned while carrying a legacy threadOrder
// list into numeric keys; loadState() persists them so the carry runs once.
let legacyThreadOrderAdopted = [];
/* Fallback colours used when a card or persona has no colour set.
 *
 * These MUST match the values the colour pickers show (15-cards.js:183-184,
 * 17-personas.js:79-80). The pickers have always defaulted a blank field to
 * a colour, but saveCard/savePersona read the PICKER, not the record -- so
 * opening an editor, seeing magenta in the swatch and closing without
 * pressing Save left the record empty while the swatch had promised a
 * colour.
 *
 * That mattered most for dialogColor, because the renderer read
 * `card.dialogColor || ''` and parseMarkdown skips the entire dialogue pass
 * on a falsy colour. Every user-created card, every imported card and every
 * persona therefore had dialogue colouring silently switched off, while the
 * bundled characters -- the only records in the app with the field
 * populated -- worked fine. It read as an intermittent parser bug and
 * survived several rewrites of the quote pattern.
 *
 * They are applied at RENDER time, not just as creation defaults, because
 * that also repairs the cards already sitting in people's browsers. Fixing
 * only the defaults would help nobody who already had a card.
 */
const FALLBACK_CARD_TEXT_COLOR      = '#e0f8ff';
const FALLBACK_CARD_DIALOG_COLOR    = '#d900ff';
const FALLBACK_PERSONA_TEXT_COLOR   = '#00b8ff';
const FALLBACK_PERSONA_DIALOG_COLOR = '#00f3ff';

const DEFAULT_CARD = {
  id: 'default',
  name: 'Assistant',
  avatar: '',
  writingStyle: 'You are a helpful, friendly, and knowledgeable assistant running fully offline on your local machine. Be concise when the question is simple. Be thorough when the question is complex. Use markdown formatting when it aids readability. When asked to create a file, output it in a code block tagged with the filename like: ```file:example.json followed by the content and closing ```. The user will see a Save button to download it. To change a file you already wrote, write the whole file again with the same name.',
  personality: 'Stay focused, helpful, and accurate. If you are unsure about something, say so rather than guessing.',
  loreEnabled: true,
  // Which GGUF compresses this card's lore. Empty means "whatever the chat
  // is already using", which is what every existing card resolves to and is
  // exactly the behaviour before this field existed.
  //
  // A filename from the models folder, matching the values in
  // models-list.json — the same list the header dropdown uses. Anything the
  // user has dropped into that folder is a valid choice; nothing else is.
  loreModelFile: '',
  // Model links (1.8.0, #52): the model this character is meant for. A file
  // name from the models folder, never a path; '' is "whatever is loaded".
  // Checked by isPlainModelFile() before use, and only ever matched against a
  // model that is installed (js/02-model.js, MODEL LINKS).
  preferredModel: '',
  // The lore prompt (js/07-prompt.js, THE LORE PROMPT). Off: the built-in
  // LORE_DEFAULT_PROMPT. On: lorePrompt, written in the card editor's
  // "Edit the lore summary prompt" box.
  loreCustomPrompt: false,
  lorePrompt: '',
  startingLore: '',
  // RAG Storybook — the big, hand-authored character/world bible. Accepts
  // structured weighted-tag lines (Retriever B) AND/OR plain prose chunks
  // (Retriever A), in the same field; the parser routes by shape. Unlike
  // startingLore (small, always-on), the storybook is large and retrieved
  // ON DEMAND — only the entity/subtree a scene needs enters context. See
  // parseStorybook() and the RAG ENGINE block for the full grammar.
  ragStorybook: '',
  // How many of a plain-text storybook entry's distinctive words must appear
  // in the chat to pull it in (1.7.9). 1 by default, the way lorebooks
  // usually behave; 2 or 3 for a large world bible that fires too easily.
  // A name in the entry always pulls it in, whatever this is.
  ragWordsToFire: 1,
  // Memory files (issue #41): [{ name, text, updated }] -- .md notes the
  // character reads back through retrieval, imported in the editor or saved
  // from a ```file:name.md block it wrote. Read via cardMemoryFiles()
  // (js/08-rag.js), which validates them; see MEMORY_LIMITS there.
  memoryFiles: [],
  // Pre-set opening message injected into new threads as the character's
  // first assistant turn. NOT model-generated — verbatim from this field.
  // {{char}} / {{user}} / macros are resolved at thread-creation time.
  greeting: '',
  // Optional pool of alternate openings. When altGreetingsEnabled is true
  // and at least one non-empty entry is present, the greeting is stored as
  // msg.variants on the injected message so the user can flip between
  // openings using the existing ◀ ▶ variant navigator. Blank-line
  // separated so individual greetings can span multiple paragraphs.
  altGreetingsEnabled: false,
  altGreetings: '',
  background: '',
  textColor: FALLBACK_CARD_TEXT_COLOR,
  dialogColor: FALLBACK_CARD_DIALOG_COLOR,
  temperature: 0.7,
  minP: 0.05,
  topK: 40,
  topP: 0.95,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  xtcProbability: 0,
  xtcThreshold: 0.1,
  dryMultiplier: 0,
  bannedPhrases: '',
  // Auto Reroll (1.8.0): a reply that uses one of these words is written
  // again, up to autoRerollMax more times (runGenerationWithReroll in
  // 03-generation.js). Off until the owner ticks it, read as `=== true`.
  autoRerollEnabled: false,
  autoRerollWords: '',
  autoRerollMax: 3,
  // Per-card custom code. Opt-in, off by default, and never enabled by an
  // import -- see applyImportedCardCode in 23-card-code.js.
  customCode: '',
  customCodeEnabled: false,
  // Per-card overrides. 0 / false means "inherit" -- see resolveContextLimit
  // and resolveSmartLimit below. Zero is a safe sentinel here in a way the
  // empty string was not for colours: it is genuinely not a valid limit, so
  // `card.contextLimit || fallback` cannot silently disable anything.
  contextLimit: 0,
  smartLimitEnabled: false,
  smartLimitTokens: 300,
  // Roadmap 1.7.7 #9. Read as `!== false` (cardThinkingEnabled), so a card
  // without the field thinks, as every card did before it existed.
  thinkingEnabled: true,
  // Tool calling. Read as `=== true` (cardToolDefs, 23-card-code.js): only a
  // card whose owner ticked the box offers its code's tools to the model.
  toolsEnabled: false,
  // Roadmap 1.7.7 #6d. null = inherit the setting -- see resolveContextBudget.
  contextInputPercent: null,
  contextReplyPercent: null,
  contextLandPercent: null,
  contextKeepPercent: null,
  logitBiasStrength: -20
};
/* Per-card context and reply limits.
 *
 * These were global settings, which meant one number had to serve a code
 * assistant answering in three lines and a DM writing scene prose. Cards
 * own them now; the globals below survive only as the inherited default
 * and the target for the model auto-detect in 02-model.js.
 *
 * Resolution happens at READ time, not as a stored default, so every card
 * already in someone's browser inherits sensible values instead of needing
 * a migration -- the same lesson as the dialogColor bug.
 */

/** Input context budget in tokens for a card. 0 on the card means auto. */
function resolveContextLimit(card) {
  const model = (typeof activeModel !== 'undefined' && activeModel) ? activeModel : null;

  let n = parseInt(card && card.contextLimit, 10) || 0;
  if (!n) {
    // Auto: what the model reports, else whatever the old global held.
    n = (model && model.defaultCtx) || (state.settings && state.settings.tokenLimit) || 24576;
  }

  // Clamp to what the model can actually take. A card carried over from a
  // 128K machine would otherwise ask a 4K model for 128K of context and the
  // server would silently truncate somewhere we cannot see.
  const ceiling = (model && model.maxCtx) || 0;
  if (ceiling && n > ceiling) n = ceiling;

  return Math.max(2048, n);
}

/** {enabled, tokens} for the reply-length cap. */
function resolveSmartLimit(card) {
  const s = state.settings || {};
  const enabled = (card && typeof card.smartLimitEnabled === 'boolean')
    ? card.smartLimitEnabled
    : !!s.smartLimitEnabled;
  const raw = (card && parseInt(card.smartLimitTokens, 10))
    || parseInt(s.smartLimitTokens, 10) || 300;
  // A floor, no ceiling. This used to clamp at 8192, silently, on a number the
  // user typed for their own character -- the kind of hard-coded limit roadmap
  // 1.7.7 #6 removes. 25 stays as a sanity floor: below it the sentence-end cut
  // in 03-generation.js has nothing to work with.
  return { enabled: enabled, tokens: Math.max(25, raw) };
}

/* How a character spends its context, and when lore compression fires
   (roadmap 1.7.7 #6d). Four percentages that were constants in
   buildContextMessages (js/08-rag.js):

     contextInputPercent  of the context the prompt may use       (90)
     contextReplyPercent  of that kept free for the reply: when   (20)
                          less is left, compression starts
     contextLandPercent   of that, where compression brings the   (65)
                          chat back down to
     contextKeepPercent   of that, the most recent turns, which   (22)
                          are never summarised

   Per character, falling back to the setting (presettable from config.toml's
   [ui] table), falling back to the old constant -- so nothing moves for anyone
   who leaves them alone. A card field that is blank, null or absent INHERITS;
   0 is a real value for the two that allow it.

   The four are not independent, and some combinations stall compression
   rather than merely tuning it:
     - a landing point at or above where compression starts frees almost
       nothing, so it fires again on every message;
     - a verbatim reserve at or above the landing point means compression can
       never get down to it.
   So each is clamped to its own range, then to its neighbours with a 5-point
   gap, in a fixed order (reply, then land, then keep). Every adjustment is
   reported in `notes`, which the card editor shows -- a number quietly changed
   on its way to being used is the thing #6 exists to stop.

   Read by buildContextMessages AND by updateContextInfo (js/13-dashboard.js),
   whose meter shows how close a chat is to compressing; they used to carry
   separate copies of 0.9 and 0.20 with a "keep these in sync" comment. */
const CONTEXT_BUDGET_RANGES = {
  contextInputPercent: { min: 10, max: 99, fallback: 90, name: 'Input budget' },
  contextReplyPercent: { min: 0,  max: 60, fallback: 20, name: 'Reply room' },
  contextLandPercent:  { min: 10, max: 95, fallback: 65, name: 'Land at' },
  contextKeepPercent:  { min: 0,  max: 90, fallback: 22, name: 'Keep verbatim' },
};
function _contextPercent(card, key) {
  const fromCard = card ? card[key] : undefined;
  if (fromCard !== '' && fromCard !== null && fromCard !== undefined && isFinite(Number(fromCard))) {
    return Number(fromCard);
  }
  const s = state.settings ? Number(state.settings[key]) : NaN;
  return isFinite(s) ? s : CONTEXT_BUDGET_RANGES[key].fallback;
}
function resolveContextBudget(card) {
  const notes = [];
  const pct = {};
  for (const key of Object.keys(CONTEXT_BUDGET_RANGES)) {
    const r = CONTEXT_BUDGET_RANGES[key];
    const want = Math.round(_contextPercent(card, key));
    const got = Math.min(r.max, Math.max(r.min, want));
    if (got !== want) notes.push(`${r.name} ${want}% is outside ${r.min}–${r.max}%, so ${got}% is used.`);
    pct[key] = got;
  }
  const landMax = 100 - pct.contextReplyPercent - 5;
  if (pct.contextLandPercent > landMax) {
    notes.push(`Land at ${pct.contextLandPercent}% would be at or above where compression starts `
      + `(${100 - pct.contextReplyPercent}%, with ${pct.contextReplyPercent}% reply room), so it would fire `
      + `on every message. ${landMax}% is used.`);
    pct.contextLandPercent = landMax;
  }
  const keepMax = pct.contextLandPercent - 5;
  if (pct.contextKeepPercent > keepMax) {
    notes.push(`Keep verbatim ${pct.contextKeepPercent}% would be at or above the landing point `
      + `(${pct.contextLandPercent}%), so compression could never reach it. ${keepMax}% is used.`);
    pct.contextKeepPercent = keepMax;
  }
  return {
    input: pct.contextInputPercent / 100,
    reply: pct.contextReplyPercent / 100,
    land:  pct.contextLandPercent / 100,
    keep:  pct.contextKeepPercent / 100,
    percent: pct,
    notes: notes,
  };
}

const DEFAULT_SETTINGS = {
  modelName: 'auto',
  // reminderFrequency removed: the periodic personality reminder it drove
  // was replaced by a persistent personality block (08-rag.js), so the
  // setting had been read and written by the settings modal while being
  // consumed by nothing at all.
  // Inherited default for cards set to Auto, and the target 02-model.js
  // writes the detected model context into. No longer a UI field.
  tokenLimit: 24576,
  apiKey: '',
  cotTimeoutEnabled: false,
  cotTimeoutMinutes: 2,
  // Were constants until roadmap 1.7.7 #6b/#6c; the defaults are the old
  // values, so nothing changes for anyone who leaves them alone. Read through
  // autoContinueDelayMs() / autoContinueMaxChain() (09-threads.js) and
  // loreTimeoutMs() (07-prompt.js), never directly -- those own the fallbacks.
  autoContinueDelaySeconds: 20,   // pause between auto-continued posts
  autoContinueMaxChain: 50,       // most posts one {{auto_continue_N}} may run
  loreTimeoutSeconds: 45,         // longest one lore compression pass may take
  // Card Tools (1.8.0, roadmap #9): PR #71's constants. Read through
  // cardToolLimit() (23-card-code.js), which owns the floors and ceilings.
  toolMaxRounds: 4,               // rounds of tool calls per reply, then an answer
  toolTimeoutSeconds: 30,         // longest one tool call may run
  toolResultMaxChars: 8000,       // most one tool result may send the model
  toolArgsMaxKB: 64,              // most arguments one call may bring
  // Roadmap 1.7.7 #6d: the context budget, as percentages. The defaults are
  // the old constants. Per character on the card; these are what a card
  // that leaves a field blank inherits. Read through resolveContextBudget().
  contextInputPercent: 90,       // of the context the prompt may use
  contextReplyPercent: 20,       // of that kept free for the reply
  contextLandPercent: 65,        // where compression brings the chat back to
  contextKeepPercent: 22,        // most recent turns never summarised
  smartLimitEnabled: false,   // cap AI reply length (rough token estimate, sentence-end cut)
  smartLimitTokens: 300,      // max estimated tokens per reply when the cap is on
  avatarScale: 1,             // avatar size multiplier (CONFIG slider; 1 = default)
  // Paint replies token-by-token as they arrive, or hold them and post the
  // finished reply in one go. Presentation only -- the transport streams
  // either way. See makeStreamFeeder in 03-generation.js for why: the smart
  // reply limit cuts generation off mid-stream, and the chat request sends
  // max_tokens: -1, so a genuinely non-streaming request would leave replies
  // unbounded. Default on, which is the behaviour every existing install has.
  streamReplies: true,
  // Remote (http/https) images in cards -- avatars, backgrounds, thumbnails.
  // Off by default: a card from an import or a synced peer can point <img src>
  // at any host, and that beacons this machine's IP on render. data:/blob:
  // images are unaffected and always work.
  allowRemoteImages: false,
  remoteImageNoticeSeen: false,   // one-time notice bookkeeping; see 24-boot.js
  // The first-run tour (js/25-tutorial.js) was offered and answered, or taken.
  // A setting rather than device storage so it syncs, and so `tour_seen = true`
  // in config.toml's [ui] table can turn the offer off for every new device.
  tourSeen: false,
  // The character modal refuses casual dismissal (single backdrop click,
  // Escape) while an editor is open, because closeCharacters() saves nothing
  // and openCharacters() rebuilds the list -- a half-written character is
  // simply gone. Some people want the modal to behave like every other one.
  //
  // Read with `!== false` everywhere, never as a truthy test: a settings blob
  // saved before this option existed has no key at all, and must keep the
  // sticky behaviour it already had rather than silently switching to
  // click-to-dismiss on upgrade.
  //
  // Turning this off does NOT turn off the unsaved-changes confirm. Sticky
  // governs whether a CASUAL gesture can dismiss; the confirm governs whether
  // ANY dismissal can destroy work. See js/22-scheduler.js.
  stickyCards: true,
  // How the viewport behaves while a reply is streaming in.
  //
  //   'smart'  follow the bottom, and stop following the moment the user
  //            scrolls up or touches the message area. The default, and what
  //            the app has always done.
  //   'always' follow the bottom and keep following. Scrolling up during a
  //            reply is a fight you cannot win -- which is the point for
  //            someone who never wants to read back mid-reply and finds the
  //            smart version letting go too easily.
  //   'off'    never move the viewport on its own. The jump-to-latest button
  //            is the way down.
  //
  // Read through autoScrollMode() in js/14-scroll.js, never directly: an
  // unrecognised or absent value has to resolve to 'smart', or an install
  // that predates this option would boot into a scrolling behaviour nobody
  // chose.
  autoScroll: 'smart',
  // Model links (1.8.0, #52): when a chat used another model, or its
  // character is linked to one. 'ask' (default), 'auto' or 'off'; read
  // through modelFollowMode() (js/02-model.js).
  modelFollow: 'ask',
  // ---- RAG retrieval knobs (Stage 1) ----
  // Full snapshot of these rides into every telemetry record's `config`
  // block so any turn is reproducible. Tune one knob at a time; the shadow
  // recompute in the record covers most of the "what if" exploration.
  retrievalEnabled: true,      // master switch for the dual retriever
  retrieverA: true,            // general semantic (needs the embed server)
  retrieverB: true,            // structured weighted-tag firing
  fireThreshold: 1.0,          // summed tag weight needed to fire a thematic pull
  warmthTurns: 3,              // turns a fired entity stays "warm" (anti-flicker)
  expansionDepth: 1,           // relational one-hop expansion (0 disables)
  semanticBackstop: true,      // A also scores B's entities for allusive scenes
  topKA: 5,                    // top-k semantic results from Retriever A
  retrievalBudgetTokens: 6000, // ceiling carved from the existing context budget
  retrievalWindowMsgs: 4,      // how many recent messages form the trigger window
  // Where the retrieved lorebook snippets go in the prompt. false: with the
  // character, above the conversation (how it has always been). true: just
  // before the newest message, so the part of the prompt that changes from
  // turn to turn sits at the end and the engine can reuse the rest from its
  // cache instead of reading the whole conversation again. CONFIG > Prompt
  // Order; see buildContextMessages in js/08-rag.js.
  retrievalNearEnd: false,
  // The Files panel (1.8.0, js/27-files-panel.js). Read as `!== false` for
  // the two that are on, `=== true` for the one that is off, so a device
  // with older settings gets the defaults.
  filesAutoOpen: true,     // a reply that writes a file opens it, on a wide screen
  filesFoldInChat: true,   // long file blocks are folded in the chat
  filesRunScripts: false   // HTML and SVG previews run their scripts without asking
};

// Extensions: custom stylesheets and scripts the user can inject.
// `styles` and `scripts` are arrays so you can load more than one of each.
// Each entry: { id, name, url, raw } — url and/or inline raw, both optional
// (raw applies after the url for that entry). Legacy single-field saves
// (cssUrl/cssRaw/jsUrl/jsRaw) are migrated on load by migrateExtensions().
const DEFAULT_EXTENSIONS = {
  enabled: false,
  styles: [],
  scripts: []
};

// Normalize any saved/imported extensions blob into the array-based shape,
// upgrading the old single-stylesheet/single-script format in place.
function migrateExtensions(raw) {
  const ext = { enabled: false, styles: [], scripts: [] };
  if (!raw || typeof raw !== 'object') return ext;
  ext.enabled = !!raw.enabled;

  if (Array.isArray(raw.styles) || Array.isArray(raw.scripts)) {
    // Already new format — sanitize entries.
    const clean = (arr, label) => (Array.isArray(arr) ? arr : [])
      .map((e, i) => ({
        id:   e && e.id ? String(e.id) : ('ext_' + Date.now().toString(36) + '_' + i),
        name: e && typeof e.name === 'string' ? e.name : '',
        url:  e && typeof e.url  === 'string' ? e.url  : '',
        raw:  e && typeof e.raw  === 'string' ? e.raw  : ''
      }))
      .filter(e => e.url.trim() || e.raw.trim() || e.name.trim());
    ext.styles  = clean(raw.styles,  'css');
    ext.scripts = clean(raw.scripts, 'js');
    return ext;
  }

  // Legacy format: cssUrl / cssRaw / jsUrl / jsRaw → one entry each.
  if ((raw.cssUrl && raw.cssUrl.trim()) || (raw.cssRaw && raw.cssRaw.trim())) {
    ext.styles.push({
      id: 'ext_' + Date.now().toString(36) + '_css',
      name: 'Imported stylesheet',
      url: (raw.cssUrl || '').trim(),
      raw: raw.cssRaw || ''
    });
  }
  if ((raw.jsUrl && raw.jsUrl.trim()) || (raw.jsRaw && raw.jsRaw.trim())) {
    ext.scripts.push({
      id: 'ext_' + Date.now().toString(36) + '_js',
      name: 'Imported script',
      url: (raw.jsUrl || '').trim(),
      raw: raw.jsRaw || ''
    });
  }
  return ext;
}

// Personas are character cards for {{user}} — a saved bundle of identity
// (name, avatar, colors) plus a description that gets shared with the model
// on a configurable cadence. Lets you switch between "Sir Lancelot" for
// fantasy RP and "Dr. Smith" for medical Q&A without manually retyping
// your name/avatar each time.
//
// injectionFrequency:
//   0 = never share the description (name/avatar still apply)
//   N = share on user message 1, then every Nth message after
const DEFAULT_PERSONA = {
  id: 'default-persona',
  name: 'Anonymous',
  avatar: '',
  description: '',
  injectionFrequency: 5,
  textColor: FALLBACK_PERSONA_TEXT_COLOR,
  dialogColor: FALLBACK_PERSONA_DIALOG_COLOR
};

/* ================================================================
   GROUPS (1.8.0, group chats)

   A group is a cast list with rules for whose turn it is: several character
   cards that share one conversation. It lives beside the characters in CAST
   and is edited like one; a chat started from it carries `thread.groupId`.
   The cards themselves are not copied -- a member is a card id, so editing
   a character changes it in every group it sits in, and a member whose card
   was deleted is skipped until the card comes back (UNDO, an import).

     members       the cards, top to bottom: this IS the turn order
       cardId      a character card's id
       muted       sits in the group but is not picked to reply; you can
                   still make it speak from the chat
       talk        0-100, how readily it joins in under "natural" order
     userInOrder   you have a place in the turn order, and the round stops
                   there to wait for you
     userSlot      how many members come before you in that order
     order         who replies next:
                     list     the members in turn, top to bottom
                     natural  whoever the last message names, then others
                              by `talk`
                     shuffle  everyone once per round, in a random order
                     manual   nobody, until you pick someone in the chat
                     dm       a short extra request asks the model who is
                              best to respond (dmInstructions guide it)
     maxReplies    replies before the round stops; 0 means everyone once
     allowSelf     the same character may speak twice in a row
     scenario      a scene every member is given
     introduce     what a member is told about the others: 'names',
                   'short' (a few lines of each personality) or 'full'
     greetings     which opening messages a new chat starts with: 'all',
                   'first' or 'none'
     stopOnOthers  end a reply where it starts writing another member's lines
     autoDelaySeconds  the pause between rounds while AUTO is on

   Whose turn it is is never stored. It is worked out from the conversation
   -- who spoke last -- so deleting, editing, rerolling or branching a chat
   cannot leave a pointer behind, and a sent turn stays an append for sync
   (see CONVERSATION ORDER below). The engine is js/29-groups.js.
================================================================ */
const GROUP_ORDERS = ['list', 'natural', 'shuffle', 'manual', 'dm'];
const GROUP_INTRODUCE = ['names', 'short', 'full'];
const GROUP_GREETINGS = ['all', 'first', 'none'];
const GROUP_LIMITS = { members: 24, name: 80, scenario: 20000, dm: 4000, autoDelayMax: 600, maxReplies: 48 };

const DEFAULT_GROUP = {
  id: '',
  name: 'New Group',
  avatar: '',
  members: [],
  userInOrder: false,
  userSlot: 0,
  order: 'list',
  maxReplies: 0,
  allowSelf: false,
  dmInstructions: '',
  scenario: '',
  introduce: 'short',
  greetings: 'all',
  stopOnOthers: true,
  autoDelaySeconds: 5
};

/** One group, as this build understands it, or null for something that is
 *  not one. Groups arrive from saved state, a synced device and imported
 *  files, so every field is read through here: a member is a string id and
 *  two flags, a choice is one of its list, and a number is in its range.
 *  Members are not checked against the cards that exist -- a card can come
 *  back -- and a card listed twice is kept once. */
function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 64) : '';
  if (!id) return null;
  const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const int = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const seen = new Set();
  const members = [];
  for (const m of (Array.isArray(raw.members) ? raw.members : [])) {
    const cardId = (m && typeof m === 'object' && typeof m.cardId === 'string') ? m.cardId : (typeof m === 'string' ? m : '');
    if (!cardId || seen.has(cardId) || members.length >= GROUP_LIMITS.members) continue;
    seen.add(cardId);
    members.push({
      cardId: cardId.slice(0, 64),
      muted: !!(m && m.muted === true),
      talk: int(m && m.talk, 0, 100, 50)
    });
  }
  return {
    id: id,
    name: str(raw.name, GROUP_LIMITS.name).trim() || 'Unnamed group',
    avatar: str(raw.avatar, 4 * 1024 * 1024),
    members: members,
    userInOrder: raw.userInOrder === true,
    userSlot: int(raw.userSlot, 0, members.length, 0),
    order: GROUP_ORDERS.includes(raw.order) ? raw.order : 'list',
    maxReplies: int(raw.maxReplies, 0, GROUP_LIMITS.maxReplies, 0),
    allowSelf: raw.allowSelf === true,
    dmInstructions: str(raw.dmInstructions, GROUP_LIMITS.dm),
    scenario: str(raw.scenario, GROUP_LIMITS.scenario),
    introduce: GROUP_INTRODUCE.includes(raw.introduce) ? raw.introduce : 'short',
    greetings: GROUP_GREETINGS.includes(raw.greetings) ? raw.greetings : 'all',
    stopOnOthers: raw.stopOnOthers !== false,
    autoDelaySeconds: int(raw.autoDelaySeconds, 0, GROUP_LIMITS.autoDelayMax, 5)
  };
}

/** A saved or imported list of groups, cleaned; ids kept once. */
function normalizeGroups(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const g = normalizeGroup(raw);
    if (!g || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}

// Built-in macro names — users cannot define macros that shadow these.
// auto_continue is reserved both as a bare form (the static expansion) and
// as a count form (the chain trigger); listing the prefix only catches the
// bare one but the chain pattern doesn't go through the custom-macro list
// anyway — it's handled in sendMessage.
// input and input1..input9 are the placeholders for text passed to a macro
// (1.7.9), so no macro may be named after them.
const RESERVED_MACROS = new Set(['char', 'user', 'current_dat', 'auto_continue',
  'input', 'input1', 'input2', 'input3', 'input4', 'input5', 'input6', 'input7', 'input8', 'input9']);

// Default macros pre-seeded on first load (serve as working examples).
// New entries here are also seeded onto existing users via the migration
// in loadState — see seededDefaultMacros below.
//
// Note on {{auto_continue_N}}: this is NOT a regular macro and won't be
// found here. It's a special pattern detected in sendMessage that kicks
// off an automated chain of N sends with a 20s gap. The expansion text
// lives in AUTO_CONTINUE_TEXT and is wired through translateTemplates so
// the LLM sees the prompt even though the stored user message keeps the
// short {{auto_continue}} form for clean rendering.
const DEFAULT_MACROS = [
  {
    trigger: 'continue',
    text: 'Please continue the scene as all characters involved.'
  },
  {
    trigger: 'fast_forward',
    text: 'Please fast-forward to a new scene that continues the storyline naturally and appropriately.'
  },
  // 1.7.9: an out-of-character note, {{SYSTEM: ...}} or {{SYSTEM:}} ... --
  // the text passed to it goes on the line after this one.
  {
    trigger: 'SYSTEM',
    text: 'The following is an out of character directive. Do not acknowledge or respond to this in the scene:'
  }
];

let state = {
  threads: [],
  activeThreadId: null,
  settings: { ...DEFAULT_SETTINGS },
  characterCards: [{ ...DEFAULT_CARD }],
  activeCardId: 'default',
  personaCards: [{ ...DEFAULT_PERSONA }],
  activePersonaId: 'default-persona',
  // Group chats (1.8.0): see GROUPS above.
  groups: [],
  schedules: [],
  sidebarOpen: true,
  searchEnabled: false,
  folders: [],
  extensions: { ...DEFAULT_EXTENSIONS },
  macros: DEFAULT_MACROS.map(m => ({ ...m })),
  // Tracks which DEFAULT_MACROS triggers have already been seeded onto
  // this user's state. Lets us add new default macros in future versions
  // without re-adding ones the user intentionally deleted. See loadState.
  seededDefaultMacros: DEFAULT_MACROS.map(m => m.trigger)
};

/* ================================================================
   CONVERSATION ORDER

   Where a conversation sits in the sidebar is a fact about that
   conversation, so it lives on the conversation: `thread.order`, a number,
   highest first. state.threads is kept sorted by it and renderSidebar()
   restores that before it paints, so every existing renderer keeps reading
   the array (the pinned / folder / unfiled sections are filtered views of
   this one array, in its order).

   It used to be the array order alone, persisted as a separate `threadOrder`
   list of every id in the non-conversation half of the save blob. That works
   exactly as long as one device owns the file. Now that conversations are
   addressed one at a time, that list was the last whole-history field with a
   claim on per-conversation data, and last-writer-wins on a list of ids is
   not a merge: a device that had not yet seen your newest chat pushed an
   order that did not mention it, and one that still remembered a deleted
   chat put it back. The list was the bug, not the ordering.

   The numbers are milliseconds, which makes the default need no storage at
   all: a conversation with no order of its own sorts by its own latest
   activity, so appending a message -- which already carries a timestamp --
   floats that chat to the top without writing a single ordering field. That
   is what keeps a sent turn a two-line append instead of a re-upload of the
   whole conversation: a field written here would change the conversation's
   head, and a changed head cannot go out as an append. So `order` is written
   by exactly one gesture: a drag, which moves a conversation against the
   grain of its own activity. (Two maintenance paths write it too: the respace
   when a gap runs out, and adoptLegacyThreadOrder() carrying an arrangement
   saved before this field existed.)

   A placement is not permanent. Each one records the conversation's activity
   at that moment in `orderActivity`, and a conversation whose activity has
   since moved past it sorts by activity again -- so, as in 1.7.5, the next
   message floats a dragged chat back to the top. That costs nothing on send:
   the new message's own timestamp is what does it, and the two fields are
   only ever written together, by the placement.
================================================================ */

// One second, in the same units as the keys. The spacing a drop leaves at
// the ends of the list, and the step a respace uses.
const ORDER_KEY_STEP = 1000;

/** When a conversation last saw anything happen.
 *
 *  Derived only from content every device already agrees on, which is what
 *  makes it safe as the default: two devices compute the same number for the
 *  same conversation, so the order needs no reconciling. createdAt counts
 *  because a fork copies old messages into a conversation that is new -- it
 *  belongs at the top, where it visibly lands. Scanned from the end for the
 *  last message that HAS a timestamp, so one that lacks one (an old import,
 *  a card-code injection) doesn't drag the whole chat to the bottom. */
function threadActivityAt(t) {
  if (!t) return 0;
  let at = (typeof t.createdAt === 'number' && isFinite(t.createdAt)) ? t.createdAt : 0;
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const ts = msgs[i] && msgs[i].timestamp;
    if (typeof ts === 'number' && isFinite(ts)) { at = Math.max(at, ts); break; }
  }
  return at;
}

/** The sort key: an explicit order where one was set, activity otherwise --
 *  until the conversation sees activity newer than it had when it was placed.
 *
 *  That exception is the 1.7.5 rule, restored: "a drag sets an order, and the
 *  next message in a thread floats it back to the top." A placement records
 *  the conversation's own activity at that moment (`orderActivity`); anything
 *  later wins over the placement. Nothing is written when a message is sent,
 *  so a sent turn stays an append (see CONVERSATION ORDER above), and the
 *  comparison is between message timestamps only -- every device holding the
 *  same conversation computes the same key, whatever its clock says.
 *
 *  A conversation with `order` but no `orderActivity` was placed by a build
 *  that did not record one: its place holds, and sendMessage() retires it the
 *  first time the conversation is used again. */
function threadOrderKey(t) {
  const o = t && t.order;
  if (typeof o !== 'number' || !isFinite(o)) return threadActivityAt(t);
  const since = t.orderActivity;
  if (typeof since === 'number' && isFinite(since)) {
    const at = threadActivityAt(t);
    if (at > since) return at;
  }
  return o;
}

/** Give `t` an explicit place in the list, recorded against its activity now. */
function setThreadOrder(t, key) {
  t.order = key;
  t.orderActivity = threadActivityAt(t);
}

/** Restore the invariant. Stable, so equal keys keep the order they had. */
function sortThreadsByOrder() {
  state.threads.sort((a, b) => threadOrderKey(b) - threadOrderKey(a));
}

/** A key strictly between two neighbours, given their keys -- `above` is the
 *  one that should end up higher in the list. Either may be undefined, for a
 *  drop at an end of the list.
 *
 *  Returns null when the numbers between the two neighbours are used up,
 *  which the caller answers by respacing. That takes about fifty drops into
 *  the same gap, and saying so is better than quietly landing the
 *  conversation somewhere the user did not point at. */
function orderKeyBetween(above, below) {
  if (above === undefined && below === undefined) return Date.now();
  // Nothing above means the top of the list, and nothing below means the
  // bottom. A drop at the top has to beat the conversation it lands over,
  // which a bare Date.now() does not when that one was messaged this second.
  if (above === undefined) return Math.max(Date.now(), below + ORDER_KEY_STEP);
  if (below === undefined) return above - ORDER_KEY_STEP;
  const mid = below + (above - below) / 2;
  return (mid > below && mid < above) ? mid : null;
}

/** Give every conversation an explicit, evenly spaced order, preserving the
 *  arrangement currently on screen. Only reached when a gap is exhausted.
 *  Each conversation it touches is one more conditional write on the next
 *  sync, which is why it is the recovery and not the routine path. */
function respaceThreadOrder() {
  sortThreadsByOrder();
  let key = Math.max(Date.now(), threadOrderKey(state.threads[0]) || 0);
  for (const t of state.threads) { setThreadOrder(t, key); key -= ORDER_KEY_STEP; }
  console.warn('[order] Respaced ' + state.threads.length + ' conversation(s): the ' +
               'numbers between two of them had run out.');
}

/** Order `moved` so it lands immediately before ('before', i.e. visually
 *  above) or after the `target` conversation. Returns false if it could not,
 *  in which case nothing moved.
 *
 *  Neighbours are taken from the whole list rather than the section the drop
 *  happened in. The array is globally sorted and each section is a filtered
 *  view of it, so a key between the target and its global neighbour is also
 *  between the target and whatever the user can actually see next to it. */
function placeThreadBeside(moved, target, pos) {
  sortThreadsByOrder();
  for (let attempt = 0; attempt < 2; attempt++) {
    const others = state.threads.filter(t => t !== moved);
    const i = others.indexOf(target);
    if (i === -1) return false;
    const above = (pos === 'before') ? others[i - 1] : target;
    const below = (pos === 'before') ? target : others[i + 1];
    const key = orderKeyBetween(above && threadOrderKey(above),
                                below && threadOrderKey(below));
    if (key !== null) {
      setThreadOrder(moved, key);
      sortThreadsByOrder();
      return true;
    }
    respaceThreadOrder();   // the second pass has room by construction
  }
  console.error('[order] Could not place "' + moved.name + '" next to "' + target.name +
                '" even after respacing — the list was left as it was.');
  return false;
}

/** Carry a saved sidebar arrangement from before per-conversation order -- the
 *  legacy `threadOrder` list of ids, top first -- into the numeric keys, so an
 *  upgrade keeps the arrangement the user made instead of reshuffling it.
 *
 *  Only what activity alone would put somewhere else is pinned. That list was
 *  activity order (sending floated a chat to the top) except where a drag had
 *  moved a chat that was not used again afterwards -- which an explicit order
 *  plus the float-on-activity rule in threadOrderKey() reproduces exactly. So
 *  the longest stretch of the list already in activity order keeps its
 *  natural keys and is not written at all, and each remaining conversation is
 *  given a key between its kept neighbours.
 *
 *  Deterministic: the result depends only on the list and the conversations'
 *  own contents, so devices that synced the same list mint the same numbers.
 *  Where two devices' lists did differ, reconcile compares conversations
 *  without their place in the list (orderlessThread in js/06-state-sync.js),
 *  so the difference is settled silently by the last writer rather than
 *  raised as a conflict. Conversations already carrying an order are left
 *  alone. Returns the conversations it pinned. */
function adoptLegacyThreadOrder(legacyIds) {
  if (!Array.isArray(legacyIds)) return [];
  const byId = new Map();
  for (const t of state.threads) if (t && typeof t.id === 'string') byId.set(t.id, t);
  const seq = [], seen = new Set();
  for (const id of legacyIds) {
    const t = byId.get(id);
    if (!t || seen.has(id)) continue;
    seen.add(id);
    if (typeof t.order === 'number' && isFinite(t.order)) continue;
    seq.push(t);
  }
  if (seq.length < 2) return [];
  const keys = seq.map(threadOrderKey);

  // Longest strictly decreasing run of keys, by patience sorting: tails[l] is
  // the index ending the best run of length l+1 found so far.
  const tails = [], prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]] > keys[i]) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Array(seq.length).fill(false);
  for (let i = tails[tails.length - 1]; i >= 0; i = prev[i]) keep[i] = true;

  const pinned = [];
  for (let i = 0; i < seq.length; ) {
    if (keep[i]) { i++; continue; }
    let j = i;
    while (j < seq.length && !keep[j]) j++;
    // The run seq[i..j) is maximal, so its neighbours (where they exist) are
    // kept, and at least one of them exists because something is always kept.
    const above = i > 0 ? keys[i - 1] : undefined;
    const below = j < seq.length ? keys[j] : undefined;
    const m = j - i;
    for (let k = 0; k < m; k++) {
      const key = (above !== undefined && below !== undefined)
        ? above - (above - below) * (k + 1) / (m + 1)
        : (above !== undefined) ? above - ORDER_KEY_STEP * (k + 1)
        : below + ORDER_KEY_STEP * (m - k);
      setThreadOrder(seq[i + k], key);
      pinned.push(seq[i + k]);
    }
    i = j;
  }
  return pinned;
}

let isGenerating = false;
let abortController = null;
let serverConnected = false;
// Why llama-server is down, straight from the supervisor via /swap-status.
// Empty when it is up, or when nothing could tell us. serverOfflinePhase
// separates "failed" from "still loading" -- both leave serverConnected false,
// but only one of them is a problem the user should act on. See issue #43:
// the landing page used to answer this question with a guess, and the guess
// named a Windows batch file.
let serverOfflineReason = '';
let serverOfflinePhase = '';
// Why a load failed, in plain words (1.8.0, #67): /swap-status's cause key
// and the one sentence for it. serverOfflineReason keeps llama.cpp's own
// line, which the landing page shows under "details".
let serverOfflineCause = '';
let serverOfflineAdvice = '';
// Smart auto-scroll: tracks whether the user is currently pinned at the
// bottom of the messages container. Streaming-tick scroll calls check
// this before auto-scrolling — if the user scrolled up to read history,
// we leave them alone until they scroll back down. Set by the scroll
// listener attached in attachScrollPinTracking(); only the user can
// "unpin" by scrolling away, since our own auto-scrolls end at the
// bottom and the resulting scroll event just re-confirms pinned=true.
// Starts true so the very first stream auto-follows before any user
// scroll has happened.
// Set by applyLoadedState() when a saved blob with settings was found. False
// on a device that has never been used, which is the one case where the
// server's [ui] presets are taken without asking.
let hadOwnSettings = false;

let scrollPinnedToBottom = true;
// When lore compression fires during a turn, this holds {count: N, threadId}
// until the next user input. Read by renderMessages to inject a persistent
// banner just above the streaming assistant message, so the user sees BOTH
// the compression event AND the new reply's COT instead of the transient
// "compressing..." indicator vanishing the moment summarization completes.
let pendingLoreCompressionNote = null;
state.editingIndex = null;

// Default characters loaded from default-characters.json at boot.
// Falls back to empty array gracefully if file is missing or fetch fails.
let defaultCharacters = [];

