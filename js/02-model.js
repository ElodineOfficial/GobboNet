/* @gobbonet-split js/02-model.js
   Moved verbatim from chat.html lines 1559-2019.
   active model state, identification, models list, hot-swap
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   ACTIVE MODEL STATE
   Populated on startup by fetching /active-model.json (written by
   launch.bat). Falls back to registry defaults if not served.
================================================================ */
let activeModel = MODEL_REGISTRY['custom'];

// Tracks the GGUF filename currently loaded by llama-server. Used by the
// header dropdown to revert the selection if a hot-swap fails, and to
// short-circuit no-op changes (selecting the model that's already active).
let _currentModelFile = null;

async function loadActiveModel() {
  if (!IS_SERVED) return; // file:// — can't fetch
  try {
    const r = await fetch('/active-model.json', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    _currentModelFile = data.ggufFile || null;
    // Prefer registry entry if we know this model, else build from JSON
    activeModel = MODEL_REGISTRY[data.id] || {
      name: data.name || data.ggufFile || 'Unknown Model',
      family: data.family || 'custom',
      maxCtx: data.maxCtx || 131072,
      defaultCtx: data.defaultCtx || 24576,
      thinkingFormat: normalizeThinkingFormat(data.thinkingFormat),
      hint: 'Loaded from active-model.json. Adjust context limit based on your VRAM.'
    };
    // Always normalize the active format (registry entries may use aliases too)
    activeModel.thinkingFormat = normalizeThinkingFormat(activeModel.thinkingFormat);
    // Update the ctx hint (still used in Settings)
    updateModelHint(activeModel);
    // Update About modal stack line
    const aboutModelLine = document.getElementById('about-model-line');
    if (aboutModelLine) aboutModelLine.textContent = activeModel.name;
    // Keep the inherited default in step with the loaded model. The settings
    // input this used to write into is gone -- context limit lives on the
    // card now -- but state.settings.tokenLimit is still what a card set to
    // Auto resolves against, so it has to track the model.
    if (!state.settings.tokenLimit || state.settings.tokenLimit === 24576) {
      state.settings.tokenLimit = activeModel.defaultCtx;
      saveState();
    }
  } catch (e) {
    // Silently ignore — file server may not be running (direct file:// access)
  }
}

function updateModelHint(modelDef) {
  const hint = document.getElementById('model-hint');
  if (hint && modelDef) hint.textContent = modelDef.hint;
  // ctx-hint and set-tokens both lived in the settings modal and moved to
  // the character card. The card editor draws its own hint from
  // resolveContextLimit (updateCardCtxHint), which reports the resolved
  // number rather than a static maximum -- more useful, and it cannot drift
  // from what the context builder actually uses.
  const cardCtx = document.getElementById('card-context-limit');
  if (cardCtx && modelDef) cardCtx.max = modelDef.maxCtx;
}

/* ================================================================
   MODEL FILENAME IDENTIFICATION (mirrors launch.bat :identify_model)

   Order matters — most specific first so 'gemma-4' isn't caught by
   the looser 'gemma' rule, and 'qwen3' beats plain 'qwen'.

   thinkingFormat values:
     none      — no thinking (Llama, Mistral, Phi, base Gemma 3)
     deepseek  — <think>...</think>  (DeepSeek-R1, Qwen3, QwQ, GLM
                  thinking, Granite thinking, Hunyuan thinking, etc.)
     harmony   — gpt-oss channels   (gpt-oss-20b, gpt-oss-120b)
     gemma     — Gemma <channel|> markers (Gemma 4)
================================================================ */
function identifyModelFromFilename(filename) {
  const f = filename.toLowerCase();

  // gpt-oss — Harmony channel format
  if (/gpt[\-_.]?oss/.test(f))    return { id: 'gpt-oss',  family: 'gpt-oss',  thinkingFormat: 'harmony' };

  // Gemma family — most specific first
  if (/gemma.?4/.test(f))         return { id: 'gemma4',   family: 'gemma',    thinkingFormat: 'gemma' };
  if (/gemma.?3/.test(f))         return { id: 'gemma3',   family: 'gemma',    thinkingFormat: 'none' };

  // DeepSeek-R1 + distills (Qwen3-distill, Llama-distill) — check BEFORE
  // qwen/llama rules, because distill filenames contain those keywords too
  if (/deepseek[\-_.]?r1|r1[\-_.]?distill/.test(f))
                                  return { id: 'deepseek-r1', family: 'deepseek', thinkingFormat: 'deepseek' };
  if (/deepseek/.test(f))         return { id: 'deepseek', family: 'deepseek', thinkingFormat: 'deepseek' };

  // QwQ (always thinking) — check before plain qwen
  if (/qwq/.test(f))              return { id: 'qwq',      family: 'qwen',     thinkingFormat: 'deepseek' };
  if (/qwen.?3/.test(f))          return { id: 'qwen3',    family: 'qwen',     thinkingFormat: 'deepseek' };
  if (/qwen/.test(f))             return { id: 'qwen',     family: 'qwen',     thinkingFormat: 'deepseek' };

  // GLM family (Z.ai / Zhipu / THUDM) -- mirrors the dispatch in
  // identify-model.ps1, kept in sync so MODEL_REGISTRY lookups succeed
  // (ps1 emits id, chat.html displays it). Order: most specific first.
  //
  // Coverage:
  //   glm-flash   - GLM-4.5V-Flash / 4.6V-Flash (9B dense, thinking, vision)
  //   glm-air     - GLM-4.5-Air / 4.6-Air (106B MoE, workstation+)
  //   glm-z1-32b  - GLM-Z1-32B-0414 / Rumination-32B (reasoning, 24 GB)
  //   glm-z1-9b   - GLM-Z1-9B-0414 (reasoning, 8 GB sweet spot)
  //   glm-4-32b   - GLM-4-32B-0414 instruct (non-thinking, 24 GB)
  //   glm-big-moe - GLM-4.5/4.6/4.7/5/5.1 flagship MoE (multi-GPU)
  //   glm-4-9b    - GLM-4-9B-Chat 2024 original (non-thinking, 8 GB)
  if (/glm[\-_.]?\d(?:\.\d)?v[\-_.]?flash|glm[\-_.]?v[\-_.]?flash|glm[\-_.]?flash/.test(f))
                                  return { id: 'glm-flash',   family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?\d(?:\.\d)?[\-_.]?air|glm[\-_.]?air/.test(f))
                                  return { id: 'glm-air',     family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?z1[\-_.]?32|z1.+32b/.test(f))
                                  return { id: 'glm-z1-32b',  family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?z1|z1[\-_.]?9b/.test(f))
                                  return { id: 'glm-z1-9b',   family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?4[\-_.]?32b/.test(f))
                                  return { id: 'glm-4-32b',   family: 'glm',   thinkingFormat: 'none' };
  if (/glm[\-_.]?(?:4\.[5-9]|5(?:\.\d+)?)/.test(f))
                                  return { id: 'glm-big-moe', family: 'glm',   thinkingFormat: 'deepseek' };
  // Original GLM-4-9B-Chat and any generic glm-4 / chatglm fallthrough.
  // The /chatglm/ alternative catches THUDM's older naming; the explicit
  // /glm[\-_.]?4[\-_.]?9b/ matches the canonical filename; and the bare
  // /^glm[\-_.]?4(?![\.0-9])/ catches glm-4-base / glm-4-instruct etc.
  // without grabbing glm-4.5 (already handled above by the big-MoE rule).
  if (/glm[\-_.]?4[\-_.]?9b|chatglm|^glm[\-_.]?4(?![\.0-9])/.test(f))
                                  return { id: 'glm-4-9b',    family: 'glm',   thinkingFormat: 'none' };
  // Generic "glm + thinking/reasoning anywhere in filename" finetune.
  // Filename starts with glm and mentions think/reason -> treat as Z1.
  // The ps1 dispatch has the embedded template available and can confirm
  // <think> directly; we don't, so filename signal is best-effort here.
  if (/^glm.*(?:think|reason)/.test(f))
                                  return { id: 'glm-z1-9b',   family: 'glm',   thinkingFormat: 'deepseek' };
  // Anything else starting with glm: best guess is the 9B instruct line.
  if (/^glm[\-_.]/.test(f))       return { id: 'glm-4-9b',    family: 'glm',   thinkingFormat: 'none' };

  // IBM Granite — <think> in thinking variants
  if (/granite/.test(f))          return { id: 'granite',  family: 'granite',
                                           thinkingFormat: /think|reason/.test(f) ? 'deepseek' : 'none' };

  // Hunyuan — <think> in thinking variants
  if (/hunyuan/.test(f))          return { id: 'hunyuan',  family: 'hunyuan',
                                           thinkingFormat: /think|reason/.test(f) ? 'deepseek' : 'none' };

  // Llama, Mistral, Phi — no native thinking
  if (/llama/.test(f))            return { id: 'llama',    family: 'llama',    thinkingFormat: 'none' };

  // Mistral Nemo (and mergekit children) — check BEFORE plain 'mistral'.
  // Most Nemo merges don't contain "mistral" in the filename ("MN-Violet-Lotus",
  // "Rocinante-12B", "Magnum-v4-12B"), so the plain mistral rule below would
  // miss them. The actual --jinja workaround lives in launch.bat; here we
  // just need the id to match MODEL_REGISTRY['mistral-nemo'] for display.
  if (/mistral[\-_.]?nemo|(?:^|[\-_.])mn[\-_]|nemo/.test(f))
                                  return { id: 'mistral-nemo', family: 'mistral', thinkingFormat: 'none' };
  // Mistral Small 24B finetunes (Cydonia v4+, Asmodeus) — none of these
  // carry "mistral" in the filename, so without an explicit rule they fall
  // through to 'custom'. Match by finetune name so the UI labels them
  // correctly. The strict v7-tekken template they use is handled by the
  // message normalizer, so no special launch.bat flags are needed here.
  if (/cydonia|asmodeus|mistral[\-_.]?small/.test(f))
                                  return { id: 'mistral-small', family: 'mistral', thinkingFormat: 'none' };
  if (/mistral|mixtral/.test(f))  return { id: 'mistral',  family: 'mistral',  thinkingFormat: 'none' };
  if (/phi/.test(f))              return { id: 'phi',      family: 'phi',      thinkingFormat: 'none' };

  // Command R (Cohere). Match BEFORE the generic /think|reason/ fallback —
  // Cohere has "reasoning" in some model card copy and we don't want that
  // bleeding into thinkingFormat: 'deepseek'. The 7B (12-2024 release) is
  // Cohere2 arch and the only Command R variant we recommend for typical
  // 8-16 GB VRAM. Filenames in the wild: c4ai-command-r7b-12-2024-Q*.gguf,
  // c4ai-command-r-08-2024-Q*.gguf, c4ai-command-r-v01-Q*.gguf, plus
  // abliterated/finetune variants. Match r7b first so we don't tag a 7B as
  // the 35B; bare "command-r" / "c4ai" falls through to the 35B id.
  if (/c4ai[\-_.]?command[\-_.]?r[\-_.]?7|command[\-_.]?r[\-_.]?7b/.test(f))
                                  return { id: 'command-r7b',  family: 'cohere', thinkingFormat: 'none' };
  if (/command[\-_.]?r|c4ai/.test(f))
                                  return { id: 'command-r-35b', family: 'cohere', thinkingFormat: 'none' };

  // Generic "thinking" or "reasoning" in filename → assume deepseek-style
  if (/think|reason/.test(f))     return { id: 'custom',   family: 'custom',   thinkingFormat: 'deepseek' };

  return                                 { id: 'custom',   family: 'custom',   thinkingFormat: 'none' };
}

function modelDisplayName(filename, detected) {
  // Use registry name if known, else clean the filename
  const reg = MODEL_REGISTRY[detected.id];
  if (reg && reg.name !== 'Custom GGUF') return reg.name;
  // Strip .gguf and prettify
  return filename.replace(/\.gguf$/i, '').replace(/[-_]/g, ' ').trim();
}

/* ================================================================
   MODELS LIST — fetch models-list.json written by launch.bat

   The three fallback paths below (file:// mode, empty list, fetch
   failure) build their <option> by string interpolation, so every
   value in them is escaped. The happy path a few lines down does not
   need it: it uses createElement + textContent, which cannot produce
   markup at all.

   The values are not user-typed, but they are not ours either.
   activeModel is populated from active-model.json, which launch.bat
   and identify-model.ps1 write out of GGUF header metadata -- a
   filename and a name field that came from whoever built the model.
   That is the same trust boundary the PowerShell side already treats
   as hostile, and it ends here, at the last hop before innerHTML.
================================================================ */
async function loadModelsList() {
  const sel = document.getElementById('header-model-select');
  if (!sel) return;

  if (!IS_SERVED) {
    // Running as file:// — can't fetch. Just show active model name.
    sel.innerHTML = `<option value="${escapeHtml(activeModel.id || 'custom')}">${escapeHtml(activeModel.name)}</option>`;
    return;
  }

  try {
    const r = await fetch('/models-list.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('not found');
    const data = await r.json();

    sel.innerHTML = '';
    const models = data.models || [];
    if (models.length === 0) {
      sel.innerHTML = `<option value="custom">${escapeHtml(activeModel.name || 'Unknown')}</option>`;
      return;
    }

    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.file; // use filename as value — unambiguous
      opt.textContent = m.name;
      opt.dataset.id = m.id;
      opt.dataset.family = m.family;
      opt.dataset.thinkingFormat = m.thinkingFormat || 'none';
      if (m.active) opt.selected = true;
      sel.appendChild(opt);
    });

    // If nothing was marked active, select by matching activeModel
    if (!data.models.some(m => m.active)) {
      const match = [...sel.options].find(o => o.dataset.id === activeModel.id);
      if (match) sel.value = match.value;
    }
    // Whatever the dropdown ended up showing, that's our "current" for
    // revert-on-failure purposes. Prefer the explicit value from
    // active-model.json (set by loadActiveModel) if we have one.
    if (!_currentModelFile) _currentModelFile = sel.value || null;
  } catch (e) {
    // Fallback — just show what we already know is loaded
    sel.innerHTML = `<option value="${escapeHtml(activeModel.id || 'custom')}">${escapeHtml(activeModel.name || 'Model')}</option>`;
  }
}

