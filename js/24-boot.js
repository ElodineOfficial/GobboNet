/* @gobbonet-split js/24-boot.js
   Moved verbatim from chat.html lines 12144-12289.
   boot, page lifecycle, all addEventListener wiring
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   BOOT
================================================================ */
// Storage is now async (IndexedDB), so everything that reads `state` for the
// first paint must wait until the backend is opened, migrated if needed, and
// `state` is populated. The whole boot tail therefore lives inside this awaited
// IIFE. The landing markup stays on screen until render() runs — the IDB open
// + read is fast but not zero.
window.GobboNet.ready = (async function boot() {
  await loadState();

  // The [ui] presets from gobbonet.toml. Awaited rather than fired and
  // forgotten: on a device with no settings of its own these become the
  // starting values, and that has to happen before the first render or the
  // user watches the page repaint itself. It is one small same-origin request
  // and it cannot throw — a server too old to have the route, or a page opened
  // from file://, simply has no presets.
  await loadServerPresets();
  seedSettingsFromServerPresets(hadOwnSettings);

  // Resolve server state before extensions, first paint or startup saves can
  // observe the temporary default Assistant. No reload/storage handshake.
  await checkServerStateOnBoot();
  const initialStateError = stateSync.status === 'error' ? stateSync.lastError : null;
  // Pending replies still resume in the background; readiness concerns the
  // initial state and UI, not completion of a possibly long generation.
  if (!initialStateError) {
    ensureSyncLedger().then(() => reconcileWithServer({ reason: 'boot' })).catch(() => {})
      .then(() => resumePendingJobs()).catch(() => {})
      .then(() => { _appBooted = true; });
  } else {
    // A failed state check pauses SYNC -- no ledger seeding or reconcile, which
    // could upload on the strength of a request that did not succeed. It must
    // not also drop reply recovery: pending replies live on /llm/jobs, not
    // /state, and 1.7.5 resumed them after this check whatever its outcome. A
    // reply that finished while the page was closed is otherwise not collected
    // until a later wake event, and one still running is not re-attached.
    Promise.resolve().then(() => resumePendingJobs()).catch(() => {})
      .then(() => { _appBooted = true; });
  }
  loadActiveModel().then(loadModelsList); // fetch model info + populate header dropdown

  // Always open on the landing page — threads are accessible from the sidebar.
  // This fixes mobile "no input visible" on first load and gives the dashboard
  // a consistent entry point. The active thread is preserved in state for quick
  // return but we don't auto-resume it on load.
  state.activeThreadId = null;
  // On mobile, always start with sidebar closed.
  if (window.innerWidth <= 700) {
    state.sidebarOpen = false;
  }
  searchEnabled = state.searchEnabled || false;
  document.getElementById('search-toggle').classList.toggle('active', searchEnabled);
  setupInput();
  applyExtensions(); // Apply any saved CSS/JS extensions
  // Load the active character's own code, if it has any and it is
  // switched on. Must come after state is restored and before render.
  try { applyCardCode(); } catch (e) { console.error('[card-code] boot:', e); }
  applyAvatarScale(); // restore saved avatar size preference

  // Load default characters from JSON, then render the landing page.
  // fetch() works when served via launch.bat; fails silently on file:// (no CORS).
  let chars = [];
  try {
    const r = await fetch('default-characters.json');
    if (r.ok) chars = await r.json();
  } catch (_) { /* file:// or missing file — render with whatever defaults exist */ }
  if (Array.isArray(chars)) defaultCharacters = chars;
  render();

  scrollToBottom();
  attachScrollPinTracking();
  applyActiveCardBackground();

  // One-time notice: 1.5.9 stopped loading remote images by default, and a card
  // that relied on one now shows a letter instead. Say so once, rather than
  // letting it read as a bug. The flag is set whether or not anything was
  // found, so this never fires twice.
  try {
    if (!state.settings.remoteImageNoticeSeen) {
      const affected = []
        .concat(state.characterCards || [], state.personaCards || [])
        .filter(c => c && (isSuppressedRemoteImage(c.avatar) || isSuppressedRemoteImage(c.background)));
      if (affected.length) {
        alert(
          'Heads up \u2014 ' + affected.length + ' of your character' +
          (affected.length === 1 ? '' : 's') + ' uses a picture stored on the web ' +
          'rather than saved into the card.\n\n' +
          'GobboNet no longer loads those by default, because fetching one tells ' +
          'that website your IP address. Those characters will show a letter ' +
          'instead of their picture for now.\n\n' +
          'Nothing was deleted \u2014 the addresses are still on the cards. To load ' +
          'them again, turn on "Allow remote images" in Settings.'
        );
      }
      state.settings.remoteImageNoticeSeen = true;
      // After a failed state check nothing may be pushed, but the flag must
      // still reach this device's storage: a thread-only checkpoint (what
      // skipServerSchedule alone means on IndexedDB) does not write settings,
      // so the one-time alert above would come back on every boot.
      saveState(initialStateError ? { localOnly: true } : {});
    }
  } catch (e) { console.error('[remote-images] notice:', e); }
  updateSchedCount();
  checkConnection().then(() => {
    // Re-render landing page after connection check so status pill updates.
    // Same transient-input guard as the interval below — this one-shot is not
    // instant (it awaits a /health fetch that can hang when llama-server is
    // down), so a fast click on +FOLDER can land inside the pending window and
    // get wiped when it resolves. Narrow, but the identical bug.
    if (document.querySelector('.new-folder-input, .rename-input')) return;
    const title = document.getElementById('thread-title');
    if (title.textContent === 'GOBBONET') render();
  });
  setInterval(() => {
    checkConnection().then(() => {
      // Yield to an in-progress sidebar edit. startNewFolder() (js/12-render.js)
      // and the two rename paths build a REAL <input> and parent it inside
      // #thread-list; renderSidebar() rebuilds that container wholesale from a
      // template string (js/12-render.js:345). Re-rendering underneath the user
      // therefore deletes the box they are typing into, mid-keystroke — nothing
      // to do with focus or blur, it is a DOM teardown.
      //
      // This bites only on a clean install because the GOBBONET title check
      // below is what gates the re-render: with no threads you never leave the
      // landing page, so it stays true and this fires every 5s forever.
      //
      // The guard sits AFTER the await, not around it, on purpose: the poll
      // itself must keep running. checkConnection() writes the header status
      // dot and label directly (js/11-search.js:195-219), so the pill still
      // updates live while you type. The only thing deferred is the landing
      // page repaint, which is cosmetic and lands on the next tick.
      if (document.querySelector('.new-folder-input, .rename-input')) return;
      const title = document.getElementById('thread-title');
      if (title.textContent === 'GOBBONET') render();
    });
  }, 5000);
  // Scheduler timer — checks every 30 seconds
  setInterval(checkSchedules, 30000);
  return { ok: !initialStateError, error: initialStateError, sync: syncTargetLabel() };
})().catch(error => {
  console.error('[boot] Startup failed:', error);
  return { ok: false, error: error.message, sync: syncTargetLabel() };
});

