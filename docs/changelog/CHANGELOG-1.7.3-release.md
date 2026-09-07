# v1.7.3 — release

`VERSION` is now `1.7.3`.

That file is the single source. `build-release.sh`,
`installer/build-installer.sh` and `installer-linux/build-deb.sh` all read it and
stamp `<VERSION>-go-<sha>` into the binary via ldflags; the result is what
`gobbonet version`, the startup banner and `/health-fileserver` report. Checked
again this release — nothing else hardcodes a version.

`TestVersionFileMatchesUpstreamRelease` compares `VERSION` against the nearest
git tag and skips when there is no tag to compare against, which is the case in
an export. **On a real clone it will fail until `v1.7.3` is tagged** — that is
the test doing its job, not a defect. Same as 1.7.2.

---

## What is in this release

| Changelog | Closes |
|---|---|
| [`CHANGELOG-1.7.3-lan-address-and-firewall.md`](CHANGELOG-1.7.3-lan-address-and-firewall.md) | the "wrong IP in the launcher" report, plus the firewall triage gap |
| [`CHANGELOG-1.7.3-remote-model-list.md`](CHANGELOG-1.7.3-remote-model-list.md) | #47, #48, #27 |
| [`CHANGELOG-1.7.3-prompt-and-sanitizer-fixes.md`](CHANGELOG-1.7.3-prompt-and-sanitizer-fixes.md) | PR #30 (John McCardle) |

Closed as already-fixed during the same pass, no code required: **#19** (shipped
in 1.7.2), **#17** (the search relay it reported was deleted in 1.6.0), **#12**
(superseded by the catalogue), and **PR #34** (both halves shipped,
reimplemented).

---

## Regression audit

Run against the 1.7.2 tree before packaging, because three of these changes
touch code paths that every install uses.

| Check | Result |
|---|---|
| Declared symbols (Go funcs/types/consts, JS functions, PowerShell functions, batch labels) | **0 lost** |
| HTTP routes and route prefixes | 0 lost |
| `config.toml` keys and `GOBBONET_*` / `GEMMA_*` env overrides | 0 lost |
| Endpoints the frontend fetches | 0 lost |
| `chat.html` script and stylesheet load order | byte-identical |
| Files shipped by `gobbonet.nsi` / `build-deb.sh` | unchanged; no new manifest entries needed |
| `stage-web.sh` | runs clean, and all five changed JS modules reach the payload |
| Per-file line endings | preserved (`launch.bat` CRLF, `identify-model.ps1` LF) |

Three user-visible strings changed, all intended, none dropped:

- `[OK] serving on http://<ip>:<port>/` → `[OK] serving on <url>`, because the
  address is now chosen from a ranked list rather than a single guess.
- `phone / LAN:   http://<ip>:<port>/` → one line per candidate address, each
  labelled with its adapter.
- `Built-in 'mDNS (UDP-In)' rule enabled on the Private profile.` → `…on all
  profiles`, following the `domain` profile being added to every rule.

**Local mode is unchanged on the wire.** `getRequestModelName()` returns the
literal `'local'` unless the server reported remote mode *and* an upstream model
is selected, and both flags initialise to off — so a local install, a `file://`
open, and a remote install whose model list failed to load all send exactly what
1.7.2 sent. `tests/test-remote-models.mjs` asserts this directly rather than
leaving it to inspection.

---

## Test suite

Everything below runs without a Go toolchain except the Go tests.

| Suite | |
|---|---|
| 12 × `tests/*.mjs` | 635 assertions |
| `tests/test-setup-lan.py` | 24 invariants |
| `tests/test-prompt-safety.py` | 37 invariants |
| `tests/test-launch-gpu-detect.py` | GPU-offload detection arrangement |
| `internal/server/*_test.go`, `cmd/gobbonet/*_test.go` | 25 cases added this release |

Four suites are new this release: `test-remote-models.mjs`,
`test-image-url-gate.mjs`, `test-prompt-safety.py`, `test-setup-lan.py`. Each was
verified against the pre-fix code so it is known to fail when the bug is present
— reverting the three PR #30 fixes trips 3, 1 and 16 assertions respectively.

---

## Packaging notes

- `web/` is a build artifact produced by `stage-web.sh` and is not committed;
  the packagers call it themselves.
- `tests/` and `docs/` are not shipped by either packager, which is unchanged
  and correct — the three changelogs above are repository history, not payload.
- `go build ./...` was not run in the environment these changes were made in
  (Go 1.22 available against a `go 1.25.0` module, and the module proxy
  unreachable). The new Go code is stdlib-only and was compiled and tested in
  isolation. **Run `go test ./...` on a full toolchain before tagging.**
