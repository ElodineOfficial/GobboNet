#!/usr/bin/env python3
"""Regression: public web staging and DEB modes must not depend on umask."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class PackagePermissions(unittest.TestCase):
    def test_web_staging_under_both_umasks(self):
        for mask in (0o022, 0o077):
            with self.subTest(umask=oct(mask)), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                for name in ('stage-web.sh', 'chat.html', 'default-characters.json', 'gobbonet.ico'):
                    shutil.copyfile(ROOT / name, root / name)
                for name in ('js', 'css'):
                    shutil.copytree(ROOT / name, root / name)
                # Private source assets must still become public release assets.
                for f in root.rglob('*'):
                    f.chmod(0o700 if f.is_dir() else 0o600)
                subprocess.run(['bash', str(root / 'stage-web.sh')], check=True, umask=mask)
                for f in [root / 'web', *(root / 'web').rglob('*')]:
                    self.assertEqual(f.stat().st_mode & 0o777, 0o755 if f.is_dir() else 0o644, str(f))

    def test_deb_staging_repairs_private_ancestors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'DEBIAN').mkdir()
            (root / 'DEBIAN/control').write_text('Package: gobbonet\n')
            app = root / 'usr/lib/gobbonet'
            (app / 'web/css').mkdir(parents=True)
            (app / 'llama-cpp').mkdir()
            (app / 'web/chat.html').write_text('test')
            (app / 'web/css/test.css').write_text('test')
            for name in ('gobbonet', 'gobbonet-launch', 'llama-cpp/llama-server'):
                (app / name).write_text('#!/bin/sh\n')
                (app / name).chmod(0o755)
            for d in root.rglob('*'):
                if d.is_dir():
                    d.chmod(0o700)
            (app / 'web/chat.html').chmod(0o600)
            subprocess.run(['bash', str(ROOT / 'installer-linux/package-permissions.sh'), str(root)], check=True, umask=0o077)
            for d in (root / 'usr').rglob('*'):
                self.assertTrue(d.stat().st_mode & 0o004, str(d))
                if d.is_dir():
                    self.assertEqual(d.stat().st_mode & 0o777, 0o755)
            # A missing launcher must prevent release.
            (app / 'gobbonet-launch').unlink()
            result = subprocess.run(['bash', str(ROOT / 'installer-linux/package-permissions.sh'), str(root)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main()
