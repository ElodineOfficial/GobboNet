#!/usr/bin/env python3
"""installer-win/stage-payload.sh stages exactly what gobbonet.nsi installs.

The 1.7.8 installer was built by staging the payload from the release ZIP, so
the files in the installer are the files in the ZIP beside it. The script
reads its file list from gobbonet.nsi's File "${APPSRC}\\..." lines, so this
runs it against the repo with a stand-in gobbonet.exe and checks:

  - every file the script installs is staged, from where README.md says
    (PURGE.md from docs/, models.ini from catalog/), byte for byte;
  - nothing else is staged;
  - with no gobbonet.exe it refuses, rather than staging a payload without the
    server.

It does not run makensis. See docs/changelog/CHANGELOG-1.7.8-windows-installer-build.md.
"""
from pathlib import Path
import filecmp
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NSI = (ROOT / 'installer-win' / 'gobbonet.nsi').read_text(encoding='utf-8', errors='replace')
SOURCES = {'PURGE.md': 'docs/PURGE.md', 'models.ini': 'catalog/models.ini'}


def installed():
    """Every payload file gobbonet.nsi installs, wildcards expanded."""
    out = set()
    for rel in re.findall(r'File (?:/oname=\S+ )?"\$\{APPSRC\}\\([^"]+)"', NSI):
        rel = rel.replace('\\', '/')
        if '*' in rel:
            out |= {str(p.relative_to(ROOT)) for p in ROOT.glob(rel)}
        else:
            out.add(rel)
    return out


@unittest.skipIf(shutil.which('bash') is None, 'needs bash')
class Staging(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        shutil.copytree(ROOT / 'installer-win', self.tmp / 'installer-win', ignore=shutil.ignore_patterns('*.exe'))
        # A source tree shaped like the repo (or the unpacked ZIP), holding just
        # the files the installer takes, from where they live in the tree.
        self.src = self.tmp / 'src'
        for rel in installed() - {'gobbonet.exe'}:
            frm = SOURCES.get(rel, rel)
            (self.src / frm).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / frm, self.src / frm)
        (self.src / 'gobbonet.exe').write_bytes(b'MZ stand-in')

    def stage(self):
        return subprocess.run(['bash', str(self.tmp / 'installer-win' / 'stage-payload.sh'), str(self.src)],
                              capture_output=True, text=True)

    def test_stages_exactly_what_the_script_installs(self):
        r = self.stage()
        self.assertEqual(r.returncode, 0, r.stderr)
        staged = {str(p.relative_to(self.tmp / 'staging')) for p in (self.tmp / 'staging').rglob('*') if p.is_file()}
        want = installed()
        self.assertEqual(staged, want, 'staged files differ from the File list in gobbonet.nsi')
        for rel in want:
            src = self.src / SOURCES.get(rel, rel)
            self.assertTrue(filecmp.cmp(src, self.tmp / 'staging' / rel, shallow=False), rel)
        for must in ('gobbonet.exe', 'launch.bat', 'engine.sha256', 'models.ini', 'PURGE.md', 'stop-gobbonet.bat'):
            self.assertIn(must, staged)

    def test_refuses_without_the_server(self):
        (self.src / 'gobbonet.exe').unlink()
        r = self.stage()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('no gobbonet.exe', r.stderr)
        self.assertFalse((self.tmp / 'staging').exists())

    def test_readme_names_the_toolchain_and_the_script(self):
        readme = (ROOT / 'installer-win' / 'README.md').read_text(encoding='utf-8')
        self.assertIn('stage-payload.sh', readme)
        self.assertIn('3.12', readme)
        self.assertIn('NSIS_MAX_STRLEN=8192', readme)


if __name__ == '__main__':
    unittest.main()
