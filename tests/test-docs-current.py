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
        self.assertIn('GOBBONET_LEGACY_SERVER=1', intro)
        self.assertIn('GOBBONET_LEGACY_SERVER', read('launch.bat'), 'the legacy switch the page names exists')

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
