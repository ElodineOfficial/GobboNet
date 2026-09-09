# Building the 1.7.3 packages

Three artefacts, three commands, in this order. Everything below was verified
against the tree as it ships except where marked.

---

## Order matters

`build-release.sh` produces the binaries the other two package. Run it first.

```sh
./build-release.sh                    # Go binaries, stamped from VERSION
cd installer       && ./build-installer.sh    # GobboNetSetup-1.7.3-go-<sha>.exe
cd ../installer-linux && ./build-deb.sh       # gobbonet_1.7.3+go.<sha>-1_amd64.deb
```

`VERSION` is the single input to all three — it already says `1.7.3`. Tag
`v1.7.3` before building, or `TestVersionFileMatchesUpstreamRelease` will fail:
it compares `VERSION` against the nearest git tag, on purpose.

---

## Preflight

| Need | Check | Status here |
|---|---|---|
| Go ≥ 1.25 | `go version` | **unavailable in the authoring sandbox** — see below |
| NSIS 3.09 | `makensis -VERSION` | verified, 3.09 |
| `dpkg-deb`, `zstd`, `fakeroot` | for the deb | |
| Network to GitHub releases | `build-deb.sh` fetches the engine | |

`build-installer.sh` warns if NSIS is not 3.09, because Elodine's 1.3 build used
it and a version match keeps the output byte-comparable for review. 3.09 is what
this was compiled against.

---

## The one thing not done here

**The Go binaries are not built, so no `.deb` and no `.exe` are in the zip.**

The sandbox has Go 1.22.2 from apt against a `go 1.25.0` module, and both the
toolchain download and `proxy.golang.org` are blocked:

```
$ go build ./cmd/gobbonet
go: downloading go1.25.0 (linux/amd64)
go: download go1.25.0 for linux/amd64: toolchain not available

$ GOTOOLCHAIN=local go build ./cmd/gobbonet
go: go.mod requires go >= 1.25.0 (running go 1.22.2; GOTOOLCHAIN=local)

$ curl -o /dev/null -w '%{http_code}' https://proxy.golang.org/...   403
$ curl -o /dev/null -w '%{http_code}' https://go.googlesource.com/crypto   403
```

`GOOS=windows` fails at the same line, so there is no `.exe` either — the
installer is compile-verified but has no binary to wrap.

Working around that would mean building Go from source through a two-stage
bootstrap and then hand-redirecting every module to a GitHub mirror, because
`golang.org/x/...` resolves through a blocked host. The result would not verify
against `go.sum`. For a project that pins a SHA-256 on the engine, on the embed
model and on every catalogue entry, a binary assembled from unverified
dependency sources is not something to hand over — it would be the one
unpinned thing in the build.

**The alternative was worse.** Repacking the 1.7 binary out of the uploaded
`.deb` and relabelling it 1.7.3 would produce packages that pass every
smoke test and contain none of this release: no upstream `/v1/models`, so #47,
#48 and #27 still broken; no ranked LAN addresses; no `doctor` firewall section.
The version string would name a release it was not built from — exactly what
`TestVersionFileMatchesUpstreamRelease` exists to catch.

So: run the three commands above on a machine with a real toolchain. The
packaging inputs are all verified and waiting.

---

## What *was* verified

**`installer/gobbonet.nsi`** — compiled clean with NSIS 3.09, 0 errors,
0 warnings, producing a 772,678-byte installer, against a payload built from the
real `stage-web.sh` output and the real `.bat` / `.ps1` files. Only
`gobbonet.exe` and the `llama-cpp/` contents were stubbed, and neither is parsed
at compile time — they are `File` directives.

**`stage-web.sh`** — runs clean; `chat.html`'s 24 js and 17 css references match
the tree, and all five JS modules changed this release reach the payload.

**Layout** — the deb tree `build-deb.sh` produces was diffed against the shipped
`gobbonet_1_7_go_9051875-1_amd64.deb`: same paths, same `usr/lib/gobbonet/`
layout, same `usr/bin/gobbonet` shim, same `web/` placement.

**`VERSION`** — `1.7.3`, and it is the only version literal. `build-release.sh`,
`build-installer.sh` and `build-deb.sh` all read it; the `.nsi` takes it as a
`-D` define and hardcodes nothing.

---

## Engine fetch

`build-deb.sh` pulls llama.cpp from GitHub releases and checks it against
`installer-linux/engine.sha256`. To reuse an engine you already have:

```sh
SKIP_ENGINE_FETCH=1 ./build-deb.sh          # uses installer-linux/vendor/
BUNDLE_CPU_ENGINE=1  ./build-deb.sh         # also ship the CPU-only archive
```

The uploaded 1.7 deb carries a usable Vulkan engine at
`usr/lib/gobbonet/llama-cpp/` if you want to populate `vendor/` from it rather
than re-downloading — but check `engine.sha256` first, since 1.7.3 may pin a
newer `LLAMA_BUILD` than that package was cut against.
