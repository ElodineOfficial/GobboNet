#!/usr/bin/env python3
"""The Windows installer is installer-win/, and it keeps the 1.7.5 flow.

Two Windows installers sit in the tree. installer-win/ is the real one: the
dark installer whose first launch opens launch.bat in a console window, where
the hardware is detected and the model is chosen. installer/ is a Go-era design
that picks a backend and downloads a model during setup. It was never meant to
ship, yet it was built by mistake for 1.7.4 and again for the first 1.7.7 test
build. The maintainer rejected that build (2026-10-12):

    INITIAL INSTALL PAGE > DESTINATION > WHERE MODELS RUN [shouldn't even BE
    HERE ...] > Detect hardware > NO PICKING A MODEL UNTIL CMD POPS UP > Start
    Gobbonet or launch phone access.

This file holds installer-win/ to that flow, and holds the build guide to
naming it, so the mistake has to get past a failing test the third time.

Since the 1.7.6 hotfix's installer side was carried over, the finish page and
the main shortcuts run `gobbonet.exe launch` rather than launch.bat itself.
The flow is the same: with no settings yet, launch runs launch.bat in its
console, so the first launch is still the console where the model is chosen.
Later launches serve the saved settings without the questions, and "Setup or
add a model" opens launch.bat directly.

It does not compile the installer, which needs makensis. See
docs/changelog/CHANGELOG-1.7.7-windows-installer.md.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
NSI = (ROOT / 'installer-win' / 'gobbonet.nsi').read_text(encoding='utf-8', errors='replace')
LAUNCH = (ROOT / 'launch.bat').read_text(encoding='utf-8', errors='replace')
BUILDING = (ROOT / 'docs' / 'BUILDING.md').read_text(encoding='utf-8')

# Comments removed, so prose about a page or a file is not mistaken for one.
CODE = '\n'.join(l for l in NSI.splitlines() if l.strip() and not l.strip().startswith(';'))
INSTALL = CODE.split('Section "GobboNet" SecMain', 1)[1].split('SectionEnd', 1)[0]
UNINSTALL = CODE.split('Section "Uninstall"', 1)[1].split('SectionEnd', 1)[0]


def installer_pages():
    """The install side's pages, in order (the uninstaller's come after)."""
    pages = []
    for a, b in re.findall(r'^\s*(?:!insertmacro (MUI_PAGE_\w+)|Page custom (\w+))', CODE, re.M):
        pages.append(a or b)
    return pages


def installed_root_files():
    """Files the install section puts at the top of the install folder."""
    root = INSTALL.split('SetOutPath "$INSTDIR\\js"', 1)[0]
    return re.findall(r'^\s*File "\$\{APPSRC\}\\([^"\\]+)"', root, re.M)


class TheFlow(unittest.TestCase):
    def test_the_pages_in_order(self):
        self.assertEqual(installer_pages(), [
            'MUI_PAGE_WELCOME',
            'MUI_PAGE_DIRECTORY',     # Destination
            'PasswordPageCreate',
            'PortPageCreate',
            'MUI_PAGE_INSTFILES',     # copies files; downloads nothing
            'DefenderPageCreate',     # One Thing Before You Start
            'MUI_PAGE_FINISH',        # Launch GobboNet / phone access
        ])

    def test_no_backend_choice_and_no_model_download_in_setup(self):
        # The model is picked and downloaded in the console window, not here.
        low = CODE.lower()
        for word in ('backendpage', 'modelpage', 'probepage', 'inetc::', 'nsisdl::', '.gguf'):
            self.assertTrue(word not in low, '%s does not belong in the Windows installer' % word)

    def test_it_is_dark(self):
        self.assertIn('!define MUI_BGCOLOR   "0D0E12"', CODE)
        self.assertIn('!define MUI_TEXTCOLOR "CEE2BA"', CODE)
        self.assertIn('!define MUI_CUSTOMFUNCTION_GUIINIT StyleParentWindow', CODE)
        self.assertIn('InstallColors 97E031 0D0E12', CODE)
        for page in ('PasswordPageCreate', 'PortPageCreate', 'DefenderPageCreate'):
            body = CODE.split('Function ' + page, 1)[1].split('FunctionEnd', 1)[0]
            self.assertIn('SetCtlColors $Dialog "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"', body, page + ' is not painted dark')

    def test_finish_launches_the_console_and_offers_phone_access(self):
        self.assertIn('!define APPEXE      "gobbonet.exe"', CODE)
        self.assertIn('!define MUI_FINISHPAGE_RUN_TEXT "Launch GobboNet"', CODE)
        run = CODE.split('Function RunGobboNet', 1)[1].split('FunctionEnd', 1)[0]
        self.assertIn('ExecShell "" "$INSTDIR\\${APPEXE}" "launch"', run)
        self.assertIn('SetOutPath "$INSTDIR"', run)
        # ...and on a new install, launch is the console: no settings yet, so
        # it runs launch.bat in its own window (cmd/gobbonet/launch.go).
        go = (ROOT / 'cmd' / 'gobbonet' / 'launch.go').read_text(encoding='utf-8')
        self.assertIn('exec.Command("cmd.exe", "/d", "/c", "launch.bat")', go)
        self.assertIn('errors.Is(err, config.ErrNotFound) && !explicit', go)
        self.assertIn('!define MUI_FINISHPAGE_SHOWREADME_TEXT "Set up phone access over the LAN (needs administrator)"', CODE)
        self.assertIn('!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED', CODE)

    def test_shortcuts_launch_and_setup_stays_one_click_away(self):
        def target(lnk):
            m = re.search(r'CreateShortcut "%s"\s*\\?\s*"([^"]+)" "([^"]*)"' % re.escape(lnk), CODE)
            self.assertTrue(m, 'no shortcut ' + lnk)
            return m.group(1), m.group(2)
        for lnk in ('$SMPROGRAMS\\${APPNAME}\\${APPNAME}.lnk', '$SMPROGRAMS\\${APPNAME}\\Launch ${APPNAME}.lnk',
                    '$DESKTOP\\${APPNAME}.lnk'):
            self.assertEqual(target(lnk), ('$INSTDIR\\${APPEXE}', 'launch'), lnk)
        # 1.7.9 (PR #15): setup goes through gobbonet.exe so it runs in a kill-on-close job.
        self.assertEqual(target('$SMPROGRAMS\\${APPNAME}\\Setup or add a model.lnk'), ('$INSTDIR\\${APPEXE}', 'launch --setup'))

    def test_the_console_picks_the_model_then_opens_the_browser(self):
        # launch.bat asks for the model, then hands over to gobbonet.exe with
        # that choice and opens the browser. That is "CMD pops up".
        self.assertIn('"!GN!" --open --model "!GGUF_BASENAME!"', LAUNCH)
        self.assertIn('-File "%~dp0hardware-probe.ps1"', LAUNCH)


class WhatItInstalls(unittest.TestCase):
    def test_every_helper_launch_bat_runs_is_installed(self):
        called = sorted(set(re.findall(r'%~dp0([A-Za-z0-9_-]+\.(?:ps1|bat|exe))', LAUNCH)))
        installed = set(installed_root_files())
        for name in called:
            self.assertIn(name, installed, 'launch.bat runs %s but the installer does not install it' % name)

    def test_models_ini_is_installed_and_removed(self):
        # Add a Model's offline list, and the source of its type buttons until
        # the live list carries the tags (internal/catalog/discover.go).
        self.assertIn('models.ini', installed_root_files())
        self.assertIn('Delete "$INSTDIR\\models.ini"', UNINSTALL)
        self.assertTrue((ROOT / 'catalog' / 'models.ini').is_file(), 'the staged models.ini comes from catalog/')

    def test_everything_installed_at_the_root_is_uninstalled(self):
        for name in installed_root_files():
            self.assertIn('Delete "$INSTDIR\\%s"' % name, UNINSTALL, '%s is installed but never removed' % name)

    def test_the_go_server_is_installed_and_stopped_first(self):
        self.assertIn('File "${APPSRC}\\gobbonet.exe"', INSTALL)
        self.assertLess(INSTALL.index('stop-gobbonet.bat" /quiet'), INSTALL.index('File "${APPSRC}\\gobbonet.exe"'))
        self.assertIn('"$INSTDIR\\gobbonet.exe" uninstall --yes --keep-models', UNINSTALL)
        un_go = (ROOT / 'cmd' / 'gobbonet' / 'uninstall.go').read_text(encoding='utf-8')
        for flag in ('"yes"', '"keep-models"'):
            self.assertIn('fs.Bool(%s' % flag, un_go)


class TheLanSetupShortcut(unittest.TestCase):
    """setup-lan.bat stops unless it runs as Administrator. The finish page
    asks with the runas verb; the Start Menu shortcut has to carry the "Run as
    administrator" flag instead, or the phone-access step the README describes
    fails at its first line (found in issue #63's docs pass)."""

    MACRO = (CODE.split('!macro ShortcutRunAsAdmin', 1) + [''])[1].split('!macroend', 1)[0]

    def test_the_flag_is_set_on_the_lan_shortcut_only(self):
        lines = [l.strip() for l in INSTALL.splitlines()]
        create = next(i for i, l in enumerate(lines) if l.startswith('CreateShortcut "$SMPROGRAMS\\${APPNAME}\\${APPNAME} LAN Setup.lnk"'))
        self.assertEqual(lines[create + 2],
                         '!insertmacro ShortcutRunAsAdmin "$SMPROGRAMS\\${APPNAME}\\${APPNAME} LAN Setup.lnk"')
        self.assertEqual(INSTALL.count('ShortcutRunAsAdmin'), 1, 'GobboNet itself must not ask for elevation')

    def test_the_macro_ors_in_run_as_user(self):
        steps = [l.strip() for l in self.MACRO.splitlines()][1:]   # after "!macro ShortcutRunAsAdmin LNK"
        self.assertIn('FileOpen $9 "${LNK}" a', steps, '"a" keeps the file; "w" would empty it')
        self.assertEqual([l for l in steps if l.startswith(('FileSeek', 'FileReadByte', 'IntOp', 'FileWriteByte'))],
                         ['FileSeek $9 0x15 SET', 'FileReadByte $9 $8', 'IntOp $8 $8 | 0x20',
                          'FileSeek $9 0x15 SET', 'FileWriteByte $9 $8'])
        self.assertEqual(steps[:2], ['Push $9', 'Push $8'])
        self.assertEqual(steps[-2:], ['Pop $8', 'Pop $9'])

    def test_the_same_bytes_on_a_shell_link_header(self):
        # MS-SHLLINK 2.1: HeaderSize, LinkCLSID, then LinkFlags at 0x14.
        # SLDF_RUNAS_USER is 0x00002000. Replaying the macro on a header with
        # other flags set must set that one and change nothing else.
        import struct
        clsid = bytes.fromhex('0114020000000000c000000000000046')
        flags = 0x000000DB | 0x00000400
        lnk = bytearray(struct.pack('<I', 0x4C) + clsid + struct.pack('<I', flags) + bytes(56))
        lnk[0x15] |= 0x20
        self.assertEqual(struct.unpack_from('<I', lnk, 0x14)[0], flags | 0x2000)


class TheBuildGuide(unittest.TestCase):
    def test_building_md_names_installer_win(self):
        self.assertIn('**The Windows installer is `installer-win/`.**', BUILDING)
        order = BUILDING.split('## Order matters', 1)[1].split('```', 2)[1]
        self.assertIn('installer-win/', order)
        self.assertNotIn('build-installer.sh', order, 'the release build order must not build installer/')

    def test_retired_installer_design_is_gone(self):
        # 1.7.9: installer/ was an unreleased design that said "do not ship" on
        # its first line. It is removed; its catalogue moved to catalog/.
        self.assertFalse((ROOT / 'installer').exists(), 'installer/ was retired in 1.7.9')


if __name__ == '__main__':
    unittest.main()
