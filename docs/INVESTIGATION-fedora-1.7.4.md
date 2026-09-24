# Investigation — "the Fedora package doesn't do squat"

Run before building the 1.7.4 rpm, on the report that the Fedora package does
nothing on some machines. Two fatal faults, one that makes the second
invisible, and one latent. Nothing here is inferred from reading alone —
everything below was reproduced.

**Method.** `rpmbuild` 4.18.2 installed locally, `build-rpm.sh` run against the
1.7.4 tree, the resulting package extracted, and its launcher executed
side-by-side with the `.deb` launcher under identical fake home directories.

---

## Finding 1 — the rpm cannot be built at all *(fatal, build time)*

```
+ sed -i s|^PREFIX="/usr/lib/gobbonet"|PREFIX="/usr/lib64/gobbonet"| .../gobbonet-launch
+ grep -q ^PREFIX="/usr/lib64/gobbonet" .../gobbonet-launch
+ echo ERROR: PREFIX rewrite missed in gobbonet-launch
error: Bad exit status from /var/tmp/rpm-tmp.ks3PMD (%install)
```

`gobbonet.spec` rewrites a hardcoded prefix in the launcher and then verifies
the rewrite landed. But `installer-linux/gobbonet-launch` line 26 has not been
hardcoded for some time:

```sh
PREFIX="$(dirname "$(readlink -f "$0")")"
```

The `sed` matches nothing, the `grep -q` guard fires, `%install` exits 1.

The guard is doing its job. What it is guarding is obsolete: a self-locating
launcher already resolves to `/usr/lib64/gobbonet` on Fedora with no rewrite at
all. The spec was written against a launcher shape that changed underneath it —
file dates show the launcher was rewritten at 20:53 and the spec at 23:34 the
same evening, so this almost certainly never built.

**Consequence.** Whatever Fedora users have installed was **not** built from
this tree.

---

## Finding 2 — the rpm never shipped the setup wizard *(fatal, runtime)*

This is "doesn't do squat".

`build-deb.sh` line 311:

```sh
install -m 0644 gobbonet-setup.py wizard.html "$STAGE/usr/lib/gobbonet/"
```

`build-rpm.sh` stages `gobbonet`, `gobbonet-launch`, `models.ini`, `web/`,
`llama-cpp/`, the desktop entry, the icon and the docs — **and neither of those
two files.**

| installed under the package's lib dir | deb | rpm |
|---|---|---|
| `gobbonet` | yes | yes |
| `gobbonet-launch` | yes | yes |
| `llama-cpp/` | yes | yes |
| `models.ini` | yes | yes |
| `web/` | yes | yes |
| **`gobbonet-setup.py`** | **yes** | **NO** |
| **`wizard.html`** | **yes** | **NO** |

`gobbonet-launch` line 176 runs the wizard on first launch:

```sh
python3 "$PREFIX/gobbonet-setup.py" "$ENGINE" >"$SETUP_LOG" 2>&1 &
```

Reproduced, same launcher, same inputs, only the payload differing:

```
--- rpm payload ---
setup: first run
python3: can't open file '/usr/lib64/gobbonet/gobbonet-setup.py': [Errno 2] No such file or directory
ERROR: GobboNet's first-run setup did not finish.            exit=1

--- deb payload ---
setup: first run
setup wizard at http://127.0.0.1:42121/                       (still running)
```

`%files` uses `%{_libdir}/gobbonet/*`, which globs whatever was staged, so
nothing in the spec notices the absence. The two builders stage independently
with no cross-check — which is how a file added on one side never arrived on
the other.

---

## Finding 3 — and the failure is silent *(severity multiplier)*

`gobbonet.desktop` is `Terminal=false`, so a click has no console. `die()`
falls back through `zenity` → `kdialog` → `notify-send`, and **all three are
weak dependencies** (`Recommends:`). `dnf` installs weak deps by default, but
`--setopt=install_weak_deps=False`, a minimal install, or a spin without GNOME
leaves none of them present.

With none of them, the user clicks the icon and gets **no window, no browser,
no error, no notification**. The only trace is a log the user has no reason to
know exists:

```
~/.local/share/gobbonet/launch.log
```

That combination — finding 2 producing the fault, finding 3 hiding it — is why
the report reads as "doesn't do squat" rather than "shows an error".

**Ask any reporter for that file first.** It names the exact cause on line 4.

---

## Finding 4 — the rpm declares almost no dependencies *(latent)*