/* ================================================================
   HEADER MODEL CHANGE — hot-swap the active GGUF via the file server.

   Flow:
     1. User picks a different option in the dropdown.
     2. We POST /swap-model {file:"<name>.gguf"} to fileserver.ps1.
     3. Fileserver kills the running llama-server, rewrites the launch
        script + active-model.json, spawns the new server detached,
        and returns 202 immediately.
     4. We poll /swap-status every ~1.5s until phase == "ready" (model
        loaded, /health returns ok) or phase == "error" (timeout, bad
        model, etc).
     5. On success: re-fetch active-model.json so the rest of the UI
        (token limits, thinking format, model hint) picks up the new
        metadata. On failure: revert the dropdown to the previous
        selection and surface the error in the toast.

   The launch.bat monitor loop watches for .swap-in-progress and skips
   its own restart while the lock exists, so we don't race with it.
================================================================ */
let _toastTimer = null;
let _swapInFlight = false;

async function onHeaderModelChange(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;

  const newFile = opt.value;
  const newName = opt.textContent;

  // No-op: user re-selected the model that's already loaded.
  if (newFile === _currentModelFile) return;

  // file:// has no fileserver. Tell the user and revert.
  if (!IS_SERVED) {
    showModelSwitchToast('Hot-swap needs the file server. Open the chat from launch.bat, not by double-clicking chat.html.', 'warn');
    if (_currentModelFile) sel.value = _currentModelFile;
    return;
  }

  // Reject overlapping swap requests.
  if (_swapInFlight) {
    showModelSwitchToast('Already swapping — please wait.', 'warn');
    if (_currentModelFile) sel.value = _currentModelFile;
    return;
  }

  const prevFile = _currentModelFile;
  const wrap = document.getElementById('header-model-wrap');

  _swapInFlight = true;
  sel.disabled = true;
  if (wrap) wrap.classList.add('swapping');
  showModelSwitchToast('Swapping to ' + newName + '...', 'info', 0);

  try {
    const r = await fetch('/swap-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: newFile })
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const body = await r.json();
        if (body && body.message) msg = body.message;
      } catch (_) {}
      throw new Error(msg);
    }

    // Poll until the new server reports healthy or we hit the timeout.
    const result = await pollSwapStatus(180000); // 3 minutes
    if (!result || result.phase !== 'ready') {
      throw new Error((result && result.message) || 'Swap did not complete.');
    }

    // Refresh the active-model metadata so the rest of the UI updates.
    await loadActiveModel();
    _currentModelFile = newFile;
    showModelSwitchToast('Active: ' + newName, 'ok');
    console.log('[swap] active model is now', newFile);
  } catch (e) {
    console.warn('[swap] failed:', e);
    showModelSwitchToast('Swap failed: ' + e.message, 'err');
    if (prevFile) sel.value = prevFile;
  } finally {
    _swapInFlight = false;
    sel.disabled = false;
    if (wrap) wrap.classList.remove('swapping');
  }
}

