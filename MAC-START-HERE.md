# GobboNet on macOS

This ZIP contains an **unsigned, unnotarized** `GobboNet.app`. It is a test
package, not an Apple-notarized release. macOS may block it because Apple has
not checked it, and overriding that warning reduces a protection Apple
recommends keeping in place. Verify the ZIP's published SHA-256 before opening
it.

## Start

1. Unzip the archive and move `GobboNet.app` to Applications if you want it
   there.
2. Open `GobboNet.app`.
3. If macOS blocks it, try once, then open **System Settings > Privacy &
   Security**, scroll to Security, and choose **Open Anyway** only if you trust
   the archive and its checksum. Apple documents the current procedure at
   <https://support.apple.com/en-us/102445>.
4. The first launch downloads the pinned llama.cpp engine (about 11 MB), checks
   its SHA-256, runs it once so macOS finishes its own first-run check of a new
   program (that can take ten seconds or more), and opens the local setup page.
   The model you choose there is a separate download. Then it fetches the small
   retrieval model (about 146 MB, once, checked against its pin), the same file
   the Windows first run downloads, so characters can find lore by meaning.

GobboNet has **no window and no Dock icon**. It runs in the background and you
use it in your browser, like the Linux desktop launcher.

GobboNet stores configuration under `~/.config/gobbonet` and models, engine,
logs, and conversations under `~/.local/share/gobbonet`. The app bundle itself
contains no model and can be replaced without removing those files. If opening
the app seems to do nothing, `~/.local/share/gobbonet/launch.log` says why.

## Come back to it, or stop it

Open `GobboNet.app` again while it is running. It asks:

- **Open the chat** opens the chat page in your browser.
- **Stop GobboNet** asks the server and its engine to stop, and waits for them.

From Terminal, `pkill -x gobbonet-bin` does the same as **Stop GobboNet**.

Please do not **Force Quit** it from Activity Monitor (its plain **Quit** is
fine). A forced quit cannot run GobboNet's cleanup, so the engine is left
running with the model in memory. If that happens, open `GobboNet.app` again:
it stops the engine it left behind before it starts.

## Build from source

Go 1.25 or newer is required. From the repository root:

```sh
bash ./scripts/stage-web.sh
go build ./cmd/gobbonet
```

To build the app ZIP on a Mac instead:

```sh
bash ./installer-mac/build-app.sh dist
```

The builder refuses a dirty tree by default so the version stamped into the
binary names the code in the archive.

## What works

- Apple Silicon and Intel Mac engine downloads are pinned by architecture.
- Metal devices are detected from llama.cpp's own device list and treated as
  unified memory.
- Chat model supervision, streaming, detached jobs, embeddings, tokenization,
  model stand-down and wake, and clean child-process shutdown use the same Go
  paths as Linux and Windows.
- `GobboNet.app/Contents/MacOS/gobbonet-bin doctor` prints the resolved paths,
  engine and Metal classification.

Start at login is not offered by this package yet. The Linux XDG login entry is
not written on macOS. Automatic in-place app updates are also not offered; a
new app ZIP replaces the bundle while keeping data outside it.

## Not tested

- **Intel Macs.** The Intel engine is pinned and the program compiles for it,
  but nothing here has run on an Intel Mac.
- **A copy downloaded through a browser.** The package was opened from the
  machine that built it, so macOS never applied its quarantine. The **Open
  Anyway** steps above are Apple's documented ones and were not walked through.
- **LAN access from another device**, and the macOS firewall prompt it brings.
- **macOS versions.** Run on one Mac: Apple Silicon (M1 Max, 32 GB).

## LAN access and the firewall

LAN access is off by default. If you enable it, macOS may ask whether GobboNet
may accept incoming connections. If another device cannot connect, open
**System Settings > Network > Firewall > Options** and allow GobboNet. Apple
documents application firewall access at
<https://support.apple.com/guide/mac-help/mh34041/mac>.

GobboNet's doctor reports that it cannot inspect the Application Firewall; it
does not claim a silent firewall is open and does not change firewall settings.

## Remove

Stop GobboNet first (above). To remove GobboNet's data as well as the app,
run:

```sh
/Applications/GobboNet.app/Contents/MacOS/gobbonet-bin uninstall
```

The command asks before removing data unless you pass an explicit confirmation
flag. Removing only `GobboNet.app` leaves models and conversations in place.
