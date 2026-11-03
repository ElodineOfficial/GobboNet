#!/usr/bin/env python3
"""1.7.9: the new-password minimum is min_password_length (8 unless set, never
below 4), everywhere a password is chosen, and nowhere is it hard-coded to a
different number.

Go's side is internal/config, internal/setup and cmd/gobbonet tests. This pins
the pages and scripts that cannot read Go constants: the setup wizards,
launch.bat's console prompt and the NSIS installer page.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_bytes().decode('latin-1')
failures = 0


def check(name, ok, detail=''):
    global failures
    print(('  PASS    ' if ok else '  FAIL    ') + name)
    if not ok:
        failures += 1
        if detail:
            print('        ' + detail)


print('setup wizards (Go wizard, Linux wizard and its ZIP copy)')
for p in ('internal/setup/wizard.html', 'installer-linux/wizard.html', 'linux-amd64/wizard.html'):
    w = read(p)
    check(f'{p}: checks against pwMin, not a fixed number',
          'if (p1.length < pwMin) return fail("Use at least " + pwMin + " characters.");' in w)
    check(f'{p}: pwMin comes from /api/state min_password', 's.min_password > 0' in w and 'pwMin = s.min_password' in w)
    check(f'{p}: the note under the field shows the same number', 'id="pw-min"' in w)
    check(f'{p}: no leftover fixed minimum', not re.search(r'p1\.length < \d', w))
check('the Linux wizard and its ZIP copy are identical',
      read('installer-linux/wizard.html') == read('linux-amd64/wizard.html'))

print("launch.bat's console prompt")
bat = read('launch.bat')
check('starts from the default, 8', '\r\necho $min = 8\r\n' in bat)
check('reads min_password_length through gobbonet.exe',
      "config get min_password_length" in bat and "Join-Path $env:GOBBONET_DIR 'gobbonet.exe'" in bat)
check('never below the floor, 4', '[Math]::Max^(4, [int]' in bat)
check('no leftover fixed $min', not re.search(r'echo \$min = (?!8\r)', bat))
check('still CRLF', '\n' not in bat.replace('\r\n', ''))

print('Windows installer page')
nsi = read('installer-win/gobbonet.nsi')
check('the installer asks for the default, 8', '${If} $3 < 8' in nsi and '"Use at least 8 characters."' in nsi)
check('no leftover 10', '${If} $3 < 10' not in nsi)
check('the page says the same number it checks (it said six until 1.7.9)', '"Eight characters minimum.' in nsi and 'Six characters minimum' not in nsi)

print('documented')
check('config.toml template documents min_password_length', 'min_password_length = 8' in read('internal/config/file.go'))
check('README names the setting', 'min_password_length' in read('README.md'))

print('\n%s' % ('all passed' if not failures else '%d FAILED' % failures))
sys.exit(1 if failures else 0)
