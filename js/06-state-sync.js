/* @gobbonet-split js/06-state-sync.js
   Moved verbatim from chat.html lines 4015-4863.
   server-side state sync
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SERVER-SIDE STATE SYNC

   Why: each LAN IP is a separate browser origin. When the PC's IP
   rotates (DHCP lease expires, reboot grabs a new one), the phone
   sees an empty localStorage at the new origin even though its old
   data is still sitting on disk at the old origin. Painful UX.

   Fix: mirror state to a server-side rolling backup at /state.
   On boot, if local is empty or the server has newer data, offer
   to restore. On every save, debounced push to the server.

   The local copy stays authoritative for performance — we never
   wait on the network for a save. Server sync is best-effort.

   ── SYNC TARGETS ────────────────────────────────────────────────
   For a long time there was exactly one file on the server, so every
   device that opened the page shared one history whether that was
   wanted or not. The phone and the desktop were joined by an
   implementation detail, not by a decision.

   A device now picks one of three targets, and the choice is this
   browser's alone:

     'shared'  the single shared state.json. The default, and exactly
               what every existing install already does.
     'profile' state-<name>.json beside it. A separate history that
               still gets the thing sync exists for — landing on a
               rotated IP with an empty localStorage and being handed
               your own chats back.
     'off'     no network at all. Fully local, and the only mode where
               nothing about this device reaches the server.

   WHY THE CHOICE IS NOT IN state.settings
   Because settings are part of the payload that gets synced, and a
   restore overwrites them. A device that pulled the desktop's backup
   would inherit the desktop's target and silently re-join the two
   histories — the exact thing the user separated, undone by the act
   of restoring. The target lives in its own localStorage key, beside
   the sync metadata, for the same reason that metadata does.

   ── WHAT A PUSH ACTUALLY SENDS ──────────────────────────────────
   Not the whole document any more. Everything down to the sync-target
   section below still describes the whole-file operations — boot
   conflict check, restore, target switching — and those are unchanged.
   The push itself now sends one conversation at a time, conditional on
   the version it is replacing, so two devices can share one backup
   without either flattening the other. See PER-CONVERSATION SYNC at
   the bottom of this file; it is where the interesting part lives.
================================================================ */

// /state lives on the file server (same origin as chat.html when served).
// On file:// it's not available; sync is silently disabled.
const STATE_SYNC_AVAILABLE = IS_SERVED;
const STATE_SYNC_BASE = IS_SERVED ? (window.location.origin + '/state') : null;

const SYNC_TARGET_KEY = 'gobbonet_sync_target';
// { mode: 'shared' | 'profile' | 'off', profile: string }
let syncTarget = { mode: 'shared', profile: '' };
try {
  const saved = JSON.parse(localStorage.getItem(SYNC_TARGET_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    // Anything unrecognised falls back to 'shared'. An install that predates
    // this key has no value at all, and must keep behaving exactly as it did.
    if (saved.mode === 'off' || saved.mode === 'profile' || saved.mode === 'shared') {
      syncTarget.mode = saved.mode;
    }
    if (typeof saved.profile === 'string') syncTarget.profile = normalizeSyncProfile(saved.profile);
  }
} catch (_) {}
// A profile mode with no usable name is not a target, it is a typo. Fall back
// rather than pushing to a URL the server will refuse on every save.
if (syncTarget.mode === 'profile' && !syncTarget.profile) syncTarget.mode = 'shared';

/** The client half of the server's allowlist. Kept deliberately identical, so
 *  a name the UI accepts is a name the server accepts — a name that only fails
 *  server-side would show up as an endless string of failed background syncs
 *  with nothing on screen explaining why. */
function normalizeSyncProfile(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n) ? n : '';
}

/** True when this device should not talk to the server at all. */
function syncIsOff() {
  return syncTarget.mode === 'off';
}

/** Whether a push or a fetch should happen right now. Every network path in
 *  this file goes through it, so 'off' is one decision rather than a condition
 *  repeated in a dozen places where one could be forgotten. */
function syncEnabled() {
  return STATE_SYNC_AVAILABLE && !syncIsOff() && !(typeof storageLoadFailed !== 'undefined' && storageLoadFailed);
}

/** A /state URL for the current target. `suffix` is '' or '/info'. */
function stateSyncUrl(suffix) {
  if (!STATE_SYNC_AVAILABLE) return null;
  const base = STATE_SYNC_BASE + (suffix || '');
  if (syncTarget.mode !== 'profile' || !syncTarget.profile) return base;
  return base + '?profile=' + encodeURIComponent(syncTarget.profile);
}

/** A stable label for the current target, for the UI and for log lines. */
function syncTargetLabel() {
  if (syncTarget.mode === 'off') return 'off';
  if (syncTarget.mode === 'profile') return syncTarget.profile;
  return 'shared';
}

const stateSync = {
  // Last mtime we successfully read from or wrote to the server.
  // Used to detect "the server has data we haven't seen" on next boot.
  lastKnownMtime: 0,
  // Status for UI:
  //   'idle' | 'syncing' | 'ok' | 'error' | 'quota' | 'conflict' | 'off' | 'disabled'
  //   'conflict' one or more conversations moved on both sides; open one to
  //              resolve it. Never blocks anything else from syncing.
  //   'locked'   the server restarted and no longer accepts our session. Not
  //              an error: nothing is lost and nothing is retried until
  //              somebody signs in again. See THE SERVER RESTARTED below.
  //   'off'      this device opted out; there is a server, we just don't use it
  //   'disabled' there is no server to use (file://)
  status: !STATE_SYNC_AVAILABLE ? 'disabled' : (syncIsOff() ? 'off' : 'idle'),
  lastError: null,
  pushTimer: null,
  // "Something changed locally since the last push." A flag rather than a
  // serialised snapshot: which conversations actually moved is worked out at
  // push time, from the ledger, so building a multi-megabyte string on every
  // save to feed a debounce would be pure waste. See PER-CONVERSATION SYNC.
  pendingPush: false,
  inFlight: false
};


/* ---------------------------------------------------------------------------
   THE SERVER RESTARTED

   A 401 from the state routes means the session this tab was using is gone:
   the server was restarted, updated, or rebooted underneath us. On an
   encrypted install it also means the data key went with it, because the key
   lives exactly as long as the session table does.

   Nothing here is lost. Local history is in localStorage or IndexedDB either
   way, and the push path already restores pendingPush on failure and retries,
   so the queue survives. What did NOT exist was any notion that a 401 is
   different from a network blip, so a restarted server produced a tiny "!" in
   the sidebar and a retry every four seconds, forever, against a server that
   would never accept any of them. The user's work quietly stopped backing up
   and the only signal was a dot.

   So: stop retrying, say what happened, and offer the one thing that fixes it.

   Deliberately NOT a redirect to /login. Navigating the tab throws away
   whatever is in the composer, any reply still streaming in, the scroll
   position and the open chat -- real work, to save one form post. The modal
   signs in over fetch and leaves the page where it was.
--------------------------------------------------------------------------- */

// noteLocked reports whether a response means "signed out", and if so puts the
// app into the locked state. Returns true when the caller should stop.
//
// One 401 is not proof, so the prompt waits for a second opinion: one cheap
// GET (sessionProbe) of the same kind of route. Only when that is refused as
// well -- or cannot be asked -- does the tab lock and ask for the password.
// A tab that is in fact still signed in carries on, and the caller's own
// retry (the push path re-arms on any error) goes out as usual. Asking for a
// password over a 401 that the next request did not repeat was the "signed
// in, tab out, asked again" report: too eager by exactly one request.
let _lockCheck = null;
function noteLocked(resp) {
  if (!resp || resp.status !== 401) return false;
  if (stateSync.status === 'locked') return true;   // already asking
  if (!_lockCheck) {
    let what = '?';
    try { what = new URL(resp.url || '', location.href).pathname; } catch (_) {}
    _lockCheck = confirmSignedOut(what)
      .catch((e) => { console.warn('[auth] could not show the sign-in prompt:', e && e.message); })
      .finally(() => { _lockCheck = null; });
  }
  return true;
}

// The route that answers "is this tab signed in?" the same way the state
// routes do: the session check, and on an encrypted install the unlocked key
// as well, which /state/* need and the password restores.
function sessionProbeUrl() {
  return (typeof STATE_SYNC_AVAILABLE !== 'undefined' && STATE_SYNC_AVAILABLE)
    ? stateSyncUrl('/info') : '/health-fileserver';
}

// true: signed in. false: refused (401). null: could not ask.
async function sessionProbe() {
  try {
    const r = await fetch(sessionProbeUrl(), { cache: 'no-store' });
    return r.status !== 401;
  } catch (_) {
    return null;
  }
}

async function confirmSignedOut(what) {
  const signedIn = await sessionProbe();
  if (stateSync.status === 'locked') return;
  if (signedIn === true) {
    console.warn('[auth] ' + what + ' was refused (401), but this tab is still signed in -- ' +
                 sessionProbeUrl().replace(location.origin, '') + ' answered. Not asking for the password.');
    return;
  }
  console.warn('[auth] signed out: ' + what + ' was refused (401)' +
               (signedIn === false ? ', and so was a fresh check.' : '; a fresh check could not reach the server.') +
               ' The gobbonet window logs the reason.');
  lockSignedOut();
}

function lockSignedOut() {
  stateSync.status = 'locked';
  stateSync.lastError = 'signed out';
  // Cancel the retry. Re-armed by resumeAfterUnlock() once we are back in.
  if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
  updateSyncIndicator();
  showUnlockModal();
}

// A locked tab is signed in again the moment ANY tab of this browser signs in:
// the session cookie belongs to the browser, not the tab. So while the prompt
// is up, look again on every return to the tab and every few seconds while it
// is on screen, and carry on by itself when the answer changes.
let _lockRecheckAt = 0;
let _lockRecheckTimer = null;
async function recheckLockedSession(reason) {
  if (stateSync.status !== 'locked') return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  const now = Date.now();
  if (now - _lockRecheckAt < 1500) return false;
  _lockRecheckAt = now;
  if (await sessionProbe() !== true || stateSync.status !== 'locked') return false;
  console.log('[auth] this browser is signed in again (' + reason + ') -- carrying on without a password here.');
  hideUnlockModal();
  resumeAfterUnlock();
  return true;
}

// serverError turns a failed response into the right Error, raising the unlock
// prompt when the reason is that we are signed out.
function serverError(resp, message) {
  noteLocked(resp);
  return new Error(message || ('HTTP ' + resp.status));
}

function showUnlockModal() {
  const modal = document.getElementById('unlock-modal');
  if (!modal) return;
  if (!_lockRecheckTimer) _lockRecheckTimer = setInterval(() => { recheckLockedSession('poll').catch(() => {}); }, 5000);
  const err = document.getElementById('unlock-error');
  if (err) { err.textContent = ''; err.style.display = 'none'; }
  modal.classList.add('open');
  const field = document.getElementById('unlock-password');
  if (field) { field.value = ''; setTimeout(() => field.focus(), 50); }
}

function hideUnlockModal() {
  if (_lockRecheckTimer) { clearInterval(_lockRecheckTimer); _lockRecheckTimer = null; }
  const modal = document.getElementById('unlock-modal');
  if (modal) modal.classList.remove('open');
}

/**
 * Sign back in without leaving the page.
 *
 * On an encrypted install this is also what unlocks the history: the password
 * keyslot is the verifier, so the server proves the password and unwraps the
 * data key in one step. Which is why a wrong password here is the same answer
 * as a wrong password anywhere else, and why there is nothing else to ask for.
 */
async function submitUnlock() {
  const field = document.getElementById('unlock-password');
  const err = document.getElementById('unlock-error');
  const btn = document.getElementById('unlock-submit');
  const password = field ? field.value : '';
  if (!password) return;

  const say = (msg) => {
    if (!err) return;
    err.textContent = msg;
    err.style.display = msg ? 'block' : 'none';
  };

  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  say('');
  try {
    const body = new URLSearchParams();
    body.set('password', password);
    const resp = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual'
    });
    // A successful login answers with a redirect to "/", which fetch reports
    // as an opaque redirect rather than a status we can read. Either shape
    // means we are in; only an explicit 401 means we are not.
    if (resp.status === 401) {
      say('That password was not accepted.');
      return;
    }
    if (resp.status === 429) {
      say('Too many attempts. Wait a moment, then try again.');
      return;
    }
    hideUnlockModal();
    resumeAfterUnlock();
  } catch (e) {
    say('Could not reach the server: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
    if (field) field.value = '';
  }
}

/**
 * Pick up where we left off.
 *
 * pendingPush is left exactly as it was, so anything queued while the server
 * was away still goes out. The index check runs first because the server may
 * have been restarted for an update that another device has already written
 * through.
 */
function resumeAfterUnlock() {
  stateSync.status = 'idle';
  stateSync.lastError = null;
  updateSyncIndicator();
  reconcileWithServer({ silent: true }).catch(() => {});
  if (stateSync.pendingPush) scheduleStateSync();
}

// Persist lastKnownMtime in localStorage so we remember it across
// reloads at the same origin. Keyed separately so a state restore
// doesn't clobber it.
//
// Kept PER TARGET. lastKnownMtime answers "has something written to the file
// I sync with since I last looked", and every decision in
// checkServerStateOnBoot hangs off that answer. Carrying one number across a
// target switch would compare the phone profile's mtime against the last time
// the shared file was written -- two unrelated clocks -- and the boot check
// would then either skip a restore it owed the user or offer one it did not.
const SYNC_META_KEY = 'gobbonet_sync_meta';
let syncMtimeByTarget = {};
try {
  const meta = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
  if (meta && typeof meta.byTarget === 'object' && meta.byTarget) syncMtimeByTarget = meta.byTarget;
  // The legacy shape is a bare lastKnownMtime, written before targets existed.
  // It can only ever have described the shared file, because that was the only
  // thing there was to describe.
  if (typeof meta.lastKnownMtime === 'number' && syncMtimeByTarget.shared === undefined) {
    syncMtimeByTarget.shared = meta.lastKnownMtime;
  }
  const mine = syncMtimeByTarget[syncTargetLabel()];
  if (typeof mine === 'number') stateSync.lastKnownMtime = mine;
} catch (_) {}

function persistSyncMeta() {
  try {
    const label = syncTargetLabel();
    // 'off' is not a file on the server, so it has no mtime worth remembering.
    // Without this guard a device that switched off would leave a meaningless
    // "off" entry in the map beside the real ones.
    if (label !== 'off') syncMtimeByTarget[label] = stateSync.lastKnownMtime;
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({
      // Mirrored at the top level as well, so a downgrade to a build with no
      // notion of targets still finds the shared file's mtime where it looks.
      lastKnownMtime: syncMtimeByTarget.shared || 0,
      byTarget: syncMtimeByTarget
    }));
  } catch (_) {}
}

