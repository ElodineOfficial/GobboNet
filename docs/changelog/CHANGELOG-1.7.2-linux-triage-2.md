# v1.7.2 — Linux triage, second pass

Against triage report v2, which was written from the build *before* the first
triage pass landed. Checked item by item before changing anything, because most
of what it lists is already fixed.

**Already fixed in this tree, verified rather than re-fixed:** A11Y-1 (the strip
is a permanent `role="status"` live region, the switch control is a real
`<button>` with an `aria-label`, and `test-cast-mismatch.mjs` is at 30
assertions, not the 22 the report counted), PKG-1, DOC-1, PKG-5, and
SETUP-1/2/3/4/5. See `CHANGELOG-1.7.2-linux-triage.md`.

What was genuinely open: NEW-1 through NEW-5, and PKG-6.

---

## NEW-1 — the port sidecar was written into root-owned program files

**Every non-root user, every Linux install, every launch.**

```
[*]  could not write .gobbonet-port (open /usr/lib/gobbonet/.gobbonet-port: permission denied)
     Harmless unless you use setup-lan.bat, which reads it.
```

`PortFilePath()` derived the path from the executable's own directory. On
Windows that is the install folder and writable, which is the whole point —
`setup-lan.bat` and `launch.bat` read `%~dp0.gobbonet-port`. On Linux the binary
is at `/usr/lib/gobbonet/gobbonet`, root-owned with no group or other write bit,
and `installer-linux/README.md` says program files are meant to be read-only.
The write could never succeed.

**The fix is not to relocate it.** The deciding evidence is in our own launcher,
at `gobbonet-launch:187`:

> The port is a config key, not a sidecar file.

It asks `gobbonet config get listen_port`. Nothing on Linux reads the sidecar —
neither batch file ships in the `.deb` — so there is nothing to relocate it
*for*. A new `config.PortFileSupported()` scopes the whole feature to Windows;
`PortFilePath` returns empty elsewhere and `WritePortFile` is a no-op.

The subtle part is that the no-op returns **nil**. `main.go` prints a warning on
a non-nil error, so spelling "this platform has no sidecar" as an error would
have put the warning straight back. A test pins that specifically.

Because there is no longer a Linux sidecar to be wrong about, NEW-2 and NEW-3
resolve with it.

## NEW-2 — `doctor` reported a permanent failure as "not written yet"

`doctor.go` branched on file existence alone, so a write that could never
succeed was reported as merely pending. Worse than silence: someone chasing a
LAN problem is told the file is about to appear and goes to look elsewhere.

New `config.PortFileWritable()` answers by **attempting** a write into the target
directory and cleaning up after itself, rather than reading permission bits —
ACLs, read-only mounts and container filesystems all deny writes the bits appear
to permit. `doctor` now distinguishes:

```
  .gobbonet-port: CANNOT BE WRITTEN (C:\Program Files\GobboNet\.gobbonet-port)
               This will not fix itself by starting the server.
```

The probe is split into `dirWritable()` so it stays under test on platforms that
have no sidecar for `PortFileWritable` to ask about. It is asserted to leave
nothing behind: this runs against the install directory of a machine someone is
already troubleshooting, and a diagnostic that litters there is its own bug
report.

## NEW-3 — Linux surfaces named `setup-lan.bat`

Both occurrences were the two above. `setup-lan.bat` is now only named where it
exists. On other platforms `doctor` says so plainly and gives no path to go
looking for:

```
  .gobbonet-port: not used on this platform
               Only setup-lan.bat and launch.bat read it, and both are
               Windows-only. The port here comes from listen_port above.
```

## NEW-4 — the port probe could miss a live server

`doctor` printed `in use: no -- the port is free to bind` for a port GobboNet
was serving on.

**Not reproducible here, and that shaped the fix.** The bind conflict was tested
across five held/probe combinations — loopback and wildcard in both directions —
and reported correctly every time. Under WSL2 mirrored networking the guest is
not always told about the conflict. Chasing that specific stack would have been
guesswork.

The design was wrong regardless. A bind probe answers *could I bind this address
right now*, which is a different question from *is my server running*, and the
old code let that one answer decide everything including identity. So the order
is inverted: **ask the server first.** An HTTP reply cannot be wrong in the
direction that matters — if something answers, something is listening. The bind
probe is demoted to what it is actually good for, telling "nothing there" apart
from "something there that does not speak HTTP".

