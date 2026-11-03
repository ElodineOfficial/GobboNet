#!/usr/bin/env python3
"""The Linux ZIP's `./gobbonet` is the launcher, not the bare server.

LINUX-START-HERE.md tells ZIP users to run `./gobbonet` and describes the
launcher's first run: a setup page in the browser, then the chat, with
launch.log as the place to look when something goes wrong. The packages'
`gobbonet` command IS the launcher (build-deb.sh links /usr/bin/gobbonet to
it). The ZIP, though, carried a copy of the server binary at that path -- and a
first run printed "review config.toml, then run gobbonet again" and stopped.

Worse, make-zip.sh never built that file. It required it and copied whatever
`gobbonet` was lying in the tree, of any age, and its stamp check only ever
looked at linux-amd64/gobbonet.

Now the top-level `gobbonet` is installer-linux/gobbonet-zip-entry: a short
script that hands over to linux-amd64/gobbonet-launch. This file pins what it
must do and that make-zip.sh ships it. The full first run through it is
tests/test-linux-onboarding.py with GOBBONET_TEST_ENTRY pointed at an extracted
ZIP's ./gobbonet.

Roadmap 1.7.7 item #14; see docs/changelog/CHANGELOG-1.7.7-zip-launcher.md.
"""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'installer-linux' / 'gobbonet-zip-entry'

# Stands in for linux-amd64/gobbonet-launch: records how it was started.
STUB = '#!/usr/bin/env bash\nprintf "%s\\n" "$0" "$@" > "$STUB_LOG"\n'


def make_zip_tree(tmp, launcher_mode=0o755, entry_mode=0o755):
    """A GobboNet folder as the ZIP extracts: ./gobbonet + linux-amd64/."""
    top = Path(tmp) / 'Gobbo Net'          # a space, as real paths have
    (top / 'linux-amd64').mkdir(parents=True)
    shutil.copyfile(ENTRY, top / 'gobbonet')
    (top / 'gobbonet').chmod(entry_mode)
    launcher = top / 'linux-amd64' / 'gobbonet-launch'
    launcher.write_text(STUB)
    launcher.chmod(launcher_mode)
    return top


def run(cmd, log):
    env = dict(os.environ, STUB_LOG=str(log))
    return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=20)


class ZipEntry(unittest.TestCase):
    def test_hands_over_to_the_launcher_with_every_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            top = make_zip_tree(tmp)
            log = Path(tmp) / 'stub.log'
            r = run([str(top / 'gobbonet'), 'config', 'set', 'listen_port', 'two words'], log)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = log.read_text().splitlines()
            self.assertEqual(Path(got[0]).resolve(), (top / 'linux-amd64' / 'gobbonet-launch').resolve(),
                             'the launcher must be run from the folder beside the entry')
            self.assertEqual(got[1:], ['config', 'set', 'listen_port', 'two words'],
                             'arguments must arrive untouched, spaces included')

    def test_no_arguments_reaches_the_launcher_too(self):
        # The case that matters most: a first run is `./gobbonet` on its own,
        # and the launcher's no-argument path is the one that opens setup.
        with tempfile.TemporaryDirectory() as tmp:
            top = make_zip_tree(tmp)
            log = Path(tmp) / 'stub.log'
            r = run([str(top / 'gobbonet')], log)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(len(log.read_text().splitlines()), 1, 'no arguments should be invented')

    def test_does_not_need_the_launchers_executable_bit(self):
        with tempfile.TemporaryDirectory() as tmp:
            top = make_zip_tree(tmp, launcher_mode=0o644)
            log = Path(tmp) / 'stub.log'
            r = run([str(top / 'gobbonet'), 'version'], log)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('version', log.read_text())

    def test_works_through_a_symlink_from_elsewhere(self):
        # Someone links ./gobbonet into ~/bin. The launcher must still be found
        # beside the real file, not beside the link.
        with tempfile.TemporaryDirectory() as tmp:
            top = make_zip_tree(tmp)
            bindir = Path(tmp) / 'bin'
            bindir.mkdir()
            (bindir / 'gobbonet').symlink_to(top / 'gobbonet')
            log = Path(tmp) / 'stub.log'
            r = run([str(bindir / 'gobbonet'), 'doctor'], log)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(Path(log.read_text().splitlines()[0]).resolve(),
                             (top / 'linux-amd64' / 'gobbonet-launch').resolve())

    def test_a_missing_launcher_says_what_to_do(self):
        with tempfile.TemporaryDirectory() as tmp:
            top = make_zip_tree(tmp)
            shutil.rmtree(top / 'linux-amd64')
            r = run([str(top / 'gobbonet')], Path(tmp) / 'stub.log')
            self.assertEqual(r.returncode, 1)
            self.assertIn('Keep the extracted GobboNet folder together', r.stderr)

    def test_the_entry_parses_and_is_a_script(self):
        self.assertTrue(ENTRY.read_text().startswith('#!/usr/bin/env bash\n'))
        r = subprocess.run(['bash', '-n', str(ENTRY)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_make_zip_ships_the_entry_and_never_a_leftover_binary(self):
        src = (ROOT / 'scripts' / 'make-zip.sh').read_text()
        loop = re.search(r'for rel in \\\n(.*?)\ndo\n', src, re.S)
        self.assertIsNotNone(loop, 'could not find the copy list in make-zip.sh')
        names = loop.group(1).replace('\\', ' ').split()
        self.assertNotIn('gobbonet', names,
                         'make-zip.sh copies a top-level `gobbonet` from the tree again -- '
                         'that is how a stale binary got into the archive')
        self.assertIn('gobbonet.exe', names)
        self.assertIn('ZIP_ENTRY="installer-linux/gobbonet-zip-entry"', src)
        self.assertIn('cp "$ZIP_ENTRY" "$TOP/gobbonet"', src)
        self.assertRegex(src, r'cmp -s "\$TOP/gobbonet" "\$ZIP_ENTRY"',
                         'make-zip.sh must check the shipped file is the entry, byte for byte')

    def test_make_zip_carries_the_contributors_file(self):
        # Found while checking the 1.7.7 archive: CONTRIBUTORS.md was never in
        # it. Release commits are made from the extracted archive, so a credit
        # added to that file -- larckdrakengold's, for 1.7.7 #2 -- would never
        # have reached the repository.
        src = (ROOT / 'scripts' / 'make-zip.sh').read_text()
        loop = re.search(r'for rel in \\\n(.*?)\ndo\n', src, re.S)
        names = loop.group(1).replace('\\', ' ').split()
        self.assertIn('CONTRIBUTORS.md', names)


if __name__ == '__main__':
    unittest.main()