/** Persist this device's choice of target. Its own key, never state.settings —
 *  see the header. */
function persistSyncTarget() {
  try { localStorage.setItem(SYNC_TARGET_KEY, JSON.stringify(syncTarget)); } catch (_) {}
}

// True when the in-memory state is mid-flight and therefore unsafe to publish
// as the cross-device source of truth: a generation is currently streaming, OR
// the active thread ends in an empty assistant placeholder (a fresh send slot
// or a freshly-blanked reroll slot) that hasn't been filled yet. Local saves
// still happen normally; only the server push is held back until the state
// settles. A settled thread never ends in an empty assistant message --
// generation always fills content, and even aborts/errors write text -- so
// this can defer a push but never starve a legitimate one.
function stateSyncWouldBeTransient() {
  if (isGenerating) return true;
  try {
    const t = getActiveThread();
    if (t && Array.isArray(t.messages) && t.messages.length > 0) {
      const last = t.messages[t.messages.length - 1];
      if (last && last.role === 'assistant' && !((last.content || '').trim())) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Debounced push to the server. Called from saveState(). Coalesces rapid
 * saves (typing, streaming tokens) into one network write every ~2s.
 *
 * Takes no argument. It accepted a pre-built JSON snapshot for as long as the
 * push was "replace the whole document"; now the push works out what moved,
 * so a snapshot built here would be discarded unread.
 */
function scheduleStateSync() {
  if (!syncEnabled()) return;
  stateSync.pendingPush = true;
  if (stateSync.pushTimer) clearTimeout(stateSync.pushTimer);
  stateSync.pushTimer = setTimeout(flushStateSync, 2000);
}

async function flushStateSync() {
  if (!syncEnabled()) return;
  // A delete with UNDO still on offer is not final, so other devices must not
  // hear about it yet (1.7.9). The push is re-armed when it commits or is
  // undone (js/18-utils.js UNDO). typeof: this file is also run on its own
  // by tests that load no utils.
  if (typeof undoHoldsSync === 'function' && undoHoldsSync()) {
    stateSync.pendingPush = true;
    return;
  }
  if (stateSync.inFlight) {
    // Another push is happening. Re-arm so we capture the latest.
    stateSync.pushTimer = setTimeout(flushStateSync, 2000);
    return;
  }
  // Never publish a mid-flight snapshot as the cross-device source of truth.
  // While a generation is streaming -- or a fresh/rerolled assistant slot is
  // still empty -- the latest state contains a blank reply. Defer and keep
  // re-checking; the settled saveState() that runs when generation finishes
  // re-arms this and the state is whole by then. This is the fix for replies
  // that "went blank" after a refresh: the server was being handed an
  // in-progress snapshot that other devices then restored.
  if (stateSyncWouldBeTransient()) {
    stateSync.pushTimer = setTimeout(flushStateSync, 2000);
    return;
  }
  if (!stateSync.pendingPush) return;
  stateSync.pendingPush = false;
  stateSync.pushTimer = null;
  stateSync.inFlight = true;
  stateSync.status = 'syncing';
  updateSyncIndicator();
  try {
    await pushChangedConversations();
    stateSync.lastError = null;
  } catch (e) {
    // Don't drop the update. Re-arm with a short backoff, so a transient
    // network blip can't leave the server holding a stale copy that a later
    // boot might restore over good local data. The ledger still holds the
    // versions we last confirmed, so the retry sends exactly what did not
    // land -- nothing is re-sent that already arrived.
    stateSync.pendingPush = true;

    // Unless we are signed out, in which case retrying is not a backoff, it is
    // a loop: every attempt gets the same 401 until a person types a password.
    // Keep the queue, drop the timer, and let resumeAfterUnlock() restart it.
    if (stateSync.status === 'locked') {
      console.warn('[sync] Push deferred: the server restarted and this tab is signed out. Nothing was lost.');
      return;
    }

    stateSync.status = 'error';
    stateSync.lastError = e.message || String(e);
    console.warn('[sync] Push failed:', stateSync.lastError);
    if (stateSync.pushTimer) clearTimeout(stateSync.pushTimer);
    stateSync.pushTimer = setTimeout(flushStateSync, 4000);
  } finally {
    stateSync.inFlight = false;
    updateSyncIndicator();
  }
}

/**
 * Collapse the 2s debounce and push the pending snapshot to /state right
 * away. Called the instant a generation settles, so a completed reply can't
 * be stranded in local-only purgatory if the user navigates away during the
 * debounce window. The orphaned debounce timer (if any) is cleared so it
 * can't fire a redundant second push; flushStateSync itself still defers
 * cleanly if the state somehow isn't settled yet.
 */
function forceServerFlush() {
  if (!syncEnabled()) return;
  if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
  // Fire and forget — sync is best-effort and we never block the UI on it.
  flushStateSync();
}

/**
 * Last-chance flush when the page is being hidden or torn down. The browser
 * gives us no async budget here, so we do the two things that survive:
 *
 *   1. A synchronous localStorage write (saveState) — this is what lets THIS
 *      origin recover the in-progress reply on reload. localStorage.setItem
 *      completes inline even inside pagehide.
 *   2. A keepalive push of whatever conversations actually moved, but ONLY
 *      when the state is settled. A mid-stream / empty-placeholder snapshot
 *      must never become the cross-device source of truth (that's the original
 *      blanking bug), so this is gated behind stateSyncWouldBeTransient()
 *      exactly like the debounced path is.
 *
 * beacon=false skips the network push entirely — used on visibilitychange,
 * which fires on every tab switch and would otherwise spam the server.
 *
 * WHY THIS IS NO LONGER A sendBeacon
 * It used to be navigator.sendBeacon with the entire history as the body: a
 * blind, unconditional PUT /state, which is precisely the overwrite the
 * per-conversation routes exist to remove. Keeping it would have left one
 * writer in the system that could still flatten another device's chats, and
 * it would have fired on every single tab close. sendBeacon cannot carry an
 * If-Match header at all, so there was no way to make it safe.
 *
 * fetch(..., { keepalive: true }) is the same "survives teardown" guarantee
 * with headers, so the exit push carries its preconditions like every other
 * write. The keepalive body cap is 64 KB, so a large conversation can be
 * refused here — that fails visibly rather than silently: the ledger is only
 * advanced on a response we actually received, so the change stays queued and
 * the next boot sends it.
 */
function flushBeforeExit(opts) {
  const beacon = !!(opts && opts.beacon);
  // Leaving for good: a delete still offering UNDO becomes final first, so
  // what is saved and pushed below is what the person did (1.7.9). Not on a
  // mere tab switch (beacon false), where they may well come back to undo.
  if (beacon) { try { if (typeof commitPendingUndo === 'function') commitPendingUndo(); } catch (_) {} }
  try {
    // Local save always. Skip arming the debounced push — the page is going
    // away, so the timer would never fire; the keepalive push below is the
    // real one.
    saveState({ skipServerSchedule: true });
    // If a debounced full IDB save is still pending, issue it now (best-effort)
    // so a just-settled action isn't stranded by the teardown.
    flushPendingIdbSave();
    if (beacon && syncEnabled() && !stateSyncWouldBeTransient()) {
      pushChangedConversations({ keepalive: true }).catch(() => {});
    }
  } catch (_) {}
}

/**
 * Boot-time check. Called once after loadState(). If the server has
 * a backup we don't have (or one strictly newer than ours), prompt
 * the user before clobbering local data.
 *
 * Decision matrix:
 *   local empty + server has data    -> auto-restore (no prompt)
 *   local has data + server matches  -> noop
 *   local has data + server newer    -> prompt user
 *   local has data + server older    -> noop, push will catch up
 *   local empty + server empty       -> noop (fresh install)
 */
async function checkServerStateOnBoot() {
  if (!syncEnabled()) return;
  let info;
  try {
    const resp = await fetch(stateSyncUrl('/info'), { cache: 'no-store' });
    if (resp.status === 404) {
      // No backup yet — nothing to restore. Push current state to seed.
      if (state.threads && state.threads.length > 0) {
        scheduleStateSync();
      }
      return;
    }
    if (!resp.ok) throw serverError(resp);
    info = await resp.json();
  } catch (e) {
    console.warn('[sync] Boot check failed:', e.message);
    stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    return;
  }

  const localEmpty = !state.threads || state.threads.length === 0;
  const serverMtime = (info && typeof info.mtime === 'number') ? info.mtime : 0;
  const serverSize = (info && typeof info.size === 'number') ? info.size : 0;
  let localSize = 0;
  try { localSize = redactedSyncJson().length; } catch (_) {}

  // Server has a backup that's newer than what we last synced (i.e. another
  // origin/device wrote after we last read), OR local is empty.
  const serverIsNewer = serverMtime > stateSync.lastKnownMtime;
  // Server holds materially more than our local copy. With "not newer than
  // what we last synced", this is the signature of a localStorage quota
  // truncation on THIS origin: we pushed the full conversation to the server,
  // but the local cache write was refused for space and froze a partial copy.
  // Retained after the IndexedDB migration (plan §7): on the IDB backend this
  // rarely triggers (IDB doesn't truncate at a 5 MB cap the way localStorage
  // did), but it still guards the localStorage-fallback path and genuine
  // cross-origin recovery, so it's kept deliberately rather than removed.
  const serverHasMore = localSize > 0 && serverSize > localSize * 1.2;

  if (localEmpty && serverSize > 0) {
    // Apply in memory: empty history can still contain characters/personas,
    // and an embedded browser may have no persistent storage at all.
    await restoreFromServer({ silent: true, inPlace: true, boot: true });
  } else if (!localEmpty && !serverIsNewer && serverHasMore) {
    await restoreFromServer({ silent: true, inPlace: true, boot: true });
  } else if (!localEmpty && serverIsNewer) {
    // Conflict: server has newer data than we know about. Don't auto-clobber.
    //
    // Defense in depth: a "newer" snapshot that is dramatically smaller than
    // our local copy is almost always a partial/mid-flight snapshot (or a
    // stale shape) rather than a legitimately newer conversation. Restoring it
    // would blank out replies we still hold locally -- the exact failure this
    // patch guards against. In that case keep local authoritative and
    // re-publish it to heal the server, instead of prompting to overwrite good
    // data. Trade-off: legitimately deleting >50% of your chats on another
    // device won't propagate to this one on the next boot (re-do the delete
    // and it will). Preserving data beats silently dropping it.
    if (localSize > 0 && serverSize < localSize * 0.5) {
      console.warn('[sync] Server is newer but much smaller (' + serverSize +
                   ' vs local ' + localSize + ') — keeping local, re-publishing.');
      stateSync.lastKnownMtime = serverMtime;
      persistSyncMeta();
      scheduleStateSync();
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      // Awaited. Boot chains ensureSyncLedger() onto this call, and that
      // seeds the server from local state -- so letting the restore run
      // unwatched would race a whole-document upload of the very data the
      // user just asked to replace.
      await showRestorePrompt(info, { inPlace: true, boot: true });
    }
  } else {
    // Local matches or is ahead. Mark as ok.
    stateSync.lastKnownMtime = Math.max(stateSync.lastKnownMtime, serverMtime);
    persistSyncMeta();
    stateSync.status = 'ok';
    updateSyncIndicator();
  }
}

/**
 * Pull state from the server and apply it. Used by both auto-restore
 * (silent) and the manual restore button.
 */
async function restoreFromServer(opts) {
  opts = opts || {};
  if (!STATE_SYNC_AVAILABLE) {
    if (!opts.silent) alert('Server backup needs the GobboNet server. Open the chat at the address GobboNet prints when it starts.');
    return false;
  }
  // An explicit restore while sync is off is a contradiction, and silently
  // pulling from the shared file would be the worst possible reading of it.
  if (syncIsOff() && !opts.force) {
    if (!opts.silent) {
      alert('Server sync is switched off for this device.\n\n' +
            'Turn it on under DATA \u2192 DEVICE SYNC to restore from the server.');
    }
    return false;
  }
  try {
    const resp = await fetch(stateSyncUrl(''), { cache: 'no-store' });
    if (resp.status === 404) {
      if (opts.boot) throw new Error('Server backup disappeared during startup; retry loading state.');
      if (!opts.silent) alert('No backup found on the server yet.');
      return false;
    }
    if (!resp.ok) throw serverError(resp);
    // let, not const: the neutralize step below rewrites this before the
    // localStorage path consumes it.
    let text = await resp.text();
    const mtimeHeader = resp.headers.get('X-State-Mtime');
    // Sanity-check: must parse and have at least the threads array
    const parsed = JSON.parse(text);
    validateServerSnapshot(parsed);

    // /state is a single shared document every paired device can overwrite, so
    // this blob is not necessarily something this user wrote. Clear the flags
    // that would make boot execute code out of it; the code itself is kept so
    // it can be read and switched on here. See neutralizeUntrustedCode.
    //
    // Called directly, with no `typeof` guard (1.7.9, PR #5 review). The guard
    // was there so a load-order change could not break restores, but what it
    // did instead was skip the security control without a sound: if the
    // function were ever missing, synced code would arrive switched ON. A
    // restore that fails loudly is the right outcome. By the time any restore
    // runs, 23-card-code.js has loaded (restores start from boot or a click).
    const neutralized = neutralizeUntrustedCode(parsed);
    if (neutralized.cards || neutralized.extensions) {
      text = JSON.stringify(parsed);   // localStorage path writes the raw text
      if (!opts.silent) {
        alert('The server backup contained custom code set to run automatically' +
              (neutralized.cards ? ' (' + neutralized.cards + ' character card(s))' : '') +
              (neutralized.extensions ? ' and an extensions list' : '') +
              '.\n\nIt was restored but left switched OFF. Review it in the ' +
              'character editor or the extensions panel before enabling it.');
      }
    }

    // No chats does not mean no state. Preserve any local chats when the
    // server supplies metadata only; a restore must not erase them by accident.
    if (opts.inPlace || parsed.threads.length === 0) {
      if (isGenerating) throw new Error('Stop the active reply before restoring state.');
      if (parsed.threads.length === 0 && state.threads && state.threads.length) {
        parsed.threads = JSON.parse(JSON.stringify(state.threads));
      }
      const previous = { ...state };
      if (!applyLoadedState(parsed)) {
        Object.assign(state, previous);
        throw new Error('Could not apply server state');
      }
      if (typeof storageLoadFailed !== 'undefined') storageLoadFailed = false;
      invalidateLedger();
      if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
      stateSync.pendingPush = false;
      // Cancel a queued save of the old local snapshot. Storage is only a
      // cache: failure must not discard the server state now held in memory.
      if (_idbFullSaveTimer) clearTimeout(_idbFullSaveTimer);
      _idbFullSaveTimer = null;
      _idbPendingBlob = null;
      let cacheFailed = false;
      try {
        const blob = buildStateBlob();
        if (STORAGE_BACKEND === 'idb') {
          await idbWriteSnapshot(blob, true);
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
        }
      } catch (e) {
        cacheFailed = true;
        console.warn('[sync] Server state loaded in memory; local cache unavailable:', e.message);
        if (isQuotaError(e)) storageQuotaHit = true;
      }
      if (mtimeHeader) stateSync.lastKnownMtime = parseInt(mtimeHeader, 10) || stateSync.lastKnownMtime;
      persistSyncMeta();
      stateSync.status = cacheFailed && storageQuotaHit ? 'quota' : 'ok';
      stateSync.lastError = null;
      updateSyncIndicator();
      state.activeThreadId = null;
      if (!opts.boot) {
        // The 🔍 switch is this device's and the server's copy does not
        // touch it; just keep the button showing it after the re-render.
        if (typeof showSearchSwitch === 'function') showSearchSwitch();
        applyExtensions();
        applyCardCode();
        applyAvatarScale();
        render();
        applyActiveCardBackground();
      }
      return true;
    }

    if (mtimeHeader) {
      stateSync.lastKnownMtime = parseInt(mtimeHeader, 10) || stateSync.lastKnownMtime;
      persistSyncMeta();
    }
    // A whole-document restore replaces every conversation at once, so every
    // per-conversation version this device was holding is now meaningless.
    // Drop the ledger and let the next boot re-seed it.
    //
    // Deliberately NOT "adopt the server's index, we just downloaded it": the
    // load path runs migrations that can rewrite a thread on the way in (the
    // interrupted-reroll rollback above is one), so the copy that lands in
    // memory is not always the copy that came off the wire. Claiming agreement
    // we have not verified would make the next push skip a thread that really
    // did differ. Re-seeding costs one upload on a path that runs rarely.
    invalidateLedger();
    // Between here and the reload actually happening, a queued push could
    // fire, find no ledger, and seed the server with the state we are in the
    // middle of replacing -- undoing the restore. Close that window.
    stateSyncReloading = true;
    if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
    stateSync.pendingPush = false;
    // Repopulate the active storage backend from the restored blob, then
    // reload so the async boot re-reads it cleanly.
    if (STORAGE_BACKEND === 'idb') {
      // No 5 MB cap here, so the localStorage in-memory fallback below isn't
      // needed on this path — just rewrite the records and reload.
      await idbWriteSnapshot(parsed, true);
      location.reload();
      return true;
    }
    // localStorage fallback. Prefer caching locally and reloading for a
    // perfectly clean apply. But if the backup is too big for localStorage —
    // the exact case that caused the data loss we are recovering from — the
    // write throws; reloading then would just re-read the truncated copy and
    // lose the data again. So on a quota error, apply the restored state IN
    // MEMORY and re-render instead.
    try {
      localStorage.setItem(STORAGE_KEY, text);
      location.reload();
      return true;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      console.warn('[sync] Restored backup is larger than localStorage allows; ' +
                   'applying in memory (local cache stays partial, server backup ' +
                   'is complete).');
      storageQuotaHit = true;
      // This branch applies in memory instead of reloading, so the reload
      // guard has to come back off or sync would stay frozen for the rest of
      // the session.
      stateSyncReloading = false;
      await loadState(text);        // parse + migrate the full blob into state
      state.activeThreadId = null;  // land on the dashboard like a normal boot
      if (syncEnabled()) stateSync.status = 'quota';
      updateSyncIndicator();
      if (typeof render === 'function') render();
      return true;
    }
  } catch (e) {
    console.error('[sync] Restore failed:', e);
    // No reload is coming, so releasing the guard is what lets the ordinary
    // sync loop carry on with the state that is still here.
    stateSyncReloading = false;
    if (!opts.silent) alert('Could not restore from server: ' + e.message);
    stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    return false;
  }
}

// Shared validation for restore and the read-only integration API. Legacy
// snapshots may omit threads; that is metadata-only, never a deletion request.
function validateServerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Malformed server state');
  if (!['threads', 'characterCards', 'personaCards', 'settings'].some(key => Object.prototype.hasOwnProperty.call(snapshot, key))) throw new Error('Malformed server state: missing state fields');
  if (snapshot.threads === undefined) snapshot.threads = [];
  for (const key of ['threads', 'characterCards', 'personaCards', 'groups', 'folders', 'macros', 'schedules']) {
    if (snapshot[key] !== undefined && (!Array.isArray(snapshot[key]) || snapshot[key].some(x => !x || typeof x !== 'object' || Array.isArray(x)))) {
      throw new Error('Malformed server state: ' + key);
    }
  }
  if (snapshot.settings !== undefined && (!snapshot.settings || typeof snapshot.settings !== 'object' || Array.isArray(snapshot.settings))) throw new Error('Malformed server state: settings');
  for (const thread of snapshot.threads) {
    if (typeof thread.id !== 'string' || !Array.isArray(thread.messages)) throw new Error('Malformed server state: thread');
  }
}

// GET only. Does not apply, execute, cache or sync the returned snapshot.
// The normal GobboNet UI remains bidirectional; this helper grants no new
// server permissions. It can be retried independently of UI startup.
window.GobboNet = window.GobboNet || {};
window.GobboNet.fetchServerState = async function fetchServerState(options = {}) {
  if (!syncEnabled()) throw new Error('Server sync is unavailable or switched off');
  let url = stateSyncUrl('');
  if (options.profile !== undefined) {
    const profile = normalizeSyncProfile(options.profile);
    if (!profile) throw new Error('Invalid server profile');
    url = STATE_SYNC_BASE + '?profile=' + encodeURIComponent(profile);
  }
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal: options.signal });
  if (response.status === 404) return null;
  if (!response.ok) throw serverError(response);
  const snapshot = await response.json();
  validateServerSnapshot(snapshot);
  return snapshot;
};

