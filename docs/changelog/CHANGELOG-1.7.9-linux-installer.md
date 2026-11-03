# 1.7.9 — the Linux installer: the .deb, and what building it found

The `.deb` is built the way 1.7.8's was: `installer-linux/build-deb.sh`, with
the ZIP's own `linux-amd64/gobbonet` as `GOBBONET_BIN` and llama.cpp b10456's
Vulkan archive, checked against `GPU_SHA256` in `engine.sha256`. Building and
installing it turned up three things to fix, one of them in 1.7.8 too.

## 1. The ZIP's Linux engine was CPU-only (a 1.7.9 test build)

The first 1.7.9 ZIP handed over for testing carried upstream's
`llama-b10456-bin-ubuntu-x64` build in `linux-amd64/llama-cpp`, not the
`-ubuntu-vulkan-x64` one. The two have the same files except
`libggml-vulkan.so`, and both start, so nothing complained. But
`gobbonet-launch` treats that folder as the GPU engine, and a ZIP install
would have run every model on the processor.

- The ZIP is rebuilt with the Vulkan build: 55.6 MB, close to 1.7.8's.
- `scripts/make-zip.sh` now refuses a full ZIP whose engine has no
  `libggml-vulkan.so`, and says which archive to unpack. `build-deb.sh`
  already refused the same thing for the package. An update ZIP
  (`--no-engine`) is unaffected.
- `tests/test-zip-engine.py` runs that check against a Vulkan engine, a
  CPU-only one and a missing one.

The Windows installer's 61 files did not change (that engine is not among
them), and `gobbonet.exe` rebuilt byte for byte.

## 2. The package's name named a different day from the server inside it

From a tree with no `.git`, such as the ZIP, `build-deb.sh` stamped
`nogit.<today's date in UTC>`. `make-zip.sh` stamps the binary with the local
date. Built in the evening in America/Chicago, the package said
`1.7.9+go.nogit.20261102-1` around a server that says
`1.7.9-go-nogit.20261101`.

`build-deb.sh` now takes the build id from the binary it packages (`gobbonet
version`, after `<VERSION>-go-`), as `build-rpm.sh` already did. It refuses a
binary from another release. A git checkout still names its commit, and the
date remains the fallback for a binary that cannot run on the build machine.
`tests/test-deb-stamp.py` runs the logic with stand-in binaries.

## 3. `gobbonet uninstall` left the conversations behind (1.7.8 too)

`gobbonet uninstall` read the config only when given `--config`. Without it,
the path it read was empty, so it worked from the default folders. The Linux
setup wizard always asks where data goes and writes `data_dir`, so for a
package user the command:

- removed the config;
- left `state.json` (every conversation), `setup-complete.json` and the rest in
  the chosen folder;
- said "GobboNet's data is gone, and so are your conversations."

Found by installing the `.deb`, choosing `~/Gobbo Data` in the wizard,
chatting, and running `gobbonet uninstall --yes --remove-models` as the user.
The code was the same in 1.7.8. The Windows uninstaller runs
`gobbonet.exe uninstall` too, so it was affected wherever `data_dir` had been
changed.

The command now finds the config the way every other command does
(`config.Discover`). A config that exists but cannot be read stops it with a
message, and nothing is removed. It no longer guesses the defaults and reports
success. With `data_dir` elsewhere, the Linux launcher's `launch.log` in the
default folder goes too.

`cmd/gobbonet/uninstall_test.go` has three new tests: a discovered config with
a `data_dir` that has a space in it, that folder removed once empty, and an
unreadable config. All three fail on 1.7.8's `uninstall.go`. One existing test
had written `x` as its `config.toml`, which only passed because the file was
never read; it now writes a real one.

## Also

`installer-linux/README.md`, installed as the package's documentation, called
the Windows builder `installer/`. It is `installer-win/` since the 1.7.9 file
layout.

## The .deb against 1.7.8's

