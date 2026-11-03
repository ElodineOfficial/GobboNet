#!/usr/bin/env python3
"""The Linux installer is installer-linux/, and it keeps the 1.7.5 flow.

The maintainer's direction for 1.7.7 (2026-10-12): every installer acts the way
it did in 1.7.5, each with its own OS-specific steps. On Linux that is the
.deb from installer-linux/: the menu entry runs gobbonet-launch, which serves
the browser setup wizard (gobbonet-setup.py + wizard.html, the maintainer's
1.7.3/1.7.5 design) and then opens the chat. LINUX-START-HERE.md names the
steps:

    Welcome -> data/model location -> password -> web port -> firewall
    explanation -> local or LAN launch -> bundled llama.cpp engine (where
    models run) -> model picker and download -> optional Nomic embeddings ->
    LAUNCH

The Windows installer was swapped for a different design twice by mistake
(tests/test-windows-installer.py). This holds the Linux one in place the same
way. tests/test-linux-onboarding.py runs the flow for real against a built
install; this checks the source it is built from.
See docs/changelog/CHANGELOG-1.7.7-linux-installer.md.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
LIN = ROOT / 'installer-linux'
LAUNCH = (LIN / 'gobbonet-launch').read_text(encoding='utf-8')
BUILD = (LIN / 'build-deb.sh').read_text(encoding='utf-8')
WIZARD = (LIN / 'wizard.html').read_text(encoding='utf-8')
BUILDING = (ROOT / 'docs' / 'BUILDING.md').read_text(encoding='utf-8')


def code(text):
    return '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('#'))


class TheLauncher(unittest.TestCase):
    def test_first_run_is_the_browser_wizard(self):
        self.assertIn('python3 "$PREFIX/gobbonet-setup.py" "$ENGINE"', code(LAUNCH))

    def test_the_command_and_menu_entry_run_the_launcher(self):
        self.assertIn('ln -sf /usr/lib/gobbonet/gobbonet-launch "$STAGE/usr/bin/gobbonet"', BUILD)
        desktop = (LIN / 'gobbonet.desktop').read_text(encoding='utf-8')
        self.assertRegex(desktop, r'(?m)^Exec=/usr/lib/gobbonet/gobbonet-launch\b')


class ThePackage(unittest.TestCase):
    def test_it_carries_the_wizard_the_catalogue_and_the_engine(self):
        build = code(BUILD)
        for line in ('install -m 0644 gobbonet-setup.py wizard.html "$STAGE/usr/lib/gobbonet/"',
                     'install -m 0755 gobbonet-launch        "$STAGE/usr/lib/gobbonet/gobbonet-launch"',
                     'install -m 0644 "$ROOT/catalog/models.ini" "$STAGE/usr/lib/gobbonet/models.ini"',
                     'cp -r "$VENDOR/llama-cpp"              "$STAGE/usr/lib/gobbonet/llama-cpp"'):
            self.assertIn(line, build)
        self.assertIn('-bin-ubuntu-vulkan-x64.tar.gz', BUILD)

    def test_the_fedora_package_is_the_same_wizard(self):
        # The .rpm takes its launcher and wizard from installer-linux/ too, so
        # Fedora's flow is Debian's (check-rpm.sh compares them byte for byte
        # in the finished package; this holds the builder to it).
        rpm = code((ROOT / 'installer-fedora' / 'build-rpm.sh').read_text(encoding='utf-8'))
        for name in ('gobbonet-setup.py', 'wizard.html', 'gobbonet-launch'):
            self.assertRegex(rpm, r'install -m 0[0-7]{3} "\$ROOT/installer-linux/%s"' % re.escape(name))

    def test_the_zip_runtime_is_the_same_wizard(self):
        for name in ('gobbonet-launch', 'gobbonet-setup.py', 'wizard.html'):
            self.assertEqual((ROOT / 'linux-amd64' / name).read_bytes(), (LIN / name).read_bytes(),
                             'linux-amd64/%s differs from installer-linux/%s' % (name, name))


class TheWizard(unittest.TestCase):
    def test_its_steps(self):
        heads = re.findall(r'<section class="step[^"]*" id="([^"]+)">.*?<h2[^>]*>([^<]+)</h2>', WIZARD, re.S)
        self.assertEqual(dict(heads), {
            'welcome': 'Welcome to GobboNet setup',
            'location': 'Install location',
            'port': 'Choose the web port',
            'network': 'Firewall and network access',
            'extras': 'Optional additions',
            's1': 'Set your access password',
            's2': 'Where should models run?',
            's3': 'Pick a model',
            's4': 'Downloading',
            's5': 'Ready to launch',
            's6': 'Ready.',
        })

    def test_the_order_between_them(self):
        # Each button leads to the next step of the documented flow.
        for wiring in ("$('save-location').onclick = function() {\n"
                       "    post('/api/location', {path: $('data-path').value}).then(function(){\n"
                       "      show(1);",
                       '.then(function () { step("port"); })',
                       "step('network');",
                       "$('local-launch').onclick = function(){ lan = 'off'; show(2); };",
                       "$('lan-launch').onclick = function(){ lan = 'on'; show(2); };",
                       'show(mode === "remote" ? 5 : 3);',
                       '$("b3skip").onclick = function () { step("extras"); };',
                       "$('extra-continue').onclick = function(){ show(5); };"):
            self.assertIn(wiring, WIZARD)


    def test_the_model_note_follows_the_chosen_folder(self):
        # "Existing GGUF models belong in: ..." and the free space beside it
        # were written once, at page load. Choosing another folder at Install
        # location restarts setup on it, but the note kept naming the old one
        # (as in 1.7.5), so a model copied in by hand went to the wrong place.
        save = WIZARD.split("$('save-location').onclick", 1)[1].split('};', 1)[0]
        self.assertIn('fetch("/api/state")', save)
        self.assertIn('.then(setNote)', save)
        self.assertEqual(WIZARD.count('$("freenote").textContent ='), 1, 'one place writes the note')
        self.assertNotIn("$('freenote').textContent +=", WIZARD)
        note = WIZARD.split('function setNote(s) {', 1)[1].split('}', 1)[0]
        self.assertIn('s.free_gb', note)
        self.assertIn('s.model_dir', note)


class TheBuildGuide(unittest.TestCase):
    def test_building_md_builds_the_deb_from_installer_linux(self):
        order = BUILDING.split('## Order matters', 1)[1].split('```', 2)[1]
        self.assertIn('cd installer-linux && ./build-deb.sh', order)


if __name__ == '__main__':
    unittest.main()
