# Fedora packaging

The RPM counterpart to `installer-linux/`. If you already know that directory,
this one holds few surprises — it stages the same tree, from the same sources,
and the differences below are the ones RPM and Fedora force.

```sh
../build-release.sh          # produces the linux/amd64 binary (or use the
                             # release binary already at ../linux-amd64/gobbonet)
./build-rpm.sh               # fetch + verify the engine, stage, build, check
sudo dnf install ./dist/gobbonet-*.rpm
```

Needs `rpm-build`, `rpm`/`rpm2cpio`, `cpio`, `file` and `curl` (Fedora:
`sudo dnf install rpm-build cpio file curl`; Debian/Ubuntu: `sudo apt install
rpm rpm2cpio cpio file curl`). The package comes out the same on either: every
macro whose default differs between hosts is pinned in the spec.

## What the builder checks

`build-rpm.sh` compiles nothing, and checks everything it is handed:

- **the engine** against `engine.sha256` — the same pin, read the same way, as
  `build-deb.sh`. A cached archive in `vendor/` is re-verified on every build.
  Then the same three guards the deb applies: an ELF `llama-server`, a real
  engine library beside it, and `libggml-vulkan.so` present.
- **the binary** against `VERSION`: `gobbonet version` has to say this release.
  The package's Release field is taken from that same string (`1.go.<build id>`),
  so the package names the build inside it — not today's date, not whatever
  commit the checkout has moved on to.
- **the staged tree** against `payload.manifest`, via `../verify-payload.sh`,
  exactly as the deb does. See that file for why both builds share one list.
- **the finished package** against `check-rpm.sh`. A package that fails is
  removed from `dist/`.

`check-rpm.sh` also runs on its own, against any GobboNet `.rpm`:

```sh
./check-rpm.sh dist/gobbonet-*.rpm
```

It holds the package to what every earlier Fedora build got wrong: requirements
generated as sonames (no hand-written library packages, no Vulkan, nothing the
package carries itself), no shared libraries offered to the system,
`/usr/bin/gobbonet` reaching the guided launcher, the wizard and desktop entry
rewritten for Fedora, unversioned doc directories, no `web/`, public file modes,
the engine really in it, the binary matching Version and Release, and — inside a
source tree — the launcher, wizard and catalogue byte-identical to the ones the
deb ships.

## What is different from the .deb, and why

**Dependencies are generated, not written.** rpm reads the bundled engine's ELF
files and requires exactly what they need, down to the symbol version:
`libssl.so.3()(64bit)`, `libc.so.6(GLIBC_2.34)(64bit)`,
`libstdc++.so.6(GLIBCXX_3.4.30)(64bit)` and so on. Only two things are filtered
out: `libvulkan.so.1` (optional — ggml drops the Vulkan backend and runs on the
CPU backends beside it) and the engine's own `libggml*`/`libllama*`/`libmtmd*`,
which live in the private directory and are found through its `$ORIGIN`
RUNPATH. `python3`, `bash`, `coreutils`, `grep`, `xdg-utils` and
`hicolor-icon-theme` are stated by hand, because nothing in an ELF file says so.

This replaced hand-written library packages (`openssl-libs >= 3.0`, `glibc >=
2.34`, ...) in 1.7.6, and Fedora 45 is why. It moved to OpenSSL 4, whose
libraries are `libssl.so.4` and `libcrypto.so.4`. `openssl-libs` 4.0 still
satisfied `>= 3.0`, so dnf installed a package whose engine then failed with
`error while loading shared libraries: libssl.so.3`. Fedora 45 does ship OpenSSL
3 as the compat package `openssl3-libs`, but dnf only installs it for a package
that asks for `libssl.so.3` by name — which this one now does. If a later Fedora
drops `openssl3-libs`, dnf refuses to install GobboNet and names the missing
library, instead of installing an engine that cannot start. Tested, see below.

