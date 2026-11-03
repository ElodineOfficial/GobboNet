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
  // Shown as the value that will actually apply, via the same readers the
  // features use -- so a missing or nonsense stored value shows its default.
  document.getElementById('set-auto-continue-delay').value = autoContinueDelayMs() / 1000;
  document.getElementById('set-auto-continue-max').value = autoContinueMaxChain();
  document.getElementById('set-lore-timeout').value = loreTimeoutMs() / 1000;
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
  // Off unless chosen: `=== true`, so a settings blob from before the option
  // keeps the order it has always had.
  document.getElementById('set-retrieval-near-end').checked = (state.settings.retrievalNearEnd === true);
  // autoScrollMode() owns the "what counts as valid" rule, so an unrecognised
  // stored value checks the same radio here that it will actually behave as.
  document.querySelectorAll('input[name="set-auto-scroll"]').forEach(el => {
    el.checked = (el.value === autoScrollMode());
  });
  loadStandDownPanel();
  loadNetworkHostsPanel();
  loadConfigFilePanel();
  document.getElementById('avatar-scale-val').textContent = Math.round(aScale * 100) + '%';
  // The Add a Model button needs a server to download with; in file:// mode it
  // is hidden with an explanation instead. Runs on open rather than at boot so
  // it is correct even if the panel is built before 02-model.js has run.
  try { applyModelCatalogAvailability(); } catch (e) { console.error('[catalog]', e); }
  loadLanPanel();
  try { initConfigSections(); } catch (e) { console.error('[config-sections]', e); }
  document.getElementById('settings-modal').classList.add('open');
}

/* ================================================================
   CONFIG SECTIONS & SEARCH (1.7.9, F3)

   CONFIG is grouped into Basics, Characters & Chat, Model & Performance,
   Devices & Network and Advanced (chat.html). Nothing was renamed or
   removed, only moved; tests/test-config-sections.mjs holds that.

   - Advanced is a <details>, closed until asked for. Whether it is open is
     remembered on this device: a per-viewer convenience, so localStorage,
     wrapped like every other optional storage read.
   - The search box at the top finds a setting by any word of its title,
     note or "?" text, across every section, Advanced included. Typing opens
     Advanced while a match is inside it and puts it back as it was when the
     box is cleared. Esc clears.
   - Hiding is a class (.cfg-hide), never style.display, so search cannot
     fight the panels that show or hide themselves.
================================================================ */
const CFG_ADVANCED_KEY = 'gobbonet.cfg.advancedOpen';
let _cfgInit = false;
let _cfgAdvancedBeforeSearch = null;

/** Every setting box CONFIG holds, in order, with the section it is in. */
function configBlocks() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return [];
  const out = [];
  modal.querySelectorAll('.cfg-section').forEach(sec => {
    for (const el of sec.children) {
      if (el.classList.contains('form-group')) out.push({ el, section: sec });
    }
  });
  // Privacy Status sits after the sections, on its own, always last.
  const inner = modal.querySelector('.modal');
  if (inner) for (const el of inner.children) {
    if (el.classList.contains('form-group')) out.push({ el, section: null });
  }
  return out;
}

function _cfgNorm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function initConfigSections() {
  const adv = document.getElementById('cfg-advanced');
  const box = document.getElementById('cfg-search');
  if (!adv || !box) return;
  if (!_cfgInit) {
    _cfgInit = true;
    adv.addEventListener('toggle', () => {
      // Opening it by searching is not a choice to remember.
      if (_cfgAdvancedBeforeSearch !== null) return;
      try { localStorage.setItem(CFG_ADVANCED_KEY, adv.open ? '1' : '0'); } catch (_) {}
    });
    box.addEventListener('input', () => filterConfig(box.value));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && box.value) {
        e.preventDefault(); e.stopPropagation();
        box.value = ''; filterConfig('');
      }
    });
  }
  // Each opening starts with the whole panel showing.
  if (box.value) { box.value = ''; filterConfig(''); }
  let open = false;
  try { open = localStorage.getItem(CFG_ADVANCED_KEY) === '1'; } catch (_) {}
  adv.open = open;
}

/**
 * Show only the settings matching every word of query. Returns how many
 * matched. An empty query shows everything again.
 */
function filterConfig(query) {
  const words = _cfgNorm(query).split(' ').filter(Boolean);
  const adv = document.getElementById('cfg-advanced');
  const empty = document.getElementById('cfg-search-empty');
  const blocks = configBlocks();
  let shown = 0, advHit = false;

  for (const { el, section } of blocks) {
    const title = section ? section.querySelector('.cfg-section-title') : null;
    const hay = _cfgNorm((title ? title.textContent : '') + ' ' + el.textContent);
    const hit = words.every(w => hay.includes(w));
    el.classList.toggle('cfg-hide', !hit);
    if (hit) { shown++; if (section && section === adv) advHit = true; }
  }
  document.querySelectorAll('#settings-modal .cfg-section').forEach(sec => {
    const any = [...sec.children].some(c => c.classList.contains('form-group') && !c.classList.contains('cfg-hide'));
    sec.classList.toggle('cfg-hide', words.length > 0 && !any);
  });

  if (adv) {
    if (words.length) {
      if (_cfgAdvancedBeforeSearch === null) _cfgAdvancedBeforeSearch = adv.open;
      if (advHit && !adv.open) adv.open = true;
    } else if (_cfgAdvancedBeforeSearch !== null) {
      const was = _cfgAdvancedBeforeSearch;
      adv.open = was;
      // Cleared after the toggle event this may fire, so it is not saved.
      setTimeout(() => { _cfgAdvancedBeforeSearch = null; }, 0);
    }
  }
  if (empty) {
    empty.textContent = !words.length ? ''
      : shown ? `${shown} setting${shown === 1 ? ' matches' : 's match'}.`
      : 'No setting matches. Try another word, or clear the box.';
  }
  return shown;
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  // Unsaved edits to config.toml are not CONFIG's SAVE's to keep, so closing
  // asks first rather than dropping them. Escape and the backdrop come here too.
  if (modal.classList.contains('open') && typeof isConfigFileDirty === 'function' && isConfigFileDirty()
      && !confirm('Discard your unsaved changes to config.toml?')) return false;
  modal.classList.remove('open');
  applyAvatarScale(); // revert any unsaved live-preview drag back to the saved value
}

