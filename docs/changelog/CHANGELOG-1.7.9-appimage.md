# 1.7.9 — The AppImage

## How it was built

`installer-linux/build-appimage.sh`, as in 1.7.8, made from the 1.7.9 `.deb`
(`gobbonet_1.7.9+go.nogit.20261102-1_amd64.deb`). The script changed since
1.7.8 only in the path to `verify-payload.sh` (`scripts/`, the 1.7.9 file
layout), and `AppRun` not at all.

- **The runtime** is the pinned type 2 runtime, release `20251108`:
  - its SHA-256 matches the pin;
  - its `runtime-x86_64.sig` verifies with `signing-pubkey.asc` from that tag
    (key `570C 77AC EA40 C0F1 B758 902C BF96 CCA5 6490 F695`);
  - the official 1.7.8 AppImage begins with the same 944,632 bytes.
- **Reproducible.** It was built with `SOURCE_DATE_EPOCH=1793577600`
  (2026-11-02 00:00 UTC). Built twice from the same `.deb`, the two files are
  byte for byte the same. Anyone with the `.deb` and the runtime can rebuild
  it and compare hashes.
- The script's own checks pass: the type 2 magic, the pinned runtime, and no
  update address. `tests/test-appimage.py` passes all 12, with its full build
  from the 1.7.9 `.deb` switched on.

GitHub drops the `+` from asset names, so on the release page the file is
`GobboNet-1.7.9go.nogit.20261102-1-x86_64.AppImage`, as 1.7.8's was
`GobboNet-1.7.8go.18aee12-1-x86_64.AppImage`.

## Against the official 1.7.8 AppImage

The official 1.7.8 AppImage was downloaded from the release page and unpacked.

**The method first.** 1.7.8's script rebuilt 1.7.8's AppImage from the
official 1.7.8 `.deb`. The result matches the official one:

- the same 92 entries, with the same types, modes and link targets;
- every file byte for byte.

Only the file times differ; the official one was built without
`SOURCE_DATE_EPOCH`.

**1.7.9 against it:**

- the same 92 entries, with the same types, modes and link targets;
- 60 of the 66 files byte for byte.

**Changed:** six files.

| File | Why |
|---|---|
| `usr/lib/gobbonet/gobbonet` | the 1.7.9 server (Go 1.25.14, the uninstall fix) |
| `usr/lib/gobbonet/wizard.html` | the password minimum comes from the server, 8 by default |
| `usr/lib/gobbonet/models.ini` | sixteen models |
| `usr/lib/gobbonet/llama-cpp/ENGINE.txt` | its "bundled by" line names the package version |
| `usr/share/doc/gobbonet/README.md` | `scripts/build-release.sh`'s new path; `installer-win/` |
| `gobbonet.desktop` | `X-AppImage-Version` names 1.7.9 |

Every file under `usr/` is byte for byte the 1.7.9 `.deb`'s.

## Checked here

On Ubuntu 24.04 (container). Each test user was an ordinary user created for
it, with FUSE open to them as on a desktop. Headless Chromium played the
browser.

**An upgrade from the official 1.7.8 AppImage:**

1. The 1.7.8 AppImage ran through FUSE. Its wizard was walked with Enter, and
   a conversation got a reply from the bundled engine. Closing GobboNet
   unmounted the image.
2. The 1.7.9 AppImage, a separate file as a user downloads it:
   - went straight to the chat ("setup: already complete");
   - healed the saved engine path from the old mount to its own;
   - the 1.7.8 conversation was there, and a new message in it got a reply;
   - page and server said 1.7.9.
3. **The `.deb` beside it.** The 1.7.9 `.deb` was installed, and `gobbonet`:
   - went straight to the chat with the AppImage's conversation;
   - moved the engine setting to `/usr/lib/gobbonet`.

   Then the `.deb` was removed. The AppImage again went straight to the chat,
   with the engine setting back on its own mount.
4. `./GobboNet-….AppImage uninstall --yes --remove-models`:
   - cleared the data folder chosen in the 1.7.8 wizard
     (`CHANGELOG-1.7.9-linux-installer.md`), the config and the launcher's log;
   - its last lines name the `.AppImage` file to delete.

   No mounts were left.

**A fresh first run of 1.7.9:**

1. The wizard was walked with Enter into `~/Gobbo Data`:
   - it says 8 characters, and refuses 7;
   - the page had no errors.
2. The chat:
   - the engine replied;
   - a conversation, after answering the tour's offer with Skip.
3. `config.toml` is the user's, mode 0600.
4. `tests/test-linux-onboarding.py` with the AppImage as `GOBBONET_TEST_ENTRY`
   passes, local and LAN.

**Without FUSE:**

- run plainly, the runtime points to the FUSE wiki, the same as 1.7.8's;
- `--appimage-extract-and-run` works (`version`).

`--appimage-updateinformation` prints nothing.

## Not checked here

The same as 1.7.8:

- a real desktop session: menu integration by Gear Lever or AppImageLauncher,
  and the browser opening;
- Vulkan on real GPUs;
- distributions other than Ubuntu (the Fedora roots tested the `.rpm`, not
  this).
