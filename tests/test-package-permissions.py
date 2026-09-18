#!/usr/bin/env python3
"""Regression: public web staging and DEB modes must not depend on umask.

The staged frontend moved in 1.7.5 -- from ./web, shipped beside the binary, to
internal/webui/assets, compiled into it. The permission rule did not move with
it: those files still become world-readable release assets, because they are
served to a browser out of a package installed root-owned. So the assertions
below are unchanged and only the path is.

The second test also drops web/ from its fake payload, because a payload that
contains one is now the abnormal shape -- see payload.manifest.
"""
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
                out = root / 'internal/webui/assets'
                self.assertTrue((out / 'chat.html').is_file(), 'stage-web.sh produced no chat.html')
                for f in [out, *out.rglob('*')]:
                    self.assertEqual(f.stat().st_mode & 0o777, 0o755 if f.is_dir() else 0o644, str(f))
                # The keep-file must survive staging, or `go:embed all:assets`
                # stops compiling in a tree that has been cleaned.
                self.assertTrue((out / '.gitkeep').is_file(),
                                'staging removed the .gitkeep the embed needs')

    def test_deb_staging_repairs_private_ancestors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'DEBIAN').mkdir()
            (root / 'DEBIAN/control').write_text('Package: gobbonet\n')
            app = root / 'usr/lib/gobbonet'
            app.mkdir(parents=True)
            (app / 'llama-cpp').mkdir()
            for name in ('gobbonet', 'gobbonet-launch', 'llama-cpp/llama-server'):
                (app / name).write_text('#!/bin/sh\n')
                (app / name).chmod(0o755)
            for d in root.rglob('*'):
                if d.is_dir():
                    d.chmod(0o700)
            (app / 'models.ini').write_text('[models]\n')
            (app / 'models.ini').chmod(0o600)
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