When the two disagree, the disagreement is printed rather than hidden, because
someone reading this needs to know their bind probe is unreliable.

`bindProbe` is a package-level variable so a test can force the exact WSL
situation — a bind reporting success while a server answers — which is otherwise
not arrangeable on a working stack. Eight tests: the lying-bind case, a real
conflict, a server behind auth (the 401 is what proves the listener is ours on a
default install), a stranger, a non-HTTP holder, a genuinely free port, a
bind error alone, and `probeHost`.

`probeHealth` also now dials the configured host instead of always loopback, via
`probeHost()`: `0.0.0.0` and `::` say what to accept on, not what to dial, so
they map to loopback while a pinned `listen_host` is dialled as written.

## NEW-5 — no browser tab on `gobbonet`

**Decided, not patched** — the report asked for a decision first, and the
existing behaviour turns out to be correct.

The route an ordinary user takes is the applications menu, which runs
`gobbonet-launch`. That waits for the server to answer and *then* opens the
browser (`gobbonet-launch:350`), deliberately in that order so a tab never lands
on a connection error. Opening one from `serve` as well would give that user two
tabs. Every other caller is a server operator — autostart, a systemd unit, an
SSH session, a headless box — where seizing a browser is wrong, and on the
headless ones impossible. `gobbonet setup` opens one because a wizard has
nowhere else to happen; a long-running server does.

What was missing was a way to say yes. `gobbonet serve --open` mirrors
`setup --no-browser` in the other direction. The default is unchanged. It reuses
the wizard's opener, now exported as `setup.OpenBrowser`, rather than a second
copy that could drift from it, and fires after the bind so the tab never races
the listener.

## PKG-6 — module path did not match the repository

`go.mod` declared `github.com/jmccardle/gobbonet` while `build-deb.sh:332` and
`README.md:48` both point at `ElodineOfficial/GobboNet`. Renamed across 26 `.go`
files, `go.mod`, and the `build-release.sh` ldflags. Mechanical, and the full
suite covers it.

---

## Deliberately not touched

**PKG-4** — the 97-package dependency footprint. Unchanged from the last pass's
reasoning: dropping `zenity` or the unused llama.cpp tools trades installed size
against graphical prompts and debuggability, and that is a maintainer's call,
not a default to guess at. The likely lever remains `zenity` under `Recommends`
pulling GTK4, plus `xdg-utils` pulling the Perl and X11 chains.

---

## Files changed

| File | Finding |
|---|---|
| `internal/config/config.go` | NEW-1, NEW-2 — `PortFileSupported`, `PortFileWritable`, `dirWritable` |
| `internal/config/heal_test.go` | NEW-1, NEW-2 — round trip no longer skips off Windows |
| `cmd/gobbonet/doctor.go` | NEW-2, NEW-3, NEW-4 |
| `cmd/gobbonet/doctor_port_test.go` | NEW-4 — new, 8 tests |
| `cmd/gobbonet/main.go` | NEW-1, NEW-5 |
| `internal/setup/setup.go` | NEW-5 — `OpenBrowser` exported |
| `go.mod`, `build-release.sh`, 26 `.go` files | PKG-6 |

---

## Verification

- **`go test -race ./...` at `GOMAXPROCS=16`: 12 packages, clean.** `go vet`
  clean. Cross-compiles for `windows` and `darwin`.
- **All 10 `.mjs` suites: 580 assertions, 0 failures** — identical to the
  baseline taken before any change.
- `bash -n` on every shell script touched.
- The read-only branch of `dirWritable` was confirmed under an unprivileged uid,
  not just asserted — under root it skips, because root ignores the mode bits.
- **Against the installed `.deb`, as an unprivileged user:** the startup banner
  is clean with no `.gobbonet-port` line; `doctor` reports the sidecar as
  Windows-only; `doctor` run against a live server reports
  `identity: GobboNet (200, auth disabled) -- already running`.
- `dpkg -P` prints the removal notice once and leaves no residue.

**What still needs bare metal**, unchanged: Vulkan acceleration, desktop menu
integration, whether the cast-mismatch strip is announced by a real screen
reader, `autostart --enable`, and LAN binding under real network conditions. The
WSL2 bind-probe behaviour behind NEW-4 could not be reproduced here either — the
fix is designed not to depend on it, but confirming the symptom is gone needs
that machine.
