# 1.7.5 — Two things the 1.7.3 audit caught, both mine

A check against v1.7.3 for two properties: **no new obfuscation**, and **no
features lost, only added**. Everything else came back green — no config key,
route, CLI command, frontend function or UI control removed anywhere, and no new
hidden windows, encoded payloads or outbound hosts. Two things did not, and both
were introduced by this release.

## 1. The engine downloader became unreachable

`launch.bat` STEP 1 downloads llama.cpp (~300 MB), verifies it against the
pinned SHA-256 and unpacks it. `gobbonet` could not do any of that: it took a
path handed to it by whoever launched it and reported `has_engine:false`
otherwise.

Survivable while `launch.bat` ran the show. Not survivable once the 1.7.5
handoff was added **above** STEP 1:

```
handoff at line 101 ; engine download at line 891
=> handoff runs FIRST, so the engine download is skipped
```

And the Windows ZIP carries **no engine** (`0` engine files in the archive — the
Windows build is a vendor drop the installer fetches). So a fresh extract went
straight into a setup with no way to get one. A capability 1.7.3 had, removed by
a convenience I added.

**Fixed by giving the downloader to the side that is now the front door.**
`internal/engine` reads the same `engine.sha256` every builder reads, fetches the
pinned asset with progress, verifies the hash, and unpacks it — flattening
upstream's `build/bin/` so `llama-server` lands where every `server_exe` points.
`gobbonet engine install|status` drives it, and it records `server_exe` in the
config afterwards, because installing something the server then cannot find is a
job half done.

The hash policy is `launch.bat`'s, deliberately: a mismatch is fatal, the partial
file is deleted, and a missing pin is a refusal rather than a shrug. An engine
that cannot be vouched for is precisely the one a user would then run.

The handoff now asks `engine status` first and installs only when there is
nothing there, so an existing install stays quiet. A failed install stops with an
error instead of starting a server that has no model to load.

## 2. The interface stopped being visible where it is unpacked

Compiling the frontend into the binary fixed the update story and cost something
real, which you named exactly: *"plainly viewable means editable in the install
folder. I should be able to see all files where this is unpacked, anything else
isn't auditable."*

Correct, and the trade as shipped was the wrong one. An install no longer
contained the interface it was serving — you could not read it, edit it, or check
that what the server sent matched what shipped.

**Fixed by writing it back out and serving it from there.** On startup the binary
exports the frontend to `web/` beside itself and serves that directory. The files
on disk are the files being served, not a decorative mirror: edit one, reload,
see the change.

**And it cannot bring back the stale-`web/` bug**, because the relationship is
inverted. That bug was a directory the server *found and trusted*. This is a
directory the server *owns*: a `.gobbonet-ui` stamp records which build wrote it,
and a build that does not recognise its own stamp **rewrites the whole tree
before serving a byte of it**. A leftover from an older install is replaced, not
obeyed. Verified:

```
  on disk before:  <!-- ANCIENT 1.0 PAGE -->   (stamped 1.0.0-ancient)
  on disk after:   <!DOCTYPE html>
  served:          <!DOCTYPE html>
  boot said:       refreshed .../web from 1.0.0-ancient to 1.7.5 (45 files).
                   Any edits you made there have been replaced -- that is how an
                   update reaches the interface.
```

Replacing someone's edits is said out loud, with the escape route next to it:
copy them elsewhere and set `web_root`, which is untouched by updates.

An install directory that cannot be written — Program Files, a root-owned
`/usr/lib/gobbonet` — falls back to serving straight from the binary and says so.
That is normal, not an error, and it must not stop the server.

## What pins it

`internal/engine/engine_test.go` — 10 tests, all against a local `httptest`
server so nothing reaches GitHub: the pin parses and normalises, a pin with no
hash for this platform is **refused** rather than downloaded unverifiably, a
tampered archive is rejected with nothing installed and no `.part` left behind, a
404 is not mistaken for success, the archive is flattened and deleted, `ENGINE.txt`
records the build, a zip entry named `../escaped.txt` cannot write outside the
destination, and the repo's own `engine.sha256` parses.

`internal/server/webroot_test.go` — now 17. The new ones: the frontend is written
to disk and an edit to it **is what gets served**; the stamp is not reachable over
HTTP; an unwritable install still serves and says why. The stale-copy test got
stronger — it used to assert "ignored", it now asserts **replaced on disk**.

`tests/test-launch-handoff.py` — the engine is fetched before setup runs, only
when missing, and a failure stops rather than starting a modelless server.

One test-quality note. `TestAnUnwritableInstallStillServes` first used `chmod
0500`, which root ignores — so it skipped on exactly the machines most likely to
run a packaged install. It obstructs the path with a plain *file* named `web`
now; nothing can turn a file into a directory.

## Still true after both fixes

- One file to update. `gobbonet.exe` still carries the interface; `web/` is
  written from it, not the other way round.
- One window, with the app's icon.
- No new hidden windows, encoded payloads, or outbound hosts.
- `engine.sha256` is in the archive manifest now, so a build cannot ship without
  the pin that `engine install` needs.

## Not verified here

`gobbonet engine install` was tested end to end against a local server, not
against GitHub — this container cannot reach `github.com/ggml-org/...` releases.
The URL is assembled from the same `engine.sha256` fields `build-installer.sh`
uses and is asserted in tests, but one real run on a machine with network access
is worth doing before release.
