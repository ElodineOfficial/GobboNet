#!/usr/bin/env python3
"""GobboNet can be added to a phone's home screen (issue #63).

A home-screen shortcut keeps the full http:// address -- so Safari's switch to
HTTPS, which fails against a plain-HTTP server on the LAN, never happens --
and opens GobboNet without the browser's address bar. That takes a web app
manifest, a touch icon and a few <meta> tags, on both pages a phone meets:
chat.html and the login page.

Held here, from the source tree (no build needed):
  - manifest.webmanifest is valid, names only files on this machine, and the
    sizes it gives are the icons' real sizes;
  - chat.html and the login page carry the same tags (relative paths on the
    chat page, absolute on the login page, which is also served at deep links);
  - the server's list of files served before sign-in is exactly the files those
    tags and the manifest name -- nothing more is public;
  - stage-web.sh builds them into the binary, make-zip.sh ships their source;
  - the icons are the package's own art, so the two cannot drift.

The routes themselves are tested in internal/server/homescreen_test.go. See
docs/changelog/CHANGELOG-1.7.8-home-screen.md.
"""
from pathlib import Path
import json
import re
import struct
import unittest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / 'manifest.webmanifest'
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
CHAT = (ROOT / 'chat.html').read_text(encoding='utf-8')
HEAD = CHAT.split('</head>', 1)[0]
LOGIN_GO = (ROOT / 'internal' / 'auth' / 'login.go').read_text(encoding='utf-8')
SERVER_GO = (ROOT / 'internal' / 'server' / 'server.go').read_text(encoding='utf-8')

TAG = re.compile(r'<(?:link|meta) [^>]*>')


def png_size(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', '%s is not a PNG' % path
    return struct.unpack('>II', data[16:24])


def login_tags():
    m = re.search(r'const HomeScreenTags = `([^`]*)`', LOGIN_GO)
    assert m, 'no HomeScreenTags in login.go'
    return TAG.findall(m.group(1))


def chat_tags():
    start = HEAD.index('<link rel="manifest"')
    return TAG.findall(HEAD[start:HEAD.index('<link rel="stylesheet"', start)])


def public_assets():
    block = re.search(r'var publicAssets = map\[string\]bool\{(.*?)\n\}', SERVER_GO, re.S).group(1)
    return set(re.findall(r'"([^"]+)":\s*true', block))


class Manifest(unittest.TestCase):
    def test_fields(self):
        self.assertEqual(MANIFEST['name'], 'GobboNet')
        self.assertEqual(MANIFEST['short_name'], 'GobboNet')
        self.assertEqual(MANIFEST['display'], 'standalone')
        # Relative to the manifest, so GobboNet works the same at any address.
        self.assertEqual((MANIFEST['start_url'], MANIFEST['scope'], MANIFEST['id']), ('./', './', './'))
        self.assertRegex(MANIFEST['background_color'], r'^#[0-9a-f]{6}$')

    def test_names_nothing_off_this_machine(self):
        self.assertNotIn('http', MANIFEST_PATH.read_text(encoding='utf-8'))
        self.assertNotIn('http', ''.join(chat_tags()) + ''.join(login_tags()))

    def test_icon_sizes_are_real(self):
        self.assertTrue(MANIFEST['icons'])
        for icon in MANIFEST['icons']:
            self.assertEqual(icon['type'], 'image/png')
            w, h = png_size(ROOT / icon['src'])
            self.assertEqual('%dx%d' % (w, h), icon['sizes'], icon['src'])
            self.assertGreaterEqual(w, 192, 'Android wants at least 192 px')

    def test_icons_are_the_packages_art(self):
        art = ROOT / 'installer-linux' / 'icon' / 'gobbonet-256.png'
        self.assertEqual((ROOT / 'icons' / 'gobbonet-256.png').read_bytes(), art.read_bytes())
        self.assertEqual(png_size(ROOT / 'icons' / 'gobbonet-180.png'), (180, 180))


class Pages(unittest.TestCase):
    def test_chat_page_and_login_page_agree(self):
        chat, login = chat_tags(), login_tags()
        self.assertEqual(len(chat), 7)
        self.assertEqual([t.replace('href="/', 'href="') for t in login], chat)
        for t in login:
            if 'href=' in t:
                self.assertIn('href="/', t, 'the login page needs absolute paths')

    def test_both_kinds_of_phone(self):
        tags = ' '.join(chat_tags())
        for needed in ('rel="manifest"', 'rel="apple-touch-icon"', 'name="apple-mobile-web-app-capable"',
                       'name="mobile-web-app-capable"', 'name="apple-mobile-web-app-title" content="GobboNet"',
                       'name="theme-color"'):
            self.assertIn(needed, tags)
        # "black", not "black-translucent": the page has no safe-area padding,
        # so a translucent bar would sit over the header.
        self.assertIn('name="apple-mobile-web-app-status-bar-style" content="black"', tags)

    def test_files_named_exist(self):
        for t in chat_tags():
            m = re.search(r'href="([^"]+)"', t)
            if m:
                self.assertTrue((ROOT / m.group(1)).is_file(), m.group(1))


class WhatIsPublic(unittest.TestCase):
    def test_exactly_the_named_files(self):
        named = {'/manifest.webmanifest'} | {'/' + i['src'] for i in MANIFEST['icons']}
        named |= {'/' + re.search(r'href="([^"]+)"', t).group(1)
                  for t in chat_tags() if 'href=' in t}
        self.assertEqual(public_assets(), named)

    def test_only_reads(self):
        self.assertIn('case publicAssets[path] && (r.Method == http.MethodGet || r.Method == http.MethodHead):',
                      SERVER_GO)
        before_gate = SERVER_GO.split('// --- Auth gate', 1)[0]
        self.assertIn('publicAssets[path]', before_gate)

    def test_served_with_the_manifest_type(self):
        httpx = (ROOT / 'internal' / 'httpx' / 'httpx.go').read_text(encoding='utf-8')
        self.assertRegex(httpx, r'"\.webmanifest":\s*"application/manifest\+json"')


class Build(unittest.TestCase):
    def test_built_into_the_binary(self):
        stage = (ROOT / 'scripts' / 'stage-web.sh').read_text(encoding='utf-8')
        files = re.search(r'^REQUIRED_FILES="([^"]*)"', stage, re.M).group(1).split()
        dirs = re.search(r'^REQUIRED_DIRS="([^"]*)"', stage, re.M).group(1).split()
        self.assertIn('manifest.webmanifest', files)
        self.assertIn('icons', dirs)

    def test_source_ships_in_the_zip(self):
        mz = (ROOT / 'scripts' / 'make-zip.sh').read_text(encoding='utf-8')
        listing = mz.split('for rel in \\', 1)[1].split('\ndo\n', 1)[0].split()
        self.assertIn('manifest.webmanifest', listing)
        self.assertIn('icons', listing)


if __name__ == '__main__':
    unittest.main(verbosity=2)
