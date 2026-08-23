/* AitherOS ↔ GobboNet adapter — run GobboNet's chat on an in-browser Bonsai model.
 *
 * GobboNet (Elodine / GoblinCorps, MIT) talks to llama.cpp over an OpenAI-compatible
 * endpoint. That is the whole integration surface: swap the transport and every one of its
 * features — character cards, lorebooks, threads, personas, macros — keeps working unchanged.
 * Nothing in the upstream tree is patched. This file is additive and removable.
 *
 * ── Why this hooks `privacyFetch` and not `window.fetch` ────────────────────────────────
 * `js/02-model.js:398` defines `privacyFetch(url, options)` as a one-line pass-through to
 * fetch. Every CHAT network call GobboNet makes goes through it, and because the app ships
 * as plain <script> tags with no bundler, it is a GLOBAL. Reassigning it reroutes the app
 * without touching a line of it. Hooking `window.fetch` instead would also intercept the
 * page's own asset loads and anything else on the origin — a strictly larger blast radius
 * for no gain there.
 *
 * The MODEL SELECTOR is a separate story: js/02-model.js's active-model / models-list /
 * swap-model / swap-status calls go through the raw global `fetch`, not `privacyFetch` — a
 * completely different subsystem talking to launch.bat's companion fileserver.ps1. Below,
 * `window.fetch` IS hooked, but narrowly: matched on an exact pathname allowlist of those
 * four routes only, falling through to the real fetch for everything else. See "The model
 * selector" section near the bottom for why.
 *
 * ── The four routes ────────────────────────────────────────────────────────────────────
 *   /llm/jobs*                  -> 404, ON PURPOSE. `startGenerationJob` treats 404/405 as
 *                                  "this server has no job spool", latches `jobsAvailable =
 *                                  false`, and falls through to direct streaming for the
 *                                  rest of the session. Job mode is a fileserver.ps1
 *                                  feature (a server-side spool that survives navigation);
 *                                  there is no server here, so we decline it in the one way
 *                                  the app already understands.
 *   /llm/health                 -> honest capability check (see below), not a hardcoded ok.
 *   /llm/v1/chat/completions    -> an SSE stream fed from the Bonsai worker.
 *   /llm/v1/models              -> the browser-runnable catalogue.
 * Everything else passes straight through to the original.
 *
 * ── The emitted wire format is not "OpenAI-ish", it is what THEY parse ─────────────────
 * `extractTokenFromLine` (js/02-model.js:411) reads `choices[0].delta.content` for answer
 * text and `delta.reasoning_content` for chain-of-thought, and stops on `data: [DONE]`.
 * Our worker already separates those as `channel: "thinking" | "answer"`, so the mapping is
 * one-to-one. Emitting a shape it does not parse would show up as a silent empty reply —
 * the model runs, tokens stream, and nothing appears.
 */
