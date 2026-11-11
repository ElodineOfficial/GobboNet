#!/usr/bin/env python3
"""LINUX-START-HERE.md's install commands work on the files people download.

The 1.7.7 page said `sudo apt install ./gobbonet_1.7.7+go.*_amd64.deb`. That is
the name build-deb.sh gives the package, but GitHub drops the '+' from release
asset names, and the file on the 1.7.7 release page is
gobbonet_1.7.7go.a1a1ce8-1_amd64.deb. The pattern matched nothing, so the shell
handed it to apt as it was, and apt said "Unsupported file". The AppImage's name
has a '+' too; its pattern on the page never relied on it.

This holds each command on the page to both names a file can have -- as built,
and as downloaded -- for the release in VERSION, and the page's title to that
release. See docs/changelog/CHANGELOG-1.7.8-linux-installer.md.
"""
from fnmatch import fnmatchcase
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / 'VERSION').read_text().strip()
PAGE = (ROOT / 'LINUX-START-HERE.md').read_text(encoding='utf-8')
BUILD_DEB = (ROOT / 'installer-linux' / 'build-deb.sh').read_text(encoding='utf-8')
BUILD_APPIMAGE = (ROOT / 'installer-linux' / 'build-appimage.sh').read_text(encoding='utf-8')
SPEC = (ROOT / 'installer-fedora' / 'gobbonet.spec').read_text(encoding='utf-8')


def github(name):
    """What a release asset is called once uploaded (as on the 1.7.7 release)."""
    return name.replace('+', '')


def pattern(regex):
    m = re.search(regex, PAGE)
    assert m, 'LINUX-START-HERE.md has no command matching ' + regex
    return m.group(1)


class InstallCommands(unittest.TestCase):
    def test_title_is_this_release(self):
        self.assertTrue(PAGE.startswith('# GobboNet %s — Linux' % VERSION),
                        'LINUX-START-HERE.md is titled for another release than VERSION (%s)' % VERSION)

    def test_the_build_scripts_still_name_files_this_way(self):
        # The names below are derived from these lines; if they change, so
        # must the fixtures.
        self.assertIn('DEB_VERSION="${RELEASE}+go.${SHA}-${DEB_REVISION}"', BUILD_DEB)
        self.assertIn('DEB="$OUT/gobbonet_${DEB_VERSION}_amd64.deb"', BUILD_DEB)
        self.assertIn('NAME_VERSION="$(printf \'%s\' "$VERSION" | tr -d \'+\')"', BUILD_APPIMAGE)
        self.assertIn('APPIMAGE="$OUT/GobboNet-${NAME_VERSION}-x86_64.AppImage"', BUILD_APPIMAGE)
        self.assertIn('Release:        %{gn_release}%{?dist}', SPEC)

    def test_apt_matches_the_deb_as_built_and_as_downloaded(self):
        glob = pattern(r'sudo apt install \./(\S+\.deb)`')
        for built in ('gobbonet_%s+go.a1a1ce8-1_amd64.deb' % VERSION,
                      'gobbonet_%s+go.nogit.20261023-1_amd64.deb' % VERSION,
                      'gobbonet_%s+go.a1a1ce8-2_amd64.deb' % VERSION):
            self.assertTrue(fnmatchcase(built, glob), '%s does not match %s' % (glob, built))
            self.assertTrue(fnmatchcase(github(built), glob), '%s does not match %s' % (glob, github(built)))
        if VERSION != '1.7.7':
            self.assertFalse(fnmatchcase('gobbonet_1.7.7go.a1a1ce8-1_amd64.deb', glob),
                             'the apt command would pick up the 1.7.7 package too')

    def test_dnf_matches_the_rpm(self):
        glob = pattern(r'sudo dnf install \./(\S+\.rpm)`')
        built = 'gobbonet-%s-1.go.a1a1ce8.fedora.x86_64.rpm' % VERSION
        self.assertTrue(fnmatchcase(built, glob) and fnmatchcase(github(built), glob), glob)

    def test_appimage_matches_as_built_and_as_downloaded(self):
        for glob in set(re.findall(r'(?:chmod \+x |\./)(GobboNet-\S*\.AppImage)', PAGE)):
            # Built without the "+" since 1.8.0, as GitHub lists it.
            built = 'GobboNet-%sgo.a1a1ce8-1-x86_64.AppImage' % VERSION
            self.assertTrue(fnmatchcase(built, glob) and fnmatchcase(github(built), glob), glob)


if __name__ == '__main__':
    unittest.main(verbosity=2)
