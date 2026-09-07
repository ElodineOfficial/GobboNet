# v1.7.2 — Linux triage pass

Findings from a WSL2 triage report against the 1.7.2 tree. The items requiring
a packaging-policy decision (version scheme, dependency weight, trimming the
llama.cpp tool suite) are deliberately untouched — they are calls for the
maintainer, not defaults to guess at.

---

## A11Y-1 — the cast-mismatch strip was invisible to screen readers

**High severity, and self-inflicted: this shipped in the previous entry.**

`chat.html` carried

```html
<div class="cast-mismatch" id="cast-mismatch" style="display:none;"></div>
```

with no `role`, no `aria-live`. The strip exists to mean *read this before you
press send* — it is the whole remaining half of the fix for issue #19. A blind
user got no signal that a different character was about to reply, and walked
into exactly the confusion #19 reported.

The missing role was not the worst of it. The code did:

```js
el.innerHTML = ...;          // inject
el.style.display = 'flex';   // then reveal
```

Injecting into a hidden element and revealing it afterwards is the order live
regions are least likely to fire on; several screen readers announce nothing.

### Fix

The container is now a permanent, unhidden live region:

```html
<div class="cast-mismatch-live" id="cast-mismatch" role="status"></div>
```

It carries no padding, border or background, so an empty one has no height and
nothing changes visually. All the visible styling moved to a `.cast-mismatch`
child that `updateCastMismatch()` creates. `updateInputState` no longer hides
it — there is nothing to hide, and hiding it would break the announcement.

**A hazard the report did not raise, and the more likely one to bite in
practice:** `render()` runs on nearly every interaction, and rewriting a live
region's contents makes a screen reader read them again. Announcing the same
sentence on every keystroke would be worse than silence. Content is now only
written when it actually changes.

Also: `aria-label` on the switch control, so it announces its destination
rather than a bare "Switch", and `aria-hidden` on the decorative dot so
"circle" is not read before every announcement.

One point from the report that turned out already satisfied: the `[Switch]`
control **is** a real `<button>`, so it was always keyboard reachable.

### Test

`tests/test-cast-mismatch.mjs` grew a section — 30 assertions now, from 22.
Its previous last two were "the strip is styled" and "the button has a hover
state": it tested logic and appearance, and nothing tested perceivability.

Now asserted: the container is `role="status"`, is never `display:none`,
`updateCastMismatch` does not toggle display, identical content is not
rewritten, the switch control names its destination, it is a real button, and
the dot is hidden from assistive tech. Reverting `role="status"` fails two;
removing the re-announcement guard fails one.

---

## SETUP-1 — "this install has no bundled engine", with the engine right there

The report's diagnosis was *the wizard probes the wrong path*. It does not
probe at all.

`cmd/gobbonet/setup.go` has a fallback for the catalogue and none for the
engine:

```go
if catPath == "" { catPath = catalog.Discover() }
...
ServerExe: *serverExe,   // the flag, and nothing else
```

Run standalone — which `--help` documents as supported — `gobbonet setup` sees
an empty `--server-exe`, concludes there is no engine, and pushes the user to
the remote-server option. The launcher hides this by passing `--server-exe`
itself, which is why the reported workaround works.

**The obvious fix would have broken remote mode.** `HealServerExe` returns
early on an empty path, and that is deliberate: empty *is* remote mode.
`installer/gobbonet.nsi:817` runs `config set server_exe ""` to select it. Any
change that auto-fills a blank `server_exe` silently cancels a user's choice of
a remote server.

### Fix

`config.DiscoverServerExe()` is split out of `HealServerExe`, because the two
are different questions:

- *Healing* asks "this configured path is broken, is there a better one?" and
  rightly refuses to answer when the path is empty.
- *Discovery* asks "did this install ship an engine?" — a property of the
  install, not of the user's configuration, and safe to show someone who has
  not chosen a backend yet.

Discovery writes nothing. An explicit `--server-exe` still wins, and choosing
remote still leaves `server_exe` empty.

It also looks in `llama-cpp-cpu/`, which the previous search did not. That
covers a second route to the same symptom the report did not reach: the
launcher's `pick_engine()` only accepts the Vulkan build if it answers
`--version`, then falls through to a CPU build that is only present when the
package was built with `BUNDLE_CPU=1`. On a machine where the Vulkan engine
will not start and no CPU build was bundled, the launcher passes no flag at
all — and now server-side discovery still finds one if it exists.

Five tests, including two that pin the thing most likely to be broken by a
careless future fix: healing still ignores an empty `server_exe`, and still
repairs a genuinely broken path.

---

## DOC-1 — the attempt count disagreed with its own comment

`attempts := 25` sat under a comment reading "200 attempts caught it on every
run, the slowest at attempt 28". Read together that says *deliberately too few*.