(function () {
  'use strict';

  if (window.__aitherBonsaiAdapter) return;           // idempotent: extensions re-run on boot

  // ── Tunables ─────────────────────────────────────────────────────────────────────────
  // 🚨 FIRST_TOKEN_FAIL_MS is DUPLICATED from portal-kit/src/webml/device-class.ts. This
  // file is served as a plain script to a page with no bundler, so it cannot import the
  // shared constant. Keep them in step: the value exists so a worker the browser killed for
  // memory cannot leave a turn hanging forever, and it is only ever checked BEFORE the first
  // token. A slow-but-alive turn must never be cut off — this runtime does ~1.9 tok/s on an
  // Iris Xe and that is a working session, and a fabricated failure is worse than a hang
  // because nobody can debug an error that did not happen.
  // Must equal device-class.ts on THIS branch, which BIH005 asserts. A LONGER copy
  // re-opens the hang the deadline exists to close (a worker the browser killed for
  // memory posts nothing and on several engines fires no error, so the turn sits at
  // 'generating' forever); a shorter one fabricates failures on a slow-but-healthy
  // device, and a fabricated error is one nobody can debug.
  // 90_000, matching device-class.ts exactly. This copy has now drifted BOTH ways: it
  // read 90000 while the owner said 60_000, was synced down, and then the owner was
  // raised to 90_000 for mobile pacing and this copy stayed at 60000. Neither drift was
  // caught, because BIH005 could not run at all -- the checker's PORTAL_KIT anchor named
  // `awkit` on a tree still spelled `portal-kit`, so every anchor missed and the gate
  // exited 2 (NOT VERIFIED) on every run. Fixed in the same commit as this line.
  var FIRST_TOKEN_FAIL_MS = 60000;
  var WORKER_URL = '/workers/webgpu-brain-bonsai-worker.js';

  // WHERE THE WORKERS ACTUALLY ARE. That path is origin-ABSOLUTE, which is right
  // for gobbonet.aitherium.com (app and workers both at the root) and for
  // aitherium.com (app under /gobbonet/, workers at the ROOT) — and wrong for
  // every SUBPATH copy of this demo, where it 404s and the engine never starts.
  //
  // Measured 2026-08-23, driving both live: on wizzense.github.io/GobboNet/ the
  // page rendered, chat answered, and the answer was "[the in-browser model
  // worker crashed before it could start]", while the root origin got far enough
  // to report "no WebGPU adapter" — an honest hardware answer. Same code, and
  // only the second one had actually reached the engine. Any vendored copy of
  // this page on another Pages site fails the first way, silently.
  //
  // Resolve by PROBE, not by rule, because the origins genuinely disagree: on the
  // apex the workers are NOT beside the adapter, so "always relative" breaks it.
  // Adapter-relative first (right for every subpath copy), origin-absolute second
  // (right for the apex). Cached: one HEAD per worker per session.
  var ADAPTER_DIR = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) return new URL('.', src).href;
    } catch (e) { /* no currentScript here; fall through */ }
    try { return new URL('.', window.location.href).href; } catch (e) { return ''; }
  })();

  var _workerUrlCache = {};
  function resolveWorkerUrl(absolutePath) {
    if (_workerUrlCache[absolutePath]) return _workerUrlCache[absolutePath];
    var name = absolutePath.split('/').pop();
    var cands = [];
    try { if (ADAPTER_DIR) cands.push(new URL('workers/' + name, ADAPTER_DIR).href); }
    catch (e) { /* an unparseable base is simply not a candidate */ }
    try { cands.push(new URL(absolutePath, window.location.origin).href); }
    catch (e) { cands.push(absolutePath); }
    var last = cands[cands.length - 1];
    _workerUrlCache[absolutePath] = (function next(i) {
      if (i >= cands.length) return Promise.resolve(last);
      // HEAD, never GET: on our own origins the real bundle is ~235KB, and a GET
      // probe would pull the engine down twice every session.
      return fetch(cands[i], { method: 'HEAD' })
        .then(function (r) { return (r && r.ok) ? cands[i] : next(i + 1); })
        .catch(function () { return next(i + 1); });
    })(0);
    return _workerUrlCache[absolutePath];
  }
  // THE CPU LANE. llama.cpp compiled to wasm (wllama), same message protocol as the GPU
  // worker, takes a weights URL as its modelId. Served beside the GPU worker on every
  // Pages origin (verified 2026-08-23 on aitherium.com, gobbonet.aitherium.com and
  // wizzense.github.io/GobboNet: 299,568 B worker + 7.6 MB wllama.wasm, all 200).
  var WASM_WORKER_URL = '/workers/webgpu-brain-wasm-worker.js';
  // Converted stock-quant GGUFs, via the CORS-adding Worker in front of the GitHub release
  // assets (see AitherVeil src/lib/bonsai-models.ts wasmModelUrl). Only the 1.7B exists.
  var WASM_WEIGHTS_BASE = 'https://weights.aitherium.com';
  var WASM_RUNNABLE_IDS = ['bonsai-1.7b'];
  // The SAME tool registry aitherium.com's React surface uses, bundled to a global by
  // scripts/build-workers.mjs. Reported live 2026-08-22: the same model, in the same
  // browser, on two of our own pages -- 'what time is it?' answered correctly on
  // aitherium.com and 'I do not have access to real-time information' here. It was not
  // lying. On this page it genuinely had no tools.
  //
  // The WORKER already carried the whole registry and the whole tool loop; the loop is
  // gated on `req.tools && req.tools.length > 0` and this adapter never set the field.
  // So nothing was missing except the list -- which is the worst shape a gap can have,
  // because every component was present, tested and working.
  var TOOLS_URL = '/gobbonet/bonsai-tools.js';

  // gobbonet.aitherium.com is GITHUB PAGES. Measured: POST /api/search/query answers
  // 405 here and on the apex, and 200 on portal. A same-origin API base would make
  // every network-backed tool fail -- and fail as a 405, which reads like a broken
  // route rather than a static host. portal.aitherium.com allows this exact origin
  // (verified preflight: Access-Control-Allow-Origin: https://gobbonet.aitherium.com).
  var API_BASE = 'https://portal.aitherium.com';

  // Tools this SURFACE cannot honour, and why. Sending one is not free: the model
  // spends a turn calling it and gets a refusal back, which reads to the visitor as the
  // agent being broken. Each entry names a missing capability, not a preference.
  var UNSUPPORTED_TOOLS = {
    open_app: 'this page is a chat, not the desktop -- there is no window to open',
    list_apps: 'no app surface here, so the list is always empty',
    search_knowledge: 'needs an anon platform identity this page never mints',
    generate_image: 'the worker returns images on a channel this page does not render'
  };

  var toolsPromise = null;

  // Tools are an ENHANCEMENT, never a precondition. A failed load must leave chat
  // working exactly as it did before -- resolve null rather than reject, or one bad
  // fetch takes the whole page down to fix a feature it did not have yesterday.
  function loadTools() {
    if (toolsPromise) return toolsPromise;
    if (window.AitherBonsaiTools) {
      toolsPromise = Promise.resolve(window.AitherBonsaiTools);
      return toolsPromise;
    }
    toolsPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = TOOLS_URL;
      s.async = true;
      s.onload = function () { resolve(window.AitherBonsaiTools || null); };
      s.onerror = function () {
        console.warn('[aither] tool registry did not load; chat continues without tools');
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return toolsPromise;
  }

  // What to SEND this model. Two filters, in this order:
  //   1. the size budget -- a small brain given every definition has no room left for
  //      the conversation, so the registry ranks and trims by the model's size;
  //   2. this surface's own capability, above.
  function toolsForTurn(api) {
    if (!api || typeof api.getToolDefinitionsForModel !== 'function') return null;
    var cat = webgpuCatalogEntry(modelId);
    var defs = api.getToolDefinitionsForModel(cat && cat.sizeMb);
    if (!defs || !defs.length) return null;
    var usable = defs.filter(function (d) { return !UNSUPPORTED_TOOLS[d.name]; });
    return usable.length ? usable : null;
  }

  // The worker is a REAL Worker: no window, no document, and its own `location` is the
  // worker script's URL. Anything about the PAGE has to be handed over, or
  // get_page_context answers 'unknown' for every visitor -- a working tool returning
  // nothing, which is indistinguishable from a broken one.
  function toolContextForTurn() {
    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      apiBase: API_BASE,
      // Deliberately empty: this surface opens nothing, and `apps` is the WHITELIST
      // open_app checks. The tool is filtered out above rather than left to refuse.
      apps: []
    };
  }
  var DESKTOP_DEFAULT_MODEL_ID = 'bonsai-4b';

  // -- Phones ---------------------------------------------------------------------
  // Reported 2026-08-21: gobbonet.aitherium.com loads fine on a Pixel, and picking a
  // model KILLS THE TAB instantly. It is not a bug in the load path -- it is the load
  // path working exactly as written on a device that cannot survive it.
  //
  // Nothing in this file knew what a phone was. `DEFAULT_MODEL_ID` was `bonsai-4b`,
  // which is 545 MB of weights uploaded as WebGPU storage buffers plus an f32 KV
  // cache, so the DEFAULT for a phone visitor was the second-largest model on offer.
  // Veil has had a mobile refusal since 2026-08-15 (BIH003/BIH004, `autoBootAllowed`),
  // but that refusal governs UNATTENDED auto-boot only, and it lives in a TypeScript
  // module this unbundled script cannot import. A visitor TAPPING a model was never
  // covered anywhere, on any surface.
  //
  // Why a phone cannot do this while a weak laptop can: a mobile browser gives a tab a
  // small fraction of system memory and reclaims it aggressively, and the compositor
  // KILLS THE TAB rather than failing the allocation. So there is no error to catch and
  // no event to handle -- from the page's point of view the tab simply ceases. That is
  // why this must be a REFUSAL BEFORE THE DOWNLOAD and cannot be a try/catch after it.
  //
  // The predicate is byte-for-byte the one in awkit/src/webml/device-class.ts and
  // Veil's bonsai-webgpu/gpu-class.ts, which BIH004 compares. The iPadOS branch is the
  // half everyone omits: iPadOS 13+ sends a DESKTOP Safari user agent, so a plain UA
  // regex misses every modern iPad -- precisely the class BIH004 exists for.
  function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
    var touch = navigator.maxTouchPoints || 0;
    return /Macintosh/i.test(ua) && touch > 1;
  }

  // A PHONE NEVER GETS THE GPU LANE -- tap or no tap. Mirrors gpuLaneAllowed() in Veil's
  // gpu-class.ts and awkit's device-class.ts (BIH003c). The 320 MB budget below let the
  // 1.7B onto a phone's GPU, and that was still too much: the OS killed the worker for
  // memory mid-load, a memory-killed worker posts nothing and fires no onerror, so the
  // corpse was never torn down and "try the CPU version" fought it for the same RAM
  // (owner report 2026-08-23). So on a phone the ONLY in-tab lane is the wasm CPU worker,
  // and requestAdapter() is never called.
  function gpuLaneAllowed() { return !isMobileDevice(); }
  function cpuLane() { return !gpuLaneAllowed(); }
  function wasmRunnable(id) { return WASM_RUNNABLE_IDS.indexOf(id) !== -1; }
  function wasmModelUrl(id) {
    var cat = webgpuCatalogEntry(id);
    var m = cat && /([\d.]+B)/.exec(cat.label);
    var size = m ? m[1] : '1.7B';
    return WASM_WEIGHTS_BASE + '/Bonsai-' + size + '-TQ1_0.gguf';
  }

  // The largest in-browser model a phone may be offered, in MB of weights.
  //
  // 320 is deliberately ABOVE the 1.7B (236 MB) and BELOW the 4B (545 MB), so the
  // smallest model stays available on a phone and everything bigger is refused. It is
  // a budget, not a measurement: WebGPU exposes no "how much may this tab allocate"
  // number -- `maxBufferSize` describes ONE buffer, not the tab's total, and reports
  // gigabytes on hardware that dies at a few hundred megabytes. Choosing the threshold
  // from the model list, where the sizes are known exactly, is honest; deriving it from
  // an adapter limit that does not mean what it looks like would be a guess wearing a
  // measurement's clothes.
  //
  // Do NOT "fix" a phone report by raising this. The fix for wanting a bigger model on
  // a phone is the local server (phone.sh below), which runs the SAME weights on the
  // CPU with mmap and no tab budget at all -- 21 tok/s measured for the 1.7B. Raising
  // the number just moves the crash to whoever has a slightly smaller phone.
  var MOBILE_MAX_MB = 320;
  var MOBILE_DEFAULT_MODEL_ID = 'bonsai-1.7b';

  var DEFAULT_MODEL_ID = isMobileDevice() ? MOBILE_DEFAULT_MODEL_ID : DESKTOP_DEFAULT_MODEL_ID;

  // The one-liner that gives a phone the models its browser cannot hold. A constant
  // because it is shown in two places, and a drifting copy of an install command is how
  // people end up pasting a URL that 404s (ONB001).
  var PHONE_BOOTSTRAP = 'curl -fsSL https://aitherium.com/phone.sh | bash';

  /** null when this model may load here; otherwise the honest reason it may not. */
  function deviceRefusal(id) {
    if (!isMobileDevice()) return null;
    var cat = webgpuCatalogEntry(id);
    // On a phone the GPU is never used (gpuLaneAllowed): a size is runnable here only if
    // its converted CPU weights exist, which today is the 1.7B alone.
    if (cat && wasmRunnable(id)) return null;
    return (cat ? cat.label : id) + ' has no CPU build for this phone, and the phone GPU '
      + 'is never used in this tab -- loading it there ends the tab rather than reporting '
      + 'an error. Pick the 1.7B (runs on the CPU here), or run it on this phone '
      + 'properly with a Linux terminal (Termux or the Android Linux Terminal):\n\n'
      + PHONE_BOOTSTRAP + '\n\n'
      + 'That serves the model over 127.0.0.1 and this page picks it up by itself -- no '
      + 'sign-in, no tab limit, and every size up to the 27B.';
  }

  // A CRASH ON A PHONE NEEDS THE SAME ESCAPE THE REFUSAL ALREADY OFFERS.
  //
  // deviceRefusal() above names Termux and the one-liner BEFORE an oversized model is
  // loaded. Nothing said it AFTER the GPU died -- teardown() passed the raw error
  // through, so a phone whose device was torn away got
  //
  //   GPU device lost (unknown: A valid external Instance reference no longer exists.)
  //
  // ...and no route out. Reported 2026-08-22 with the phone left unusable. The asymmetry
  // IS the bug: one path on this file offers the escape, and the other -- reached only
  // once something has already gone badly wrong -- did not.
  //
  // Mobile only. On a desktop a lost device is a stutter the breaker already handles, and
  // appending an install pitch to every crash there is the CTA-in-the-chat the owner ruled
  // out on 2026-08-01. Here it is the remedy rather than a pitch: the cloud lane rescues
  // the CHAT, and nothing but the native lane rescues the DEVICE.
  function crashEscape(err) {
    if (!isMobileDevice()) return err;
    var msg = (err && err.message) || 'the in-browser model failed';
    return new Error(msg + '\n\nThat was your phone\'s GPU being taken away by the OS'
      + ' -- which is what froze the device, and retrying asks for it again. The same'
      + ' model runs natively, off the GPU, in a Linux terminal (Termux or the Android'
      + ' Linux Terminal):\n\n' + PHONE_BOOTSTRAP + '\n\nThat serves it over'
      + ' 127.0.0.1 and this page picks it up by itself -- no tab limit, and every size'
      + ' up to the 27B.');
  }
  // ── Consent, and where a model may run at all ────────────────────────────────────────
  // 🚨 DUPLICATED FROM src/lib/bonsai-consent.ts, for the same reason FIRST_TOKEN_FAIL_MS
  // above is: this file is served as a plain <script> to a page with no bundler, so it
  // cannot import the shared module. Nothing under public/ is compiled, imported or
  // type-checked either, so no TypeScript-shaped rule can see this copy — which is exactly
  // how the shared browser-inference worker drifted from the Living OS copy while carrying a
  // comment asking people to keep them in step. A comment is not a gate: BCG007 in
  // check_bonsai_consent_gate.py DIFFS these three values against the canonical module and
  // fails on any disagreement.
  //
  // Owner directive 2026-08-20: nothing downloads without an explicit yes, the yes is only
  // remembered if the visitor ticks the box, and a reading surface never runs a model at all.
  var CONSENT_KEY = 'aitheros-bonsai-consent';
  // The two github.io entries are the upstream GobboNet browser-demo origins:
  // the ElodineOfficial/gobbonet Pages site, and our fork Pages where a PR is
  // previewable before it merges. Same doctrine as every other entry — added
  // because the demo tree deployed there genuinely runs the brain, and the
  // per-visitor download consent still gates every load.
  var ALLOWED_HOSTS = ['aitherium.com', 'www.aitherium.com', 'desktop.aitherium.com',
    'spaces.aitherium.com', 'gobbonet.aitherium.com', 'dgg.aitherium.com',
    'garg.aitherium.com', 'localhost', '127.0.0.1',
    'elodineofficial.github.io', 'wizzense.github.io'];
  var DENIED_PATHS = ['/blog', '/docs', '/media', '/changelog', '/pricing', '/about',
    '/privacy', '/terms', '/legal', '/help', '/support', '/welcome', '/status'];

  function surfaceRefusal() {
    var h = String(location.hostname || '').toLowerCase().split(':')[0];
    if (!h || ALLOWED_HOSTS.indexOf(h) < 0) {
      return 'The in-browser model runs on aitherium.com only — not on ' + (h || 'this host') + '.';
    }
    var p = location.pathname || '/';
    for (var i = 0; i < DENIED_PATHS.length; i++) {
      var d = DENIED_PATHS[i];
      if (p === d || p.indexOf(d + '/') === 0) {
        return 'The in-browser model does not run on reading surfaces (' + d + ').';
      }
    }
    return null;
  }

  // Fails CLOSED on unreadable storage or a malformed record — "I could not read the
  // consent" is not consent.
  function readConsent() {
    try {
      var raw = window.localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || v.granted !== true) return null;
      return { granted: true, auto: v.auto === true };
    } catch (e) { return null; }
  }

  function writeConsent(auto) {
    try {
      window.localStorage.setItem(CONSENT_KEY, JSON.stringify({
        granted: true, auto: !!auto, at: new Date().toISOString(),
      }));
    } catch (e) { /* private mode: the session proceeds, it is just not remembered */ }
  }

  var consentAsk = null;   // one dialog at a time; concurrent sends share the same promise

  // A minimal dialog rather than a confirm(): a native confirm cannot carry the checkbox,
  // and the checkbox is the half the owner asked for. Built in the DOM because this page has
  // no framework.
  function askConsent() {
    if (consentAsk) return consentAsk;
    consentAsk = new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.setAttribute('data-testid', 'bonsai-consent-dialog');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:' +
        'center;justify-content:center;background:rgba(0,0,0,.7);padding:16px';
      var cat = webgpuCatalogEntry(modelId);
      var mb = (cat && cat.sizeMb) || 0;
      wrap.innerHTML =
        '<div style="max-width:28rem;width:100%;background:#0b0d13;color:#cbd5e1;border:1px ' +
        'solid rgba(255,255,255,.1);border-radius:12px;padding:24px;font:14px/1.5 system-ui">' +
        '<h2 style="margin:0 0 12px;color:#fff;font-size:16px">Run this model on your device?</h2>' +
        '<p style="margin:0 0 8px">This downloads ' +
        (mb ? '<strong style="color:#fff">about ' + mb + ' MB</strong>' : 'the model weights') +
        ' to your browser and runs it on your own GPU. Your conversation stays on this ' +
        'device — nothing is sent to a server for it.</p>' +
        '<p style="margin:0 0 16px;color:#94a3b8">The download happens once and is cached.</p>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">' +
        '<input type="checkbox" data-testid="bonsai-consent-auto" style="margin-top:3px">' +
        '<span>Load automatically on this device from now on</span></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px">' +
        '<button data-testid="bonsai-consent-decline" style="padding:8px 16px;border:0;' +
        'background:transparent;color:#94a3b8;cursor:pointer">Not now</button>' +
        '<button data-testid="bonsai-consent-accept" style="padding:8px 16px;border:0;' +
        'border-radius:8px;background:#34d399;color:#000;font-weight:500;cursor:pointer">' +
        'Download and run</button></div></div>';
      // The box is DEFAULT OFF and set here, never in the markup: a pre-ticked checkbox is a
      // default the visitor has to notice to escape, not a decision they made.
      var box = wrap.querySelector('[data-testid="bonsai-consent-auto"]');
      box.checked = false;
      var settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        consentAsk = null;
        if (ok) writeConsent(box.checked);
        resolve(ok);
      }
      // A DETACHED DIALOG COUNTS AS DECLINED. GobboNet re-renders large parts of the page
      // (thread switches, character edits), and a wrap element removed from the DOM by
      // anything other than `done` would leave this promise unsettled FOREVER — and the
      // caller is `ensureReady`, which the model swap awaits. That is a permanent
      // "Swapping to Bonsai 1.7B (in-browser)..." with nothing on screen to act on, which
      // is exactly the shape of hang this adapter was reported for on 2026-08-20.
      // Never leave a promise that gates a visible state machine without a path to settle.
      var watch = setInterval(function () {
        if (!wrap.isConnected) done(false);
      }, 1000);
      wrap.querySelector('[data-testid="bonsai-consent-accept"]')
        .addEventListener('click', function () { done(true); });
      wrap.querySelector('[data-testid="bonsai-consent-decline"]')
        .addEventListener('click', function () { done(false); });
      document.body.appendChild(wrap);
    });
    return consentAsk;
  }

  /** Resolves only when a model may actually be downloaded. Rejects with the honest reason. */
  function requireConsent() {
    var refusal = surfaceRefusal();
    if (refusal) return Promise.reject(new Error(refusal));
    // The DEVICE refusal goes here, beside the surface refusal and BEFORE the consent
    // dialog -- not after it. Asking a phone visitor to approve a download that will
    // kill their tab is worse than not offering it: they say yes, wait through 545 MB,
    // and the page dies with their consent on record. Order is the rule, not a detail.
    var deviceNo = deviceRefusal(modelId);
    if (deviceNo) return Promise.reject(new Error(deviceNo));
    if (readConsent()) return Promise.resolve();
    return askConsent().then(function (ok) {
      if (!ok) throw new Error('The in-browser model was not loaded — permission declined.');
    });
  }

  // ── Consent, and where a model may run at all ────────────────────────────────────────
  // 🚨 DUPLICATED FROM src/lib/bonsai-consent.ts, for the same reason FIRST_TOKEN_FAIL_MS
  // above is: this file is served as a plain <script> to a page with no bundler, so it
  // cannot import the shared module. Nothing under public/ is compiled, imported or
  // type-checked either, so no TypeScript-shaped rule can see this copy — which is exactly
  // how the shared browser-inference worker drifted from the Living OS copy while carrying a
  // comment asking people to keep them in step. A comment is not a gate: BCG007 in
  // check_bonsai_consent_gate.py DIFFS these three values against the canonical module and
  // fails on any disagreement.
  //
  // Owner directive 2026-08-20: nothing downloads without an explicit yes, the yes is only
  // remembered if the visitor ticks the box, and a reading surface never runs a model at all.
  var CONSENT_KEY = 'aitheros-bonsai-consent';
  // The two github.io entries are the upstream GobboNet browser-demo origins:
  // the ElodineOfficial/gobbonet Pages site, and our fork Pages where a PR is
  // previewable before it merges. Same doctrine as every other entry — added
  // because the demo tree deployed there genuinely runs the brain, and the
  // per-visitor download consent still gates every load.
  var ALLOWED_HOSTS = ['aitherium.com', 'www.aitherium.com', 'desktop.aitherium.com',
    'spaces.aitherium.com', 'gobbonet.aitherium.com', 'dgg.aitherium.com',
    'garg.aitherium.com', 'localhost', '127.0.0.1',
    'elodineofficial.github.io', 'wizzense.github.io'];
  var DENIED_PATHS = ['/blog', '/docs', '/media', '/changelog', '/pricing', '/about',
    '/privacy', '/terms', '/legal', '/help', '/support', '/welcome', '/status'];

  function surfaceRefusal() {
    var h = String(location.hostname || '').toLowerCase().split(':')[0];
    if (!h || ALLOWED_HOSTS.indexOf(h) < 0) {
      return 'The in-browser model runs on aitherium.com only — not on ' + (h || 'this host') + '.';
    }
    var p = location.pathname || '/';
    for (var i = 0; i < DENIED_PATHS.length; i++) {
      var d = DENIED_PATHS[i];
      if (p === d || p.indexOf(d + '/') === 0) {
        return 'The in-browser model does not run on reading surfaces (' + d + ').';
      }
    }
    return null;
  }

  // Fails CLOSED on unreadable storage or a malformed record — "I could not read the
  // consent" is not consent.
  function readConsent() {
    try {
      var raw = window.localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || v.granted !== true) return null;
      return { granted: true, auto: v.auto === true };
    } catch (e) { return null; }
  }

  function writeConsent(auto) {
    try {
      window.localStorage.setItem(CONSENT_KEY, JSON.stringify({
        granted: true, auto: !!auto, at: new Date().toISOString(),
      }));
    } catch (e) { /* private mode: the session proceeds, it is just not remembered */ }
  }

  var consentAsk = null;   // one dialog at a time; concurrent sends share the same promise

  // A minimal dialog rather than a confirm(): a native confirm cannot carry the checkbox,
  // and the checkbox is the half the owner asked for. Built in the DOM because this page has
  // no framework.
  function askConsent() {
    if (consentAsk) return consentAsk;
    consentAsk = new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.setAttribute('data-testid', 'bonsai-consent-dialog');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:' +
        'center;justify-content:center;background:rgba(0,0,0,.7);padding:16px';
      var cat = webgpuCatalogEntry(modelId);
      var mb = (cat && cat.sizeMb) || 0;
      wrap.innerHTML =
        '<div style="max-width:28rem;width:100%;background:#0b0d13;color:#cbd5e1;border:1px ' +
        'solid rgba(255,255,255,.1);border-radius:12px;padding:24px;font:14px/1.5 system-ui">' +
        '<h2 style="margin:0 0 12px;color:#fff;font-size:16px">Run this model on your device?</h2>' +
        '<p style="margin:0 0 8px">This downloads ' +
        (mb ? '<strong style="color:#fff">about ' + mb + ' MB</strong>' : 'the model weights') +
        ' to your browser and runs it on your own GPU. Your conversation stays on this ' +
        'device — nothing is sent to a server for it.</p>' +
        '<p style="margin:0 0 16px;color:#94a3b8">The download happens once and is cached.</p>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">' +
        '<input type="checkbox" data-testid="bonsai-consent-auto" style="margin-top:3px">' +
        '<span>Load automatically on this device from now on</span></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px">' +
        '<button data-testid="bonsai-consent-decline" style="padding:8px 16px;border:0;' +
        'background:transparent;color:#94a3b8;cursor:pointer">Not now</button>' +
        '<button data-testid="bonsai-consent-accept" style="padding:8px 16px;border:0;' +
        'border-radius:8px;background:#34d399;color:#000;font-weight:500;cursor:pointer">' +
        'Download and run</button></div></div>';
      // The box is DEFAULT OFF and set here, never in the markup: a pre-ticked checkbox is a
      // default the visitor has to notice to escape, not a decision they made.
      var box = wrap.querySelector('[data-testid="bonsai-consent-auto"]');
      box.checked = false;
      var settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        consentAsk = null;
        if (ok) writeConsent(box.checked);
        resolve(ok);
      }
      // A DETACHED DIALOG COUNTS AS DECLINED. GobboNet re-renders large parts of the page
      // (thread switches, character edits), and a wrap element removed from the DOM by
      // anything other than `done` would leave this promise unsettled FOREVER — and the
      // caller is `ensureReady`, which the model swap awaits. That is a permanent
      // "Swapping to Bonsai 1.7B (in-browser)..." with nothing on screen to act on, which
      // is exactly the shape of hang this adapter was reported for on 2026-08-20.
      // Never leave a promise that gates a visible state machine without a path to settle.
      var watch = setInterval(function () {
        if (!wrap.isConnected) done(false);
      }, 1000);
      wrap.querySelector('[data-testid="bonsai-consent-accept"]')
        .addEventListener('click', function () { done(true); });
      wrap.querySelector('[data-testid="bonsai-consent-decline"]')
        .addEventListener('click', function () { done(false); });
      document.body.appendChild(wrap);
    });
    return consentAsk;
  }

  /** Resolves only when a model may actually be downloaded. Rejects with the honest reason. */
  function requireConsent() {
    var refusal = surfaceRefusal();
    if (refusal) return Promise.reject(new Error(refusal));
    if (readConsent()) return Promise.resolve();
    return askConsent().then(function (ok) {
      if (!ok) throw new Error('The in-browser model was not loaded — permission declined.');
    });
  }

  var origFetch = window.privacyFetch;
  if (typeof origFetch !== 'function') {
    console.error('[aither] privacyFetch is not defined — load this after GobboNet\'s scripts.');
    return;
  }

  // ── The onramp text ─────────────────────────────────────────────────────────────────
  // One string, three call sites. It used to be pasted at each, which is how the awdk
  // hint stayed the ONLY thing offered here long after a real one-command installer
  // existed and was serving.
  //
  // 🚨 THE INSTALLER IS REAL AND PUBLIC. `https://aitherium.com/install-bonsai.sh` is
  // live (verified 200, 2026-08-22) and defaults to PORT=8080 -- a port this adapter
  // already probes -- so a visitor who runs it is discovered immediately. The gap was
  // never a missing API: there is no daemon route to install a model, a browser cannot
  // install a binary, and the platform's own answer (`.claude/skills/selfhost-bonsai`)
  // is exactly this script. The page simply never mentioned it, so the capability was
  // being offered to nobody -- the same defect the awdk hint below was added to fix,
  // one layer up.
  var ONRAMP_TEXT =
    'Run a real model on this machine: `curl -fsSL https://aitherium.com/install-bonsai.sh | sh`'
    + ' — it picks a size for your hardware, starts a local server and this page finds it.'
    + ' Already running your own? `pip install awdk` then `adk up` works too, with no sign-in.';

  // ── The onramp: detect a real local awdk/awnode and route there instead ────────────────
  // Same probe ladder as the Living Desktop's useLocalNode (src/components/os/use-local-node.ts)
  // — duplicated here because this file ships as a plain <script> to an unbundled page and
  // cannot import that hook. Keep the port list in step with it: a base added there and not
  // here silently drops GobboNet as an onramp surface while the rest of the site correctly
  // finds the same node. 127.0.0.1, never "localhost" — see that file's header comment for why.
  var LOCAL_NODE_BASES = [
    'http://127.0.0.1:8498', // awnode container, plain-HTTP loopback status port
    'http://127.0.0.1:8090', // awnode daemon default
    'http://127.0.0.1:8000', // adk server
    'http://127.0.0.1:8080', // bare llama.cpp llama-server (aitherium.com/phone.sh)
    'http://127.0.0.1:8092', // aither-llamacpp-bonsai, the fleet's own local Bonsai container
    'http://127.0.0.1:9001', // awdk's daemon (adk up)
    // The MCP gateway. Plain HTTP on loopback and therefore the ONE fleet surface a
    // browser can actually reach: MicroScheduler serves the real model roster on :8150
    // but over TLS with an internal-CA cert no browser can validate, which is exactly
    // why :8490 was removed from the Living Desktop's list on 2026-07-30. Adding an
    // internal-CA port here would look right on this machine (where the CA is installed)
    // and fail silently on every visitor's.
    // Requires the CORS + Private-Network-Access layer added to the gateway in
    // e295f3b56b; before that it answered 200 and the browser discarded it.
    'http://127.0.0.1:8182',
    // :8889 — the port the platform's OWN self-host playbook tells people to use.
    // `.claude/skills/selfhost-bonsai` names it sixteen times ("llama-server ... --listen
    // 127.0.0.1 --port 8889 -np 1"), and NEITHER probe list had it. So a stranger who
    // followed our documented procedure exactly ended up with a working llama.cpp server
    // that this page could never find — the playbook and the discovery code disagreeing
    // about a number, with nothing comparing them. Asserted now by LNP002.
    'http://127.0.0.1:8889',
  ];
  var LOCAL_NODE_POLL_MS = 4000;
  // `models` is EVERY id the node serves, not just the first. A node running adk can
  // hold several GGUFs, and taking data[0] exposed exactly one of them to the picker —
  // so a machine with four models downloaded looked like a machine with one, and the
  // other three were unreachable from this UI with no indication they existed.
  var localNode = { base: null, modelId: null, models: [], lockedCount: 0 };

  // ── Signing in to the fleet ──────────────────────────────────────────────────────────
  // The gateway answers /v1/models with its whole catalogue and marks each row
  // `accessible`, which is FALSE for anything above the caller's tier. Measured
  // 2026-08-20 on :8182: 6 models, 1 accessible unauthenticated. A bearer turns the
  // rest on, and the ONLY flow a page with no backend can run is the OAuth DEVICE
  // grant (RFC 8628) the gateway already serves at /auth/device/* — the same flow
  // mint_session_bearer.py uses. Nothing new was added server-side for this.
  //
  // The token is stored per-ORIGIN in localStorage, exactly like the consent record.
  // It is NOT a platform credential the page invents: the visitor authorises it on
  // portal.aitherium.com and can revoke it there.
  var GATEWAY_TOKEN_KEY = 'aitheros-gateway-token';

  function readToken() {
    try {
      var raw = window.localStorage.getItem(GATEWAY_TOKEN_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      // An expired token is WORSE than none: it makes every gateway call 401, and the
      // caller cannot tell "signed out" from "the fleet is down". Drop it here.
      if (!v || !v.access_token) return null;
      if (v.expires_at && Date.now() > v.expires_at) { forgetToken(); return null; }
      return v.access_token;
    } catch (e) { return null; }
  }

  function writeToken(tok, expiresIn) {
    try {
      window.localStorage.setItem(GATEWAY_TOKEN_KEY, JSON.stringify({
        access_token: tok,
        // A minute of slack so a token that expires mid-request is treated as expired
        // before it is sent, rather than producing a 401 nobody can explain.
        expires_at: expiresIn ? Date.now() + (expiresIn - 60) * 1000 : 0,
        at: new Date().toISOString(),
      }));
    } catch (e) { /* private mode: usable this session, just not remembered */ }
  }

  function forgetToken() {
    try { window.localStorage.removeItem(GATEWAY_TOKEN_KEY); } catch (e) {}
  }

  /** Merge the bearer into a fetch init WITHOUT clobbering headers the caller set. */
  function withGatewayAuth(options) {
    var tok = readToken();
    if (!tok) return options;
    var next = Object.assign({}, options || {});
    var h = new Headers((options && options.headers) || {});
    h.set('Authorization', 'Bearer ' + tok);
    next.headers = h;
    return next;
  }

  /** Only the gateway gets the bearer. A bare llama.cpp on :8080 has no use for it, and
   *  sending a platform credential to whatever happens to answer a loopback port is how
   *  a token leaks to something that was never meant to see it. */
  function isGateway(base) { return /:8182$/.test(String(base || '')); }

  var signInFlow = null;   // one at a time; a second click joins the first

  /**
   * RFC 8628 device grant against the gateway, driven from the page.
   *
   * Deliberately NOT a popup-and-hope: the visitor approves on portal.aitherium.com in
   * their own tab, and this polls until the gateway hands over a token. The user_code is
   * shown on the page as well as passed in the URL, because a popup blocker eating the
   * tab must not leave the flow with nothing to act on.
   */
  function signInToFleet() {
    if (signInFlow) return signInFlow;
    var base = localNode.base;
    if (!isGateway(base)) {
      return Promise.reject(new Error('the fleet gateway is not reachable from this page'));
    }
    signInFlow = fetch(base + '/auth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'gobbonet' }),
    }).then(function (r) {
      if (!r.ok) throw new Error('the gateway declined to start a sign-in (HTTP ' + r.status + ')');
      return r.json();
    }).then(function (d) {
      if (!d || !d.device_code) throw new Error('the gateway returned no device code');
      showSignInPrompt(d);
      var deadline = Date.now() + (d.expires_in || 900) * 1000;
      // Honour the server's interval. Polling faster earns `slow_down` and, on a strict
      // implementation, invalidates the flow — a self-inflicted failure that reads as the
      // gateway rejecting a valid code.
      var every = Math.max(2, d.interval || 5) * 1000;
      return new Promise(function (resolve, reject) {
        (function poll() {
          if (Date.now() > deadline) {
            dismissSignInPrompt();
            return reject(new Error('the sign-in code expired before it was approved'));
          }
          fetch(base + '/auth/device/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: d.device_code, client_id: 'gobbonet' }),
          }).then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (t) {
              if (t && t.access_token) {
                writeToken(t.access_token, t.expires_in);
                dismissSignInPrompt();
                // Re-probe NOW rather than waiting up to 4s for the next poll: the whole
                // point of signing in is that the picker changes, and a picker that
                // updates "eventually" reads as the sign-in not having worked.
                return probeLocalNode().catch(function () {}).then(function () {
                  relabelBackend();
                  resolve(t.access_token);
                });
              }
              var status = t && (t.status || t.error);
              if (status === 'authorization_pending' || status === 'slow_down') {
                if (status === 'slow_down') every += 2000;
                return void setTimeout(poll, every);
              }
              dismissSignInPrompt();
              reject(new Error(status ? 'sign-in refused: ' + status : 'sign-in failed'));
            })
            .catch(function () { setTimeout(poll, every); });
        }());
      });
    }).catch(function (err) {
      dismissSignInPrompt();
      throw err;
    }).then(function (v) { signInFlow = null; return v; },
      function (e) { signInFlow = null; throw e; });
  }

  var SIGNIN_ID = 'aither-signin-prompt';

  function showSignInPrompt(d) {
    dismissSignInPrompt();
    var wrap = document.createElement('div');
    wrap.id = SIGNIN_ID;
    wrap.setAttribute('role', 'dialog');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;display:flex;align-items:' +
      'center;justify-content:center;background:rgba(0,0,0,.7);padding:16px';
    var card = document.createElement('div');
    card.style.cssText = 'background:#0b0b12;color:#e8e8f0;border:1px solid #2a2a3a;' +
      'border-radius:10px;max-width:26rem;padding:1.25rem;font:14px/1.5 ui-monospace,monospace';
    var code = document.createElement('div');
    code.textContent = d.user_code || '';
    code.style.cssText = 'font-size:1.6rem;letter-spacing:.18em;margin:.75rem 0;color:#5eead4';
    var p = document.createElement('p');
    p.style.cssText = 'margin:0;color:#b8b8c8';
    p.textContent = 'Approve this code at portal.aitherium.com to use the fleet’s models. '
      + 'This window updates on its own once you do.';
    var a = document.createElement('a');
    a.href = d.verification_uri_complete || d.verification_uri || 'https://portal.aitherium.com/link';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open the approval page ↗';
    a.style.cssText = 'display:inline-block;margin-top:.9rem;color:#5eead4';
    var cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'margin-left:1rem;background:none;border:1px solid #2a2a3a;' +
      'color:#b8b8c8;border-radius:6px;padding:.35rem .8rem;cursor:pointer';
    cancel.onclick = dismissSignInPrompt;
    card.appendChild(Object.assign(document.createElement('strong'),
      { textContent: 'Sign in to use the fleet’s models' }));
    card.appendChild(code);
    card.appendChild(p);
    card.appendChild(a);
    card.appendChild(cancel);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  function dismissSignInPrompt() {
    var el = document.getElementById(SIGNIN_ID);
    if (el) el.remove();
  }
  // Whether chat routes to a detected local node when one is present. Defaults true (the
  // onramp's whole point); flipped false only by an EXPLICIT user pick of a WebGPU size
  // in the model selector (see handleSwapModel below), so a deliberate choice sticks
  // rather than being silently overridden by the next detection poll.
  var preferLocalNode = true;

  // Rewrite ONLY the `model` field of an outgoing chat body to the selected local model.
  // Returns the original options untouched when there is nothing to say or the body is
  // not parseable JSON — a body we cannot read is forwarded verbatim rather than dropped,
  // because guessing at it would break a request that would otherwise have worked.
  function withLocalModel(options) {
    if (!localNode.modelId || !options || typeof options.body !== 'string') return options;
    var body;
    try { body = JSON.parse(options.body); } catch (e) { return options; }
    if (!body || typeof body !== 'object' || body.model === localNode.modelId) return options;
    body.model = localNode.modelId;
    var next = {};
    for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) next[k] = options[k];
    next.body = JSON.stringify(body);
    return next;
  }

  function probeLocalNode() {
    return Promise.any(LOCAL_NODE_BASES.map(function (b) {
      // The bearer rides ONLY to the gateway (isGateway); the probe is otherwise
      // unchanged. Without it a signed-in visitor keeps seeing the free-tier list,
      // which reads as the sign-in having silently failed.
      var init = { signal: AbortSignal.timeout(1500), cache: 'no-store' };
      if (isGateway(b)) init = withGatewayAuth(init);
      return fetch(b + '/v1/models', init)
        .then(function (res) { if (!res.ok) throw new Error('not ok'); return res.json().then(function (body) { return { base: b, body: body }; }); });
    })).then(function (winner) {
      if (localNode.base !== winner.base) {
        console.log('[aither] local node detected on ' + winner.base + ' — routing GobboNet chat there instead of the in-browser model.');
      }
      var appeared = !localNode.base;
      localNode.base = winner.base;
      // Relabel on the TRANSITION. relabelBackend otherwise runs only when the landing
      // page renders, so a node started mid-session left the page claiming the GPU and
      // still showing the "install awdk" hint while adk was answering every turn.
      if (appeared) relabelBackend();
      var data = (winner.body && Array.isArray(winner.body.data)) ? winner.body.data : [];
      // ONLY WHAT THE CALLER CAN ACTUALLY USE. The MCP gateway answers /v1/models with
      // its whole catalogue and marks each row `accessible`, which is FALSE for anything
      // above the caller's tier — measured 2026-08-20 on :8182, 6 models of which 1 was
      // accessible unauthenticated. Listing the other five would put five options in the
      // picker that fail the moment they are chosen: a phantom capability (PTB001), and
      // the failure lands on the USER's click rather than anywhere a probe would see it.
      // A node that does not publish the field is unfiltered, because absent is not false.
      var ids = data
        .filter(function (m) { return m && m.accessible !== false; })
        .map(function (m) { return m.id; })
        .filter(Boolean);
      // How many were withheld, so the sign-in offer can state a NUMBER instead of
      // hinting that something unnamed might exist. Measured, not assumed: if nothing is
      // locked the offer does not appear at all.
      localNode.lockedCount = data.filter(function (m) {
        return m && m.accessible === false;
      }).length;
      localNode.models = ids;
      // KEEP AN EXPLICIT PICK ACROSS POLLS. This runs every 4s, so re-deriving the
      // selection from the list each time would silently drag the user back to the
      // node's first model seconds after they chose a different one.
      if (!localNode.modelId || ids.indexOf(localNode.modelId) === -1) {
        localNode.modelId = ids[0] || 'local-model';
      }
    }).catch(function () {
      var lost = !!localNode.base;
      if (lost) console.log('[aither] local node lost — falling back to the in-browser model.');
      localNode.base = null;
      localNode.modelId = null;
      localNode.models = [];
      // Clear the withheld count too, or a sign-in offer naming N models outlives the
      // node that reported them -- an offer for something no longer reachable.
      localNode.lockedCount = 0;
      if (lost) relabelBackend();
    });
  }
  // Fire immediately (don't make the visitor wait a full poll interval to be routed
  // correctly), then keep polling so a node started mid-session is picked up and one
  // that goes away is noticed.
  probeLocalNode();
  setInterval(probeLocalNode, LOCAL_NODE_POLL_MS);

  // ── Worker lifecycle ─────────────────────────────────────────────────────────────────
  var worker = null;
  var ready = false;
  //: Whole-percent download progress, or null before the first 'progress' message. Null is
  //: a REAL state, not a zero — "LOADING…" and "LOADING 0%" say different things, and a
  //: fabricated 0% is the same class of wrong as the pill this whole change is about.
  var loadPct = null;
  var readyWaiters = [];
  var active = null;          // { onToken, onDone, onError, sawFirstToken, timer }
  var modelId = DEFAULT_MODEL_ID;

  function teardown(err) {
    if (active) {
      if (active.timer) clearTimeout(active.timer);
      var a = active;
      active = null;
      a.onError(err);
    }
    readyWaiters.splice(0).forEach(function (w) { w.reject(err); });
    ready = false;
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
  }

  function disarm() {
    if (active && active.timer) { clearTimeout(active.timer); active.timer = null; }
  }

  function spawn(resolvedUrl) {
    var w = new Worker(resolvedUrl || (cpuLane() ? WASM_WORKER_URL : WORKER_URL),
                       { type: 'module' });

    w.onmessage = function (ev) {
      var msg = ev.data || {};
      switch (msg.type) {
        case 'ready':
          ready = true;
          loadPct = null;
          // REPAINT ON THE TRANSITION. Without this the header keeps saying "READY TO LOAD"
          // after the weights are in, which is the same defect as the old code with the
          // sign flipped — and just as invisible, because nothing re-renders on its own.
          relabelBackend();
          readyWaiters.splice(0).forEach(function (x) { x.resolve(); });
          break;
        case 'tool_action':
        case 'image':
          // Named explicitly so they are DECLINED, not silently swallowed by falling
          // off the switch. Both are honoured on the desktop surface and cannot be
          // here; the tools that raise them are filtered out of the request for exactly
          // that reason, so reaching this arm means the filter has a hole.
          break;
        case 'progress':
          // The worker reports a FINISHED TOOL CALL as a progress line carrying `file`
          // and no numeric `progress`, which the branch below ignores. Re-emit it as an
          // event so tool activity is observable instead of invisible.
          if (typeof msg.progress !== 'number' && msg.file) {
            window.dispatchEvent(new CustomEvent('aither-bonsai-tool',
              { detail: { info: msg.file } }));
          }
          if (typeof msg.progress === 'number') {
            // Accept both conventions rather than guessing: the worker reports 0..1 today,
            // and a 0..100 reading must not render as "LOADING 1%" forever.
            var pct = msg.progress <= 1 ? msg.progress * 100 : msg.progress;
            var next = Math.max(0, Math.min(100, Math.round(pct)));
            if (next !== loadPct) { loadPct = next; relabelBackend(); }
            window.dispatchEvent(new CustomEvent('aither-bonsai-progress', { detail: msg }));
          }
          break;
        case 'token':
          // FIRST token disarms the deadline — any channel. A reasoning model's scratchpad
          // proves the worker is alive exactly as well as an answer token does.
          if (active && !active.sawFirstToken) { active.sawFirstToken = true; disarm(); }
          // THREE channels, not two. The worker gates its answer channel while tools
          // are active and posts completed <tool_call> blocks on `channel: 'tool'`.
          // Treating that as answer text types the raw XML into the reply bubble, and a
          // stream is append-only -- nothing can take it back afterwards. Routed to the
          // reasoning channel so it stays VISIBLE and collapsible rather than hidden: a
          // visitor who can see the call can tell a searched answer from a guess.
          if (active) active.onToken(msg.text || '',
            msg.channel === 'thinking' || msg.channel === 'tool');
          break;
        case 'done':
          if (active) { disarm(); var d = active; active = null; d.onDone(); }
          break;
        case 'error': {
          var e = new Error(msg.message || 'the in-browser model failed');
          // A LOST GPU DEVICE IS TERMINAL. Retrying submits the same work to the same
          // adapter and resets the display driver again — on Windows that presents as the
          // screen flashing repeatedly, outliving the tab. Tear down; do not re-arm.
          if (msg.fatal === 'device-lost') teardown(crashEscape(e));
          else if (active) { disarm(); var a = active; active = null; a.onError(e); }
          // 🚨 AN ERROR DURING **LOAD** FELL THROUGH BOTH BRANCHES AND VANISHED.
          // `active` is only set once a generate is in flight. A failure while the model is
          // still LOADING has no `active`, is not `device-lost`, and so hit neither arm —
          // the error was constructed and dropped on the floor. `readyWaiters` was never
          // rejected, `ensureReady()` never settled, and the chat sat there forever with
          // nothing on screen. That is the "GobboNet chat never responds" report of
          // 2026-08-20, and the "Swapping to Bonsai 1.7B (in-browser)..." that never ended.
          //
          // Measured, not inferred: driving a real chat through the live adapter, the worker
          // posts {"type":"error","message":"bonsai load failed: ..."} and the page shows
          // NOTHING. Every load failure is silent by construction.
          //
          // Tear down so the waiters are rejected AND the dead worker is discarded — a
          // retry must get a fresh one, since a worker that failed to load holds no model.
          else if (readyWaiters.length) teardown(e);
          break;
        }
      }
    };

    // BIH001 — BOTH handlers, always. `onerror` covers a worker that threw; `onmessageerror`
    // covers a message that could not be deserialised, which fires NO error event and would
    // otherwise settle nothing at all: the promise stays pending and the UI reads "thinking"
    // until the tab is closed. That silence is the single most-reported symptom of this class.
    w.onerror = function (ev) {
      teardown(new Error('the in-browser model worker crashed'
        + (ev && ev.message ? ': ' + ev.message : ' before it could start')));
    };
    w.onmessageerror = function () {
      teardown(new Error('a reply from the in-browser model could not be read'));
    };
    return w;
  }

  function ensureReady() {
    if (ready && worker) return Promise.resolve();
    // THE GATE GOES HERE, not at the call sites. Both callers (a chat send, an explicit
    // model swap) reach the worker through this one function, so asking here is the same
    // chokepoint discipline start() uses in webgpu-brain.tsx — a third caller added later
    // inherits the gate instead of having to remember it.
    return requireConsent().then(function () {
      // Resolve the lane's worker BEFORE constructing it: a 404 here is what a
      // subpath deployment used to hit, and `new Worker` on a 404 dies as an
      // opaque "crashed before it could start".
      return resolveWorkerUrl(cpuLane() ? WASM_WORKER_URL : WORKER_URL);
    }).then(function (resolvedUrl) {
      if (!worker) {
        worker = spawn(resolvedUrl);
        // The wasm worker has no catalogue: its modelId IS the weights URL.
        worker.postMessage({ type: 'load', modelId: cpuLane() ? wasmModelUrl(modelId) : modelId });
      }
      return new Promise(function (resolve, reject) {
        readyWaiters.push({ resolve: resolve, reject: reject });
      });
    });
  }

  // ── Wire helpers ─────────────────────────────────────────────────────────────────────
  var enc = new TextEncoder();

  function sse(obj) { return enc.encode('data: ' + JSON.stringify(obj) + '\n\n'); }

  function deltaChunk(text, thinking) {
    var delta = thinking ? { reasoning_content: text } : { content: text };
    return sse({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: delta }] });
  }

  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── /v1/chat/completions ─────────────────────────────────────────────────────────────
  function chatCompletions(options) {
    var body = {};
    try { body = JSON.parse(options && options.body ? options.body : '{}'); } catch (e) {}
    var messages = Array.isArray(body.messages) ? body.messages : [];
    var signal = options && options.signal;

    var stream = new ReadableStream({
      start: function (controller) {
        var closed = false;
        function close() {
          if (closed) return;
          closed = true;
          try { controller.enqueue(enc.encode('data: [DONE]\n\n')); } catch (e) {}
          try { controller.close(); } catch (e) {}
        }
        // An abort must reach the WORKER, not just drop the stream. Without the interrupt
        // the model keeps decoding into a reader nobody is holding — the tab stays hot and
        // the next turn queues behind a turn the user already cancelled.
        function onAbort() {
          if (worker) { try { worker.postMessage({ type: 'interrupt' }); } catch (e) {} }
          disarm();
          active = null;
          close();
        }
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Load the registry ALONGSIDE the model, not after it. The weights are a
        // multi-hundred-MB download; a 57 KB script fetched in series behind them would
        // add a round trip to the first turn for no reason.
        Promise.all([ensureReady(), loadTools()]).then(function (settled) {
          var toolApi = settled[1];
          active = {
            sawFirstToken: false,
            timer: null,
            onToken: function (text, thinking) {
              if (closed || !text) return;
              try { controller.enqueue(deltaChunk(text, thinking)); } catch (e) {}
            },
            onDone: close,
            onError: function (err) {
              // Surface the reason IN the stream rather than erroring the Response. Their
              // reader is already attached and mid-loop; rejecting here reads to the user as
              // "lost contact", which names the wrong thing. A visible sentence in the reply
              // is both honest and debuggable.
              if (!closed) {
                try { controller.enqueue(deltaChunk('\n\n[on-device model: ' + err.message + ']', false)); } catch (e) {}
              }
              close();
            },
          };
          active.timer = setTimeout(function () {
            if (!active || active.sawFirstToken) return;
            var a = active;
            active = null;
            teardown(new Error('the model stopped responding before its first token — the '
              + 'browser most likely ended the worker to reclaim memory. Try a smaller model.'));
            a.onError(new Error('no first token within ' + Math.round(FIRST_TOKEN_FAIL_MS / 1000) + 's'));
          }, FIRST_TOKEN_FAIL_MS);

          // TRANSLATE llama.cpp's CONVENTIONS, do not forward them.
          // GobboNet sends `max_tokens: -1`, which in llama.cpp means "unlimited, run to EOS".
          // Our worker takes a POSITIVE COUNT, so -1 asks it for minus-one tokens: it returns
          // `done` immediately having emitted nothing. Measured live 2026-08-15 — the turn
          // completed in 1.9s with a clean [DONE], no error, and an EMPTY assistant bubble.
          // That is the whole silent-empty-reply class in one integer, and it is invisible
          // from either side: their request is valid llama.cpp, our worker is behaving as
          // specified. Only the seam is wrong, which is exactly what an adapter is for.
          // A non-positive or absent value means "no caller limit" — omit the field and let
          // the worker apply its own default rather than inventing a ceiling here.
          var cap = Number(body.max_tokens);
          var req = {
            type: 'generate',
            messages: messages.map(function (m) {
              return { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') };
            }),
            temperature: body.temperature,
            topK: body.top_k,
            topP: body.top_p,
            repetitionPenalty: body.repeat_penalty,
          };
          if (isFinite(cap) && cap > 0) req.maxTokens = cap;
          // THE FIELD THAT WAS MISSING. The worker's tool loop is gated on exactly
          // this, so omitting it did not disable a feature loudly -- it produced a model
          // that answers every question about the present tense from priors, and says so
          // politely.
          var toolDefs = toolsForTurn(toolApi);
          if (toolDefs) {
            req.tools = toolDefs;
            req.context = toolContextForTurn();
          }
          worker.postMessage(req);
        }).catch(function (err) {
          if (!closed) {
            try { controller.enqueue(deltaChunk('[on-device model failed to load: ' + err.message + ']', false)); } catch (e) {}
          }
          close();
        });
      },
    });

    return Promise.resolve(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  }

  // ── The hook ─────────────────────────────────────────────────────────────────────────
  function pathOf(url) {
    try { return new URL(url, window.location.origin).pathname; }
    catch (e) { return String(url || ''); }
  }

  window.privacyFetch = function (url, options) {
    var p = pathOf(url);

    // Decline job mode the way the app already handles: 404 latches jobsAvailable=false.
    // Matches BOTH spellings of JOBS_URL (`LLAMA_URL + '/jobs'`): `/llm/jobs` when the page
    // is served, and a bare `/jobs` when LLAMA_URL is the absolute 127.0.0.1 form. Scoped to
    // the trailing segment so `/llm/jobs/<id>` (the DELETE ack) is declined too. The wide
    // shape is safe because only GobboNet's own calls come through privacyFetch.
    if (/(^|\/)jobs(\/[^/]*)?$/.test(p)) {
      return Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }));
    }
    // GobboNet polls /health every few seconds via checkConnection() (js/11-search.js:195)
    // and paints the whole header from it: 200 + {"status":"ok"} is "Connected", anything
    // else is a red "Error: HTTP nnn" and "OFFLINE — RUN LAUNCH.BAT". Passing this through
    // means the app truthfully reports itself offline while the on-device backend is sitting
    // right there — measured live, and the single most visible thing on the page.
    if (/\/health$/.test(p)) {
      // A real local node outranks the in-browser fallback — it's presumably bigger, and
      // it's the visitor's own hardware doing the work rather than a 3.8GB browser download.
      // Unless the user explicitly picked a WebGPU size in the model selector — see
      // preferLocalNode / handleSwapModel.
      if (preferLocalNode && localNode.base) {
        return Promise.resolve(jsonResponse({ status: 'ok', backend: 'awdk-local-node', base: localNode.base }));
      }
      // ANSWER HONESTLY rather than hardcoding ok. Without WebGPU this adapter cannot serve a
      // single token, and claiming "Connected" would move the failure to the first message,
      // where it reads as the model being broken instead of the browser being unsupported.
      //
      // 🚨 AND ANSWER THE QUESTION THAT WAS ASKED. This used to return `ok` for any browser
      // with `navigator.gpu` — honest about CAPABILITY, and read by the caller as READINESS.
      // checkConnection()'s own comment states the contract it assumes: "llama.cpp /health
      // returns {"status":"ok"} when model is loaded". So `ok` here means "weights are in",
      // and nothing weaker may claim it. Measured 2026-08-20: a first visit with an empty
      // cache showed a green CONNECTED dot before the consent dialog had even been answered.
      var phase = backendPhase();
      if (phase === 'unsupported') {
        return Promise.resolve(jsonResponse(
          { status: 'unavailable', reason: 'this browser exposes no WebGPU adapter' }, 503));
      }
      if (phase === 'ready') {
        return Promise.resolve(jsonResponse({ status: 'ok', backend: 'aitherium-bonsai-webgpu' }));
      }
      // 200 with a NON-ok status on purpose, for both 'loading' and 'idle'. A non-2xx here
      // makes GobboNet paint a red "Error: HTTP nnn" and "OFFLINE — RUN LAUNCH.BAT", which
      // is a different falsehood and a scarier one: the backend is not offline, it is
      // sitting right there waiting to be allowed. Upstream already renders exactly the
      // state we want from a 200 that is not `ok` — `label.textContent = ready ? 'Connected'
      // : 'Loading model...'` — and wrapCheckConnection() below corrects that one word for
      // the 'idle' case, where nothing is loading yet.
      return Promise.resolve(jsonResponse({
        status: phase === 'loading' ? 'loading' : 'idle',
        backend: 'aitherium-bonsai-webgpu',
        progress: loadPct,
      }));
    }
    if (/\/v1\/chat\/completions$/.test(p)) {
      // PASS THROUGH UNCHANGED — no max_tokens: -1 translation here. That translation exists
      // only because OUR worker takes a positive count; a real llama.cpp-shaped local server
      // already understands -1 as "unlimited" per its own convention, so rewriting it would be
      // undoing the very thing GobboNet correctly sent.
      if (preferLocalNode && localNode.base) {
        // STAMP THE CHOSEN MODEL. Without this the picker is a silent no-op on a node
        // serving more than one: selecting the second entry would leave `model` naming
        // the first, the request would succeed, and the answer would come from a model
        // the user did not choose — visibly working and quietly wrong, which is worse
        // than an error. Only the model field is rewritten; everything else passes
        // through untouched, including max_tokens: -1 (see below).
        options = withLocalModel(options);
        // FALL BACK TO WEBGPU, don't just reject. The poll that detected this node runs every
        // 4s; a node that crashes or is closed in between goes undetected until the next poll,
        // and a bare rejected fetch here would surface as GobboNet's own connection-error UI —
        // silently ignoring the in-browser model sitting right there ready to answer instead.
        if (isGateway(localNode.base)) options = withGatewayAuth(options);
        return origFetch(localNode.base + '/v1/chat/completions', options).catch(function (err) {
          console.log('[aither] local node request failed (' + (err && err.message || err) + ') — falling back to the in-browser model for this turn.');
          localNode.base = null; // force a fresh probe rather than repeating a dead route
          return chatCompletions(options);
        });
      }
      return chatCompletions(options);
    }
    if (/\/v1\/models$/.test(p)) {
      // Forward the REAL catalogue when a node is connected — "are the models selectable"
      // has to mean the node's actual models, not our one hardcoded in-browser id.
      if (preferLocalNode && localNode.base) {
        if (isGateway(localNode.base)) options = withGatewayAuth(options);
        return origFetch(localNode.base + '/v1/models', options).catch(function () {
          return jsonResponse({ object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'aitherium-bonsai' }] });
        });
      }
      return Promise.resolve(jsonResponse({
        object: 'list',
        data: [{ id: modelId, object: 'model', owned_by: 'aitherium-bonsai' }],
      }));
    }
    return origFetch(url, options);
  };

  // ── The model selector: header-model-select, wired for real ────────────────────────────
  // GobboNet's own model UI (js/02-model.js) never goes through privacyFetch — it calls the
  // global `fetch` directly against /active-model.json, /models-list.json, /swap-model and
  // /swap-status, a completely separate subsystem talking to launch.bat's companion
  // fileserver.ps1. Without this, those four calls hit the real (nonexistent) static paths,
  // 404, get silently swallowed ("file server may not be running"), and the header dropdown
  // is stuck on the ONE hardcoded fallback option: "Custom GGUF" — regardless of whether a
  // real local node is connected or which WebGPU size loaded. That is the whole reason the
  // selector looked fake even after the onramp itself was live and routing chat correctly.
  //
  // Every WebGPU-runnable size, matching apps/packages/awkit/src/webml/bonsai-models.ts.
  // Duplicated for the same reason LOCAL_NODE_BASES is: this file has no bundler and cannot
  // import that module. Keep the id/contextWindow values in step with it.
  // `sizeMb` is here so the consent dialog can print a NUMBER. The 2026-08-07 incident
  // ("8B, 1.1 GB, downloading unasked on page load") was filed as a model-picker bug because
  // the visitor was never told one. BCG007 diffs these against bonsai-models.ts.
  var WEBGPU_CATALOG = [
    { id: 'bonsai-1.7b', label: 'Bonsai 1.7B (in-browser)', contextWindow: 32768, sizeMb: 236 },
    { id: 'bonsai-4b', label: 'Bonsai 4B (in-browser)', contextWindow: 32768, sizeMb: 545 },
    { id: 'bonsai-8b', label: 'Bonsai 8B (in-browser)', contextWindow: 65536, sizeMb: 1104 },
    { id: 'bonsai-27b-text', label: 'Bonsai 27B (in-browser)', contextWindow: 262144, sizeMb: 3627 },
  ];
  function webgpuCatalogEntry(id) {
    for (var i = 0; i < WEBGPU_CATALOG.length; i++) if (WEBGPU_CATALOG[i].id === id) return WEBGPU_CATALOG[i];
    return null;
  }
  function prettifyId(id) {
    return String(id || 'model').replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // In-flight swap state, polled by GobboNet's own pollSwapStatus(). `phase` is 'loading',
  // 'ready' or 'error' — exactly the three values js/02-model.js checks for.
  var _swap = { phase: null, targetId: null, message: null };

  function buildModelsListPayload() {
    var models = [];
    var localActive = preferLocalNode && !!localNode.base;
    if (localNode.base) {
      // ONE ROW PER MODEL THE NODE SERVES. The value is `local-node:<id>` so a pick
      // names which one; the bare `local-node` value is still accepted by
      // handleSwapModel for anything holding a previously-rendered option.
      var ids = localNode.models.length ? localNode.models : [localNode.modelId];
      ids.forEach(function (id) {
        models.push({
          file: 'local-node:' + id, id: id, name: prettifyId(id) + ' (your machine)',
          family: 'custom', thinkingFormat: 'none',
          active: localActive && id === localNode.modelId,
        });
      });
    }
    WEBGPU_CATALOG.forEach(function (c) {
      // On a phone, a model over the tab budget is LABELLED, not hidden. Removing the
      // row would make a 27B this phone genuinely CAN run -- via phone.sh, over
      // loopback -- look like a model that does not exist, and the visitor would have
      // no way to learn the local path exists. A row that says why is a signpost; a
      // missing row is a lie. Picking one still refuses at requireConsent, which is
      // what carries the one-liner.
      var blocked = !!deviceRefusal(c.id);
      models.push({
        file: c.id, id: c.id, name: c.label + (blocked ? ' -- too big for a phone browser' : ''),
        family: 'bonsai', thinkingFormat: 'none', active: !localActive && modelId === c.id,
      });
    });
    return { models: models };
  }

  function buildActiveModelPayload() {
    if (preferLocalNode && localNode.base) {
      return {
        ggufFile: localNode.modelId, id: localNode.modelId, name: prettifyId(localNode.modelId) + ' (your machine)',
        family: 'custom', maxCtx: 131072, defaultCtx: 24576, thinkingFormat: 'none',
      };
    }
    var cat = webgpuCatalogEntry(modelId) || { id: modelId, label: prettifyId(modelId), contextWindow: 32768 };
    return {
      ggufFile: cat.id, id: cat.id, name: cat.label,
      family: 'bonsai', maxCtx: cat.contextWindow, defaultCtx: Math.min(cat.contextWindow, 24576), thinkingFormat: 'none',
    };
  }

  function handleSwapModel(options) {
    var body = {};
    try { body = JSON.parse(options && options.body ? options.body : '{}'); } catch (e) {}
    var file = body.file;

    if (file === 'local-node' || file.indexOf('local-node:') === 0) {
      var wantId = file.indexOf(':') > -1 ? file.slice(file.indexOf(':') + 1) : '';
      if (!localNode.base) {
        _swap = { phase: 'error', targetId: file, message: 'no local node is currently connected' };
      } else if (wantId && localNode.models.length && localNode.models.indexOf(wantId) === -1) {
        // Name the model rather than failing generically: the node is up, this
        // particular file is not one it serves, and those need different fixes.
        _swap = { phase: 'error', targetId: file, message: wantId + ' is not served by the node on ' + localNode.base };
      } else {
        preferLocalNode = true;
        if (wantId) localNode.modelId = wantId;
        _swap = { phase: 'ready', targetId: file, message: null };
      }
      return Promise.resolve(new Response('', { status: 202 }));
    }

    var cat = webgpuCatalogEntry(file);
    if (!cat) {
      _swap = { phase: 'error', targetId: file, message: 'unknown model id: ' + file };
      return Promise.resolve(new Response('', { status: 202 }));
    }

    // Refuse BEFORE `setModel` below, which tears down the running worker.
    // requireConsent would refuse this anyway, but only after the working model had
    // already been discarded -- so tapping the 27B on a phone would leave the visitor
    // with no model at all and an error, instead of the one they had and an
    // explanation. Refuse first; destroy nothing you are about to decline.
    var deviceNo = deviceRefusal(file);
    if (deviceNo) {
      _swap = { phase: 'error', targetId: file, message: deviceNo };
      return Promise.resolve(new Response('', { status: 202 }));
    }

    preferLocalNode = false;
    // Say WHY when the wait is a human decision rather than a download. `phase:'loading'`
    // with a null message renders as a bare "Swapping to ..." spinner, which is
    // indistinguishable from a stall — and the thing it is waiting for is a dialog the
    // visitor has to answer.
    _swap = {
      phase: 'loading',
      targetId: file,
      message: readConsent() ? null
        : 'waiting for your permission to download this model — answer the prompt on screen',
    };
    window.__aitherBonsaiAdapter.setModel(file); // tears down the current worker
    ensureReady().then(function () {
      if (_swap.targetId === file) _swap = { phase: 'ready', targetId: file, message: null };
    }).catch(function (err) {
      if (_swap.targetId === file) _swap = { phase: 'error', targetId: file, message: err && err.message || 'load failed' };
    });
    return Promise.resolve(new Response('', { status: 202 }));
  }

  var origWindowFetch = window.fetch;
  // Scoped to exactly these four pathnames — never the whole origin. The adapter's own
  // header comment already explains why privacyFetch was chosen over hooking window.fetch
  // globally (asset loads, everything else on the page); this hook keeps that same
  // discipline by matching on an exact allowlist and falling through to the real fetch for
  // anything else, including same-named paths on a different origin.
  // ── AitherSearch + local state sync ──────────────────────────────────────────────────
  // Upstream declares `SEARCH_PROXY_URL = origin + '/search'` and
  // `STATE_SYNC_URL = origin + '/state'` (js/02-model.js, js/06-state-sync.js) and calls
  // BOTH through the raw global `fetch` — not `privacyFetch`. This adapter proxied chat and
  // only chat, so on aitherium.com those two planes fell straight through to Pages:
  //   * `PUT /state` -> 405 Method Not Allowed, painted permanently as "sync error: HTTP 405"
  //   * `POST /search/web_search` -> reaching for a searxng sidecar on 127.0.0.1:11435 that
  //     does not exist here, while AitherSearch sits on the SAME ORIGIN at /api/search/web.
  // Reported 2026-08-20: "we've literally integrated aithersearch directly into the
  // aitherium.com living desktop". Correct — and nothing pointed at it.
  var STATE_KEY = 'aither-gobbonet-state';
  var STATE_MTIME_KEY = 'aither-gobbonet-state-mtime';

  /** 404 is upstream's FIRST-CLASS "no backup yet" (06-state-sync.js:229, :338) — it seeds
   *  from local state rather than erroring. So an empty store answers 404, never 200-empty. */
  function stateGet(withBody) {
    var blob = null;
    try { blob = window.localStorage.getItem(STATE_KEY); } catch (e) { /* storage denied */ }
    if (!blob) return new Response('', { status: 404, statusText: 'Not Found' });
    var mtime = '';
    try { mtime = window.localStorage.getItem(STATE_MTIME_KEY) || ''; } catch (e) {}
    if (!withBody) {
      return jsonResponse({ mtime: mtime, bytes: blob.length, backend: 'aither-local' });
    }
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-State-Mtime': mtime },
    });
  }

  function statePut(options) {
    try {
      window.localStorage.setItem(STATE_KEY, String((options && options.body) || ''));
      window.localStorage.setItem(STATE_MTIME_KEY, new Date().toISOString());
    } catch (e) {
      // Quota or private mode. Say so honestly — a silent success here would show a green
      // "synced" for a backup that does not exist.
      return jsonResponse({ error: 'local state store unavailable: ' + (e && e.message) }, 507);
    }
    return jsonResponse({ ok: true, backend: 'aither-local' });
  }

  /** GobboNet's contract and AitherSearch's are ALREADY identical — POST {query, max_results}
   *  -> {results:[{title,url,content}]} — so this is a re-address, not a translation. That is
   *  what makes the omission so cheap to have fixed and so easy to have missed. */
  // 🚨 SAME-ORIGIN IS NOT ENOUGH, and getting this wrong reproduced the exact bug this
  // adapter was fixing. `aitherium.com` is a GitHub PAGES STATIC EXPORT: it has no API
  // routes at all, so `POST /api/search/web` there answers **405 Not Allowed** — measured
  // live 2026-08-20, right after shipping the first version of this function. The container
  // hosts serve it fine (blog./portal. both 200), and proxy.ts's PUBLIC_PATHS entry that
  // made it look safe describes the CONTAINER; proxy.ts does not run on Pages.
  //
  // So: try same-origin, and fall back to a host that really serves the API. Measured that
  // the fallback is allowed — the container returns
  // `Access-Control-Allow-Origin: https://aitherium.com` with credentials on both the
  // preflight and the POST, so this is a supported cross-origin call, not a hope.
  //
  // The decision is LEARNED rather than keyed on a hostname list: a list goes stale the
  // first time a surface moves, and today already produced three "this host serves that"
  // assumptions that were wrong.
  var SEARCH_API_HOST = 'https://portal.aitherium.com';
  var _searchBase = null;   // null = not yet decided, '' = same-origin works

  function searchOnce(base, body) {
    return origWindowFetch(base + '/api/search/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body,
    });
  }

  function searchProxy(options) {
    var payload = {};
    try { payload = JSON.parse((options && options.body) || '{}'); } catch (e) {}
    var body = JSON.stringify({
      query: String(payload.query || ''),
      max_results: payload.max_results || 5,
    });

    var attempt = _searchBase === null
      ? searchOnce('', body).then(function (r) {
          // 405/404 means THIS ORIGIN does not serve API routes (the Pages case). Anything
          // else — including a 429 from the throttle — is a real answer from a real route.
          if (r.status !== 405 && r.status !== 404) { _searchBase = ''; return r; }
          _searchBase = SEARCH_API_HOST;
          return searchOnce(_searchBase, body);
        })
      : searchOnce(_searchBase, body);

    return attempt.catch(function (err) {
      // Upstream reads a non-OK as "search unavailable" and carries on; give it a parseable
      // body rather than a network rejection it logs as a crash.
      return jsonResponse({ error: 'AitherSearch unreachable: ' + (err && err.message) }, 502);
    });
  }

  window.fetch = function (url, options) {
    var p = pathOf(url);
    if (p === '/active-model.json') return Promise.resolve(jsonResponse(buildActiveModelPayload()));
    if (p === '/models-list.json') return Promise.resolve(jsonResponse(buildModelsListPayload()));
    if (p === '/swap-model') return handleSwapModel(options);
    if (p === '/swap-status') return Promise.resolve(jsonResponse(_swap));
    // AitherSearch, same origin, already integrated into the Living Desktop.
    if (p === '/search/health') return Promise.resolve(jsonResponse({ status: 'ok', backend: 'aithersearch' }));
    if (p === '/search/web_search') return searchProxy(options);
    // State sync, served locally instead of PUTting into a Pages route that answers 405.
    if (p === '/state') {
      var m = ((options && options.method) || 'GET').toUpperCase();
      if (m === 'PUT' || m === 'POST') return Promise.resolve(statePut(options));
      return Promise.resolve(stateGet(true));
    }
    if (p === '/state/info') return Promise.resolve(stateGet(false));
    // RAG embeddings. Upstream declares `EMBED_URL = origin + '/embed'` (02-model.js:391)
    // and posts to `/embed/v1/embeddings` (08-rag.js:189), expecting a sidecar on
    // 127.0.0.1:11436. There is NO same-origin embeddings route on this site, so this
    // answers honestly instead of letting the call fall through to Pages and fail as a
    // 404/405 that the RAG path swallows — which is how a knowledge feature becomes
    // silently inert while every surface looks fine. Found by the route-coverage test,
    // not by reading: it was the plane nobody had noticed.
    if (/^\/embed(\/|$)/.test(p)) {
      return Promise.resolve(jsonResponse({
        error: 'on-device RAG embeddings are not wired on this host yet',
      }, 501));
    }
    return origWindowFetch(url, options);
  };

  // ── Honest backend labelling ─────────────────────────────────────────────────────────
  // Upstream hardcodes "LLAMA-SERVER ONLINE" (13-dashboard.js:17), a
  // "llama.cpp - zero telemetry, fully offline" subtitle (13-dashboard.js:97) and the
  // padlock's title (12-render.js:23). None of that is true here: the tokens come from the
  // Bonsai worker in this tab, or from an awdk node on the visitor's own machine.
  //
  // Reported 2026-08-20: "it doesn't even support our awdk engine". The awdk lane has been
  // in this adapter all along (`localNode`); the UI simply never said so, and a header that
  // names the wrong engine is not cosmetic -- it is the page telling the visitor something
  // false about where their conversation is going.
  //
  // Fixed by wrapping the two GLOBALS that write those nodes, exactly as `privacyFetch` is
  // wrapped, because upstream is vendored and never edited (build-gobbonet.mjs). Wrapping
  // rather than one-shot patching is what survives a re-render: `renderLandingPage` rewrites
  // the whole landing surface on every thread change, and a DOM edit applied once is undone
  // the first time the visitor clicks HOME.
  /**
   * What is ACTUALLY true right now — the single source every status surface reads.
   *
   *   'node'        a real awdk node answered on loopback; it outranks the browser.
   *   'unsupported' this browser exposes no WebGPU adapter, so we can never serve a token.
   *   'ready'       the worker posted 'ready'; weights are in and a turn can start NOW.
   *   'loading'     the worker is spawned and fetching weights.
   *   'idle'        capable, nothing downloaded, nothing asked. THE FIRST-VISIT STATE, and
   *                 the one every surface used to render as 'ready'.
   *
   * Derived, never stored: `ready` and `worker` are set by the worker's own messages, so
   * this cannot drift from the thing it describes the way a second status flag would.
   */
  function backendPhase() {
    if (preferLocalNode && localNode.base) return 'node';
    if (typeof navigator === 'undefined') return 'unsupported';
    if (cpuLane() ? typeof WebAssembly === 'undefined' : !('gpu' in navigator)) return 'unsupported';
    if (ready && worker) return 'ready';
    if (worker) return 'loading';
    return 'idle';
  }

  function laneWord() { return cpuLane() ? 'CPU (phone-safe, slower)' : 'GPU'; }

  function describeBackend() {
    if (preferLocalNode && localNode.base) {
      return {
        pill: 'AWDK NODE ONLINE',
        privacy: 'awdk on your machine — inference never leaves your hardware',
        badgeTitle: 'awdk local node — inference runs on your own machine',
      };
    }
    var cat = webgpuCatalogEntry(modelId);
    var name = (cat && cat.label) ? cat.label.replace(/\s*\(in-browser\)\s*/, '') : 'Bonsai';
    var phase = backendPhase();

    // ── SAY WHICH PHASE WE ARE IN, not which model we WOULD run ────────────────────────
    // This block used to return the present-tense pill unconditionally, built from the
    // catalogue LABEL alone — no worker handle, no cache check, no consent check. So a
    // first-time visitor with nothing downloaded read "BONSAI 4B — RUNNING ON YOUR GPU"
    // above a green CONNECTED dot, and the consent dialog then asked to download 545 MB
    // of the thing the page had just said was already running. Reported 2026-08-20:
    // "why does it even give appearances like the model is already downloaded and setup".
    //
    // The failure was not a hardcoded lie — it was answering a DIFFERENT QUESTION than the
    // one the surface asks. "Which model is selected" is not "is a model loaded", and only
    // the second one may be written in the present tense.
    // No WebGPU adapter: this can never load here, so "READY TO LOAD" would be a promise the
    // browser cannot keep. Say the true thing and keep the onramp, which is the ONLY route
    // to a model on such a device — a real node on their own machine.
    if (phase === 'unsupported') {
      return {
        pill: 'NO WEBGPU IN THIS BROWSER',
        // The search disclosure survives every phase. Where a query GOES is true whether or
        // not a model can run here, and dropping it in one branch is how a privacy claim
        // quietly becomes conditional — an existing assertion pins exactly that.
        privacy: 'this browser exposes no WebGPU adapter, so nothing can run in this tab'
          + '; web search, when you use it, queries AitherSearch',
        badgeTitle: 'This browser exposes no WebGPU adapter, so no model can run in this tab.'
          + ' Web search, when you use it, queries AitherSearch.',
        onramp: ONRAMP_TEXT,
      };
    }
    if (phase !== 'ready') {
      var waiting = phase === 'loading'
        ? name.toUpperCase() + ' — LOADING' + (loadPct === null ? '…' : ' ' + loadPct + '%')
        // `sizeMb` is the SAME number the consent dialog quotes, read from the same
        // catalogue row, so the page cannot promise one size and ask for another.
        : name.toUpperCase() + ' — READY TO LOAD'
          + (cat && cat.sizeMb ? ' (' + cat.sizeMb + ' MB)' : '');
      return {
        pill: waiting,
        // FUTURE TENSE. The privacy promise is true of what will happen, and stating it
        // now is the point — it is what the visitor needs in order to answer the consent
        // dialog. Only the tense was wrong, never the claim.
        privacy: phase === 'loading'
          ? 'downloading to this browser — it will run in this tab on your ' + laneWord() + ', and your'
            + ' conversation stays on this device'
          : 'will run in this tab on your ' + laneWord() + ' once you allow it — your conversation stays'
            + ' on this device; web search, when you use it, queries AitherSearch',
        badgeTitle: name + ' has not been downloaded to this browser yet. When you allow'
          + ' it, it runs in this tab on your ' + laneWord() + ' and your conversation stays on this'
          + ' device. Web search, when you use it, queries AitherSearch.',
        onramp: ONRAMP_TEXT,
      };
    }
    return {
      pill: name.toUpperCase() + (cpuLane() ? ' — RUNNING ON YOUR CPU' : ' — RUNNING ON YOUR GPU'),
      // Deliberately NOT "fully offline". Since the search plane was pointed at AitherSearch,
      // a query you run DOES leave the device, and repeating upstream's absolute claim would
      // trade one false statement for another.
      privacy: 'runs in this tab on your ' + laneWord() + ' — your conversation stays on this device'
        + '; web search, when you use it, queries AitherSearch',
      badgeTitle: name + ' runs in this tab on your ' + laneWord() + '. Your conversation stays on this '
        + 'device. Web search, when you use it, queries AitherSearch.',
      // THE ONRAMP. The adapter has polled six loopback ports every 4s this whole time,
      // ready to hand the conversation to a real local node the moment one answers — and
      // a visitor who has never heard of adk has no way to learn that, so the capability
      // sat there being offered to nobody. Shown ONLY when no node was found: repeating it
      // to someone already running one is noise, and noise is how a hint stops being read.
      onramp: ONRAMP_TEXT,
    };
  }

  function relabelBackend() {
    try {
      var b = describeBackend();
      // 🚨 THE GUARD MUST MATCH OUR OWN OUTPUT TOO, or this runs exactly ONCE.
      // These tests existed to avoid clobbering unrelated nodes, and they only recognised
      // UPSTREAM's text — so the first relabel replaced "LLAMA-SERVER" with our pill and
      // every later call found no match and did nothing. That was harmless while the pill
      // was a constant; the moment it became a phase it would have frozen on whatever the
      // first paint said, which is the very bug this change exists to remove. Marking the
      // nodes we own is what makes the transition idle -> loading -> ready visible.
      // camelCase, NOT 'aither-backend-label'. A DOMStringMap key containing a dash
      // followed by a lowercase letter throws SyntaxError on assignment, and the
      // try/catch around this function swallowed it -- so the pill updated and the
      // subtitle, badge and header silently never did. Caught by the suite, not by
      // reading: the page looked half-right and threw nothing.
      var OURS = 'aitherBackendLabel';
      var pill = document.querySelector('.landing-status-ok');
      if (pill && (/LLAMA-SERVER/i.test(pill.textContent || '') || pill.dataset[OURS] === '1')) {
        pill.innerHTML = '&#9679; ' + b.pill;
        pill.dataset[OURS] = '1';
      }
      var subs = document.querySelectorAll('.landing-subtitle');
      for (var i = 0; i < subs.length; i++) {
        if (/llama\.cpp/i.test(subs[i].textContent || '') || subs[i].dataset[OURS] === '1') {
          subs[i].innerHTML = '&#128274; ' + b.privacy;
          subs[i].dataset[OURS] = '1';
        }
      }
      var badge = document.getElementById('privacy-badge');
      if (badge && (/llama\.cpp/i.test(badge.title || '') || badge.dataset[OURS] === '1')) {
        badge.title = b.badgeTitle;
        badge.dataset[OURS] = '1';
      }
      relabelConnection();
      renderSignIn(subs);
      renderOnramp(b.onramp, subs);
    } catch (e) { /* labelling must never break the page it is describing */ }
  }

  // Put the onramp under the landing subtitle, and TAKE IT AWAY the moment a node
  // appears. Both directions matter: this runs on every landing render and on every
  // detection change, so a stale "install adk" line sitting above a working local
  // node would be actively wrong rather than merely redundant.
  /**
   * The sign-in line. Shown ONLY when the gateway is the connected node AND something is
   * actually locked behind a tier.
   *
   * Both halves matter. Offering sign-in when nothing would change is an invitation to do
   * work for no result; offering it when the gateway is not reachable is worse, because
   * the flow cannot even start. And once signed in the line becomes a sign-OUT, because a
   * control with no way back is how a visitor ends up unable to explain what their browser
   * is holding.
   */
  var SIGNIN_LINK_ID = 'aither-signin-line';

  function renderSignIn(subs) {
    var existing = document.getElementById(SIGNIN_LINK_ID);
    if (!isGateway(localNode.base)) {
      if (existing) existing.remove();
      return;
    }
    var anchor = subs && subs.length ? subs[subs.length - 1] : null;
    if (!anchor || !anchor.parentNode) return;
    var signedIn = !!readToken();
    // `lockedCount` is derived from the LAST probe, so "nothing is locked" is a measured
    // statement rather than an assumption.
    if (!signedIn && !localNode.lockedCount) {
      if (existing) existing.remove();
      return;
    }
    var el = existing || document.createElement('div');
    if (!existing) {
      el.id = SIGNIN_LINK_ID;
      el.className = 'landing-subtitle';
      el.style.cssText = 'opacity:.72;font-size:.85em;margin-top:.4em';
      anchor.parentNode.insertBefore(el, anchor.nextSibling);
    }
    el.textContent = '';
    var btn = document.createElement('button');
    btn.style.cssText = 'background:none;border:1px solid currentColor;border-radius:6px;'
      + 'padding:.2rem .6rem;color:inherit;font:inherit;cursor:pointer';
    if (signedIn) {
      btn.textContent = 'Sign out of the fleet';
      btn.onclick = function () {
        forgetToken();
        probeLocalNode().catch(function () {}).then(relabelBackend);
      };
      el.appendChild(document.createTextNode('Signed in — the fleet’s models are available. '));
    } else {
      btn.textContent = 'Sign in';
      btn.onclick = function () {
        btn.disabled = true;
        signInToFleet().catch(function (e) {
          // SAY WHY. A button that goes quiet is indistinguishable from one that did
          // nothing, and this flow has several honest failure modes (expired code,
          // refused approval, gateway gone).
          el.appendChild(document.createTextNode(' — ' + (e && e.message || 'sign-in failed')));
        }).then(function () { btn.disabled = false; });
      };
      el.appendChild(document.createTextNode(
        localNode.lockedCount + ' more model' + (localNode.lockedCount === 1 ? '' : 's')
        + ' on this machine need an account. '));
    }
    el.appendChild(btn);
  }

  var ONRAMP_ID = 'aither-onramp-hint';
  function renderOnramp(text, subs) {
    var existing = document.getElementById(ONRAMP_ID);
    if (!text) {
      if (existing) existing.remove();
      return;
    }
    var anchor = subs && subs.length ? subs[subs.length - 1] : null;
    if (!anchor || !anchor.parentNode) return;
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    var el = document.createElement('div');
    el.id = ONRAMP_ID;
    el.className = 'landing-subtitle';
    el.style.cssText = 'opacity:.62;font-size:.85em;margin-top:.6em';
    el.textContent = text;
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }

  /**
   * The header word, which is the loudest status on the page.
   *
   * checkConnection() writes `status-label` straight from /health: `ok` -> "Connected",
   * any other 200 -> "Loading model...". That second string is right for 'loading' and
   * WRONG for 'idle' — nothing is loading before you allow it, and "Loading model..."
   * on a first visit is the same false-progress claim as the old green CONNECTED.
   *
   * Corrected here rather than by returning a different /health shape, because upstream
   * only branches two ways on that response and a third state has nowhere to land in it.
   */
  function relabelConnection() {
    try {
      var label = document.getElementById('status-label');
      var dot = document.getElementById('status-dot');
      if (!label) return;
      var phase = backendPhase();
      if (phase === 'idle') {
        label.textContent = 'Not loaded';
        label.title = 'The model has not been downloaded to this browser yet.';
        // The dot is upstream's "we reached a backend" light and /health really did answer,
        // so it stays lit — but not GREEN, which on this page means ready to serve.
        if (dot) dot.classList.remove('connected');
      } else if (phase === 'loading') {
        label.textContent = loadPct === null ? 'Loading model…' : 'Loading model… ' + loadPct + '%';
        if (dot) dot.classList.remove('connected');
      }
      // 'ready', 'node' and 'unsupported' are left to upstream: its own two branches say
      // exactly the right thing for those, and overwriting them would be gratuitous.
    } catch (e) { /* labelling must never break the page it is describing */ }
  }

  /** Wrap a global so upstream's own render keeps working and we correct it afterwards. */
  function wrapGlobal(name) {
    var orig = window[name];
    if (typeof orig !== 'function') return false;
    window[name] = function () {
      var out = orig.apply(this, arguments);
      relabelBackend();
      return out;
    };
    return true;
  }

  var _labelled = wrapGlobal('renderLandingPage');
  wrapGlobal('updatePrivacyBadge');
  // checkConnection() runs on a POLL, so it is the one writer that will overwrite our
  // header text seconds after we set it. Wrapping it is what makes the correction stick;
  // relabelBackend() alone would be right until the next tick and then silently wrong.
  // It is async, so correct on the microtask AFTER it settles rather than on return —
  // wrapGlobal's synchronous relabel would run before the fetch resolves and be undone.
  (function () {
    var orig = window.checkConnection;
    if (typeof orig !== 'function') {
      console.warn('[aither] checkConnection not found - the header may still claim Connected');
      return;
    }
    window.checkConnection = function () {
      var out = orig.apply(this, arguments);
      if (out && typeof out.then === 'function') out.then(relabelConnection, relabelConnection);
      else relabelConnection();
      return out;
    };
  }());
  if (!_labelled) {
    // The anchor moved upstream. Say so once rather than silently leaving the page claiming
    // llama.cpp -- an unlabelled backend is a wrong label, not a missing feature.
    console.warn('[aither] renderLandingPage not found - GobboNet may still be claiming llama.cpp');
  }
  relabelBackend();

  // ── The try-before-you-download bar ────────────────────────────────────────────────
  //
  // gobbonet.aitherium.com is the public demo. Before this, the page offered no route to
  // the real thing: no release link, no installer, no repo -- the only mention of the
  // phone bootstrap lived inside an ERROR string, so the only visitors who ever saw a way
  // to run it properly were the ones who had already hit a failure.
  //
  // It REPORTS the engine rather than asserting one. Three different things can answer a
  // turn here -- a real local node on 127.0.0.1, the in-browser worker, or the fleet
  // gateway -- and "Running in your browser" printed while the fleet is answering is the
  // exact dishonesty the adapter already guards elsewhere ("this chat is NOT running on
  // your GPU"). A privacy claim that is sometimes false is worse than no claim.
  //
  // It installs ONLY where surfaceRefusal() is null. On a refused surface the brain cannot
  // load, so a bar boasting about local inference would be advertising a thing that page
  // is forbidden to do.
  var CTA_ID = 'aither-gobbonet-cta';
  var CTA_SHIM_ID = 'aither-gobbonet-cta-shim';
  var CTA_DISMISS_KEY = 'aitheros-gobbonet-cta-dismissed';
  var CTA_RELEASES = 'https://github.com/ElodineOfficial/GobboNet/releases/latest';
  var CTA_SOURCE = 'https://github.com/ElodineOfficial/GobboNet';
  // The project's own home, which is NOT the repo: release notes, the community, the
  // story. A developer wants the second; everyone else wants the first, and sending
  // everyone to a file tree is how an upstream author's own audience never reaches them.
  var CTA_HOME = 'https://goblincorps.com/gobbonet';
  var _ctaLabel = null;
  var _ctaTimer = null;
  var _ctaResize = null;

  function ctaDismissed() {
    // localStorage throws outright in some embedded/preview contexts, and returns null in a
    // fresh private window. Both mean "not dismissed", never "crash the demo".
    try { return localStorage.getItem(CTA_DISMISS_KEY) === '1'; } catch (e) { return false; }
  }

  /** Which engine is really answering, as {text, short, tone} -- never a guess.
   *
   *  `short` is not a truncation of `text`; it is written for the width. An ellipsised
   *  desktop sentence on a phone ("Live demo — runs in your browser. No ac…") spends a
   *  whole row saying less than a five-word line would. */
  function ctaState() {
    if (localNode.base && preferLocalNode) {
      if (isGateway(localNode.base)) {
        return { tone: '#fca5a5',
                 text: 'Answering from Aitherium’s servers — not from this device',
                 short: 'On Aitherium’s servers' };
      }
      return { tone: '#86efac',
               text: '⚡ Running on YOUR machine — '
                     + (localNode.modelId || 'your own backend'),
               short: '⚡ On YOUR machine' };
    }
    if (ready) {
      return { tone: '#5eead4',
               text: '⚡ Running in YOUR browser — nothing leaves this tab',
               short: '⚡ In YOUR browser' };
    }
    return { tone: '#b8b8c8',
             text: 'Live demo — runs in your browser. No account, nothing uploaded.',
             short: 'Live demo — in your browser' };
  }

  /** The width below which the bar uses its compact form. Matches the media query. */
  var CTA_NARROW = 720;
  function ctaIsNarrow() {
    try { return window.innerWidth < CTA_NARROW; } catch (e) { return false; }
  }

  var CTA_CSS_ID = 'aither-gobbonet-cta-css';
  function ensureCtaCss() {
    if (document.getElementById(CTA_CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CTA_CSS_ID;
    // A stylesheet rather than inline styles for exactly one reason: a media query cannot
    // be expressed inline, and the phone layout is the one that was wrong.
    st.textContent =
      '#' + CTA_ID + '{position:fixed;top:0;left:0;right:0;z-index:99997;display:flex;'
      + 'align-items:center;gap:.5rem;flex-wrap:wrap;padding:.35rem .7rem;'
      + 'background:#0b0b12;border-bottom:1px solid #2a2a3a;color:#e8e8f0;'
      + 'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}'
      + '#' + CTA_ID + ' .agn-msg{min-width:0;overflow:hidden;text-overflow:ellipsis;'
      + 'white-space:nowrap;flex:1 1 auto}'
      + '#' + CTA_ID + ' .agn-act{display:flex;align-items:center;gap:.4rem;flex:0 0 auto}'
      + '#' + CTA_ID + ' a,#' + CTA_ID + ' button{white-space:nowrap}'
      + '#' + CTA_ID + ' .agn-credit{color:#8a8a9a;white-space:nowrap}'
      + '@media (max-width:' + (CTA_NARROW - 1) + 'px){'
      + '#' + CTA_ID + '{font-size:12px;padding:.3rem .5rem;gap:.35rem}'
      + '#' + CTA_ID + ' .agn-msg{flex:1 1 100%}'
      + '#' + CTA_ID + ' .agn-act{flex:1 1 100%;justify-content:space-between}'
      + '#' + CTA_ID + ' .agn-act{flex-wrap:wrap}'
      + '#' + CTA_ID + ' .agn-credit{font-size:11px;flex:1 1 100%;order:9;'
        + 'white-space:normal}'
      + '}';
    document.head.appendChild(st);
  }

  function ctaButton(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'background:none;border:1px solid #2a2a3a;color:#e8e8f0;'
      + 'border-radius:6px;padding:.15rem .55rem;cursor:pointer;font:inherit;white-space:nowrap';
    b.onclick = onClick;
    return b;
  }

  /** The "run it yourself" panel: what to do on a desktop, and what to do on a phone.
   *
   *  Deliberately NOT phone-only, which is what it was first. The discovery message that
   *  matters most -- this page routes to a model you are ALREADY serving on loopback --
   *  was hidden behind a button saying "On your phone", so the most receptive visitor
   *  imaginable (someone with llama.cpp already running) could not discover it.
   */
  function showPhoneRoute() {
    var existing = document.getElementById('aither-cta-phone');
    if (existing) { existing.remove(); return; }
    var box = document.createElement('div');
    box.id = 'aither-cta-phone';
    box.style.cssText = 'position:fixed;z-index:99997;left:50%;transform:translateX(-50%);'
      // WIDTH, not just max-width: once the <pre> was allowed to wrap, a max-only box
      // shrank to its smallest wrappable content -- 180px wide and 771px tall at 360px.
      + 'width:min(38rem,94vw);max-width:min(38rem,94vw);box-sizing:border-box;'
      + 'background:#0b0b12;color:#e8e8f0;border:1px solid #2a2a3a;'
      + 'border-radius:10px;padding:1rem;font:13px/1.6 ui-monospace,monospace;'
      + 'box-shadow:0 10px 30px rgba(0,0,0,.6)';
    box.style.top = (ctaHeight() + 8) + 'px';

    // ── already running something? ────────────────────────────────────────────────────
    // No install, no account, no allegiance. This is a statement of what the page already
    // does, which is the least pushy form of adoption there is. awdk is ONE of four names
    // and is not the recommendation -- "anything OpenAI-compatible" is.
    var h0 = document.createElement('strong');
    h0.textContent = 'Already serving a model on this machine?';
    var p0 = document.createElement('p');
    p0.style.cssText = 'margin:.5rem 0 1rem;color:#b8b8c8';
    p0.textContent = 'Nothing to configure — this page looks for one on 127.0.0.1 and uses '
      + 'it instead of the browser model. llama.cpp, Ollama-style servers, awnode, awdk: '
      + 'anything that speaks the OpenAI chat API.';
    box.appendChild(h0);
    box.appendChild(p0);

    var h = document.createElement('strong');
    h.textContent = 'On a phone';
    var p = document.createElement('p');
    p.style.cssText = 'margin:.5rem 0;color:#b8b8c8';
    p.textContent = 'In Termux or the Android Linux Terminal. This serves a model on '
      + '127.0.0.1 and this page picks it up by itself — no settings to change. '
      + 'The bootstrap is Aitherium’s; GobboNet itself is Elodine’s, MIT licensed.';
    var pre = document.createElement('pre');
    pre.textContent = PHONE_BOOTSTRAP;
    // WRAP, do not scroll. This block's own copy says a command you cannot read
    // before running is one you should not run -- and at 360px the scrolling
    // version cut it at "phone.s", which is exactly that failure.
    pre.style.cssText = 'margin:0;padding:.6rem;background:#05050a;border:1px solid #2a2a3a;'
      + 'border-radius:6px;color:#5eead4;white-space:pre-wrap;word-break:break-all';
    var copy = ctaButton('Copy', function () {
      // Clipboard is permission-gated and absent over plain http. Say which happened
      // rather than leaving a button that silently does nothing.
      var ok = function () { copy.textContent = 'Copied'; };
      var no = function () { copy.textContent = 'Select and copy manually'; };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(PHONE_BOOTSTRAP).then(ok, no);
        } else { no(); }
      } catch (e) { no(); }
    });
    copy.style.marginTop = '.6rem';
    var close = ctaButton('Close', function () { box.remove(); });
    close.style.cssText += ';margin-left:.4rem';
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(pre);
    box.appendChild(copy);
    box.appendChild(close);
    document.body.appendChild(box);
  }

  function ctaHeight() {
    var el = document.getElementById(CTA_ID);
    return el ? Math.ceil(el.getBoundingClientRect().height) : 0;
  }

  /** Shrink #app by the bar's REAL measured height.
   *
   *  #app is `height:100dvh; overflow:hidden`, a locked full-viewport shell, so a fixed bar
   *  covers its header with nothing able to scroll out from under it. The height is measured
   *  rather than hardcoded because the bar wraps to two lines on a narrow phone, where a
   *  constant would be wrong by exactly the amount that hides the chat input.
   */
  function applyCtaShim() {
    var h = ctaHeight();
    var style = document.getElementById(CTA_SHIM_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = CTA_SHIM_ID;
      document.head.appendChild(style);
    }
    style.textContent = '#app{height:calc(100dvh - ' + h + 'px);'
      + 'height:calc(100vh - ' + h + 'px);margin-top:' + h + 'px}';
  }

  function removeCta() {
    var el = document.getElementById(CTA_ID);
    if (el) el.remove();
    var shim = document.getElementById(CTA_SHIM_ID);
    if (shim) shim.remove();
    var phone = document.getElementById('aither-cta-phone');
    if (phone) phone.remove();
    if (_ctaTimer) { clearInterval(_ctaTimer); _ctaTimer = null; }
    if (_ctaResize) { window.removeEventListener('resize', _ctaResize); _ctaResize = null; }
    var css = document.getElementById(CTA_CSS_ID);
    if (css) css.remove();
  }

  function paintCta() {
    var bar = document.getElementById(CTA_ID);
    if (!bar) return;
    var st = ctaState();
    var want = ctaIsNarrow() ? st.short : st.text;
    if (want === _ctaLabel) return;   // only touch the DOM when the truth changed
    _ctaLabel = want;
    var msg = bar.querySelector('.agn-msg');
    if (msg) { msg.textContent = want; msg.style.color = st.tone; }
    applyCtaShim();
  }

  function installCta() {
    if (ctaDismissed()) return;
    if (surfaceRefusal()) return;          // a refused surface may not boast about inference
    if (document.getElementById(CTA_ID)) return;
    if (!document.body) return;

    ensureCtaCss();
    var bar = document.createElement('div');
    bar.id = CTA_ID;

    var msg = document.createElement('span');
    msg.className = 'agn-msg';
    msg.textContent = '';
    bar.appendChild(msg);

    // One row for the actions. The old `flex:1 1 auto` spacer pushed each item onto its
    // own line as soon as the bar wrapped -- four rows on a 360px phone.
    var act = document.createElement('span');
    act.className = 'agn-act';
    bar.appendChild(act);

    var dl = document.createElement('a');
    dl.href = CTA_RELEASES;
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.textContent = 'Download the real thing ↗';
    dl.title = 'Official GobboNet release from ElodineOfficial/GobboNet';
    dl.style.cssText = 'color:#5eead4;text-decoration:none;border:1px solid #2a2a3a;'
      + 'border-radius:6px;padding:.15rem .55rem;white-space:nowrap';
    act.appendChild(dl);

    act.appendChild(ctaButton('Run it yourself', showPhoneRoute));

    // Attribution, not a footnote. This is Elodine's app under MIT; we vendor it verbatim
    // and host a demo of it. The credit is in the bar itself rather than an About dialog
    // nobody opens, and it names the author before it names either link.
    var credit = document.createElement('span');
    credit.className = 'agn-credit';
    credit.appendChild(document.createTextNode('GobboNet by '));

    var home = document.createElement('a');
    home.href = CTA_HOME;
    home.target = '_blank';
    home.rel = 'noopener noreferrer';
    home.textContent = 'Elodine';
    home.title = 'GobboNet is built by Elodine / GoblinCorps and is MIT licensed';
    home.style.cssText = 'color:#b8b8c8;text-decoration:underline';
    credit.appendChild(home);

    credit.appendChild(document.createTextNode(' · '));

    var src = document.createElement('a');
    src.href = CTA_SOURCE;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = 'source ↗';
    src.style.cssText = 'color:#b8b8c8;text-decoration:none';
    credit.appendChild(src);

    act.appendChild(credit);

    var x = ctaButton('×', function () {
      try { localStorage.setItem(CTA_DISMISS_KEY, '1'); } catch (e) {}
      removeCta();
    });
    x.setAttribute('aria-label', 'Dismiss');
    act.appendChild(x);

    document.body.appendChild(bar);
    _ctaLabel = null;
    paintCta();
    // The engine can change without a page load -- a local node appears on the next poll,
    // or the worker finishes loading -- so the bar re-reads state instead of freezing
    // whatever was true at boot. paintCta() is a no-op unless the text actually changed.
    _ctaTimer = setInterval(paintCta, 2000);
    // Rotating a phone crosses the narrow threshold, and a bar still sized for the other
    // orientation is the same defect this compaction exists to fix. The shim height is
    // re-measured too, since wrapping changes it.
    _ctaResize = function () { _ctaLabel = null; paintCta(); };
    window.addEventListener('resize', _ctaResize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installCta, { once: true });
  } else {
    installCta();
  }

  window.__aitherBonsaiAdapter = {
    version: 1,
    get modelId() { return modelId; },
    /** Switch size. Tears the worker down so the next turn loads the new weights. */
    setModel: function (id) {
      if (!id || id === modelId) return;
      modelId = id;
      teardown(new Error('switching model'));
    },
    get ready() { return ready; },
    /** The awdk onramp: null when running in-browser, the base URL when a real local
     *  node (awnode/awdk/llama-server) was detected and chat is routed there instead. */
    get localNodeBase() { return localNode.base; },
    /** The demo CTA bar, so a test can assert its state text rather than its pixels. */
    ctaState: ctaState,
    installCta: installCta,
    removeCta: removeCta,
  };

  console.log('[aither] Bonsai adapter active — GobboNet is running on this device\'s GPU'
    + ' (or, once a local node is detected, on your own awdk backend).');
})();
