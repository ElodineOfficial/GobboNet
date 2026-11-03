#!/usr/bin/env python3
"""Regression: no build script may depend on another script's executable bit.

Every build script in the tree was committed 100644 and had been since the day
it was added -- release commits are made from Windows, where Git does not
record the bit. So in a fresh clone `./scripts/build-release.sh` failed with
"Permission denied", and `bash build-release.sh` failed one line later at its
own `./scripts/stage-web.sh`. Worse were the two places that TESTED for the bit
instead of running the file: check-rpm.sh skipped its payload verification and
build-deb.sh skipped regenerating models.ini, both silently, in every checkout.

Setting the bit in git is worth doing, but it is the half that a Windows commit
undoes. The half that holds is this: one script runs another through its
interpreter (`bash x.sh`, `python3 x.py`), never as a bare path and never
behind `[ -x ... ]`. That is what this file pins.

Roadmap 1.7.7 item #11; see docs/changelog/CHANGELOG-1.7.7-build-scripts.md.
"""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

# Build scratch and generated trees are not ours to police.
SKIP_DIRS = {'.git', 'dist', 'stage', 'stage-appimage', 'vendor', 'payload', 'rpmbuild', 'node_modules'}

# A path to a .sh or .py in COMMAND position: at the start of a line, after an
# operator or control word, or as the first word of a $( ) substitution. The
# path is either relative (./x.sh) or built from a variable ("$ROOT/x.sh").
_CMD_START = r'(?:^|[;&|(]|\$\(|\bthen\b|\bdo\b|\belse\b|\bif\b|\bwhile\b|\buntil\b|!|\bexec\b)'
_PATH = r'"?(?:\./|\.\./|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/)[^\s"]*\.(?:sh|py)\b'
DIRECT_CALL = re.compile(_CMD_START + r'\s*' + _PATH)

# A test of the executable bit on a script, which turns a missing bit into a
# silently skipped step rather than a failure.
BIT_TEST = re.compile(r'\[\s+-x\s+"?[^\]]*\.(?:sh|py)"?\s+\]')


def build_scripts():
    out = []
    for p in sorted(ROOT.rglob('*.sh')):
        rel = p.relative_to(ROOT)
        if SKIP_DIRS.intersection(rel.parts[:-1]):
            continue
        if rel.parts[:3] == ('internal', 'webui', 'assets'):
            continue
        out.append(p)
    return out


def offences(text):
    """(line number, line) for every call that depends on the bit."""
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        code = line.strip()
        if not code or code.startswith('#'):
            continue
        if DIRECT_CALL.search(code) or BIT_TEST.search(code):
            found.append((n, code))
    return found


class BuildScripts(unittest.TestCase):
    def test_the_check_recognises_what_it_exists_to_catch(self):
        # The exact lines this fix replaced. A pattern that quietly matched
        # nothing would pass every tree, so it is tested against them first.
        for line in (
            './scripts/stage-web.sh',
            '"$ROOT/scripts/verify-payload.sh" "$STAGE/usr/lib/gobbonet" "deb payload"',
            '"$ROOT/installer-linux/package-permissions.sh" "$STAGE"',
            'if ! "$HERE/check-rpm.sh" "$RPM"; then',
            'if report="$("$ROOT/scripts/verify-payload.sh" "$TMP$LIB" "packaged payload" 2>&1)"; then',
            'if [ -x "$ROOT/scripts/verify-payload.sh" ]; then',
            '"$ROOT/catalog/gen-catalog.py" "$ROOT/launch.bat" "$ROOT/catalog/models.ini"',
            './gen-catalog.py "$ROOT/launch.bat" models.ini',
        ):
            with self.subTest(line=line):
                self.assertTrue(offences(line), 'not recognised as depending on the bit: ' + line)
        # ... and the forms that replaced them, plus prose that merely names a
        # script, must not be flagged.
        for line in (
            'bash ./scripts/stage-web.sh',
            'bash "$ROOT/scripts/verify-payload.sh" "$STAGE/usr/lib/gobbonet" "deb payload"',
            'if ! bash "$HERE/check-rpm.sh" "$RPM"; then',
            'if report="$(bash "$ROOT/scripts/verify-payload.sh" "$TMP$LIB" "packaged payload" 2>&1)"; then',
            'if [ -f "$ROOT/scripts/verify-payload.sh" ]; then',
            'python3 ./gen-catalog.py "$ROOT/launch.bat" models.ini',
            'fail "icon/gobbonet-256.png is missing - run ./make-icon.sh"',
            '# ./scripts/build-release.sh --allow-dirty  build anyway',
        ):
            with self.subTest(line=line):
                self.assertFalse(offences(line), 'wrongly flagged: ' + line)

    def test_no_script_runs_another_by_its_executable_bit(self):
        scripts = build_scripts()
        self.assertGreater(len(scripts), 5, 'found almost no build scripts; is ROOT right?')
        bad = []
        for p in scripts:
            for n, code in offences(p.read_text(errors='replace')):
                bad.append(f'{p.relative_to(ROOT)}:{n}: {code}')
        self.assertEqual(bad, [], '\nrun scripts through bash/python3, not as a path '
                         'or behind [ -x ]:\n  ' + '\n  '.join(bad))

    def test_every_build_script_parses(self):
        for p in build_scripts():
            with self.subTest(script=str(p.relative_to(ROOT))):
                r = subprocess.run(['bash', '-n', str(p)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == '__main__':
    unittest.main()
