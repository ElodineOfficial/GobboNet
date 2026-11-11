# 1.8.0 — The update button

ABOUT > THIS BUILD has CHECK FOR UPDATES. It finds a newer GobboNet on
GitHub, asks before installing it, installs it and restarts into it. A
release older than the one running is never installed. A later build of the
same release, a hotfix, is.

## What was there

A CHECK FOR UPDATES button, disabled, among ABOUT's links, with "Update
checks are coming in a later version" under it. Updating meant downloading
the ZIP and replacing `gobbonet.exe` by hand, after closing GobboNet first,
because Windows will not replace a running program.

## The change

**The button** sits under the build's version, beside COPY BUILD INFO. Pressed,
it says one of these:

- a newer release is out, with its version, the download's size, its short
  notes and WHAT'S NEW;
- a fix for the version you have is out, by build;
- you have the newest;
- why it cannot install here, with the release page: a copy installed from a
  .deb or .rpm, a folder it cannot write to, or a build made without the
  signing key;
- what went wrong.

UPDATE NOW asks first. The question names both builds and the size, says that
chats, characters, models and settings are not touched, and that the restart
stops a reply being written, loads the model again and means signing in again.
A progress bar follows the download. Then RESTART NOW: GobboNet stops its model
and its other programs and starts the new version. On Linux this is exec, so the
process ID, terminal and launcher stay the same. On Windows the new version is
started in the same console window, and the old one exits with code 3, so that
`launch.bat`, when it started GobboNet, steps aside instead of saying GobboNet
stopped. The page reloads once the new version answers. Without RESTART NOW, the new version runs the next time GobboNet starts.

**Never backwards.** A build may only be replaced by a later release, or by
the same release built from a later commit. Each build now carries its
commit's time, its serial, stamped by `make-zip.sh` and `build-release.sh` as
`version.Stamp` (`gobbonet-build[1.8.0-go-abc1234/1793932190]`). A short sha
does not sort, and a hotfix keeps the release number. An older release is
never offered, however recently it was published, and neither is the build
already running. The server applies the rule again when UPDATE NOW is pressed.

**What it trusts.** A release can be installed only from a signed update
file attached to it, `gobbonet-update.json` with `gobbonet-update.json.sig`.
The signature is ed25519, and the keys that may sign are built into the program
(`internal/update/trusted-keys.txt`). The update file names the download for
each platform and pins its size and SHA-256, and those of the program inside
it. The size GitHub lists must agree, and the new program is run once
(`gobbonet version --json`) to confirm it starts and is the build promised.
Nothing that fails a check is kept, and the old program is moved back if the
last step fails. Getting a program onto someone's PC this way therefore takes
the maintainer's private key, not only the GitHub account.

**Who may do what.** Any signed-in device may check. Installing and
restarting need a browser on the PC GobboNet runs on, the Config File
editor's rule, with an `Origin` that is this server. So no website can start an
install, even on an install with no password. A phone sees "installed from
GobboNet on the PC".

**Privacy.** GitHub is asked only when the button is pressed, as a plain GET
with `User-Agent: GobboNet` and nothing else. The comparison happens on the PC.
Requests and redirects may go only to GitHub's hosts or the host of
`update_releases_url`, over https. PRIVATE BY DESIGN and Privacy Status say so.
`update_releases_url = ""` in `config.toml` switches the button off.

**What is replaced** is the program file the documented manual update
replaces: `gobbonet.exe` on Windows (the ZIP or GobboNetSetup.exe, both
per-user), `linux-amd64/gobbonet` in the Linux ZIP, or the .AppImage file
itself. The one it replaced waits beside it as `.old` and is removed the next
time GobboNet starts and is serving. On Windows the new file is written as
`gobbonet.new.exe`, so it runs like any program for the check. A rename a virus
scanner is holding up is retried for a few seconds.

**For the maintainer**, `gobbonet update keygen | manifest | sign | verify`
and `scripts/make-update-manifest.sh`. The manifest's version, build and
serial are read out of the programs in the ZIP, so it cannot describe
another build. Two builds in one ZIP are refused, as is a key kept inside the
checkout. `gobbonet update check` answers from a terminal what the button
would. docs/UPDATES.md has the procedure. The keys file ships empty. A build
made with no key there can say a release exists but installs nothing, and
`make-zip.sh` and `build-release.sh` warn about it. The key has to be added
before building the first release that should be able to update itself; that
is the maintainer's call.

Docs: docs/UPDATES.md (new), README.md's "Updating to a newer version",
docs/GO_SERVER.md, AGENTS.md and docs/INDEX.md.

## Tests

- `internal/update` (new):
  - the release-number parser;
  - the never-backwards rule, case by case: a later release, a hotfix, the
    same release from an earlier commit, the running build, an older release
    with a later date, a dev build;
  - the keys file parses;
  - signatures: another key, changed bytes, no keys;
  - the update file refuses a member outside the archive, another product,
    or a build of another release;
  - against a fake GitHub (`internal/update/updatetest`), the check:
    - picks the newest signed release that is newer;
    - skips prereleases without reading them;
    - offers a hotfix, and never offers the original back to the hotfix;
    - with no key, offers nothing and downloads nothing;
    - refuses a size GitHub disagrees with;
    - refuses a redirect, and a request, off the allowed hosts;
  - the install:
    - replaces the program;
    - keeps it, and leaves nothing behind, when the download, the program, the
      stamp or the start is wrong;
    - refuses a package install or another platform;
    - installs from a .tar.gz;
    - gives up on a stalled download;
    - moves the old program back when the swap fails;
    - cleans up only its own files;
  - the stamp is read from real Windows and Linux builds, and a manifest from
    a ZIP of them; mixed builds and dev builds are refused.
- `internal/server/update_test.go` (new):
  - every status, and the cache;
  - a check from another website, an install from a phone, without an Origin
    or from another website, and a restart from a phone are all refused;
  - only the offered build can be installed;
  - install, then restart;
  - a failed install changes nothing and can be retried;
  - a package install points at the release page;
  - no signing key means no offer.
- `cmd/gobbonet/update_test.go` (new): the restart's arguments (no second
  browser tab or setup), its environment, `version --json`, and `launch.bat`
  stepping aside on exit code 3.
- `tests/test-update-button.mjs` (new):
  - where the button is;
  - nothing asks for a check but the button;
  - every answer shown as what it means, from the PC and from a phone;
  - the question before anything is downloaded, and that a yes sends only
    the offered build;
  - progress, RESTART NOW, and the wait that reloads the page on 401 or on
    the new version;
  - release notes are text, and only https links are opened.
- `tests/test-about-links.mjs`, `tests/test-informant.mjs`: the placeholder
  is gone, and the privacy wording counts the check.
- `tests/console/1.8.0-update-button.js`: a live check from a browser,
  installing nothing.

The new tests fail on the Files panel tree.

## Fixed later, in the AppImage round

The update file named the AppImage as `build-appimage.sh` made it, with a `+`
(`GobboNet-1.8.0+go.<commit>-1-x86_64.AppImage`). GitHub drops the `+` from an
attached file's name, so the release would have had no file of that name, and
the AppImage would never have been offered an update. It is built without the
`+` now, and the update file refuses a name GitHub would change. The question
before an update now names the AppImage when that is what it replaces.
`CHANGELOG-1.8.0-appimage.md` has both.
