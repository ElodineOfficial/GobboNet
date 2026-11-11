> Revision 3: see ../LINUX-START-HERE.md for the current guided launch flow, portable ZIP, validation and rebuild instructions. The historical notes below describe earlier revisions.

# installer-linux

Builds `gobbonet.deb` for Ubuntu, Mint, Pop!_OS and Debian. Sibling of
`installer-win/`, which builds the Windows `.exe`. **Neither touches the codebase** —
both wrap a finished binary produced by `scripts/build-release.sh`.

```sh
bash ../scripts/build-release.sh     # produces dist/<version>/…-linux-amd64.tar.gz
bash ./build-deb.sh          # produces dist/gobbonet_<version>_amd64.deb
```

## What the user does

Download the `.deb` → double-click → the desktop's package installer opens →
click Install, type the password once → GobboNet appears in the applications
menu → click it → setup questions → chatting.

## Layout

| | Path |
|---|---|
| Program files | `/usr/lib/gobbonet` |
| Command | `/usr/bin/gobbonet` → symlink |
| Menu entry | `/usr/share/applications/gobbonet.desktop` |
| Icon | `/usr/share/icons/hicolor/256x256/apps/gobbonet.png` |
| Config | `~/.config/gobbonet/` |
| Models, conversations | `~/.local/share/gobbonet/` |

The root prompt at install covers **read-only program files only** — the same
role Program Files plays on Windows. Config, models, password and conversations
all stay in the user's own space, created on first launch by the user who owns
them.

## Why postinst writes nothing into a home directory

It runs as root. A config it created would be root-owned, in whichever home it
guessed at, and the user could not then write their own password into it. On a
multi-user machine there is no single right home to pick. First launch does it
instead.

`postrm` leaves `~/.config/gobbonet` and `~/.local/share/gobbonet` alone **even
on purge**, for the same reason plus one more: the models in there are gigabytes
the user waited for. `gobbonet uninstall`, run as the user, is the command that
clears them — and the only context that can sensibly prompt about the models.

Both scripts carry these reasons as comments, because the next person to read
them needs to know the omission is deliberate.

## The engine

Bundled, not downloaded — an unsigned installer that fetches executables at
runtime is the shape behavioural AV reads as malware staging, and `launch.bat`
already documents that.

**Only the Vulkan archive is bundled by default.** The original plan called for
shipping both the GPU and CPU-only builds so a machine with no Vulkan driver
still worked. That goal is right, but the means turned out to be redundant:

- Upstream's two Linux archives were compared file by file. **51 of 52 files are
  byte-identical**; the CPU archive is a strict subset. The only meaningful
  difference is `libggml-vulkan.so`.
- The Vulkan archive already carries all fifteen `libggml-cpu-*.so` backends.
- Tested with `libvulkan.so.1` removed from the system: `libggml-vulkan.so`
  fails to load, and `llama-server` from the Vulkan bundle **still starts and
  exits 0**. ggml dlopens backends through a registry, so a missing driver drops
  that one backend and falls through to the CPU ones beside it.

So the Vulkan bundle alone works everywhere, at ~92 MB instead of ~133 MB.
`BUNDLE_CPU_ENGINE=1 bash ./build-deb.sh` ships both anyway.

### Sizes are not what the plan assumed

Upstream moved from a monolithic static binary to a shared-library layout, which
invalidates two rules of thumb worth writing down:

- `llama-server` is a **~17 KB launcher stub**, not a multi-megabyte binary. The
  engine is in `libllama-server-impl.so`, `libllama.so` and the `libggml-*.so`
  backends. A guard that requires `llama-server` to be over 1 MB would reject a
  perfectly good engine, so `build-deb.sh` checks the stub is an ELF rather than
  a script and applies the size test to the library that carries the engine.
- The package is roughly **45 MB**, not 35. `libggml-vulkan.so` alone is 52 MB
  uncompressed.

### Pinning

`engine.sha256` holds the SHA-256 of each archive, verified against the release
page. `build-deb.sh` fails the build on a mismatch. Bumping `LLAMA_BUILD` means
updating those hashes in the same commit.

