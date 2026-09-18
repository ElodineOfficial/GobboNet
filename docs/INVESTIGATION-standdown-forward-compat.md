# Investigation — idle stand-down cannot be delivered by replacing files

Raised as: *"I can't take the zip, replace old files… and have it work. That's
how 95% of our users update their app, so the whole 'forward facing' on
features like this is a non-starter."*

You are right, and the previous write-up
(`CHANGELOG-1.7.4-config-forward-compat.md`) answered a narrower question than
the one you asked. It fixed *"an old binary refuses to boot on a new config"*.
It did not ask *"can the update path this project actually has ever put a new
binary in place?"*

The answer to that, on Windows, is **no** — and not for a subtle reason.

---

## The short version

**The feature works.** I ran it against the shipped `linux-amd64/gobbonet`
binary and watched it unload and reload a backend process. Nothing is wrong
with the mechanism.

**The feature cannot arrive.** This zip contains no Windows server binary — no
`gobbonet.exe`, no `GobboNetSetup.exe`, no Windows llama.cpp. `*.exe` is
gitignored (`.gitignore:11`), so it has never been in the tree and is not in
the archive:

```
$ find . -iname '*.exe' -o -iname '*.dll'
./installer/plugins/x86-unicode/INetC.dll      # an NSIS build plugin
```

Every 1.7.4 feature that lives in the server — **idle stand-down (item 6),
device sync profiles (item 4), the `[ui]` config table (item 10)** — is
therefore unreachable for any Windows user who updates by replacing files,
no matter how carefully they do it. They are not doing it wrong. There is
nothing in the zip for them to replace it with.

The greyed-out panel is not the bug. It is the only part of this that behaved
correctly: it detected a server that could not do the job and said so. What it
said next was wrong, because the advice it gives cannot be followed.

---

## Five defects, in the order a user meets them

### 1. The zip has no Windows server binary

Covered above. The panel currently tells the user:

> The gobbonet program file ships in the same download as `web/` — replace
> both together.

For this archive that is **false**. `linux-amd64/gobbonet` is the only compiled
server in it. A Windows user following that instruction to the letter finds
nothing to follow it with.

Linux ZIP users are in better shape: the binary *is* committed at
`linux-amd64/gobbonet`, so a drop-in replace of that folder genuinely updates
the server. That is also the path that already went stale once — roadmap item
12 records the shipped `linux-amd64/gobbonet` still being the 1.7.3 build, "so
the server halves of #4 and #10 were never running." Same class of fault,
already seen once, and nothing was added to detect it.

### 2. The frontend a user replaces is not the frontend the server serves

`detectWebRoot()` (`internal/config/config.go:635-650`) tries, in order:

```
<exe dir>/web,  <exe dir>,  <cwd>/web,  <cwd>
```

`<exe dir>/web` wins whenever it exists — which is every real install: the NSIS
payload stages `web/` and **not** the root frontend
(`installer/build-installer.sh:218-226`), the deb/rpm require `web/`
(`payload.manifest`), and the Linux launcher hardcodes
`WEBROOT="$PREFIX/web"` (`linux-amd64/gobbonet-launch`).

So `chat.html`, `js/` and `css/` at the root of an install are **dead files**.
Verified live — old `web/chat.html` next to a new root `chat.html`, real
binary, real HTTP request:

```
$ curl -s http://127.0.0.1:9077/chat.html
<!-- OLD 1.7.3 web/chat.html -->
```

And `README.md:423-437`, "Where everything lives", tells users exactly the
wrong thing:

| | |
|---|---|
| `chat.html`, `js/`, `css/` | The chat interface itself. |

Neither `web/` nor the server binary appears in that table at all. The two
files that must be replaced are the two it does not mention, and the three it
does mention change nothing. The Linux ZIP doubles down: `LINUX-START-HERE.md`
advertises "a Linux amd64 runtime **and the editable source**" — with the
runtime serving its own copy, so editing the source is silent no-op.

