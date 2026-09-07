# v1.7 — "The system cannot find the drive specified."

*Addresses #36. Also removes noise reported in passing by #17 and #37.*

---

## Symptom

Five copies of

```
The system cannot find the drive specified.
```

print before the GobboNet banner, every launch. Nothing is actually broken —
the app starts, finds the model and runs — but it is the first thing on
screen, it looks like a stack of failures, and it survives a reinstall.

From #36, on a `D:\Programs\GobboNet` install:

```
The system cannot find the drive specified.
The system cannot find the drive specified.
The system cannot find the drive specified.
The system cannot find the drive specified.
The system cannot find the drive specified.

 ====================================================
      GOBBONET - LOCAL AI CHAT
```

---

> **Revised twice after hardware testing.** Two earlier theories are kept
> below, struck through, because the wrong turns are the useful part of this
> record. The real cause is in **The actual cause** further down.

## First theory: a dead `%PATH%` entry — WRONG

Windows, not GobboNet.

`launch.bat` names the tools it needs bare — `curl.exe`, `powershell`,
`certutil`, `tar`, `reg` — the way batch files normally do. For each one
Windows walks `%PATH%` folder by folder until it finds a match.

If any entry ahead of `System32` in that list points at a drive that no
longer exists — an unmapped network drive, a USB stick that is gone, a
leftover from an uninstalled program — the walk prints
`The system cannot find the drive specified.`, then carries on to the next
folder and finds the tool anyway. One line per lookup.

Two details are consistent with this:

- **The count matches exactly.** The script performs precisely five tool
  lookups before printing the banner, and #36 reports precisely five lines.
- **So does the silence after.** Between the banner and the `Select model`
  prompt the script spawns no external tools at all, and #36's transcript
  shows no further lines there. Five lookups, five errors; no lookups, no
  errors.

It also fits the message ignoring where GobboNet is installed.

**It did not survive testing.** On a Windows 10.0.26200 machine still
reporting the message, `%PATH%` contained no dead entry — every element was
a live `C:` path — and running the five original bare-name probes by hand
printed nothing. The `System32` anchor is kept as cheap hardening, not as
the fix.

## Second theory: the `%TEMP%` scratch file — ALSO WRONG

`:http_alive` staged curl's response through a scratch file in `%TEMP%`;
`:http_health` pipes straight into findstr. In one session `:http_alive`
printed the message on all three of its calls while `:http_health` polled
five times in a row silently, so the scratch file looked like the culprit.
Rewriting `:http_alive` to pipe changed nothing. The message appeared in the
same three places.

That result was worth having: it ruled out the plumbing and left the real
difference exposed.

## The actual cause

**`::` is only a comment at the top level of a batch file. Inside a
parenthesised block it is not a comment at all** — cmd tries to execute it,
and a token ending in `:` reads as a request to change drive. The message
for a drive that does not exist is, word for word, the one being reported.

The comment line *is* the error. It reports nothing.

The two probe routines settle it:

| Routine | `::` lines inside its block | Calls in one session | Errors |
|---|---|---|---|
| `:http_alive` | 2 | 3 | **3** |
| `:http_health` | 0 | 4 | **0** |

Same URL, same curl, same session. The only structural difference is two
comment lines sitting inside `if defined HAVE_CURL ( ... )`.

This also explains the varying counts across reports. There are 57 such
lines across the four scripts, but only those on a path actually taken print
anything — which is why a normal launch shows three and a first install or
an error path shows more.

## Fix

`::` becomes `rem` on every one of those lines. `rem` is a real command and
is safe inside a block.

`rem` does **not** neutralise everything, though: cmd still acts on
parentheses, redirection and quotes on a `rem` line. Nine of the 57 carried
those characters, so their punctuation was softened first — meaning
unchanged, only the punctuation:

| Was | Now |
|---|---|
| `(which some ... produce),` | `[which some ... produce],` |
| `"custom ports do not work".` | `'custom ports do not work'.` |
| `<think> tags` | `[think] tags` |
| `"Desktop chat still works normally."` | `'Desktop chat still works normally.'` |
| `status >= 400` | `status of 400 or above` |
| `"nothing is running now"` | `'nothing is running now'` |

Counts: 47 in `launch.bat`, 7 in `setup-lan.bat`, 3 in `stop-gobbonet.bat`,
0 in `teardown-lan.bat`.

No logic changed. Verified afterwards that the parenthesis-depth profile
still ends at zero in every file, that the only code-line changes are the
19 additions and 9 removals belonging to the preflight and `:http_alive`
work, and that `gen-catalog.py` still reproduces `models.ini` byte for byte.

## Lesson

The static checker flagged all 57 of these on the first pass. The result was
read as "57 before, 57 after, nothing added" — parity treated as the safety
property — and the findings were dismissed as the checker miscounting
parentheses inside `echo` text. The claim was never tested. Two rounds were
spent on theories that a five-line experiment would have killed at the
start.

Parity is worth checking. It is not a substitute for reading what the tool
is actually saying.

---

## What this is *not*

The fix usually suggested for this message is `cd /d "%~dp0"` at the top of
the script, on the theory that the working directory is wrong. It isn't, and
that change does nothing here:

- The installer's shortcuts already start in the install folder —
  `SetOutPath "$INSTDIR"` runs before `CreateShortcut`.
- `launch.bat` never reads the working directory anyway. Every path in it is
  built from `%~dp0`.
- It was tried. See #37, where the reporter added exactly that line and the
  message stayed.

---

## Fix

**Put `System32` at the front of the search order.** A `%PATH%` lookup stops
at the first hit, so every one of those tools is now found in the first
folder tried and a dead entry further down is never probed — and so never
gets to complain.

