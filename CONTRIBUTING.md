# Contributing to GobboNet

Bug reports, fixes, tests, docs and ideas are all welcome, from anyone,
written however you write them, including with an AI assistant. Two things are
worth knowing before you start: how pull requests are handled, and the privacy
rules every change has to keep.

## How pull requests are handled

- **A PR is often reimplemented rather than merged as it stands.** The code
  moves quickly, and a branch written against last month's tree usually has to
  be redone against this month's. That does not make the fix any less yours.
- **Everyone who helps is credited**, in [CONTRIBUTORS.md](CONTRIBUTORS.md) and
  in the release notes. That includes people who report, diagnose or test
  without ever opening a PR, because GitHub's contributor list only counts
  commits.

## Reporting a bug

Use the **Bug report** template under New issue. It asks for the things that
make a report actionable:

- the version, from **ABOUT** in the app;
- the text from **COPY BUILD INFO**, in the same panel;
- the output of `gobbonet doctor`: on Windows run `gobbonet.exe doctor` in the
  install folder; on Linux run `gobbonet doctor`;
- how you started GobboNet (a Start menu or desktop shortcut, `launch.bat`,
  `gobbonet.exe`, the Linux menu or `gobbonet` command, the AppImage, the ZIP);
- your OS and GPU.

`gobbonet doctor` and the build info can include local network addresses and
folder paths. Read them over before posting, and blank out anything you would
rather not share.

**Security problems:** don't open a public issue. Send the report privately
to Elodine on the [GobboNet Discord](https://discord.gg/rcmN8uEbaa).

## Privacy and security rules

GobboNet is offline and private by design. Changes that weaken that are not
merged, however useful they are otherwise.

- **No telemetry, analytics, crash reporting or automatic update checks.**
- **Nothing leaves the machine unless the user asked for it.** Engine and
  model downloads happen when the user picks them. Web search is the model for
  anything else: off by default, clearly labelled, and it sends only the
  search and the user's own search key.
- **Every download is pinned by SHA-256**: the engine (`engine.sha256`), the
  model catalogue, the embedding model and every file of an endorsed mod. A
  new download needs a pin.
- **A new dependency or network destination needs a reason in the PR.**
- **The code stays legible.** No obfuscation, encoded commands or hidden
  windows. [SECURITY.md](SECURITY.md) explains why this matters for this
  project in particular.
- **LAN access stays opt-in and scoped to the local subnet.** llama-server
  stays on loopback.

## Before you send a change

1. **Run the tests.** None need an install step beyond Node, Python and Go
   1.25 or newer:

   ```sh
   for f in tests/*.mjs; do node "$f" || echo "FAILED: $f"; done
   for f in tests/*.py;  do python3 "$f" || echo "FAILED: $f"; done
   bash ./scripts/stage-web.sh && go test ./...
   ```

   `tests/test-linux-onboarding.py` needs a built `linux-amd64/gobbonet` and an
   engine; `bash ./scripts/make-zip.sh` builds both. See [tests/README.md](tests/README.md).

2. **Keep the house rules the tests can't always catch:**
   - Batch files stay CRLF. Inside a `( )` block, escape parentheses in
     `echo` text (`^(` and `^)`), and read variables as `!VAR!`, not `%VAR%`.
   - Edit `chat.html`, `js/` and `css/`. Never edit `internal/webui/assets/`:
     `stage-web.sh` generates it and the binary embeds it.
   - `installer-linux/wizard.html` and `linux-amd64/wizard.html` stay
     identical.
   - The Windows installer that ships is `installer-win/`, not `installer/`.

3. **Add a short changelog note** as
   `docs/changelog/CHANGELOG-<version>-<topic>.md`: what was happening, the
   change, and how it was tested.

4. **Say what you could not test.** Plenty of GobboNet only runs on Windows,
   or needs a GPU. A PR that says "not run on Windows" is far more useful than
   one that doesn't say.

## AI-assisted contributions

These are welcome. The bug report and PR templates have an optional section
where you can say:

- which assistant helped;
- what a person checked: ran it, read the code, reproduced it;
- which claims are still unverified.

That makes the contribution easier to review. It is not a gate, and leaving it
blank is fine.

## Talking it over

Questions, ideas and half-finished thoughts are welcome on
[Discord](https://discord.gg/rcmN8uEbaa) as well as in issues.

## License

GobboNet is licensed under the GNU Affero General Public License; see
[LICENSE](LICENSE). Contributions are accepted under the same license.