| | |
|---|---|
| deb `Depends:` | `python3 (>= 3.8), bash, coreutils, libc6 (>= 2.34), libstdc++6 (>= 12), libgcc-s1, libgomp1, libssl3t64 \| libssl3 (>= 3.0.0), xdg-utils` |
| rpm `Requires:` | `xdg-utils` (plus auto-detected `/bin/sh`, `/usr/bin/env`) |

Two causes.

**`python3` is simply absent from the spec**, although `gobbonet-launch`
depends on it for the wizard.

**The engine's dependencies are filtered out wholesale.** This line exists to
stop `libvulkan` becoming a hard requirement, which is correct — the CPU
backend works without it:

```
%global __requires_exclude_from ^%{_libdir}/gobbonet/llama-cpp(-cpu)?/.*$
```

But it excludes *every* `NEEDED` entry of the engine, not just Vulkan. `ldd` on
the shipped `llama-server`:

```
libc.so.6  libcrypto.so.3  libgcc_s.so.1  libgomp.so.1
libm.so.6  libssl.so.3     libstdc++.so.6
```

All genuinely required; none declared. A Fedora machine without `libgomp` or
`python3` installs the package happily and then fails at runtime — the same
class of fault as finding 2, reached a different way. Most desktops have these,
which is consistent with "**some** users".

---

## Checked and clean

Worth recording, so it is not re-investigated later.

- **The Release field is derived, not hardcoded.** `PKG_RELEASE="1.go.${SHA//-/.}"`
  starts at 1 and follows `VERSION`. The rpm does **not** have the problem the
  deb had with its `-3`.
- **The engine pin works.** `build-rpm.sh` fetched
  `llama-b10456-bin-ubuntu-vulkan-x64.tar.gz` and reported
  `sha256 verified against engine.sha256` — the shared pin moved in the exe
  step reads correctly from here.
- **Package content is otherwise right.** With finding 1 neutralised, the built
  rpm has `Exec=/usr/lib64/gobbonet/gobbonet-launch`, a correct
  `/usr/bin/gobbonet` symlink, 0755 on all three executables, 24 js + 17 css in
  the web root, and the `%post` scriptlet matches the deb's `postinst` line for
  line.
- **`%files` globbing, `ExclusiveArch`, the Provides filter and `%license`
  handling** are all correct and follow Fedora's bundling guidelines.

---

## Proposed fixes

In the order they should be applied, smallest blast radius first.

1. **Delete the `PREFIX` rewrite and its guard** from `%install`. Not repair —
   delete. The launcher self-locates, so the rewrite is unnecessary and the
   guard is the only thing it now does. Keep the `Exec=` rewrite for the
   desktop file, which is still needed and still matches.

2. **Stage `gobbonet-setup.py` and `wizard.html`** in `build-rpm.sh`, beside
   the launcher.

3. **Add a payload cross-check** so this cannot recur: after staging, compare
   the rpm's file list against the deb's and fail on a difference. The two
   builders drifting silently is the actual defect; finding 2 is a symptom of
   it, and fixing only the symptom leaves the next added file to be forgotten
   the same way.

4. **Declare the real dependencies.** `Requires: python3`, and narrow the
   `__requires_exclude_from` filter so it drops only `libvulkan`, letting the
   rest of the engine's `NEEDED` entries generate proper requirements.

5. **Make the silent failure audible.** `die()` should print the log path to
   stdout regardless, and the wizard-missing case deserves its own message
   rather than the generic "setup did not finish" — but this is a launcher
   change shared with Debian, so it belongs in its own step rather than folded
   into the rpm work.

Items 1 and 2 are the minimum to produce a working Fedora package. Item 3 is
what stops the next one being broken the same way.

---

## Status (1.7.6)

Items 1–3 shipped in 1.7.4 ([`CHANGELOG-1.7.4-fedora-repair.md`](changelog/CHANGELOG-1.7.4-fedora-repair.md)).

Item 4 — Finding 4 — was deferred, then covered in 1.7.6 by listing the engine's
library *packages* by hand. Fedora 45's move to OpenSSL 4 showed why that is not
the same thing: `openssl-libs >= 3.0` was satisfied by OpenSSL 4, and the
engine, which needs `libssl.so.3`, could not start. The requirements are now
generated from the engine itself, as proposed here, filtering only Vulkan and
the bundled libraries. See
[`CHANGELOG-1.7.6-fedora-rpm.md`](changelog/CHANGELOG-1.7.6-fedora-rpm.md).

Item 5 is still open.