### The libc6 floor

Read from the engine binaries themselves with `objdump -T | grep GLIBC_`, not
hardcoded. The Go binary is static and does not care; the engine links against
glibc. Getting this right means the package manager refuses to install on a
too-old system with a clear message, instead of the user hitting an unexplained
runtime failure later. Currently **2.34**.

## The launcher

`/usr/lib/gobbonet/gobbonet-launch`, installed as **plain text anyone can read
and edit**. A `.desktop` file cannot express "ask some questions the first time,
then start a server, then open a browser at it", and `gobbonet serve`
deliberately asks nothing — it is a server, and a server launched from a menu
entry has no terminal and nobody to ask. So the sequencing lives here.

It logs to `~/.local/share/gobbonet/launch.log`, surfaces failures through
zenity → kdialog → notify-send, runs `gobbonet setup` first with `--server-exe`
so a fresh config points at the packaged engine, reads the port with
`gobbonet config get` and falls back to 9066, detects an already-running
instance and just opens the browser, waits for the port before opening it, and
traps EXIT/INT/TERM so quitting from the desktop does not orphan a process
holding the port and the GPU.

## Launching

**After install** there is no auto-launch, and that is deliberate. `postinst`
runs as root, often with no `DISPLAY` at all (`apt` from a terminal, a container,
unattended-upgrades), so starting a GUI from it would fail in the common case
and start a server as the wrong user in the rest. The Linux equivalent of
Windows' "Launch GobboNet" finish-page checkbox is the menu entry appearing
immediately, which is what the `update-desktop-database` and
`gtk-update-icon-cache` calls in `postinst` are for.

**At login** is opt-in, per-user, and off by default:

```sh
gobbonet autostart --enable     # writes ~/.config/autostart/gobbonet.desktop
gobbonet autostart --disable
gobbonet autostart              # reports
```

The wizard offers the same choice on its final step, unchecked. The entry runs
`gobbonet-launch --no-browser` — the server starts quietly and no browser window
opens by itself at login. From the AppImage it runs the AppImage file itself
with `--no-browser`, which `AppRun` hands to the same launcher: the launcher
inside the image is there only while it runs (until 1.8.0 the entry named it,
and started nothing at login). `gobbonet uninstall` removes it, because it
lives outside the config directory and would otherwise be left pointing at a
binary that is no longer there.

Worth recording: **the Windows installer has no startup entry at all.** It writes
no `Run` key and drops no Startup-folder shortcut — it only offers to launch
once, from the finish page. So autostart-at-login is a Linux addition, not
parity work, which is why it defaults to off.

### The silent-first-run trap

The first version of the launcher called `gobbonet setup` and let it open the
browser. If nothing could open one, the user clicked the menu entry, the wizard
served happily on a port they had no way to guess, and **nothing appeared** —
indistinguishable from a broken install.

The launcher now asks `gobbonet setup --status` first and owns the browser step
itself, so it can notice the failure and fall back to a zenity/kdialog/
notify-send dialog carrying the URL. Owning that step is what makes the failure
visible; a script that delegates it cannot detect it.

## The AppImage

```sh
bash ./build-deb.sh && bash ./build-appimage.sh   # dist/GobboNet-<deb version, no +>-x86_64.AppImage
```

Made from the `.deb`, so it carries the same files: `build-appimage.sh` unpacks
the package into an AppDir, adds `AppRun`, a copy of the menu entry with
`Exec=gobbonet` and the icon, and appends a zstd squashfs of it to the AppImage
type 2 runtime. Nothing else is added. The one change to the package's files
is `usr/bin/gobbonet`: in the `.deb` it is an absolute link to
`/usr/lib/gobbonet`, which inside an image would point at the host, so it is
made relative.

`AppRun` runs `usr/lib/gobbonet/gobbonet-launch`, the same launcher the package
installs. Nothing in it changed for the AppImage:

