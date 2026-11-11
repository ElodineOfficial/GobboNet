#!/usr/bin/env python3
"""The version literals outside VERSION move with it.

VERSION is the release number, and almost everything reads it: the build stamp,
installer/gobbonet.nsi (a -D define), build-deb.sh, build-rpm.sh. Two places
carry the number as a literal instead:

  - js/01-config.js's GOBBONET_UI_VERSION, held equal by
    tests/test-version-stamp.mjs;
  - installer-win/gobbonet.nsi's APPVER, OutFile and VIProductVersion, which
    nothing checked. Its README says only APPVER changes between releases and
    the other two "track it" -- by hand.

This holds the second group to VERSION, so a release cannot ship an installer
named, labelled or version-stamped as the previous one. It also holds
installer/gobbonet.nsi to taking the number from its define rather than
growing a literal.

1.7.7 release housekeeping; see docs/changelog/CHANGELOG-1.7.7-version-bump.md.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / 'VERSION').read_text().strip()


class VersionStrings(unittest.TestCase):
    def test_version_file_is_a_release_number(self):
        self.assertRegex(VERSION, r'^\d+\.\d+\.\d+$')

    def test_installer_win_literals_follow_version(self):
        nsi = (ROOT / 'installer-win' / 'gobbonet.nsi').read_text(encoding='utf-8', errors='replace')
        for want in ('!define APPVER      "%s"' % VERSION,
                     'OutFile           "GobboNetSetup-%s.exe"' % VERSION.replace('.', '_'),
                     'VIProductVersion "%s.0"' % VERSION):
            self.assertTrue(want in nsi, 'installer-win/gobbonet.nsi should say %s (VERSION is %s)' % (want, VERSION))
        stale = sorted(set(re.findall(r'GobboNetSetup-(\d+_\d+_\d+)\.exe', nsi)) - {VERSION.replace('.', '_')})
        self.assertEqual(stale, [], 'another release named in an installer filename')

    def test_fedora_package_docs_follow_version(self):
        # FEDORA.md ships inside the .rpm as its doc, and its dnf command names
        # the package; the spec's changelog is what `rpm -q --changelog` shows.
        # Both are hand-edited per release, and both were left at 1.7.7 until
        # the 1.7.8 packaging step (CHANGELOG-1.7.8-fedora-installer.md).
        fedora = (ROOT / 'installer-fedora' / 'FEDORA.md').read_text(encoding='utf-8')
        self.assertTrue('sudo dnf install ./gobbonet-%s-*.fedora.x86_64.rpm' % VERSION in fedora,
                        'installer-fedora/FEDORA.md should name the %s package' % VERSION)
        spec = (ROOT / 'installer-fedora' / 'gobbonet.spec').read_text(encoding='utf-8')
        newest = re.search(r'(?m)^%changelog\n\* .* - (\S+)$', spec)
        self.assertTrue(newest and newest.group(1).startswith(VERSION + '-'),
                        "gobbonet.spec's newest changelog entry should be for %s, not %s"
                        % (VERSION, newest.group(1) if newest else 'missing'))

    def test_bug_report_version_placeholder_follows_version(self):
        # The bug form shows the version a reporter should see in ABOUT. It was
        # not in this tree until 1.8.0 (CHANGELOG-1.7.9-version-bump.md noted it
        # had to be bumped by hand on GitHub); now it moves with VERSION.
        bug = (ROOT / '.github' / 'ISSUE_TEMPLATE' / 'bug.yml').read_text(encoding='utf-8')
        version = bug.split('    id: version\n', 1)[1].split('  - type:', 1)[0]
        self.assertIn('placeholder: "%s"' % VERSION, version,
                      '.github/ISSUE_TEMPLATE/bug.yml should show %s as the version placeholder' % VERSION)


if __name__ == '__main__':
    unittest.main()
