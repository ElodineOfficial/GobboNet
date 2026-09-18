# 1.7.4 — Fedora: the package that did nothing

Fixes for findings 1, 2 and 3 of
[`docs/INVESTIGATION-fedora-1.7.4.md`](../INVESTIGATION-fedora-1.7.4.md),
which has the evidence and the reproduction. Summary of what was wrong: the rpm
could not be built at all, and if you got past that, the package it produced
installed cleanly and then did nothing.

## 1. The build was blocked by a guard on something that no longer existed

`%install` rewrote a hardcoded prefix in the launcher and verified the rewrite
landed:

```sh
sed -i 's|^PREFIX="/usr/lib/gobbonet"|PREFIX="%{_libdir}/gobbonet"|' …
grep -q '^PREFIX="%{_libdir}/gobbonet"' … || { echo "ERROR: …"; exit 1; }
```

The launcher stopped being hardcoded some time ago. It resolves its own
location:

```sh
PREFIX="$(dirname "$(readlink -f "$0")")"
```

So the `sed` matched nothing, the guard fired, and `rpmbuild` exited 1.

**Deleted rather than repaired.** A self-locating launcher lands on
`/usr/lib64/gobbonet` by itself and needs no rewrite; the guard was the only
thing the rewrite still did, and it was stopping the package from building.
The `Exec=` rewrite for the desktop entry stays — a `.desktop` line cannot
resolve anything for itself.

## 2. The rpm never shipped the setup wizard

`build-deb.sh` staged `gobbonet-setup.py` and `wizard.html`. `build-rpm.sh`
staged neither, and `%files` globs `%{_libdir}/gobbonet/*`, so nothing noticed.

`gobbonet-launch` runs the wizard on first start:

```sh
python3 "$PREFIX/gobbonet-setup.py" "$ENGINE" >"$SETUP_LOG" 2>&1 &
```

With the file absent, python3 exits immediately, no URL is ever written to the
log, no browser opens, and the launcher dies. The desktop entry is
`Terminal=false` and every error-dialog tool is a weak dependency, so on a
machine without zenity there is **no window, no browser, no message** — only a
line in `~/.local/share/gobbonet/launch.log`. That is the whole of "doesn't do
squat".

Both files are staged now. Before and after, same launcher, same inputs:

```
before:  python3: can't open file '…/gobbonet-setup.py': No such file or directory
         ERROR: GobboNet's first-run setup did not finish.        exit=1

after:   setup wizard at http://127.0.0.1:46007/                  (running)
```

which is the line the working `.deb` produces.

## 3. The defect was two lists that could disagree

The missing files were a symptom. The two builders staged independently with
nothing comparing them, so a file added on one side could simply never arrive
on the other — and did.

**`payload.manifest`** at the repo root is now the list, and
**`verify-payload.sh`** checks a staged tree against it. Both builders call it
before packaging.

The property that matters: adding a file to the payload means adding it to the
manifest, and once it is there **both** builds fail until both stage it. A file
can no longer arrive on one platform and be forgotten on the other. Unexpected
files are an error too — that is usually a leftover from an abandoned build,
and it is the same drift seen from the other side.

One script rather than a function copied into each builder, because a copied
consistency check is precisely the thing it exists to prevent. It lives at the
root beside `stage-web.sh` and `engine.sha256`, which is where shared build
machinery already goes.

Exercised against every shape of drift:

| | |
|---|---|
| correct payload | exit 0 |
| the actual 1.7.4 fault (wizard files missing) | exit 1, names both files |
| a stray file from an abandoned build | exit 1, names it |
| the optional CPU engine present | exit 0, not flagged |
| a directory where a file belongs | exit 1, reported as both missing and unexpected |
| no such directory / no argument | exit 2 |

### It caught a mistake of mine on its first run

I first put the deb's call next to the line that stages the wizard files.
Staging in that script runs across thirty lines, so the check ran halfway
through and reported `gobbonet-launch`, `models.ini`, `web/` and `llama-cpp/`
as missing — all of them staged a few lines later.

That is a false positive caused by placement, and worth recording because it is
the obvious place to put the call and the wrong one. Both builders now check
after staging is finished, immediately before packaging.

## Result

Both packages build, and their payloads are now provably the same thing:

```
deb:  payload: 7 entries, matches payload.manifest
rpm:  payload: 7 entries, matches payload.manifest
```

Directory listings identical. `gobbonet-setup.py`, `wizard.html` and
`gobbonet-launch` byte-for-byte identical across the two. Web trees identical.

`installer-fedora/`'s build artifacts (`rpmbuild/`, `stage/`, `vendor/`,
`dist/`) were not in `.gitignore` — the Debian equivalents were — so one build
left an rpmbuild tree and a 100 MB vendored engine in the working copy. Added.

## Still outstanding

**Finding 4 is not fixed.** The rpm declares `Requires: xdg-utils` and
essentially nothing else, where the deb declares nine. `python3` is absent from
the spec although the launcher depends on it, and the
`__requires_exclude_from` filter — correct in intent, to stop `libvulkan`
becoming mandatory — excludes *every* `NEEDED` entry of the engine, including
`libstdc++`, `libgomp`, `libgcc_s`, `libssl` and `libcrypto`, all of which
`ldd` confirms are genuinely required.

A Fedora machine missing `python3` or `libgomp` will install this package and
then fail at runtime in the same way it just did, by a different route. Most
desktops have them, which is consistent with "*some* users" — and is exactly
the kind of partial coverage that makes a bug hard to pin down.

**Finding 5 is not fixed either.** `die()` should print the log path
unconditionally, and the missing-wizard case deserves its own message rather
than the generic one. That is a launcher change shared with Debian, so it
belongs in its own step rather than folded into rpm work.