- it finds its own folder with `readlink -f`;
- it writes only to `~/.config/gobbonet` and `~/.local/share/gobbonet`;
- the engine path recorded at setup names that run's temporary mount, and
  `gobbonet serve` already replaces a `server_exe` that no longer exists with
  the engine beside the binary, so each later run picks up its own.

The runtime is pinned in the script to a dated release by SHA-256. The hash
was checked against the release's detached signature. The build fails on a
mismatch, and a different release has to be passed with its hash. No
appimagetool is used, so the runtime is the only download. The build also
checks the runtime's `.upd_info` section is empty, so the AppImage never looks
for updates on its own.

On the user's machine it needs x86_64, glibc 2.34 or newer (the engine's
floor, as for the `.deb`), bash, `fusermount`, and python3 for the first-run
setup. The engine's other libraries (libstdc++, libgomp, OpenSSL 3) come from
the host as they do for the package; bundling libstdc++ would fight the host's
Vulkan driver, which loads the host's own. When python3 is missing, the
launcher says so in a dialog instead of failing the first run.

The approach is Deven-Eve's from issue #53.

## Deferred

arm64 packages, and a recommended pick for the PC. Linux v1 offers the
catalogue unmarked and lets the user pick, which is exactly what the Windows
wizard does when its hardware probe fails; since 1.7.7 it does ask first
before a model too big for the GPU the engine reports. (The `.rpm` was on
this list once; it is built by `installer-fedora/` now. So was
autostart-at-login, which is in: see Launching above.)

**arm64 note:** the original plan held arm64 back because upstream published no
arm64 Linux engine. That is no longer true — `llama-<build>-bin-ubuntu-arm64.tar.gz`
and `…-ubuntu-vulkan-arm64.tar.gz` both exist. The remaining reason to hold it
is testing, not availability.

## 1.7.3 packaging revision 2

The corrected package is `gobbonet_1.7.3+go.nogit.20260908-2_amd64.deb`.
Install it over revision 1; no purge is needed:

```sh
sudo apt install ./gobbonet_1.7.3+go.nogit.20260908-2_amd64.deb
```

Launch GobboNet from the applications menu as your regular user to run the
browser setup wizard. For terminal-driven setup, run `gobbonet setup`.

`stage-web.sh` now makes its generated directories 0755 and assets 0644 before
publishing the web root. `mktemp -d` creates 0700 directories regardless of the
normal umask; moving that directory without normalizing it caused the reported
failure. `package-permissions.sh` also normalizes and checks the public package
staging tree immediately before `dpkg-deb` runs. These scripts never change
permissions on user models, conversations, passwords or configuration.

The package declares the C++, GCC, OpenMP and OpenSSL runtime libraries needed
by its bundled engine. Vulkan remains recommended so CPU-only use is supported.
The application remains version 1.7.3; only the Debian revision advances to 2.

Run the packaging regression tests from the project root:

```sh
python3 tests/test-package-permissions.py
```

Release verification must include a fresh install and an upgrade, launched as
a non-root user. Confirm the setup wizard, model loading, chat, desktop entry,
and that existing user data survives the upgrade. Do not use a production home
or purge a working installation just to perform a release test; use a disposable
VM or test installation.

## 1.8.0: the same package, for the 1.8.0 payload

`build-deb.sh`, `postinst`, `postrm`, the menu entry and the icon are 1.7.9's,
and so is the engine: llama.cpp b10456, from the same pinned archive. The
package's 88 files, folders and links are 1.7.9's, with the same modes and
owners. What changed is in the files it carries:

