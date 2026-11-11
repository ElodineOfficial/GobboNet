# 1.8.0 — the legacy PowerShell server is gone

Roadmap item #13. PR #56 and PR #58 (orcmaul) both edited the branch removed
here; they close with credit, and their ideas land in #15 (the embedding
supervisor) and #7 (`open_browser`, already in 1.8.0).

## What was happening

1.7.9 told users, in both `launch.bat` and `fileserver.ps1`, that the
PowerShell server "will be removed in GobboNet 1.8". Until then `launch.bat`
had two paths. Normally it asked its questions and handed over to
`gobbonet.exe`. Without `gobbonet.exe`, or with `GOBBONET_LEGACY_SERVER=1`, it
started llama-server itself, served the chat from `fileserver.ps1` (2,108
lines of PowerShell) and watched both from a monitor loop in a minimised
window. That second path had none of the server-side features since 1.7.6
(sync, stand-down, presets, the GPU menu, load-failure reasons), a separate
llama-server command line that had to be kept in step with Go's by a test, and
a URL reservation in the kernel that only it needed.

## The change

**`fileserver.ps1` is deleted.** It leaves the ZIP manifest
(`scripts/make-zip.sh`) and the installer's file list.

**`launch.bat` has one path.** Removed: `:start_server_legacy`, its wait loop
and the STEP 3b offload grep; `:launch_legacy` through the health monitor and
its restart loop; the minimise/restore helpers (and their inline P/Invoke)
that only the monitor used; `:http_probe`, `:llm_state` and `:http_health`,
whose only callers were in that branch; the `active-model.json` and
`models-list.json` writes, which existed for the PowerShell server to hand to
the page (`gobbonet.exe` answers both itself from its own scan of `models\`);
and the variables only the branch read (`LOG_VERBOSITY`, `LOG_FILE`,
`LAUNCH_SCRIPT`, the swap lock files, `SECRET_JUST_SET`). 3,033 lines become
2,071. `:http_get` and `:http_alive` stay, because the downloads and the
embedding server use them. The PowerShell preflight probe now resolves
`System.Net.WebClient`, the type the download fallback uses, instead of the
listener type only the old server needed.

**A missing `gobbonet.exe` stops the run at the start**, before the password
prompt and the downloads, with a message that says to re-extract the package
or reinstall and to check antivirus quarantine. It is checked once more right
before the hand-over, because a scan can take the file mid-run. Before, a
missing `gobbonet.exe` silently meant the legacy server.

**`GOBBONET_LEGACY_SERVER` is ignored**, and `launch.bat` says so in one line
for anyone who still sets it. `gobbonet launch --setup` keeps dropping a stale
value from the environment, so normal starts never print the note.

**`setup-lan.bat` makes no URL reservation.** `gobbonet.exe` binds with
Winsock and never used one. It now removes the reservations older versions
left: the web port's, plus the old 11435 and 8080 ones it already cleaned. The
web port's is removed too, not only left for `teardown-lan.bat` (the
maintainer's decision was to stop creating it; removing it on the same run is
an addition, for security): up to 1.7.8 it was granted to Everyone, which let
any account on the PC serve its own page at the chat's address while GobboNet
was stopped, and a reservation with nothing behind it makes Windows answer the
port with 503. Each removal is verified. The SID lookup and `:add_urlacl` go
with it. `teardown-lan.bat` keeps removing old reservations, unchanged.

**Leftovers are pointed out, not deleted** (the maintainer's call). The
installer deletes a stale `fileserver.ps1` on install; the uninstaller keeps
its Delete lines for it and its log. A ZIP update cannot delete files, so
`gobbonet doctor` on Windows now ends with a LEFTOVERS FROM 1.7 section when
`fileserver.ps1` or `fileserver.log` is in the install folder, saying nothing
runs them and they can be deleted; it prints nothing when there are none.
README.md and TROUBLESHOOTING.md say the same. The 1.8.0 update notes
(roadmap #6) carry the line for ZIP users. `stop-gobbonet.bat` still stops a
copy left running from before an update, because it holds the web port.

**The page's notices for a leftover server are corrected.** Idle Stand-Down,
LAN Access and the About row recognise a page served by the PowerShell server
(it names itself, or sends no version). They used to say "start GobboNet with
the gobbonet program file instead of launch.bat", which is no longer the fix:
`launch.bat` cannot start that server now. They say it is a copy left running
from GobboNet 1.7 and to run `stop-gobbonet.bat`, then start GobboNet again.

**`gobbonet doctor`'s URL RESERVATION section** says a reservation it finds was
left by 1.7 or earlier and how to remove it, and "none (GobboNet needs none)"
otherwise. The `.gobbonet-port` disagreement message no longer mentions a
reservation.

**Found on the way: `!` in `setup-lan.bat` and `stop-gobbonet.bat`.** Both run
with delayed expansion, where `!` marks a variable. `echo [!] Found !N! rules`
printed `[N rules`, and `All done!` lost its `!`. The markers are `[*]` now,
as in `launch.bat`, and a test catches a literal `!` in any of the delayed
expansion scripts.

**Docs and comments.** TROUBLESHOOTING.md loses the `fileserver.log` table, the
legacy-only "Waiting for server to come back up" section and the URL
reservation advice. SECURITY.md's capability list matches what ships: the
listener and the search POST are `gobbonet.exe`'s, the process kill is
`stop-gobbonet.bat`'s, the password hash is `launch.bat`'s, and the inline
P/Invoke and the URL reservation are gone (eight capabilities, not nine).
README.md, AGENTS.md, docs/GO_SERVER.md, installer-win/README.md, the NSIS
comments, `.gitignore` and the Go, JS and PowerShell comments that cited
`fileserver.ps1` for a behaviour that stays now call it the 1.7 PowerShell
server. History in docs/changelog/ and docs/archive/ is unchanged.

Not changed: the `/health-fileserver` route keeps its name, because the page
and `gobbonet doctor` call it. The embedding server is still started by
`launch.bat`; #15 moves it into `gobbonet.exe`.

## Updating

Extracting a ZIP cannot delete files, so a checkout updated from the round
ZIP runs `git-apply-1.8.0-legacy.sh` first: it deletes `fileserver.ps1`, then
the ZIP is extracted over it as usual. Windows users updating from a 1.7 ZIP
can delete `fileserver.ps1` by hand; nothing breaks if they do not.

## Tests

- `tests/test-legacy-removal.py` (new): `fileserver.ps1` is not in the tree,
  the manifest or the installer's file list; the installer deletes an old copy
  and the uninstaller still does; no shipped file names `fileserver.ps1` or
  `GOBBONET_LEGACY_SERVER` outside an allowlist that gives each place its
  reason; `launch.bat` has no PowerShell server start, no model-list writes
  and no window helpers; `setup-lan.bat` adds no reservation and removes the
  web port's; doctor deletes nothing.
- `cmd/gobbonet/doctor_leftover_test.go` (new): a clean folder prints nothing;
  a stale `fileserver.ps1` is named with the advice; a directory called
  `fileserver.log` is not mistaken for the log; nothing is deleted.
- `tests/test-launch-cmd-flow.py`: the step markers follow the new headings;
  the legacy labels, the monitor and the PowerShell start are gone;
  `GOBBONET_LEGACY_SERVER` only gets its note; a missing `gobbonet.exe` stops
  the run before the password prompt and again before the hand-over, and ends
  at `:fatal`; no literal `!` in a delayed-expansion script.
- `tests/test-setup-lan.py`: no reservation is added, none for Everyone, no SID
  lookup; the web port's, 11435's and 8080's are removed and the removal is
  checked; `teardown-lan.bat` still removes them.
- `tests/test-engine-args.py`, `test-launch-gpu-detect.py`,
  `test-launch-gpu-layers.py`, `test-tekken-template.py`: these pinned the
  batch llama-server command line against Go's. They now pin that
  `launch.bat` starts only the embedding server (without `-lv`), that
  `BuildArgs` keeps the shared flags, that the Go offload check accepts
  several spellings and passes `-lv 4`, that `-1` reaches `gobbonet.exe`
  untouched, and that the Go template tests exist.
- `tests/test-launch-secret-handoff.py`, `test-launch-open-browser.py`,
  `test-file-layout.py`, `test-prompt-safety.py`, `test-docs-current.py`:
  updated for one path and no `fileserver.ps1`; TROUBLESHOOTING.md says 1.8
  has one server and names the leftover.
- `tests/test-standdown-panel.mjs`, `test-lan-panel.mjs`,
  `test-version-stamp.mjs`: the leftover-server notices say to run
  `stop-gobbonet.bat` and no longer say `launch.bat` starts that server.

Every new or changed check fails on the round-5 tree.