/* ================================================================
   PAGE-LIFECYCLE PERSISTENCE

   Historical context: these handlers were born when the browser owned
   the streaming fetch, so a hidden/torn-down page could genuinely LOSE
   the in-flight reply (on mobile the socket died within seconds).

   With detached generation jobs, the server-side spool is the source
   of truth and resume replays it verbatim — navigation no longer
   threatens the reply. The handlers stay for three cheaper reasons:
   the legacy direct-stream path (file://, old fileserver) still needs
   them, the pendingJob breadcrumb should hit disk before teardown, and
   a flushed partial keeps sidebar previews honest while away.

   visibilitychange→hidden: fires on every tab/app switch, the earliest
   reliable "user left" signal on mobile. Local save only (no beacon), and
   only while generating — when idle, localStorage is already current (every
   state mutation saves), so the only thing that can be lost is in-flight
   streaming progress. Skipping the idle case avoids re-serializing a
   multi-MB blob on every routine tab toggle.

   pagehide: fires on real navigation, tab close, and bfcache entry. Local
   save AND a keepalive push of whatever conversations actually moved, when
   the state is settled, so a completed turn reaches the server backup even if
   the user navigates inside the debounce window. (beforeunload/unload are
   deliberately not used — they're unreliable on mobile and disqualify the
   page from bfcache.) This was a sendBeacon of the entire history until the
   per-conversation routes landed; sendBeacon cannot carry an If-Match header,
   which made it the last writer in the system that could still flatten
   another device's chats. See flushBeforeExit in js/06-state-sync.js.

   ---- The return trip (handleAppWake) ----
   The handlers above cover leaving; these cover coming BACK — the half
   that used to be missing. Four signals, one handler:
     visibilitychange→visible / pageshow / focus — the user returned
       (app switch back, bfcache restore, window refocus);
     online — connectivity returned while the page was up.
   On any of them: parked poll sleeps resolve immediately (an attached
   generation catches up NOW instead of whenever the throttled timer
   lands), the header status dot refreshes (its 5s interval was throttled
   while hidden), and — when idle — resumePendingJobs() re-follows any
   breadcrumbs. That last one is the real win: it revives generations
   whose poll loop gave up as 'unreachable' during a Wi-Fi blip or server
   restart (previously dead until a manual reload), and it folds in
   replies that finished while away in OTHER threads after a bfcache
   restore, where no boot pass runs.
   Guards: _appBooted (the boot pass owns the first resume — resuming
   against a state blob checkServerStateOnBoot may be about to replace
   would stream into thread objects about to be swapped out), a 1s
   cooldown (the signals burst together on return), and never while a
   generation is attached (a resume pass sets currentJob; clobbering the
   live one would point the Stop button at the wrong job).
================================================================ */
let _lastWakeResumeAt = 0;

function handleAppWake(reason) {
  // Always: unpark the poll loop. Cheap, idempotent, and exactly what a
  // reconnect needs — the next poll (or failure retry) fires immediately.
  wakePendingPolls();
  if (!_appBooted) return;
  // 'online' can fire while the page is hidden — resuming into a background
  // tab wastes radio and races the eventual visible-wake; polls are enough.
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - _lastWakeResumeAt < 1000) return;   // pageshow + visibility + focus arrive together
  _lastWakeResumeAt = now;
  try { checkConnection().catch(() => {}); } catch (_) {}
  if (!isGenerating) {
    console.log(`[wake] app returned (${reason}) — re-checking pending generations`);
    resumePendingJobs();
    // The other half of the return trip. switchThread() covers "I opened a
    // different chat"; this covers the gap it cannot — the conversation you
    // are already looking at, while the other device adds to it. Picking your
    // phone back up is exactly that moment, and this handler is already
    // gated, cooled down and idle-only, which is precisely what the check
    // needs. See PER-CONVERSATION SYNC in js/06-state-sync.js.
    if (typeof reconcileWithServer === 'function') {
      reconcileWithServer({ reason: reason, focus: state.activeThreadId }).catch(() => {});
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isGenerating) flushBeforeExit({ beacon: false });
  if (document.visibilityState === 'visible') handleAppWake('visibility');
});
window.addEventListener('pagehide', () => flushBeforeExit({ beacon: true }));
window.addEventListener('pageshow', (e) => handleAppWake(e && e.persisted ? 'bfcache' : 'pageshow'));
window.addEventListener('focus', () => handleAppWake('focus'));
window.addEventListener('online', () => handleAppWake('online'));
