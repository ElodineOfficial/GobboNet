/* @gobbonet-split js/15-cards.js
   Moved verbatim from chat.html lines 9482-9803.
   settings, character cards
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SETTINGS
================================================================ */
function openSettings() {
  // Pulls live values from the server; safe if the endpoint is absent.
  try { loadPerfSettings(); } catch (e) { console.error('[perf]', e); }
  // Model dropdown is in the header — loadModelsList() handles it on startup
  // Reminder frequency, context limit and the smart reply cap have moved to
  // the character card. state.settings.tokenLimit survives as the inherited
  // default that cards set to Auto resolve against.
  document.getElementById('set-apikey').value = state.settings.apiKey || '';
  // COT timeout
  document.getElementById('set-cot-timeout-enabled').checked = !!state.settings.cotTimeoutEnabled;
  document.getElementById('set-cot-timeout-minutes').value = state.settings.cotTimeoutMinutes || 2;
  updateCotTimeoutRow();
  // Smart response limit
  const aScale = state.settings.avatarScale || 1;
  document.getElementById('set-avatar-scale').value = aScale;
  document.getElementById('set-allow-remote-images').checked = !!state.settings.allowRemoteImages;
  // Defaults ON: `!== false` rather than a truthy test, so a settings blob
  // saved before this option existed streams as it always did instead of
  // silently switching the user to held replies on upgrade.
  document.getElementById('set-stream-replies').checked = (state.settings.streamReplies !== false);
  document.getElementById('avatar-scale-val').textContent = Math.round(aScale * 100) + '%';
  // The Add a Model button needs a server to download with; in file:// mode it
  // is hidden with an explanation instead. Runs on open rather than at boot so
  // it is correct even if the panel is built before 02-model.js has run.
  try { applyModelCatalogAvailability(); } catch (e) { console.error('[catalog]', e); }
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
  applyAvatarScale(); // revert any unsaved live-preview drag back to the saved value
}

function saveSettings() {
  // Model selection is now in the header dropdown — no longer saved in settings

  state.settings.apiKey = document.getElementById('set-apikey').value.trim();
  state.settings.cotTimeoutEnabled = document.getElementById('set-cot-timeout-enabled').checked;
  state.settings.cotTimeoutMinutes = parseInt(document.getElementById('set-cot-timeout-minutes').value) || 2;
  state.settings.avatarScale = parseFloat(document.getElementById('set-avatar-scale').value) || 1;
  state.settings.allowRemoteImages = document.getElementById('set-allow-remote-images').checked;
  state.settings.streamReplies = document.getElementById('set-stream-replies').checked;
  saveState();
  closeSettings();
  renderMessages();
  applyActiveCardBackground();   // background obeys the same gate -- repaint it
  updateContextInfo();
  updatePrivacyBadge();
}

/* Avatar size — a single CSS var (--avatar-scale) multiplies every avatar's
   base dimension at every breakpoint. previewAvatarScale() runs live as the
   CONFIG slider moves; applyAvatarScale() restores the saved value (on boot,
   and on Cancel to discard an unsaved drag). */
function previewAvatarScale(val) {
  const scale = parseFloat(val) || 1;
  document.documentElement.style.setProperty('--avatar-scale', scale);
  const lbl = document.getElementById('avatar-scale-val');
  if (lbl) lbl.textContent = Math.round(scale * 100) + '%';
}
function applyAvatarScale() {
  const scale = (state.settings && state.settings.avatarScale) || 1;
  document.documentElement.style.setProperty('--avatar-scale', scale);
}

/* ================================================================
   CHARACTER CARDS
================================================================ */
let editingCardId = null;

function openCharacters() {
  editingCardId = null;
  editingPersonaId = null;
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
  document.getElementById('char-modal').classList.add('open');
}

function closeCharacters() {
  document.getElementById('char-modal').classList.remove('open');
  applyActiveCardBackground();
  renderMessages();
}

