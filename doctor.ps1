<#
  GobboNet doctor -- answer "why won't it let me in" without a reinstall.

  Standalone by design: no dependencies, nothing to install, no account. Drop it next to
  launch.bat and run it. Everything it checks is local, and every check names the fix.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File doctor.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File doctor.ps1 -SelfTest

  Exit codes:  0 all clear   1 a problem was found   2 could not judge

  THE CHECK THIS EXISTS FOR (D-ORPHAN below). launch.bat probes the web port before it
  spawns, and if anything answers it prints "[OK] File server already running" and reuses
  it. But the password is handed to the server by ENVIRONMENT at spawn time, so an
  orphaned fileserver.ps1 from an earlier run is still holding the OLD salt. Set a new
  password and the launcher adopts the orphan, which rejects it -- and no amount of
  deleting .gobbonet-secret, reinstalling, or disabling antivirus touches a running
  process. Only a reboot does, which is why "I rebooted and it fixed itself" is in
  launch.bat's own comments.

  From the outside every signal is reassuring: the installer accepts the password, the
  page loads, the login form appears. The only observable is that the password is wrong.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Root = '',
    [switch]$SelfTest
)

$script:Problems = 0
$script:Judged = 0

function Say-Ok   ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Say-Bad  ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:Problems++ }
function Say-Dead ($m) { Write-Host "  [????] $m" -ForegroundColor Yellow }
function Say-Info ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------------------
# Pure decision functions. Kept free of I/O so -SelfTest can drive them with fixtures --
# a doctor whose logic can only be exercised by reproducing the fault is a doctor nobody
# has ever seen work.
# ---------------------------------------------------------------------------------------

<# A stored secret is usable only if it is exactly one line of <hex>:<hex>. That is what
   fileserver.ps1 parses; anything else makes it exit before it ever listens. #>
function Test-SecretShape {
    param([string]$Text)
    if ($null -eq $Text) { return $false }
    return ($Text.Trim() -match '^[0-9a-fA-F]+:[0-9a-fA-F]+$')
}

<# THE ONE. A listener that started BEFORE the secret was last written cannot know the
   current password: it read the old value out of its environment at spawn and never
   re-reads the file. Returns $true when that mismatch is present.

   Both timestamps are required. A missing one returns $false -- "cannot tell" must not
   masquerade as "found the bug", or the doctor starts inventing faults. #>
function Test-ListenerPredatesSecret {
    param(
        [Nullable[datetime]]$ListenerStart,
        [Nullable[datetime]]$SecretWritten
    )
    if ($null -eq $ListenerStart -or $null -eq $SecretWritten) { return $false }
    return ($ListenerStart -lt $SecretWritten)
}

<# Windows reserves TCP ranges (Hyper-V, WSL, Docker) that nothing can bind. GobboNet's
   default 11434 falls inside one on some machines, and the failure is silent: the bind
   fails, the server picks another port, and nothing is listening where you were told to
   look. Ranges come from `netsh interface ipv4 show excludedportrange protocol=tcp`. #>
