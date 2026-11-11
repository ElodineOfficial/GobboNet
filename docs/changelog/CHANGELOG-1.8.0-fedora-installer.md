# 1.8.0 — the Fedora .rpm

## What was asked

The maintainer, after the `.deb`: "Now for the rpm! Same deal as before." As
for the `.exe` and the `.deb`, the official 1.7.9 package is the guide, and
1.8.0's should work the same way, updated for the 1.8.0 payload.

## The package

Nothing in the packaging changed. `installer-fedora/gobbonet.spec` (but for its
1.8.0 changelog entry, written over the earlier rounds), `build-rpm.sh`,
`check-rpm.sh`, `test-in-fedora.sh` and the engine are 1.7.9's. Seven files in
the package changed:

| File | Why |
|---|---|
| `gobbonet` | the 1.8.0 program, byte for byte the ZIP's |
| `gobbonet-launch` | the 1.8.0 launcher, the `.deb`'s byte for byte (`installer-linux/README.md` has what changed) |
| `gobbonet-setup.py`, `wizard.html` | the two-folder setup (#68) and the `.deb` round's fixes; the spec's two Fedora rewrites (`/usr/lib64`, firewalld) still apply |
| `models.ini` | the 1.8.0 catalogue, every model with a pinned checksum |
| `llama-cpp/ENGINE.txt` | its "bundled by" line names the package version |
| `/usr/share/doc/gobbonet/FEDORA.md` | names the upgrade tested, now from 1.7.9 |

`installer-fedora/README.md` has a 1.8.0 section, and its results table is
1.8.0's (1.7.6's, which it held until now, is in
`CHANGELOG-1.7.6-fedora-rpm.md`).

No new problem turned up in the package. The fixes found while testing the
`.deb` (`CHANGELOG-1.8.0-linux-installer.md`) are in the shared launcher, setup
page and program, so they are in this package too, and were run again here.

## How it was built

**rpm 4.19.1, as for 1.7.8 and 1.7.9.** Built from
rpm-software-management/rpm at `rpm-4.19.1-release` (98b301e) with CMake: prefix
`/usr` (rpm takes `%_libdir` and the rest from it), `/etc` and `/var`; no Python
bindings, translations, plugins, SELinux, D-Bus, audit or fapolicyd; the
internal OpenPGP parser instead of Sequoia, which needs Rust; libgcrypt.
Installed into a private folder and run from there with `RPM_CONFIGDIR`,
`LD_LIBRARY_PATH` and its own `%_dbpath`, so Ubuntu's rpm 4.18 is never
consulted. Two things on the way: GNU awk is needed (with mawk the tag table
comes out empty, as `CHANGELOG-1.7.9-fedora-installer.md` says), and the
install step stops at the API documentation without Doxygen, so that one line
was skipped.