async function showRestorePrompt(info, opts) {
  // Lightweight modal — uses the existing modal pattern
  const mtime = info && info.mtime ? new Date(info.mtime) : null;
  const when = mtime ? mtime.toLocaleString() : 'unknown';
  const sizeKB = info && info.size ? Math.round(info.size / 1024) : '?';
  const msg =
    'A newer chat backup was found on the server (' + syncTargetLabel() + ').\n\n' +
    'Saved: ' + when + '\n' +
    'Size: ' + sizeKB + ' KB\n\n' +
    'This usually means the server\'s LAN IP changed and your\n' +
    'browser is now seeing a fresh empty chat at the new address.\n\n' +
    'Restore it? (Your current local chat will be replaced.)';
  if (confirm(msg)) {
    await restoreFromServer(opts);
  } else {
    invalidateLedger(undefined, true);
    // User declined — accept local as authoritative and push to overwrite
    stateSync.lastKnownMtime = info.mtime || 0;
    persistSyncMeta();
    scheduleStateSync();
  }
}

/**
 * Update the small sync-status indicator in the UI. Created lazily on
 * first call. Tucks into the sidebar footer; hidden on file://.
 */
function updateSyncIndicator() {
  if (!STATE_SYNC_AVAILABLE) return;
  let el = document.getElementById('sync-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-indicator';
    el.className = 'sync-indicator';
    el.title = 'Click to manually restore from the server backup';
    el.addEventListener('click', () => {
      if (stateSync.status === 'locked') {
        // Offering a restore here would be answering the wrong question: the
        // server is not refusing our data, it is refusing our session.
        showUnlockModal();
        return;
      }
      if (syncIsOff()) {
        // Offering a restore here would only produce the "sync is off" alert.
        // Send the user where the switch actually is.
        try { openDataManager(); } catch (_) {}
        return;
      }
      if (confirm('Replace your current chat with the version saved on the server (' +
                  syncTargetLabel() + ')?')) {
        restoreFromServer();
      }
    });
    // Place it in the sidebar footer if that exists; otherwise body
    const footer = document.querySelector('.sidebar-footer') || document.querySelector('.sidebar') || document.body;
    footer.appendChild(el);
  }
  const icons = { idle: '○', syncing: '⟳', ok: '✓', error: '!', quota: '⚠', conflict: '⇅', locked: '🔒', off: '⦸', disabled: '' };
  // The target is named on every label that involves the server. With more
  // than one backup on disk, "synced" on its own no longer says which.
  const where = syncTargetLabel();
  const suffix = (syncTarget.mode === 'profile') ? ' (' + where + ')' : '';
  const labels = {
    idle: 'sync idle' + suffix,
    syncing: 'syncing…' + suffix,
    ok: 'synced' + suffix,
    error: 'sync error: ' + (stateSync.lastError || 'unknown'),
    quota: 'local storage full — backed up to server (click to restore full history)',
    // Not counted: the number would be stale the moment another device wrote,
    // and the resolution happens one chat at a time anyway. Short enough to
    // stay on one line, so the status changing does not shove the sidebar
    // buttons around; the explanation is on the tooltip below.
    conflict: 'chat conflict' + suffix,
    locked: 'signed out — click to sign back in',
    off: 'sync off — this device only',
    disabled: ''
  };
  el.textContent = (icons[stateSync.status] || '') + ' ' + (labels[stateSync.status] || '');
  el.dataset.status = stateSync.status;
  // The label has one line of a narrow sidebar to work with, so anything that
  // needs a sentence says it here instead of wrapping and shoving the footer
  // buttons up the page.
  el.title = (stateSync.status === 'conflict')
    ? 'A chat changed here and on another device. Open it and GobboNet will ask ' +
      'which version to keep — only that chat is affected.'
    : (stateSync.status === 'locked')
      ? 'The server restarted, so this tab is signed out. Nothing has been lost — ' +
        'your chats are saved on this device and will back up again once you sign in.'
      : 'Click to manually restore from the server backup';
}

/**
 * Parse a numeric input value, returning the default only if the input
 * is genuinely empty or NaN — NOT when it's zero. Fixes the bug where
 * `parseFloat(x) || default` treats 0 as falsy.
 */
function safeParse(raw, fallback, asInt) {
  const v = asInt ? parseInt(raw) : parseFloat(raw);
  return (isNaN(v) || raw === '' || raw == null) ? fallback : v;
}

/**
 * DRY scan window, expressed so that every llama.cpp build accepts it.
 *
 * This field used to be hardcoded to -1, which older llama-server read as
 * the sentinel for "scan the whole context". Upstream has since dropped
 * that sentinel: the field is now range-checked as 0 <= value <= 2147483647
 * and its default fell to 64. Newer engines reject -1 outright —
 *
 *   upstream HTTP 400: Field 'dry_penalty_last_n': Value must be between
 *   0 <= value <= 2147483647, but got -1
 *
 * — and because this parameter is sent on EVERY request, not only when DRY
 * is switched on, that 400 killed all generation rather than just DRY runs.
 * It showed up on Linux first because the .deb pins a recent engine build
 * (see installer-linux/engine.sha256) while Windows still runs an older one
 * that honours -1. Nothing about the platform itself is involved.
 *
 * Sending the resolved context size keeps the original meaning intact on
 * both: old builds expanded -1 to exactly this number, and new builds take
 * it as a plain in-range window. resolveContextLimit() is already clamped
 * to the model's real ceiling and floored at 2048, so the scan window can
 * never exceed the context being scanned — and since the prompt builder
 * never sends more than this many tokens, the window still covers 100% of
 * what is actually in play.
 *
 * Note the value has to stay proportionate, not merely legal: the engine
 * sizes its DRY ring buffer from this number, so 2147483647 would validate
 * and then ask for a multi-gigabyte allocation to hold a window that can
 * never fill.
 *
 * Hence the ceiling. resolveContextLimit() clamps to activeModel.maxCtx,
 * but when no model is loaded yet there is no ceiling to clamp against and
 * a card carrying a junk contextLimit (hand-edited, or imported from
 * somewhere odd) passes straight through. Such a value is still legal
 * upstream and would fail the wrong way — a silent oversized allocation
 * rather than a 400. 262144 is the largest maxCtx in the registry, so this
 * cannot trim a window any real model could actually use.
 *
 * The fallback only fires if 04-state.js somehow hasn't loaded; 4096 is a
 * safe in-range window rather than a behavioural choice.
 */
const DRY_PENALTY_LAST_N_CEILING = 262144;

function resolveDryPenaltyLastN(card) {
  const n = (typeof resolveContextLimit === 'function')
    ? parseInt(resolveContextLimit(card), 10)
    : NaN;
  if (isNaN(n) || n < 0) return 4096;
  return Math.min(n, DRY_PENALTY_LAST_N_CEILING);
}

/**
 * Build sampler parameters from the active character card.
 * Returns an object to spread into the llama.cpp API body.
 *
 * Existing cards without XTC/DRY fields fall through to off-by-default
 * values, so adding these samplers doesn't change behavior for anyone
 * who hasn't opted in via the UI or a preset.
 *
 * XTC (Exclude Top Choices) - removes high-prob tokens with some chance
 *   per step, forcing the model down less-trodden paths. Best lever for
 *   "model keeps reaching for the same word" on peaky distributions.
 *   xtc_probability = 0 disables.
 *
 * DRY (Don't Repeat Yourself) - penalizes repeated SEQUENCES rather than
 *   single tokens. Lets function words / names repeat naturally while
 *   blocking the model from re-using whole descriptive phrases.
 *   dry_multiplier = 0 disables.
 */
function getCardSamplerParams(card) {
  card = card || getActiveCard();
  return {
    temperature: card.temperature !== undefined ? card.temperature : 0.7,
    min_p:       card.minP !== undefined ? card.minP : 0.05,
    top_k:       card.topK !== undefined ? card.topK : 40,
    top_p:       card.topP !== undefined ? card.topP : 0.95,
    repeat_penalty:  card.repeatPenalty !== undefined ? card.repeatPenalty : 1.1,
    repeat_last_n:   card.repeatLastN !== undefined ? card.repeatLastN : 64,
    // XTC — off by default
    xtc_probability: card.xtcProbability !== undefined ? card.xtcProbability : 0,
    xtc_threshold:   card.xtcThreshold !== undefined ? card.xtcThreshold : 0.1,
    // DRY — off by default. Base/allowed-length use community-standard
    // values; only the multiplier is user-facing in the UI.
    dry_multiplier:     card.dryMultiplier !== undefined ? card.dryMultiplier : 0,
    dry_base:           card.dryBase !== undefined ? card.dryBase : 1.75,
    dry_allowed_length: card.dryAllowedLength !== undefined ? card.dryAllowedLength : 2,
    // Resolved rather than -1: newer engines range-check this field and
    // reject the old sentinel. See resolveDryPenaltyLastN above.
    dry_penalty_last_n: resolveDryPenaltyLastN(card)
  };
}

