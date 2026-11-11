# 1.8.0 — the AppImage

## What was asked

The maintainer, after the `.rpm`: "Time for the AppImage". As for the `.exe`,
the `.deb` and the `.rpm`, the official 1.7.9 AppImage is the guide, and
1.8.0's should work the same way, updated for the 1.8.0 payload.

## The package

Made the way 1.7.9's was: `installer-linux/build-appimage.sh` unpacks the 1.8.0
`.deb` into an AppDir, adds `AppRun`, the menu entry and the icon, and joins a
zstd squashfs of it to the pinned AppImage type 2 runtime. `AppRun`, the
runtime (release `20251108`) and the steps are 1.7.9's; the script's one change
is the file's name, below. Of the 66 files, 58 are 1.7.9's byte for byte, the
engine among them. Eight changed:

| File | Why |
|---|---|
| `usr/lib/gobbonet/gobbonet` | the 1.8.0 program, byte for byte the ZIP's |
| `usr/lib/gobbonet/gobbonet-launch` | the 1.8.0 launcher (`installer-linux/README.md` has what changed) |
| `usr/lib/gobbonet/gobbonet-setup.py`, `wizard.html` | the two-folder setup (#68) and the `.deb` round's fixes; the setup page also writes the login entry below |
| `usr/lib/gobbonet/models.ini` | the 1.8.0 catalogue, every model with a pinned checksum |
| `usr/lib/gobbonet/llama-cpp/ENGINE.txt` | its "bundled by" line names the package version |
| `usr/share/doc/gobbonet/README.md` | `installer-linux/README.md`, with its 1.8.0 sections |
| `gobbonet.desktop` | `X-AppImage-Version` names 1.8.0 |

Every file under `usr/` is the 1.8.0 `.deb`'s, byte for byte.

**The name.** GitHub drops a `+` from the name of a file attached to a release:
1.7.9's AppImage, built as `GobboNet-1.7.9+go.nogit.20261102-1-x86_64.AppImage`,
is listed as `GobboNet-1.7.9go.nogit.20261102-1-x86_64.AppImage`. 1.8.0's is
built under the name the release will list,
`GobboNet-1.8.0go.<commit>-1-x86_64.AppImage`; why that now matters is below.
The `.deb` keeps its `+`, which is part of a Debian version: GitHub renames it
as before, and nothing looks a package up by name.

## Found while running it, and fixed

**Start at login did nothing from the AppImage (1.7.8 on).** The setup page's
last question, and `gobbonet autostart --enable`, write
`~/.config/autostart/gobbonet.desktop`. From the AppImage both named the
launcher inside the image's temporary mount
(`/tmp/.mount_…/usr/lib/gobbonet/gobbonet-launch`), which goes away when
GobboNet closes, so at the next login the entry started nothing. Both now name
the AppImage file itself, which the runtime passes on as `APPIMAGE`, with
`--no-browser`; `AppRun` hands that to the same launcher. They do so only when
the program is inside that AppImage's mount (`APPDIR`), the test `gobbonet
uninstall` and the update button already use, so another AppImage's variables
in the environment change nothing, and a package or the ZIP gets the entry it
got before. `gobbonet autostart --enable` also quotes the path now, as the
setup page always did: a space in it (an AppImage in `~/My Apps`) split the
command in two.

If the AppImage is moved or renamed, the entry still names the old place;
`LINUX-START-HERE.md` says to run `autostart --enable` from the new one. An
update keeps the file's name, so it leaves the entry working (checked below).

Tests: `internal/autostart` (`TestLauncherFor`, `TestExecIsQuoted`,
`TestEnableFromAnAppImage`), and `tests/test-appimage-login-entry.py`, which
runs the setup page's code in an AppImage's layout with a space in the path,
in the ZIP's layout, and with another AppImage's variables set. It fails on
the setup page as it was before this fix.

**AppImage users would never have been offered an update.** The update file
names each download as the release lists it, and the check offers nothing when
the release has no file of that name. `--appimage` named the AppImage as it was
built, with the `+`, which the release page would not have had. The AppImage is
now built without it, and `gobbonet update manifest` (which
`scripts/make-update-manifest.sh` runs) refuses a file name GitHub would change,
naming the one to use (`TestBuildManifestRefusesANameGitHubWouldChange`).
`docs/UPDATES.md` has the procedure with the new name.

**The question before an update named the wrong file.** UPDATE NOW asked before
replacing "the gobbonet program file", from the AppImage too, where it replaces
the AppImage. There it says "the GobboNet AppImage" now
(`tests/test-update-button.mjs`).

## How it was built

From the extracted 1.8.0 update ZIP, like the `.deb` and the `.rpm`: the `.deb`
first (`installer-linux/README.md` has the command), then in the same folder

```sh
cp /path/to/runtime-x86_64 vendor/appimage-runtime-20251108-x86_64
SKIP_RUNTIME_FETCH=1 SOURCE_DATE_EPOCH=<the commit's time> \
    bash ./build-appimage.sh dist/gobbonet_1.8.0+go.<commit>-1_amd64.deb
```

The script checks the runtime against its pin; without `SKIP_RUNTIME_FETCH` it
downloads it.

- **The runtime** is release `20251108`, its SHA-256 the pin, and the AppImage
  begins with the same 944,632 bytes as 1.7.9's.
- **This way reproduces 1.7.9.** The script, run on the official 1.7.9 `.deb`
  with `SOURCE_DATE_EPOCH=1793577600` as 1.7.9's was, makes a file byte for
  byte the official 1.7.9 AppImage (SHA-256 `7d1a8e13…`), under the name the
  release lists it by.
- **Reproducible.** Two builds, each from its own extraction of the ZIP, are
  byte for byte the same.

## How it was checked

On Ubuntu 24.04 (a container). Each test user was an ordinary user created for
it, with FUSE open to them as on a desktop, and headless Chromium was their
browser.

- **Against the official 1.7.9, entry by entry:** the same runtime; the same 92
  entries in the same order, with the same types, modes, owners and link
  targets; 58 of the 66 files byte for byte, and the 8 above changed.
- **`tests/test-appimage.py`:** 12 of 12, with its full build from the 1.8.0
  `.deb` switched on: the pinned runtime, no update address, exactly the
  `.deb`'s files, and the AppImage starts.
- **Run by ordinary users, 33 checks, all passing:**
  - **From 1.7.9.** The official 1.7.9 AppImage was set up through its own
    wizard and answered a chat from its bundled engine; closing it unmounted
    the image. The 1.8.0 AppImage, a separate file as a user downloads it, went
    straight to the chat: the server 1.8.0, signed in with the same password,
    1.7.9's conversation there and a new chat answered, on the same model,
    untouched. The engine path 1.7.9 saved (its own mount, gone) was healed to
    this image's. CHECK FOR UPDATES knew it could replace this AppImage.
  - **A fresh first run with a models folder of the user's own, and Start at
    login on:** the location page found the model there, a chat was answered
    on it, and `config.toml` is 0600 with that folder. The login entry is
    `Exec="/home/…/Apps/GobboNet-1.8.0go.<commit>-1-x86_64.AppImage" --no-browser`,
    and running it after GobboNet had closed started the server and opened no
    browser.
  - **A fresh first run with 1.7.9's choices:** the location page keeps
    `<data>/models` and finds the model in it, and GobboNet starts on it.
  - **A first run stopped part way:** no `setup.XXXXXX` left, nothing left
    running, the image unmounted. `gobbonet uninstall` from the AppImage then
    leaves nothing of GobboNet's, and its last lines name the AppImage file to
    delete.
  - **`tests/test-linux-onboarding.py`** with the AppImage as
    `GOBBONET_TEST_ENTRY`: local and LAN.
  - **`gobbonet uninstall`,** with the embedding model setup downloads in place:
    answering yes to the models, nothing of GobboNet's is left; answering no,
    the config, the data (embeddings too) and the login entry go, and the
    user's own models folder keeps its model. No mounts left.
  - **Without FUSE:** run plainly, the runtime says FUSE is needed;
    `--appimage-extract-and-run` works; `--appimage-updateinformation` prints
    nothing.
- **The update button replacing the AppImage,** 15 checks, all passing. Two test
  builds of this tree, A and a later B, each trusting a throwaway key (never the
  release key) and made into an AppImage the same way. A stand-in release list
  on this machine offered B, with an update file signed by that key, and
  `update_releases_url` pointed at it. A user ran A through FUSE, with Start at
  login on:
  - CHECK FOR UPDATES offered B; UPDATE NOW asked first, naming the AppImage,
    then downloaded and checked it; RESTART NOW came back on B, with the same
    process ID (the launcher still watching it) and the engine on the same
    model, and `launch.log` says the update finished;
  - the AppImage file, under its own name, is B byte for byte; the one it
    replaced (`.old`) is gone once B is serving, and no `.new` is left;
  - closing GobboNet unmounted both images and left nothing running;
  - the file now reports B, and the login entry still starts it.

  The file keeps its name, so the name still says A. That is what keeps the
  login entry and any shortcut working; `version` and ABOUT say what it is.
- **In the `.rpm` round's Fedora 44 and 45 root filesystems,** as an ordinary
  user, without FUSE: on 44 the engine starts with the system's libraries. 45
  ships OpenSSL 4, and there the engine starts only once OpenSSL 3 is there
  (Fedora 44's libraries standing in for `openssl3-libs`). The `.rpm` requires
  that package and the AppImage cannot, so `LINUX-START-HERE.md` now says to
  install it first.
- **Tests:** every suite, Go, JavaScript and Python.

## Found, and left for the maintainer's call

- **Fedora 45 without `openssl3-libs`.** The AppImage's setup page still offers
  local mode there, because it finds the engine file, and why the engine cannot
  start is only in the launcher's `engine-choice` note. The setup page could
  run the engine once before offering it.
- **A moved AppImage.** The login entry names the file where it was when Start
  at login was chosen. `autostart --enable` from the new place fixes it;
  GobboNet could also rewrite the entry when it finds itself started from
  another AppImage file.

## Not done here

The same as 1.7.9, plus the update from GitHub itself:

- a real desktop session: a login running the entry, menu integration by Gear
  Lever or AppImageLauncher, and the browser opening;
- Vulkan on real GPUs;
- on Fedora, a run through FUSE and a whole first run with chats (only the
  engine's start and the setup page's answer were checked, in a chroot);
- the update from the real release: here the release list was a stand-in and
  the key a throwaway one. The real one needs the update file signed with the
  release key and the AppImage attached under its built name (`docs/UPDATES.md`).
