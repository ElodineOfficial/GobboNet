"""
catalog/pin-hashes.py (1.7.9, F2), run offline: GOBBONET_PIN_FIXTURE stands in
for HuggingFace's LFS pointers. Works on a copy of launch.bat, hw-recommend.ps1
and catalog/ in a temporary folder; the real tree is never written.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCK = re.compile(r'if\s+"!MODEL_CHOICE!"=="(\d+)"\s*\((.*?)^\)', re.S | re.M)
FIELD = re.compile(r'set\s+"([A-Z0-9_]+)=([^"]*)"')
SIZE = re.compile(r'echo\s+\[\s*(\d+)\]\s+.*?~\s*([0-9.]+)\s*GB')


def entries(bat_text):
    out = {}
    for idx, body in BLOCK.findall(bat_text):
        f = dict(FIELD.findall(body))
        out[int(idx)] = f
    return out


def fake_sha(idx):
    return hashlib.sha256(b'model %d' % idx).hexdigest()


def pointer(sha, size):
    return "version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n" % (sha, size)


class PinHashes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        for name in ('launch.bat', 'hw-recommend.ps1'):
            shutil.copy(ROOT / name, self.tmp / name)
        shutil.copytree(ROOT / 'catalog', self.tmp / 'catalog')
        (self.tmp / 'linux-amd64').mkdir()
        shutil.copy(ROOT / 'catalog' / 'models.ini', self.tmp / 'linux-amd64' / 'models.ini')
        text = (self.tmp / 'launch.bat').read_text(encoding='ascii')
        self.models = entries(text)
        self.sizes = {int(i): float(gb) for i, gb in SIZE.findall(text)}
        self.table = {}
        for idx, f in self.models.items():
            sha = f.get('DL_SHA256') or fake_sha(idx)
            self.table['https://huggingface.co/%s/raw/main/%s' % (f['DL_REPO'], f['DL_FILE'])] = \
                pointer(sha, int(self.sizes[idx] * 1e9))

    def run_tool(self, *args, table=None):
        fx = self.tmp / 'fixture.json'
        fx.write_text(json.dumps(self.table if table is None else table))
        env = dict(os.environ, GOBBONET_PIN_FIXTURE=str(fx))
        return subprocess.run([sys.executable, str(self.tmp / 'catalog' / 'pin-hashes.py'), *args],
                              capture_output=True, text=True, env=env, timeout=120)

    def test_check_reports_and_changes_nothing(self):
        before = (self.tmp / 'launch.bat').read_bytes()
        p = self.run_tool('--check')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(p.stdout.count('  ok '), 2, p.stdout)          # the two pinned by hand
        self.assertEqual(p.stdout.count('unpinned'), len(self.models) - 2)
        self.assertEqual((self.tmp / 'launch.bat').read_bytes(), before)

    def test_pins_everything_then_has_nothing_to_do(self):
        p = self.run_tool()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        raw = (self.tmp / 'launch.bat').read_bytes()
        self.assertEqual(raw.count(b'\n'), raw.count(b'\r\n'), 'launch.bat stays CRLF')
        pinned = entries(raw.decode('ascii').replace('\r\n', '\n'))
        for idx, f in pinned.items():
            want = self.models[idx].get('DL_SHA256') or fake_sha(idx)
            self.assertEqual(f.get('DL_SHA256'), want, 'choice %d' % idx)
        self.assertRegex(raw.decode('ascii'), r'set "DL_FILE=Llama-3\.2-1B-Instruct-Q8_0\.gguf"\r\n    set "DL_SHA256=[0-9a-f]{64}"\r\n',
                         'the pin goes on the line after DL_FILE, indented to match')
        ini = (self.tmp / 'catalog' / 'models.ini').read_bytes()
        self.assertEqual(len(re.findall(rb'\r\nsha256=[0-9a-f]{64}\r\n', ini)), len(self.models), 'models.ini regenerated with every pin')
        self.assertEqual((self.tmp / 'linux-amd64' / 'models.ini').read_bytes(), ini, 'and its linux-amd64 copy follows')
        again = self.run_tool()
        self.assertEqual(again.returncode, 0)
        self.assertIn('nothing to pin', again.stdout)

    def test_a_pin_that_no_longer_matches_is_reported(self):
        table = dict(self.table)
        nemo = self.models[13]
        table['https://huggingface.co/%s/raw/main/%s' % (nemo['DL_REPO'], nemo['DL_FILE'])] = pointer('0' * 64, int(7.5e9))
        p = self.run_tool('--check', table=table)
        self.assertEqual(p.returncode, 1)
        self.assertIn('[13] Mistral Nemo 12B (2407): the pinned hash 7c1a10d2', p.stdout)
        self.assertIn('does not match', p.stdout)

    def test_a_wrong_repo_or_file_is_caught(self):
        table = dict(self.table)
        tiny = self.models[12]
        table['https://huggingface.co/%s/raw/main/%s' % (tiny['DL_REPO'], tiny['DL_FILE'])] = None
        phi = self.models[14]
        table['https://huggingface.co/%s/raw/main/%s' % (phi['DL_REPO'], phi['DL_FILE'])] = pointer(fake_sha(14), int(30e9))
        p = self.run_tool(table=table)
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn('[12] Llama 3.2 1B Instruct', p.stdout)
        self.assertIn('answered 404', p.stdout)
        self.assertIn('[14] Phi-4 14B: the file is 30.00 GB but the menu says ~9.1 GB', p.stdout)
        text = (self.tmp / 'launch.bat').read_text(encoding='ascii')
        self.assertIsNone(entries(text)[12].get('DL_SHA256'), 'a 404 is never pinned')

    def test_the_live_list_carries_the_pins(self):
        self.run_tool()
        out = self.tmp / 'live.json'
        p = subprocess.run([sys.executable, str(self.tmp / 'catalog' / 'gen-remote-catalog.py'),
                            str(self.tmp / 'catalog' / 'models.ini'), str(out)], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        doc = json.loads(out.read_text())
        self.assertEqual(len(doc['models']), len(self.models))
        self.assertTrue(all(m['sha256'] and len(m['sha256']) == 64 for m in doc['models']))
        self.assertEqual({m['index']: m['tier'] for m in doc['models'] if m['tier'] == 'moe'}, {5: 'moe', 6: 'moe', 8: 'moe', 17: 'moe'})


class Committed(unittest.TestCase):
    def test_the_committed_live_list_matches_models_ini(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'live.json'
            subprocess.run([sys.executable, str(ROOT / 'catalog' / 'gen-remote-catalog.py'),
                            str(ROOT / 'catalog' / 'models.ini'), str(out)], check=True, capture_output=True)
            fresh = json.loads(out.read_text())
        committed = json.loads((ROOT / 'catalog' / 'gobbonet_model_list.json').read_text())
        fresh.pop('generated'); committed.pop('generated')
        self.assertEqual(committed, fresh, 'catalog/gobbonet_model_list.json is stale: re-run gen-remote-catalog.py')


if __name__ == '__main__':
    unittest.main()