function Test-PortReserved {
    param([int]$Port, [array]$Ranges)
    foreach ($r in $Ranges) {
        if ($Port -ge $r.Start -and $Port -le $r.End) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------------------
function Get-ExcludedPortRanges {
    $out = @()
    try {
        $raw = netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
        foreach ($line in $raw) {
            if ($line -match '^\s*(\d+)\s+(\d+)\s*$') {
                $out += [pscustomobject]@{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
            }
        }
    } catch { }
    return $out
}

function Get-PortListener {
    param([int]$Port)
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
             Select-Object -First 1
        if (-not $c) { return $null }
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        return [pscustomobject]@{
            Pid   = $c.OwningProcess
            Name  = if ($p) { $p.ProcessName } else { 'unknown' }
            Start = if ($p) { $p.StartTime } else { $null }
        }
    } catch { return $null }
}

<# WHY $Root IS NOT `param([string]$Root = $PSScriptRoot)`.

   Measured on Windows PowerShell 5.1.26100: with [CmdletBinding()] present, $PSScriptRoot
   is EMPTY while parameter defaults are bound. Drop [CmdletBinding()] and the same default
   resolves. So the obvious spelling yields $Root = '' -- every later Join-Path throws a
   binding error, the port falls back to something the user never chose, and the doctor
   reports on a folder and a port that are not theirs. On the first real run against a
   1.6.0 tree that is exactly what happened: it named a FAIL on an unrelated program's
   listener. A doctor that invents a fault is worse than no doctor.

   Order: -Root  ->  the script's own folder  ->  the current directory. #>
function Resolve-RootFolder {
    param([string]$Explicit, [string]$ScriptRoot, [string]$Cwd)
    foreach ($c in @($Explicit, $ScriptRoot, $Cwd)) {
        if (-not [string]::IsNullOrWhiteSpace($c)) { return $c.Trim() }
    }
    return ''
}

<# The port has to be resolved the way the LAUNCHER resolves it, in the same order, or the
   doctor inspects a port nobody is using -- and "nothing is holding port 9066" is a clean
   bill of health for the exact orphan this tool exists to find.

   launch.bat 1.6.0 (lines 152-206): read .gobbonet-port and strip non-digits; then
   GEMMA_LISTEN_PORT overrides it if set; then fall back to 9066, which is also what an
   unusable value falls back to.

   An earlier version of this script scraped launch.bat for the first `set "WEB_PORT=<n>"`.
   That line IS the 9066 fallback, so it silently ignored the port the installer wrote --
   checking the default on every machine that had chosen anything else. #>
function Resolve-WebPort {
    param([string]$PortFileText, [string]$EnvPort, [int]$Default = 9066)
    foreach ($candidate in @($EnvPort, $PortFileText)) {
        $digits = ($candidate -replace '[^0-9]', '')
        if ($digits -and $digits.Length -le 5) {
            $n = [int]$digits
            if ($n -ge 1 -and $n -le 65535) { return $n }
        }
    }
    return $Default
}

# ---------------------------------------------------------------------------------------
function Invoke-SelfTest {
    Write-Host "doctor.ps1 --self-test" -ForegroundColor Cyan
    $fail = 0
    function Assert($cond, $label) {
        if ($cond) { Write-Host "  ok   $label" -ForegroundColor Green }
        else       { Write-Host "  FAIL $label" -ForegroundColor Red; $script:stFail = $true }
    }
    $script:stFail = $false

    # Secret shape
    Assert (Test-SecretShape 'a1b2:c3d4')            'accepts hex:hex'
    Assert (Test-SecretShape "a1b2:c3d4`r`n")        'tolerates a trailing newline'
    Assert (-not (Test-SecretShape ''))              'rejects empty'
    Assert (-not (Test-SecretShape 'a1b2'))          'rejects a missing half'
    Assert (-not (Test-SecretShape 'zz:c3d4'))       'rejects non-hex'

    # The orphan check -- BOTH directions, because a rule that always fires is as
    # useless as one that never does.
    $secret = Get-Date '2026-08-21 10:00:00'
    $older  = Get-Date '2026-08-21 09:00:00'
    $newer  = Get-Date '2026-08-21 10:30:00'
    Assert (Test-ListenerPredatesSecret $older $secret)          'fires: listener older than the secret'
    Assert (-not (Test-ListenerPredatesSecret $newer $secret))   'quiet: listener started after'
    Assert (-not (Test-ListenerPredatesSecret $null $secret))    'quiet: unknown start time is not a finding'
    Assert (-not (Test-ListenerPredatesSecret $older $null))     'quiet: unknown secret time is not a finding'

    # Reserved ports
    $ranges = @([pscustomobject]@{ Start = 11412; End = 11511 })
    Assert (Test-PortReserved 11434 $ranges)         'fires: 11434 inside a reserved range'
    Assert (-not (Test-PortReserved 8080 $ranges))   'quiet: 8080 outside it'
    Assert (-not (Test-PortReserved 11434 @()))      'quiet: no ranges means no finding'

    # Root resolution -- both directions, because an empty $Root is how this script
    # previously fabricated a finding against an unrelated program.
    Assert ((Resolve-RootFolder 'C:\explicit' 'C:\script' 'C:\cwd') -eq 'C:\explicit')  'root: -Root wins'
    Assert ((Resolve-RootFolder ''  'C:\script' 'C:\cwd') -eq 'C:\script')               'root: falls back to the script folder'
    Assert ((Resolve-RootFolder ''  ''          'C:\cwd') -eq 'C:\cwd')                   'root: falls back to the cwd'
    Assert ((Resolve-RootFolder '   ' ''        'C:\cwd') -eq 'C:\cwd')                   'root: whitespace is not a folder'
    Assert ((Resolve-RootFolder ''  ''          '')        -eq '')                        'root: nothing resolvable stays empty'

    # Port resolution -- must match launch.bat's order, or every other check inspects the
    # wrong port and reports a clean bill of health.
    Assert ((Resolve-WebPort '9066' '7777') -eq 7777)   'port: GEMMA_LISTEN_PORT overrides the file'
    Assert ((Resolve-WebPort '9066' '')     -eq 9066)   'port: .gobbonet-port is used when no env'
    Assert ((Resolve-WebPort "8123`r`n" '') -eq 8123)   'port: strips stray characters like the launcher does'
    Assert ((Resolve-WebPort '' '')         -eq 9066)   'port: falls back to the launcher default'
    Assert ((Resolve-WebPort 'garbage' '')  -eq 9066)   'port: an unusable file falls back, it does not crash'
    Assert ((Resolve-WebPort '99999' '')    -eq 9066)   'port: out of range falls back'

    if ($script:stFail) { Write-Host "SELF-TEST FAILED" -ForegroundColor Red; exit 1 }
    Write-Host "SELF-TEST PASS" -ForegroundColor Green
    exit 0
}

if ($SelfTest) { Invoke-SelfTest }

# ---------------------------------------------------------------------------------------
Write-Host ""
Write-Host "GobboNet doctor" -ForegroundColor Cyan

$Root = Resolve-RootFolder -Explicit $Root -ScriptRoot $PSScriptRoot -Cwd (Get-Location).Path
if ([string]::IsNullOrWhiteSpace($Root)) {
    Write-Host "  could not work out which folder to look at -- pass -Root <path>" -ForegroundColor Yellow
    exit 2
}
Write-Host "  folder: $Root"

if ($Port -le 0) {
    $portFileText = ''
    $portFile = Join-Path $Root '.gobbonet-port'
    if (Test-Path $portFile) {
        $portFileText = (Get-Content $portFile -Raw -ErrorAction SilentlyContinue)
    }
    $Port = Resolve-WebPort -PortFileText $portFileText -EnvPort $env:GEMMA_LISTEN_PORT
}
Write-Host "  web port: $Port"
Write-Host ""

# --- 1. the app is actually here ---------------------------------------------------
if (Test-Path (Join-Path $Root 'chat.html')) {
    Say-Ok 'chat.html is present'; $script:Judged++
} else {
    Say-Bad "chat.html is NOT in $Root -- run this from the folder you installed into"
    $script:Judged++
}

# --- 2. the stored secret --------------------------------------------------------------
$secretPath = Join-Path $Root '.gobbonet-secret'
$secretWritten = $null
if (-not (Test-Path $secretPath)) {
    Say-Info "no .gobbonet-secret yet -- launch.bat will ask you to set one (that is normal"
    Say-Info "on a first run). Note the leading DOT; Explorer hides it by default."
} else {
    $script:Judged++
    $secretWritten = (Get-Item $secretPath).LastWriteTime
    $text = Get-Content $secretPath -Raw -ErrorAction SilentlyContinue
    if (Test-SecretShape $text) {
        Say-Ok ".gobbonet-secret parses (written $secretWritten)"
    } else {
        Say-Bad ".gobbonet-secret is empty, truncated or not <hex>:<hex>"
        Say-Info "fix: delete it and run  launch.bat reset-password"
    }
}

# --- 3. THE ORPHAN CHECK ---------------------------------------------------------------
$listener = Get-PortListener -Port $Port
if (-not $listener) {
    Say-Ok "nothing is holding port $Port"; $script:Judged++
} else {
    $script:Judged++
    Say-Info "port $Port is held by PID $($listener.Pid) ($($listener.Name)), started $($listener.Start)"
    if (Test-ListenerPredatesSecret $listener.Start $secretWritten) {
        Say-Bad "that server STARTED BEFORE your password was set -- it cannot accept it."
        Say-Info "This is the 'password works in the installer, not in the browser' bug."
        Say-Info "The password is passed to the server when it starts, so a server already"
        Say-Info "running has the OLD one and never re-reads the file. Deleting"
        Say-Info ".gobbonet-secret, reinstalling and turning off antivirus all change nothing."
        Say-Info ""
        Say-Info "fix:  Stop-Process -Id $($listener.Pid) -Force"
        Say-Info "      then run launch.bat again."
    } elseif ($listener.Name -notmatch 'powershell|pwsh') {
        Say-Bad "port $Port is owned by $($listener.Name), which is not GobboNet."
        Say-Info "Choose another port, or stop that program."
    } else {
        Say-Ok "the running server is newer than the secret -- consistent"
    }
}

# --- 4. reserved port ranges -----------------------------------------------------------
$ranges = Get-ExcludedPortRanges
if ($ranges.Count -eq 0) {
    Say-Dead "could not read Windows' reserved port ranges -- skipping that check"
} else {
    $script:Judged++
    if (Test-PortReserved -Port $Port -Ranges $ranges) {
        Say-Bad "port $Port is inside a Windows RESERVED range -- nothing can bind it."
        Say-Info "Windows hands these to Hyper-V/WSL/Docker. The bind fails silently and"
        Say-Info "the server ends up on some other port, so nothing is listening where you"
        Say-Info "were told to look. Pick a port outside every reserved range."
    } else {
        Say-Ok "port $Port is not in a Windows reserved range"
    }
}

Write-Host ""
if ($script:Judged -eq 0) {
    Write-Host "could not judge anything -- is this the GobboNet folder?" -ForegroundColor Yellow
    exit 2
}
if ($script:Problems -gt 0) {
    Write-Host "$($script:Problems) problem(s) found." -ForegroundColor Red
    exit 1
}
Write-Host "All clear ($($script:Judged) checks)." -ForegroundColor Green
exit 0