function saveSettings() {
  // Model selection is now in the header dropdown — no longer saved in settings

  state.settings.apiKey = document.getElementById('set-apikey').value.trim();
  state.settings.cotTimeoutEnabled = document.getElementById('set-cot-timeout-enabled').checked;
  state.settings.cotTimeoutMinutes = parseInt(document.getElementById('set-cot-timeout-minutes').value) || 2;
  // A cleared or nonsense field keeps the default rather than saving NaN or 0.
  // 0 s between auto-continued posts is a real choice and is kept.
  const acDelay = parseInt(document.getElementById('set-auto-continue-delay').value, 10);
  state.settings.autoContinueDelaySeconds = (isFinite(acDelay) && acDelay >= 0) ? acDelay : DEFAULT_SETTINGS.autoContinueDelaySeconds;
  const acMax = parseInt(document.getElementById('set-auto-continue-max').value, 10);
  state.settings.autoContinueMaxChain = (isFinite(acMax) && acMax >= 1) ? acMax : DEFAULT_SETTINGS.autoContinueMaxChain;
  const loreT = parseInt(document.getElementById('set-lore-timeout').value, 10);
  state.settings.loreTimeoutSeconds = isFinite(loreT) ? Math.max(5, loreT) : DEFAULT_SETTINGS.loreTimeoutSeconds;
  state.settings.avatarScale = parseFloat(document.getElementById('set-avatar-scale').value) || 1;
  state.settings.allowRemoteImages = document.getElementById('set-allow-remote-images').checked;
  state.settings.streamReplies = document.getElementById('set-stream-replies').checked;
  state.settings.stickyCards = document.getElementById('set-sticky-cards').checked;
  state.settings.retrievalNearEnd = document.getElementById('set-retrieval-near-end').checked;
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
   JSON array inside the meta record, so their order round-trips, but `threads`
   moved to an IDB store keyed by id and lost its array order. Conversations
   answer that with `thread.order`, a number on each one (see CONVERSATION
   ORDER in js/04-state.js) — and they need it for a second reason cards do
   not have: a conversation is synced individually, so its place in the list
   has to travel with it rather than in a list of every id. Cards go over the
   wire as one array in one field, where the array IS the order. If they ever
   move to a keyed store, the answer is the same numeric key, not a schema
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
    loreCustomPrompt: false,
    lorePrompt: '',
    startingLore: '',
    ragStorybook: '',
    ragWordsToFire: 1,
    memoryFiles: [],
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
    smartLimitTokens: 300,
    thinkingEnabled: true
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
  loadLorePromptEditor(card);
  document.getElementById('card-rag-storybook').value = card.ragStorybook || '';
  const _rw = document.getElementById('card-rag-words');
  if (_rw) _rw.value = String(ragWordsToFireOf(card));
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
  // CHECK's result belongs to the card it was run on.
  const _bannedReadout = document.getElementById('banned-phrases-readout');
  if (_bannedReadout) _bannedReadout.textContent = '';
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
  // `!== false`: a card with no field (older, or imported) thinks, as it always did.
  document.getElementById('card-thinking-enabled').checked = (card.thinkingEnabled !== false);
  loadCardBudgetFields(card);
  updateCardCtxHint();
  document.getElementById('card-custom-code').value = card.customCode || '';
  document.getElementById('card-code-enabled').checked = !!card.customCodeEnabled;
  updateCardCodeStatus();
  previewAvatar('card-avatar', 'card-avatar-preview');
  previewBg();
  loadCardMemoryEditor(card);
  // Snapshot AFTER every field is populated, so "clean" means "exactly as
  // loaded". A card the user created and has not typed into is clean, and
  // backing out of it costs no confirm. See charEditorOpened in
  // js/22-scheduler.js.
  charEditorOpened();
}

/* ================================================================
   MEMORY FILES in the editor (issue #41)

   While the editor is open the list is pending, kept as JSON in the hidden
   #card-memory-files textarea: an import or removal shows at once, SAVE
   writes it to the card, CANCEL drops it, and the unsaved-changes guard
   (js/22-scheduler.js) sees it because it fingerprints every textarea.
   Rows are built as DOM nodes, never from HTML strings: a file name comes
   from a file the user picked or a block the model wrote.
================================================================ */
function _memoryEditorFiles() {
  const el = document.getElementById('card-memory-files');
  if (!el) return [];
  try { return cardMemoryFiles({ memoryFiles: JSON.parse(el.value || '[]') }); }
  catch (e) { return []; }
}

function _memoryEditorSet(files, note) {
  const el = document.getElementById('card-memory-files');
  if (el) el.value = JSON.stringify(files);
  renderCardMemoryList(note);
}

function loadCardMemoryEditor(card) { _memoryEditorSet(cardMemoryFiles(card)); }

function _memorySize(chars) {
  if (chars < 1000) return chars + ' chars';
  return (chars / 1000).toFixed(chars < 10000 ? 1 : 0) + 'k chars';
}

function renderCardMemoryList(note) {
  const box = document.getElementById('card-memory-list');
  if (!box) return;
  const files = _memoryEditorFiles();
  box.textContent = '';
  files.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'card-memory-row';
    const name = document.createElement('span');
    name.className = 'card-memory-name';
    name.textContent = f.name;
    name.title = f.name;
    const meta = document.createElement('span');
    meta.className = 'card-memory-meta';
    const parts = memoryFileChunks(f).length;
    meta.textContent = _memorySize(f.text.length) + ' \u00b7 ' + parts + (parts === 1 ? ' part' : ' parts');
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn-sm';
    dl.textContent = 'Download';
    dl.title = 'Save a copy of this file';
    dl.onclick = () => downloadCardMemoryFile(i);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-sm';
    rm.textContent = 'Remove';
    rm.title = 'Remove from this character\'s memory (SAVE to keep the change)';
    rm.onclick = () => removeCardMemoryFile(i);
    row.appendChild(name); row.appendChild(meta); row.appendChild(dl); row.appendChild(rm);
    box.appendChild(row);
  });
  const readout = document.getElementById('card-memory-readout');
  if (readout) {
    const total = files.reduce((n, f) => n + f.text.length, 0);
    const summary = files.length
      ? files.length + (files.length === 1 ? ' file' : ' files') + ' \u00b7 ' + total.toLocaleString()
        + ' of ' + MEMORY_LIMITS.totalChars.toLocaleString() + ' characters'
      : 'No memory files yet.';
    readout.textContent = note ? note + ' \u2014 ' + summary : summary;
  }
}