```bat
set "SYS32=%SystemRoot%\System32"
if not exist "%SYS32%\cmd.exe" set "SYS32=%windir%\System32"
if exist "%SYS32%\cmd.exe" set "PATH=%SYS32%;%SYS32%\WindowsPowerShell\v1.0;%PATH%"
```

`%PATH%` is only touched once a real `System32` has been confirmed, so a
machine with an unusual `%SystemRoot%` is left exactly as it was, and
`setlocal` scopes the change to the script.

In `launch.bat` this sits *above* the keep-open guard, because that guard's
own `cmd /k` is a bare-name lookup too and would otherwise still print one
stray line before anything else ran. The relaunched copy re-runs the three
lines harmlessly; a duplicate `System32` entry costs nothing.

**Preflight probes also take the absolute path.** The five probes that run
before any output — the ones users actually see complain — now invoke the
tool from its full `System32` path, falling back to the bare name only if the
tool genuinely is not there (pre-1803 Windows, or a custom build):

```bat
set "T_CURL=%SYS32%\curl.exe"
if not exist "!T_CURL!" set "T_CURL=curl.exe"
"!T_CURL!" --version >nul 2>&1
```

Belt and braces on top of the anchor: these five now avoid `%PATH%`
altogether, including on a machine where the tool is missing and the search
would otherwise walk every folder looking for it.

---

---

## What testing actually found

Two separate faults, one of them mine.

### The `for /f` quoting regression

Switching the PowerShell preflight probe to a quoted absolute path broke it,
and the launcher began reporting "No working PowerShell found" on machines
where PowerShell was fine. `for /f` hands its command to a second `cmd`,
which strips one quote from the front and one from the end before running
it. A command that *begins* with a quote therefore arrives mangled.

Measured on the reporting machine, same probe three ways:

| Form | Result |
|---|---|
| `powershell` (bare, original) | `OK` |
| `"C:\...\powershell.exe"` (quoted) | *empty — the bug* |
| `C:\...\powershell.exe` (unquoted) | `OK` |

Fixed by dropping the quotes. `%SystemRoot%` cannot contain a space, so
they were never needed. The four probes that are ordinary commands rather
than `for /f` were unaffected and keep their quoted absolute paths.

### `:http_alive` rewritten to a pipe

Made while chasing the second theory. It did not fix the message, but it is
kept: it drops a scratch file, a delete and a `%TEMP%` dependency, and makes
the two probes the same routine apart from the `-f` flag and the token they
match. Semantics are unchanged — with `-f`, a non-2xx reply reaches findstr
as nothing, so `RC=0` still requires a 2xx body containing `status`.

---

## Files changed

| File | Change |
|---|---|
| `launch.bat` | 47 `::`→`rem` inside blocks; anchor above the keep-open guard; five preflight probes on absolute paths (PowerShell's unquoted); `:http_alive` piped instead of a `%TEMP%` scratch file |
| `setup-lan.bat` | 7 `::`→`rem` inside blocks; anchor after `setlocal` |
| `stop-gobbonet.bat` | 3 `::`→`rem` inside blocks; anchor after `setlocal` |
| `teardown-lan.bat` | Anchor after `setlocal` (no `::`-in-block lines) |

The anchor is placed at the outermost `setlocal` in each file. The nested
`setlocal` blocks inside subroutines (`:add_urlacl`, `:stop_image`,
`:drop_rule`, `:drop_urlacl`) inherit it and need no change of their own.

---

## Side benefits

- Nothing earlier in `%PATH%` can shadow `curl` or `certutil` with a
  lookalike. Worth having: those two download and checksum the models.
- Tool lookups resolve on the first folder tried instead of walking the list,
  so startup is marginally quicker.

---

## Not affected

`gobbonet.exe` does not have this bug. Go's `exec.LookPath` skips an
unreachable `%PATH%` entry silently instead of printing a console message, so
the Go server's `taskkill` / `tasklist` / `netsh` calls were never a source of
these lines. Reports that name `GobboNet.exe` are from the 1.6-era shim that
ran `launch.bat` behind it; 1.7 points its shortcuts at the real binary.

---

## Verification

`.bat` files cannot be executed in the environment this was prepared in, so
the changes were checked statically instead:

- **Structure unchanged.** `installer/gen-catalog.py` parses the model
  catalogue back out of `launch.bat` and is written to fail loudly if the
  file's shape shifts. It parses the patched file and emits an
  `installer/models.ini` byte-identical to the committed one.
- **No new syntax faults.** A parenthesis-depth / quote-balance / `goto`-target
  pass over all four files reports exactly the same findings before and after
  — none added, none lost — and `setlocal`/`endlocal` counts are unchanged.
- **Line endings intact.** All four files remain pure CRLF, no bare LF, no
  stray CR.
- **The one delicate line was modelled.** The `for /f` probe now holds a
  quoted path. `for /f` runs its command as `cmd /c "<command>"`, and cmd's
  documented quote rules strip exactly that added outer pair back off.
  Implementing those rules and round-tripping the real command line confirms
  it arrives at PowerShell unchanged.
- **Go suite green.** `go build ./...`, `go vet ./...` and `go test ./...`
  all pass (Go 1.27.0).

Round two additionally verified on real hardware via a purpose-built
diagnostic script: the quoting bug reproduced exactly as predicted, and both
candidate fixes for it returned the expected values.

What still needs a Windows box: confirming the console is now clean end to
end, including the first-install and download paths, which carry most of the
other 54 converted lines and which no test run has exercised yet.
