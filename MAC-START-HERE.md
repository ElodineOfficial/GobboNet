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
4. First launch downloads the pinned llama.cpp engine, checks its SHA-256, and
   opens the local setup page. The model you choose is a separate download.

GobboNet stores configuration under `~/.config/gobbonet` and models, engine,
logs, and conversations under `~/.local/share/gobbonet`. The app bundle itself
contains no model and can be replaced without removing those files.

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

## LAN access and the firewall

LAN access is off by default. If you enable it, macOS may ask whether GobboNet
may accept incoming connections. If another device cannot connect, open
**System Settings > Network > Firewall > Options** and allow GobboNet. Apple
documents application firewall access at
<https://support.apple.com/guide/mac-help/mh34041/mac>.

GobboNet's doctor reports that it cannot inspect the Application Firewall; it
does not claim a silent firewall is open and does not change firewall settings.

## Stop and remove

Quit the app or stop its process. GobboNet owns the llama.cpp processes it
starts and stops them with itself. To remove GobboNet's data as well as the app,
run:

```sh
/Applications/GobboNet.app/Contents/MacOS/gobbonet-bin uninstall
```

The command asks before removing data unless you pass an explicit confirmation
flag. Removing only `GobboNet.app` leaves models and conversations in place.
