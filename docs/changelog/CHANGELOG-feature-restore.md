# Restoring 1.7.5 behaviour

Built on the CPU/RAM runtime package, which includes PR #60 and the
corrective, launcher, memory-QOL, state-handshake and CPU/RAM runtime updates.
Those updates are all kept; this restores 1.7.5 behaviour they had lost.
Released in 1.7.6.

Found by comparing this tree with the last push (`28fe0b2`): every function,
control, route, command and setting, 1.7.5's own test suites, and the real UI
of each build run against its real server (eleven sync flows, ten chat flows).

## Restored

**Device sync (DATA → DEVICE SYNC).** Choosing a separate profile, keeping
this device's data over a backup, or turning sync back on ended in "⇅ chat
conflict"; in 1.7.5 each ends "✓ synced" again. The upload that seeds a
target now records the versions it wrote, adopted only when the server's index
matches that upload exactly (otherwise the normal conflict handling decides).
Chats created without the loader's default fields (integration API, imports,
older clients) no longer raise a false conflict prompt on the first device to
load them. (`js/06-state-sync.js`)

**Updating replaces the interface.** The interface folder beside the
executable (`web/`) was stamped with the release number only, so a new build
of the same release kept serving the previous build's JavaScript. It is now
stamped with the build, so replacing gobbonet(.exe) is enough.
(`internal/server/webroot.go`)

**Replies recovered at startup** even when the startup server check fails;
only sync pauses, as intended. (`js/24-boot.js`)

**The remote-image notice** is saved to local storage after a failed check
instead of returning on every boot (`saveState({ localOnly })`).

**A dragged chat floats back to the top when used**, as in 1.7.5. A drag
records the chat's activity; newer activity wins. Nothing is written on send,
so a sent message stays a cheap append, and placement never counts as a sync
conflict. (`js/04-state.js`, `js/06-state-sync.js`, `js/10-chat.js`)

**The sidebar arrangement saved by 1.7.5 is carried over** on upgrade instead
of reshuffled: only chats placed out of activity order are pinned, identically
on every device, once. It needs the 1.7.5 list to still exist (devices still on
1.7.5, 1.7.5-era backups); a device that already ran PR #60 dropped it.

**Crash recovery keeps retrying** (1 s doubling to 2 min) until the engine is
back, instead of stopping after three attempts. Choosing a model, stand-down or
shutdown still ends it. The console again prints each failure's reason,
"llama-server recovered", and "could not reload" on a failed wake.
(`internal/supervisor/`)

**GPU layers in launch.bat.** The legacy launcher starts llama-server with 99
layers again, as in 1.7.5. The normal launcher now really hands `-1` to
gobbonet.exe, so the memory-QOL automatic placement is used; a GPU layers
value set in CONFIG still overrides it.

## Checked, unchanged

Windows engine termination (1.7.5's polite stop could never succeed for
llama-server), hidden-tab painting, markdown caching, the load-summary memory
figure, configuration keys, routes, CLI commands, `POST /state`, legacy
password rehash, the sync indicator and restore prompt.

## Tests

New: `tests/test-device-sync.mjs`, `tests/test-conversation-order.mjs`,
`tests/test-boot-resume.mjs`, `tests/test-launch-gpu-layers.py`,
`internal/supervisor/recovery_test.go` (a real engine process crashing five
times, then recovering), `internal/config/gpu_layers_set_test.go`,
`internal/server/webroot_refresh_test.go`. The checks covering a fix fail on
the build before it; the rest guard behaviour that must not change. No
existing test was changed.

Two failures predate this and are identical on the last push:
`TestVersionFileMatchesUpstreamRelease` (VERSION 1.7.5, newest tag v1.7.3)
and `tests/test-linux-onboarding.py` (`linux-amd64/gobbonet-launch` is not
executable in the repository).
