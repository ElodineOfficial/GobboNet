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
  runs the local setup page, then starts the normal supervisor.

Tests cover the archive format and symlinks, both Mac pins, Metal unified-memory
classification, RAM conversion, updater refusal, the listening marker, the
portable bind-denial invariant, and the package's static first-launch contract.