The official 1.7.8 `.deb` could not be found under any name tried at first.
1.7.8's sources were therefore built into a package by the same script, with
the same engine archive. The official package was found later
(`gobbonet_1.7.8go.18aee12-1_amd64.deb`; the build id is in the official
`gobbonet.exe`). Compared with it, the result below is the same, and the
rebuild matched it in every file except the three that carry the version
(`CHANGELOG-1.7.9-fedora-installer.md`). Compared with the 1.7.8 package:

**The same:**

- every control field except `Version` and `Installed-Size`;
- `postinst` and `postrm`, byte for byte;
- all 88 entries, with the same types, modes, owners and link targets;
- 58 files byte for byte, including the whole engine, `gobbonet-launch`,
  `gobbonet-setup.py`, the menu entry and the icon.

**Changed:** five files, each for a 1.7.9 change.

| File | Why |
|---|---|
| `usr/lib/gobbonet/gobbonet` | the 1.7.9 server, byte for byte the ZIP's |
| `usr/lib/gobbonet/wizard.html` | the password minimum comes from the server, 8 by default |
| `usr/lib/gobbonet/models.ini` | sixteen models, the ZIP's catalogue byte for byte |
| `usr/lib/gobbonet/llama-cpp/ENGINE.txt` | its "bundled by" line names the package version |
| `usr/share/doc/gobbonet/README.md` | `scripts/build-release.sh`'s new path; `installer-win/` |

The package is 20 MB, installs 102 MB, and needs libc6 2.34 or newer (read from
the engine). LINUX-START-HERE.md's other route, `GOBBONET_RUNTIME_DIR`, gives
the same files, but at 130 MB. `zip` stores the engine's library symlinks as
copies, and that route packages the ZIP's engine as it is, as in 1.7.8. The
release package uses the archive.

## Checked here

On Ubuntu 24.04 (container), with the real bundled engine. GobboNet always ran
as an ordinary user created for the test, and was started from the user's
home. Pages were driven in headless Chromium.

**A fresh install:**

1. `apt install` pulled the dependencies and the recommended Vulkan driver.
   - Every file was in place, and `gobbonet` on PATH is the launcher.
   - `ENGINE.txt` names the Vulkan archive and its pin.
   - The engine runs as the user.
2. `gobbonet` opened the wizard. It was walked with Enter in its fields, into
   `~/Gobbo Data`.
   - The password step says 8, and refuses 7 characters with "Use at least 8
     characters."
   - Enter with Confirm empty stays on the step.
   - The page logged no errors.
3. The chat opened on the chosen port: page and server 1.7.9. The engine loaded
   the model and replied.
4. `config.toml` is the user's, mode 0600, and `data_dir` is the chosen
   folder.
5. `apt remove` left the program files, command and menu entry gone, and the
   config and chats in place. `apt purge` left them too.

**An upgrade from 1.7.8:**

1. A new user installed 1.7.8's `.deb`, walked its wizard, and had a
   conversation.
2. GobboNet was closed, and `apt install` of 1.7.9 reported *Unpacking
   gobbonet (1.7.9…) over (1.7.8…)*. The user's files were byte for byte
   untouched.
3. `gobbonet` went straight to the chat ("setup: already complete").
   - The 1.7.8 conversation was there, and a new message in it got a reply.

**Uninstalling:** `gobbonet uninstall --yes --remove-models` is what found the
problem above. With the fix, it was run again the same way. See the
validation in PATCH-README.

**Suites:**

- `tests/test-linux-onboarding.py` against the installed package as an
  ordinary user, local and LAN: both pass.
- The console blocks were run against the same server binary from the ZIP.

**Rebuilt with Go 1.25.14** (`CHANGELOG-1.7.9-fedora-installer.md`). The
upgrade test was run again, from the official 1.7.8 `.deb`, along with the
fresh install, the onboarding suite and the uninstall.

**Not run here:** a desktop session (a double-click in a file manager, the
menu entry launched by a desktop) and a real GPU.
