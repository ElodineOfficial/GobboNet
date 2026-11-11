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

1.8.0 adds the other half (roadmap item #2): the COMMANDS WE TELL PEOPLE TO
TYPE. 1.7.7 left `./scripts/make-zip.sh` in the docs on the grounds that the bit
would make it work, and by 1.7.9 every build script had lost the bit again. So
every documented run of a repo script goes through its interpreter too --
`bash ./scripts/make-zip.sh` -- which works whatever the file mode is. See
docs/changelog/CHANGELOG-1.8.0-script-modes.md.
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


# A repo script named as ./path.sh or ./path.py in text a PERSON reads: docs,
# usage comments, the messages a script prints, ../x.sh as much as ./x.sh. It
# is fine only when the word before it is its interpreter (`bash ./x.sh`,
# `sudo bash ./x.sh`, `python3 ./x.py`). Prose that merely names a script
# leaves off the ./ (`scripts/make-zip.sh builds both`).
DOC_PATH = re.compile(r'(?<![\w./-])\.\.?/[\w./-]+\.(?:sh|py)\b')
INTERPRETER = re.compile(r'(?:^|[\s`(])(?:bash|python3)\s+$')

# History is left as it was written: changelogs and archived notes quote the
# commands of their day. tests/ holds the patterns themselves as test data;
# its README is a doc like any other and is checked.
DOC_SKIP = (('docs', 'changelog'), ('docs', 'archive'), ('tests',))


def doc_files():
    out = []
    for pattern in ('*.md', '*.txt', '*.sh'):
        for p in ROOT.rglob(pattern):
            rel = p.relative_to(ROOT)
            if SKIP_DIRS.intersection(rel.parts[:-1]):
                continue
            if rel.parts[:3] == ('internal', 'webui', 'assets'):
                continue
            if any(rel.parts[:len(s)] == s for s in DOC_SKIP) and rel != Path('tests', 'README.md'):
                continue
            out.append(p)
    return sorted(set(out))


def doc_offences(text):
    """(line number, line) for every ./script a person is told to run bare."""
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        for m in DOC_PATH.finditer(line):
            if not INTERPRETER.search(line[:m.start()]):
                found.append((n, line.strip()))
                break
    return found


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

    def test_the_docs_check_recognises_what_it_exists_to_catch(self):
        # Lines from the 1.7.9 tree that told people to run a script bare.
        for line in (
            '- **ZIP:** `./scripts/make-zip.sh` builds both servers and refuses to produce an',
            'cd installer-linux && ./build-deb.sh  # gobbonet_<VERSION>+go.<sha>-1_amd64.deb',
            'SKIP_ENGINE_FETCH=1 ./build-deb.sh          # uses installer-linux/vendor/',
            '#   ./scripts/make-zip.sh --no-engine     same, without the bundled llama.cpp engine',
            '#   sudo ./test-in-fedora.sh --root DIR --rpm PKG.rpm --python CPYTHON.tar.gz \\',
            'pip install gguf numpy && ./make-test-model.py test-model.gguf   # < 1 MB',
            'echo "  Other platforms (linux/arm64, darwin) come from ./scripts/build-release.sh."',
            '#   ./build-deb.sh && ./build-appimage.sh      the newest dist/gobbonet_*_amd64.deb',
            'bash ./build-deb.sh && ./build-appimage.sh',
            '../scripts/build-release.sh          # produces dist/<version>/...-linux-amd64.tar.gz',
        ):
            with self.subTest(line=line):
                self.assertTrue(doc_offences(line), 'not recognised as a bare command: ' + line)
        for line in (
            'bash ./scripts/make-zip.sh --no-engine',
            '- **ZIP:** `bash ./scripts/make-zip.sh` builds both servers',
            'cd installer-linux && bash ./build-deb.sh',
            'SKIP_ENGINE_FETCH=1 bash ./build-deb.sh',
            '#   sudo bash ./test-in-fedora.sh --root DIR',
            'pip install gguf numpy && python3 ./make-test-model.py test-model.gguf',
            'bash ./build-deb.sh && bash ./build-appimage.sh',
            'Other platforms come from scripts/build-release.sh.',
            'bash ../scripts/build-release.sh     # produces dist/<version>/...',
            'use dist/ from scripts/build-release.sh',
            'cd GobboNet && ./gobbonet',
        ):
            with self.subTest(line=line):
                self.assertFalse(doc_offences(line), 'wrongly flagged: ' + line)

    def test_no_doc_tells_people_to_run_a_script_by_its_executable_bit(self):
        files = doc_files()
        self.assertTrue(any(p.name == 'BUILDING.md' for p in files), 'docs/BUILDING.md is not being checked')
        bad = []
        for p in files:
            for n, line in doc_offences(p.read_text(errors='replace')):
                bad.append(f'{p.relative_to(ROOT)}:{n}: {line}')
        self.assertEqual(bad, [], '\nwrite these as `bash ./x.sh` or `python3 ./x.py` '
                         '(or name the script without ./):\n  ' + '\n  '.join(bad))

    def test_every_build_script_parses(self):
        for p in build_scripts():
            with self.subTest(script=str(p.relative_to(ROOT))):
                r = subprocess.run(['bash', '-n', str(p)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == '__main__':
    unittest.main()
