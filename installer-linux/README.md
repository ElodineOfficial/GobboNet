# installer-linux

Builds `gobbonet.deb` for Ubuntu, Mint, Pop!_OS and Debian. Sibling of
`installer/`, which builds the Windows `.exe`. **Neither touches the codebase** —
both wrap a finished binary produced by `../build-release.sh`.

```sh
../build-release.sh          # produces dist/<version>/…-linux-amd64.tar.gz
./build-deb.sh               # produces dist/gobbonet_<version>_amd64.deb
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
`BUNDLE_CPU_ENGINE=1 ./build-deb.sh` ships both anyway.

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
opens by itself at login. `gobbonet uninstall` removes it, because it lives
outside the config directory and would otherwise be left pointing at a binary
that is no longer there.

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

## Deferred

`.rpm`, arm64 packages, autostart-at-login, and the hardware probe. Linux v1
offers the catalogue unfiltered and lets the user pick, which is exactly what
the Windows wizard already does when its probe fails.

**arm64 note:** the original plan held arm64 back because upstream published no
arm64 Linux engine. That is no longer true — `llama-<build>-bin-ubuntu-arm64.tar.gz`
and `…-ubuntu-vulkan-arm64.tar.gz` both exist. The remaining reason to hold it
is testing, not availability.