async function importCardMemoryFiles(input) {
  const picked = Array.from((input && input.files) || []);
  if (input) input.value = '';   // so picking the same file again fires onchange
  if (!picked.length) return;
  let files = _memoryEditorFiles();
  const notes = [];
  for (const f of picked) {
    const fname = f.name || 'file';
    if (!MEMORY_EXT_RE.test(fname)) { notes.push(fname + ': not a .md or .txt file'); continue; }
    // Bytes, before reading: a file this large cannot fit, so it is not read.
    if (f.size > MEMORY_LIMITS.fileChars * 4) { notes.push(fname + ': too large'); continue; }
    let text;
    try { text = await f.text(); } catch (e) { notes.push(fname + ': could not be read'); continue; }
    const r = memoryPutFile(files, fname, text);
    if (!r.ok) { notes.push(r.error); continue; }
    files = r.files;
    notes.push(r.name + (r.replaced ? ' replaced' : ' added'));
  }
  _memoryEditorSet(files, notes.join('; '));
}

function removeCardMemoryFile(i) {
  const files = _memoryEditorFiles();
  if (!files[i]) return;
  const gone = files.splice(i, 1)[0];
  const cardId = editingCardId;
  _memoryEditorSet(files, gone.name + ' removed');
  // The removal lives in the editor until SAVE. UNDO puts it back wherever it
  // is now: in the editor if that card is still open, otherwise on the saved
  // card -- unless Cancel already threw the removal away.
  undoable({
    label: 'Removed memory file "' + String(gone.name).slice(0, 40) + '"',
    undo: () => {
      if (editingCardId === cardId && document.getElementById('card-memory-files')) {
        const now = _memoryEditorFiles();
        if (!now.some(f => f.name === gone.name)) now.splice(Math.min(i, now.length), 0, gone);
        _memoryEditorSet(now, gone.name + ' restored');
        return;
      }
      const card = state.characterCards.find(c => c.id === cardId);
      if (!card) return;
      const saved = Array.isArray(card.memoryFiles) ? card.memoryFiles : [];
      if (!saved.some(f => f && f.name === gone.name)) {
        saved.splice(Math.min(i, saved.length), 0, gone);
        card.memoryFiles = saved;
      }
    },
  });
}

function downloadCardMemoryFile(i) {
  const f = _memoryEditorFiles()[i];
  if (!f) return;
  _downloadBlob(new Blob([f.text], { type: 'text/markdown;charset=utf-8' }), f.name);
}

/* "Save to memory" on a ```file:name.md block (issue #41).
 *
 * The character the block belongs to is the message's speaker -- the same
 * resolution the avatar uses -- so in a thread with several characters the
 * file goes to whoever wrote it. A user's own message resolves to the
 * thread's character. A new file is saved straight away; replacing one asks
 * first, because the old version is gone afterwards. */
function saveFileToCardMemory(btn) {
  const payload = (typeof fileBlockPayload === 'function') ? fileBlockPayload(btn) : null;
  if (!payload) return;
  const thread = getActiveThread();
  const msgEl = btn.closest && btn.closest('[data-index]');
  const m = thread && msgEl ? thread.messages[Number(msgEl.dataset.index)] : null;
  const speaker = thread ? makeCastResolver(thread).cardFor(m) : getActiveCard();
  const card = speaker && speaker.id && state.characterCards.find(c => c.id === speaker.id);
  if (!card) {
    showModelSwitchToast('This message has no character to save the file to.', 'err');
    return;
  }
  const name = memoryFileName(payload.filename);
  const existing = cardMemoryFiles(card);
  if (existing.some(f => f.name.toLowerCase() === name.toLowerCase())
      && !confirm('Replace ' + name + ' in ' + card.name + '\'s memory with this version?\n\nThe current version will be gone.')) {
    return;
  }
  const r = memoryPutFile(existing, name, payload.content);
  if (!r.ok) { showModelSwitchToast(r.error, 'err'); return; }
  card.memoryFiles = r.files;
  // An editor open on this same card holds its own pending list; keep it in
  // step, or saving the editor afterwards would write the old list back.
  if (editingCardId === card.id && document.getElementById('card-memory-files')) {
    const er = memoryPutFile(_memoryEditorFiles(), name, payload.content);
    if (er.ok) _memoryEditorSet(er.files, er.name + (er.replaced ? ' replaced' : ' added') + ' from the chat');
  }
  saveState();
  try { ragIngestCard(card); } catch (e) {}
  showModelSwitchToast(r.name + (r.replaced ? ' updated in ' : ' saved to ') + card.name + '\'s memory.', 'ok');
}

/* ---- The lore prompt box (beside the RAG Storybook) -----------------------
   Ticked: the box shows the card's prompt, or the built-in one to start from.
   Unticked: the built-in prompt is used and the box is hidden; what was typed
   stays in it, so unticking and ticking again loses nothing until SAVE. A
   prompt saved identical to the built-in one is stored as '' -- the card then
   follows the built-in prompt if it improves in a later release. */
function loadLorePromptEditor(card) {
  const box = document.getElementById('card-lore-prompt-custom');
  const ta = document.getElementById('card-lore-prompt');
  if (!box || !ta) return;
  box.checked = !!(card && card.loreCustomPrompt);
  const own = (card && typeof card.lorePrompt === 'string') ? card.lorePrompt : '';
  ta.value = own.trim() ? own : LORE_DEFAULT_PROMPT;
  toggleLorePromptEditor();
}