**`/usr/lib64`, not `/usr/lib`.** Fedora puts architecture-specific content in
`%{_libdir}`, which is `/usr/lib64` on x86_64. It is also where 1.7.3-3 put it,
and it has to stay there: existing users' configs name
`/usr/lib64/gobbonet/llama-cpp/llama-server` as their engine.
`gobbonet-launch` finds its own directory
(`PREFIX="$(dirname "$(readlink -f "$0")")"`), so it is shipped byte-identical
to the deb's. What names Debian specifics is rewritten during `%install` and
then grepped to confirm the rewrite landed: `Exec=` in `gobbonet.desktop`, and
two lines of the setup wizard — the program-files path, and the firewall
command, which is `firewall-cmd` on Fedora, not `ufw`. A silent miss produces a
package that installs cleanly and then misleads, which is why each is checked
rather than trusted.

**`/usr/bin/gobbonet` runs the launcher**, as on Debian, not the Go binary —
linking the binary skips first-run setup and the browser. It is a relative
link, so it resolves the same in a chroot, an image build or an ostree
deployment.

**Build-host independence.** Pinned in the spec, because each default differs
between Fedora and other hosts: unversioned doc directories
(`_docdir_fmt %%{NAME}` — elsewhere FEDORA.md landed in
`/usr/share/doc/gobbonet-1.7.6/`), no build-id links (`_build_id_links none`;
there are no debuginfo packages to pair with, and Fedora treats an ELF file
without a build-id as fatal while making them), and a zstd payload
(`_binary_payload w19.zstdio`; gzip -9, the default elsewhere, is 35 MB instead
of 20 MB).

**Scriptlet arguments are counts, not words.** dpkg passes `configure`,
`remove`, `purge`. RPM passes a number: in `%post` it is 1 on first install and
2+ on upgrade; in `%preun` and `%postun` it is the number of copies *left*, so
0 is a real removal and 1 is the removal half of an upgrade.

That matters. The removal notice must print on `$1 = 0` only. Printing it on
every upgrade would be the same class of mistake as PKG-1 on the Debian side,
where the notice appeared twice on a purge and the second copy told the user to
reinstall in order to delete files — at the exact moment they had asked for
everything to be gone.

**A root-run server's `web/` is cleaned up.** The server writes its built-in
page beside the binary whenever that directory is writable, which for a
packaged install means only when someone ran GobboNet as root (`sudo
gobbonet`). Nothing owns those files, so they would outlive the package. `%post`
and `%preun` remove `%{_libdir}/gobbonet/web` — only when it carries the
server's own `.gobbonet-ui` stamp.

**Bundled libraries are filtered out of the metadata.**
`__provides_exclude_from` covers the whole private directory, so the package
never advertises `libggml-base.so()(64bit)` and the rest system-wide, where an
unrelated package could satisfy a dependency against a copy of llama.cpp that
disappears when GobboNet is removed. `Provides: bundled(llama.cpp) = b10456` is
declared so a security response can find the bundled copy.

**No stripping, no debuginfo.** `%global __os_install_post %{nil}` and
`%global debug_package %{nil}`. The Go binary carries build metadata that
`gobbonet version` and `debug/buildinfo` read; the llama.cpp `.so` files are
upstream's and are not ours to modify.

**License** is `AGPL-3.0-or-later AND Apache-2.0 AND BSD-3-Clause AND MIT`:
GobboNet, plus what is compiled into or shipped beside it (llama.cpp is MIT and
its licence is installed as `LICENSE.llama-cpp`; the Go modules are listed in
the spec).

**`Release`, not `Version`, carries the build id**, as `<revision>.go.<build
id>`, with anything illegal in a Release field turned into dots. `RPM_REVISION`
(default 1) counts packaging-only rebuilds of one release, like `DEB_REVISION`.
The suffix comes from `DIST=`, defaulting to `.fedora` as 1.7.3-3 shipped:
nothing in the package is built against one Fedora release, so one package
serves all current ones. Set `DIST=.fc45` to tag a specific release.

## Signing

Fedora 45 switched on rpm's signature enforcement (`%_pkgverify_level all`):
`rpm -i` refuses an unsigned package there. `dnf install ./gobbonet-*.rpm` does
not — dnf skips OpenPGP checks for a file named on its command line and says so
— so the unsigned package installs on every current Fedora, and that is the
documented way in.

To sign anyway:

```sh
RPM_SIGN_KEY=<gpg key id> ./build-rpm.sh
```

