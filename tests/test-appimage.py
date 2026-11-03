#!/usr/bin/env python3
"""GobboNet as an AppImage, built from the .deb (issue #53).

installer-linux/build-appimage.sh unpacks the .deb into an AppDir, adds
AppRun, the menu entry and the icon, and joins a zstd squashfs of it to the
AppImage type 2 runtime, pinned by SHA-256 like the engine.

Held here, always:
  A. the runtime is pinned to a dated release by hash, an override without a
     hash is refused, and nothing embeds update information;
  B. AppRun hands over to the packages' own launcher;
  C. the launcher says so when python3 is missing, instead of failing the
     first run with a bare "command not found" in its log.

And with a real package (set GOBBONET_TEST_DEB to a gobbonet_*_amd64.deb, and
GOBBONET_TEST_APPIMAGE_RUNTIME to the pinned runtime file; skipped otherwise):
  D. the build runs, in a scratch copy of the tree, and its AppImage:
     - is the pinned runtime followed by the image, with no update address;
     - holds exactly the .deb's files, with /usr/bin/gobbonet made relative
       and no link pointing out of the image;
     - starts: `GobboNet.AppImage version` runs the program inside;
  E. a wrong runtime hash, or a .deb without the Vulkan engine, stops it.

The first run through the AppImage is tests/test-linux-onboarding.py with
GOBBONET_TEST_ENTRY set to the AppImage. See
docs/changelog/CHANGELOG-1.7.8-appimage.md.
"""
from pathlib import Path
import atexit
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LINUX = ROOT / 'installer-linux'
BUILD = LINUX / 'build-appimage.sh'
SRC = BUILD.read_text()
DEB = os.environ.get('GOBBONET_TEST_DEB', '')
RUNTIME = os.environ.get('GOBBONET_TEST_APPIMAGE_RUNTIME', '')
TAG = re.search(r'RUNTIME_TAG="\$\{APPIMAGE_RUNTIME_TAG:-(\w+)\}"', SRC).group(1)


def have_zstd_mksquashfs():
    if not shutil.which('mksquashfs'):
        return False
    with tempfile.TemporaryDirectory() as d:
        os.mkdir(d + '/x')
        return subprocess.run(['mksquashfs', d + '/x', d + '/p', '-comp', 'zstd', '-quiet'],
                              capture_output=True).returncode == 0


def scratch_tree(runtime=None):
    """A copy of just what build-appimage.sh reads, so a build here writes
    nothing into the real installer-linux/."""
    d = Path(tempfile.mkdtemp())
    atexit.register(shutil.rmtree, d, True)
    (d / 'scripts').mkdir()
    for name in ('verify-payload.sh', 'payload.manifest'):
        shutil.copy(ROOT / 'scripts' / name, d / 'scripts' / name)
    (d / 'installer-linux').mkdir()
    for name in ('build-appimage.sh', 'AppRun'):
        shutil.copy(LINUX / name, d / 'installer-linux' / name)
    if runtime:
        (d / 'installer-linux' / 'vendor').mkdir()
        shutil.copy(runtime, d / 'installer-linux' / 'vendor' / ('appimage-runtime-%s-x86_64' % TAG))
    return d


def build(tree, *args, env=None):
    e = dict(os.environ, SKIP_RUNTIME_FETCH='1')
    e.update(env or {})
    return subprocess.run(['bash', str(tree / 'installer-linux' / 'build-appimage.sh'), *args],
                          capture_output=True, text=True, env=e, timeout=600)