/* ── Cast ordering ────────────────────────────────────────────────
   Array position IS the order. There is no `order` field on a card and
   there is no migration, because there is nothing to migrate: every card
   that exists already has an index.

   The roadmap leaned the other way, on the grounds that an explicit field
   "survives merge-imports cleanly". Checked, and it's the reverse. Import
   merges by id and appends (js/21-data.js:107), so exporting cards ranked
   0,1,2 into a profile that already has cards ranked 0,1,2 produces two of
   each rank; sorting that gives you the imported roster interleaved through
   your own. Avoiding it means renumbering the incoming cards to sit after
   the existing ones — which is what appending to an array already does, for
   free. The field would buy a backfill, a collision rule and a sort on every
   read path, to arrive at the same list.

   The one real argument for a field is the threads store: cards persist as a
   JSON array inside the meta record (js/05-persistence.js:570), so order
   round-trips, but `threads` moved to an IDB store keyed by id and lost its
   array order — hence `threadOrder` (js/05-persistence.js:567). If cards ever
   move to a keyed store, the answer is the same six lines, not a schema
   change. Noted rather than pre-built.

   Nine sites read `[0]` as a fallback (getActiveCard, getActivePersona, the
   four delete paths, two import paths). None of them means "the built-in
   default" — they all mean "some card, deterministically". Under user
   ordering they resolve to the user's top card, which is a better answer than
   the oldest one, so all nine were left alone. */

/* Move one entry within its array and slide the matching row to match.
   Deliberately not a re-render: renderCardGrid() replaces the button that
   was just clicked, and the row underneath a stationary cursor becomes the
   row that got displaced — so clicking ▲ twice without moving the mouse
   moves a card up and then straight back down. Moving the node keeps the
   button under the pointer, and keeps focus for the keyboard path.
   The array is still the source of truth: if the DOM has drifted from it for
   any reason, this bails to a full render rather than guessing. */
function moveCastEntry(list, id, delta, gridId, rerender, btn) {
  if (!Array.isArray(list)) return;
  const from = list.findIndex(x => x && x.id === id);
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= list.length) return;   // already at an end

  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  saveState();

  const grid = document.getElementById(gridId);
  const rows = grid ? Array.from(grid.children) : [];
  if (!grid || rows.length !== list.length) { rerender(); return; }

  grid.insertBefore(rows[from], delta < 0 ? rows[to] : rows[to].nextSibling);
  refreshMoveButtons(grid);

  // The clicked arrow travelled with its row. Put focus back on it, or on
  // its partner if this move disabled it, so the keyboard path doesn't drop
  // the user out to <body> on reaching an end.
  if (btn && btn.isConnected) {
    const partner = btn.parentNode && btn.parentNode.querySelector(
      btn.dataset.move === 'up' ? '[data-move="down"]' : '[data-move="up"]');
    const target = btn.disabled ? partner : btn;
    if (target) target.focus({ preventScroll: true });
  }
}

/* End-caps only: the top row can't go up, the bottom row can't go down.
   Re-derived from live positions so it matches what a full render produces. */
function refreshMoveButtons(grid) {
  const rows = grid.children;
  for (let i = 0; i < rows.length; i++) {
    const up = rows[i].querySelector('[data-move="up"]');
    const dn = rows[i].querySelector('[data-move="down"]');
    if (up) up.disabled = (i === 0);
    if (dn) dn.disabled = (i === rows.length - 1);
  }
}

/* Shared markup for the reorder column. Omitted entirely for a list of one,
   matching how Del is omitted at length 1. */
