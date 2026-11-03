"""
catalog/gen-mod-list.py (1.7.9, F6): builds the endorsed-mods list from a
folder of mod folders, pinning every file by SHA-256. Run on copies in a
temporary folder; the real tree is never written. The shipped sample list
(docs/mods-example) must match the example mod it was made from, and
internal/mods/endorsed_test.go reads the same sample with the Go parser.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / 'catalog' / 'gen-mod-list.py'
EXAMPLE = ROOT / 'docs' / 'mods-example'
BASE = 'https://goblincorps.com/gobbonet_mods'


def run(*args):
    return subprocess.run([sys.executable, str(GEN), *map(str, args)], capture_output=True, text=True)


class GenModList(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.mods = self.tmp / 'mods'
        shutil.copytree(EXAMPLE / 'hello-gobbo', self.mods / 'hello-gobbo')
        self.out = self.tmp / 'list.json'

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def mod(self, name, manifest, files):
        d = self.mods / name
        d.mkdir(parents=True)
        (d / 'mod.json').write_text(json.dumps(manifest))
        for p, body in files.items():
            (d / p).parent.mkdir(parents=True, exist_ok=True)
            (d / p).write_text(body)

    def test_pins_every_file_and_keeps_the_fields(self):
        self.mod('spicy', {'name': 'Spicy', 'version': '2', 'adult': True, 'min_client': '1.7.9', 'files': ['a/b.css']}, {'a/b.css': 'p{}'})
        r = run(self.mods, '--base-url', BASE + '/', '--js-as-txt', '--out', self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        lst = json.loads(self.out.read_text())
        self.assertEqual(lst['schema_version'], 1)
        self.assertEqual([m['id'] for m in lst['mods']], ['hello-gobbo', 'spicy'])
        hello, spicy = lst['mods']
        for f in hello['files']:
            body = (self.mods / 'hello-gobbo' / f['path']).read_bytes()
            self.assertEqual(f['sha256'], hashlib.sha256(body).hexdigest())
            self.assertEqual(f['size'], len(body))
        js = [f for f in hello['files'] if f['path'] == 'hello.js'][0]
        self.assertEqual(js['url'], BASE + '/hello-gobbo/hello.js.txt', 'a script is served as .txt, saved as .js')
        self.assertTrue(spicy['adult'])
        self.assertEqual(spicy['min_client'], '1.7.9')
        self.assertEqual(spicy['files'][0]['url'], BASE + '/spicy/a/b.css')

    def test_check_catches_a_file_changed_after_the_list(self):
        self.assertEqual(run(self.mods, '--base-url', BASE, '--out', self.out).returncode, 0)
        self.assertEqual(run(self.mods, '--base-url', BASE, '--out', self.out, '--check').returncode, 0)
        (self.mods / 'hello-gobbo' / 'hello.js').write_text('window.changed=1')
        r = run(self.mods, '--base-url', BASE, '--out', self.out, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('does not match', r.stderr)

    def test_refuses_what_gobbonet_would_refuse(self):
        cases = {
            'Bad Name': ({'name': 'x', 'version': '1', 'files': ['a.css']}, {'a.css': ''}, 'id'),
            'escape': ({'name': 'x', 'version': '1', 'files': ['../hello-gobbo/hello.js']}, {}, 'plain path'),
            'exe': ({'name': 'x', 'version': '1', 'files': ['run.exe']}, {'run.exe': ''}, 'kind of file'),
            'noversion': ({'name': 'x', 'files': ['a.css']}, {'a.css': ''}, 'version'),
            'missing': ({'name': 'x', 'version': '1', 'files': ['gone.css']}, {}, 'missing'),
            'urlonly': ({'name': 'x', 'version': '1', 'files': [{'url': 'https://e/x.js'}]}, {}, 'URL entries'),
        }
        for name, (man, files, why) in cases.items():
            with self.subTest(name):
                shutil.rmtree(self.mods)
                self.mods.mkdir()
                self.mod(name, man, files)
                r = run(self.mods, '--base-url', BASE, '--out', self.out)
                self.assertEqual(r.returncode, 1, name)
                self.assertIn(why, r.stderr)
        self.assertEqual(run(self.mods, '--base-url', 'http://plain', '--out', self.out).returncode, 1)

    def test_the_shipped_sample_matches_the_example(self):
        r = run(EXAMPLE, '--base-url', BASE, '--js-as-txt', '--out', EXAMPLE / 'gobbonet_mod_list.sample.json', '--check')
        self.assertEqual(r.returncode, 0, r.stderr + ' -- regenerate docs/mods-example/gobbonet_mod_list.sample.json')


if __name__ == '__main__':
    unittest.main()
