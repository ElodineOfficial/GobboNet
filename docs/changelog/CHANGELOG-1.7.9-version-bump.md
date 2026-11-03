# 1.7.9 — Version strings

*Patch step 16 of 1.7.9: the release gets its number. It follows the 1.7.8 bump
(`CHANGELOG-1.7.8-version-bump.md`) step for step.*

## Changed

| File | Was | Now |
|---|---|---|
| `VERSION` | `1.7.8` | `1.7.9` |
| `js/01-config.js`, `GOBBONET_UI_VERSION` | `'1.7.8'` | `'1.7.9'` |
| `installer-win/gobbonet.nsi`, `APPVER` | `"1.7.8"` | `"1.7.9"` |
| `installer-win/gobbonet.nsi`, `OutFile` | `GobboNetSetup-1_7_8.exe` | `GobboNetSetup-1_7_9.exe` |
| `installer-win/gobbonet.nsi`, `VIProductVersion` | `"1.7.8.0"` | `"1.7.9.0"` |
| `installer-fedora/FEDORA.md`, the `dnf install` line | `gobbonet-1.7.8-*` | `gobbonet-1.7.9-*` |
| `installer-fedora/gobbonet.spec`, `%changelog` | newest 1.7.8-1 | a 1.7.9-1 entry on top |
| `LINUX-START-HERE.md`, title and both install commands | 1.7.8 | 1.7.9, plus a "New in 1.7.9" line |
| `docs/BUILDING.md`, the tag example | `v1.7.8` | `v1.7.9` |
| `AGENTS.md`, "as of" | 1.7.8 | 1.7.9 |

**Everything else derives from `VERSION`:**
- the build stamp, `1.7.9-go-<sha>`, via `make-zip.sh` and `build-release.sh`;
- the ZIP's name, `GobboNet-1_7_9.zip` and `GobboNet-1_7_9-update.zip`;
- `build-deb.sh`, `build-appimage.sh`, `build-rpm.sh` and the spec's
  `%{gn_version}`.

**Not in this tree, so not changed here:** `.github/ISSUE_TEMPLATE/bug.yml`'s
version placeholder. The 1.7.8 bump changed it; it should read 1.7.9 in the
repository.

**Release notes:**
- `scripts/PATCH-README.txt`, which ships in the ZIP as `PATCH-README.txt`, is
  now the 1.7.9 release notes, grouped as new, fixed and changed. Until now
  it was a running list of patch steps.
- `README.md`:
  - *Recently fixed* gains the Tekken fix;
  - the model list names Mistral Nemo;
  - *Upcoming changes* marks UNDO as shipped;
  - the feature list gains UNDO, the tour, the CONFIG sections, Add a Model's
    tiers and FOUND ON THIS COMPUTER, and default-character UPDATE;
  - fixed in passing: the Config File path (now under Advanced since step 10)
    and the `{{fast_forward}}` macro's name.

**Left as they are:**
- sentences about the released 1.7.8 itself, such as "fails on the 1.7.8
  script" and "1.7.8's was about 1,920";
- 1.7.8's changelogs;
- the 1.7.9 changelogs, which were written as 1.7.9 from the start.

## The git tag

`TestVersionFileMatchesUpstreamRelease` compares `VERSION` with the nearest
`v*` tag. This tree has no tags, so it skips and says so. Tag `v1.7.9` on the
commit you release, and it holds `VERSION` to it from then on.

## Tests

- `tests/test-version-strings.py` holds the installer literals, `FEDORA.md`
  and the spec's newest changelog entry to `VERSION`.
- `tests/test-version-stamp.mjs` holds the page's stamp to `VERSION`.
- `tests/test-linux-start-here.py` holds the Linux guide's title and install
  globs to `VERSION`, matched against the asset names a release produces.
- `make-zip.sh` refuses to build when either server or the page reports
  another version. Both archives were built from this commit and say
  `1.7.9-go-<sha>`.
