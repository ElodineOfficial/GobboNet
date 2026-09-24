# GobboNet 1.7.6 — Linux

Install the Debian package with `sudo apt install ./gobbonet_1.7.6+go.nogit.*_amd64.deb`, then run `gobbonet` as your normal user or select GobboNet in the application menu. On Fedora, install the RPM instead: `sudo dnf install ./gobbonet-1.7.6-*.fedora.x86_64.rpm` (see `installer-fedora/FEDORA.md`).

For the ZIP, extract it, open a terminal in GobboNet and run `./gobbonet`. The ZIP includes a Linux amd64 runtime and the editable source. It needs Python 3.8+, Bash, coreutils, xdg-utils and the same engine libraries listed in the Debian package. Keep the extracted folder in place while using it. Do not run the application with sudo.

## Updating

Replace the `linux-amd64` folder with the one from the new ZIP, or install the new package over the old one. The chat page is compiled into `linux-amd64/gobbonet`, so that single binary carries both halves of the app and they cannot go out of step.

Editing `chat.html`, `js/` or `css/` at the root of the ZIP changes nothing by itself — they are the *source* of the page, and it is built in at compile time. To run your own copy, put the files you want to change in a folder of your own and `gobbonet config set web_root /path/to/that/folder`; files you do not include still come from the binary. Older versions of the launcher wrote a `web_root` line into your config automatically, pointing at the packaged `web/` folder; this release clears that line and says so, because leaving it would serve you the previous version's page forever.

## First launch

Welcome → data/model location → password → web port → firewall explanation → local or LAN launch → bundled llama.cpp engine → model picker and download → optional Nomic embeddings → LAUNCH.

The wizard opens in your default browser. The chat opens automatically after the server starts listening. Large models can take several minutes to load. Reopening GobboNet opens the existing chat instead of starting a second server. The terminal remains attached to the server; Ctrl+C stops it and the optional embedding engine.

Debian owns the program installation under `/usr/lib/gobbonet`; the location screen chooses the potentially much larger model/chat storage folder. Password/configuration remains under `$XDG_CONFIG_HOME/gobbonet` (normally `~/.config/gobbonet`). This revision does not migrate existing conversations between data folders.

The engine is already bundled, so there is no redundant llama.cpp download. Model downloads use the existing Go catalogue downloader and its checksum policy. Nomic is optional, is checked against the SHA-256 pin in launch.bat, and lives in a separate embeddings folder so it cannot become the chat model. A second CPU engine serves embeddings on loopback port 11436.

Linux has no Windows Defender prompt. The wizard explains the firewall equivalent and shows a UFW command for the selected port. LAN selection changes GobboNet's listening address; it does not silently elevate privileges or edit the firewall. Both choices continue through the browser setup and open the chat. If a firewall is active, allow the selected TCP port only on your trusted network.

## Commands

- `gobbonet`: normal setup/launch/browser flow.
- `gobbonet --no-browser`: same flow with URLs printed to the terminal/log instead of opening a browser.
- `gobbonet setup` or `gobbonet setup --force`: rerun the guided flow, then launch.
- `gobbonet setup --status`: completion status, without opening anything.
- `gobbonet serve ...`: explicit server command; preserves advanced server flags and does not run the setup shell.
- `gobbonet doctor`, `gobbonet config ...`: existing administration commands.

For the ZIP, substitute `./gobbonet` in those commands. Launch errors and URLs are in `$XDG_DATA_HOME/gobbonet/launch.log`, normally `~/.local/share/gobbonet/launch.log`.

## Changes and validation

1.7.5 rebuilds the Go server binary: the frontend is now compiled into it, and there is no packaged `web/` directory any more. The pinned llama.cpp b10456 engine is retained and was not recompiled. The Windows side gains `gobbonet.exe` in the ZIP, which it never carried before. The Linux Python setup shell uses the existing Go wizard APIs for password hashing and model downloads, with added screens and completion checks.

Fixed: command bypassing setup/browser launch; engine shared-library discovery; stale setup URL on retries; suppressed terminal output; premature 30-second startup timeout; accepting a missing/failed model at Finish; optional Nomic download and launch; child cleanup on interruption.

Validated using the packaged executable and isolated temporary user directories: local and LAN setup, folder paths containing spaces, password configuration, invalid/custom ports, engine discovery, missing-model rejection, local-to-remote switching, setup completion, login page serving, automatic browser-opener invocation, and reopening an existing server. Browser calls were recorded with a test opener. Python and JavaScript syntax and shell syntax were checked. The Debian build's payload and permission checks passed.

Not validated here: native desktop rendering, a full multi-GB model download, actual model inference, GPU driver combinations, or access from a second physical device. These require a Linux desktop and model download access.

## Rebuild the Debian package from this ZIP

From the GobboNet folder:

```sh
GOBBONET_RUNTIME_DIR="$PWD/linux-amd64" bash installer-linux/build-deb.sh
python3 tests/test-linux-onboarding.py
```

This explicitly reuses the included runtime. For a newly compiled Go server and freshly fetched pinned engine, use the original build-release.sh / build-deb.sh path instead.

A ZIP without `linux-amd64/llama-cpp` (an update ZIP) has no runtime engine to reuse. Point the builder at the included server instead; it fetches the pinned engine and refuses it unless the hash matches `engine.sha256`:

```sh
GOBBONET_BIN="$PWD/linux-amd64/gobbonet" bash installer-linux/build-deb.sh
```

To run the onboarding test against an installed package rather than this folder, as your normal user: `GOBBONET_TEST_PREFIX=/usr/lib/gobbonet python3 tests/test-linux-onboarding.py`. Linux setup source lives in installer-linux/gobbonet-launch, gobbonet-setup.py and wizard.html. internal/setup remains the underlying Go setup API and standalone minimal wizard.