Users then import the public key once (`sudo rpm --import gobbonet.asc`), after
which `rpm -i` works on Fedora 45 too. Tested with a throwaway key: refused as
NOKEY before the import, installed after it.

## Engine

Same pinned build as the deb — `b10456`, verified against `engine.sha256`,
which stays the single source for that build and its hashes. Three ways to
supply it:

```sh
./build-rpm.sh                                   # download (cached in vendor/)
SKIP_ENGINE_FETCH=1 ./build-rpm.sh               # never download; the archive
                                                 # must already be in vendor/
REUSE_DEB=../installer-linux/dist/gobbonet_*.deb ./build-rpm.sh
```

The archive in `vendor/` is hash-checked on every build either way. (Before
1.7.6, `SKIP_ENGINE_FETCH=1` used an extracted `vendor/llama-cpp/` as-is and
checked nothing.) `REUSE_DEB` lifts the engine out of a `.deb` you already
built, and refuses one whose `ENGINE.txt` names a different build.

Both packages write `llama-cpp/ENGINE.txt` into the install, so "which engine
are you on?" has an answer on a user's disk.

## Testing without Fedora hardware

```sh
pip install gguf numpy && ./make-test-model.py test-model.gguf   # < 1 MB
sudo ./test-in-fedora.sh --root f45 --rpm dist/gobbonet-*.rpm \
     --python cpython-3.15.*-x86_64-unknown-linux-gnu-install_only*.tar.gz \
     --openssl3-from <a dir with Fedora 44's libssl.so.3* and libcrypto.so.3*> \
     --upgrade-from gobbonet-1.7.3-3.go.nogit.20260908.fedora.x86_64.rpm \
     --model test-model.gguf
```

It runs inside throwaway copies of an official Fedora root filesystem (the
header of the script says where to get one per release), with that release's
own rpm, dnf, glibc, libstdc++ and OpenSSL, and checks: which requirements the
real Fedora rpmdb cannot meet; that dnf refuses the package where nothing
provides OpenSSL 3; an offline `dnf install ./package`; `rpm -V`; the engine and
the command as an ordinary user; `tests/test-linux-onboarding.py` — the full
first-run flow — against the installed package as that user; GobboNet in local
mode as that user, starting the bundled engine on a model and answering a chat
through its own proxy; that a root-run server's `web/` is cleaned up; removal,
with the user's data untouched; and an upgrade from 1.7.3-3, including the
stale `web_root` its launcher left in configs.

The local-mode step matters more than it looks. The onboarding test never
starts the engine — it proves setup, then switches to a remote backend — so on
Fedora 45 it passes even for a package whose engine cannot load. The model from
`make-test-model.py` is random weights; it proves the engine loads a model and
generates with Fedora's libraries, not that it says anything useful.

Results for 1.7.6, on the userlands of 2026-09-20:

| | rpm | OpenSSL | signatures | Python | result |
|---|---|---|---|---|---|
| Fedora 43 | 6.0.2 | 3.5.8 | optional | 3.14 | 20/20 |
| Fedora 44 | 6.0.2 | 3.5.8 | optional | 3.14 | 20/20 |
| Fedora 45 | 6.1.0 | 4.0.2 | enforced | 3.15 | 21/21 |
| Rawhide (46) | 6.1.0 | 4.0.2 | enforced | 3.15 | 21/21 |

It cannot test SELinux (the chroot has none), a real desktop session, GNOME
Software, or GPU inference. Those still need Fedora hardware.

On a Fedora box, `rpmlint dist/gobbonet-*.rpm` is worth a look. Expect it to
flag the statically linked Go binary, the unstripped engine, the unsigned
package, `#!/usr/bin/env` in the shared launcher and the stamped `rm -rf` in
`%post`/`%preun`. Each is deliberate and explained above.

## What is deliberately not here

No config or data is written to a home directory at install time, on either
platform. The scriptlets run as root, so anything they created would be
root-owned in whichever home they guessed at, and the user who then set their
own password could not write to it. First launch creates the config, as the
user. `gobbonet setup` does it.

Removal leaves `~/.config/gobbonet` and `~/.local/share/gobbonet` alone,
including the downloaded models — gigabytes the user waited for, on an operation
they may be reversing in thirty seconds. `gobbonet uninstall`, run as the owning
user, is what clears them.