This is precisely the failure `stage-web.sh` was written to prevent ("the copy
went stale silently, the server kept serving it, and nothing anywhere reported
a problem"). It was fixed in the repo and left in place in the user's install.

### 3. On the Windows PowerShell stack there is no binary, and never was

`README.md:60` documents the non-installer path as **Download ZIP → extract →
run `launch.bat`**. `launch.bat:2183` unconditionally starts the PowerShell
server:

```
start /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fileserver.ps1"
```

`fileserver.ps1` serves the repo root directly (`$Root`, line 48) and has **no
`/standdown` route** — the request falls to the static handler and returns 404
(`fileserver.ps1:2040-2044`). That 404 is what drives the panel into its
"server is older than these web files" branch (`js/15-cards.js:626-634`), which
then names a binary and a `web/` folder that this user's install does not have.

It gets worse in ABOUT. The page reads `/health-fileserver`
(`js/22-scheduler.js:537`). The Go server returns `version` and `mode`
(`internal/server/server.go:521-528`). The PowerShell server returns:

```powershell
Write-Json $response 200 @{ status = 'ok'; pid = $PID; hotswap = $HotSwapEnabled }
```

No `version`. So `_releaseOf(server)` is empty, `cmp` is `null`, the mismatch
warning stays hidden, and ABOUT reports the **page's** stamp
(`GOBBONET_UI_VERSION = '1.7.4'`, `js/01-config.js:24`) as *the* version. The
app therefore tells this user, in the same session:

- ABOUT: you are running 1.7.4.
- CONFIG: your server is too old for this 1.7.4 setting, replace the binary.

Both are wrong. There is no version and no binary; there is a different program
that never had the feature.

One useful fact in the other direction: **`fileserver.ps1` already owns
llama-server.** It stops it by image name (`Get-Process -Name 'llama-server'`,
line 1369), starts a replacement from `.llama-launch.cmd` for `/swap-model`,
and tracks in-flight generations for `/llm/jobs`. Every primitive stand-down
needs is already in that file. This stack is not incapable of the feature — it
simply was not given it.

### 4. There is no documented update procedure anywhere

No "Updating" or "Upgrading" section in `README.md` or `TROUBLESHOOTING.md`.
The public Releases page still tops out at v1.5.8, so 1.7.x is handed out as
loose zips. Users invented the only procedure available to them — replace the
files — and nothing in the project tells them which files carry what, or that
one of them isn't in the box.

### 5. Windows locks a running `gobbonet.exe`

Even once a Windows binary does ship, a drag-and-drop update over a running
install hits a locked `gobbonet.exe`, Explorer offers **Skip**, and the user
takes it. Result: new `web/`, old server, greyed-out panel — the reported
symptom exactly. The NSIS installer handles this deliberately
(`installer/gobbonet.nsi:663-684`, which stops and explains while it is still
fixable). The manual path has no equivalent.

---

## What is *not* wrong

Worth stating, because it narrows the fix.

**The mechanism is sound.** Against the shipped 1.7.4 binary and a stand-in for
llama-server:

```
1) booted                phase=ready, child process running
2) POST /standdown {"minutes":1}   -> {"minutes":1,"persisted":true}
3) after 60s idle        {"idle_seconds":82,"minutes":1,"stood_down":true,"supported":true}
   log: [standdown] idle for 1m0s; unloading test-model.gguf to free VRAM
   backend process:      gone
4) POST /llm/v1/chat/completions   -> HTTP 200 in 0.51s
   {"idle_seconds":0,"stood_down":false}, backend process back
```

**Upgraders are not silently opted out.** `Load()` starts from `Default()`, so
a config predating the key still reports the default. Verified with a config
file containing no `idle_standdown_minutes` at all:

```
$ curl -s localhost:9088/standdown
{"minutes":5,"stood_down":false,"supported":true}
```

**The config forward-compat fix does what it claims.** Verified against the
shipped binary — a future key warns and boots:

```
WARNING: future.toml has setting(s) this version does not know: a_setting_from_1_8
         They are being ignored. …
```

**Server-side is the right call.** A shut tab cannot run a timer. Nothing below
proposes moving it into the browser; that would trade a delivery problem for a
correctness one.

---

## Why "forward facing" was the wrong frame

The phrase assumes the two halves of the app move independently and need to
tolerate each other's versions. They do not need to. They need to **stop being
two halves** that a user can update separately, because every mechanism we have
for keeping them in step lives on the developer side — `stage-web.sh`,
`payload.manifest`, `build-release.sh`'s clean-tree check, `test-version-stamp.mjs`
— and none of it survives contact with a person dragging a folder.

A version-tolerance rule cannot fix an artifact that does not contain the thing
being versioned.

---

## Options

### A. Embed the frontend in the binary — *recommended*

`go:embed web/` into `cmd/gobbonet`, keep on-disk `web_root`
(`internal/config/config.go:133`) as an explicit opt-in override for modders.

- Makes "replace one file" the whole update. The binary carries its matching UI;
  a half-updated install becomes impossible rather than merely detectable.
- Kills defect 2 outright, and kills the class — no future feature can ship its
  server half and page half out of step.
- Cost: modders must set `web_root` to override, and the binary grows by the
  size of the frontend (~1 MB). Losing drop-a-file CSS tweaks is a real cost and
  should be documented, not glossed.

### B. Have the binary re-stage `web/` from the root source

Port `stage-web.sh`'s logic into the server: at boot, if the root frontend
differs from `web/`, restage and log it.

- Makes the action users already take (replace `chat.html`/`js`/`css`) do what
  they expect.
- Does **not** fix stand-down, because it does not update the binary. Useful as
  a companion to A, not a substitute.

### C. Ship a Windows binary in the zip, or stop shipping a zip

Non-negotiable regardless of what else is chosen. Either `gobbonet.exe` goes in
the archive beside `linux-amd64/`, or the archive stops being an update channel
and the release page carries `build-release.sh`'s per-platform archives (which
already contain binary + `web/` + `models.ini` together, correctly paired).
Committing an `.exe` conflicts with `.gitignore:11` and is a call for you, not
me — but a hand-assembled release zip is not a git archive anyway, and this one
already carries a committed Linux binary.

