# 1.8.1 — OpenSSL 3 for the AppImage and the ZIP, on Fedora 45 and later

## What was happening

llama.cpp's `libllama-common.so` and `libllama-server-impl.so` need
`libssl.so.3` and `libcrypto.so.3`. Fedora 45 and later ship OpenSSL 4
(`libssl.so.4`) and keep 3 as a separate package, `openssl3-libs`. The `.rpm`
asks for `libssl.so.3` by name, so dnf installs it; the `.deb`'s systems all
have OpenSSL 3. The AppImage and the ZIP install nothing, so on Fedora 45 their
engine did not load:

```
llama-server: error while loading shared libraries: libssl.so.3: cannot open shared object file
```

and the launcher's engine test read that as the GPU build failing. Reproduced
here with the 1.8.0 launcher on a simulated system without OpenSSL 3 (below):
`engine-choice` said `build=none` with "the GPU build would not start: ...
libssl.so.3", and `gobbonet doctor` said "engine build: none bundled" and
could not list devices. The release notes' known issue told AppImage users to
run `sudo dnf install openssl3-libs` first; ZIP users had the same problem and
no note.

## The change

**The AppImage and the ZIP carry OpenSSL 3**, in `openssl3/`: `libssl.so.3`,
`libcrypto.so.3`, OpenSSL's licence (Apache 2.0, from the `openssl-3.0.2` tag,
`installer-linux/openssl3-LICENSE.txt`), the package's copyright file, and
`SOURCE.txt` naming the package and hashes.

**Where they come from.** Ubuntu 22.04's `libssl3_3.0.2-0ubuntu1.30_amd64.deb`:
22.04 is the system the pinned engine (b10456, GCC 11.4) is built on, so the
engine gets the OpenSSL it was linked against, and the libraries need glibc
2.34 at most, the AppImage's floor. `engine.sha256` pins the package and both
libraries. The package's hash was taken from jammy-updates'
`main/binary-amd64/Packages.xz`, whose hash is in `InRelease`, which verified
with `gpgv` against `ubuntu-archive-keyring.gpg` (Ubuntu Archive Automatic
Signing Key 2018); jammy-security lists the same file.
`scripts/fetch-openssl3.sh DEST [CACHE]` downloads it once, checks it, unpacks
it (`dpkg-deb`, or `ar` + `tar` elsewhere) and checks each library.

**Used only when the system has none.** `gobbonet-launch` (both copies) asks
the dynamic loader, with `LD_TRACE_LOADED_OBJECTS=1` (what `ldd` does; nothing
is run, 2 ms), whether the engine's `libssl.so.3` or `libcrypto.so.3` is "not
found", and only then appends `openssl3/` to `LD_LIBRARY_PATH`. Anywhere the
system has OpenSSL 3 (every Debian, Ubuntu, Arch, openSUSE, and Fedora up to
44, or 45 with `openssl3-libs`) the engine keeps the system's, which its
package manager keeps up to date. The decision is made before the launcher's
command dispatch, so `gobbonet doctor` and every other command see the engine
as the server will, and a launcher that starts itself again (`setup`) keeps it.
It is written to `engine-choice` as `openssl=system|bundled` and, when bundled,
to the launch log. The `.deb` and `.rpm` carry no `openssl3/`, so for them the
launcher does what it did.

The engine uses OpenSSL for llama.cpp's own model downloads (`-hf`, `-mu`) and
for serving HTTPS (`--ssl-key-file`); `Supervisor.BuildArgs` and `EmbedArgs`
pass none of those (GobboNet downloads models itself, in Go, and the engine
listens on loopback over plain HTTP). So a bundled copy that falls behind
Ubuntu's security updates is not reachable from the network in GobboNet's use.
A newer pin needs the same check as this one.

**Saying so.** `gobbonet doctor`'s GPU section: "openssl: GobboNet's own
OpenSSL 3 -- this system has none", and that installing `openssl3-libs` makes
the engine use the system's. `GET /gpu` returns `engine_openssl`, and CONFIG >
Performance's note says the same in a sentence (`updateGpuNote()`).

**Building.** `make-zip.sh` requires `linux-amd64/openssl3` with exactly the
pinned files, in the full and the update archive: a ZIP install updated from
either has no other way to get them. `build-appimage.sh` runs the fetch into
the AppDir after `verify-payload.sh` has held it to the `.deb`'s list, and
checks the launcher in the `.deb` is one that uses it. `openssl3/` is not in
`scripts/payload.manifest`, so the packages still cannot carry it.
`/linux-amd64/openssl3/` is gitignored. The update button replaces only the
program file, so a ZIP on Fedora 45 needs a zip extracted once (the AppImage is
replaced whole); `PATCH-README.txt` says so.

## Tests

- `tests/test-openssl3.py` (new). Statically: the pins, the fetch script's
  checks, the licence, `make-zip.sh`'s manifest and refusal, the AppImage
  adding it after the payload check, no package builder shipping it, the
  `.gitignore`, both launchers one file, the decision before the dispatch.
  Then the real launcher on this system and on a simulated one without
  OpenSSL 3: in a private mount namespace (`unshare -m`, or `-rm` without
  root), the system's `libssl.so.3` and `libcrypto.so.3` -- found through the
  loader, not assumed -- are covered by an ELF header for AArch64, which the
  x86-64 loader skips, so they are "not found" exactly as on Fedora 45. With
  the system's OpenSSL, `openssl3/` stays off the path; without it, 1.8.0's
  error is reproduced, the launcher adds `openssl3/` (and a package prefix
  without one is left alone), the engine starts with `LD_BIND_NOW=1` and both
  libraries resolve to the bundled files; a real first run records
  `build=gpu` and `openssl=bundled`, the log says so, and `gobbonet doctor`
  says so and lists devices; the same first run with the system's OpenSSL
  records `openssl=system`. 25 checks.
- Go: `TestParseEngineChoice` (the new key; an unknown value is dropped),
  `TestDoctorSaysWhoseOpenSSL`, `TestGPUSaysWhoseOpenSSL`.
- `tests/test-gpu-choice.mjs`: the Performance note, and nothing said for
  `system` or an older launcher's file.
- `scripts/fetch-openssl3.sh` run three ways: from the cache, by a fresh
  download, and on a PATH without `dpkg-deb` (it names the missing `zstd`).

Not run: a real Fedora 45 (the simulation covers the loader's view, not the
rest of a Fedora system), the AppImage build itself (with the installers), and
a model loaded through the bundled libraries (none is available here; the
engine's own start with every symbol bound is what the libraries decide).