**This toolchain reproduces 1.7.9.** The official
`gobbonet-1.7.9-1.go.nogit.20261102.fedora.x86_64.rpm` (SHA-256
`dd601b8aa5739f833ad50c26a5bcde380ec6bbebcd6fe5d15fdae4e7f58d81c3`) was
downloaded from the v1.7.9 release. Its header says rpm 4.19.1, platform
`x86_64-vendor-linux`, build host `vm`, a zstd payload at level 19, and a build
time from the clock: 1.7.9 was built without `SOURCE_DATE_EPOCH`. Rebuilt from
`git archive v1.7.9` with its own program (byte for byte the official
`.deb`'s) and the same engine archive, also without it:

- of the 71 header tags, all are the same but the build time and the six that
  sign or digest what the clock touched (the header's SHA-1 and SHA-256, the
  MD5, the payload digests, the signature size);
- all 79 files are the same in digest, size, mode, owner, group, link target,
  flags, colour and class; the 16 that the build makes differ in their time
  only.

**1.8.0 was built from the extracted 1.8.0 update ZIP**, like the `.deb`:
`GOBBONET_BIN` its `linux-amd64/gobbonet`, the engine archive in `vendor/`
(checked against `engine.sha256` by the build), and `SOURCE_DATE_EPOCH` the
commit's time, which `build-rpm.sh` turns into the build time and a ceiling on
file times. Two builds from two extractions of the ZIP are byte-identical.
`installer-fedora/README.md` has the command.

## How it was checked

- **`check-rpm.sh`** passes, `desktop-file-validate` included (its one hint, two
  main categories, is 1.7.9's too).
- **Against the official 1.7.9, tag by tag and file by file:**
  - the same: summary, description, licence, URL, group, platform, build
    host, rpm version, optimisation flags, payload format, compressor and
    level, digest algorithms, the scriptlets and their interpreters, all 72
    requirements, the 4 recommends, and the names of the 5 provides;
  - changed: Version, Release (`1.go.<commit>.fedora`), the build time (the
    commit's), the sizes (about 1.3 MB more, the program), the source rpm's
    name, the provides' versions, and one more changelog entry;
  - the same 79 files in the same order; 72 identical, the engine among them;
    the 7 above differ in content. The launcher, `gobbonet-setup.py` and the
    catalogue are the ZIP's (and the `.deb`'s) byte for byte, and
    `wizard.html` differs from the ZIP's in exactly its two Fedora lines
    (`check-rpm.sh` checks that).
- **rpmlint** 2.5.0 (Ubuntu's, so without Fedora's licence list) finds the
  same 8 errors and 68 warnings in both, nothing new: the static Go program
  (not position-independent, no manual page); the engine as upstream ships it
  (unstripped, duplicate tools, `.so` links, a `gethostbyname` call in its RPC
  library); no signature, Packager or Group tag; `#!/usr/bin/env` in the
  launcher, and a shebang on the setup page without the executable bit (the
  launcher runs it with `python3`); the stamped `rm -rf` in `%post` and
  `%preun`; the changelog's version without the build id; two words in the
  description its dictionary lacks; and the SPDX licence names.
- **`test-in-fedora.sh`**, on the official Fedora root filesystems of
  2026-11-08 (fedora-cloud/docker-brew-fedora), each run upgrading from the
  official 1.7.9 package and loading the 400 KB test model:

  | Fedora | rpm | OpenSSL | Python stand-in | Result |
  |---|---|---|---|---|
  | 43 | 6.0.2 | 3.5.9 | 3.14.10 | 20/20 |
  | 44 | 6.0.2 | 3.5.9 | 3.14.10 | 20/20 |
  | 45 | 6.1.0 | 4.0.3 | 3.15.2 | 21/21 |
  | Rawhide (46) | 6.1.0 | 4.0.3 | 3.15.2 | 21/21 |

  The checks are 1.7.9's: an offline `dnf install`; `rpm -V` before and after
  the first run; the engine and the repo's first-run test as an ordinary user,
  local and LAN; GobboNet in local mode answering a chat; removal, its notice
  printed once and the user's data untouched; dnf's refusal, naming
  `libssl.so.3`, when nothing provides OpenSSL 3 (45 and Rawhide); and the
  upgrade's file ownership, engine path and chat page.
- **As ordinary users in a browser,** on Fedora 44 and 45: a copy of the
  official root with the same test-only stand-ins, users running GobboNet in a
  chroot and headless Chromium on the host as their browser. 35 checks each,
  all passing:
  - **Upgrade.** 1.7.9 installed with dnf and set up through its own wizard
    (Fedora's wording: `/usr/lib64/gobbonet`, the firewalld command), a chat
    answered by the bundled engine; GobboNet closed; dnf upgraded the package,
    `rpm -V` clean. Started again: straight into the chat, the server 1.8.0,
    signed in with the same password, 1.7.9's conversation listed from the
    server's copy, a new chat answered. `config.toml` and the model byte for
    byte as 1.7.9 left them; `engine-choice` written; CHECK FOR UPDATES
    reports a package install; `rpm -V` clean after running it.
  - **A fresh first run with 1.7.9's choices,** beside 1.7.9's in the same
    root: eight pages pixel-identical, the location page the new one (with
    Fedora's path), the model page's note one line longer. The models folder
    stays `<data>/models`, and GobboNet starts on the model in it.
  - **A fresh first run with a models folder of the user's own:** found ("1
    GGUF model found here"), stored as chosen, no `models` folder made in the
    data folder, a chat answered on it; `config.toml` 0600 in a 0700 folder;
    the login entry runs `/usr/lib64/gobbonet/gobbonet-launch --no-browser`,
    which starts the server and opens nothing.
  - **A first run stopped part way:** no `setup.XXXXXX` left, nothing left
    running, the setup page's output in `launch.log`; `gobbonet uninstall`
    then leaves nothing, and its last line names `sudo dnf remove gobbonet`.
  - **`dnf remove`:** the program, the command and the menu entry go, the
    notice prints once, and every file and folder in the users' homes is
    unchanged.
  - **`gobbonet uninstall`** (reinstalled first), with GobboNet's embedding
    model in place: answering yes to the models, nothing of GobboNet's left;
    answering no with a models folder of their own, the config, the data
    (embeddings too) and the login entry go, and that folder keeps its model.
- **`gobbonet doctor`** on a configured install on Fedora 44 runs every
  section; GPU says the engine sees none, which is right in a chroot.
- **The stand-ins**, as for 1.7.9: the harness's test-only package providing
  python3, xdg-utils and hicolor-icon-theme, with a standalone CPython of the
  release's own version (python-build-standalone 20261026, checked against its
  `SHA256SUMS`); Fedora 44's OpenSSL 3.5.9 libraries packaged as
  `openssl3-libs` on 45 and Rawhide; the tiny test models.
- **Tests:** every suite, as in the `.deb` round; nothing in the code changed in
  this one.

## Found, and left for the maintainer's call

- **doctor's GPU line when the engine cannot start.** In a root installed with
  `--nodeps` on Fedora 45, so without OpenSSL 3, `gobbonet doctor` says "could
  not list devices: exit status 127", where the engine's own message names the
  missing library. A real install does not get there (dnf installs
  `openssl3-libs`), and the launcher's `engine-choice` note does carry the
  engine's words; doctor's GPU section could too.

## Not done here

The same as 1.7.9; they need Fedora hardware:

- SELinux (the chroot has none);
- a real desktop session and GNOME Software;
- GPU inference.