### D. Make `launch.bat` hand off to `gobbonet.exe` when it is present

One line of intent, two real wins: installer users who click "Add another
model" (`installer/gobbonet.nsi:873`) stop starting a second, featureless
server — which today serves **404 for the chat page**, since NSIS installs no
root `chat.html` — and the PowerShell serving path stops being reachable by
accident.

### E. Port stand-down to `fileserver.ps1`

Only if the PowerShell stack is staying as a supported server. The primitives
are there (defect 3). The part that would bite is the in-flight counter — the
changelog is right that a six-minute generation looks exactly like an idle one,
and that logic would now exist twice, in two languages, with a test harness for
only one of them. I would not choose this unless C and D are both rejected.

### F. Report the mismatch honestly, wherever it is detected

Cheap, and worth doing whatever else is chosen. The frontend already has the
right diagnosis in ABOUT (`js/22-scheduler.js:589-595`, "the web files were
updated without replacing the gobbonet binary beside them") — it is just not
wired to the panel, and it cannot fire on the PowerShell stack.

Three concrete changes:

1. Give the stand-down panel the three cases it actually has, from
   `/health-fileserver` rather than from a 404: **no `version` field** → this is
   the PowerShell server, name it and say the Go server is the one with this
   feature; **`version` older than the page stamp** → name the file and the
   platform's path; **route missing but version current** → a real bug, say so.
2. Add `version` to `fileserver.ps1`'s `/health-fileserver`, read from
   `VERSION`. It costs one line and it stops ABOUT from claiming a version the
   serving program does not have.
3. Log a startup line from the Go server when the served `chat.html`'s
   `GOBBONET_UI_VERSION` does not match `version.String()`. The pairing is
   currently checked only in a browser, by a user who has to open ABOUT to see
   it. Roadmap item 12's stale binary would have been caught at boot by this.

---

## Recommendation

**A + C + D + F now. B as a follow-on. E only if you intend to keep the
PowerShell server as a server.**

That combination answers the actual requirement — *take the zip, replace files,
have it work* — rather than explaining why it doesn't. A makes the binary
self-sufficient, C puts a Windows binary in the archive so there is something
to replace, D removes the second server that silently lacks every server-side
feature, and F means the remaining failure modes say something true.

## Before the zip ships

Independent of the option chosen, these are wrong in the archive as it stands:

- `LINUX-START-HERE.md` is headed **1.7.3** and names 1.7.3 `.deb` files, in a
  1.7.4 zip. Roadmap item 13 already has this open.
- `README.md:423-437` points users at `chat.html`/`js`/`css` as "the chat
  interface itself" and never mentions `web/` or the binary.
- `README.md:60`'s Download-ZIP path leads to the PowerShell server, so it is
  also the path that silently has no server-side 1.7.4 features.
- The stand-down panel's "ships in the same download as `web/`" is false for
  this archive on Windows.

## What I did not test

No PowerShell available here, so defect 3's 404 and the health-payload shape
are read from source, not executed — the routing is a literal `elseif` chain
with a static fallthrough, so I am confident, but it is not a run. No Windows
machine, so defect 5 is reasoned from the NSIS code's own account of the lock
rather than reproduced. No 1.7.3 binary, so "a 1.7.3 binary still refuses a
1.7.4 config" is taken from the earlier changelog as given; the 1.7.4 side of
that rule I did verify.