class Pins(unittest.TestCase):
    def test_runtime_is_pinned_to_a_dated_release_by_hash(self):
        self.assertRegex(TAG, r'^20\d{6}$', 'a dated tag, not "continuous"')
        self.assertRegex(SRC, r'APPIMAGE_RUNTIME_SHA256:-[0-9a-f]{64}\}')
        self.assertIn('releases/download/${RUNTIME_TAG}/runtime-x86_64', SRC)
        self.assertNotIn('continuous', re.sub(r'#.*', '', SRC))

    def test_an_override_tag_without_a_hash_is_refused(self):
        p = build(scratch_tree(), env={'APPIMAGE_RUNTIME_TAG': '20990101'})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('without APPIMAGE_RUNTIME_SHA256', p.stderr)

    def test_no_update_information_and_no_appimagetool(self):
        code = re.sub(r'#.*', '', SRC)
        self.assertNotRegex(code, r'appimagetool|zsyncmake|--updateinformation|\s-u\s')
        self.assertIn("'.upd_info'", SRC, 'the build checks the runtime carries none')
        self.assertIn('-comp zstd', SRC, 'the runtime reads only zlib and zstd images')

    def test_build_leftovers_are_ignored(self):
        self.assertIn('installer-linux/stage-appimage/', (ROOT / '.gitignore').read_text())


class AppRun(unittest.TestCase):
    def test_hands_over_to_the_packages_launcher(self):
        src = (LINUX / 'AppRun').read_text()
        self.assertTrue(src.startswith('#!/bin/sh\n'))
        self.assertIn('exec bash "$here/usr/lib/gobbonet/gobbonet-launch" "$@"', src)

    def test_passes_its_arguments_through(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'usr/lib/gobbonet').mkdir(parents=True)
            (d / 'usr/lib/gobbonet/gobbonet-launch').write_text('printf "%s|" "$@"\n')
            shutil.copy(LINUX / 'AppRun', d / 'AppRun')
            p = subprocess.run(['sh', str(d / 'AppRun'), 'doctor', 'a b'], capture_output=True, text=True)
            self.assertEqual(p.stdout, 'doctor|a b|')


