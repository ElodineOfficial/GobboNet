#!/usr/bin/env python3
"""The user-facing docs describe the program that ships (issue #63).

New users and AI agents both read README.md, TROUBLESHOOTING.md and
docs/PURGE.md first, and in 1.7.6 they described an older app: Windows only,
a launch.exe removed in 1.7, the PowerShell file server's logs and files.
1.7.8's docs pass brought them up to the Go server. This holds the specific
claims that were wrong, and ties the facts the docs quote to the code they
come from, so the next change to one shows up in the other.

See docs/changelog/CHANGELOG-1.7.8-docs-pass.md.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


README = read('README.md')
TROUBLE = read('TROUBLESHOOTING.md')
PURGE = read('docs/PURGE.md')
GO_SERVER = read('docs/GO_SERVER.md')
SPLIT = read('docs/archive/GO_CONFIG_SPLIT.md')
NSI = read('installer-win/gobbonet.nsi')
USAGE = read('cmd/gobbonet/main.go').split('func usage()', 1)[1].split('`)', 1)[0]


class Docs(unittest.TestCase):
    # assertNotIn would print the whole document on a failure.
    def assertAbsent(self, needle, text, where):
        self.assertFalse(needle in text, '%s still says %r' % (where, needle))


def section(text, heading):
    start = text.index(heading)
    nxt = text.find('\n## ', start + len(heading))
    return text[start:nxt if nxt >= 0 else len(text)]


class Readme(Docs):
    def test_no_launcher_exe(self):
        # launch.exe and launchLAN.exe were C shims removed in 1.7.
        for gone in ('launch.exe', 'launchLAN.exe'):
            self.assertAbsent(gone, README, 'README.md')

    def test_linux_is_not_called_unsupported(self):
        self.assertAbsent("doesn't work on Mac or Linux", README, 'README.md')
        self.assertAbsent('Windows-only today', README, 'README.md')
        self.assertIn('(LINUX-START-HERE.md)', README)
        self.assertTrue((ROOT / 'LINUX-START-HERE.md').is_file())

    def test_no_installer_size(self):
        # 660 KB was 1.3's; 1.7.6's was about 3.9 MB. A number here goes stale
        # with every release, so there is none.
        self.assertIsNone(re.search(r'GobboNetSetup\.exe.{0,6}\. It\'s small \(\d+ ?[KM]B\)', README))

    def test_lan_setup_is_run_as_administrator(self):
        self.assertIn('Run as administrator', README)


class Troubleshooting(Docs):
    def test_starts_from_doctor_and_the_go_server(self):
        intro = TROUBLE.split('\n## ', 1)[0]
        self.assertIn('gobbonet doctor', intro)
        self.assertIn('gobbonet.exe', intro)
        # 1.8.0 removed the PowerShell server: the page says so, names the
        # leftover a ZIP update leaves, and no longer offers the old switch.
        flat = ' '.join(intro.split())
        self.assertIn('Since 1.8 it is the only server', flat)
        self.assertIn('`fileserver.ps1` from 1.7 may still be in the install folder', flat)
        self.assertAbsent('GOBBONET_LEGACY_SERVER', TROUBLE, 'TROUBLESHOOTING.md')
        self.assertFalse((ROOT / 'fileserver.ps1').exists(), 'the file the page calls a leftover is not shipped')

    def test_linux_is_supported(self):
        linux = section(TROUBLE, '## Linux')
        self.assertAbsent('Not supported yet', linux, 'TROUBLESHOOTING.md')
        self.assertIn('LINUX-START-HERE.md', linux)

    def test_quoted_messages_are_the_programs_own(self):
        main = read('cmd/gobbonet/main.go')
        ready = read('cmd/gobbonet/ready.go')
        for quoted, source in (
            ('is already in use, so nothing was started', main),
            ('was refused on every address', main),
            ('is malformed', main),
            ('no password is set', main),
            ('LAN ACCESS IS OFF', ready),
            ('Network bind failed', ready),
        ):
            self.assertIn(quoted, TROUBLE)
            self.assertIn(quoted, source, '%r is quoted but the program no longer says it' % quoted)
        self.assertIn('"startup-error.log"', main)
        self.assertIn('"llama-server.log"', read('internal/config/config.go'))

    def test_the_session_lifetime_is_the_configs(self):
        ttl = re.search(r'DefaultSessionTTLHours\s*=\s*(\d+)', read('internal/config/config.go')).group(1)
        self.assertIn('A sign-in lasts %s hours' % ttl, TROUBLE)
        self.assertIn('session_ttl_hours', TROUBLE)

    def test_commands_it_names_exist(self):
        for cmd in ('set-password', 'doctor', 'uninstall'):
            self.assertIn('gobbonet %s' % cmd, USAGE)
        self.assertTrue((ROOT / 'stop-gobbonet.bat').is_file())

    def test_the_cost_of_an_exclusion(self):
        self.assertIn('Defender does not scan anything in an excluded folder', TROUBLE)
        self.assertIn('The cost: Defender no longer scans that folder', NSI)

    def test_one_run_port_uses_the_current_spelling(self):
        self.assertAbsent('set GEMMA_LISTEN_PORT=', TROUBLE, 'TROUBLESHOOTING.md')


class Purge(Docs):
    def test_names_the_go_servers_files(self):
        uninstall = read('cmd/gobbonet/uninstall.go')
        for name in ('state.json', 'state.json.bak', 'state.keyring'):
            self.assertIn(name, PURGE)
            self.assertIn('"%s"' % name, uninstall, '%s is named but uninstall no longer removes it' % name)
        self.assertIn('state-*.json', uninstall)
        self.assertIn('gobbonet uninstall', PURGE)
        self.assertIn('.local\\share\\gobbonet', PURGE)

    def test_the_windows_uninstaller_does_what_it_says(self):
        self.assertIn('"$INSTDIR\\gobbonet.exe" uninstall --yes --keep-models', NSI)
        self.assertIn('Delete "$INSTDIR\\.gobbonet-state.json"', NSI)


class DesignNotes(Docs):
    def test_go_server_has_no_web_folder(self):
        self.assertAbsent('next to `web/`', GO_SERVER, 'docs/GO_SERVER.md')
        self.assertAbsent('with `web/` into an archive', GO_SERVER, 'docs/GO_SERVER.md')

    def test_config_split_has_no_pasted_text(self):
        self.assertTrue(SPLIT.startswith('# Shared config file design (historical)\n'))
        self.assertAbsent('Now I have the complete picture', SPLIT, 'docs/archive/GO_CONFIG_SPLIT.md')

    def test_installer_header_matches_the_installer(self):
        header = NSI.split('Unicode true', 1)[0]
        self.assertAbsent('handled separately by\n;     launchLAN.exe', header, 'the installer header')
        self.assertIn('runas', header)
        self.assertIn('ExecShell "runas" "$INSTDIR\\${LANEXE}"', NSI)


# --- Issue and PR templates (1.8.0, issue #62) -------------------------------
#
# CONTRIBUTING.md told people to "Use the Bug report template under New issue"
# and described an optional AI section in "the bug report and PR templates",
# and there was no .github/ folder at all. These hold the templates to what
# CONTRIBUTING.md promises. The forms are read as text, so the suite still needs
# nothing beyond Python itself.

GH = ROOT / '.github'
CONTRIBUTING = read('CONTRIBUTING.md')


def form_field(form, field_id):
    """The text of one body element of an issue form, from its `id:` line to
    the next element."""
    m = re.search(r'^  - type: \w+\n    id: ' + re.escape(field_id) + r'\n(.*?)(?=^  - type: |\Z)', form, re.M | re.S)
    return m.group(0) if m else ''


def dropdown_options(field):
    block = field.split('options:', 1)[1].split('validations:', 1)[0]
    return [o.strip().strip('"') for o in re.findall(r'^\s+- (.+)$', block, re.M)]


class Templates(Docs):
    BUG = (GH / 'ISSUE_TEMPLATE' / 'bug.yml')
    FEATURE = (GH / 'ISSUE_TEMPLATE' / 'feature.yml')
    CONFIG = (GH / 'ISSUE_TEMPLATE' / 'config.yml')
    PR = (GH / 'PULL_REQUEST_TEMPLATE.md')

    def test_every_template_contributing_names_exists(self):
        self.assertIn('Use the **Bug report** template under New issue', CONTRIBUTING)
        for p in (self.BUG, self.FEATURE, self.CONFIG, self.PR):
            self.assertTrue(p.is_file(), '%s is missing' % p.relative_to(ROOT))
        self.assertRegex(self.BUG.read_text(), r'(?m)^name: Bug report$')

    def test_the_bug_form_asks_for_what_contributing_lists(self):
        bug = self.BUG.read_text()
        # CONTRIBUTING.md: version from ABOUT, COPY BUILD INFO, gobbonet doctor,
        # how it was started, OS and GPU.
        for field_id, words in (('version', 'ABOUT'), ('build-info', 'COPY BUILD INFO'), ('doctor', 'doctor'),
                                ('started', 'start'), ('os', 'Operating system'), ('gpu', 'GPU')):
            field = form_field(bug, field_id)
            self.assertTrue(field, 'bug.yml has no %r field' % field_id)
            self.assertIn(words, field)
        self.assertIn('required: true', form_field(bug, 'version').split('validations:', 1)[1])

    def test_the_bug_forms_start_options_are_the_launchers_that_ship(self):
        # Each option, and the file in this tree that makes it real. A launcher
        # that is added or retired shows up here.
        nsi = NSI
        shipped = {
            'Windows: the GobboNet or Launch GobboNet shortcut (Start menu or desktop)':
                '"$SMPROGRAMS\\${APPNAME}\\Launch ${APPNAME}.lnk"' in nsi and '"$DESKTOP\\${APPNAME}.lnk"' in nsi,
            'Windows: the Setup or add a model shortcut': '"$SMPROGRAMS\\${APPNAME}\\Setup or add a model.lnk"' in nsi,
            'Windows: launch.bat': (ROOT / 'launch.bat').is_file(),
            'Windows: gobbonet.exe, run directly': re.search(r'(?m)^gobbonet\.exe$', read('scripts/make-zip.sh')) is not None,
            'Linux: the app menu or the gobbonet command (.deb or .rpm)':
                (ROOT / 'installer-linux' / 'gobbonet.desktop').is_file() and (ROOT / 'installer-fedora' / 'gobbonet.spec').is_file(),
            'Linux: the AppImage': (ROOT / 'installer-linux' / 'build-appimage.sh').is_file(),
            'Linux: the ZIP (./gobbonet)': (ROOT / 'installer-linux' / 'gobbonet-zip-entry').is_file(),
        }
        options = dropdown_options(form_field(self.BUG.read_text(), 'started'))
        self.assertEqual(options[-1], 'Something else (say below)')
        self.assertEqual(options[:-1], list(shipped), 'the start options and the launchers that ship disagree')
        gone = [o for o, real in shipped.items() if not real]
        self.assertEqual(gone, [], 'offered as a way to start GobboNet, but not in this tree')
        self.assertAbsent('fileserver', '\n'.join(options), 'bug.yml start options')

    def test_the_privacy_tick_is_required_and_says_what_to_remove(self):
        bug = self.BUG.read_text()
        tick = form_field(bug, 'privacy')
        self.assertIn('type: checkboxes', tick)
        self.assertIn('required: true', tick)
        for word in ('addresses', 'folder paths'):
            self.assertIn(word, tick)
        # ...and the warning comes before anyone pastes, as CONTRIBUTING.md says.
        self.assertLess(bug.index('Before you paste anything'), bug.index('id: doctor'))

    def test_security_reports_go_privately_where_contributing_says(self):
        discord = re.search(r'privately\s+to Elodine on the \[GobboNet Discord\]\((https://[^)]+)\)', CONTRIBUTING)
        self.assertIsNotNone(discord, 'CONTRIBUTING.md no longer says where security reports go')
        config = self.CONFIG.read_text()
        self.assertRegex(config, r'(?m)^blank_issues_enabled: true$')
        security = config.split('- name: Report a security problem privately', 1)[1].split('- name:', 1)[0]
        self.assertIn('url: ' + discord.group(1), security)
        self.assertIn(discord.group(1), self.BUG.read_text())

    def test_the_pr_checklist_is_contributings_privacy_rules(self):
        pr = self.PR.read_text()
        rules = section(CONTRIBUTING, '## Privacy and security rules')
        for rule, box in (('telemetry', 'No telemetry'), ('network destination', 'No new network destination'),
                          ('dependency', 'No new dependency'), ('pinned by SHA-256', 'pinned by SHA-256'),
                          ('LAN access stays opt-in', 'LAN access stays opt-in')):
            self.assertIn(rule, rules, 'CONTRIBUTING.md no longer has the rule %r' % rule)
            self.assertRegex(pr, r'(?m)^- \[ \] .*' + re.escape(box), 'the PR checklist has no box for %r' % rule)
        self.assertRegex(pr, r'(?m)^- \[ \] Anything that can make code run is set from this PC only')

    def test_the_ai_sections_are_optional_and_never_a_gate(self):
        self.assertIn('optional section', CONTRIBUTING)
        for p, field in ((self.BUG, 'ai-assist'), (self.FEATURE, 'ai-assist')):
            f = form_field(p.read_text(), field)
            self.assertIn('optional', f)
            self.assertIn('required: false', f)
        pr = self.PR.read_text()
        self.assertIn('## AI assistance (optional)', pr)
        ai = pr.split('## AI assistance (optional)', 1)[1]
        for asks in ('which assistant', 'what a person checked', 'unverified'):
            self.assertIn(asks, ai)
        self.assertIn('never a gate', ai)


if __name__ == '__main__':
    unittest.main(verbosity=2)
