#!/usr/bin/env python3
"""Mixture-of-Experts models are offered to 8-12 GB cards (issue #65).

PR #66 measured the three MoE models in the catalogue on an 8 GB RTX 4070
Laptop with 32 GB of RAM at over 20 tokens a second, once automatic placement
left room on the card. The menu still marked all three "needs ~N GB VRAM - will
be slow" there, because the only rule it knew was "the whole model fits on the
card". Now a MoE model carries a second rule beside its min_vram: it also fits
a card of MOE_MIN_VRAM GB when system RAM covers its min_ram.

The figures live twice on Windows, like the VRAM gate does -- $moeVram /
$moeRam in hw-recommend.ps1 for the menu, MOE_MIN_VRAM / PICK_MOE_RAM in
launch.bat for the download warning -- and gen-catalog.py carries them into
models.ini for the Linux wizard and the Add a Model window.

Held here:
  A. the generator writes the allowance for the three MoE models and no other,
     and refuses to build when the two Windows tables disagree;
  B. hw-recommend.ps1, run for real under pwsh against a stand-in
     hardware.json, marks the menu by both rules, and the recommendation is
     unchanged (skipped without pwsh: set GOBBONET_TEST_PWSH);
  C. launch.bat skips the heads-up warning only when the MoE rule holds, says
     what would make the model fit when it does not, and stays CRLF.

See docs/changelog/CHANGELOG-1.7.8-moe-small-cards.md.
"""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / 'catalog' / 'gen-catalog.py'
PWSH = os.environ.get('GOBBONET_TEST_PWSH') or shutil.which('pwsh')

MOE = {5: 24, 6: 32, 8: 16, 17: 24}   # slot -> system RAM, beside an 8 GB card
FITS = '[ fits: MoE, uses system RAM ]'


def generate(launch_dir):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'models.ini'
        p = subprocess.run([sys.executable, str(GEN), str(Path(launch_dir) / 'launch.bat'), str(out)],
                           capture_output=True, text=True)
        return p, (out.read_text(encoding='ascii') if out.exists() else '')


def sections(ini):
    out, cur = {}, None
    for line in ini.splitlines():
        m = re.match(r'\[(\d+)\]$', line.strip())
        if m:
            cur = out.setdefault(int(m.group(1)), {})
        elif cur is not None and '=' in line:
            k, v = line.strip().split('=', 1)
            cur[k] = v
    return out


def with_edit(name, old, new):
    """A copy of launch.bat and hw-recommend.ps1 with one edit made to one."""
    d = tempfile.mkdtemp()
    for f in ('launch.bat', 'hw-recommend.ps1'):
        shutil.copy(ROOT / f, Path(d) / f)
    p = Path(d) / name
    data = p.read_bytes()
    assert old.encode() in data, 'anchor %r not in %s' % (old, name)
    p.write_bytes(data.replace(old.encode(), new.encode(), 1))
    return d


class Generator(unittest.TestCase):
    def test_allowance_is_written_for_the_moe_models_only(self):
        p, ini = generate(ROOT)
        self.assertEqual(p.returncode, 0, p.stderr)
        got = {i: (int(s['moe_min_vram']), int(s['min_ram']))
               for i, s in sections(ini).items() if 'moe_min_vram' in s}
        self.assertEqual(got, {i: (8, ram) for i, ram in MOE.items()})
        for i, s in sections(ini).items():
            self.assertEqual('moe_min_vram' in s, 'min_ram' in s, 'slot %d has half an allowance' % i)
        # The whole-model figure is unchanged: it is still what the card needs
        # without help from system RAM.
        self.assertEqual({i: int(sections(ini)[i]['min_vram']) for i in MOE}, {5: 18, 6: 24, 8: 14, 17: 22})

    def test_committed_catalogues_carry_it(self):
        for rel in ('catalog/models.ini', 'linux-amd64/models.ini'):
            secs = sections((ROOT / rel).read_text(encoding='ascii'))
            got = {i: int(s['min_ram']) for i, s in secs.items() if 'min_ram' in s}
            self.assertEqual(got, MOE, rel)

    def test_a_ram_figure_that_drifts_stops_the_generator(self):
        d = with_edit('launch.bat', 'set "PICK_MOE_RAM=32"', 'set "PICK_MOE_RAM=48"')
        p, _ = generate(d)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('PICK_MOE_RAM', p.stderr)

    def test_a_card_size_that_drifts_stops_the_generator(self):
        d = with_edit('hw-recommend.ps1', '$moeVram = 8', '$moeVram = 6')
        p, _ = generate(d)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('MOE_MIN_VRAM', p.stderr)

    def test_a_model_on_one_side_only_stops_the_generator(self):
        d = with_edit('hw-recommend.ps1', '    8 = 16     # gpt-oss 20B', '    # 8 = 16     # gpt-oss 20B')
        p, _ = generate(d)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('disagree', p.stderr)

    def test_a_missing_table_stops_the_generator(self):
        d = with_edit('launch.bat', 'set "MOE_MIN_VRAM=8"', 'set "MOE_CARD=8"')
        p, _ = generate(d)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('MoE allowance', p.stderr)


