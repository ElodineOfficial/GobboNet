# 1.7.4 — Debian package

Roadmap item 13, second of three. `gobbonet_1.7.4+go.nogit.20260917-1_amd64.deb`
— 19 MB compressed, 101 MB installed, libc6 floor 2.34.

Installed, run, removed and purged on a real system rather than only inspected
as an archive.

## The version string was wrong

The package came out as `1.7.4+go.nogit.20260917-**3**`.

The Debian revision counts *packaging-only* changes to one upstream version and
resets whenever upstream moves. 1.7.3 went through three of them — the
original, the `web/` permissions repair, and the guided-launcher rebuild — and
the `-3` from that sequence was left hardcoded in `build-deb.sh`.

So 1.7.4 shipped claiming two earlier Debian revisions of itself that never
existed, and the next genuine packaging fix had nowhere sensible to go: you
would have had to call it `-4`, implying a history four deep for a package on
its first build.

Nothing was *broken* by it — `dpkg --compare-versions` still orders
`1.7.3…-3 < 1.7.4…-3` — which is exactly why it would have gone on being wrong.

Fixed at the root rather than by editing the number:

```sh
DEB_REVISION="${DEB_REVISION:-1}"
```

A default, not a literal, so a new `VERSION` resets it with nobody having to
remember — which is precisely what went wrong. A packaging-only rebuild of the
same upstream version passes `DEB_REVISION=2`. Non-integer values are rejected
before anything is staged.

Upgrade ordering checked against every revision that actually shipped:

| from | to `1.7.4…-1` |
|---|---|
| `1.7.3+go.nogit.20260908-1` | upgrades |
| `1.7.3+go.nogit.20260908-2` | upgrades |
| `1.7.3+go.nogit.20260908-3` | upgrades |
| `1.7.4…-1` → `1.7.4…-2` | upgrades |

## The engine pin, from the other side

The `engine.sha256` move made in the exe step got its real test here:
`build-deb.sh` fetched `llama-b10456-bin-ubuntu-vulkan-x64.tar.gz` from the
root pin and verified it.

The deb had the opposite half of the gap the exe had. The exe now ships
`llama-cpp/ENGINE.txt`; the deb shipped **nothing**, so the bundled engine was
anonymous once installed and "which engine are you on?" had no answer short of
hashing shared objects. It carries the same marker now:

```
llama.cpp build: b10456
asset:           llama-b10456-bin-ubuntu-vulkan-x64.tar.gz
backend:         vulkan (with the CPU backends it also carries)
pinned hash:     856fcfe9...
bundled by:      GobboNet 1.7.4+go.nogit.20260917-1
```

Confirmed against the binary itself after installation, which is the check that
actually closes the loop:

```
$ /usr/lib/gobbonet/llama-cpp/llama-server --version
version: 0.1.0-dev (build 10456, commit f275595dd)
```

Pin, package marker and shipped binary all say b10456.

## Verified on a live install

```
$ dpkg -i gobbonet_1.7.4+go.nogit.20260917-1_amd64.deb
$ gobbonet version
1.7.4-go-nogit.20260917 (go1.25.14 linux/amd64)
```

Serving from `/usr/lib/gobbonet/web`: `chat.html` 200, page reports
`GOBBONET_UI_VERSION = '1.7.4'`, 24 js and 17 css. Every route this release
added answers — `/ui-defaults.json` (item 10), `/state/profiles` (item 4),
`/standdown` (item 6).

The desktop entry and the 256×256 hicolor icon install and the icon-cache
trigger fires. **No file in the package lacks world-read**, so the revision-2
bug — `web/` shipped at 0700, which made the package work only for root — has
not come back. `web/` is 0755.

`dpkg -r` removes `/usr/lib/gobbonet`, the `/usr/bin/gobbonet` symlink, the
desktop entry and the icon, leaving nothing behind; `dpkg -P` leaves nothing
either. Config, conversations and models in the user's home are deliberately
untouched — that is what `gobbonet uninstall` is for, and the package
description says so.

## Notes

`fakeroot` is not installed here, so the build took its documented fallback
(`dpkg-deb --root-owner-group`). Ownership in the archive is `root/root`
throughout, which is the point of that flag; the package is identical either
way.

`models.ini` was regenerated on every build and came out byte-identical to the
committed copy, so `launch.bat` and the catalogue have not drifted.

## Not done yet

The `.rpm` is the last third. `installer-fedora/build-rpm.sh` reads the pin
that moved in the exe step, and it has a `Release:` field with the same shape
as the Debian revision — worth checking whether it is stale in the same way.

`LINUX-START-HERE.md` and `installer-linux/README.md` still describe 1.7.3
revision 3 and name its `.deb`. They are updated once all three packages exist,
so nothing points at a file that has not been built.