function moveColumnHtml(id, name, idx, total, fn) {
  if (total < 2) return '';
  const who = escapeHtml(name || 'this entry');
  const eid = escapeJsAttr(id);
  return `
      <div class="card-move">
        <button class="card-move-btn" data-move="up" ${idx === 0 ? 'disabled' : ''}
                onclick="event.stopPropagation();${fn}('${eid}',-1,this)"
                title="Move up" aria-label="Move ${who} up">&#9650;</button>
        <button class="card-move-btn" data-move="down" ${idx === total - 1 ? 'disabled' : ''}
                onclick="event.stopPropagation();${fn}('${eid}',1,this)"
                title="Move down" aria-label="Move ${who} down">&#9660;</button>
      </div>`;
}

function moveCard(id, delta, btn) {
  moveCastEntry(state.characterCards, id, delta, 'card-grid', renderCardGrid, btn);
}

function renderCardGrid() {
  const grid = document.getElementById('card-grid');
  const total = state.characterCards.length;
  grid.innerHTML = state.characterCards.map((c, i) => {
    const av = renderAvatar(c.avatar, c.name);
    return `
    <div class="card-item ${c.id === state.activeCardId ? 'active' : ''}" onclick="activateCard('${escapeJsAttr(c.id)}')">
      ${moveColumnHtml(c.id, c.name, i, total, 'moveCard')}
      <div class="card-avatar">${av}</div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(c.name)}</div>
        <div class="card-desc">${escapeHtml((c.writingStyle || '').slice(0, 60))}</div>
      </div>
      <div class="card-actions">
        <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editCard('${escapeJsAttr(c.id)}')">Edit</button>
        <button class="msg-action-btn" onclick="event.stopPropagation();copyCard('${escapeJsAttr(c.id)}')" title="Duplicate this character">Copy</button>
        ${state.characterCards.length > 1 ? `<button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deleteCardById('${escapeJsAttr(c.id)}')" title="Delete this character">Del</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function activateCard(id) {
  state.activeCardId = id;
  saveState();
  // Swap the running card code along with the card. Anything the previous
  // card registered is discarded here, which is what keeps one character's
  // logic from leaking into the next.
  try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  renderCardGrid();
  renderMessages();
  applyActiveCardBackground();
}

function createCard() {
  const card = {
    id: generateId(),
    name: 'New Character',
    avatar: '',
    writingStyle: '',
    personality: '',
    loreEnabled: true,
    startingLore: '',
    ragStorybook: '',
    greeting: '',
    altGreetingsEnabled: false,
    altGreetings: '',
    background: '#000000',
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
    logitBiasStrength: -20,
    carouselEnabled: false,
    carouselPrompts: '',
    carouselMode: 'random',
    carouselIndex: 0,
    customCode: '',
    customCodeEnabled: false,
    contextLimit: 0,
    smartLimitEnabled: false,
    smartLimitTokens: 300
  };
  state.characterCards.push(card);
  saveState();
  editCard(card.id);
}

function editCard(id) {
  const card = state.characterCards.find(c => c.id === id);
  if (!card) return;
  editingCardId = id;
  document.getElementById('card-name').value = card.name;
  document.getElementById('card-avatar').value = card.avatar || '';
  document.getElementById('card-style').value = card.writingStyle;
  document.getElementById('card-personality').value = card.personality;
  document.getElementById('card-lore-toggle').value = card.loreEnabled !== false ? 'on' : 'off';
  populateLoreModelSelect(card.loreModelFile || '');
  document.getElementById('card-starting-lore').value = card.startingLore || '';
  document.getElementById('card-rag-storybook').value = card.ragStorybook || '';
  updateStorybookReadout();
  // Greeting + alt greetings — mirror the carousel toggle pattern so
  // the body opens/closes cleanly when the user re-edits.
  document.getElementById('card-greeting').value = card.greeting || '';
  const altGreetingsEnabled = !!card.altGreetingsEnabled;
  document.getElementById('card-alt-greetings-enabled').checked = altGreetingsEnabled;
  document.getElementById('card-alt-greetings').value = card.altGreetings || '';
  const altGreetingsBody = document.getElementById('alt-greetings-body');
  altGreetingsBody.classList.toggle('open', altGreetingsEnabled);
  document.getElementById('alt-greetings-toggle-label').classList.toggle('active', altGreetingsEnabled);
  updateAltGreetingsCounter();
  document.getElementById('card-bg').value = card.background || '';
  // Populate card text color pickers
  // Same constants the renderer uses -- if these ever diverge again, the
  // swatch goes back to promising a colour the chat will not show.
  const ctc = card.textColor   || FALLBACK_CARD_TEXT_COLOR;
  const cdc = card.dialogColor || FALLBACK_CARD_DIALOG_COLOR;
  document.getElementById('card-textcolor').value = ctc;
  document.getElementById('card-textcolor-hex').value = ctc;
  document.getElementById('card-dialogcolor').value = cdc;
  document.getElementById('card-dialogcolor-hex').value = cdc;
  previewCardColors();
  // Populate sampler parameters
  const temp = card.temperature !== undefined ? card.temperature : 0.7;
  const minp = card.minP !== undefined ? card.minP : 0.05;
  const topk = card.topK !== undefined ? card.topK : 40;
  const topp = card.topP !== undefined ? card.topP : 0.95;
  const reppen = card.repeatPenalty !== undefined ? card.repeatPenalty : 1.1;
  const repn = card.repeatLastN !== undefined ? card.repeatLastN : 64;
  document.getElementById('card-temperature').value = temp;
  document.getElementById('card-temp-val').textContent = temp;
  document.getElementById('card-min-p').value = minp;
  document.getElementById('card-minp-val').textContent = minp;
  document.getElementById('card-top-k').value = topk;
  document.getElementById('card-top-p').value = topp;
  document.getElementById('card-topp-val').textContent = topp;
  document.getElementById('card-repeat-penalty').value = reppen;
  document.getElementById('card-rep-val').textContent = reppen;
  document.getElementById('card-repeat-last-n').value = repn;
  // XTC + DRY (default to off for cards saved before these existed)
  const xtcProb = card.xtcProbability !== undefined ? card.xtcProbability : 0;
  const xtcThr  = card.xtcThreshold !== undefined ? card.xtcThreshold : 0.1;
  const dryMult = card.dryMultiplier !== undefined ? card.dryMultiplier : 0;
  document.getElementById('card-xtc-prob').value = xtcProb;
  document.getElementById('card-xtc-prob-val').textContent = xtcProb;
  document.getElementById('card-xtc-threshold').value = xtcThr;
  document.getElementById('card-xtc-threshold-val').textContent = xtcThr;
  document.getElementById('card-dry-mult').value = dryMult;
  document.getElementById('card-dry-mult-val').textContent = dryMult;
  // Banned phrases / logit bias
  document.getElementById('card-banned-phrases').value = card.bannedPhrases || '';
  const lbStrength = card.logitBiasStrength !== undefined ? card.logitBiasStrength : -20;
  document.getElementById('card-logit-strength').value = lbStrength;
  document.getElementById('card-logit-strength-val').textContent = lbStrength;
  // Carousel prompt
  const carouselEnabled = !!card.carouselEnabled;
  document.getElementById('card-carousel-enabled').checked = carouselEnabled;
  document.getElementById('card-carousel-prompts').value = card.carouselPrompts || '';
  const carouselMode = card.carouselMode || 'random';
  document.getElementById('carousel-mode-random').checked = carouselMode === 'random';
  document.getElementById('carousel-mode-sequential').checked = carouselMode === 'sequential';
  const carouselBody = document.getElementById('carousel-body');
  carouselBody.classList.toggle('open', carouselEnabled);
  document.getElementById('carousel-toggle-label').classList.toggle('active', carouselEnabled);
  updateCarouselCounter(card);
  document.getElementById('char-modal-list').style.display = 'none';
  document.getElementById('card-editor').style.display = '';
  document.getElementById('char-close-row').style.display = 'none';
  document.getElementById('card-delete-btn').style.display = state.characterCards.length > 1 ? '' : 'none';
  document.getElementById('card-context-limit').value = card.contextLimit || 0;
  document.getElementById('card-smart-limit-tokens').value = card.smartLimitTokens || 300;
  document.getElementById('card-smart-limit-enabled').checked = !!card.smartLimitEnabled;
  updateCardCtxHint();
  document.getElementById('card-custom-code').value = card.customCode || '';
  document.getElementById('card-code-enabled').checked = !!card.customCodeEnabled;
  updateCardCodeStatus();
  previewAvatar('card-avatar', 'card-avatar-preview');
  previewBg();
}

function saveCard() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (!card) return;
  card.contextLimit = Math.max(0, parseInt(document.getElementById('card-context-limit').value, 10) || 0);
  card.smartLimitTokens = Math.min(8192, Math.max(25,
    parseInt(document.getElementById('card-smart-limit-tokens').value, 10) || 300));
  card.smartLimitEnabled = document.getElementById('card-smart-limit-enabled').checked;
  card.customCode = document.getElementById('card-custom-code').value;
  card.customCodeEnabled = document.getElementById('card-code-enabled').checked;
  card.name = document.getElementById('card-name').value.trim() || 'Unnamed';
  card.avatar = document.getElementById('card-avatar').value.trim();
  card.writingStyle = document.getElementById('card-style').value;
  card.personality = document.getElementById('card-personality').value;
  card.loreEnabled = document.getElementById('card-lore-toggle').value === 'on';
  card.loreModelFile = document.getElementById('card-lore-model').value || '';
  card.startingLore = document.getElementById('card-starting-lore').value;
  const _prevStorybook = card.ragStorybook || '';
  card.ragStorybook = document.getElementById('card-rag-storybook').value;
  // Invalidate the parse cache and, if the storybook text changed, embed its
  // docs now (fire-and-forget) so the first chat turn isn't the one paying the
  // indexing cost. Silently no-ops if the embed server is unavailable.
  if (card._storybook) { try { delete card._storybook; } catch (e) { card._storybook = null; } }
  if (card.ragStorybook !== _prevStorybook && card.ragStorybook.trim()) {
    try { ragIngestCard(card); } catch (e) {}
  }
  card.greeting = document.getElementById('card-greeting').value;
  card.altGreetingsEnabled = document.getElementById('card-alt-greetings-enabled').checked;
  card.altGreetings = document.getElementById('card-alt-greetings').value;
  card.background = document.getElementById('card-bg').value.trim();
  card.textColor = document.getElementById('card-textcolor').value;
  card.dialogColor = document.getElementById('card-dialogcolor').value;
  card.temperature = safeParse(document.getElementById('card-temperature').value, 0.7);
  card.minP = safeParse(document.getElementById('card-min-p').value, 0.05);
  card.topK = safeParse(document.getElementById('card-top-k').value, 40, true);
  card.topP = safeParse(document.getElementById('card-top-p').value, 0.95);
  card.repeatPenalty = safeParse(document.getElementById('card-repeat-penalty').value, 1.1);
  card.repeatLastN = safeParse(document.getElementById('card-repeat-last-n').value, 64, true);
  card.xtcProbability = safeParse(document.getElementById('card-xtc-prob').value, 0);
  card.xtcThreshold = safeParse(document.getElementById('card-xtc-threshold').value, 0.1);
  card.dryMultiplier = safeParse(document.getElementById('card-dry-mult').value, 0);
  card.bannedPhrases = document.getElementById('card-banned-phrases').value;
  card.logitBiasStrength = safeParse(document.getElementById('card-logit-strength').value, -20);
  card.carouselEnabled = document.getElementById('card-carousel-enabled').checked;
  card.carouselPrompts = document.getElementById('card-carousel-prompts').value;
  card.carouselMode = document.getElementById('carousel-mode-random').checked ? 'random' : 'sequential';
  // Preserve existing index on save (don't reset it)
  if (card.carouselIndex === undefined) card.carouselIndex = 0;
  const _wasActive = (card.id === state.activeCardId);
  editingCardId = null;
  saveState();
  // If you just edited the card you are chatting with, reload its code now
  // rather than making you switch away and back to see the change.
  if (_wasActive) {
    try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  }
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

/**
 * Fill the card editor's compression-model dropdown from models-list.json —
 * the same file the header picker reads, so the choices are exactly the
 * GGUFs sitting in the models folder and nothing else. Drop a new model in
 * and it appears here on the next open.
 *
 * `selected` may name a model that is no longer on disk (deleted, renamed,
 * or the card came from another machine). That entry is kept in the list,
 * marked missing, rather than silently reset to the default: quietly
 * changing which model summarises someone's story is worse than showing
 * them a stale name they can fix.
 */
async function populateLoreModelSelect(selected) {
  const sel = document.getElementById('card-lore-model');
  if (!sel) return;
  const want = (selected || '').trim();
  sel.innerHTML = '<option value="">Same as chat model (default)</option>';

  let models = [];
  try {
    const r = await fetch('/models-list.json', { cache: 'no-store' });
    if (r.ok) models = (await r.json()).models || [];
  } catch (e) {
    // file:// mode, or no file server. The default option still works, and
    // compression falls back to the chat model at run time anyway.
  }

  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.file;
    o.textContent = m.name + (m.active ? '  (currently loaded)' : '');
    sel.appendChild(o);
  }

  if (want && !models.some(m => m.file === want)) {
    const o = document.createElement('option');
    o.value = want;
    o.textContent = want + '  (not in the models folder)';
    sel.appendChild(o);
  }
  sel.value = want;
}

function cancelCardEdit() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (card && !card.writingStyle && card.name === 'New Character') {
    state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
    saveState();
  }
  editingCardId = null;
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function deleteCard() {
  if (state.characterCards.length <= 1) return;
  const _deletedId = editingCardId;
  state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
  if (state.activeCardId === editingCardId) state.activeCardId = state.characterCards[0].id;
  editingCardId = null;
  // Drop the deleted card's code scratch space, then load whatever card
  // just became active. Without this, a deleted card's hooks would keep
  // running against a character that no longer exists.
  if (state._cardCodeStore) delete state._cardCodeStore[_deletedId];
  saveState();
  try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function copyCard(id) {
  const src = state.characterCards.find(c => c.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), name: src.name + ' (Copy)' };
  state.characterCards.push(copy);
  saveState();
  renderCardGrid();
}

function deleteCardById(id) {
  if (state.characterCards.length <= 1) return;
  state.characterCards = state.characterCards.filter(c => c.id !== id);
  if (state.activeCardId === id) state.activeCardId = state.characterCards[0].id;
  saveState();
  renderCardGrid();
}


/* Tell the user what "auto" actually means on this machine. Without it the
   0 placeholder is a number with no consequence attached to it. */
function updateCardCtxHint() {
  const el = document.getElementById('card-ctx-hint');
  if (!el) return;
  const card = state.characterCards.find(c => c.id === editingCardId);
  const resolved = resolveContextLimit(card);
  const raw = parseInt(card && card.contextLimit, 10) || 0;
  const ceiling = (typeof activeModel !== 'undefined' && activeModel && activeModel.maxCtx) || 0;
  let msg = raw
    ? 'Using ' + resolved.toLocaleString() + ' tokens'
    : 'Auto \u2014 currently ' + resolved.toLocaleString() + ' tokens from the loaded model';
  if (raw && ceiling && raw > ceiling) {
    msg += ' (clamped from ' + raw.toLocaleString() + ' \u2014 the model tops out at '
         + ceiling.toLocaleString() + ')';
  }
  el.textContent = msg + '. 90% is the input budget; the rest is reply headroom.';
}
