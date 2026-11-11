<!--
Thanks for the pull request. A PR is often reimplemented rather than merged as
it stands, because the code moves quickly; you are credited either way, in
CONTRIBUTORS.md and the release notes. See CONTRIBUTING.md.
-->

## What changed, and why

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## Tests run

<!-- The commands and what they said. The usual three:
for f in tests/*.mjs; do node "$f" || echo "FAILED: $f"; done
for f in tests/*.py;  do python3 "$f" || echo "FAILED: $f"; done
bash ./scripts/stage-web.sh && go test ./...
-->

## What was not tested

<!-- Much of GobboNet only runs on Windows or needs a GPU. "Not run in a Windows
console" or "no GPU here" is far more useful than saying nothing. -->

## Privacy and security

- [ ] No telemetry, analytics, crash reporting or automatic update checks.
- [ ] No new network destination, or the reason for one is given above.
- [ ] No new dependency, or the reason for one is given above.
- [ ] Every new download is pinned by SHA-256.
- [ ] Anything that can make code run is set from this PC only, and imported or synced content arrives switched off.
- [ ] LAN access stays opt-in and scoped to the local subnet; llama-server stays on loopback.

## House rules

- [ ] A changelog note at `docs/changelog/CHANGELOG-<version>-<topic>.md`: what was happening, the change, and how it was tested.
- [ ] Edited `chat.html`, `js/` and `css/`, never `internal/webui/assets/`.
- [ ] Batch files stay CRLF, with `^(` `^)` in `echo` text inside `( )` blocks and `!VAR!` there.
- [ ] `installer-linux/wizard.html` and `linux-amd64/wizard.html` are still identical.

## AI assistance (optional)

<!-- Entirely optional, and never a gate. If an assistant helped, it makes
review easier to say:
- which assistant;
- what a person checked, and how (ran it, read the code, reproduced it);
- which claims are still unverified. -->
