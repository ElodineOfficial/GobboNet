# GobboNet Windows installer

Turns "downloaded the setup exe" into "chatting" with no console window in
between. Everything `launch.bat` used to ask at a `C:\>` prompt — hardware
probe, model choice, download, config — is a wizard page, and the finish
page's **Start GobboNet** checkbox lands on a working chat.

## Wizard flow

| # | Page | Notes |
|---|------|-------|
| 1 | Welcome | Elodine's 1.3 artwork and copy, reworded for the bundled engine |
| 2 | Directory | Per-user, `$LOCALAPPDATA\GobboNet`, no elevation |
| 3 | Backend | *On this PC* (bundled llama.cpp) or *remote* (URL + API key) |
| 4 | Hardware | Runs `hardware-probe.ps1` out of `$PLUGINSDIR`, shows GPU/VRAM/RAM/disk — local only |
| 5 | Model | Catalogue from `models.ini`, recommendation preselected — local only |
| 6 | Install | Copies files, downloads the GGUF, verifies it, writes config |
| 7 | Finish | **Start GobboNet**, plus the opt-in LAN setup |

Pages 4 and 5 `Abort` out of their create functions when the backend is
remote, which is how NSIS skips a page.

Page 4 runs **before** the install section, so `$INSTDIR` is still empty when
the probe fires. `.onInit` extracts `hardware-probe.ps1` into `$PLUGINSDIR`
and the page runs that copy, writing `hardware.json` and `hardware.ini` there
too; the install section copies `hardware.json` into `$INSTDIR` afterwards so
`launch.bat` inherits the result instead of re-probing. Reading the probe from
`$INSTDIR` instead — as an earlier revision did — invokes a path that does not
exist yet, and every install silently takes the "could not read this machine's
hardware" branch.

## What is bundled vs downloaded

**Bundled:** `gobbonet.exe`, web assets, llama.cpp, the `.ps1` helpers.
**Downloaded:** the GGUF model, and only the GGUF model.

That split is not arbitrary. `launch.bat` documents at length that
`cmd → temp .ps1 with Bypass → downloads an executable archive` is the shape
behavioral AV reads as malware staging, and that it kills the process tree
with no error text. An unsigned installer fetching a zip of `.exe` files is
the same shape with a worse parent process, so llama.cpp ships inside the
installer. A `.gguf` is inert data and carries no such signature — and it is
also the only file too large to bundle.

The PowerShell the installer *does* run only reads WMI, the registry and
`nvidia-smi`. It downloads nothing, so it is not the pattern `launch.bat`
removed — and `launch.bat` already invokes it exactly this way.

## The catalogue is generated, not copied

The model catalogue is defined across `launch.bat` (menu lines and download blocks)
and `hw-recommend.ps1` (the `$min` VRAM table and recommendation ladder).

`gen-catalog.py` parses these sources into `models.ini`, which NSIS reads with
native `ReadINIStr`. Hand-copying them into the wizard would fork the
catalogue the first time a quant is bumped. `build-installer.sh` regenerates
it on every build, and the generator fails loudly rather than emitting a
catalogue with holes in it.

**`models.ini` is generated — do not edit it.** Change `launch.bat` and `hw-recommend.ps1`.

## Download integrity

Mirrors `launch.bat`'s policy exactly, because HuggingFace serves an LFS
*pointer* — a few hundred bytes of text — instead of the model when things
go wrong, and it arrives as a clean HTTP 200:

- hash mismatch → fatal, file deleted
- pointer unreadable or unparseable → warn and continue
- file under 1 GB → fatal (the backstop for the warn-and-continue path)

Without this the installer would report success and write a config pointing
at a text file.

## Building

```sh
sudo apt-get install nsis          # 3.09 preferred; see below
../build-release.sh                # produces dist/<version>/…windows-amd64.zip
unzip -d /tmp/gn dist/*/gobbonet-*-windows-amd64.zip

# llama.cpp is bundled, so it has to be on disk first
mkdir -p vendor/llama-cpp
#   https://github.com/ggml-org/llama.cpp/releases  →  -bin-win-vulkan-x64.zip
#   extract it into installer/vendor/llama-cpp/
#
# It must be the VULKAN asset. The CPU-only zip has the same filenames minus
# ggml-vulkan.dll, and an installer built from it runs everything on the
# processor while still setting gpu_layers 99 -- no error, just a slow machine.
# build-installer.sh refuses that unless you pass LLAMA_BACKEND=cpu.

GOBBONET_EXE=/tmp/gn/*/gobbonet.exe ./build-installer.sh
```

Elodine built 1.3 with **NSIS 3.09**. Debian bookworm ships 3.08. The script
warns on a mismatch rather than failing — it builds fine either way, but a
version match keeps the installer diffable against one Elodine builds, which
matters for review.

## Layout

```
gen-catalog.py       launch.bat  ->  models.ini   (run by build-installer.sh)
models.ini           GENERATED. Do not edit.
gobbonet.nsi         the wizard
build-installer.sh   stages payload/, regenerates the catalogue, runs makensis
art/                 modern-header.bmp, modern-wizard.bmp, gobbonet.ico
                     (extracted from GobboNetSetup-1.3.exe — Elodine's work)
plugins/x86-unicode/ INetC.dll, for the GGUF download progress dialog
payload/             GENERATED staging folder. Not committed.
vendor/llama-cpp/    the bundled engine. Not committed (fetched by hand).
```

`vendor/` lives here rather than at the repo root on purpose: a directory
named `vendor` at a Go module root is reserved by the toolchain, and putting
non-Go files there breaks `go build`.

## Not done yet

- **Untested on Windows.** Compiles clean under NSIS with zero warnings, but
  compiling only proves the syntax. Nothing here has been *run*: not the probe
  timer, not the `-IniPath` parse, not the listbox index mapping, not the LFS
  pointer check.

  `-IniPath` is a local addition to `hardware-probe.ps1`, re-ported onto
  upstream's v1.5 rewrite of that file (schema 2, ~1,960 lines). Upstream's
  own `-EmitEnv` does not substitute for it: it writes bare `KEY=VALUE` lines,
  and `ReadINIStr` needs a `[section]` header. The sanitiser differs from
  `ConvertTo-EnvSafe` too — `!` and `%` are batch hazards, not INI hazards, and
  must survive; newlines and `;` must not. Those three cases are covered by
  `hardware-probe.ps1 -SelfTest`, which is runnable on any Windows box without
  touching the installer.
- **Unsigned.** See the signing discussion — a cert changes the SmartScreen
  story but not the behavioral-AV story, which is why the bundle/download
  split above still stands regardless.
- The `launch.exe` / `launchLAN.exe` C shims from 1.3 are deliberately
  dropped. They existed to locate the install folder and `ShellExecute` a
  `.bat`; `gobbonet.exe` is a real executable, so the shortcuts point
  straight at it.