/**
 * Swap the loaded GGUF, without the header dropdown's UI bookkeeping.
 *
 * Same protocol onHeaderModelChange uses -- POST /swap-model, poll
 * /swap-status, refresh active-model.json -- factored out so lore
 * compression can borrow the server for a pass and hand it back. Throws on
 * failure; callers decide what that means.
 *
 * Sets _swapInFlight for the duration so a header swap started mid-pass is
 * rejected rather than racing us into two llama-servers fighting for a port.
 */
async function swapToModelFile(file) {
  if (!IS_SERVED) throw new Error('hot-swap needs the file server');
  if (_swapInFlight) throw new Error('a model swap is already running');
  _swapInFlight = true;
  try {
    const r = await fetch('/swap-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: file })
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const b = await r.json(); if (b && b.message) msg = b.message; } catch (_) {}
      throw new Error(msg);
    }
    const result = await pollSwapStatus(180000);
    if (!result || result.phase !== 'ready') {
      throw new Error((result && result.message) || 'swap did not complete');
    }
    await loadActiveModel();
    _currentModelFile = file;
  } finally {
    _swapInFlight = false;
  }
}

/**
 * Poll /swap-status until the server tells us the swap is done.
 * Returns the final status object, or a synthetic error on timeout.
 * Network blips are tolerated — we keep polling until the wall clock
 * elapses past `timeoutMs`.
 */
