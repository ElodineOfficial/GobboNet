# Building the packages

> Renamed from `BUILDING-1.7.3.md`. A build guide whose *filename* carries a
> version is a file that is wrong from the next release onward — the same
> disease as the frontend build stamp that sat at `1.6.0-no-encoded-payload`
> through the whole of 1.7.x. `VERSION` is the one place a release number
> belongs.

Three artefacts, three commands, in this order. Everything below was verified
against the tree as it ships except where marked.

---

## Order matters

`build-release.sh` produces the binaries the other two package. Run it first.

```sh
./scripts/build-release.sh                    # Go binaries, stamped from VERSION
# Windows: installer-win/ -- stage the payload, then makensis (installer-win/README.md)
cd installer-linux && ./build-deb.sh  # gobbonet_<VERSION>+go.<sha>-1_amd64.deb
./build-appimage.sh                   # GobboNet-<deb version>-x86_64.AppImage, from that .deb
```

The AppImage is made from the `.deb`, not beside it, so the two carry the same
files. `build-appimage.sh` unpacks the newest `dist/gobbonet_*_amd64.deb` (or
the one you name), adds `AppRun`, the menu entry and the icon, and joins a zstd
squashfs of it to the AppImage type 2 runtime. The runtime is pinned by SHA-256
in the script, like the engine, and the build checks the result embeds no
update address. It does not use appimagetool. Set `SOURCE_DATE_EPOCH` for a
reproducible image. Background: `docs/changelog/CHANGELOG-1.7.8-appimage.md`.

**The Windows installer is `installer-win/`.** It is the dark
installer: Welcome, Destination, Password, Port, Install, the Defender notice,
then Finish with *Launch GobboNet* and *Set up phone access*. The first launch
opens `launch.bat` in a console window, which fetches llama.cpp, detects the
hardware and offers the model list. It is the Windows installer from 1.7.0 on,
1.7.4 apart (below).

Until 1.7.9 there was also an `installer/` directory: a separate design that
chose a backend and downloaded a model during setup. It was never meant to
ship, was built by mistake for 1.7.4 and the first 1.7.7 test build, and was
removed in 1.7.9. Its model catalogue lives on in `catalog/`.

The Debian revision — the `-1` — counts PACKAGING-only changes to one upstream
version and resets when `VERSION` moves. `build-deb.sh` defaults it to 1 so a
new release resets it with nobody having to remember; a packaging-only rebuild
of the same upstream version passes the next number:

```sh
DEB_REVISION=2 ./build-deb.sh
```

It used to be the literal `-3`, left over from 1.7.3's three packaging repairs,
which meant 1.7.4 shipped claiming two earlier Debian revisions that never
existed.

`VERSION` is the single input to all three. Tag `v` + `VERSION` (for 1.7.9,
`v1.7.9`) before building, or `TestVersionFileMatchesUpstreamRelease` will fail:
it compares `VERSION` against the nearest git tag, on purpose.

Two places carry the number as a literal and move with `VERSION`. A test fails
if either is left behind:

- `GOBBONET_UI_VERSION` in `js/01-config.js` (`tests/test-version-stamp.mjs`);
- `APPVER`, `OutFile` and `VIProductVersion` in `installer-win/gobbonet.nsi`
  (`tests/test-version-strings.py`).

---

## Preflight

| Need | Check | Status here |
|---|---|---|
| Go ≥ 1.25 | `go version` | required by every builder |
| NSIS 3.12, large strings | `makensis -VERSION`; `-HDRINFO` says sections are 32792 bytes | what built every installer-win release since 1.7.7; how to build it on Linux is in installer-win/README.md |
| `dpkg-deb`, `zstd`, `fakeroot` | for the deb | |
| Network to GitHub releases | `build-deb.sh` fetches the engine; `build-appimage.sh` the runtime, once | |
| `mksquashfs` with zstd (squashfs-tools) | for the AppImage | |

---

## Toolchain

Go 1.25 or newer, no cgo, to build at all. A release is never built with an
older Go than the release before it: `scripts/go-floor.sh`, which
`make-zip.sh` and `build-release.sh` call first, refuses anything older than
`GO_FLOOR` (go1.25.14, what built 1.7.8 and 1.7.9). Raise it when a release
moves to a newer Go. Go's patch releases are mostly security fixes. Through 1.7.4 the authoring sandbox could not reach
the Go module proxy, so that release's zip shipped without binaries; that
history is in `docs/changelog/`. Every builder since builds both binaries, and
`scripts/make-zip.sh` refuses to produce an archive with a platform missing.

---

## What *was* verified

**`stage-web.sh`** — runs clean; `chat.html`'s 24 js and 17 css references match
the tree, and all five JS modules changed this release reach the payload.

**Layout** — the deb tree `build-deb.sh` produces was diffed against the shipped
`gobbonet_1_7_go_9051875-1_amd64.deb`: same paths, same `usr/lib/gobbonet/`
layout, same `usr/bin/gobbonet` shim, same `web/` placement.

**`VERSION`** — read by `build-release.sh` and `build-deb.sh`.
`installer-win/`'s script and the page stamp carry literals of their own; see
"Order matters" above.

---

## Engine fetch

**`engine.sha256` at the repo root is the single pin for all three builds.** It
carries `LLAMA_BUILD` and one hash per platform archive; bumping the build means
updating every hash in the same commit.

It moved here from `installer-linux/` in 1.7.4. Before that only the deb build
pinned anything — the Windows installer bundled whatever was sitting in
the old `installer/vendor/`, with a look for `ggml-vulkan.dll` as the only check. An
`.exe` and a `.deb` carrying the same version number could therefore contain
different engines, with nothing recording which. That is precisely the question
you want answered when one platform reproduces a bug and the other does not.

All three builders now fetch from GitHub releases and refuse a mismatch. The
Windows payload also carries `llama-cpp/ENGINE.txt`, so the bundled engine is
still identifiable after installation. To reuse an engine you already have:

```sh
SKIP_ENGINE_FETCH=1 ./build-deb.sh          # uses installer-linux/vendor/
BUNDLE_CPU_ENGINE=1  ./build-deb.sh         # also ship the CPU-only archive

```

The Windows installer (`installer-win/`) bundles no engine. `launch.bat`
downloads one on first launch and checks it against its own pin,
`LLAMA_PIN_TAG` and `LLAMA_PIN_SHA256` near the top of the file. That pin is
separate from `engine.sha256`.

`LLAMA_CPP=` is the one route that skips verification, because a hand-placed
directory cannot be hashed against an archive nobody kept. The build says so
rather than implying a check that did not happen, and `ENGINE.txt` in the
payload records it as unverified.

The uploaded 1.7 deb carries a usable Vulkan engine at
`usr/lib/gobbonet/llama-cpp/` if you want to populate `vendor/` from it rather
than re-downloading — but check `engine.sha256` first, since 1.7.4 may pin a
newer `LLAMA_BUILD` than that package was cut against.
