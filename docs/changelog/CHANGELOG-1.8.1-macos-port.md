# v1.8.1 — macOS app package

GobboNet now has a native macOS application bundle builder and pinned
llama.cpp engine downloads for Apple Silicon and Intel Macs.

- `gobbonet engine install` accepts the pinned upstream macOS tarballs,
  preserves their relative library symlinks, rejects escaping links and checks
  the archive SHA-256 before extraction.
- Apple Metal devices remain the devices llama.cpp reports. Apple M-series
  GPUs are classified as integrated unified memory, with system RAM read from
  `hw.memsize`, so model recommendations do not treat shared memory as a
  separate dedicated card.
- The in-app updater refuses installation on macOS with a manual-update reason;
  it cannot overwrite an app bundle as though it were one portable binary.
- Current llama.cpp's `llama_server: listening on` log line counts as a
  successful load. This is a cross-platform parser repair discovered by the
  Mac run, not a Metal-specific behavior.
- The setup page does not offer the Linux XDG start-at-login entry on macOS.
  Doctor names the limit of its macOS Application Firewall inspection.
- `installer-mac/build-app.sh` creates an unsigned, unnotarized app ZIP. Its
  first launch installs the pinned engine through GobboNet's checked path,
  runs the local setup page, fetches the pinned retrieval model (the file the
  Windows first run downloads; nothing fetched it on a Mac, so semantic search
  stayed off), then starts the normal supervisor.
- The engine install runs the engine once on macOS before calling it ready.
  The first run of a freshly unpacked `llama-server` took 13.7 s for `--help`
  on an M1 Max while the system checked it, against 0.08 s for the second.
  The memory-fitting probe allows 10 s and remembers a failure, so the first
  model load after an install was killed mid-check and every later one failed
  until a restart. The probe also allows a minute on macOS, for an engine
  placed by hand.
- The app has no Dock icon (`LSUIElement`). The program has no window to
  answer Quit, and a Force Quit cannot run GobboNet's cleanup: the engine was
  left running with the model loaded, and the next start reported "engine
  port is already occupied". Opening the app again while it runs offers
  **Open the chat** or **Stop GobboNet** (SIGTERM, then a wait), and a start
  that finds this install's own engine still running stops it first. Only
  processes started from this bundle or this install's engine folder are
  ever matched.
- Installing the engine over an earlier one replaces what is there. The first
  version failed with "file exists" at the first symlink.
- The background ready panel says `pkill -x gobbonet-bin` inside the app,
  the name the program has there.

Found by running it: the two end-to-end runs (the binary alone, and the app's
own launcher with the setup page answered over its API) are what caught the
first-run kill, the missing retrieval model and the forced-quit leftover. None
of them shows in a unit test or with an engine that has already run once.

Tests cover the archive format and symlinks, a reinstall, both Mac pins, the
install's first run, the probe timeout, Metal unified-memory classification,
RAM conversion, updater refusal, the listening marker, the portable bind-denial
invariant, the retrieval model's pin in all five places, and the launcher
itself: `tests/test-mac-package.py` runs it on the system's own bash against a
stand-in binary (a first launch with and without `--no-browser`, opening it
twice, stopping it, and starting after a forced quit).

Not run: Intel Macs, a browser-downloaded (quarantined) copy, LAN access from
another device. On macOS six of the Python suites fail before and after this
change because they exercise the Linux packaging and launcher with GNU tools
(`test-appimage-login-entry`, `test-deb-stamp`, `test-launch-open-browser`,
`test-linux-onboarding`, `test-package-permissions`, `test-setup-port`);
`test-appimage-login-entry` fails one more of its checks there now, because
start at login is refused on macOS instead of writing an XDG entry.
