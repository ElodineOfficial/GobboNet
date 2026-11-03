"""Guard all distributed Windows launch entry points against batch regressions."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
for name in ('installer-win/gobbonet.nsi',):   # installer/ retired in 1.7.9
    source = (root / name).read_text()
    expanded = source.replace('${APPNAME}', 'GobboNet').replace('${APPEXE}', 'gobbonet.exe')
    if name.startswith('installer-win'):
        assert '!define APPEXE      "gobbonet.exe"' in source
    for link in ('$SMPROGRAMS\\GobboNet\\GobboNet.lnk',
                 '$SMPROGRAMS\\GobboNet\\Launch GobboNet.lnk',
                 '$DESKTOP\\GobboNet.lnk'):
        pattern = re.escape('CreateShortcut "' + link + '"') + r'\s*\\\s*"\$INSTDIR\\gobbonet.exe" "launch"'
        assert re.search(pattern, expanded), (name, link)
    assert re.search(r'(ExecShell ""|Exec) .*gobbonet.exe.*launch', expanded)
    # 1.7.9 (PR #15): setup runs through gobbonet.exe, inside its job.
    assert '"$INSTDIR\\${APPEXE}" "launch --setup" "$INSTDIR\\gobbonet.ico"' in source
repair = (root / 'repair-windows-shortcuts.ps1').read_text()
assert "$link.WorkingDirectory = $installDir" in repair
assert repair.count("$exe 'launch'") == 3
assert "Set-GobboNetLink (Join-Path $menu 'Setup or add a model.lnk') $exe 'launch --setup'" in repair
assert "GetFolderPath('Programs')" in repair
assert "GetFolderPath('DesktopDirectory')" in repair
# 1.7.8 integration: the uninstaller removes the two links the installer now
# makes (a leftover link also keeps the Start menu folder from being removed),
# and the ZIP ships the repair script next to the program.
nsi = (root / 'installer-win/gobbonet.nsi').read_text()
for link in ('Launch ${APPNAME}.lnk', 'Setup or add a model.lnk'):
    assert 'Delete "$SMPROGRAMS\\${APPNAME}\\' + link + '"' in nsi, link
assert nsi.index('Setup or add a model.lnk"') < nsi.index('RMDir  "$SMPROGRAMS\\${APPNAME}"')
make_zip = (root / 'scripts' / 'make-zip.sh').read_text()
assert '"Repair Windows shortcuts.bat" repair-windows-shortcuts.ps1' in make_zip
print('Windows installer and ZIP shortcut contracts passed (source checks).')
