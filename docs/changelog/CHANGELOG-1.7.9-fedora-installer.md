# 1.7.9 — The Fedora installer, and the Go that builds every release

## How it was built

`installer-fedora/build-rpm.sh`, as for 1.7.8, takes:

- the ZIP's own `linux-amd64/gobbonet`;
- llama.cpp b10456's Vulkan archive, checked against `GPU_SHA256` in
  `engine.sha256`.

`check-rpm.sh` passes. `desktop-file-validate` was installed, so the menu entry
is validated too.

**The same rpm as 1.7.7 and 1.7.8.** The official 1.7.8 package's header says
it was built by rpm 4.19.1 for `x86_64-vendor-linux`, so 4.19.1 was built here
from rpm-software-management/rpm (`rpm-4.19.1-release`). It has prefix `/usr`
and its own macros (`RPM_CONFIGDIR`), so the build machine's rpm 4.18 is never
consulted.

Two things a source build needs that are easy to miss:

- **GNU awk.** With only mawk, rpm's tag table generates empty. The rpm then
  cannot read any package ("invalid signature tag (unknown) (257)").
- **A private rpm database** (`%_dbpath`) for the build tool.

**The toolchain reproduces 1.7.8.** 1.7.8's scripts, with the server lifted out
of the official `gobbonet-1.7.8-1.go.18aee12.fedora.x86_64.rpm`, rebuilt it.
The two match in every header field except the build time, the 16 file times
that come from the build, and the digests that cover those:

- all 72 requirements, 5 provides and 4 recommends;
- the scriptlets and the changelog;
- all 79 files' digests, modes, owners, links and flags.

## What the 1.7.9 `.rpm` does differently from the official 1.7.8

**The same:**

- the summary, description, licence, URL, platform, payload format and
  compression;
- the scriptlets;
- all 72 requirements, the 4 recommends, and `bundled(llama.cpp) = b10456`;
- all 79 files, with the same types, modes, owners, links and flags;
- 74 of the files, byte for byte.

**Changed:** five files, plus a `1.7.9-1` changelog entry.

| File | Why |
|---|---|
| `gobbonet` | the 1.7.9 server, byte for byte the ZIP's |
| `wizard.html` | the password minimum comes from the server, 8 by default. The spec's Fedora rewrites (`/usr/lib64`, firewalld) still apply |
| `models.ini` | sixteen models, the ZIP's catalogue byte for byte |
| `llama-cpp/ENGINE.txt` | its "bundled by" line names the package version |
| `/usr/share/doc/gobbonet/FEDORA.md` | names 1.7.9, and the upgrade tested from 1.7.8 |

The changelog entry names, among the rest:

- the `gobbonet uninstall` fix (`CHANGELOG-1.7.9-linux-installer.md`);
- the Go below.

## Go 1.25.14, not 1.25.0

The official 1.7.8 server reports `go1.25.14`, on Windows and Linux alike.
Every 1.7.9 build up to this step reported `go1.25.0`, the toolchain the build
machine happened to have, and nothing said so. 1.7.9 would have shipped
fourteen Go patch releases behind 1.7.8. Those are mostly security fixes,
several in `net/http` and `crypto`, which the server uses directly.

- **Go 1.25.14** was built from github.com/golang/go at tag `go1.25.14`,
  bootstrapped with the 1.25.0 at hand. It is the last 1.25 release, the one
  1.7.8 used. go.dev and the module proxy were not reachable here.
- **Rebuilt with it:** both servers, the ZIP, the `.exe`, the `.deb` and this
  `.rpm`. Every Go package passes and vet is clean, for linux and windows.
- **`scripts/go-floor.sh`**, which `make-zip.sh` and `build-release.sh` call
  first, refuses a Go older than `GO_FLOOR` (go1.25.14).
  `tests/test-go-floor.py` runs it with stand-in `go` commands.

Go 1.25 no longer gets fixes now that 1.27 is out. Moving to 1.26 or 1.27 is
left for its own release.

## The official 1.7.8 packages

The official `.rpm` and `.deb` were found on the 1.7.8 release page. Their
names follow the build id, `18aee12`, read from the official `gobbonet.exe`.
The 1.7.9 `.deb` was compared again, with the official package this time, and
the result is the one `CHANGELOG-1.7.9-linux-installer.md` records against
the rebuild:

- the same control fields apart from `Version` and `Installed-Size`;
- `postinst` and `postrm` byte for byte;
- all 88 entries identical;
- the same five files changed.