function toggleLorePromptEditor() {
  const box = document.getElementById('card-lore-prompt-custom');
  const body = document.getElementById('card-lore-prompt-body');
  const ta = document.getElementById('card-lore-prompt');
  if (!box || !body) return;
  body.style.display = box.checked ? '' : 'none';
  if (box.checked && ta && !ta.value.trim()) ta.value = LORE_DEFAULT_PROMPT;
}

function resetLorePrompt() {
  const ta = document.getElementById('card-lore-prompt');
  if (ta) ta.value = LORE_DEFAULT_PROMPT;
}

/* The two card fields from the box. Without the box on the page, the card
   keeps what it had. */
function readLorePromptEditor(card) {
  const box = document.getElementById('card-lore-prompt-custom');
  const ta = document.getElementById('card-lore-prompt');
  if (!box || !ta) return { loreCustomPrompt: !!(card && card.loreCustomPrompt), lorePrompt: (card && card.lorePrompt) || '' };
  const text = ta.value.slice(0, LORE_PROMPT_MAX_CHARS);
  const same = text.trim() === LORE_DEFAULT_PROMPT;
  return { loreCustomPrompt: box.checked && !!text.trim() && !same, lorePrompt: same ? '' : text };
}

function saveCard() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (!card) return;
  card.contextLimit = Math.max(0, parseInt(document.getElementById('card-context-limit').value, 10) || 0);
  // Floor only -- the 8192 ceiling is gone; see resolveSmartLimit().
  card.smartLimitTokens = Math.max(25,
    parseInt(document.getElementById('card-smart-limit-tokens').value, 10) || 300);
  card.smartLimitEnabled = document.getElementById('card-smart-limit-enabled').checked;
  card.thinkingEnabled = document.getElementById('card-thinking-enabled').checked;
  Object.assign(card, readCardBudgetFields());
  card.customCode = document.getElementById('card-custom-code').value;
  card.customCodeEnabled = document.getElementById('card-code-enabled').checked;
  card.name = document.getElementById('card-name').value.trim() || 'Unnamed';
  card.avatar = document.getElementById('card-avatar').value.trim();
  card.writingStyle = document.getElementById('card-style').value;
  card.personality = document.getElementById('card-personality').value;
  card.loreEnabled = document.getElementById('card-lore-toggle').value === 'on';
  card.loreModelFile = document.getElementById('card-lore-model').value || '';
  card.startingLore = document.getElementById('card-starting-lore').value;
  Object.assign(card, readLorePromptEditor(card));
  const _prevStorybook = card.ragStorybook || '';
  card.ragStorybook = document.getElementById('card-rag-storybook').value;
  const _rwEl = document.getElementById('card-rag-words');
  if (_rwEl) card.ragWordsToFire = ragWordsToFireOf({ ragWordsToFire: _rwEl.value });
  // Invalidate the parse cache and, if the storybook text changed, embed its
  // docs now (fire-and-forget) so the first chat turn isn't the one paying the
  // indexing cost. Silently no-ops if the embed server is unavailable.
  if (card._storybook) { try { delete card._storybook; } catch (e) { card._storybook = null; } }
  // Memory files (issue #41) come from the editor's pending list. Only when
  // the editor has one: a page without the field must not empty the card.
  const _prevMemory = JSON.stringify(cardMemoryFiles(card));
  if (document.getElementById('card-memory-files')) card.memoryFiles = _memoryEditorFiles();
  const _memoryChanged = JSON.stringify(cardMemoryFiles(card)) !== _prevMemory;
  if ((card.ragStorybook !== _prevStorybook && card.ragStorybook.trim())
      || (_memoryChanged && cardMemoryFiles(card).length)) {
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

/** UNDO for a deleted character (1.7.9). Its code scratch space is not kept:
 *  that is per-session state, rebuilt when the card is active again. */
function _offerCardUndo(card, at, wasActive) {
  undoable({
    label: 'Deleted character "' + String(card.name || 'Unnamed').slice(0, 40) + '"',
    undo: () => {
      if (!state.characterCards.some(c => c.id === card.id)) {
        state.characterCards.splice(Math.min(at, state.characterCards.length), 0, card);
      }
      if (wasActive) state.activeCardId = card.id;
      try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
      renderCardGrid(); renderPersonaGrid();
      try { renderMessages(); } catch (_) {}
    },
    commit: () => {
      if (state._cardCodeStore && !state.characterCards.some(c => c.id === card.id)) {
        delete state._cardCodeStore[card.id];
        saveState();
      }
    },
  });
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
  const _at = state.characterCards.findIndex(c => c.id === _deletedId);
  const _card = state.characterCards[_at];
  const _wasActive = state.activeCardId === _deletedId;
  state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
  if (state.activeCardId === editingCardId) state.activeCardId = state.characterCards[0].id;
  editingCardId = null;
  // Load whatever card just became active. Without this, a deleted card's
  // hooks would keep running against a character that no longer exists. Its
  // code scratch space is dropped when the delete becomes final (1.7.9), so
  // UNDO brings it back with the card.
  saveState();
  try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  charEditorClosed();
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
  if (_card) _offerCardUndo(_card, _at, _wasActive);
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
  const at = state.characterCards.findIndex(c => c.id === id);
  if (at < 0) return;
  const card = state.characterCards[at];
  const wasActive = state.activeCardId === id;
  state.characterCards = state.characterCards.filter(c => c.id !== id);
  if (wasActive) state.activeCardId = state.characterCards[0].id;
  saveState();
  renderCardGrid();
  _offerCardUndo(card, at, wasActive);
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
  // The input share is the character's own since 1.7.7 #6d -- read live from
  // the fields, so the sentence changes as the number is typed.
  const inputPct = resolveContextBudget(liveBudgetCard(card)).percent.contextInputPercent;
  el.textContent = msg + '. ' + inputPct + '% is the input budget; the rest is reply headroom.';
}

/* ================================================================
   CONTEXT BUDGET FIELDS (roadmap 1.7.7 #6d)

   Four per-character percentages; see resolveContextBudget in js/04-state.js.
   A blank field means "inherit", and its placeholder shows what that is right
   now -- the setting, which config.toml's [ui] table can preset, else the old
   constant -- so blank never reads as "nothing".
================================================================ */
const CARD_BUDGET_FIELDS = {
  'card-ctx-input-pct': 'contextInputPercent',
  'card-ctx-reply-pct': 'contextReplyPercent',
  'card-ctx-land-pct':  'contextLandPercent',
  'card-ctx-keep-pct':  'contextKeepPercent',
};

function loadCardBudgetFields(card) {
  for (const [id, key] of Object.entries(CARD_BUDGET_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = card ? card[key] : null;
    el.value = (v === null || v === undefined || v === '') ? '' : v;
    el.placeholder = _contextPercent(null, key) + ' (default)';
  }
  updateCardBudgetHint();
}

/* The fields as card values: blank -> null (inherit); a number -> rounded and
   held to that field's own range. Combinations are NOT adjusted here: the user's
   number is stored as typed, and resolveContextBudget adjusts it at use and says
   so in the hint. Storing a silently different number is what #6 removes. */
function readCardBudgetFields() {
  const out = {};
  for (const [id, key] of Object.entries(CARD_BUDGET_FIELDS)) {
    const el = document.getElementById(id);
    const raw = el ? String(el.value).trim() : '';
    const n = raw === '' ? NaN : Number(raw);
    if (!isFinite(n)) { out[key] = null; continue; }
    const r = CONTEXT_BUDGET_RANGES[key];
    out[key] = Math.min(r.max, Math.max(r.min, Math.round(n)));
  }
  return out;
}

/* The card being edited, with whatever is in the four fields right now. */
function liveBudgetCard(card) {
  return Object.assign({}, card || {}, readCardBudgetFields());
}

function updateCardBudgetHint() {
  const el = document.getElementById('card-budget-hint');
  if (!el) return;
  const card = state.characterCards.find(c => c.id === editingCardId);
  const b = resolveContextBudget(liveBudgetCard(card));
  const of = (f) => Math.round(b.input * f * 100);
  let msg = 'Compression starts at ' + of(1 - b.reply) + '% of the context and brings the chat back to '
          + of(b.land) + '%; the last ' + of(b.keep) + '% is kept word for word.';
  if (b.notes.length) msg += ' Adjusted: ' + b.notes.join(' ');
  el.textContent = msg;
  // The context hint above names the input budget too; keep it in step.
  try { updateCardCtxHint(); } catch (e) {}
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

/* ================================================================
   PHONE & OTHER DEVICES PANEL (roadmap 1.7.7 #7)

   The addresses a phone can use, and the address and port the server answers
   on. A server setting like Idle Stand-Down, so it is read from /lan when
   CONFIG opens and saved on its own button, never by SAVE.

   It applies on the next start, not now: moving the socket under the page
   that asked would cut that page off, and on a phone it is the one device
   that then cannot find the new address. So the box shows the new address
   BEFORE saving (updateLanPreview), including a warning when the address
   this page is open at is about to stop working.
================================================================ */
let _lanInfo = null;

function _lanStatus(msg, tone) {
  const el = document.getElementById('lan-status');
  if (!el) return;
  el.textContent = msg || '';
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

function _lanIsWildcard(h) { return h === '0.0.0.0' || h === '::' || h === ''; }
function _lanIsLoopback(h) { return h === '127.0.0.1' || h === '::1' || h === 'localhost'; }
function _lanUrl(host, port) {
  return 'http://' + (String(host).includes(':') ? '[' + host + ']' : host) + ':' + port + '/';
}
/* The adapter's name, with the banner's warning for the kinds a phone is
   rarely on (lanAddrNote in cmd/gobbonet/main.go). */
function _lanAdapterLabel(a) {
  const name = a.interface || 'Network';
  if (a.kind === 'virtual adapter') return name + ' \u2014 virtual adapter, unlikely';
  if (a.kind === 'VPN or tunnel') return name + ' \u2014 VPN or tunnel, unlikely';
  return name;
}

function _lanSetEnabled(on) {
  ['lan-host', 'lan-port', 'lan-save'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function _lanRenderAddresses(data) {
  const list = document.getElementById('lan-addr-list');
  if (!list) return;
  const running = data && data.running;
  const say = (msg) => { list.innerHTML = '<div class="form-hint" style="margin:0;">' + escapeHtml(msg) + '</div>'; };
  if (!running) { say('The server did not say which address it is answering on.'); return; }
  if (!running.lan_access) {
    if (running.fell_back) {
      say('Phones can\u2019t connect right now. GobboNet could not open its network address (' +
          (running.bind_error || 'refused') + '), so it is answering on this PC only.');
    } else {
      say('Phones can\u2019t connect right now: GobboNet is set to answer on this PC only. ' +
          'Choose Automatic below and save to let them in.');
    }
    return;
  }
  const addrs = Array.isArray(data.addresses) ? data.addresses : [];
  if (!addrs.length) {
    say('No Wi-Fi or Ethernet address was found on this PC. Check that it is connected to a network.');
    return;
  }
  list.innerHTML = addrs.map(a =>
    '<div class="about-build-row" style="flex-wrap:wrap;align-items:center;">' +
      '<span>' + escapeHtml(_lanAdapterLabel(a)) + '</span>' +
      '<b>' + escapeHtml(a.url) + '</b>' +
      '<button class="btn btn-sm" type="button" data-url="' + escapeHtml(a.url) + '" onclick="copyLanAddress(this)">COPY</button>' +
    '</div>').join('');
}

/* Automatic, every address this PC has, and this PC only. The values are what
   listen_host will hold. A saved wildcard or loopback keeps its own spelling,
   and a saved address that has since left this PC stays listed and selected,
   so the box shows what the file says rather than pretending otherwise. */
function _lanFillChoices(data) {
  const sel = document.getElementById('lan-host');
  if (!sel) return;
  const saved = (data.saved && typeof data.saved.host === 'string') ? data.saved.host : '0.0.0.0';
  const auto = _lanIsWildcard(saved) ? saved : '0.0.0.0';
  const local = _lanIsLoopback(saved) ? saved : '127.0.0.1';
  const opts = [{ v: auto, t: 'Automatic (all addresses)' }];
  const choices = Array.isArray(data.choices) ? data.choices : [];
  choices.forEach(c => opts.push({ v: c.ip, t: c.ip + ' \u2014 ' + _lanAdapterLabel(c) }));
  if (!_lanIsWildcard(saved) && !_lanIsLoopback(saved) && !choices.some(c => c.ip === saved)) {
    opts.push({ v: saved, t: saved + ' \u2014 no longer on this PC' });
  }
  opts.push({ v: local, t: 'This PC only (no phones)' });
  sel.innerHTML = opts.map(o =>
    '<option value="' + escapeHtml(o.v) + '">' + escapeHtml(o.t) + '</option>').join('');
  sel.value = saved;
}

async function loadLanPanel() {
  const group = document.getElementById('lan-group');
  if (!group) return;
  _lanInfo = null;
  const list = document.getElementById('lan-addr-list');
  const preview = document.getElementById('lan-preview');
  if (preview) preview.textContent = '';
  const disable = (why) => {
    if (list) list.innerHTML = '';
    _lanSetEnabled(false);
    _lanStatus(why);
  };

  if (!IS_SERVED) {
    disable('Opened from a file rather than the GobboNet server, so there are no network addresses to show.');
    return;
  }

  // Same first question as Idle Stand-Down: which server is this?
  let health = null;
  try {
    const hr = await fetch(window.location.origin + '/health-fileserver', { cache: 'no-store' });
    if (hr.ok) health = await hr.json();
  } catch (e) { /* handled with an unreachable /lan below */ }
  if (health && (health.server === 'fileserver.ps1' || !health.version)) {
    disable('GobboNet is being served by the older PowerShell file server (fileserver.ps1), which ' +
            'can\u2019t show or change these here. Its window lists the addresses when it starts.');
    return;
  }

  try {
    const resp = await fetch(window.location.origin + '/lan', { cache: 'no-store' });
    if (resp.status === 404) {
      const was = (health && health.version) ? ' This one is ' + _sdRelease(health.version) + '.' : '';
      disable('This version of the GobboNet program file does not have this setting; it arrived in 1.7.7.' +
              was + ' Replace the gobbonet program file in your GobboNet folder with the one from the ' +
              'download \u2014 the chat page is built into it, so that single file is the whole update.');
      return;
    }
    if (!resp.ok) {
      disable('The server could not read these settings (error ' + resp.status + ').');
      return;
    }
    const data = await resp.json();
    _lanInfo = data;
    _lanRenderAddresses(data);
    _lanFillChoices(data);
    const port = document.getElementById('lan-port');
    if (port) {
      port.min = data.port_min || 1024;
      port.max = data.port_max || 32767;
      port.value = (data.saved && data.saved.port) || (data.running && data.running.port) || 9066;
    }
    _lanSetEnabled(true);
    _lanStatus(_lanPendingNote(data), (data.env_overrides && data.env_overrides.length) ? 'err' : null);
    updateLanPreview();
  } catch (e) {
    disable('Could not reach the server to read these settings.');
  }
}

/* What is saved but not yet running, and anything that stops a save working. */
function _lanPendingNote(data) {
  const parts = [];
  const s = data.saved, r = data.running;
  if (s && r && (s.host !== r.host || s.port !== r.port)) {
    parts.push('A saved change is waiting: it applies the next time GobboNet starts.');
  }
  if (data.env_overrides && data.env_overrides.length) {
    parts.push(data.env_overrides.join(' and ') + (data.env_overrides.length > 1 ? ' are' : ' is') +
               ' set on this PC, and wins over this setting until it is removed.');
  }
  return parts.join(' ');
}

/* The address phones and this PC will use after the next start, shown before
   anything is saved. */
function updateLanPreview() {
  const el = document.getElementById('lan-preview');
  const sel = document.getElementById('lan-host');
  const input = document.getElementById('lan-port');
  if (!el || !sel || !input || !_lanInfo) return;
  const lo = _lanInfo.port_min || 1024, hi = _lanInfo.port_max || 32767;
  const port = Number(input.value);
  if (!Number.isInteger(port) || port < lo || port > hi) {
    el.textContent = 'The port must be a whole number from ' + lo + ' to ' + hi + '.';
    return;
  }
  const host = sel.value;
  const running = _lanInfo.running || {};
  if (host === running.host && port === running.port) { el.textContent = ''; return; }

  const local = _lanUrl(host === '::' || host === '::1' ? '::1' : '127.0.0.1', port);
  let phones;
  if (_lanIsLoopback(host)) {
    phones = 'phones can\u2019t connect';
  } else if (_lanIsWildcard(host)) {
    // 0.0.0.0 answers on IPv4 only, so an IPv6 address is no example of it.
    const first = (_lanInfo.choices || []).find(c => host !== '0.0.0.0' || !String(c.ip).includes(':'));
    phones = first ? 'phones use ' + _lanUrl(first.ip, port) + ' (or another address above)'
                   : 'phones use this PC\u2019s network address with port ' + port;
  } else {
    phones = 'phones use ' + _lanUrl(host, port);
  }
  let msg = 'After the next start: ' + phones + '; this PC uses ' + local + '.';

  // Is the address this page is open at about to stop working?
  const here = window.location.hostname.replace(/^\[|\]$/g, '');
  const herePort = Number(window.location.port || 80);
  const keeps = port === herePort && (_lanIsLoopback(here) || _lanIsWildcard(host) || host === here);
  if (!keeps) {
    msg += (_lanIsLoopback(host) && !_lanIsLoopback(here))
      ? ' This page is open on another device, which won\u2019t reach GobboNet after that.'
      : ' The address this page is open at will stop working then \u2014 note the new one first.';
  }
  if (_lanInfo.os === 'windows' && port !== running.port) {
    msg += ' On Windows, run GobboNet LAN Setup again after the restart, so the firewall lets phones in on the new port.';
  }
  el.textContent = msg;
}

async function saveLanSettings() {
  const sel = document.getElementById('lan-host');
  const input = document.getElementById('lan-port');
  if (!sel || !input || !_lanInfo) return;
  const port = Number(input.value);
  const lo = _lanInfo.port_min || 1024, hi = _lanInfo.port_max || 32767;
  if (!Number.isInteger(port) || port < lo || port > hi) {
    _lanStatus('The port must be a whole number from ' + lo + ' to ' + hi + '.', 'err');
    return;
  }
  try {
    const resp = await fetch(window.location.origin + '/lan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: sel.value, port })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      _lanStatus(data.error || 'Could not save (error ' + resp.status + ').', 'err');
      return;
    }
    _lanInfo.saved = data.saved || { host: sel.value, port };
    if (data.env_overrides) _lanInfo.env_overrides = data.env_overrides;
    const r = _lanInfo.running || {};
    let msg = (_lanInfo.saved.host === r.host && _lanInfo.saved.port === r.port)
      ? 'Saved. This is what GobboNet is using now, so nothing changes.'
      : 'Saved. GobboNet uses this from its next start; until then nothing changes.';
    let tone = 'ok';
    if (data.env_overrides && data.env_overrides.length) {
      msg += ' ' + _lanPendingNote({ env_overrides: data.env_overrides });
      tone = 'err';
    }
    if (data.port_file_error) {
      msg += ' The port could not be recorded for launch.bat (' + data.port_file_error +
             '), so starting from launch.bat may put the old one back.';
      tone = 'err';
    }
    _lanStatus(msg, tone);
  } catch (e) {
    _lanStatus('Could not reach the server.', 'err');
  }
}

/* Same pattern as COPY BUILD INFO in ABOUT, including the fallback: a phone
   reaches this over plain http, where navigator.clipboard is refused. */
function copyLanAddress(btn) {
  const text = (btn && btn.dataset && btn.dataset.url) || '';
  const done = () => {
    const original = btn.textContent;
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      btn.textContent = 'COPY FAILED';
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

/* NETWORK HOSTS PANEL — server-wide, never stored in browser settings. */
async function loadNetworkHostsPanel() {
  const input = document.getElementById('set-network-hosts');
  const save = document.getElementById('network-hosts-save');
  const status = document.getElementById('network-hosts-status');
  if (!input || !save || !status) return;
  input.disabled = save.disabled = true;
  input.value = '';
  status.textContent = 'Loading network names…';
  if (!IS_SERVED) {
    status.textContent = 'Open GobboNet through its server address to manage network names.';
    return;
  }
  try {
    const resp = await fetch(window.location.origin + '/network/hosts', { cache: 'no-store' });
    if (resp.status === 401) {
      status.textContent = 'Sign in again, then reopen CONFIG to manage network names.';
      return;
    }
    if (!resp.ok) throw new Error('unavailable');
    const data = await resp.json();
    if (!Array.isArray(data.allowed_hosts)) throw new Error('unsupported');
    input.value = data.allowed_hosts.join('\n');
    input.disabled = save.disabled = false;
    status.textContent = 'Names saved here work immediately; no restart needed.';
  } catch (e) {
    status.textContent = 'Network settings are unavailable. Check the server connection and update GobboNet if this server does not support this panel.';
  }
}

async function saveNetworkHosts() {
  const input = document.getElementById('set-network-hosts');
  const save = document.getElementById('network-hosts-save');
  const status = document.getElementById('network-hosts-status');
  if (!input || !save || !status || input.disabled || save.disabled) return;
  const names = input.value.split(/[\s,]+/).filter(Boolean);
  input.disabled = save.disabled = true;
  status.textContent = 'Saving network names…';
  try {
    const resp = await fetch(window.location.origin + '/network/hosts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_hosts: names }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      status.textContent = data.error || 'Could not save network names.';
      return;
    }
    if (!Array.isArray(data.allowed_hosts)) throw new Error('invalid response');
    input.value = data.allowed_hosts.join('\n');
    status.textContent = 'Saved. You can now open GobboNet using these names. Sign in on the new address if asked.';
  } catch (e) {
    status.textContent = 'Could not confirm the save. Check the connection, then reopen CONFIG to see the saved names.';
  } finally {
    input.disabled = save.disabled = false;
  }
}

/* ================================================================
   CONFIG FILE PANEL -- config.toml, edited in CONFIG.

   Server-side (internal/server/configfile.go), saved on its own buttons and
   never by CONFIG's SAVE. The server sends the file with its secrets shown as
   "(hidden)", checks every save, refuses one made after the file changed
   elsewhere (409), keeps the version it replaced for UNDO LAST SAVE, and
   answers anywhere but this PC with where to open it instead.
================================================================ */
const _cfgFile = { loaded: '', version: '', hasBackup: false, open: false };

function _cfgEls() {
  return {
    path: document.getElementById('config-file-path'),
    openBtn: document.getElementById('config-file-open'),
    editor: document.getElementById('config-file-editor'),
    text: document.getElementById('config-file-text'),
    notes: document.getElementById('config-file-notes'),
    save: document.getElementById('config-file-save'),
    reload: document.getElementById('config-file-reload'),
    undo: document.getElementById('config-file-undo'),
    status: document.getElementById('config-file-status'),
  };
}

function _cfgStatus(msg, tone) {
  const { status } = _cfgEls();
  if (!status) return;
  status.textContent = msg || '';
  if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
}

function isConfigFileDirty() {
  const { text } = _cfgEls();
  return !!(_cfgFile.open && text && text.value !== _cfgFile.loaded);
}

function updateConfigFileDirty() {
  const { text } = _cfgEls();
  if (!text) return;
  const dirty = isConfigFileDirty();
  text.classList.toggle('dirty', dirty);
  if (dirty) _cfgStatus('Unsaved changes.', '');
}

async function _fetchConfigFile() {
  const resp = await fetch(window.location.origin + '/config/file', { cache: 'no-store' });
  if (resp.status === 401) throw Object.assign(new Error('Sign in again, then reopen CONFIG to edit config.toml.'), { shown: true });
  if (!resp.ok) throw new Error('unavailable');
  return resp.json();
}

function _cfgShow(data) {
  const els = _cfgEls();
  _cfgFile.loaded = data.text || '';
  _cfgFile.version = data.version || '';
  _cfgFile.hasBackup = !!data.has_backup;
  els.text.value = _cfgFile.loaded;
  els.text.classList.remove('dirty');
  els.undo.disabled = !_cfgFile.hasBackup;
  const notes = [];
  if (Array.isArray(data.env_overrides) && data.env_overrides.length) {
    notes.push('Set by environment variables, which win over this file: ' + data.env_overrides.join(', ') + '.');
  }
  if (data.perf_overrides) {
    notes.push('CONFIG > Performance has saved its own ctx_size, gpu_layers and kv_cache_type, which win over this file until RESET TO AUTO there.');
  }
  els.notes.textContent = notes.join(' ');
  els.notes.style.display = notes.length ? '' : 'none';
}

async function loadConfigFilePanel() {
  const els = _cfgEls();
  if (!els.path || !els.editor) return;
  _cfgFile.open = false;
  els.editor.style.display = 'none';
  els.openBtn.style.display = 'none';
  els.path.textContent = '';
  _cfgStatus('');
  if (!IS_SERVED) {
    els.path.textContent = 'Opened from a file rather than the GobboNet server, so there is no config file to edit here.';
    return;
  }
  try {
    const data = await _fetchConfigFile();
    if (!data.editable) {
      els.path.textContent = data.reason || 'config.toml cannot be edited from here.';
      return;
    }
    els.path.textContent = 'In use: ';
    const code = document.createElement('code');
    code.textContent = data.path || 'config.toml';
    els.path.appendChild(code);
    els.openBtn.style.display = '';
    _cfgShow(data);
  } catch (e) {
    els.path.textContent = e.shown ? e.message : 'The config file is unavailable. Update GobboNet if this server does not offer it.';
  }
}

function openConfigFileEditor() {
  const els = _cfgEls();
  if (!els.editor || !_cfgFile.version) return;
  _cfgFile.open = true;
  els.editor.style.display = '';
  els.openBtn.style.display = 'none';
  els.text.value = _cfgFile.loaded;
  els.text.classList.remove('dirty');
  _cfgStatus('Saving checks the file first. Changes apply the next time GobboNet starts.');
  try { els.text.focus(); els.text.setSelectionRange(0, 0); els.text.scrollTop = 0; } catch (_) {}
}

/* Put the cursor on the line an error names ("line 12"), so it can be fixed. */
function _cfgGoToLine(msg) {
  const m = /\bline (\d+)/i.exec(msg || '');
  const { text } = _cfgEls();
  if (!m || !text) return;
  const lines = text.value.split('\n');
  const n = Math.min(Math.max(1, parseInt(m[1], 10)), lines.length);
  const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
  try {
    text.focus();
    text.setSelectionRange(start, start + lines[n - 1].length);
    text.scrollTop = Math.max(0, (n - 4) * (parseFloat(getComputedStyle(text).lineHeight) || 18));
  } catch (_) {}
}

function _cfgBusy(on) {
  const els = _cfgEls();
  for (const b of [els.save, els.reload, els.undo]) if (b) b.disabled = on || (b === els.undo && !_cfgFile.hasBackup);
}

async function _cfgPost(path, body) {
  const resp = await fetch(window.location.origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { resp, data };
}

function _cfgSavedMessage(data, verb) {
  const changed = Array.isArray(data.changed) ? data.changed : [];
  let msg = changed.length
    ? verb + ': ' + changed.join(', ') + '. Restart GobboNet to use it (close its window and start it again).'
    : verb + '; no setting changed.';
  if (Array.isArray(data.warnings) && data.warnings.length) {
    msg += ' This version does not know ' + data.warnings.join(', ') + ' and will ignore it.';
  }
  if (data.port_file_error) msg += ' The launcher’s port file could not be updated: ' + data.port_file_error;
  return msg;
}

async function saveConfigFile() {
  const els = _cfgEls();
  if (!_cfgFile.open || !els.text) return;
  _cfgBusy(true);
  _cfgStatus('Checking and saving…', '');
  try {
    const { resp, data } = await _cfgPost('/config/file', { text: els.text.value, version: _cfgFile.version });
    if (!resp.ok) {
      _cfgStatus(data.error || ('Not saved (HTTP ' + resp.status + ').'), 'err');
      _cfgGoToLine(data.error);
      return;
    }
    _cfgShow(await _fetchConfigFile());
    _cfgStatus(_cfgSavedMessage(data, 'Saved'), 'ok');
  } catch (e) {
    _cfgStatus('Could not confirm the save. Press RELOAD to see what config.toml says now.', 'err');
  } finally {
    _cfgBusy(false);
  }
}

async function reloadConfigFile() {
  if (isConfigFileDirty() && !confirm('Discard your unsaved changes to config.toml and load it again?')) return;
  _cfgBusy(true);
  try {
    _cfgShow(await _fetchConfigFile());
    _cfgStatus('Loaded config.toml as it is now.', '');
  } catch (e) {
    _cfgStatus(e.shown ? e.message : 'Could not load config.toml.', 'err');
  } finally {
    _cfgBusy(false);
  }
}

async function undoConfigFileSave() {
  if (!_cfgFile.hasBackup) return;
  const ask = isConfigFileDirty()
    ? 'Discard your unsaved changes and put back config.toml as it was before the last save?'
    : 'Put back config.toml as it was before the last save?';
  if (!confirm(ask)) return;
  _cfgBusy(true);
  try {
    const { resp, data } = await _cfgPost('/config/file/restore', { version: _cfgFile.version });
    if (!resp.ok) {
      _cfgStatus(data.error || ('Not restored (HTTP ' + resp.status + ').'), 'err');
      return;
    }
    _cfgShow(await _fetchConfigFile());
    _cfgStatus(_cfgSavedMessage(data, 'Put back the previous version'), 'ok');
  } catch (e) {
    _cfgStatus('Could not confirm. Press RELOAD to see what config.toml says now.', 'err');
  } finally {
    _cfgBusy(false);
  }
}