/* The per-character thinking switch (roadmap 1.7.7 #9), as request fields.

   Off sends chat_template_kwargs.enable_thinking = false. llama-server (pinned
   b10456, tools/server/server-common.cpp) reads that per request and hands it
   to the model's chat template; a template that supports it answers without
   its reasoning step, and one that does not ignores it. It must be a real JSON
   boolean -- the engine REJECTS the request if it arrives as the string
   "false" -- which is why this builds an object rather than a string.

   On, which is the default and what every card had before this setting
   existed, sends nothing at all: the request is byte-identical to before.
   Read as `!== false`, so a card from an older install or another app (no
   field) thinks, as it always did.

   Models trained to always reason (DeepSeek-R1 distills; gpt-oss, which can be
   turned down but not off) may think anyway. The card editor says so. */
function cardThinkingEnabled(card) {
  return !(card && card.thinkingEnabled === false);
}
function getCardThinkingParams(card) {
  card = card || getActiveCard();
  return cardThinkingEnabled(card) ? {} : { chat_template_kwargs: { enable_thinking: false } };
}

/**
 * Family-aware STOP STRINGS.
 *
 * Why this exists: '[INST]' / '[/INST]' are NOT special tokens in Mistral's
 * format — they're plain text. When a model leaks them into a visible reply
 * ("Tekken junk"), it means generation ran PAST the turn boundary because the
 * EOS the model emits doesn't match what llama-server stops on. This is the
 * classic roleplay-merge artifact (mismatched/wrong EOS in the GGUF). The
 * embedded template can be perfectly correct and the model still runs on.
 *
 * SillyTavern's universal fix is custom stop strings: the instruct template's
 * turn delimiters double as stopping strings, so a runaway gets cut at the
 * first delimiter regardless of EOS health. We mirror that here.
 *
 * SAFETY: every string below is a TURN DELIMITER that must never appear inside
 * a valid assistant reply. Stopping on them is a pure backstop — it only fires
 * when the model misbehaves, so it can't truncate legitimate output and can't
 * regress models that already stop cleanly (the server still honors real EOS
 * first). Delimiters are stripped from the output, not echoed.
 *
 * We deliberately leave the delicate reasoning formats (harmony / deepseek)
 * to the server's own parsing and add no extra stops for them, since their
 * channel/think markers are consumed mid-turn, not at the boundary.
 */
const STOP_STRINGS_BY_FAMILY = {
  // Mistral V1/V2/V3/Tekken/V7 — the family that leaks "[INST]" junk.
  mistral:    ['</s>', '[INST]', '[/INST]'],
  // Llama 3.x header format (also covers llama2-lineage [INST] merges).
  llama:      ['<|eot_id|>', '<|start_header_id|>', '[INST]', '[/INST]'],
  // ChatML and friends.
  qwen:       ['<|im_end|>', '<|im_start|>'],
  glm:        ['<|im_end|>', '<|im_start|>', '<|user|>', '<|assistant|>'],
  phi:        ['<|im_end|>', '<|im_start|>', '<|end|>'],
  moonshot:   ['<|im_end|>', '<|im_user|>', '<|im_assistant|>'],
  // Gemma turn markers (thinking is channel-based *within* the turn, so these
  // boundary markers don't clip reasoning).
  gemma:      ['<end_of_turn>', '<start_of_turn>'],
  // Cohere Command R / R+ / R7B. Keyed by 'cohere' to match the family
  // identifier used in MODEL_REGISTRY / identify-model.ps1 / launch.bat —
  // the lookup is by activeModel.family.toLowerCase(), so the key has to
  // match exactly or getStopStrings() returns {} and the END_OF_TURN_TOKEN
  // marker leaks into the rendered output.
  cohere:     ['<|END_OF_TURN_TOKEN|>', '<|START_OF_TURN_TOKEN|>'],
  // tulu uses the same <|...|> role markers as its base.
  tulu:       ['<|user|>', '<|assistant|>', '<|system|>'],
  // harmony (gpt-oss), deepseek, granite, custom: intentionally no extra stops.
};

/**
 * Returns { stop: [...] } for the active model's family, or {} when we have no
 * safe delimiters to add (custom / reasoning formats). Spread into the request
 * body alongside the sampler params.
 */
function getStopStrings() {
  const fam = (activeModel && activeModel.family) ? String(activeModel.family).toLowerCase() : '';
  const stops = STOP_STRINGS_BY_FAMILY[fam];
  return (stops && stops.length) ? { stop: stops.slice() } : {};
}

/**
 * gobboDiag() — GROUND-TRUTH PROMPT DIAGNOSTIC.
 *
 * Eyeballing model output can't tell us what framing the model actually
 * received — only the server knows that. This pulls the two facts that settle
 * any "wrong template / garbage output" question:
 *
 *   1. GET  /props          -> the chat template llama-server actually loaded
 *                              (plus the tool-use template, if any).
 *   2. POST /apply-template -> the EXACT prompt string the model is fed for the
 *                              current conversation (formats, does not infer).
 *
 * If /apply-template shows the turns wrapped in '[INST]' but the model's own
 * output uses '<|user|>' / '<|assistant|>', the embedded template and the
 * model's training disagree — that's the bug, proven rather than guessed.
 *
 * Run it from the browser console (F12) after a bad reply:  gobboDiag()
 * The report is printed and copied to the clipboard when possible.
 */
async function gobboDiag() {
  const out = { when: new Date().toISOString(), model: null, family: null,
                stop: null, props: null, appliedPrompt: null, notes: [] };

  if (!IS_SERVED) {
    console.warn('[gobboDiag] Not served over http — open via the LAN/server URL, not file://. Cannot reach llama-server.');
    return out;
  }

  out.model  = (activeModel && activeModel.name)   || _currentModelFile || 'unknown';
  out.family = (activeModel && activeModel.family) || 'unknown';
  out.stop   = getStopStrings().stop || [];

  // 1) What template did the server actually load?
  try {
    const r = await fetch(LLAMA_URL + '/props', { cache: 'no-store' });
    if (r.ok) {
      const p = await r.json();
      out.props = {
        chat_template:          p.chat_template || '(none reported)',
        chat_template_tool_use: p.chat_template_tool_use || null,
        bos: (p.bos_token ?? (p.default_generation_settings && p.default_generation_settings.bos_token)) ?? null,
        eos: (p.eos_token ?? (p.default_generation_settings && p.default_generation_settings.eos_token)) ?? null,
        n_ctx: (p.default_generation_settings && (p.default_generation_settings.n_ctx ?? p.default_generation_settings.n_ctx_train)) ?? null
      };
    } else if (r.status === 401) {
      // The /llm/* proxy rejects this because the file-server login session
      // has expired (NOT a llama-server API key problem). Reload the page,
      // log in, and re-run gobboDiag().
      out.notes.push('/props returned 401 — your file-server login session has expired. Reload the page, log in again, then re-run gobboDiag().');
    } else {
      out.notes.push('/props returned ' + r.status);
    }
  } catch (e) {
    out.notes.push('/props fetch failed: ' + e.message);
  }

  // 2) What exact prompt does the current conversation produce?
  try {
    const thread = getActiveThread();
    // In a group chat, the prompt of whoever would reply next (js/29-groups.js).
    const card   = (thread && typeof replyCardForThread === 'function') ? replyCardForThread(thread) : getActiveCard();
    if (thread) {
      const { apiMessages } = await buildContextMessages(thread, card, { diag: true });
      const r = await fetch(LLAMA_URL + '/apply-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages })
      });
      if (r.ok) {
        const j = await r.json();
        out.appliedPrompt = (typeof j.prompt === 'string') ? j.prompt : JSON.stringify(j);
      } else if (r.status === 401) {
        const already = out.notes.some(n => n.indexOf('/props returned 401') === 0);
        if (!already) {
          out.notes.push('/apply-template returned 401 — file-server login session expired. Reload the page, log in, then re-run gobboDiag().');
        } else {
          out.notes.push('/apply-template also 401 (same session-expiry cause as /props).');
        }
      } else {
        out.notes.push('/apply-template returned ' + r.status + ' (older build? then use /props template above)');
      }
    } else {
      out.notes.push('no active thread — open a chat first to capture an applied prompt');
    }
  } catch (e) {
    out.notes.push('/apply-template fetch failed: ' + e.message);
  }

  // ---- pretty report ----
  const tmpl = out.props && out.props.chat_template ? out.props.chat_template : '(unknown)';
  const looksMistral = /\[INST\]|\[SYSTEM_PROMPT\]|\[AVAILABLE_TOOLS\]/.test(tmpl) || (out.appliedPrompt && /\[INST\]/.test(out.appliedPrompt));
  const looksPipe    = /<\|user\|>|<\|assistant\|>|<\|system\|>/.test(tmpl) || (out.appliedPrompt && /<\|user\|>|<\|assistant\|>/.test(out.appliedPrompt));
  const looksChatML  = /<\|im_start\|>/.test(tmpl) || (out.appliedPrompt && /<\|im_start\|>/.test(out.appliedPrompt));
  let verdict = 'inconclusive — compare the applied framing below against what the model emits';
  if (looksMistral && !looksPipe && !looksChatML) verdict = 'server is applying MISTRAL [INST] framing';
  else if (looksChatML) verdict = 'server is applying CHATML <|im_start|> framing';
  else if (looksPipe)   verdict = 'server is applying <|role|> (Zephyr/Tulu-style) framing';

  console.log('%c=== gobboDiag ===', 'font-weight:bold');
  console.log('model:  ' + out.model + '   family(client): ' + out.family);
  console.log('stop strings sent: ' + JSON.stringify(out.stop));
  console.log('verdict: ' + verdict);
  if (out.props) {
    console.log('--- /props ---');
    console.log('bos=' + out.props.bos + '  eos=' + out.props.eos + '  n_ctx=' + out.props.n_ctx);
    console.log('chat_template (server-loaded):\n' + tmpl);
    if (out.props.chat_template_tool_use) console.log('chat_template_tool_use present (tools variant differs).');
  }
  if (out.appliedPrompt != null) {
    console.log('--- /apply-template (EXACT prompt fed to model) ---');
    console.log(out.appliedPrompt);
  }
  if (out.notes.length) console.log('notes: ' + out.notes.join(' | '));

  try {
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    console.log('(full report copied to clipboard)');
  } catch (_) { /* clipboard may be blocked over plain http — report is above */ }

  return out;
}
// Expose for console use and log a one-time hint.
if (typeof window !== 'undefined') {
  window.gobboDiag = gobboDiag;
}

/* ================================================================
   BANNED PHRASES -> logit_bias (issue #51, the stand-in for CFG)

   Real classifier-free guidance needs the full logits of a second, negative
   prompt, and llama-server does not expose them over HTTP. What it does have
   is logit_bias, which covers the commonest thing people want from a negative
   prompt: "stop writing X". This is that, per card.

   logit_bias works per TOKEN, and that is the whole difficulty. The first
   version of this banned EVERY token of every case variant of every phrase.
   For a phrase that meant its ordinary words too -- "shivers down her spine"
   banned " her" and " down" everywhere -- and for a word that splits into
   pieces it meant fragments: "Chuckle" at the start of a line tokenizes as
   [Ch][uckle] on many models, and banning [Ch] took out every line starting
   with "Ch". It also re-tokenized every variant on every message.

   llama-server will also take a word as a string key and tokenize it
   itself, but it then biases every piece of it, which is the same fragment
   problem one step removed. So the page still tokenizes, and picks.

   Now:
     - A single word is banned at its own token, or at its leading piece
       when it splits and that piece carries most of the word. A piece too
       short to be the word's own ("Ch", "S"), or one that is a common word
       in its own right ("what" of "whatever"), is never banned.
     - A phrase is stopped at its rarest word -- its longest word that is not
       one of the commonest ones ("a mix of" at "mix"). When that word only
       splits into pieces too small to ban, the next longest is tried
       ("shivers down her spine" at "spine": " shivers" is [ sh][ivers] on
       every model checked). The word is then banned everywhere, which the
       editor's CHECK says in so many words. A phrase made only of common
       words is not banned at all.
     - Tokenization is cached per model, so after the first message a turn
       costs no extra requests.
     - At the slider's far end (-100) the bias is `false`, which llama-server
       reads as "never produce this token".
   CHECK in the card editor shows exactly what will be banned, with the model
   that is loaded.
================================================================ */
const BANNED_COMMON_WORDS = new Set(('a an the and or but nor so yet for of to in on at by with from into onto upon '
  + 'off out over under up down as than then that this these those there here i me my mine we us our ours you your '
  + 'yours he him his she her hers it its they them their theirs who whom whose which what when where why how is am '
  + 'are was were be been being have has had do does did not no yes if some any all can will would could should just '
  + 'like more most very also only even well one two').split(' '));
const BANNED_MAX_PHRASES = 200;
const _bannedTokenCache = new Map();   // model + '\u0000' + text -> [{ id, piece }]
const _bannedWordRe = () => /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function _bannedModelKey() {
  const file = (typeof _currentModelFile !== 'undefined' && _currentModelFile) || '';
  const am = (typeof activeModel !== 'undefined' && activeModel) || {};
  return file || am.id || am.name || 'unknown';
}

/* The phrases, one per line, trimmed, de-duplicated (any case), capped. */
function bannedPhraseList(raw) {
  const seen = new Set();
  const out = [];
  for (const line of String(typeof raw === 'string' ? raw : '').split('\n')) {
    const p = line.trim();
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
    if (out.length >= BANNED_MAX_PHRASES) break;
  }
  return out;
}

/* The words a phrase can be banned at, best first. A single word is itself
   -- the user asked for exactly that word. A phrase offers its words of three
   letters or more that are not among the commonest, longest (rarest) first,
   at most four; none when it has none. */
