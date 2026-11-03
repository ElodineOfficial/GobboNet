#!/usr/bin/env python3
"""The Add a Model window's buckets travel from launch.bat to the window.

Roadmap 1.7.7: each model is tagged coding, roleplay and/or
jack-of-all-trades. launch.bat stays the single source of truth for the model
set, so the tags sit beside each download block as MODEL_TAGS, the way
DL_SHA256 does; catalog/gen-catalog.py carries them into models.ini, and the
Go catalogue reads them from there (internal/catalog/buckets.go).

Held here:
  - every model in launch.bat has a MODEL_TAGS made only of buckets;
  - the generator and the Go code agree on what the buckets are;
  - the committed models.ini (and its linux-amd64 copy) is what the generator
    writes today, tags included -- nobody hand-edited one side;
  - a misspelled bucket stops the generator instead of quietly dropping a
    model from its bucket.

See docs/changelog/CHANGELOG-1.7.7-catalog-filters.md.
"""
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / 'catalog' / 'gen-catalog.py'
BUCKETS_GO = ROOT / 'internal' / 'catalog' / 'buckets.go'


def go_buckets():
    m = re.search(r'var Buckets = \[\]string\{([^}]*)\}', BUCKETS_GO.read_text())
    return tuple(re.findall(r'"([^"]+)"', m.group(1)))


def gen_buckets():
    m = re.search(r'^BUCKETS = \(([^)]*)\)', GEN.read_text(), re.M)
    return tuple(re.findall(r'"([^"]+)"', m.group(1)))


def generate(launch_dir):
    # The output always goes to a temporary folder, never beside launch.bat:
    # for the real tree that would be the repository root.
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'models.ini'
        p = subprocess.run([sys.executable, str(GEN), str(Path(launch_dir) / 'launch.bat'), str(out)],
                           capture_output=True, text=True)
        return p, (out.read_bytes() if out.exists() else b'')


class CatalogBuckets(unittest.TestCase):
    def test_every_model_in_launch_bat_is_tagged(self):
        text = (ROOT / 'launch.bat').read_text(encoding='ascii')
        blocks = re.findall(r'if "!MODEL_CHOICE!"=="(\d+)" \((.*?)^\)', text, re.S | re.M)
        self.assertEqual(len(blocks), 16)
        for idx, body in blocks:
            m = re.search(r'set "MODEL_TAGS=([^"]*)"', body)
            self.assertIsNotNone(m, 'choice %s has no MODEL_TAGS' % idx)
            for tag in m.group(1).split(','):
                self.assertIn(tag, go_buckets(), 'choice %s: %r is not a bucket' % (idx, tag))

    def test_generator_and_go_agree_on_the_buckets(self):
        self.assertEqual(gen_buckets(), go_buckets())
        self.assertEqual(go_buckets(), ('coding', 'roleplay', 'jack-of-all-trades'))

    def test_committed_models_ini_is_the_generators_output(self):
        p, out = generate(ROOT)
        self.assertEqual(p.returncode, 0, p.stderr)
        committed = (ROOT / 'catalog' / 'models.ini').read_bytes()
        self.assertEqual(out, committed, 'catalog/models.ini is stale: re-run gen-catalog.py')
        self.assertEqual((ROOT / 'linux-amd64' / 'models.ini').read_bytes(), committed,
                         'linux-amd64/models.ini is not a copy of catalog/models.ini')
        self.assertEqual(committed.count(b'\r\ntags='), 16)

    def test_a_misspelled_bucket_stops_the_generator(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ('launch.bat', 'hw-recommend.ps1'):
                shutil.copy(ROOT / name, Path(d) / name)
            bat = Path(d) / 'launch.bat'
            bat.write_bytes(bat.read_bytes().replace(b'set "MODEL_TAGS=roleplay"', b'set "MODEL_TAGS=rolepaly"', 1))
            p, _ = generate(d)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('rolepaly, which is not a bucket', p.stderr)

    def test_a_model_with_no_tags_is_only_warned_about(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ('launch.bat', 'hw-recommend.ps1'):
                shutil.copy(ROOT / name, Path(d) / name)
            bat = Path(d) / 'launch.bat'
            bat.write_bytes(re.sub(rb'\r\n *set "MODEL_TAGS=coding"\r\n', b'\r\n', bat.read_bytes(), count=1))
            p, out = generate(d)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn('has no MODEL_TAGS, so it only shows under ALL MODELS', p.stderr)
            self.assertEqual(out.count(b'\r\ntags='), 15)


if __name__ == '__main__':
    unittest.main()