class MissingPython(unittest.TestCase):
    def test_the_first_run_says_python3_is_missing(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            prefix = d / 'prefix'
            prefix.mkdir()
            shutil.copy(LINUX / 'gobbonet-launch', prefix / 'gobbonet-launch')
            # A stand-in for the program: setup has never run.
            (prefix / 'gobbonet').write_text('#!/bin/sh\n[ "$1 $2" = "setup --status" ] && exit 1\nexit 0\n')
            (prefix / 'gobbonet').chmod(0o755)
            # Every command this machine has, except python3 and the dialogs.
            bindir = d / 'bin'
            bindir.mkdir()
            for top in ('/usr/local/bin', '/usr/bin', '/bin'):
                for f in Path(top).iterdir() if Path(top).is_dir() else ():
                    if f.name.startswith('python3') or f.name in ('zenity', 'kdialog', 'notify-send'):
                        continue
                    if not (bindir / f.name).exists():
                        os.symlink(f, bindir / f.name)
            env = {'PATH': str(bindir), 'HOME': str(d), 'XDG_DATA_HOME': str(d / 'data')}
            p = subprocess.run(['bash', str(prefix / 'gobbonet-launch'), '--no-browser'],
                               capture_output=True, text=True, env=env, timeout=60)
            log = (d / 'data/gobbonet/launch.log').read_text()
            self.assertEqual(p.returncode, 1, log)
            self.assertIn("first-run setup needs Python 3, and this system has no python3", log)
            self.assertNotIn('command not found', log)


@unittest.skipUnless(DEB and RUNTIME and have_zstd_mksquashfs() and
                     (shutil.which('dpkg-deb') or shutil.which('ar')),
                     'set GOBBONET_TEST_DEB and GOBBONET_TEST_APPIMAGE_RUNTIME; needs mksquashfs with zstd')
class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = scratch_tree(RUNTIME)
        cls.p = build(cls.tree, DEB, env={'SOURCE_DATE_EPOCH': '1760918400'})
        found = list((cls.tree / 'installer-linux' / 'dist').glob('GobboNet-*-x86_64.AppImage'))
        cls.image = found[0] if found else None

    def setUp(self):
        self.assertEqual(self.p.returncode, 0, self.p.stdout + self.p.stderr)
        self.assertIsNotNone(self.image)

    def test_image_is_the_pinned_runtime_then_the_filesystem(self):
        data = self.image.read_bytes()
        rt = Path(RUNTIME).read_bytes()
        self.assertEqual(data[8:11], b'AI\x02')
        self.assertEqual(data[:len(rt)], rt)
        self.assertEqual(data[len(rt):len(rt) + 4], b'hsqs', 'a squashfs straight after the runtime')
        self.assertTrue(self.image.stat().st_mode & stat.S_IXUSR)
        self.assertIn('no update information -- ok', self.p.stdout)

    def test_it_holds_exactly_the_debs_files(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([str(self.image), '--appimage-extract'], cwd=d, check=True, capture_output=True)
            root = Path(d) / 'squashfs-root'
            deb = Path(d) / 'deb'
            subprocess.run(['dpkg-deb', '-x', DEB, str(deb)], check=True)

            def listing(base, sub):
                out = {}
                for p in sorted((base / sub).rglob('*')):
                    rel = str(p.relative_to(base))
                    if p.is_symlink():
                        out[rel] = ('link', os.readlink(p))
                    elif p.is_file():
                        out[rel] = ('file', p.stat().st_mode & 0o777, p.read_bytes())
                return out
            got, want = listing(root, 'usr'), listing(deb, 'usr')
            want['usr/bin/gobbonet'] = ('link', '../lib/gobbonet/gobbonet-launch')
            self.assertEqual(sorted(got), sorted(want))
            for k in want:
                self.assertEqual(got[k], want[k], k)
            for p in root.rglob('*'):
                if p.is_symlink():
                    self.assertFalse(os.readlink(p).startswith('/'), '%s points out of the image' % p)
            desktop = (root / 'gobbonet.desktop').read_text()
            self.assertIn('\nExec=gobbonet\n', desktop)
            self.assertIn('X-AppImage-Version=', desktop)
            self.assertEqual(os.readlink(root / '.DirIcon'), 'gobbonet.png')
            self.assertEqual((root / 'AppRun').read_bytes(), (LINUX / 'AppRun').read_bytes())

    def test_it_runs(self):
        env = dict(os.environ)
        if not Path('/dev/fuse').exists():
            env['APPIMAGE_EXTRACT_AND_RUN'] = '1'
        with tempfile.TemporaryDirectory() as home:
            env.update(HOME=home, XDG_CONFIG_HOME=home + '/c', XDG_DATA_HOME=home + '/d')
            p = subprocess.run([str(self.image), 'version'], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertRegex(p.stdout, r'^\d+\.\d+')
        p = subprocess.run([str(self.image), '--appimage-updateinformation'], capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), '')

    def test_a_wrong_runtime_hash_stops_it(self):
        tree = scratch_tree(RUNTIME)
        rt = tree / 'installer-linux' / 'vendor' / ('appimage-runtime-%s-x86_64' % TAG)
        rt.write_bytes(rt.read_bytes() + b'\0')
        p = build(tree, DEB)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('SHA-256 mismatch for the AppImage runtime', p.stderr)
        self.assertFalse(list((tree / 'installer-linux' / 'dist').glob('*.AppImage')))

    def test_a_deb_without_the_vulkan_engine_stops_it(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            subprocess.run(['dpkg-deb', '-R', DEB, str(d / 'x')], check=True)
            for f in (d / 'x/usr/lib/gobbonet/llama-cpp').glob('libggml-vulkan.so*'):
                f.unlink()
            subprocess.run(['dpkg-deb', '--root-owner-group', '-b', str(d / 'x'), str(d / 'cpu.deb')],
                           check=True, capture_output=True)
            p = build(scratch_tree(RUNTIME), str(d / 'cpu.deb'))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('no libggml-vulkan.so', p.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