const BANNED_MAX_CANDIDATES = 4;
function bannedAnchorCandidates(phrase) {
  const words = String(phrase || '').match(_bannedWordRe()) || [];
  if (words.length === 1) return [words[0]];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (w.length < 3 || BANNED_COMMON_WORDS.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  // Array.prototype.sort is stable: equal lengths keep the phrase's order.
  return out.sort((a, b) => b.length - a.length).slice(0, BANNED_MAX_CANDIDATES);
}
/* The word a phrase is stopped at first; '' when it has none. */
function bannedAnchorWord(phrase) {
  return bannedAnchorCandidates(phrase)[0] || '';
}

/* The forms a word turns up in: as typed, lower, Title, UPPER, each with and
   without the leading space that marks a word in mid-sentence. */
function bannedVariants(word) {
  const lower = word.toLowerCase();
  const title = lower ? lower[0].toUpperCase() + lower.slice(1) : lower;
  const out = [];
  for (const b of [...new Set([word, lower, title, word.toUpperCase()])]) out.push(' ' + b, b);
  return out;
}

/* Which token, if any, bans `variant` given how it tokenizes. Its own token
   when it is one; otherwise its leading piece, when that piece is at least
   four letters, more than half the word (" Chuck" of "Chuckle", not " tape"
   of "tapestry"), and not itself a common word ("what" of "whatever") --
   never a fragment that other words share. Space-only
   pieces in front are skipped: some SentencePiece models tokenize " word" as
   [ ][ word]. null when there is nothing safe to ban, or when the engine did
   not say how the word splits (an older /tokenize without pieces). */
function bannedTokenFor(variant, toks) {
  if (!Array.isArray(toks)) return null;
  let i = 0;
  while (i < toks.length - 1 && toks[i] && typeof toks[i].piece === 'string' && toks[i].piece.trim() === '') i++;
  const rest = toks.slice(i);
  if (!rest.length || !rest[0]) return null;
  if (rest.length === 1) {
    // A lone space token is not the word, whatever it was asked for.
    if (typeof rest[0].piece === 'string' && rest[0].piece.trim() === '') return null;
    return { id: rest[0].id, piece: rest[0].piece, exact: true };
  }
  const piece = rest[0].piece;
  if (typeof piece !== 'string') return null;
  const letters = piece.trim();
  const word = String(variant).trim();
  if (letters.length >= 4 && letters.length * 2 > word.length && !BANNED_COMMON_WORDS.has(letters.toLowerCase())) {
    return { id: rest[0].id, piece, exact: false };
  }
  return null;
}

/* /tokenize with pieces, cached per model. Returns [{ id, piece }], or
   throws when the endpoint is not answering. parse_special is off: a banned
   word is plain text, and "<|im_end|>" typed into the list must not come back
   as the end-of-turn token. */
async function _bannedTokenize(text) {
  const key = _bannedModelKey() + '\u0000' + text;
  if (_bannedTokenCache.has(key)) return _bannedTokenCache.get(key);
  const resp = await privacyFetch(LLAMA_URL + '/tokenize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, with_pieces: true, parse_special: false })
  });
  if (!resp.ok) throw new Error('/tokenize returned ' + resp.status);
  const data = await resp.json();
  const toks = (Array.isArray(data && data.tokens) ? data.tokens : []).map(t =>
    (t && typeof t === 'object') ? { id: t.id, piece: typeof t.piece === 'string' ? t.piece : null } : { id: t, piece: null })
    .filter(t => Number.isInteger(t.id) && t.id >= 0);
  _bannedTokenCache.set(key, toks);
  if (_bannedTokenCache.size > 4000) _bannedTokenCache.delete(_bannedTokenCache.keys().next().value);
  return toks;
}

/* The tokens that ban one word in all its forms, and the forms that have
   nothing safe to ban. Its forms are tokenized together. Throws when
   /tokenize is not answering. */
async function _bannedPlanWord(word) {
  const variants = bannedVariants(word);
  const all = await Promise.all(variants.map(v => _bannedTokenize(v)));
  const tokens = [], unsafe = [], seen = new Set();
  variants.forEach((v, k) => {
    const t = bannedTokenFor(v, all[k]);
    if (!t) { unsafe.push(v); return; }
    if (!seen.has(t.id)) { seen.add(t.id); tokens.push(t); }
  });
  return { tokens, unsafe };
}

/* What a list of phrases bans with the loaded model. Returns
     { phrases: [{ phrase, anchor, tokens: [{ id, piece, exact }], unsafe: [variant],
                   skipped: [word] }], error }
   `anchor` is the word the phrase is stopped at, and `skipped` the better
   words tried first that had nothing safe to ban. `error` is set (and
   phrases empty) when /tokenize is not answering. The cache makes later
   turns free. */
async function planBannedPhrases(raw) {
  const phrases = [];
  for (const phrase of bannedPhraseList(raw)) {
    const cands = bannedAnchorCandidates(phrase);
    const row = { phrase, anchor: cands[0] || '', tokens: [], unsafe: [], skipped: [] };
    for (const word of cands) {
      let plan;
      try { plan = await _bannedPlanWord(word); }
      catch (e) { return { phrases: [], error: (e && e.message) || String(e) }; }
      if (plan.tokens.length) { row.anchor = word; row.tokens = plan.tokens; row.unsafe = plan.unsafe; break; }
      row.skipped.push(word);
      if (row.skipped.length === 1) row.unsafe = plan.unsafe;
    }
    phrases.push(row);
  }
  return { phrases, error: null };
}

/* The bias a card's strength sends. The slider runs -1..-100; anything else
   (an imported card, a hand-edited backup) is pulled back into that range, so
   a "banned" list can never PROMOTE its words. -100 is "ban outright":
   false, which llama-server reads as -infinity -- the token is never
   produced. */
function bannedBiasValue(strength) {
  let s = Number(strength);
  if (strength === undefined || strength === null || strength === '' || !isFinite(s)) s = -20;
  s = Math.min(-1, Math.max(-100, s));
  return s <= -100 ? false : s;
}

async function buildLogitBias(card) {
  const raw = (card && typeof card.bannedPhrases === 'string') ? card.bannedPhrases : '';
  if (!raw.trim()) return {};
  const plan = await planBannedPhrases(raw);
  if (plan.error) {
    console.warn('[logit_bias] /tokenize unavailable, skipping banned phrases:', plan.error);
    return {};
  }
  const value = bannedBiasValue(card.logitBiasStrength);
  const logitBias = {};
  for (const row of plan.phrases) for (const t of row.tokens) logitBias[String(t.id)] = value;
  const count = Object.keys(logitBias).length;
  if (!count) return {};
  console.log(`[logit_bias] Suppressing ${count} token IDs at ${value === false ? 'ban' : 'strength ' + value} (${plan.phrases.length} phrase(s))`);
  console.log('[logit_bias] Per-phrase breakdown:', plan.phrases.map(r => ({
    phrase: r.phrase, at: r.anchor || null, banned: r.tokens.map(t => t.piece), notSafeToBan: r.unsafe })));
  return { logit_bias: logitBias };
}

/* CHECK in the card editor: what the phrases typed there ban, with the model
   that is loaded, in words. Built as text, never HTML -- the phrases and the
   pieces are both user or model text. */
async function checkBannedPhrases() {
  const out = document.getElementById('banned-phrases-readout');
  const ta = document.getElementById('card-banned-phrases');
  if (!out || !ta) return;
  const raw = ta.value || '';
  if (!raw.trim()) { out.textContent = 'Nothing to check: the list is empty.'; return; }
  out.textContent = 'Checking with the loaded model…';
  const plan = await planBannedPhrases(raw);
  // The editor moved on (another card, or more typing) while this ran.
  if (ta.value !== raw) { out.textContent = 'The list changed while checking. Press CHECK again.'; return; }
  if (plan.error) {
    out.textContent = 'Can’t check: no model is answering (' + plan.error + '). Load a model and try again.';
    return;
  }
  const show = (p) => JSON.stringify(p == null ? '?' : p);
  const lines = [];
  const ids = new Set();
  for (const r of plan.phrases) {
    const isPhrase = (r.phrase.match(_bannedWordRe()) || []).length > 1;
    const quoted = (ws) => ws.map(w => '"' + w + '"').join(', ');
    if (!r.anchor) { lines.push(r.phrase + ' — not banned: every word in it is too common to ban without changing ordinary text.'); continue; }
    if (!r.tokens.length) {
      lines.push(r.phrase + ' — not banned: ' + (r.skipped.length > 1
        ? 'none of ' + quoted(r.skipped) + ' can be banned safely with this model; each splits into pieces too small or too common.'
        : '"' + r.anchor + '" splits into pieces too small or too common to ban safely with this model.'));
      continue;
    }
    for (const t of r.tokens) ids.add(t.id);
    let line = r.phrase + ' — ' + (isPhrase
      ? 'stopped at "' + r.anchor + '"' + (r.skipped.length ? ' (' + quoted(r.skipped) + ' split' + (r.skipped.length === 1 ? 's' : '') + ' too finely)' : '')
        + ', everywhere it appears, not only in this phrase: '
      : 'banned: ')
      + r.tokens.map(t => show(t.piece) + (t.exact ? '' : ' (start of the word)')).join(', ');
    if (r.unsafe.length) line += '. Left alone in ' + r.unsafe.length + ' form(s) that split too finely, e.g. ' + show(r.unsafe[0]) + '.';
    lines.push(line);
  }
  const value = bannedBiasValue(document.getElementById('card-logit-strength')?.value);
  lines.unshift(ids.size + ' token(s) ' + (value === false ? 'banned outright' : 'pushed down by ' + value)
    + ' with ' + _bannedModelKey() + ':');
  out.textContent = lines.join('\n');
}

function resetSamplerDefaults() {
  applySamplerPreset('precise');
}

/**
 * Apply one of three sampler presets to the card editor sliders.
 * Does NOT save — user still has to hit Save in the modal. This way
 * they can preview / tweak before committing.
 *
 *   precise  - factory defaults; deterministic, good for code & facts
 *   balanced - looser knobs; good general-purpose chat
 *   creative - high variety; XTC + DRY engaged; fiction & roleplay
 *
 * Designed against the observation that confident models (Gemma family
 * in particular) collapse to near-deterministic output under the tight
 * defaults. The Creative preset disables top_k and top_p, raises temp,
 * lowers min_p, swaps repeat_penalty for DRY, and turns on XTC.
 */
function applySamplerPreset(name) {
  const presets = {
    precise: {
      temperature: 0.7, minP: 0.05, topK: 40, topP: 0.95,
      repeatPenalty: 1.1, repeatLastN: 64,
      xtcProbability: 0, xtcThreshold: 0.1,
      dryMultiplier: 0
    },
    balanced: {
      temperature: 1.0, minP: 0.03, topK: 0, topP: 1.0,
      repeatPenalty: 1.05, repeatLastN: 64,
      xtcProbability: 0.3, xtcThreshold: 0.1,
      dryMultiplier: 0
    },
    creative: {
      temperature: 1.2, minP: 0.02, topK: 0, topP: 1.0,
      repeatPenalty: 1.0, repeatLastN: 64,
      xtcProbability: 0.5, xtcThreshold: 0.1,
      dryMultiplier: 0.8
    }
  };
  const p = presets[name] || presets.precise;

  const setSlider = (inputId, valId, value) => {
    const el = document.getElementById(inputId);
    if (el) el.value = value;
    const lbl = document.getElementById(valId);
    if (lbl) lbl.textContent = value;
  };

  setSlider('card-temperature',     'card-temp-val',          p.temperature);
  setSlider('card-min-p',           'card-minp-val',          p.minP);
  setSlider('card-top-p',           'card-topp-val',          p.topP);
  setSlider('card-repeat-penalty',  'card-rep-val',           p.repeatPenalty);
  setSlider('card-xtc-prob',        'card-xtc-prob-val',      p.xtcProbability);
  setSlider('card-xtc-threshold',   'card-xtc-threshold-val', p.xtcThreshold);
  setSlider('card-dry-mult',        'card-dry-mult-val',      p.dryMultiplier);
  // top-k and repeat-last-n are number inputs with no separate label
  const tk = document.getElementById('card-top-k');           if (tk) tk.value = p.topK;
  const rn = document.getElementById('card-repeat-last-n');   if (rn) rn.value = p.repeatLastN;
  // Auto Reroll's note depends on the temperature (1.8.0).
  if (typeof updateAutoRerollNote === 'function') updateAutoRerollNote();
}


/* ================================================================
   CHOOSING A SYNC TARGET

   The switch itself is the delicate part. Boot-time conflict resolution is
   tuned for "I just opened the page and something may have changed while I was
   away", and its heuristics are deliberately conservative -- in particular it
   will keep local and re-publish when the server copy is much smaller, on the
   grounds that a tiny newer snapshot is usually a mid-flight one.

   Reusing that here would be wrong, and quietly destructive. Pointing a device
   at a profile is not an ambiguous event that needs guessing at: the user has
   just said which pile of data they mean. So the switch asks a direct question
   instead, and the two answers are the only two things that can sensibly
   happen -- take what is in the slot, or put this device's data into it.
================================================================ */

/** What is on the server. Returns [] rather than throwing, because every
 *  caller is UI that should degrade to "nothing to show". */
