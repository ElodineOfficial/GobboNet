# 1.7.5 — The update is one file, because the app is one file

Raised as: *"I can't take the zip, replace old files… and have it work. That's
how 95% of our users update their app, so the whole 'forward facing' on
features like this is a non-starter."*

Correct, and the previous release answered a smaller question than the one
asked. `CHANGELOG-1.7.4-config-forward-compat.md` fixed *"an old binary refuses
to boot on a new config"*. It never asked whether the update path this project
actually has could put a new binary in place at all.

On Windows it could not. See `docs/INVESTIGATION-standdown-forward-compat.md`
for the full trace; the short version is below, then what changed.

## The zip had no Windows server in it

`*.exe` is gitignored (`.gitignore:11`) and nothing built one, so the archive
contained exactly one compiled server:

```
$ find . -iname '*.exe' -o -iname '*.dll'
./installer/plugins/x86-unicode/INetC.dll      # an NSIS build plugin
```

`linux-amd64/gobbonet`, and nothing else. So for every Windows user — most of
them — the download **could not update the server half of the app**, no matter
how carefully they replaced files. Idle stand-down, device sync profiles and the
`[ui]` table all live in that half. The panel then told them their gobbonet
binary was out of date. It was right, and there was nothing in the box to fix it
with.

## And the frontend they replaced was not the one being served

`detectWebRoot()` searched `<exe dir>/web` and then `<exe dir>`, and `web/` won
whenever it existed — which is every install. So `chat.html`, `js/` and `css/`
at the install root were dead files, while `README.md` listed them as "the chat
interface itself". Verified against the real binary before the change:

```
$ curl -s http://127.0.0.1:9077/chat.html
<!-- OLD 1.7.3 web/chat.html -->     # with a new chat.html sitting right beside it
```

Worse, `installer-linux/gobbonet-launch:208` ran `config set web_root
$PREFIX/web` on every Linux launch, so every Linux install carries an explicit
override pinning it to that directory.

This is the failure `stage-web.sh` was written to prevent — "the copy went
stale silently, the server kept serving it, and nothing anywhere reported a
problem". It was fixed in the repo and left in place in the user's install.

## What changed

**The frontend is compiled into the binary.** `internal/webui` embeds it;
`stage-web.sh` now stages `internal/webui/assets` instead of `./web`, and that
directory is an *input to the build* rather than a thing copied beside it. One
file carries both halves, so they cannot disagree — there is no longer a second
artifact to disagree with.

**Discovery is gone.** An empty `web_root` means "use the copy in the binary".
It is never inferred from a directory on disk. A leftover `web/` beside the
binary is reported at startup and ignored:

```
 [OK] chat interface: built into this program
 [*]  /opt/gobbonet/web is being ignored. The chat interface now ships inside
      the program file itself, so there is nothing to keep in step by hand and
      an old copy beside it can no longer be served by mistake. You can delete
      it.
```

**The `web_root` older launchers wrote is migrated, not honoured.** The launcher
clears it; the server also ignores it when it points at exactly `<exe dir>/web`,
because that value was written automatically and is therefore not a choice. Any
other path is obeyed — that is a real override, and it still works, with files
it does not contain falling through to the built-in copy so a one-file mod is a
modified page rather than a blank one.

**The zip is built by a script that refuses to ship a platform short.**
`make-zip.sh` builds `gobbonet.exe` and `linux-amd64/gobbonet`, checks the
staged tree against a manifest, checks each binary reports the version being
built, and checks the page stamp matches `VERSION`. Same rule as
`payload.manifest`, for the same reason.

**`launch.bat` hands over to `gobbonet.exe` when it finds one.** Two servers
serve the same page and only one has the last two releases in it; the page
looked identical either way. `GOBBONET_LEGACY_SERVER=1` forces the old path.

**Both servers now say which they are.** `/health-fileserver` carries
`server: "gobbonet"` or `server: "fileserver.ps1"`, and the PowerShell server
reports a version at all for the first time. The stand-down panel asks that
before `/standdown`, so it can stop guessing from a 404 — and ABOUT stops
reporting the page's own stamp as the version of an install whose server half is
a different program.

**`web/` is out of every payload.** Shipping one would set the "being ignored"
warning off on every launch of a healthy install. `payload.manifest` drops it,
and `package-permissions.sh` uses the binary as its completeness sentinel
instead of `web/chat.html` — which would have failed the deb build outright.

## The messages that were wrong

The old panel, on a 404 from `/standdown`:

> This server is older than these web files and does not have the idle
> stand-down setting. The gobbonet program file ships in the same download as
> `web/` — replace both together.

