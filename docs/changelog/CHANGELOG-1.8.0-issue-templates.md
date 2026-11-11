# 1.8.0 — Issue forms and a PR template

Issue #62 (Solteris-Dev). Roadmap item #5. Docs only: nothing that ships in the
app changes.

## What was happening

Half of #62 was already done: CONTRIBUTING.md (1.7.8) restates the
reimplement-and-credit policy, and AGENTS.md was refreshed for 1.7.9. But
CONTRIBUTING.md tells people to "Use the **Bug report** template under New
issue", lists what it asks for, and describes "an optional section" in "the bug
report and PR templates". The repository had no `.github/` folder, so none of
that existed. The 1.7.9 version bump also noted that the bug form's version
placeholder lived only on GitHub, outside the tree.

## The change

Four files under `.github/`:

| File | Holds |
| --- | --- |
| `ISSUE_TEMPLATE/bug.yml` | The version (from ABOUT, required), COPY BUILD INFO, how GobboNet was started (a dropdown of the launchers that ship), OS, GPU, what happened, steps, what was expected, `gobbonet doctor` output, the end of `llama-server.log`, the optional AI section, and a required tick: "I read what I pasted and removed addresses, folder paths and anything else I don't want public." The form opens with where security reports go and what doctor output can reveal, before anything is pasted. |
| `ISSUE_TEMPLATE/feature.yml` | What you want to do, what you tried, whether it should be on for everyone or a setting, whether it would send anything off this PC, details, and the optional AI section. |
| `ISSUE_TEMPLATE/config.yml` | Blank issues stay allowed. Two contact links to the GobboNet Discord: security reports, privately, as CONTRIBUTING.md says; and questions and ideas. |
| `PULL_REQUEST_TEMPLATE.md` | What changed and why, tests run, what was not tested, CONTRIBUTING.md's privacy and security rules as tick boxes, the house rules, and the optional AI section. |

The "how did you start it" options are the launchers that ship: the GobboNet
and Launch GobboNet shortcuts, Setup or add a model, `launch.bat`,
`gobbonet.exe` run directly, the `.deb`/`.rpm` menu entry and `gobbonet`
command, the AppImage, and the ZIP's `./gobbonet`. The legacy PowerShell server
is not offered: it goes in 1.8.0 (roadmap #13).

**The AI section is opt-in**, in the shape contributors already use on #62,
#63, #66, #70 and #71: which assistant, what a person checked and how, and
which claims are unverified. Every form says it is never a gate, and it is
never required.

Also:

- `scripts/make-zip.sh` copies `.github/` into the archive and requires it,
  so a checkout updated from the zip receives the templates
  (`tests/test-file-layout.py` checks both). The Windows
  installer's payload comes from the `.nsi`'s own file list, so `.github/`
  stays out of it.
- CONTRIBUTING.md's "how you started GobboNet" list names the AppImage too,
  as the form does.
- AGENTS.md lists `.github/`.

## Tests

- `tests/test-docs-current.py`, new `Templates` class (7 tests). Every template
  CONTRIBUTING.md names exists. The bug form asks for each thing CONTRIBUTING.md
  lists. Its start options are exactly the launchers in this tree, each tied to
  the file that makes it real (an `.nsi` shortcut, `launch.bat`, the zip
  manifest, the `.desktop` entry and spec, the AppImage builder, the ZIP entry).
  The privacy tick is required and comes after the warning. The security link is
  CONTRIBUTING.md's Discord. The PR checklist has a box for each of
  CONTRIBUTING.md's privacy rules. Every AI section is optional. The forms are
  read as text, so the suite still needs nothing beyond Python.
- `tests/test-version-strings.py`: the bug form's version placeholder follows
  `VERSION`, so the release bump cannot leave it behind.
- Checked by breaking them: dropping the AppImage option, making the privacy
  tick optional, pointing the security link elsewhere, and a stale version
  placeholder each fail the suites.
- The forms were also checked against GitHub's issue-form rules (types, unique
  ids and labels, dropdown options, attributes per type) with a YAML parser.

Not run here: GitHub rendering the forms. That shows on the repository's New
issue page once this is pushed.
