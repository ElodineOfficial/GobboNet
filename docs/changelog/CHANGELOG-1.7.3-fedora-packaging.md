# v1.7.3 — Fedora packaging

A requested fork of the Linux package. `installer-fedora/` is new: a spec file,
a build script shaped like `build-deb.sh`, and a README aimed at someone who
maintains the Debian package and has not maintained an RPM.

Nothing about the product changed. The RPM stages the same tree from the same
sources — same Go binary, same `stage-web.sh` frontend, same pinned llama.cpp
`b10456`, same `gobbonet-launch`. What follows is only what RPM forces.

---

## Four things RPM does differently, and what each would have cost

**`/usr/lib64`, not `/usr/lib`.** Fedora puts architecture-specific content in
`%{_libdir}`. Two files name the prefix literally — `PREFIX=` in
`gobbonet-launch`, `Exec=` in `gobbonet.desktop` — and the spec rewrites both
during `%install` and then greps to confirm the rewrite landed. Everything else
in the launcher derives from `PREFIX`. A silent miss produces a package that
installs cleanly and cannot find its own binary, so it is checked rather than
trusted.

**Scriptlet arguments are counts, not words.** dpkg passes `configure`,
`remove`, `purge`; RPM passes a number, and in `%postun` it is the number of
copies *left* — 0 for a real removal, 1 for the removal half of an upgrade. The
removal notice therefore prints on `$1 = 0` only. Printing it on every upgrade
would be the same shape of bug as PKG-1 on the Debian side.

**Bundled libraries have to be filtered out of the metadata.** Without
`__provides_exclude_from`, the package advertises `libggml-base.so()(64bit)` and
the rest system-wide, and an unrelated package can satisfy a dependency against
a copy of llama.cpp inside GobboNet's private directory — which vanishes when
GobboNet is removed. `__requires_exclude_from` covers the reverse: the engine's
`NEEDED` entries must not become hard dependencies, because `pick_engine()`
falls back to the CPU build when Vulkan is absent.

Verified on the built package:

```
Requires:   /bin/sh, /usr/bin/env, libc.so.6(GLIBC_2.34), xdg-utils
Recommends: curl, mesa-vulkan-drivers, vulkan-loader, zenity
Provides:   gobbonet, bundled(llama.cpp) = b10456, application(gobbonet.desktop)
```

No `.so` in Provides, no Vulkan in Requires. The glibc floor rpm derived from
the binary is `GLIBC_2.34` — the same floor the Debian control file states by
hand as `libc6 (>= 2.34)`, arrived at independently.

**No stripping, no debuginfo.** The Go binary carries build metadata in a
section `gobbonet version` and `debug/buildinfo` read; `brp-strip` removes it,
turning a supportable binary into one that cannot say what it is.

## Two bugs found while building it

**Duplicate doc paths.** The spec installed `README.md` and `copyright` by hand
*and* listed them under `%doc` / `%license`. On the build host this produced
four files where there should be two. On Fedora it would have been worse than
untidy: `_docdir_fmt` is `%{name}` there, so `%doc` writes to the exact path the
manual copy used and the build fails on duplicate files. Built anywhere else the
docdir is versioned and the collision hides — a bug that only appears on the one
distribution the package is for. The manual installs are gone; `%doc` and
`%license` place them.

**gzip payload.** rpm outside Fedora still defaults to gzip -9, which produced a
40 MB package for contents the deb fits in 23.5 MB. `_binary_payload` is now
pinned to `w19.zstdio`, so the package does not change size depending on where
it was built. Final size 23,613,257 bytes, within 46 KB of the deb.

## Verified

Built, then installed and removed against a test root:

- `gobbonet version` from the installed tree reports `1.7.3-go-nogit.20260908`
- `PREFIX` resolves to a real `gobbonet`, `models.ini`, `web/` and
  `llama-cpp/llama-server`
- `/usr/bin/gobbonet` symlinks to `/usr/lib64/gobbonet/gobbonet`
- the Go fixes are in the shipped binary: `v1/models` ×3, `lan_addresses`,
  `upstream_error`, `LAN ACCESS`
- the frontend fixes are in the shipped `web/`: `resolveDryPenaltyLastN`,
  `safeUrlBody`, `getRequestModelName`
- `rpm -e` leaves nothing behind
- no `/usr/lib/gobbonet` path survives anywhere in the file list

`rpmlint` was not available here. On a Fedora box expect it to flag the bundled
libraries and the absent debuginfo package; both are deliberate and documented
in `installer-fedora/README.md`.
