# Run after extracting the full update into your GobboNet installation folder.
# Only this user's GobboNet links are changed; no administrator access needed.
$ErrorActionPreference = 'Stop'
$installDir = $PSScriptRoot
$exe = Join-Path $installDir 'gobbonet.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Extract the full GobboNet update here before repairing shortcuts.'
}
$shell = New-Object -ComObject WScript.Shell
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'GobboNet'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
function Set-GobboNetLink($path, $target, $arguments) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $target
    $link.Arguments = $arguments
    $link.WorkingDirectory = $installDir
    $link.IconLocation = (Join-Path $installDir 'gobbonet.ico')
    $link.Save()
}
Set-GobboNetLink (Join-Path $menu 'GobboNet.lnk') $exe 'launch'
Set-GobboNetLink (Join-Path $menu 'Launch GobboNet.lnk') $exe 'launch'
Set-GobboNetLink (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'GobboNet.lnk') $exe 'launch'
# Through gobbonet.exe so setup runs in a kill-on-close job (1.7.9, PR #15).
Set-GobboNetLink (Join-Path $menu 'Setup or add a model.lnk') $exe 'launch --setup'
Write-Host 'Shortcuts repaired. Open Launch GobboNet from the Start menu.'
Write-Host 'If a taskbar pin still opens the old launcher, unpin it and pin the repaired shortcut.'