async function fetchSyncProfiles() {
  if (!STATE_SYNC_AVAILABLE) return [];
  try {
    const resp = await fetch(STATE_SYNC_BASE + '/profiles', { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data && Array.isArray(data.profiles)) ? data.profiles : [];
  } catch (e) {
    console.warn('[sync] Could not list profiles:', e.message);
    return [];
  }
}

/** Metadata for one target without switching to it, so the UI can say what a
 *  slot holds before the user commits. */
async function fetchSyncTargetInfo(mode, profile) {
  if (!STATE_SYNC_AVAILABLE) return null;
  let url = STATE_SYNC_BASE + '/info';
  if (mode === 'profile') url += '?profile=' + encodeURIComponent(profile);
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (resp.status === 404) return { mtime: 0, size: 0 };
    if (noteLocked(resp)) return null;
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

/** Remove a stored backup from the server. */
async function deleteSyncProfile(name) {
  if (!STATE_SYNC_AVAILABLE) return false;
  const norm = name === '' ? '' : normalizeSyncProfile(name);
  if (name !== '' && !norm) return false;
  let url = STATE_SYNC_BASE;
  if (norm) url += '?profile=' + encodeURIComponent(norm);
  try {
    const resp = await fetch(url, { method: 'DELETE' });
    if (!resp.ok) return false;
    // A deleted backup is not one we have seen: leaving the old mtime behind
    // would make the next boot treat a freshly re-seeded file as "not newer"
    // and skip a restore that was owed.
    delete syncMtimeByTarget[norm || 'shared'];
    if ((norm || 'shared') === syncTargetLabel()) {
      stateSync.lastKnownMtime = 0;
    }
    persistSyncMeta();
    // Same reasoning one layer down: the per-conversation versions we were
    // holding described a file that no longer exists.
    invalidateLedger(norm || 'shared');
    return true;
  } catch (e) {
    console.warn('[sync] Delete failed:', e.message);
    return false;
  }
}

/**
 * Point this device at a different target.
 *
 * Returns one of 'unchanged' | 'off' | 'seeded' | 'restoring' | 'pushed' |
 * 'cancelled' | 'invalid', so the caller can report what actually happened
 * rather than assuming.
 */
async function applySyncTarget(mode, profileName) {
  if (!STATE_SYNC_AVAILABLE) return 'invalid';

  const profile = (mode === 'profile') ? normalizeSyncProfile(profileName) : '';
  if (mode === 'profile' && !profile) return 'invalid';
  if (mode !== 'off' && mode !== 'shared' && mode !== 'profile') return 'invalid';
  if (mode === syncTarget.mode && profile === syncTarget.profile) return 'unchanged';

  // Drop any queued push before the target moves. It would otherwise fire
  // against the new URL on the old schedule, which is a write the user did not
  // ask for at a moment they are still deciding.
  if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
  stateSync.pendingPush = false;

  syncTarget = { mode: mode, profile: profile };
  persistSyncTarget();
  // Per-target bookkeeping: adopt whatever we last knew about the NEW target,
  // not what we knew about the old one.
  stateSync.lastKnownMtime = syncMtimeByTarget[syncTargetLabel()] || 0;
  stateSync.lastError = null;

  if (mode === 'off') {
    stateSync.status = 'off';
    updateSyncIndicator();
    return 'off';
  }

  const info = await fetchSyncTargetInfo(mode, profile);
  const serverSize = (info && typeof info.size === 'number') ? info.size : 0;

  if (serverSize <= 0) {
    // Nothing there yet. Seeding is the only sensible reading of "use this
    // slot", and there is nothing to overwrite, so it needs no confirmation.
    stateSync.status = 'idle';
    // Whatever we last knew about this slot describes a file that is not there.
    invalidateLedger();
    scheduleStateSync();
    forceServerFlush();
    updateSyncIndicator();
    return 'seeded';
  }

  const when = info.mtime ? new Date(info.mtime).toLocaleString() : 'unknown';
  const sizeKB = Math.max(1, Math.round(serverSize / 1024));
  const label = (mode === 'profile') ? 'Profile "' + profile + '"' : 'The shared backup';
  const answer = confirm(
    label + ' already holds a backup.\n\n' +
    'Saved: ' + when + '\n' +
    'Size: ' + sizeKB + ' KB\n\n' +
    'OK\t\tLoad that backup onto this device (replaces what is here now).\n' +
    'Cancel\tKeep this device\u2019s data and overwrite the backup.'
  );

  if (answer) {
    stateSync.status = 'syncing';
    updateSyncIndicator();
    await restoreFromServer();
    return 'restoring';
  }
  stateSync.status = 'idle';
  // The user just said "keep this device's data and overwrite the backup".
  // Clearing the ledger makes the next push a whole-document replace, which is
  // what they asked for -- an incremental push would merge into a history this
  // device has never seen and leave the other device's chats behind.
  invalidateLedger(undefined, true);
  scheduleStateSync();
  forceServerFlush();
  updateSyncIndicator();
  return 'pushed';
}


/* ================================================================
   PER-CONVERSATION SYNC

   Everything above this line pushes one thing: the whole document. That was
   never subtle -- build the entire history, PUT it over whatever is there,
   last writer wins -- and it is why two devices cannot both use one backup.
   The one that saves second replaces the other's chats, and neither side has
   anything to notice that with. Not because the check is hard, but because a
   request that carries everything has no way to say "only this part".

   The server now addresses one conversation at a time
   (internal/state/threads.go). This is the client half of it:

     GET     /state/index                  what the server holds: ids,
                                           versions and message counts, and
                                           no message text at all
     GET     /state/threads/<id>           one conversation
     PUT     /state/threads/<id>           replace or create it
     POST    /state/threads/<id>/append    add messages to the end
     DELETE  /state/threads/<id>           remove it
     GET/PUT /state/meta                   everything that is not a
                                           conversation

   Every mutating request carries the version it believes it is changing, and
   the server refuses it otherwise (412, or 428 for no precondition at all).
   So "do not overwrite the other device's chats" stops being a rule this file
   has to remember to apply, and becomes something the protocol cannot express.

   -- THE LEDGER --------------------------------------------------
   Per target, per conversation, three facts recorded at the moment of a
   successful exchange:

     etag  the server's version token. Opaque -- we only ever echo back what
           we were handed, so the two sides never have to agree on how JSON is
           serialised, only on a token.
     n     how many messages it had then, which is where an append's tail
           starts.
     hash  a fingerprint of the copy the SERVER holds at that etag, which is
           the only way to tell "I have not touched this" from "I have".
           Recorded as what the server has rather than as what we had makes
           "dirty" mean "we differ from the backup" -- so a difference of any
           kind, including one that arrived by our own choice not to take
           theirs, is something the next push settles rather than something
           both sides sit on. At the moment of agreement the two readings are
           the same value; they part company only where we keep something.

   etag and hash together answer the only question that matters, per chat:

                          server etag unchanged   server etag moved
     local hash unchanged  nothing to do           pull it
     local hash moved      push it                 they both moved

   Three of those four resolve silently. The fourth is the only case where no
   default is honest, and it is the case the whole-document design could not
   even detect.

   The ledger lives in its own localStorage key for the same reason the sync
   target does: it describes THIS browser's relationship with the server, and
   a restore overwrites state.settings. A device that inherited another
   device's ledger would believe it had already sent chats it has never seen.

   -- WHAT THIS DELIBERATELY DOES NOT DO --------------------------
   No background polling. Every check is caused by something the user just did
   -- opening a conversation, or coming back to the tab. No device id, no
   writer log, no fingerprint of the machine: the comparison is between file
   versions, and the server never learns who asked. Only the index is fetched
   speculatively; a conversation's body is pulled on demand.
================================================================ */

// Set while a restore is about to reload the page. Between invalidateLedger()
// and the reload actually happening there is a window in which a queued push
// could fire, find no ledger, and seed the server with the pre-restore local
// state -- undoing the restore the user just asked for. Everything that writes
// checks this first.
let stateSyncReloading = false;

const SYNC_LEDGER_KEY = 'gobbonet_sync_ledger';
// { "<target label>": { seeded, meta, metaHash, threads: { id: {etag,n,hash} } } }
let syncLedger = {};
try {
  const savedLedger = JSON.parse(localStorage.getItem(SYNC_LEDGER_KEY) || 'null');
  if (savedLedger && typeof savedLedger === 'object' &&
      savedLedger.version === 1 && savedLedger.byTarget &&
      typeof savedLedger.byTarget === 'object') {
    syncLedger = savedLedger.byTarget;
  }
} catch (_) {}

/** The ledger for one target, created empty if this device has never used it.
 *  An empty ledger is not a problem to route around -- it is exactly the
 *  "seed me" state, and seeding is a real, explicit step. */
function ledgerFor(label) {
  let L = syncLedger[label];
  if (!L || typeof L !== 'object') {
    L = { seeded: false, meta: '', metaHash: '', threads: {} };
    syncLedger[label] = L;
  }
  if (!L.threads || typeof L.threads !== 'object') L.threads = {};
  return L;
}

function currentLedger() { return ledgerFor(syncTargetLabel()); }

function persistSyncLedger() {
  try {
    localStorage.setItem(SYNC_LEDGER_KEY,
      JSON.stringify({ version: 1, byTarget: syncLedger }));
  } catch (_) {
    // A ledger we cannot persist still works for this page's lifetime; the
    // next boot simply re-seeds. Nothing is lost, so this is not worth a
    // dialog -- but it is worth saying once.
    console.warn('[sync] Could not persist the sync ledger; the next boot will re-seed.');
  }
}

/** Forget the baseline for this target. Replacing an existing backup requires
 * an explicit user choice; losing a ledger alone never authorizes it. */
const overwriteSyncTargets = new Set();

function invalidateLedger(label, overwrite = false) {
  const key = label || syncTargetLabel();
  if (overwrite) overwriteSyncTargets.add(key);
  else overwriteSyncTargets.delete(key);
  syncLedger[key] = { seeded: false, meta: '', metaHash: '', threads: {} };
  persistSyncLedger();
}

/* -- Fingerprints ------------------------------------------------
   A fingerprint answers one question: is this conversation still exactly what
   I last sent? It is compared only against fingerprints this same code
   produced, so it needs no cryptographic strength -- but it does need two
   properties the obvious JSON.stringify() comparison lacks.

   It must be key-order independent, because a conversation that comes back
   from the server has been through Go's encoder, which sorts object keys. Two
   identical conversations would otherwise fingerprint differently and every
   comparison with the server's copy would report a conflict.

   And it must not build the string. A conversation carrying image attachments
   is megabytes -- js/18-utils.js stores them as full base64 data URLs on the
   message -- so the value is walked and fed to the accumulator directly rather
   than serialised first.

   cyrb53, 53 bits, one pass. */
function syncFingerprint() {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  return {
    add(str) {
      for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
    },
    done() {
      const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
    }
  };
}

// Walk a value into a fingerprint. Types are tagged so 1, "1" and true can
// never collide, and object keys are sorted so encoder differences do not
// register as content differences.
//
// undefined and functions are skipped exactly where JSON.stringify drops
// them, because the thing on the other side of the comparison has been
// through JSON and no longer has them either.
const FP_NULL = 'n', FP_NUM = 'd', FP_BOOL = 'b';
const FP_STR = 's', FP_OTHER = 'u', FP_ARR = '[';
const FP_OBJ = '{', FP_KEY = '', FP_MSG = '';

function fingerprintValue(fp, v) {
  if (v === null) { fp.add(FP_NULL); return; }
  const t = typeof v;
  if (t === 'number')  { fp.add(FP_NUM + v); return; }
  if (t === 'boolean') { fp.add(FP_BOOL + v); return; }
  if (t === 'string')  { fp.add(FP_STR + v.length + ':'); fp.add(v); return; }
  if (t !== 'object')  { fp.add(FP_OTHER); return; }
  if (Array.isArray(v)) {
    fp.add(FP_ARR + v.length + ':');
    for (const item of v) {
      // JSON.stringify writes null for a hole or an undefined element.
      if (item === undefined || typeof item === 'function') fp.add(FP_NULL);
      else fingerprintValue(fp, item);
    }
    return;
  }
  const keys = Object.keys(v)
    .filter(k => v[k] !== undefined && typeof v[k] !== 'function')
    .sort();
  fp.add(FP_OBJ + keys.length + ':');
  for (const k of keys) {
    fp.add(FP_KEY + k + '=');
    fingerprintValue(fp, v[k]);
  }
}

/**
 * Fingerprint one conversation, optionally only its first `upTo` messages.
 *
 * The truncated form is what makes append possible: if the local copy's first
 * n messages still fingerprint to what we recorded when the server was at n,
 * then everything after n is new and the tail is all we have to upload.
 *
 * The returned string carries the count as a prefix, so a fingerprint can
 * never be compared against one taken at a different length by accident.
 *
 * Runtime-only message fields are excluded, matching cleanThread() exactly --
 * they are stripped on the way out, so counting them here would leave any
 * thread with live parser state looking permanently dirty.
 */
function threadFingerprint(thread, upTo) {
  const msgs = (thread && Array.isArray(thread.messages)) ? thread.messages : [];
  const n = (upTo === undefined || upTo === null) ? msgs.length : Math.min(upTo, msgs.length);
  const head = { ...(thread || {}) };
  delete head.messages;
  const fp = syncFingerprint();
  fingerprintValue(fp, head);
  for (let i = 0; i < n; i++) {
    const m = msgs[i];
    let value = m;
    if (m && typeof m === 'object') {
      let runtime = false;
      for (const f of RUNTIME_MESSAGE_FIELDS) if (m[f] !== undefined) { runtime = true; break; }
      if (runtime) {
        value = { ...m };
        for (const f of RUNTIME_MESSAGE_FIELDS) delete value[f];
      }
    }
    fp.add(FP_MSG);
    fingerprintValue(fp, value);
  }
  return n + '-' + fp.done();
}

function metaFingerprint(meta) {
  const fp = syncFingerprint();
  fingerprintValue(fp, meta);
  return fp.done();
}

/** Strip the runtime-only fields from one message, for the wire. cleanThread
 *  does this for a whole conversation; an append sends a tail. */
function cleanMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const clean = { ...m };
  for (const f of RUNTIME_MESSAGE_FIELDS) delete clean[f];
  return clean;
}

/** The meta half of the blob with the API key removed, which is what actually
 *  goes to the server. Same redaction rule as redactedSyncJson(): the key
 *  stays in this browser, because the state file is readable by anything on
 *  the LAN. */
function redactedStateMeta() {
  const meta = buildStateMeta();
  if (meta && meta.settings) {
    meta.settings = { ...meta.settings };
    delete meta.settings.apiKey;
  }
  // Code does not travel in /state any more (1.7.9, F1): mods live on the PC
  // and are switched on there. An empty list is sent so a 1.7.8 device reading
  // this has nothing to run, and so a blob still held here never leaves.
  if (meta) meta.extensions = { enabled: false, styles: [], scripts: [] };
  return meta;
}

/* -- Addressability ----------------------------------------------
   A thread id becomes a URL path segment, so the client half of the server's
   rule (internal/state/threads.go, validThreadID) has to hold here too, with
   one extra constraint the server cannot express: a '/' in an id would be
   decoded back into a path separator and route the request somewhere else.

   generateId() never produces one. importData() takes ids straight out of
   whatever file the user picked, so one can arrive. When it does we do NOT
   quietly skip that conversation. Report it as an error and preserve both
   copies, rather than using an unconditional whole-document write that could
   erase another device's chats. */
function isAddressableThreadId(id) {
  if (typeof id !== 'string' || id === '' || id.indexOf('/') >= 0) return false;
  // The server's cap is 256 BYTES; count them rather than UTF-16 units.
  try {
    if (new TextEncoder().encode(id).length > 256) return false;
  } catch (_) {
    if (id.length > 256) return false;
  }
  for (const ch of id) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** The ids that cannot be addressed one at a time, or [] when all can. */
function unaddressableThreadIds() {
  const bad = [];
  for (const t of state.threads) if (!isAddressableThreadId(t && t.id)) bad.push(t && t.id);
  return bad;
}

/** A per-conversation URL for the current target. */
function threadSyncUrl(id, sub) {
  return stateSyncUrl('/threads/' + encodeURIComponent(id) + (sub ? '/' + sub : ''));
}

/* -- Talking to the server ---------------------------------------*/

/**
 * GET /state/index. Returns the parsed body, or null when there is nothing to
 * compare against (no file yet, sync off, or the request failed).
 *
 * Never throws: every caller is a user action that should degrade to "carry
 * on with what is on screen" rather than an error dialog. A genuine failure
 * still shows up on the indicator via the status it leaves behind.
 */
async function fetchStateIndex() {
  if (!syncEnabled()) return null;
  try {
    const resp = await fetch(stateSyncUrl('/index'), { cache: 'no-store' });
    if (resp.status === 404) {
      if (resp.headers.get('X-State-Protocol') !== '2') {
        throw new Error('Update the GobboNet server before using per-conversation sync.');
      }
      return null; // Confirmed absent on a server that enforces conditional writes.
    }
    if (!resp.ok) throw serverError(resp);
    const data = await resp.json();
    if (!data || !Array.isArray(data.threads)) throw new Error('malformed index');
    if (typeof data.mtime === 'number') {
      stateSync.lastKnownMtime = Math.max(stateSync.lastKnownMtime, data.mtime);
      persistSyncMeta();
    }
    if (data.unaddressable > 0) {
      // The server found conversations with no usable id. They round-trip
      // fine but can never be the target of a per-conversation request, so
      // say so rather than letting them look like they are syncing.
      console.warn('[sync] The server holds ' + data.unaddressable + ' conversation(s) ' +
                   'with no usable id. They are preserved but cannot be synced individually.');
    }
    return data;
  } catch (e) {
    console.warn('[sync] Index check failed:', e.message);
    if (stateSync.status !== 'locked') stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    throw e;
  }
}

/**
 * Interpret the answer to a conditional write.
 *
 * Returns { ok, etag, messages } on success and { conflict: true, etag,
 * messages } on a refused precondition, and throws for everything else --
 * because a 500 or a dropped connection is not a conflict and must not be
 * treated as one. The caller advances the ledger ONLY on ok, which is what
 * makes a replayed append safe: the server moved the version on, so the
 * replay's stale If-Match is refused rather than duplicating the messages.
 */
async function readWriteResult(resp) {
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 412 || resp.status === 428) {
    return {
      conflict: true,
      etag: (body && body.etag) || resp.headers.get('ETag') || '',
      messages: (body && typeof body.messages === 'number') ? body.messages : -1,
      reason: (body && body.error) || ('HTTP ' + resp.status)
    };
  }
  if (!resp.ok) {
    throw serverError(resp, (body && body.error) ? (body.error + ' (HTTP ' + resp.status + ')')
                                                 : ('HTTP ' + resp.status));
  }
  if (typeof body.mtime === 'number') {
    stateSync.lastKnownMtime = body.mtime;
    persistSyncMeta();
  }
  return {
    ok: true,
    etag: body.etag || resp.headers.get('ETag') || '',
    messages: (typeof body.messages === 'number') ? body.messages : -1
  };
}

/* -- Seeding -----------------------------------------------------*/

/**
 * Establish a baseline for the current target by publishing the whole
 * document once, then adopting the index it produces.
 *
 * This is the one remaining whole-document write, and it is deliberate. It
 * runs when this device has never synced with this target, after a restore,
 * and after the user explicitly chooses "overwrite the backup" -- all moments
 * where the user has either just said which copy wins or there is nothing to
 * lose. Every ordinary save after it is incremental.
 *
 * The write is conditional on the document version just read (or absence).
 * Thread baselines are established by content reconciliation, never by message
 * counts: an edited message can keep the same count with different content.
 */
async function seedWholeDocument(idx) {
  const label = syncTargetLabel();
  const json = redactedSyncJson();
  if (!json || json === '{}') throw new Error('nothing to seed with');
  // What this upload holds, taken in the same synchronous step as the body and
  // in the ledger's own terms: pushOneThread records the live copy's
  // fingerprint after a write, and so does this.
  const sent = new Map();
  for (const t of state.threads) {
    if (t && typeof t.id === 'string') {
      sent.set(t.id, { n: Array.isArray(t.messages) ? t.messages.length : 0, hash: threadFingerprint(t) });
    }
  }
  const sentMetaHash = metaFingerprint(redactedStateMeta());
  const headers = { 'Content-Type': 'application/json' };
  if (idx) {
    if (!idx.documentEtag) throw new Error('Server cannot safely replace this backup; update the server.');
    headers['If-Match'] = idx.documentEtag;
  } else headers['If-None-Match'] = '*';
  const resp = await fetch(stateSyncUrl(''), {
    method: 'PUT',
    headers,
    body: json
  });
  if (!resp.ok) {
    // A failed replacement is not permission to retry against a newer version.
    // Leave the changed backup intact and return to content reconciliation.
    if (resp.status === 412) overwriteSyncTargets.delete(label);
    throw serverError(resp, 'seed failed: HTTP ' + resp.status);
  }
  const data = await resp.json().catch(() => ({}));
  if (data && typeof data.mtime === 'number') {
    stateSync.lastKnownMtime = data.mtime;
    persistSyncMeta();
  }

  // Do not adopt versions fetched after the write: another device may have
  // changed the content without changing its message count. Reconcile instead.
  overwriteSyncTargets.delete(label);

  const L = ledgerFor(label);
  L.threads = {};
  L.meta = '';
  L.metaHash = sentMetaHash;
  // Record what was just written. Left empty, the pushes that follow in this
  // same pass tried to CREATE every conversation the upload had just created;
  // each was refused (412) and counted as a conflict, so switching into a new
  // profile, keeping this device's data over a backup, or turning sync back on
  // all ended in "chat conflict" -- 1.7.5 settled each of those silently.
  // Adopted only when the index describes exactly this upload: the same write
  // (mtime) and the same conversations with the same message counts. Anything
  // else means another write landed in between, and the ledger stays empty so
  // the ordinary conflict handling decides, as before.
  if (data && typeof data.mtime === 'number') {
    try {
      const after = await fetchStateIndex();
      if (syncTargetLabel() === label && after && after.mtime === data.mtime &&
          seededIndexMatches(after, sent)) {
        for (const e of after.threads) {
          const s = sent.get(e.id);
          L.threads[e.id] = { etag: e.etag, n: s.n, hash: s.hash };
        }
        L.meta = after.meta || '';
      }
    } catch (_) { /* unreadable index: keep the empty ledger */ }
  }
  L.seeded = true;
  persistSyncLedger();
  return true;
}

/** Does this index describe exactly the upload summarised in `sent`? Every
 *  addressable conversation present with the message count we sent, and
 *  nothing else. */
function seededIndexMatches(idx, sent) {
  if (!idx || !Array.isArray(idx.threads)) return false;
  let addressable = 0;
  for (const id of sent.keys()) if (isAddressableThreadId(id)) addressable++;
  if (idx.threads.length !== addressable) return false;
  for (const e of idx.threads) {
    const s = e && sent.get(e.id);
    if (!s || typeof e.etag !== 'string' || e.etag === '' || e.messages !== s.n) return false;
  }
  return true;
}

/** Make sure there is a baseline before anything incremental is attempted.
 *  Idempotent, and the only path that ever writes the whole document. */
async function ensureSyncLedger() {
  if (!syncEnabled() || stateSyncReloading) return false;
  const L = currentLedger();
  if (L.seeded) return true;
  const idx = await fetchStateIndex(); // Errors are not evidence of an empty server.
  if (overwriteSyncTargets.has(syncTargetLabel())) {
    await seedWholeDocument(idx);
    return true;
  }
  if (!idx) {
    if (!state.threads || state.threads.length === 0) {
      // Nothing on the server and no conversation here: nothing is seeded
      // (an empty device must not create the backup), and the first chat's
      // upload carries the settings with it. Say "idle" rather than leave the
      // indicator on "syncing..." for good, which is what a brand-new profile
      // showed from its first load until 1.7.9.
      if (stateSync.status === 'syncing') stateSync.status = 'idle';
      return false;
    }
    await seedWholeDocument(null);
    return true;
  }
  // A missing ledger is not permission to replace an existing backup. Start
  // with no claims about individual threads: their conditional writes and
  // reconcile path will compare actual contents, preserving unseen chats.
  L.threads = {};
  L.meta = idx.meta || '';
  L.metaHash = metaFingerprint(redactedStateMeta());
  L.seeded = true;
  persistSyncLedger();
  return true;
}

/* -- Pushing -----------------------------------------------------*/

/**
 * Send one conversation, if it has moved.
 *
 * Append when the shared prefix is untouched and only the tail grew -- which
 * is what a sent turn looks like, and the reason that route exists: with
 * image attachments stored as base64 on the message, re-uploading a whole
 * conversation to add two lines is the antipattern the append route removes.
 *
 * Anything else -- an edit, a reroll, a rename, a message deleted from the
 * middle -- replaces the conversation, still conditional on the version we
 * last saw.
 */
async function pushOneThread(thread, opts) {
  const L = currentLedger();
  const entry = L.threads[thread.id];
  const msgs = Array.isArray(thread.messages) ? thread.messages : [];
  const full = threadFingerprint(thread);
  if (entry && entry.hash === full) return 'unchanged';

  const keepalive = !!(opts && opts.keepalive);
  let result;
  if (entry && entry.hash && msgs.length > entry.n &&
      threadFingerprint(thread, entry.n) === entry.hash) {
    const tail = msgs.slice(entry.n).map(cleanMessage);
    const resp = await fetch(threadSyncUrl(thread.id, 'append'), {
      method: 'POST',
      keepalive: keepalive,
      headers: { 'Content-Type': 'application/json', 'If-Match': entry.etag },
      body: JSON.stringify(tail)
    });
    result = await readWriteResult(resp);
  } else {
    const headers = { 'Content-Type': 'application/json' };
    // No entry means we have never seen this conversation on the server, so
    // the honest precondition is "only if it is not there". If it IS there,
    // that is a conflict to reconcile, not a write to force.
    if (entry) headers['If-Match'] = entry.etag;
    else headers['If-None-Match'] = '*';
    const resp = await fetch(threadSyncUrl(thread.id), {
      method: 'PUT',
      keepalive: keepalive,
      headers: headers,
      body: JSON.stringify(cleanThread(thread))
    });
    result = await readWriteResult(resp);
  }

  if (result.conflict) return 'conflict';
  L.threads[thread.id] = { etag: result.etag, n: msgs.length, hash: full };
  persistSyncLedger();
  return 'sent';
}

/** Remove a conversation the user deleted here, if the server still holds the
 *  version we last saw. If it has moved on, another device added to it after
 *  we last looked -- that is a conflict, and deleting anyway would discard
 *  messages this device has never seen. */
async function deleteOneThread(id, opts) {
  const L = currentLedger();
  const entry = L.threads[id];
  if (!entry) return 'unchanged';
  const resp = await fetch(threadSyncUrl(id), {
    method: 'DELETE',
    keepalive: !!(opts && opts.keepalive),
    headers: { 'If-Match': entry.etag }
  });
  if (resp.status === 404) {
    // Already gone. Nothing to reconcile: the outcome is the one we wanted.
    delete L.threads[id];
    persistSyncLedger();
    return 'sent';
  }
  const result = await readWriteResult(resp);
  if (result.conflict) return 'conflict';
  delete L.threads[id];
  persistSyncLedger();
  return 'sent';
}

/**
 * Send the non-conversation half: settings, cards, personas, folders, macros.
 *
 * Last writer wins here, on purpose and with its limits stated. meta is small
 * and has no append shape, and stopping to ask about a settings change would
 * be worse than the thing it prevents. A refused precondition is therefore
 * resolved by taking the server's current version and writing over it, which
 * is exactly what the whole-document push did for every key in the file --
 * so it is not a regression, it is the old behaviour confined to the part
 * that cannot do better yet. Conversations, which is where the data is, no
 * longer work this way.
 *
 * What is left here is preference, and it is preference all the way down --
 * every field is one value the user chose, so the last device they chose it
 * on is the right answer. `threadOrder` was the exception, because a list of
 * every conversation id is not a preference and overwriting it discarded
 * other devices' conversations from the ordering. It is gone: a conversation
 * carries its own place in the list (js/04-state.js, CONVERSATION ORDER).
 */
async function pushMeta(opts) {
  const L = currentLedger();
  const meta = redactedStateMeta();
  const hash = metaFingerprint(meta);
  if (L.meta && L.metaHash === hash) return 'unchanged';

  const send = async (etag) => {
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const resp = await fetch(stateSyncUrl('/meta'), {
      method: 'PUT',
      keepalive: !!(opts && opts.keepalive),
      headers: headers,
      body: JSON.stringify(meta)
    });
    return readWriteResult(resp);
  };

  let result = await send(L.meta);
  if (result.conflict) {
    if (!result.etag) throw new Error('meta precondition failed with no version to retry against');
    console.warn('[sync] Settings changed on another device; this device takes precedence.');
    result = await send(result.etag);
    if (result.conflict) return 'conflict';
  }
  L.meta = result.etag;
  L.metaHash = hash;
  persistSyncLedger();
  return 'sent';
}

/**
 * The push half of a sync: send every conversation that moved here, remove
 * every one that was deleted here, and update meta.
 *
 * Deliberately silent about conflicts. A push is caused by a save -- the user
 * is typing, or a reply just landed -- and a dialog in the middle of that is
 * the wrong moment for a question they have been given no reason to expect.
 * Conflicts are recorded on the indicator and resolved by the next reconcile,
 * which runs on a conversation switch or on coming back to the tab, where a
 * question is expected.
 */
async function pushChangedConversations(opts) {
  if (!syncEnabled() || stateSyncReloading) return;
  if (!(await ensureSyncLedger())) return;

  const L = currentLedger();
  let sent = 0, conflicts = 0;

  let scanYieldAt = Date.now();
  for (const thread of state.threads) {
    // A large unchanged library can otherwise monopolize the UI thread.
    // Exit/keepalive sync must not wait on a timer during page teardown.
    if (!(opts && opts.keepalive) && Date.now() - scanYieldAt >= 8) {
      await new Promise(resolve => setTimeout(resolve, 0));
      // Input can change during the yield: never continue under another
      // target/restore ledger or publish a newly-started partial reply.
      if (!syncEnabled() || stateSyncReloading || currentLedger() !== L) return;
      if (stateSyncWouldBeTransient()) { scheduleStateSync(); return; }
      scanYieldAt = Date.now();
    }
    if (!state.threads.includes(thread)) continue;
    if (!isAddressableThreadId(thread.id)) {
      throw new Error('A chat has an imported ID that cannot be synced individually. Export it before changing its ID; no server history was replaced.');
    }
    const outcome = await pushOneThread(thread, opts);
    if (outcome === 'sent') sent++;
    else if (outcome === 'conflict') conflicts++;
  }
  const live = new Set(state.threads.map(t => t.id));
  const gone = Object.keys(L.threads).filter(id => !live.has(id) && !state.threads.some(t => t.id === id));
  if (opts && opts.keepalive) {
    // Leaving the page: start every DELETE now, together. One at a time, only
    // the first got out before the page was torn down -- the rest never ran,
    // so after deleting or purging several chats and closing the tab, all but
    // one came back from the server on the next load (1.7.8 too). DELETEs
    // carry no body, so keepalive's 64 KB budget is not a concern.
    const outcomes = await Promise.all(gone.map(id => deleteOneThread(id, opts).catch(() => 'error')));
    for (const outcome of outcomes) {
      if (outcome === 'sent') sent++;
      else if (outcome === 'conflict') conflicts++;
    }
  } else {
    for (const id of gone) {
      const outcome = await deleteOneThread(id, opts);
      if (outcome === 'sent') sent++;
      else if (outcome === 'conflict') conflicts++;
    }
  }
  if ((await pushMeta(opts)) === 'conflict') conflicts++;

  if (conflicts > 0) {
    stateSync.status = 'conflict';
    console.warn('[sync] ' + conflicts + ' conversation(s) changed here and on another ' +
                 'device. Open one to resolve it.');
  } else if (stateSync.status !== 'quota') {
    stateSync.status = 'ok';
  }
  if (sent) console.log('[sync] Pushed ' + sent + ' change(s).');
}

/* -- Comparing ---------------------------------------------------*/

/** One conversation without its place in the list, for a comparison that is
 *  about the messages. Returns the thread itself when there is nothing to
 *  strip, so the common case copies nothing. */
function orderlessThread(t) {
  if (!t || (t.order === undefined && t.orderActivity === undefined)) return t;
  const copy = { ...t };
  // Both halves of a placement (js/04-state.js, CONVERSATION ORDER): where it
  // sits, and the activity it was placed against. Neither is about messages.
  delete copy.order;
  delete copy.orderActivity;
  return copy;
}

/**
 * How two copies of one conversation are related.
 *
 *   'same'         identical, whatever the versions say
 *   'local-ahead'  the server's copy is a prefix of ours: we appended
 *   'server-ahead' our copy is a prefix of the server's: they appended
 *   'diverged'     neither contains the other
 *
 * This is what keeps the prompt rare and honest. A refused precondition only
 * means the version moved; it does not say the content disagrees. The common
 * causes -- an append whose response we never received, or two devices that
 * each added to the same chat in turn -- all resolve here without asking
 * anyone anything. Only a genuine fork reaches the user.
 *
 * `order` is deliberately left out of the comparison. Where a conversation
 * sits in the list is one number, a drag is the lightest gesture in the app,
 * and none of that may turn "they replied while I rearranged" into a question
 * about which copy of the messages to keep -- it would not even be a prompt
 * the user could answer, since both sides show the same messages. It is
 * settled by whoever writes last, the way the preferences in meta are: the
 * ledger records what the server holds, so a device that keeps its own number
 * is left dirty and its next push carries it. The messages are what this
 * function is for.
 */
/* The fields applyLoadedState() gives every conversation that lacks them
   ("Migrate threads: add folder/pin/tag/branch fields if missing"), with the
   values it gives. A copy that has been through a load and one that has not
   differ only in these, which is not a difference in the conversation: a
   chat created by an integration (docs/state-integration.md needs only an id
   and messages), an import, or an older client arrives without them, and the
   first device to load it would otherwise report it as changed in ways that
   cannot be combined. Kept equal to the loader by tests/test-device-sync.mjs. */
const THREAD_LOAD_DEFAULTS = { pinned: false, folderId: null, tags: [], forkSource: null };

/** A conversation as it compares: without its place in the list, and with
 *  any missing load-time default filled in exactly as a load would fill it.
 *  A value that differs from the default is still a difference. */
function comparableThread(t) {
  t = orderlessThread(t);
  if (!t) return t;
  let copy = null;
  for (const k of Object.keys(THREAD_LOAD_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(t, k)) {
      if (!copy) copy = { ...t };
      copy[k] = THREAD_LOAD_DEFAULTS[k];
    }
  }
  return copy || t;
}

function relateThreads(local, server) {
  local = comparableThread(local);
  server = comparableThread(server);
  const fpLocal = threadFingerprint(local);
  const fpServer = threadFingerprint(server);
  if (fpLocal === fpServer) return 'same';
  const nLocal = Array.isArray(local.messages) ? local.messages.length : 0;
  const nServer = Array.isArray(server.messages) ? server.messages.length : 0;
  if (nServer < nLocal && threadFingerprint(local, nServer) === fpServer) return 'local-ahead';
  if (nLocal < nServer && threadFingerprint(server, nLocal) === fpLocal) return 'server-ahead';
  return 'diverged';
}

/** Fetch one conversation and its version. Returns null on any failure --
 *  every caller has a sane "leave it alone for now" path. */
async function fetchOneThread(id) {
  try {
    const resp = await fetch(threadSyncUrl(id), { cache: 'no-store' });
    if (!resp.ok) return null;
    const thread = await resp.json();
    if (!thread || typeof thread !== 'object') return null;
    return { thread: thread, etag: resp.headers.get('ETag') || '' };
  } catch (e) {
    console.warn('[sync] Could not fetch conversation ' + id + ':', e.message);
    return null;
  }
}

/* -- Applying what the server has --------------------------------*/

/** Replace (or add) one conversation locally. Returns true when the visible
 *  view needs repainting; the sidebar sorts itself, since where a conversation
 *  sits is a number on the conversation (js/04-state.js).
 *
 *  serverHash is what the server holds, which is normally the thread we are
 *  adopting -- pass it explicitly when we kept something of ours, so the
 *  ledger records the backup rather than the merge and the difference shows
 *  up as ours to push. */
function applyPulledThread(thread, etag, serverHash) {
  const L = currentLedger();
  const i = state.threads.findIndex(t => t.id === thread.id);
  if (i >= 0) state.threads[i] = thread;
  else state.threads.push(thread);
  const n = Array.isArray(thread.messages) ? thread.messages.length : 0;
  L.threads[thread.id] = {
    etag: etag, n: n,
    hash: (serverHash === undefined) ? threadFingerprint(thread) : serverHash
  };
  persistSyncLedger();
  return state.activeThreadId === thread.id;
}

/** Remove one conversation locally because it was deleted elsewhere. */
function applyRemoteDelete(id) {
  const L = currentLedger();
  state.threads = state.threads.filter(t => t.id !== id);
  delete L.threads[id];
  persistSyncLedger();
  // The record has to go from IndexedDB too. The 'threads' store is keyed by
  // id and a full save only ever puts, so a record left behind would be read
  // straight back into state on the next boot and the conversation would
  // reappear.
  if (STORAGE_BACKEND === 'idb') {
    idbDelete('threads', id).catch(e =>
      console.warn('[sync] Could not remove thread record ' + id + ':', e && e.message));
  }
  if (state.activeThreadId === id) {
    state.activeThreadId = null;   // land on the dashboard rather than a blank chat
    return true;
  }
  return false;
}

/* -- Resolving a real fork ---------------------------------------*/

/**
 * Ask about ONE conversation. The scope is the point: the old prompt offered
 * to replace an entire history because that was the only unit it had, so
 * "yes" and "no" both meant discarding something the user had not been shown.
 * This names the chat, says what is on each side, and affects nothing else.
 */
function resolveThreadConflict(local, server, serverEtag) {
  const name = (local && local.name) || (server && server.name) || 'this chat';
  const nLocal = Array.isArray(local.messages) ? local.messages.length : 0;
  const nServer = Array.isArray(server.messages) ? server.messages.length : 0;
  const answer = confirm(
    '“' + name + '” changed here and on another device, in ways that ' +
    'cannot be combined automatically.\n\n' +
    'On this device: ' + nLocal + ' message(s)\n' +
    'On the server:  ' + nServer + ' message(s)\n\n' +
    'OK\t\tTake the server’s version of this chat.\n' +
    'Cancel\tKeep this device’s version and overwrite the server’s.\n\n' +
    'Only this chat is affected either way.'
  );
  if (answer) return applyPulledThread(server, serverEtag);
  // Keep local. Adopt the server's version token so the next push replaces it
  // rather than failing the precondition again, and clear the hash so that
  // push is a replace rather than an append onto a history we are discarding.
  const L = currentLedger();
  L.threads[local.id] = { etag: serverEtag, n: nServer, hash: '' };
  persistSyncLedger();
  stateSync.pendingPush = true;
  return false;
}

/* -- The check itself --------------------------------------------*/

let reconcileInFlight = false;

/**
 * Ask the server what it holds and fold in anything new.
 *
 * Called on a conversation switch and on coming back to the tab -- never on a
 * timer. A poll would generate traffic nobody asked for and would have to run
 * while the user is reading; a switch is already a moment where a beat of
 * latency is expected and where the user has just said which conversation
 * they care about.
 *
 * opts.focus  a conversation id to settle first, so switching into a chat
 *             resolves that chat before anything else moves on screen.
 */
async function reconcileWithServer(opts) {
  opts = opts || {};
  if (!syncEnabled() || stateSyncReloading) return;
  if (reconcileInFlight) return;
  // A reconcile can replace the active conversation's messages array. Doing
  // that under a running generation would write tokens into an object that is
  // no longer the one on screen.
  if (typeof isGenerating !== 'undefined' && isGenerating) return;
  const L = currentLedger();
  if (!L.seeded) return;             // no baseline yet; the push path seeds

  reconcileInFlight = true;
  try {
    const idx = await fetchStateIndex();
    if (!idx) return;

    const serverById = new Map(idx.threads.map(e => [e.id, e]));
    let repaint = false, pulled = 0, removed = 0, conflicts = 0;

    // Order matters only for the conversation the user just opened: settle
    // that one first so the view stops changing under them.
    const entries = idx.threads.slice().sort((a, b) =>
      (b.id === opts.focus ? 1 : 0) - (a.id === opts.focus ? 1 : 0));

    for (const entry of entries) {
      const local = state.threads.find(t => t.id === entry.id);
      const known = L.threads[entry.id];

      if (!local) {
        // Not here. Either it is new to this device, or we deleted it.
        if (!known) {
          const got = await fetchOneThread(entry.id);
          if (got) { applyPulledThread(got.thread, got.etag); pulled++; repaint = true; }
        } else if (known.etag === entry.etag) {
          // We deleted it and the server still holds exactly what we saw.
          // The push path owns that; leave it alone here.
          stateSync.pendingPush = true;
        } else {
          // We deleted it, someone else extended it. Bring it back rather
          // than discard messages this device has never seen, and let the
          // user delete it again if that is still what they want.
          const got = await fetchOneThread(entry.id);
          if (got) {
            applyPulledThread(got.thread, got.etag);
            pulled++; repaint = true;
            console.warn('[sync] "' + (got.thread.name || entry.id) + '" was deleted here but ' +
                         'extended on another device -- restored rather than dropped.');
          }
        }
        continue;
      }

      const moved = !known || known.etag !== entry.etag;
      const dirty = !known || known.hash !== threadFingerprint(local);
      if (!moved) {
        if (dirty) stateSync.pendingPush = true;   // ours to push
        continue;
      }
      if (!dirty && known) {
        // Server moved, we have not touched it: take theirs, no questions.
        const got = await fetchOneThread(entry.id);
        if (!got) continue;
        if (applyPulledThread(got.thread, got.etag)) repaint = true;
        pulled++;
        continue;
      }

      // Both sides moved -- or we have no record of this one at all. A moved
      // version is not by itself a disagreement about content, so find out
      // what it actually is before asking anyone anything.
      const got = await fetchOneThread(entry.id);
      if (!got) continue;
      const relation = relateThreads(local, got.thread);
      const nServer = Array.isArray(got.thread.messages) ? got.thread.messages.length : 0;
      if (relation === 'same') {
        // Identical after all: an append whose response we never received, or
        // a re-encoding. Adopt the version and say nothing. The hash is the
        // server's own copy, so if the one thing still differing is where the
        // conversation sits in the list, this device reads as dirty and the
        // next push settles it -- silently, because there is nothing about
        // the messages for anyone to decide.
        L.threads[entry.id] = { etag: got.etag, n: nServer, hash: threadFingerprint(got.thread) };
        persistSyncLedger();
        if (L.threads[entry.id].hash !== threadFingerprint(local)) stateSync.pendingPush = true;
      } else if (relation === 'server-ahead') {
        // Their messages, our place in the list. Taking their copy wholesale
        // would undo a drag made on this device, and the ordering is the one
        // field on a conversation that can be merged without guessing -- so
        // keep ours, and record the server's fingerprint so the push carries
        // it back.
        const serverHash = threadFingerprint(got.thread);
        // The placement travels as a pair: an order kept from this device with
        // the other device's activity mark would float, or pin, on the wrong
        // evidence.
        if (local.order !== undefined &&
            (local.order !== got.thread.order || local.orderActivity !== got.thread.orderActivity)) {
          got.thread.order = local.order;
          if (local.orderActivity !== undefined) got.thread.orderActivity = local.orderActivity;
          else delete got.thread.orderActivity;
          stateSync.pendingPush = true;
        }
        if (applyPulledThread(got.thread, got.etag, serverHash)) repaint = true;
        pulled++;
      } else if (relation === 'local-ahead') {
        // We hold everything the server has, plus more. Record its version and
        // its fingerprint so the push appends onto it -- and so that if our
        // copy also sits somewhere else in the list, the fingerprints differ
        // at the head and the push replaces instead, because the append route
        // only ever adds messages and could never carry that.
        L.threads[entry.id] = { etag: got.etag, n: nServer, hash: threadFingerprint(got.thread) };
        persistSyncLedger();
        stateSync.pendingPush = true;
      } else {
        conflicts++;
        if (resolveThreadConflict(local, got.thread, got.etag)) repaint = true;
      }
    }

    // A conversation we hold that the server no longer has.
    for (const thread of state.threads.slice()) {
      if (serverById.has(thread.id)) continue;
      const known = L.threads[thread.id];
      if (!known) { stateSync.pendingPush = true; continue; }   // never sent; push creates it
      if (known.hash && known.hash === threadFingerprint(thread)) {
        // Unchanged since the version we and the server agreed on, and now
        // gone from the server: it was deleted on another device, and there
        // is nothing here that removing it would lose.
        if (applyRemoteDelete(thread.id)) repaint = true;
        removed++;
      } else {
        // Deleted there, changed here. Keep it and re-create it; the local
        // changes are real, and the delete can simply be repeated.
        delete L.threads[thread.id];
        persistSyncLedger();
        stateSync.pendingPush = true;
        console.warn('[sync] "' + (thread.name || thread.id) + '" was deleted on another ' +
                     'device but has unsent changes here -- keeping it.');
      }
    }

    if (pulled || removed) {
      console.log('[sync] Folded in ' + pulled + ' updated conversation(s)' +
                  (removed ? ', removed ' + removed : '') + ' from ' + syncTargetLabel() + '.');
      saveState();
      if (typeof render === 'function' && repaint) render();
      else if (typeof renderSidebar === 'function') renderSidebar();
    }
    if (conflicts > 0) stateSync.status = 'conflict';
    else if (stateSync.status !== 'quota') stateSync.status = 'ok';
    updateSyncIndicator();
    if (stateSync.pendingPush) forceServerFlush();
  } finally {
    reconcileInFlight = false;
  }
}
