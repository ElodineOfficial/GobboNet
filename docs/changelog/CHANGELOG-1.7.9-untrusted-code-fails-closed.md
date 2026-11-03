# 1.7.9 — Transferred code arrives switched off, and cannot skip that

*Patch step 5 of 1.7.9. Finishes PR #5 (neoliminal), "Never let transferred
state arrive with code already enabled". The quarantine,
`neutralizeUntrustedCode()` in `js/23-card-code.js`, was ported in 1.7. This
step closes the gap jmccardle found in his review: "its guard silently skips
the security control".*

## What was happening

Every call to the quarantine was written like this:

```js
const neutralized = (typeof neutralizeUntrustedCode === 'function')
  ? neutralizeUntrustedCode(parsed)
  : { cards: 0, extensions: false };
```

The guard was meant to stop a load-order change from breaking restores. What it
actually did: if the function were ever missing, the restore carried on and
code from the incoming blob arrived **switched on**. A security control that
fails open is not doing its job.

There were five guarded calls: the server restore (which also serves a sync
profile switch), the cards import, the folder and character import, the full
backup restore, and recovering pre-upgrade history.

### Reproduced

On the harness, with a `/state` backup carrying a card with
`customCodeEnabled: true` and an enabled extensions script, the restore was
run through the real page with the function removed:

```
1.7.8:  restore returned true, and the backup's code RAN
1.7.9:  [sync] Restore failed: TypeError: neutralizeUntrustedCode is not a function
        restore returned false, nothing applied, nothing ran
```

With the function present, both versions switch the code off, as designed.

## The change

All five calls are now direct. A missing quarantine makes the restore or import
fail with an error, and nothing is applied. Restores run from boot or from a
click, both after `23-card-code.js` has loaded, so the failure the guard was
written for cannot happen in normal use.

**Audit of every way in.** These paths bring cards or extensions in from
outside the device, and each calls the quarantine:

- server restore and sync profile switch (`restoreFromServer`);
- the cards import, and the folder and character import;
- the full backup restore, before `applyExtensions()` runs;
- recovered history (`recoverUpgradeHistory`);
- card files (PNG, JSON, zip), through `applyImportedCardCode`.

Per-thread sync (`reconcileWithServer`) moves conversations only, never cards
or extensions.

The notice is unchanged: one line saying the code was kept but switched OFF.

## Tests

- `tests/test-state-handshake.mjs`: new case. With the quarantine left out, the
  restore must fail, arm nothing and write nothing to storage, both in place
  and with a reload. It fails on the 1.7.8 `06-state-sync.js`.
- `tests/test-untrusted-code-paths.mjs`, new:
  - no `typeof neutralizeUntrustedCode` anywhere;
  - each way in calls the quarantine;
  - a full backup quarantines before `applyExtensions()`;
  - `state.characterCards` and `state.extensions` are replaced only by known
    writers, so a new way in has to come through here.
- `tests/console/1.7.9-steps-4-6.js`, non-destructive: the quarantine against
  a synthetic blob, plus the source check on the JS the page actually loaded.
