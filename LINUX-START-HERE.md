# GobboNet 1.7.3 — Linux installer revision 3

Install the Debian package with `sudo apt install ./gobbonet_1.7.3+go.nogit.20260908-3_amd64.deb`, then run `gobbonet` as your normal user or select GobboNet in the application menu.

For the ZIP, extract it, open a terminal in GobboNet and run `./gobbonet`. The ZIP includes a Linux amd64 runtime and the editable source. It needs Python 3.8+, Bash, coreutils, xdg-utils and the same engine libraries listed in the Debian package. Keep the extracted folder in place while using it. Do not run the application with sudo.

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

This is a launcher/packaging revision. The supplied Go server binary and pinned llama.cpp b10456 engine are retained; neither was recompiled. Windows installer files are unchanged. The Linux Python setup shell uses the existing Go wizard APIs for password hashing and model downloads, with added screens and completion checks.

Fixed: command bypassing setup/browser launch; engine shared-library discovery; stale setup URL on retries; suppressed terminal output; premature 30-second startup timeout; accepting a missing/failed model at Finish; optional Nomic download and launch; child cleanup on interruption.

Validated using the packaged executable and isolated temporary user directories: local and LAN setup, folder paths containing spaces, password configuration, invalid/custom ports, engine discovery, missing-model rejection, local-to-remote switching, setup completion, login page serving, automatic browser-opener invocation, and reopening an existing server. Browser calls were recorded with a test opener. Python and JavaScript syntax and shell syntax were checked. The Debian build's payload and permission checks passed.

Not validated here: native desktop rendering, a full multi-GB model download, actual model inference, GPU driver combinations, or access from a second physical device. These require a Linux desktop and model download access.

## Rebuild the Debian package from this ZIP

From the GobboNet folder:

```sh
GOBBONET_RUNTIME_DIR="$PWD/linux-amd64" bash installer-linux/build-deb.sh
python3 tests/test-linux-onboarding.py
```

This explicitly reuses the included runtime. For a newly compiled Go server and freshly fetched pinned engine, use the original build-release.sh / build-deb.sh path instead. Linux setup source lives in installer-linux/gobbonet-launch, gobbonet-setup.py and wizard.html. internal/setup remains the underlying Go setup API and standalone minimal wizard.