async function pollSwapStatus(timeoutMs) {
  const start = Date.now();
  // Small grace period before the first poll — the server has just
  // killed and respawned llama-server.exe and may briefly be busy.
  await new Promise(r => setTimeout(r, 800));
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch('/swap-status', { cache: 'no-store' });
      if (r.ok) {
        const st = await r.json();
        if (st && (st.phase === 'ready' || st.phase === 'error')) return st;
      }
    } catch (_) {
      // Server temporarily unreachable — keep trying.
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return { phase: 'error', message: 'Timed out waiting for model to load.' };
}

/**
 * Show the header toast. `kind` picks a colour: info (cyan), ok (green),
 * warn (amber), err (red). If `ms` is 0 the toast stays up until the
 * next call replaces or clears it (used while a swap is in flight).
 */
function showModelSwitchToast(msg, kind, ms) {
  const t = document.getElementById('model-switch-toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'visible';
  if (kind) t.classList.add('t-' + kind);
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  const ttl = (ms === 0) ? 0 : (typeof ms === 'number' ? ms : (kind === 'err' ? 6000 : 4000));
  if (ttl > 0) {
    _toastTimer = setTimeout(() => t.classList.remove('visible'), ttl);
  }
}

const SEARCH_PROXY_URL = IS_SERVED ? window.location.origin + '/search' : 'http://127.0.0.1:11435';

// Embedding service (Retriever A + semantic backstop). Mirrors LLAMA_URL /
// SEARCH_PROXY_URL exactly: when served over http, the file server's /embed
// reverse-proxy route reaches the loopback embed llama-server (and inherits
// the session-cookie auth for free); on file:// it talks straight to loopback.
// OPTIONAL INFRA: if this server is down or never installed, embedText()
// returns null, embed_available flips off for the turn, and the retriever
// degrades to tag-only Retriever B. Chat is never gated on embeddings.
const EMBED_URL = IS_SERVED ? window.location.origin + '/embed' : 'http://127.0.0.1:11436';

/**
 * Thin fetch wrapper. llama.cpp has zero telemetry so there's
 * nothing to scrub — this just forwards the call.
 * Kept as a named function so all API paths remain consistent.
 */
function privacyFetch(url, options = {}) {
  return fetch(url, options);
}

/**
 * Extract a token from a single line of streaming response.
 * Returns {text, field} where field is 'content' or 'reasoning',
 * or null if nothing found.
 *
 * Servers may return reasoning in different fields depending on
 * config. We accept several common ones — see THINKING_FORMATS for
 * the parser that handles raw inline tokens.
 */
function extractTokenFromLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') return null;

  // Strip SSE "data:" prefix if present
  let jsonStr = trimmed;
  if (jsonStr.startsWith('data:')) {
    jsonStr = jsonStr.slice(5).trim();
  }
  if (!jsonStr || jsonStr === '[DONE]') return null;

  try {
    const json = JSON.parse(jsonStr);

    // OpenAI streaming: choices[0].delta
    if (json.choices && json.choices[0]) {
      const c = json.choices[0];
      if (c.delta) {
        // Server-extracted reasoning (llama.cpp with --jinja --reasoning-format X,
        // or any provider exposing a reasoning channel separately).
        // Multiple field names exist in the wild — accept the most common.
        if (typeof c.delta.reasoning_content === 'string')
          return { text: c.delta.reasoning_content, field: 'reasoning' };
        if (typeof c.delta.reasoning === 'string')
          return { text: c.delta.reasoning, field: 'reasoning' };
        // Standard content token
        if (typeof c.delta.content === 'string')
          return { text: c.delta.content, field: 'content' };
      }
      if (c.message && typeof c.message.content === 'string')
        return { text: c.message.content, field: 'content' };
    }

    // Ollama format: message.content (also message.thinking for some builds)
    if (json.message) {
      if (typeof json.message.thinking === 'string')
        return { text: json.message.thinking, field: 'reasoning' };
      if (typeof json.message.content === 'string')
        return { text: json.message.content, field: 'content' };
    }

    // Raw content field
    if (typeof json.content === 'string')
      return { text: json.content, field: 'content' };

    // Response field (some servers)
    if (typeof json.response === 'string')
      return { text: json.response, field: 'content' };

    return null;
  } catch (e) {
    return null;
  }
}