On the most common Windows setup every clause of that is wrong. The server is
not an old GobboNet, it is `fileserver.ps1`. There is no `web/` folder. There
was no gobbonet program file in the download. Now:

> GobboNet is being served by the older PowerShell file server
> (fileserver.ps1), which does not have idle stand-down. To get it, start
> GobboNet with the gobbonet program file in your GobboNet folder instead of
> launch.bat. Everything else works the same, and the chat page is built into
> that program file, so there is nothing else to update.

And for a genuinely old Go server, it names the version and the one file.

## Docs

`README.md` gains an **Updating** section — there was none, anywhere, which is
why users invented one. It says: replace `gobbonet.exe`, close GobboNet first,
and don't click Skip when Windows says the file is in use. The file map no
longer presents `chat.html`, `js/` and `css/` as the interface; they are named
as its source, with `web_root` documented as the way to run an edited copy.

## What pins it

| | |
|---|---|
| `internal/server/webroot_test.go` | 13 tests: the stale `web/` is not served and *is* reported, `Load` discovers no web root, the override wins per file and falls back, a wrong path is named, the legacy auto-written value is ignored while a deliberate one elsewhere is obeyed, and the embed contains every module `chat.html` loads |
| `internal/static/static_test.go` | the path rules, which moved onto `fs.FS` — traversal, encoded traversal, backslash traversal, dotfiles, directories |
| `tests/test-standdown-panel.mjs` | 72 assertions, up from 45. Both vintages of the PowerShell server, the old-Go-server case, a server error, and that a missing health reply does not disable a working control |
| `tests/test-version-stamp.mjs` | 59, up from 48. ABOUT names the PowerShell server instead of passing it off as healthy |
| `tests/test-launch-handoff.py` | the handoff exists, runs before the PowerShell start, is reachable, quoted, and exits rather than starting both |
| `tests/test-package-permissions.py` | follows the staged tree to its new path, and asserts the keep-file survives staging |

**Verified to bite.** The regression test's first draft *passed* with the old
shadowing behaviour deliberately restored, because `os.Executable()` inside a
test binary points at a build directory in `/tmp` and never at the stale `web/`
the test had just created. The directories are parameters now, and with
discovery put back it fails:

```
--- FAIL: TestStaleWebDirBesideTheBinaryIsNotServed
    webroot_test.go:117: the stale web/ copy was served — the shadowing bug is back
```

`make-zip.sh` was checked the same way — with the Windows build removed it
refuses to produce an archive, which is the failure that started all of this:

```
ERROR: the staged archive is missing things it must contain:
         gobbonet.exe
```

**Verified live**, against the binary that ships in this zip, in an install
dressed as a drop-in update: a stale `linux-amd64/web` present *and* a
`web_root` line in the config pointing at it.

```
1) boot        chat interface: built into this program
               ignoring web_root = .../linux-amd64/web  (+ the reason)
2) page        GOBBONET_UI_VERSION = '1.7.5'
3) health      server=gobbonet  version=1.7.5-go-nogit.20260917  mode=local
4) standdown   {"minutes":5,"stood_down":false,"supported":true}
5) at t+60s    {"stood_down":true}  backend process: gone
               [standdown] idle for 1m0s; unloading test-model.gguf to free VRAM
6) next msg    HTTP 200 in 0.51s, backend back
```

The deb was rebuilt from this tree and `verify-payload.sh` passes with the new
manifest (`payload: 6 entries`), carrying no `web/`.

## Not changed, and the honest limits

The stand-down mechanism itself. Nothing was wrong with it — the timer stays in
the supervisor, because the case it exists for is the browser being closed and a
shut tab cannot run a timer. It was never a feature problem; it was a delivery
problem wearing a feature's clothes.

`fileserver.ps1` still has no `/standdown`, and did not get one. It *could* have
— it already stops and starts llama-server for hot-swaps — but with
`gobbonet.exe` in the archive and `launch.bat` handing over to it, that would be
a second implementation of a subtle in-flight-counting rule, in a language with
no test harness for it, on a path nothing needs to take any more. It now says
what it is instead.

**A 1.7.4-or-earlier install still has to be told once.** Nothing in an old
binary can be made to unload a model, and nothing in an old install knows to
look for `gobbonet.exe`. This closes the trap going forward: from 1.7.5 on, the
update is one file, and if you get it wrong the app says which file and why.

The rpm and the Windows `.exe` installer were edited but **not built** —
`rpmbuild` and `makensis` were not available. Both changes are one-line removals
of a `web/` copy, and `verify-payload.sh` covers the rpm's payload shape, but
they are unbuilt and should be built before release.