- **`gobbonet`**, the 1.8.0 program.
- **`gobbonet-launch`:**
  - `open_browser = false` in config.toml starts GobboNet without a new
    browser tab (PR #58);
  - which build of the engine it picked, and why, goes to
    `~/.local/share/gobbonet/engine-choice` for doctor and CONFIG (#72);
  - the embedding server is started by GobboNet itself, not by the launcher;
  - a first run that is stopped before setup finishes (a kill, a logout,
    Ctrl+C) leaves no `setup.XXXXXX` behind, and stops the setup page with it.
    Up to 1.8.0 only a finished setup removed that file, which kept the data
    folder after `gobbonet uninstall`.
- **`gobbonet-setup.py` and `wizard.html`:** the location page asks for a data
  folder and a models folder (#68). A data folder whose only models are in its
  own `models` subfolder (where 1.7.9 said existing models belong, and where
  `gobbonet uninstall` leaves the ones it keeps) keeps that subfolder as the
  models folder; it is not offered as one itself.
- **`models.ini`**, the 1.8.0 catalogue, every model with a pinned checksum.
- **This README.**

`gobbonet uninstall` also clears what the launcher and setup leave in the
data folder: the embedding model setup downloads (`embeddings/`), the
launcher's log and `engine-choice` note, and old setup logs.

**How it was built.** From the extracted 1.8.0 update ZIP, not a git checkout,
as 1.7.9's was (its version says `nogit`): the package then carries exactly the
ZIP's files and takes its build id from the program, `1.8.0+go.<commit>-1`. The
engine archive was put in `vendor/` by hand, and the script checks it against
its pin. `SOURCE_DATE_EPOCH` is the commit's time, so the same command gives
the same file, byte for byte:

```sh
cd GobboNet/installer-linux       # in the extracted ZIP
mkdir -p vendor && cp /path/to/llama-b10456-bin-ubuntu-vulkan-x64.tar.gz vendor/
GOBBONET_BIN="$PWD/../linux-amd64/gobbonet" SKIP_ENGINE_FETCH=1 \
    SOURCE_DATE_EPOCH="$(git -C /path/to/the/repo log -1 --format=%ct v1.8.0)" \
    bash ./build-deb.sh
```

The same way rebuilds the official
`gobbonet_1.7.9+go.nogit.20261102-1_amd64.deb` byte for byte from `git archive
v1.7.9`, its program and `SOURCE_DATE_EPOCH=1793633538`.

**How it was checked** (`docs/changelog/CHANGELOG-1.8.0-linux-installer.md`
has the details):

- entry by entry against the official 1.7.9: the same 88 entries in the same
  order, with the same modes, owners and link targets. 81 are byte-identical,
  the engine among them; the other 7 are the files above and `ENGINE.txt`'s
  "bundled by" line, each byte-for-byte the ZIP's. `postinst` and `postrm` are
  identical, and `control` differs only in Version and Installed-Size.
  lintian reports the same findings for both;
- installed with apt on Ubuntu 24.04 and used as ordinary users: an upgrade
  over 1.7.9 that keeps the conversations, password, config and models; a
  first run whose wizard pages match 1.7.9's except the location page and the
  model page's note; a chat answered by the bundled engine; a first run
  stopped part way; `apt remove` and `apt purge`, which leave the users' files
  alone; and `gobbonet uninstall`, which leaves nothing of GobboNet's.

## 1.8.0: the AppImage

Made from the 1.8.0 `.deb` the way 1.7.9's was, with the same `AppRun` and the
same pinned runtime. Two things changed:

- **Its name** has no `+`: `GobboNet-1.8.0go.<commit>-1-x86_64.AppImage`, the
  name GitHub lists it by once it is attached. The update file names it that
  way, so the update button can find it (`docs/UPDATES.md`).
- **Start at login** from the AppImage starts the AppImage file, as Launching
  says.

Built after the `.deb`, in the same extracted ZIP, with the same
`SOURCE_DATE_EPOCH`:

```sh
cp /path/to/runtime-x86_64 vendor/appimage-runtime-20251108-x86_64   # or let the script fetch it
SKIP_RUNTIME_FETCH=1 SOURCE_DATE_EPOCH=<the same> \
    bash ./build-appimage.sh dist/gobbonet_1.8.0+go.<commit>-1_amd64.deb
```

`docs/changelog/CHANGELOG-1.8.0-appimage.md` has how it was checked: entry by
entry against the official 1.7.9, run by ordinary users through FUSE (an
upgrade from 1.7.9, first runs, Start at login, `gobbonet uninstall`), and the
update button replacing it.
