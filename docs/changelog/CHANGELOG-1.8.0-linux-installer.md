# 1.8.0 — the Linux .deb

## What was asked

The maintainer, after the Windows installer: "Time to do the same for Linux! A
deb! Just like before we have one from the last patch that works incredibly
well." So, as for Windows, the official 1.7.9 package is the guide, and 1.8.0's
should work the same way, updated for the 1.8.0 payload.

## The package

Nothing in the packaging changed. `installer-linux/build-deb.sh`, `postinst`,
`postrm`, `gobbonet.desktop` and the icon are 1.7.9's, and so is the engine:
llama.cpp b10456, from the archive pinned in `engine.sha256`. What the package
carries changed in earlier 1.8.0 rounds and in this one:

- `gobbonet`, the 1.8.0 program;
- `gobbonet-launch`: `open_browser` (PR #58, `CHANGELOG-1.8.0-open-browser.md`),
  the `engine-choice` note (#72, `CHANGELOG-1.8.0-gpu-picker.md`), the
  embedding server left to the program (PR #56,
  `CHANGELOG-1.8.0-embedding-supervisor.md`), and the setup log below;
- `gobbonet-setup.py` and `wizard.html`: the two folders (#68,
  `CHANGELOG-1.8.0-setup-folders.md`), and the two fixes below;
- `models.ini`, with every model's checksum pinned
  (`CHANGELOG-1.8.0-catalog-pins.md`);
- `README.md`, installed as `/usr/share/doc/gobbonet/README.md`: a 1.8.0
  section saying all this, and its Deferred list corrected (autostart at login
  is in; what is still deferred is a recommended pick for the PC, since the
  wizard has asked before a model too big for the GPU since 1.7.7).

The `linux-amd64/` copies of the launcher and the wizard, which the ZIP and the
AppImage run, are the same files.

## Found while testing it, and fixed

Installing the package and using it as ordinary users found four things. The
first two were there in 1.7.9 too; the other two are in the location page that
is new in 1.8.0.

**`gobbonet uninstall` left GobboNet's embedding model.** The Linux setup
downloads `nomic-embed-text-v1.5.Q8_0.gguf` into `<data_dir>/embeddings` when
asked (since 1.7). Uninstall removed neither it nor its unfinished download, so
the data folder stayed. It removes both now, and the folder if that empties it,
whatever was said about models: it is part of GobboNet that setup fetched, not
one of the user's models. A file of the user's own in that folder stays
(`cmd/gobbonet/uninstall.go`). Windows keeps the model in the models folder
(`launch.bat`), where it is treated as a model, as before.

**An unfinished first run left its setup log.** The launcher sends the setup
page's output to a temporary file, `setup.XXXXXX` in
`~/.local/share/gobbonet`, and watches it for the page's address. It removed
the file only when setup finished, and set its trap only once the browser had
opened. So a first run stopped part way (a kill, a logout, Ctrl+C, or a setup
that failed) left the file, `gobbonet uninstall` left the folder because of it,
and a signal to the launcher alone could leave the setup page running: on
SIGHUP, or on any signal before the browser step. Now the trap is set as soon
as the page starts and covers SIGHUP, and however the first run ends the page
is stopped, its output goes into `launch.log`, and the file goes. `gobbonet
uninstall` removes the ones older versions left: regular files of exactly that
shape, in GobboNet's own folder.

**The location page offered the data folder for models when its only models
were in its own `models` subfolder.** The page offers, pre-selected, to use a
data folder that already holds models as the models folder (#68), so that
pointing setup at a collection does not give an empty subfolder. It counted
the data folder's `models` subfolder as part of the collection. A model already
there is common: 1.7.9's wizard said existing models belong in
`~/.local/share/gobbonet/models`, `gobbonet uninstall` leaves kept models
there, and setup can be run again. The page then offered the data folder
itself, one click on Continue stored `model_dir` as the data folder, and since
the model menu lists the top of `model_dir`, GobboNet started with no model
("llama-server did not start: no .gguf files in /home/…/gobbonet"). Found by
walking 1.8.0's wizard with the choices made in 1.7.9's. Now a data folder
whose models are all in its own `models` subfolder is not offered; that
subfolder stays the models folder, and its note says the model is found. A
folder with models anywhere else is offered as before, counting all of them.

**"1 GGUF model found here. They will be in the model menu."** The note now
says "It" for one model.

## How it was built

From the extracted 1.8.0 update ZIP (`make-zip.sh --no-engine`), not a git
checkout. 1.7.9's was built that way too (its version says `nogit`), and it
means the package carries exactly the ZIP's files and takes its build id from
the program: `1.8.0+go.<commit>-1`. The pinned Vulkan archive,
`llama-b10456-bin-ubuntu-vulkan-x64.tar.gz` (SHA-256 `856fcfe9…1772`), was put
in `installer-linux/vendor/`, and the build checked it against the pin.
`SOURCE_DATE_EPOCH` was the commit's time, so two builds from two extractions
of the ZIP gave the same file, byte for byte. `installer-linux/README.md` has
the command.

**This way of building reproduces 1.7.9.** The official
`gobbonet_1.7.9go.nogit.20261102-1_amd64.deb` (GitHub drops the `+` from the
name) was downloaded from the v1.7.9 release. Rebuilt from `git archive v1.7.9`
with its own program, the same engine archive and its own time
(`SOURCE_DATE_EPOCH=1793633538`), the result is byte-identical to it (SHA-256
`5f91b163951236b84cc78df15751b4b14ade6c3962e6676fd5df57a902f5e259`). Built in
a git worktree instead, the package is named after the commit, which is why
the ZIP is the source.

## How it was checked

- **Against the official 1.7.9, entry by entry** (both unpacked; every tar
  entry's type, mode, owner, link target and content compared):
  - the same 88 entries, in the same order, with the same modes, owners and
    link targets;
  - 81 byte-identical, among them all of `llama-cpp/` but `ENGINE.txt`, the
    menu entry, the icon and `copyright`;
  - the other 7: `gobbonet`, `gobbonet-launch`, `gobbonet-setup.py`,
    `wizard.html`, `models.ini` and `README.md`, each byte-for-byte the ZIP's
    (`models.ini` is `catalog/models.ini`, which the build regenerates from
    `launch.bat` and found unchanged), and `ENGINE.txt`, whose only change is
    its "bundled by" line;
  - `postinst` and `postrm` identical; `control` differs only in Version and
    Installed-Size (about 1.3 MB more: the program is larger). The
    dependencies are 1.7.9's, the libc6 floor read from the engine (2.34) the
    same.
- **lintian** (2.117.0ubuntu1.6) reports the same 73 findings for both, none
  new: the engine's programs and libraries as upstream ships them (unstripped,
  the libraries marked executable), the static Go program, and the package as
  it has always been (a URL for Maintainer, no changelog or manual page, the
  absolute `/usr/bin/gobbonet` link, `bash` and `coreutils` named without a
  version).
- **Installed with apt on Ubuntu 24.04** (a container: no desktop, a stand-in
  `xdg-open` that records what it is asked to open, the wizard and the chat
  driven in headless Chromium) and used as ordinary users. apt pulled in the
  Recommends, `mesa-vulkan-drivers` and `zenity`. The model was
  `installer-fedora/make-test-model.py`'s random-weight model with a 4096-token
  context (the script takes one now: the default character's prompt, about 600
  tokens, does not fit its usual 512):
  - **Upgrade.** 1.7.9 installed and set up through its own wizard, a chat
    answered; GobboNet stopped; `apt install ./gobbonet_1.8.0…deb` ("Unpacking
    gobbonet (1.8.0…) over (1.7.9…)"). Started from the same command: straight
    into the chat, the engine on the same model, signed in with the same
    password, 1.7.9's conversation listed (in a fresh browser, so from the
    server's copy), a new chat answered. `config.toml` and the model
    byte-for-byte as 1.7.9 left them; `engine-choice` written. CHECK FOR
    UPDATES reports the package install and says to install the new package
    over it (the release list itself could not be fetched from here). `dpkg -V`
    finds nothing changed.
  - **A fresh first run with 1.7.9's choices**, beside 1.7.9's, page by page
    in the same browser: Welcome, Password, Port, Firewall, Backend, Optional
    additions, Ready to launch and Ready are pixel-identical. The location page
    is the new one; the model page differs only in its note (the user's name
    in the path, and that a model is already there). The models folder stays
    `<data>/models`, and GobboNet starts on the model in it.
  - **A fresh first run with a models folder of the user's own**
    (`~/my-models`, holding the model): "1 GGUF model found here"; `model_dir`
    stored as chosen, no `models` folder made in the data folder; a chat
    answered on that model; `config.toml` 0600 in a 0700 folder, the data
    folder 0700; Start at login on, and the login entry runs
    `gobbonet-launch --no-browser`, which starts the server and opens nothing.
  - **A first run stopped part way** (SIGTERM to the launcher with the wizard
    open): no `setup.XXXXXX` left, nothing of it still running, the page's
    output in `launch.log`; `gobbonet uninstall` then leaves nothing.
  - **`tests/test-linux-onboarding.py`**, run as an ordinary user against
    `/usr/lib/gobbonet`: both runs pass (local and LAN).
  - **`apt remove`, then `apt purge`:** the program, command, menu entry and
    icon go; every file and folder in both users' homes is unchanged
    (listing and checksums compared).
  - **`gobbonet uninstall`** (package reinstalled), with GobboNet's embedding
    model in place, and an unfinished download of it for one user: answering
    yes to the models, nothing of GobboNet's is left; answering no, with a
    models folder of their own, the config, the data (embeddings too) and the
    login entry go and that folder keeps its model. Given the same layout,
    1.7.9's program left the embeddings folder, `launch.log` and
    `engine-choice`, and so the data folder.
  - `/usr/share/doc/gobbonet/README.md` was not installed here: this image's
    dpkg configuration excludes `/usr/share/doc` but each `copyright`. 1.7.9's
    the same.
- **Tests:** `tests/test-launch-setup-log.py` (new: the launcher stopped by
  SIGTERM, SIGHUP and SIGINT before and after the browser step, and a failed
  setup; fails on the previous launcher, which left the file every time and
  the setup page running on SIGHUP); `tests/test-wizard-location.mjs` (new:
  the location page's own code against a stand-in `/api/scan`; fails on the
  previous page); `cmd/gobbonet/uninstall_test.go` (new: the embedding model
  and its download removed with `--keep-models`, a user's own file in
  `embeddings` kept, and a setup log removed while a file named
  `setup.notes.txt` stays; each fails on the previous code). All suites:
  Go, JavaScript 73 of 73, Python 39 of 39.

## Found, and left for the maintainer's call

- **`launch.log` and `engine-choice` follow the user's umask** (0664 on
  Ubuntu) where the rest of the data folder's files are 0600. The folder is
  0700, so no one else can reach them; 1.7.9 the same.
- **The embedding model's message on every start without it.** With no
  embedding model downloaded, `launch.log` gets "[embed] failed: no embedding
  model at …" on each start. It says what to do, but "failed" reads worse than
  "off" for a download the user skipped.

## Not done here

- **A desktop.** No GNOME, KDE or file manager: double-clicking the `.deb`,
  the menu entry, the icon in a menu and a real browser opening were not seen.
  The menu entry, icon and post-install scripts are byte-for-byte 1.7.9's.
- **A GPU.** apt's `mesa-vulkan-drivers` gave the engine a CPU Vulkan device
  (llvmpipe), so "GPU acceleration confirmed" in the log means that, not a
  graphics card.
- **A real model download.** HuggingFace cannot be reached from here, so the
  wizard's Download and Download Nomic were not run; the models were put in
  place by hand, and the embedding model was a stand-in file of that name.
- **The release list.** GitHub's API cannot be reached from here, so CHECK FOR
  UPDATES got as far as saying this is a package install.