@unittest.skipUnless(PWSH, 'no pwsh: set GOBBONET_TEST_PWSH to a PowerShell 7 binary')
class Menu(unittest.TestCase):
    def menu(self, vram, ram, tier='gpu'):
        with tempfile.TemporaryDirectory() as d:
            shutil.copy(ROOT / 'hw-recommend.ps1', Path(d) / 'hw-recommend.ps1')
            (Path(d) / 'hardware.json').write_text(json.dumps({
                'gpu': {'vram_gb': vram}, 'recommended_tier': tier,
                'ram_gb': ram, 'disk': {'free_gb': 500}}))
            p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(Path(d) / 'hw-recommend.ps1')],
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stderr)
        kv = dict(l.split('=', 1) for l in p.stdout.splitlines() if '=' in l)
        return int(kv['REC']), {i: kv['MK_%d' % i] for i in list(range(1, 11)) + list(range(12, 18))}

    def test_8gb_card_with_32gb_ram_is_offered_all_three(self):
        rec, mk = self.menu(8, 32)
        self.assertEqual(rec, 1, 'the recommendation is unchanged')
        self.assertEqual({i for i, m in mk.items() if m == FITS}, {5, 6, 8, 17})
        self.assertEqual(mk[7], '[ needs ~11 GB VRAM - will be slow ]', 'a dense model is not')
        self.assertEqual(mk[10], '[ needs ~24 GB VRAM - will be slow ]', 'nor is the 35B dense one')

    def test_ram_decides_which(self):
        for ram, fits in ((16, {8}), (24, {5, 8, 17}), (31, {5, 8, 17}), (32, {5, 6, 8, 17})):
            rec, mk = self.menu(8, ram)
            self.assertEqual(rec, 1)
            self.assertEqual({i for i, m in mk.items() if m == FITS}, fits, '%d GB RAM' % ram)
            for i in set(MOE) - fits:
                self.assertTrue(mk[i].startswith('[ needs ~'), '%d GB RAM, slot %d: %r' % (ram, i, mk[i]))

    def test_12gb_card(self):
        rec, mk = self.menu(12, 32)
        self.assertEqual(rec, 4, 'the recommendation is unchanged')
        self.assertEqual({i for i, m in mk.items() if m == FITS}, {5, 6, 8, 17})

    def test_below_8gb_nothing_changes(self):
        rec, mk = self.menu(6, 64)
        self.assertEqual(rec, 2)
        self.assertFalse(any(m == FITS for m in mk.values()))

    def test_a_card_that_holds_the_whole_model_says_nothing(self):
        rec, mk = self.menu(24, 16)
        self.assertEqual(rec, 5)
        self.assertEqual(mk[6], '', 'Qwen3.6 fits a 24 GB card outright')
        self.assertEqual(mk[8], '')
        self.assertEqual(mk[17], '', 'and so does Qwen3-Coder (22 GB)')

    def test_no_gpu_still_says_too_slow(self):
        rec, mk = self.menu(0, 64, tier='cpu_only')
        self.assertEqual(rec, 2)
        for i in MOE:
            self.assertEqual(mk[i], '[ likely too slow without a GPU ]')

    def test_ram_unknown_confirms_nothing(self):
        rec, mk = self.menu(8, 0)
        self.assertFalse(any(m == FITS for m in mk.values()))


class LaunchBat(unittest.TestCase):
    RAW = (ROOT / 'launch.bat').read_bytes()
    SRC = RAW.decode('ascii')

    def test_still_crlf(self):
        self.assertEqual(self.RAW.count(b'\n'), self.RAW.count(b'\r\n'), 'a bare LF crept into launch.bat')

    def test_the_moe_rule_is_the_only_thing_that_clears_the_gate(self):
        clear = re.findall(r'^if [^\r\n]*set "PICK_MIN=0"', self.SRC, re.M)
        self.assertEqual(clear, ['if !PICK_MOE_RAM! gtr 0 if !HW_VRAM! geq !MOE_MIN_VRAM! '
                                 'if !HW_RAM! geq !PICK_MOE_RAM! set "PICK_MIN=0"'])
        gate = self.SRC.index('if !HW_VRAM! gtr 0 if !PICK_MIN! gtr 0 if !HW_VRAM! lss !PICK_MIN! (')
        self.assertLess(self.SRC.index(clear[0]), gate, 'the MoE rule runs before the warning')
        self.assertLess(self.SRC.index('if not defined HW_RAM set "HW_RAM=0"'), self.SRC.index(clear[0]),
                        'an unset HW_RAM reads as 0, not as a syntax error')

    def test_the_warning_says_what_would_make_it_fit(self):
        gate = self.SRC.index('if !HW_VRAM! gtr 0 if !PICK_MIN! gtr 0 if !HW_VRAM! lss !PICK_MIN! (')
        block = self.SRC[gate:self.SRC.index('call :prompt_yn "  Download it anyway?" GO_BIG', gate)]
        self.assertIn('if !PICK_MOE_RAM! gtr 0 (', block)
        self.assertIn('!MOE_MIN_VRAM! GB also runs it well beside !PICK_MOE_RAM! GB of', block)
        self.assertIn('This PC reports !HW_RAM! GB of RAM.', block)
        # Inside a ( ) block an unescaped parenthesis in an echo closes the
        # block early, and %VAR% is expanded once for the whole block.
        for line in block.splitlines()[1:]:
            if line.strip().startswith('echo'):
                self.assertNotRegex(line, r'[()]', line)
                self.assertNotIn('%', line, line)


if __name__ == '__main__':
    unittest.main(verbosity=2)
