# Fedora packaging

The RPM counterpart to `installer-linux/`. If you already know that directory,
this one holds no surprises — it stages the same tree, from the same sources,
and the differences below are the ones RPM forces.

```sh
../build-release.sh          # produces the linux/amd64 binary first
./build-rpm.sh               # then this
sudo dnf install dist/gobbonet-*.rpm
```

## What is different from the .deb, and why

**`/usr/lib64`, not `/usr/lib`.** Fedora puts architecture-specific content in
`%{_libdir}`, which is `/usr/lib64` on x86_64. Two files name the prefix
literally — `PREFIX=` in `gobbonet-launch` and `Exec=` in `gobbonet.desktop` —
and the spec rewrites both during `%install`, then greps to confirm the rewrite
landed. Everything else in the launcher derives from `PREFIX`, so those two
lines are the whole of it. A silent miss here produces a package that installs
cleanly and cannot find its own binary, which is why it is checked rather than
trusted.

**Scriptlet arguments are counts, not words.** dpkg passes `configure`,
`remove`, `purge`. RPM passes a number: in `%post` it is 1 on first install and
2+ on upgrade; in `%postun` it is the number of copies *left*, so 0 is a real
removal and 1 is the removal half of an upgrade.

That last one matters. The removal notice must print on `$1 = 0` only. Printing
it on every upgrade would be the same class of mistake as PKG-1 on the Debian
side, where the notice appeared twice on a purge and the second copy told the
user to reinstall in order to delete files — at the exact moment they had asked
for everything to be gone.

**Bundled libraries are filtered out of the metadata.** Without
`__provides_exclude_from`, the package would advertise `libggml-base.so()(64bit)`
and the rest system-wide, and an unrelated package could satisfy a dependency
against a copy of llama.cpp living inside GobboNet's private directory — which
then disappears when GobboNet is removed. `__requires_exclude_from` covers the
other direction: the bundled engine's `NEEDED` entries must not become hard
dependencies, because `pick_engine()` falls back to the CPU build when Vulkan is
absent. Vulkan is a `Recommends`, matching Debian.

`Provides: bundled(llama.cpp) = b10456` is declared so a security response can
find the bundled copy.

**No stripping, no debuginfo.** `%global __os_install_post %{nil}` and
`%global debug_package %{nil}`. The Go binary carries its build metadata in a
section that `gobbonet version` and `debug/buildinfo` read; `brp-strip` removes
it, turning a supportable binary into one that cannot say what it is. The
llama.cpp `.so` files are upstream's and are not ours to modify.

**Payload compression is pinned** to `w19.zstdio`. Fedora's rpm defaults to
zstd, but rpm on other hosts still defaults to gzip -9 — 40 MB instead of 24 MB
for byte-identical contents. Pinning means the package does not change size
depending on where it was built.

**`Release`, not `Version`, carries the build id.** RPM's `Version` is the
upstream version and must stay clean, so the git short SHA goes in `Release` as
`1.go.<sha>`. Dashes are illegal there and are replaced with dots. The `.fc42`
dist tag comes from `DIST=`, defaulting to `.fc42`; set it to match whatever you
are targeting.

## Engine

Same pinned build as the deb — `b10456`, verified against
`installer-linux/engine.sha256`, which stays the single source for that hash.
Three ways to supply it:

```sh
./build-rpm.sh                                   # fetch and verify
SKIP_ENGINE_FETCH=1 ./build-rpm.sh               # reuse vendor/
REUSE_DEB=../installer-linux/dist/gobbonet_*.deb ./build-rpm.sh
```

The third lifts the engine straight out of a `.deb` you already built. It is
the same upstream asset, already unpacked and already verified when that package
was made, and it works offline.

## Checking a build

```sh
rpm -qip  dist/gobbonet-*.rpm     # metadata
rpm -qlp  dist/gobbonet-*.rpm     # file list -- expect /usr/lib64
rpm -qp --provides dist/*.rpm     # must NOT list any .so
rpm -qp --requires dist/*.rpm     # must NOT list libvulkan
rpm -qp --scripts  dist/*.rpm     # scriptlets
```

On a real Fedora box, `rpmlint dist/gobbonet-*.rpm` is worth a look. Expect it
to complain about the bundled libraries and the missing debuginfo package; both
are deliberate and explained above.

## What is deliberately not here

No config or data is written to a home directory at install time, on either
platform. The scriptlet runs as root, so anything it created would be root-owned
in whichever home it guessed at, and the user who then set their own password
could not write to it. First launch creates the config, as the user.
`gobbonet setup` does it.

Removal leaves `~/.config/gobbonet` and `~/.local/share/gobbonet` alone,
including the downloaded models — gigabytes the user waited for, on an operation
they may be reversing in thirty seconds. `gobbonet uninstall`, run as the owning
user, is what clears them.