Both are true and the missing sentence is why. Detection moved to
`internal/atomicfile`, whose test reproduces the collision on attempt 0 every
run because it exercises the write directly instead of hunting for it through
eight HTTP round-trips. The handler test only has to cover the handler's own
contract, which 25 attempts does. The comment and the changelog now say so.

---

## PKG-5 — a source tree without `.git` could not be packaged

`build-deb.sh` ran `git rev-parse --short HEAD` with no fallback, so a tarball
or exported zip died with "not a git repository" before producing anything.
This is why no `.deb` was built during triage.

Now falls back to `nogit.<date>`, honouring `SOURCE_DATE_EPOCH` so reproducible
builds stay reproducible. A date rather than a stand-in hash on purpose: a
fabricated hash would claim the source had been identified when it had not.

Verified against a tree with `.git` removed: `1.7.2+go.nogit.20260904-1`.

---

## PKG-1 — the removal notice printed twice on purge

`postrm` matched `remove|purge`, and dpkg runs both phases, so a purge printed
the whole notice twice. Worse than repetitive: the second copy told the user to
reinstall in order to delete files, at the moment they had asked for everything
to be gone. Now `remove` only.

---

## SETUP-3 — clearing your config locked you out of setup

The completion marker lives in the data directory; the config it describes
lives in the config directory. Delete `~/.config/gobbonet` and the two
disagree — a default config is written, the marker still says complete, and
setup refuses. The user is left holding a config with no password, and the
escape hatch (`--force`) is only discoverable by reading `--help` after being
turned away.

A config that had to be created moments ago cannot be one setup configured,
whatever the marker says. That now counts as reason to run again, and says so.

Verified both directions: marker present with no config re-runs setup; marker
present with a config still reports already complete.

---

## SETUP-4 — a normal first run was reported as an error

Writing a commented default config on a machine that has never been configured
is the expected first run. It was printed under `[ERROR]`, which made a healthy
install read like a broken one.

A new `errNotice` prints under `[..]`, keeps the non-zero exit — the server
genuinely did not start — and skips the startup-error log, which should not
collect normal first runs.

---

## SETUP-5 — setup finished without saying how to start anything

Setup printed an address and stopped. Anyone who reached it through the desktop
entry needs nothing, because the launcher starts the server itself; anyone who
ran setup by hand was left with a finished install and no next step. It now
says `gobbonet` and that Ctrl+C stops it.

---

## Deliberately not touched

**PKG-2, PKG-3, PKG-4** — the Debian version scheme, version-metadata drift,
and the 97-package dependency footprint. Each is a policy decision with
trade-offs only the maintainer can weigh: `1.7.2+git20260904.<commit>-1` sorts
correctly but changes every future upgrade path, and dropping `zenity` or the
unused llama.cpp tools trades installed size against graphical prompts and
debuggability.

**SETUP-2** — `dry_penalty_last_n: -1`. Already fixed in this tree by
`resolveDryPenaltyLastN()`. The report tested build 663fc9b, which predates it.
Worth re-testing rather than re-fixing.

---

## Files changed

| File | Finding |
|---|---|
| `chat.html`, `js/13-dashboard.js`, `css/04-chat.css` | A11Y-1 |
| `tests/test-cast-mismatch.mjs` | A11Y-1 — 22 assertions to 30 |
| `internal/config/config.go` | SETUP-1 — `DiscoverServerExe` |
| `internal/config/discover_serverexe_test.go` | SETUP-1 — new |
| `cmd/gobbonet/setup.go` | SETUP-1, SETUP-3, SETUP-4, SETUP-5 |
| `cmd/gobbonet/main.go` | SETUP-4 |
| `installer-linux/build-deb.sh` | PKG-5 |
| `installer-linux/postrm` | PKG-1 |
| `internal/setup/setup_test.go`, changelog | DOC-1 |

---

## Verification

- Full Go suite at `GOMAXPROCS=16` **with `-race`**: 13 packages, clean.
- All 10 `.mjs` suites: 580 assertions, 0 failures.
- A11Y assertions confirmed to fail when `role="status"` or the
  re-announcement guard is removed.
- `bash -n` on every shell script touched; PKG-5's fallback exercised against a
  tree with `.git` deleted.
- SETUP-3 exercised in both directions with a real binary.
- Batch linter, `stage-web.sh`, and `installer/models.ini` unchanged.

**What still needs bare metal**, unchanged from the report: whether the strip
is actually announced by a real screen reader, whether SETUP-1's fix resolves
the symptom on a real install, Vulkan acceleration, desktop integration, and
browser launch. None of that is testable here, and the fixes above should be
treated as diagnosed rather than confirmed until they are.
