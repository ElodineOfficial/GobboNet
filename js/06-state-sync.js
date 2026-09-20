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
  return STATE_SYNC_AVAILABLE && !syncIsOff();
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
function noteLocked(resp) {
  if (!resp || resp.status !== 401) return false;
  if (stateSync.status === 'locked') return true;   // already asking

  stateSync.status = 'locked';
  stateSync.lastError = 'signed out';
  // Cancel the retry. Re-armed by resumeAfterUnlock() once we are back in.
  if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
  updateSyncIndicator();
  showUnlockModal();
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
  const err = document.getElementById('unlock-error');
  if (err) { err.textContent = ''; err.style.display = 'none'; }
  modal.classList.add('open');
  const field = document.getElementById('unlock-password');
  if (field) { field.value = ''; setTimeout(() => field.focus(), 50); }
}

function hideUnlockModal() {
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
// Loop guard for the silent auto-restore paths below. A silent restore ends in
// location.reload(), so any backup that never satisfies the boot check after
// being applied (e.g. a thread-less or otherwise non-converging blob) would
// reload-loop forever. sessionStorage survives reloads but is cleared when the
// tab closes, so this caps boot-time silent auto-restores at one per tab
// session: if the first attempt didn't make the page converge, we stop trying
// and leave local as-is rather than thrash. A real restore (server actually has
// chats) converges on its first reload — localEmpty becomes false and we never
// consult the guard again — so legitimate cross-device restore is unaffected.
function bootRestoreAlreadyTried() {
  try { return !!sessionStorage.getItem('gobbonet_boot_restore_attempted'); }
  catch (_) { return false; }
}
function markBootRestoreTried() {
  try { sessionStorage.setItem('gobbonet_boot_restore_attempted', '1'); }
  catch (_) {}
}
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
    // Auto-restore — nothing to lose
    if (bootRestoreAlreadyTried()) {
      console.warn('[sync] Skipping boot auto-restore: already attempted this ' +
                   'session (loop guard). Server backup may have no threads.');
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      console.log('[sync] Local empty, restoring from server backup');
      markBootRestoreTried();
      await restoreFromServer({ silent: true });
    }
  } else if (!localEmpty && !serverIsNewer && serverHasMore) {
    // Quota-truncation recovery (the bug this fix targets). The server copy
    // is complete and is not a competing newer edit, so pull it back and the
    // replies that never fit into localStorage reappear. restoreFromServer
    // applies in memory if it still cannot fit locally.
    if (bootRestoreAlreadyTried()) {
      console.warn('[sync] Skipping quota-recovery restore: already attempted ' +
                   'this session (loop guard).');
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      console.warn('[sync] Local copy (' + localSize + ') smaller than server backup (' +
                   serverSize + ') with no newer remote edit — recovering full history ' +
                   'from server (local was truncated by the storage quota).');
      markBootRestoreTried();
      await restoreFromServer({ silent: true });
    }
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
      await showRestorePrompt(info);
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
    if (!parsed || typeof parsed !== 'object') throw new Error('malformed backup');

    // /state is a single shared document every paired device can overwrite, so
    // this blob is not necessarily something this user wrote. Clear the flags
    // that would make boot execute code out of it; the code itself is kept so
    // it can be read and switched on here. See neutralizeUntrustedCode.
    //
    // The typeof guard is deliberate: 23-card-code.js loads after this file,
    // and a load-order change should not turn into a hard failure on the
    // restore path.
    const neutralized = (typeof neutralizeUntrustedCode === 'function')
      ? neutralizeUntrustedCode(parsed)
      : { cards: 0, extensions: false };
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

    // Loop stopper: a backup with no threads must NEVER trigger a reload. The
    // boot check treats "local has no threads" as a reason to restore, so
    // reloading into a thread-less restore lands right back in that branch ->
    // check/reload thrash. There is nothing to recover from an empty backup, so
    // sync the mtime, mark the backend in good standing, and return without
    // reloading. (Settings-only backups are non-zero bytes, which is exactly
    // why the size-based boot check can't catch this and we must catch it here.)
    const restoredThreads = Array.isArray(parsed.threads) ? parsed.threads : [];
    if (restoredThreads.length === 0) {
      if (mtimeHeader) {
        stateSync.lastKnownMtime = parseInt(mtimeHeader, 10) || stateSync.lastKnownMtime;
        persistSyncMeta();
      }
      stateSync.status = 'ok';
      updateSyncIndicator();
      console.warn('[sync] Server backup has no threads — nothing to restore; ' +
                   'not reloading (loop stopper).');
      if (!opts.silent) alert('The server backup contains no chats — nothing to restore.');
      return false;
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
      await idbPut('meta', metaPartOf(parsed), 'app');
      await idbClearThreads();
      await idbBulkPutThreads(parsed.threads || []);
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

async function showRestorePrompt(info) {
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
    await restoreFromServer();
  } else {
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
    const card   = getActiveCard();
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

/**
 * Tokenize banned phrases and build a logit_bias object for the API request.
 * Tries the llama.cpp /tokenize endpoint; if unavailable, skips silently.
 *
 * NOTE on capitalization: BPE/SentencePiece tokenizers encode case INSIDE
 * the token — `[ blue]` and `[ Blue]` are different IDs. An earlier version
 * of this function only generated lowercase variants, which silently let
 * the banned word through whenever it landed at the start of a sentence,
 * proper-noun position, after a quote, etc. We now generate 8 variants
 * per phrase: {lower, Title, UPPER, as-typed} x {no-space, leading-space}.
 *
 * CEILING (worth knowing): logit_bias only suppresses canonical token IDs.
 * The model can still emit the same surface string via a multi-token
 * decomposition (e.g. "blue" -> [bl][ue]). For a hard string-level ban,
 * use a GBNF grammar or a streaming post-filter — neither is wired up here.
 *
 * Returns { logit_bias: {"tokenId": strength, ...} } or {} if nothing to bias.
 */
async function buildLogitBias(card) {
  const raw = (card && card.bannedPhrases) ? card.bannedPhrases.trim() : '';
  if (!raw) return {};

  const phrases = raw.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  if (phrases.length === 0) return {};

  const strength = (card.logitBiasStrength !== undefined) ? Number(card.logitBiasStrength) : -20;
  const logitBias = {};
  const tokenizeUrl = LLAMA_URL + '/tokenize';

  // Per-phrase debug record so the user can see exactly what got banned.
  // Keyed by phrase, value is { variants: [...], tokenIds: [...] }.
  const debugByPhrase = {};

  // Build full case-coverage variant set. Title-case fills the gap that
  // bit us before (capitalized at sentence start, dialogue, proper nouns).
  function caseVariants(phrase) {
    const lower = phrase.toLowerCase();
    const upper = phrase.toUpperCase();
    // Title-case the first character; leave the rest of the lowered form
    // as-is so multi-word phrases don't get mangled (we want "Blue sky",
    // not "Blue Sky", since the second word's banned token usually starts
    // with a space character anyway).
    const title = lower.length ? lower[0].toUpperCase() + lower.slice(1) : lower;
    const bases = [...new Set([phrase, lower, title, upper])];
    const out = [];
    for (const b of bases) {
      out.push(b);
      out.push(' ' + b);
    }
    return [...new Set(out)];
  }

  for (const phrase of phrases) {
    const variants = caseVariants(phrase);
    debugByPhrase[phrase] = { variants, tokenIds: [] };

    for (const variant of variants) {
      try {
        const resp = await privacyFetch(tokenizeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: variant })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.tokens && Array.isArray(data.tokens)) {
          for (const id of data.tokens) {
            logitBias[String(id)] = strength;
            debugByPhrase[phrase].tokenIds.push(id);
          }
        }
      } catch (e) {
        // Tokenizer endpoint not available — skip gracefully
        console.warn('[logit_bias] /tokenize unavailable, skipping banned phrases:', e.message);
        return {}; // No point retrying every variant if the endpoint is down
      }
    }
  }

  const count = Object.keys(logitBias).length;
  if (count > 0) {
    console.log(`[logit_bias] Suppressing ${count} token IDs at strength ${strength} (${phrases.length} phrase(s))`);
    console.log('[logit_bias] Per-phrase breakdown:', debugByPhrase);
    return { logit_bias: logitBias };
  }
  return {};
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
  invalidateLedger();
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

/** Forget everything we believed about a target. The next push re-seeds it
 *  with a whole-document write, which is the only honest baseline when we no
 *  longer know what the server holds. */
function invalidateLedger(label) {
  const key = label || syncTargetLabel();
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
  return meta;
}

/* -- Addressability ----------------------------------------------
   A thread id becomes a URL path segment, so the client half of the server's
   rule (internal/state/threads.go, validThreadID) has to hold here too, with
   one extra constraint the server cannot express: a '/' in an id would be
   decoded back into a path separator and route the request somewhere else.

   generateId() never produces one. importData() takes ids straight out of
   whatever file the user picked, so one can arrive. When it does we do NOT
   quietly skip that conversation -- a chat that silently stops syncing is the
   worst possible failure here -- we fall the whole target back to the
   whole-document write, which is exactly as correct as it was before these
   routes existed, and say so. */
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
    if (resp.status === 404) return null;          // no backup on this target yet
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
    stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    return null;
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
 * An entry is adopted only when the server's message count agrees with ours.
 * Another device could have written between the PUT and the index fetch; a
 * count that disagrees proves it did, and claiming agreement we have not
 * verified is the one thing a ledger must never do. Unadopted conversations
 * are simply absent from the ledger, which the next reconcile treats as
 * "compare properly" rather than as an error.
 */
async function seedWholeDocument() {
  const label = syncTargetLabel();
  const json = redactedSyncJson();
  if (!json || json === '{}') throw new Error('nothing to seed with');
  const resp = await fetch(stateSyncUrl(''), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json
  });
  if (!resp.ok) throw serverError(resp, 'seed failed: HTTP ' + resp.status);
  const data = await resp.json().catch(() => ({}));
  if (data && typeof data.mtime === 'number') {
    stateSync.lastKnownMtime = data.mtime;
    persistSyncMeta();
  }

  const idx = await fetchStateIndex();
  if (!idx) throw new Error('seeded, but could not read the index back');

  const L = ledgerFor(label);
  L.threads = {};
  let skipped = 0;
  for (const entry of idx.threads) {
    const local = state.threads.find(t => t.id === entry.id);
    if (!local) continue;
    const n = Array.isArray(local.messages) ? local.messages.length : 0;
    if (entry.messages !== n) { skipped++; continue; }
    L.threads[entry.id] = { etag: entry.etag, n: n, hash: threadFingerprint(local) };
  }
  L.meta = idx.meta || '';
  L.metaHash = metaFingerprint(redactedStateMeta());
  L.seeded = true;
  persistSyncLedger();
  console.log('[sync] Baseline established for "' + label + '": ' +
              Object.keys(L.threads).length + ' conversation(s)' +
              (skipped ? ', ' + skipped + ' left to reconcile' : ''));
  return true;
}

/** Make sure there is a baseline before anything incremental is attempted.
 *  Idempotent, and the only path that ever writes the whole document. */
async function ensureSyncLedger() {
  if (!syncEnabled() || stateSyncReloading) return false;
  const L = currentLedger();
  if (L.seeded) return true;
  // Seeding is a whole-document overwrite, so the two cases where it would
  // destroy something have to be ruled out before it runs.
  const localCount = state.threads ? state.threads.length : 0;
  const idx = await fetchStateIndex();
  if (!idx) {
    // Nothing here and nothing there: seeding would create a state file for
    // someone who has not typed anything yet, which is a write nobody asked
    // for. The first real save seeds instead.
    if (localCount === 0) return false;
  } else if (localCount === 0 && idx.threads.length > 0) {
    // The server holds conversations and this device holds none. Publishing
    // the emptiness over them is exactly the failure this whole design exists
    // to remove. Which copy wins when the two disagree is checkServerStateOnBoot's
    // decision -- it restores -- and never this function's.
    console.warn('[sync] Not seeding: this device has no conversations and the server has ' +
                 idx.threads.length + '. Waiting for the boot check to resolve that.');
    return false;
  }
  const bad = unaddressableThreadIds();
  if (bad.length) {
    // Seeding is the whole-document write, so it is the correct thing to do
    // here anyway -- but the ledger must not end up marked seeded, or the
    // next save would try to address a conversation that has no address.
    console.warn('[sync] ' + bad.length + ' conversation(s) have ids that cannot be ' +
                 'used in a URL; this device will keep using whole-document sync.');
  }
  await seedWholeDocument();
  if (bad.length) { currentLedger().seeded = false; persistSyncLedger(); }
  return currentLedger().seeded;
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
  const live = new Set(state.threads.map(t => t.id));
  let sent = 0, conflicts = 0;

  for (const thread of state.threads) {
    if (!isAddressableThreadId(thread.id)) continue;   // see ensureSyncLedger
    const outcome = await pushOneThread(thread, opts);
    if (outcome === 'sent') sent++;
    else if (outcome === 'conflict') conflicts++;
  }
  for (const id of Object.keys(L.threads)) {
    if (live.has(id)) continue;
    const outcome = await deleteOneThread(id, opts);
    if (outcome === 'sent') sent++;
    else if (outcome === 'conflict') conflicts++;
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
  if (!t || t.order === undefined) return t;
  const copy = { ...t };
  delete copy.order;
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
function relateThreads(local, server) {
  local = orderlessThread(local);
  server = orderlessThread(server);
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
        if (local.order !== undefined && local.order !== got.thread.order) {
          got.thread.order = local.order;
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