/* ================================================================
   PERFORMANCE TUNING

   Context size, GPU layers and KV cache type are llama-server launch
   arguments, so changing one means restarting llama-server. Rather than
   building a second restart path, this saves to /perf and then drives the
   EXISTING hot-swap by re-selecting the model already loaded. One lock,
   one status feed, one thing to debug.
================================================================ */

function _perfStatus(msg, kind) {
  const el = document.getElementById('perf-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'error' ? 'var(--red, #ff6b6b)'
                 : kind === 'ok'    ? 'var(--green-neon, #00ff73)'
                 : 'rgba(255,255,255,0.45)';
}

/** Populate the panel. Called when settings opens. */
async function loadPerfSettings() {
  const ctx = document.getElementById('perf-ctx');
  const gpu = document.getElementById('perf-gpu');
  const kv  = document.getElementById('perf-kv');
  if (!ctx || !gpu || !kv) return;

  if (!IS_SERVED) {
    ctx.disabled = gpu.disabled = kv.disabled = true;
    _perfStatus('Opened without the file server, so these cannot be read or changed. Start from launch.bat.', 'error');
    return;
  }

  try {
    const r = await fetch('/perf', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = await r.json();
    ctx.value = p.current.ctxSize;
    gpu.value = p.current.gpuLayers;
    kv.value  = p.current.kvCacheType;

    // Cap the input at what the model can actually take, so a number the
    // server would reject cannot be typed in the first place.
    if (p.modelMaxCtx > 0) ctx.max = p.modelMaxCtx;

    const a = p.auto;
    _perfStatus(p.overridden
      ? 'Custom settings in use. Auto would pick ' + a.ctxSize + ' ctx, ' +
        a.gpuLayers + ' layers, ' + a.kvCacheType + '.'
      : 'Using automatic settings for your hardware.');
  } catch (e) {
    _perfStatus('Could not read current settings: ' + e.message, 'error');
  }
}

/** Save, and optionally restart the model so it takes effect now. */
async function savePerfSettings(applyNow) {
  if (!IS_SERVED) return;
  const body = {
    ctxSize:     parseInt(document.getElementById('perf-ctx').value, 10),
    gpuLayers:   parseInt(document.getElementById('perf-gpu').value, 10),
    kvCacheType: document.getElementById('perf-kv').value
  };

  _perfStatus('Saving...');
  try {
    const r = await fetch('/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) { _perfStatus(j.error || ('HTTP ' + r.status), 'error'); return; }

    if (!applyNow) {
      _perfStatus('Saved. Takes effect the next time the model starts.', 'ok');
      return;
    }
    await _restartModelForPerf();
  } catch (e) {
    _perfStatus('Save failed: ' + e.message, 'error');
  }
}

/** Put everything back to the hardware-detected values. */
async function resetPerfSettings() {
  if (!IS_SERVED) return;
  _perfStatus('Resetting...');
  try {
    const r = await fetch('/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true })
    });
    const j = await r.json();
    if (!r.ok) { _perfStatus(j.error || ('HTTP ' + r.status), 'error'); return; }
    document.getElementById('perf-ctx').value = j.current.ctxSize;
    document.getElementById('perf-gpu').value = j.current.gpuLayers;
    document.getElementById('perf-kv').value  = j.current.kvCacheType;
    _perfStatus('Back to automatic. Restart the model to apply.', 'ok');
  } catch (e) {
    _perfStatus('Reset failed: ' + e.message, 'error');
  }
}

/** Reload the current model through the normal swap pipeline. */
async function _restartModelForPerf() {
  if (!_currentModelFile) {
    _perfStatus('Saved, but the current model is unknown -- restart launch.bat to apply.', 'error');
    return;
  }
  if (_swapInFlight) { _perfStatus('A model swap is already running.', 'error'); return; }

  _swapInFlight = true;
  _perfStatus('Restarting the model with the new settings. This takes as long as loading it did.');
  try {
    const r = await fetch('/swap-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: _currentModelFile })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      _perfStatus(j.message || ('Restart failed: HTTP ' + r.status), 'error');
      _swapInFlight = false;
      return;
    }
    // Same status feed the header swap watches, so a failure here reports
    // identically to a failed model change. Waiting for the real outcome
    // matters more than usual: a context size that does not fit VRAM fails
    // at load, and "Saved!" followed by a dead model would be the worst
    // possible feedback for a panel whose entire job is letting people
    // push settings past what is safe.
    const st = await pollSwapStatus(180000);
    if (st && st.phase === 'ready') {
      _perfStatus('Model restarted with the new settings.', 'ok');
      if (typeof loadActiveModel === 'function') { try { await loadActiveModel(); } catch (e) {} }
    } else {
      const why = (st && st.message) ? st.message : 'the model did not come back';
      _perfStatus('Restart failed: ' + why +
                  ' -- try a smaller context, fewer GPU layers, or a smaller KV cache type.', 'error');
    }
  } catch (e) {
    _perfStatus('Restart failed: ' + e.message, 'error');
  } finally {
    _swapInFlight = false;
  }
}

/* ================================================================
   MODEL CATALOGUE — download a new model from inside the app

   Three routes on the Go server, all behind the same auth as
   everything else:

     GET  /catalog.json     the download list, parsed server-side
     POST /model-download   start one   (body: {index})
     GET  /model-download   poll progress

   The browser never talks to HuggingFace. It cannot write a 12 GB
   file into the models folder, a cross-origin fetch would need CORS
   on someone else's host, and routing through Go keeps the
   third-party origin out of the page.

   We submit an *index*, never a URL or a filename. The server
   resolves it against the catalogue, so nothing the page sends can
   name an arbitrary thing to fetch or an arbitrary path to write.

   Progress is polled, not streamed. The first-run wizard polls
   /api/download every 700ms and it works; the same shape here is
   proven and boring. No SSE, no websocket.

   Nothing invalidates the installed-model list, because nothing has
   to: the server's directory scan keys on the models folder's mtime
   and entry count, and a finished download changes both when it
   renames the .part file. The header dropdown picks it up on its own.
================================================================ */

let _catalogPoll = null;
let _catalogDownloadedFile = null;

/* TEMPORARY HOLD — the download/swap path is known-bugged and is being fixed
   in a later patch. Until then the button is shown disabled and labelled as
   not working, rather than left live to fail in the user's hands.

   This is deliberately ONE flag and nothing else. The modal, the catalogue
   fetch, the progress polling and the swap are all left exactly as they are,
   so the fix patch flips this to `true` and the feature comes back whole. Do
   not start deleting the code path it gates.

   `let` rather than `const` so the test suite can drive both states and prove
   the flip is all that is needed. */
let MODEL_CATALOG_ENABLED = false;

function openModelCatalog() {
  // The button that calls this is disabled while the hold flag is off, so
  // this is belt and braces -- but a dead route that silently half-works is
  // worse than one that does not open at all.
  if (!MODEL_CATALOG_ENABLED) return;
  const modal = document.getElementById('model-catalog-modal');
  if (!modal) return;
  modal.classList.add('open');
  document.getElementById('model-catalog-progress').style.display = 'none';
  document.getElementById('model-catalog-swap-row').style.display = 'none';
  _catalogDownloadedFile = null;
  loadModelCatalog();
  // A download may already be running -- from another tab, or from before
  // this modal was closed. Show it rather than presenting an idle list.
  pollModelDownload({ silent: true });
}

function closeModelCatalog() {
  const modal = document.getElementById('model-catalog-modal');
  if (modal) modal.classList.remove('open');
  // Stop polling, but do NOT cancel the download: it lives on the server and
  // survives the modal, the tab, and a reload. Reopening picks it back up.
  if (_catalogPoll) { clearInterval(_catalogPoll); _catalogPoll = null; }
  // Let the server forget a download that has already finished, so the next
  // open shows the list rather than the last transfer's result. A running one
  // is refused server-side and keeps going, which is the point.
  if (IS_SERVED) {
    fetch('/model-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true })
    }).catch(() => {});
  }
}

async function loadModelCatalog() {
  const box = document.getElementById('model-catalog-list');
  const freeEl = document.getElementById('model-catalog-free');
  if (!box) return;
  box.textContent = 'Loading the catalogue...';
  freeEl.textContent = '';

  try {
    /* refresh=1 says "the user asked for this list, go and look". Without it
       the server answered from one resolution per process, so opening this
       offline and reconnecting a minute later still showed the bundled list
       until GobboNet was restarted. The server rate-limits the network hop, so
       reopening this repeatedly does not repeatedly wait on a dead endpoint. */
    const r = await fetch('/catalog.json?refresh=1', { cache: 'no-store' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      /* Say what actually went wrong. "The catalogue is not available" on its
         own is not something anyone can act on; the notes name the step that
         failed -- endpoint unreachable, client too old, no bundled list
         found. */
      box.textContent = '';
      const head = document.createElement('div');
      head.textContent = j.error || ('The catalogue is unavailable (HTTP ' + r.status + ').');
      box.appendChild(head);
      const reasons = (j.notes || []).slice();
      if (j.detail) reasons.push(j.detail);
      reasons.forEach(n => {
        const li = document.createElement('div');
        li.className = 'form-hint';
        li.style.marginTop = '4px';
        li.textContent = '\u2022 ' + n;
        box.appendChild(li);
      });
      return;
    }
    const data = await r.json();
    const models = data.models || [];

    /* Say which list this is. A user staring at a stale catalogue needs to
       know it is the shipped one rather than the live one, and it makes a bug
       report actionable without asking them to dig through logs. */
    const bits = [];
    if (typeof data.freeGB === 'number' && data.freeGB > 0) {
      bits.push('About ' + data.freeGB.toFixed(1) + ' GB free on this disk.');
    }
    if (data.source === 'bundled') {
      bits.push('Showing the list that shipped with GobboNet \u2014 the online ' +
                'catalogue could not be reached.');
    } else if (data.source === 'cache') {
      bits.push('Showing the last catalogue downloaded.');
    }
    freeEl.textContent = bits.join(' ');

    box.innerHTML = '';
    if (models.length === 0) {
      box.textContent = 'The catalogue is empty.';
      return;
    }

    /* createElement + textContent throughout. These values come from
       models.ini, which is ours, but this is still the last hop before the
       DOM and the file is user-editable on disk -- the same trust boundary
       loadModelsList() treats as hostile a few hundred lines up. */
    models.forEach(m => {
      const row = document.createElement('div');
      row.className = 'catalog-entry' + (m.installed ? ' installed' : '');

      const name = document.createElement('div');
      name.className = 'catalog-entry-name';
      name.textContent = m.display;
      row.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'catalog-entry-meta';
      let desc = m.sizeGB.toFixed(1) + ' GB download';
      if (m.minVRAM) desc += ' \u00b7 suits ' + m.minVRAM + ' GB VRAM or more';
      if (m.ctx) desc += ' \u00b7 ' + m.ctx.toLocaleString() + ' token context';
      meta.textContent = desc;
      row.appendChild(meta);

      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.type = 'button';
      if (m.installed) {
        btn.textContent = 'ALREADY INSTALLED';
        btn.disabled = true;
      } else {
        btn.textContent = 'DOWNLOAD';
        btn.onclick = () => startModelDownload(m.index, m.display, m.file);
      }
      row.appendChild(btn);

      box.appendChild(row);
    });
  } catch (e) {
    box.textContent = 'Could not reach the server: ' + e.message;
  }
}

async function startModelDownload(index, display, file) {
  const log = document.getElementById('model-catalog-log');
  document.getElementById('model-catalog-progress').style.display = '';
  document.getElementById('model-catalog-swap-row').style.display = 'none';
  document.getElementById('model-catalog-dl-title').textContent = 'Downloading ' + display;
  document.getElementById('model-catalog-bar').style.width = '0%';
  log.textContent = 'starting...';
  catalogNote('');
  _catalogDownloadedFile = file;

  try {
    const r = await fetch('/model-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: index })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.textContent = j.error || ('Could not start the download (HTTP ' + r.status + ').');
      return;
    }
    if (j.started === false && j.status && j.status.display) {
      // Something else is already downloading -- another tab, or a click the
      // user forgot. Follow that instead of pretending this click started
      // anything. The explanation goes in the note line, not the log: the log
      // is rewritten by every poll tick and would swallow it within 700ms.
      document.getElementById('model-catalog-dl-title').textContent =
        'Downloading ' + j.status.display;
      catalogNote('Only one download runs at a time, so this is the one already ' +
                  'in progress. Your pick was not started.');
      _catalogDownloadedFile = null;
    }
    if (_catalogPoll) clearInterval(_catalogPoll);
    _catalogPoll = setInterval(pollModelDownload, 700);
    pollModelDownload();
  } catch (e) {
    log.textContent = 'Could not reach the server: ' + e.message;
  }
}

/* The note line carries anything that must outlive a poll tick. Passing an
   empty string hides it again. */
function catalogNote(text) {
  const el = document.getElementById('model-catalog-note');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
}

async function pollModelDownload(opts) {
  const silent = opts && opts.silent;
  const bar = document.getElementById('model-catalog-bar');
  const log = document.getElementById('model-catalog-log');
  if (!bar || !log) return;

  let d;
  try {
    const r = await fetch('/model-download', { cache: 'no-store' });
    if (!r.ok) return;
    d = await r.json();
  } catch (e) {
    return; // a blip; the next tick tries again
  }

  if (d.state === 'idle') return;

  /* The open-time poll only cares about a transfer still going. A finished or
     failed one belongs to a session the user has already left: reacting to it
     wrote into a hidden panel and kicked off a second loadModelCatalog() that
     raced the one openModelCatalog() had just started, both writing the same
     list into the same element. */
  if (silent && d.state !== 'running') return;

  // A download found already in flight on open: reveal the progress view.
  if (silent) {
    document.getElementById('model-catalog-progress').style.display = '';
    document.getElementById('model-catalog-dl-title').textContent =
      'Downloading ' + (d.display || 'a model');
    if (_catalogPoll) clearInterval(_catalogPoll);
    _catalogPoll = setInterval(pollModelDownload, 700);
  }

  const GB = 1073741824;
  if (d.state === 'running') {
    bar.style.width = (d.percent || 0) + '%';
    log.textContent = (d.done / GB).toFixed(2) + ' GB of ' +
      (d.total / GB).toFixed(2) + ' GB \u2014 ' + (d.percent || 0).toFixed(1) + '%';
  } else if (d.state === 'done') {
    if (_catalogPoll) { clearInterval(_catalogPoll); _catalogPoll = null; }
    bar.style.width = '100%';
    document.getElementById('model-catalog-dl-title').textContent = 'Downloaded';
    log.textContent = d.message || 'Done.';
    // The picker sees it on its own -- refresh so the user does not have to
    // reload to find it in the header dropdown.
    if (typeof loadModelsList === 'function') { try { loadModelsList(); } catch (e) {} }
    loadModelCatalog();
    // Offer the swap, do not force it: switching changes the context window
    // mid-conversation.
    if (_catalogDownloadedFile) {
      document.getElementById('model-catalog-swap-row').style.display = '';
      catalogNote('The file is in your models folder and in the header dropdown. ' +
                  'Switching to it below loads it now, with the context size the ' +
                  'catalogue lists for it. Restarting GobboNet also picks it up.');
    } else {
      catalogNote('The file is in your models folder. Pick it from the header ' +
                  'dropdown, or restart GobboNet.');
    }
  } else if (d.state === 'error') {
    if (_catalogPoll) { clearInterval(_catalogPoll); _catalogPoll = null; }
    document.getElementById('model-catalog-dl-title').textContent = 'Download failed';
    log.textContent = d.message || 'The download failed.';
  }
}

async function swapToDownloadedModel() {
  const log = document.getElementById('model-catalog-log');
  const row = document.getElementById('model-catalog-swap-row');
  if (!_catalogDownloadedFile) return;
  row.style.display = 'none';
  log.textContent = 'Switching to the new model...';
  catalogNote('');
  try {
    await swapToModelFile(_catalogDownloadedFile);
    log.textContent = 'Now running the new model.';
    catalogNote('');
    if (typeof loadModelsList === 'function') { try { loadModelsList(); } catch (e) {} }
  } catch (e) {
    /* The download itself succeeded -- say so first, because "could not
       switch" on its own reads as though the whole thing failed. Restarting is
       the honest fallback: it reloads the backend from config, which is
       exactly what the swap was going to do. */
    log.textContent = 'Could not switch: ' + e.message;
    catalogNote('The model itself downloaded fine and is in your models folder. ' +
                'Pick it from the header dropdown, or restart GobboNet and it ' +
                'will be there.');
    row.style.display = '';
  }
}

/* Three states, applied fresh on every open of the settings panel.

     held      -- MODEL_CATALOG_ENABLED is off. The button says so and does
                  nothing. Checked FIRST: a broken feature is broken whether
                  or not there is a server behind it, and telling a served
                  user "this needs a server" would send them hunting a fault
                  that is ours.
     file://   -- no server to download with, so nothing to offer.
     served    -- normal operation.

   IS_SERVED is the same flag the rest of this file gates on. */
function applyModelCatalogAvailability() {
  const block = document.getElementById('add-model-block');
  if (!block) return;
  const btn = block.querySelector('button');
  const note = document.getElementById('add-model-unavailable');

  if (!MODEL_CATALOG_ENABLED) {
    if (btn) {
      btn.disabled = true;
      btn.style.display = '';
      btn.textContent = 'NOT WORKING YET';
      btn.title = 'Model downloads are being repaired in a later patch.';
    }
    if (note) {
      note.style.display = '';
      note.textContent = 'Downloading from the catalogue is not working right now '
        + 'and is being fixed in a later patch. To add a model in the meantime, '
        + 'put the .gguf file into your models folder yourself and pick it from '
        + 'the header dropdown.';
    }
    return;
  }

  if (IS_SERVED) {
    // Restore explicitly rather than trusting the markup's initial state.
    // This used to `return` here, so the function could only ever turn the
    // button OFF -- which is also what makes the hold above safe to lift:
    // flipping the flag genuinely puts everything back.
    if (btn) {
      btn.disabled = false;
      btn.style.display = '';
      btn.textContent = 'BROWSE CATALOGUE';
      btn.title = '';
    }
    if (note) { note.style.display = 'none'; note.textContent = ''; }
    return;
  }

  if (btn) btn.style.display = 'none';
  if (note) {
    note.style.display = '';
    note.textContent = 'Downloading models needs the GobboNet server. ' +
      'This page was opened directly from disk, so there is nothing running ' +
      'to fetch the file. Start GobboNet normally to use this.';
  }
}
