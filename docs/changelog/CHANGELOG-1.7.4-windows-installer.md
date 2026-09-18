# 1.7.4 — Windows installer

Roadmap item 13, first of three. `GobboNetSetup-1.7.4-go-nogit.20260917.exe`,
19 MB, built with NSIS 3.09 — the version `build-installer.sh` asks for, so it
is byte-comparable with one built on your side.

## The visuals and version stamp were already right

That was the thing to confirm first, and it checks out. Everything derives from
`VERSION`; the `.nsi` hardcodes nothing and takes the version as a `-D` define.

Read back out of the built `.exe`:

```
ProductName      GobboNet
FileDescription  GobboNet Installer
FileVersion      1.7.4-go-nogit.20260917
ProductVersion   1.7.4-go-nogit.20260917
CompanyName      Elodine
LegalCopyright   Elodine / GoblinCorps -- free to use, copy and modify
```

So Windows' own file-properties dialog reports 1.7.4, which is one more place
a user can be asked "which build?" without opening the app.

The art is intact and at the dimensions MUI2 actually wants — the two that
silently look wrong when they drift:

| | | |
|---|---|---|
| `gobbonet.ico` | 7 images, 16→256 px | full set, so it stays sharp at every shell size |
| `modern-header.bmp` | 150×57, 24bpp | MUI2's header slot exactly |
| `modern-wizard.bmp` | 164×314, 24bpp | MUI2's welcome/finish slot exactly |

Payload verified to carry this release's work rather than a stale staging
directory: 24 js + 17 css, `GOBBONET_UI_VERSION = '1.7.4'`, and the item 6, 8
and 11 markup present.

## The gap that was worth finding

**The Windows engine was not pinned.** `build-installer.sh` bundled whatever
was sitting in `installer/vendor/`, with a look for `ggml-vulkan.dll` as the
only check. The deb build has pinned and hash-verified its engine all along.

So an `.exe` and a `.deb` carrying the same version number could contain
**different llama.cpp builds**, and nothing anywhere recorded which. That is
exactly the question you want answered when one platform reproduces a bug and
the other does not — and it is unanswerable after the fact, because the
bundled engine was anonymous once installed.

Three changes:

**One pin for all three builds.** `installer-linux/engine.sha256` moved to
`engine.sha256` at the repo root and gained `LLAMA_BUILD` plus the Windows
hash. Same rule `VERSION` already follows: one literal, read by every builder.
`build-deb.sh` and `build-rpm.sh` both read the new path — the rpm build read
the old one too, so moving it without updating that would have broken the
third package while fixing the first.

**The Windows engine is fetched and verified**, like the Linux one:
`llama-b10456-bin-win-vulkan-x64.zip`, SHA-256
`60f3d31c…`. Verified to refuse both a tampered archive and a stale pin:

```
ERROR: SHA-256 mismatch for llama-b10456-bin-win-vulkan-x64.zip
       expected 60f3d31cc7c2fe62de8f34f8d75ffd06655b4de83bcc5aa6f08df56be42ebb91
       got      f665cac00a769c8e42c18a975ff912635df80973e6fee52fba04d5934787e3b9
```

The engine is re-extracted on every build rather than trusting a leftover
directory, because the hash speaks for the archive and not for whatever was
unpacked last time.

`LLAMA_CPP=/path/to/llama-cpp` still bypasses the fetch, for an engine you
placed deliberately. That route **cannot** be verified — a hand-placed
directory has no archive to hash — so the build says so plainly instead of
implying a check that did not happen.

**`llama-cpp/ENGINE.txt` ships in the payload**, so the bundled engine stays
identifiable after installation:

```
llama.cpp build: b10456
asset:           llama-b10456-bin-win-vulkan-x64.zip
backend:         vulkan
pinned hash:     60f3d31c...
verified:        yes (sha256 matches the pin)
bundled by:      GobboNet 1.7.4-go-nogit.20260917
```

## Environment notes

The Windows binary is cross-compiled from Linux — `CGO_ENABLED=0 GOOS=windows`,
the same flags `build-release.sh` uses — so it is the same artefact that script
would produce.

`installer/vendor/`, `installer/payload/` and `GobboNetSetup-*.exe` were
already in `.gitignore`, so the auto-fetch lands in an ignored directory and
nothing new needed adding. One comment there said the engine was "fetched by
hand" and no longer is.

`models.ini` is regenerated on every build, as designed, and came out
byte-identical to the committed copy — so `launch.bat` and the catalogue have
not drifted.

## Not done yet

The `.deb` and `.rpm` are the remaining two thirds of item 13.
`LINUX-START-HERE.md` and `installer-linux/README.md` still name 1.7.3
packages; they are updated when the packages they describe are actually built,
so they do not point at files that do not exist.