The 1.7.8 package rebuilt the day before matched the official one in every
file except the three that carry the version.

## Checked here

### `test-in-fedora.sh`

It ran on the official Fedora root filesystems of 2026-11-01
(fedora-cloud/docker-brew-fedora). Each run:

- tests the upgrade from the official 1.7.8 package;
- loads the repo's 400 KB test model.

| Fedora | rpm | OpenSSL | Python stand-in | Result |
|---|---|---|---|---|
| 43 | 6.0.2 | 3.5.9 | 3.14.10 | 20/20 |
| 44 | 6.0.2 | 3.5.9 | 3.14.10 | 20/20 |
| 45 | 6.1.0 | 4.0.3 | 3.15.2 | 21/21 |
| Rawhide (46) | 6.1.0 | 4.0.3 | 3.15.2 | 21/21 |

The checks are 1.7.8's, listed in `CHANGELOG-1.7.8-fedora-installer.md`:

- an offline `dnf install`;
- `rpm -V` before and after the first run;
- the engine and the repo's first-run test as an ordinary user, local and LAN;
- GobboNet in local mode answering a chat;
- removal;
- dnf's refusal, naming `libssl.so.3`, when nothing provides OpenSSL 3 (45 and
  Rawhide);
- the upgrade's file ownership, engine path and chat page.

### As a Fedora user, in a browser

On Fedora 44 and 45, each run used a copy of the official root, with the same
test-only stand-ins. Users ran GobboNet in a chroot, and headless Chromium on
the host played their browser. Each release passed all 51 checks.

**The upgrade from the official 1.7.8:**

1. `dnf` installed it. Its wizard was walked with Enter in each field:
   - it names `/usr/lib64/gobbonet`;
   - it gives the firewalld command and no UFW one;
   - the page had no errors.
2. A conversation got a reply from the bundled engine.
3. GobboNet was closed and `dnf` upgraded the package. `rpm -V` was clean, and
   the user's config and data folder were byte for byte untouched.
4. `gobbonet` went straight to the chat ("setup: already complete").
   - Page and server said 1.7.9.
   - The 1.7.8 conversation was there, and a new message in it got a reply.
5. `gobbonet uninstall --yes --remove-models` cleared the folder chosen in the
   1.7.8 wizard, and the config. Its last line names `sudo dnf remove
   gobbonet`.
6. `dnf remove` printed its note once.

**A fresh install of 1.7.9:**

1. The wizard was walked with Enter into `~/Gobbo Data`:
   - the password step says 8, and refuses 7 characters;
   - the Fedora rewrites are in place.
2. A conversation, after answering the tour's offer with Skip.
3. `config.toml` is mode 0600, and `rpm -V` was still clean.
4. `dnf remove` left the user's config and chats.

**One thing the driver got wrong first:** the minimal roots have no `pkill`,
so "close GobboNet" did nothing. The next version's launcher then found the old
server still running on the port. GobboNet reused it, which is correct, but
the test was then talking to 1.7.8. The driver now stops the user's processes
from the host, and checks that the page and server it talks to say 1.7.9.

**Allowances,** as for 1.7.8:

- a test-only package standing in for python3, xdg-utils and
  hicolor-icon-theme, with a standalone CPython of the release's version;
- Fedora 44's OpenSSL 3 libraries standing in for `openssl3-libs` on 45 and
  later;
- the tiny test models.

### The other packages, rebuilt with Go 1.25.14

- **The ZIP:** all 60 JS and 34 Python suites, the Go suite, vet, the first run
  from nothing and every console block. Its source matches the tree.
- **The `.exe`:** its script is identical to the build tested on Windows, and
  of its 61 files only `gobbonet.exe` changed. 7-Zip unpacked the official
  1.7.8 installer, and the two file lists differ by the three new page files.
  The files that changed are this release's, plus NSIS's three plugin DLLs,
  which follow the compiler that built NSIS
  (`CHANGELOG-1.7.9-windows-installer.md`).
- **The `.deb`:** on Ubuntu 24.04:
  - the upgrade from the official 1.7.8 package, with a conversation kept and
    continued;
  - a fresh first run and a conversation;
  - `tests/test-linux-onboarding.py` against the installed package, local and
    LAN;
  - `gobbonet uninstall` clearing the chosen folder;
  - purge leaving user data.

## Not checked

The same as 1.7.8; they need Fedora hardware:

- SELinux;
- a real desktop session and GNOME Software;
- GPU inference.
