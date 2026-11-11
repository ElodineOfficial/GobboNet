# Updates: the button in ABOUT (1.8.0)

ABOUT > THIS BUILD has **CHECK FOR UPDATES**. It asks GitHub whether a newer
GobboNet is out. If one is, it says what it is and how big it is, and
**UPDATE NOW** asks before it does anything. Then GobboNet downloads the
release, checks it, puts the new program in place and offers **RESTART NOW**.

This file covers what the button does and what it trusts, and what the
maintainer does once and then for every release so the button can install
that release.

## For everyone

- **Nothing happens on its own.** GitHub is asked only when you press the
  button. The request is a plain GET of GobboNet's public release list. It
  carries nothing about you or your install: no version, no ID. The
  comparison happens on your PC.
- **Only what the maintainer signed is installed.** Each release carries an
  update file, `gobbonet-update.json`, signed with the maintainer's private
  key. The matching public key is built into the program, so GobboNet refuses
  a release nobody signed, a file uploaded by someone else, or a download that
  was changed on the way. The update file pins the SHA-256 and size of the
  download, and of the program inside it. Before the new program goes in, it
  is run once to confirm it starts and is the build the update file names.
- **Never backwards.** A release older than yours is never offered. The same
  release is offered again only as a fix: the same version number, built from
  a later commit. (Each build carries the time of the commit it was built
  from, which is how two builds of 1.8.0 are put in order.) The build you are
  running is never offered back to you.
- **Your things are left alone.** Only the `gobbonet` program file is
  replaced (`gobbonet.exe` on Windows). The chat page is built into it, so the
  page updates too. Chats, characters, models, settings and your password are
  not touched. The program it replaced stays beside the new one, as
  `gobbonet.exe.old`, until GobboNet next starts, and is removed then.
- **The restart.** RESTART NOW stops the model, starts the new GobboNet and
  reloads the page. On Windows the new program runs in the same window. A
  reply still being written stops. The model loads again, and you sign in
  again, because sign-ins do not survive a restart. You can also skip
  RESTART NOW: the new version runs the next time GobboNet starts.
- **From the PC only.** A phone can check, and is told to install from the
  PC, the same rule as `config.toml`.
- **When the button cannot install.**
  - A copy installed from a `.deb` or `.rpm` package is updated with the new
    package, so the package manager stays in charge of its files. The button
    links the release page instead.
  - So does a copy in a folder GobboNet cannot write to.
  - So does a build made without the maintainer's key (see below).
- **Switching it off.** In `config.toml`, `update_releases_url = ""` switches
  the button off. Point it at another URL to use a mirror of the release
  list, in GitHub's format. Only releases signed with a key built into the
  program are installed, whatever list they come from.

`gobbonet update check` from a terminal answers what the button would.

## For the maintainer: once

The button installs only releases signed by a key whose public half is in
`internal/update/trusted-keys.txt` **in the build that does the
installing**. A 1.8.0 built without a key there can never update itself, so
add the key before building the first release that should update itself.

1. Make the key, somewhere outside the repository:

   ```sh
   gobbonet update keygen --out ~/keys/gobbonet-update.key
   ```

   It writes the private key (readable by you only) and prints one line,
   `ed25519 <public key> gobbonet-update <date>`.

2. Paste that line into `internal/update/trusted-keys.txt` and commit it.
   `TestTrustedKeysFileParses` fails the build if the line is mangled.

3. Keep the private key **off GitHub, out of every release, and out of
   CI logs**, and back it up. Whoever holds it can sign an update that every
   GobboNet trusting it will install. Without it, builds that trust it can only
   be updated by hand. (`*.key` is gitignored, and
   `scripts/make-update-manifest.sh` refuses a key inside the checkout.)

`make-zip.sh` and `build-release.sh` warn when the keys file has no key.

**Changing the key:** add the new line beside the old one and ship a
release with both. Once that release is out, sign with the new key, and
remove the old line in a later release. A build can only check a signature
against the keys it already has.

## For the maintainer: every release

From a clean checkout of the release commit:

```sh
bash ./scripts/make-zip.sh --no-engine        # dist/GobboNet-1_8_0-update.zip
bash ./scripts/make-update-manifest.sh --key ~/keys/gobbonet-update.key \
     --notes "One or two sentences for the update box." \
     --notes-url https://github.com/ElodineOfficial/gobbonet/releases/tag/v1.8.0
```

Then attach these to the GitHub release, beside each other, with the names
unchanged:

- the ZIP (`GobboNet-1_8_0-update.zip`),
- `dist/gobbonet-update.json`,
- `dist/gobbonet-update.json.sig`.

The update file points at the ZIP's `GobboNet/gobbonet.exe` for Windows and
`GobboNet/linux-amd64/gobbonet` for the Linux ZIP. The version, build and
serial in it are read out of those two programs, not typed in, and a ZIP
holding two different builds is refused.
`--appimage installer-linux/dist/GobboNet-<version>-x86_64.AppImage` adds the
AppImage as its own download; attach it beside the others. The script reads
the AppImage's version by running it, so do that on Linux.

The update file names each download as the release will list it. GitHub drops
a `+` from an attached file's name, so `build-appimage.sh` leaves it out of the
AppImage's (since 1.8.0), and the script refuses a name GitHub would change
rather than sign a download nobody would find.

The full ZIP (with the engine) works in place of the update ZIP: pass it
with `--zip`. The update ZIP is a third of the size, and that is the
download every user's button will make.

**A hotfix:** commit the fix, keep `VERSION` as it is, and do the same three
steps. Then either publish a new release (`1.8.0-Hotfix`, say) or replace
the three files on the existing one. Either way it is offered as a fix to
everyone on an earlier build of 1.8.0, and to nobody on a later one.

**Prereleases and drafts are never offered.** Publish as a prerelease to
test with `update_releases_url` pointed at a list of your own first.

## How it works

| Piece | Where |
|---|---|
| The rule, the update file, signatures, the GitHub list, the download, the swap | `internal/update` |
| `/update/check`, `/update/status` (any signed-in device), `/update/install`, `/update/restart` (a browser on this PC, with an `Origin` that is this server) | `internal/server/update.go` |
| The restart (exec on Linux, keeping the process ID; a new process in the same console on Windows), `gobbonet update ...`, `version --json` | `cmd/gobbonet/update.go`, `restart_*.go` |
| The button | `js/28-update.js`, ABOUT in `chat.html` |
| The serial stamp | `internal/version` (`Stamp`), set by `scripts/make-zip.sh` and `scripts/build-release.sh` |

A check reads the newest five published releases that carry an update file.
It verifies each signature, ignores any release not newer than the running
build, and offers the newest of the rest that has a download for this
platform (`windows-amd64`, `linux-amd64`, `appimage-amd64`). Every request and
redirect must go to GitHub (`api.github.com`, `github.com`,
`*.githubusercontent.com`) or to the host of `update_releases_url`, over https.
Plain http is allowed only to this machine.
