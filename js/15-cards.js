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
  // Same `!== false` reason as above: absent means sticky, which is what
  // every install that predates this option already had.
  document.getElementById('set-sticky-cards').checked = (state.settings.stickyCards !== false);
  // autoScrollMode() owns the "what counts as valid" rule, so an unrecognised
  // stored value checks the same radio here that it will actually behave as.
  document.querySelectorAll('input[name="set-auto-scroll"]').forEach(el => {
    el.checked = (el.value === autoScrollMode());
  });
  loadStandDownPanel();
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
  state.settings.stickyCards = document.getElementById('set-sticky-cards').checked;
  const scrollPick = document.querySelector('input[name="set-auto-scroll"]:checked');
  if (scrollPick && AUTO_SCROLL_MODES.indexOf(scrollPick.value) >= 0) {
    state.settings.autoScroll = scrollPick.value;
  }
  // Switching to 'always' while a reply is mid-flight would otherwise wait for
  // the next scroll event to re-pin, which never comes if the user is sitting
  // still. Re-pin now so the change takes effect on the very next chunk.
  if (state.settings.autoScroll === 'always') scrollPinnedToBottom = true;
  updateFollowButton();
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
  charEditorClosed();
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
  document.getElementById('char-modal').classList.add('open');
}

function closeCharacters() {
  charEditorClosed();
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
        <button class="msg-action-btn" onclick="event.stopPropagation();exportCharacter('${escapeJsAttr(c.id)}')" title="Export this character as JSON — GobboNet's own format, nothing lost. For sharing with other apps, open Edit and use EXPORT V3 or FOR SHARING.">Save</button>
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
  // Snapshot AFTER every field is populated, so "clean" means "exactly as
  // loaded". A card the user created and has not typed into is clean, and
  // backing out of it costs no confirm. See charEditorOpened in
  // js/22-scheduler.js.
  charEditorOpened();
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
  charEditorClosed();
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
  // Cancel is a deliberate action, so sticky does not apply -- but it is the
  // most destructive way out of the editor, and until now it was the only one
  // that asked nothing. The backdrop and Escape were both refused to protect
  // these edits while the UI pointed at a button that dropped them silently.
  if (!charDismissGuard()) return;
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (card && !card.writingStyle && card.name === 'New Character') {
    state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
    saveState();
  }
  editingCardId = null;
  charEditorClosed();
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
  charEditorClosed();
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

/* ================================================================
   IDLE STAND-DOWN PANEL

   The only setting in CONFIG that lives on the SERVER rather than in
   state.settings, and it has to: the case it exists for is the browser being
   closed, and a tab that has been shut cannot run a timer. So this reads and
   writes /standdown instead of the settings object, and unlike everything else
   in this modal it applies on its own button rather than on SAVE — a value the
   server owns should not be written by a panel that is mostly about the
   browser's own preferences.
================================================================ */

/** The release half of a version string: "1.7.5" out of "1.7.5-go-afb7e0d".
 *
 *  A local copy rather than a call to _releaseOf(), which lives in
 *  js/22-scheduler.js and therefore loads after this file. At runtime that
 *  would be fine; it is the panel's own test, which evaluates this section on
 *  its own, that would be reaching for something that is not there. */
function _sdRelease(v) {
  return String(v || '').split('-')[0].trim();
}

function _standDownStatus(msg, tone) {
  const el = document.getElementById('standdown-status');
  if (!el) return;
  el.textContent = msg || '';
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

/** Fill the panel from the server.
 *
 *  This used to hide the whole section unless the server manages llama.cpp,
 *  on the reasoning that a switch which cannot do anything gets blamed when
 *  the VRAM stays pinned. That reasoning was not wrong, but it traded one
 *  problem for a worse one: an invisible feature is indistinguishable from a
 *  feature that was never built, and the first thing it produced was someone
 *  opening CONFIG, finding nothing, and asking whether it had been implemented
 *  at all.
 *
 *  So the section is always visible, and when it cannot work it says why and
 *  disables the control. Nobody flips a switch that does nothing, and nobody
 *  is left wondering whether the switch exists.
 *
 *  WHY IT ASKS /health-fileserver FIRST. It used to infer everything from one
 *  request: if /standdown did not answer, it said the server was older than
 *  these web files and told the reader to replace the gobbonet program file
 *  beside web/. That was a guess off a 404, and on the most common Windows
 *  setup it was wrong in a way the reader could not act on -- GobboNet started
 *  from launch.bat is served by fileserver.ps1, which has no /standdown and
 *  never will, and an install made from the source ZIP has no gobbonet program
 *  file and no web/ folder to put one beside. The advice named two things that
 *  were not there.
 *
 *  /health-fileserver is answered by BOTH servers and only the Go one reports a
 *  version, so it is what actually distinguishes them. Ask it first, and every
 *  branch below can say something true. */
async function loadStandDownPanel() {
  const group = document.getElementById('standdown-group');
  if (!group) return;
  group.style.display = '';

  const input = document.getElementById('set-standdown-minutes');
  const apply = document.getElementById('standdown-apply');
  const disable = (why) => {
    if (input) { input.disabled = true; input.value = ''; }
    if (apply) apply.disabled = true;
    _standDownStatus(why);
  };

  if (!IS_SERVED) {
    disable('Opened from a file rather than the GobboNet server, so there is nothing here to unload.');
    return;
  }

  // WHICH SERVER IS THIS. Both answer here; only the Go server carries a
  // version, which is the one field that tells the two apart.
  let health = null;
  try {
    const hr = await fetch(window.location.origin + '/health-fileserver', { cache: 'no-store' });
    if (hr.ok) health = await hr.json();
  } catch (e) { /* handled below, together with an unreachable /standdown */ }

  // Two ways to recognise the PowerShell file server, because there are two
  // vintages of it in the wild. Since 1.7.5 it names itself; before that, the
  // absence of a version is the tell, since the Go server has always sent one.
  const isLegacyServer = !!health &&
    (health.server === 'fileserver.ps1' || !health.version);

  if (isLegacyServer) {
    // The PowerShell file server. It can start and stop llama-server for a
    // model swap, so this is a gap rather than an impossibility -- but it is a
    // gap in a different program, and the fix is to run the other one.
    disable('GobboNet is being served by the older PowerShell file server (fileserver.ps1), ' +
            'which does not have idle stand-down. To get it, start GobboNet with the gobbonet ' +
            'program file in your GobboNet folder instead of launch.bat. Everything else works ' +
            'the same, and the chat page is built into that program file, so there is nothing ' +
            'else to update.');
    return;
  }

  try {
    const resp = await fetch(window.location.origin + '/standdown', { cache: 'no-store' });
    if (resp.status === 404) {
      // A Go server too old to have the route. Now that the chat page ships
      // inside the program file, this means one specific thing and the advice
      // is one specific action.
      const was = (health && health.version) ? ' This one is ' + _sdRelease(health.version) + '.' : '';
      disable('This version of the GobboNet program file does not have the idle stand-down ' +
              'setting; it arrived in 1.7.4.' + was + ' Replace the gobbonet program file in your ' +
              'GobboNet folder with the one from the download \u2014 the chat page is built into it, ' +
              'so that single file is the whole update. The timer runs in the server, not the ' +
              'browser: nothing here can unload a model while the page is closed, which is the ' +
              'case it exists for.');
      return;
    }
    if (!resp.ok) {
      disable('The server could not read this setting (error ' + resp.status + ').');
      return;
    }
    const data = await resp.json();

    if (!data || !data.supported) {
      // Remote mode: llama.cpp belongs to someone else, and stopping it is not
      // ours to do. Worth naming, because "why is this greyed out" has a real
      // answer and it is one the user can act on if they want to.
      disable('This GobboNet is pointed at a llama.cpp running somewhere else, so it cannot unload it \u2014 that process belongs to whoever started it. Idle stand-down only works when GobboNet runs the model itself.');
      return;
    }

    if (input) input.disabled = false;
    if (apply) apply.disabled = false;
    if (input) input.value = (typeof data.minutes === 'number') ? data.minutes : 5;
    if (data.stood_down) {
      _standDownStatus('The model is unloaded right now. Your next message will reload it.');
    } else if (!data.minutes) {
      _standDownStatus('Off \u2014 the model stays loaded until GobboNet closes.');
    } else {
      _standDownStatus('');
    }
  } catch (e) {
    disable('Could not reach the server to read this setting.');
  }
}

async function applyStandDown() {
  const input = document.getElementById('set-standdown-minutes');
  if (!input) return;
  const minutes = Math.max(0, Math.min(1440, parseInt(input.value, 10) || 0));
  input.value = minutes;
  try {
    const resp = await fetch(window.location.origin + '/standdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      _standDownStatus(data.error || 'Could not change the setting.', 'err');
      return;
    }
    const where = minutes === 0
      ? 'Off \u2014 the model stays loaded until GobboNet closes.'
      : 'Saved. The model unloads after ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + ' idle.';
    // persisted comes back false when the config file could not be written —
    // a read-only install, say. Claiming a save that did not happen would send
    // the user away believing it survives a restart.
    _standDownStatus(where + (data.persisted === false
      ? ' (applied for now, but the config file could not be written, so it will revert on restart.)'
      : ''), data.persisted === false ? 'err' : 'ok');
  } catch (e) {
    _standDownStatus('Could not reach the server.', 'err');
  }
}
