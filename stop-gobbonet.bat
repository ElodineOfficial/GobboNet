@echo off
:: Stops everything GobboNet may have left running.
::
:: WHY THIS EXISTS. The uninstaller used to go straight to deleting
:: gobbonet.exe without stopping anything first. A running process holds
:: both its own file and the folder open, so the delete fails and Windows
:: reports "the folder is still open in another program" -- which reads as
:: a stuck uninstall, and leaves a server still holding the web port after
:: the user believes the program is gone.
::
:: Run by the installer before it overwrites files, by the uninstaller
:: before it deletes them, and safe to run by hand any time.
setlocal EnableDelayedExpansion

:: ---------------------------------------------------------------
:: TOOL PATH ANCHOR -- silences "The system cannot find the drive
:: specified." (issues #36, #17, #37)
::
:: Every external tool this script uses -- powershell, curl, tar,
:: certutil, reg, findstr, netsh, tasklist, taskkill, timeout, ping,
:: where -- ships in System32. Naming one bare, the way batch files
:: normally do, makes Windows walk %PATH% folder by folder until it
:: finds a match. A dead entry anywhere ahead of System32 in that
:: list -- an unmapped network drive, a USB stick that is gone, a
:: leftover from an uninstalled program -- makes the walk print
::
::     The system cannot find the drive specified.
::
:: once per lookup, then carry on and find the tool anyway. Nothing
:: is broken. But it is the first thing on screen and it reads like
:: a failure, which is why it keeps getting reported.
::
:: Putting System32 at the FRONT of the search order means every one
:: of those lookups hits on the first folder tried, so a dead entry
:: further down is never probed and never gets to complain. It also
:: means nothing earlier in %PATH% can shadow curl or certutil --
:: worth having, since those two download and checksum the models.
::
:: This is NOT the working-directory bug it is usually mistaken for.
:: The installer's shortcuts already start in the install folder
:: (SetOutPath "$INSTDIR" runs before CreateShortcut), and every path
:: below is built from %~dp0 rather than from the current directory.
:: Adding `cd /d "%~dp0"` therefore changes nothing -- see #37, where
:: it was tried and the message stayed.
::
:: We only touch %PATH% once we have confirmed a real System32, so a
:: machine with an odd %SystemRoot% is left exactly as it was.
:: ---------------------------------------------------------------
set "SYS32=%SystemRoot%\System32"
if not exist "%SYS32%\cmd.exe" set "SYS32=%windir%\System32"
if exist "%SYS32%\cmd.exe" set "PATH=%SYS32%;%SYS32%\WindowsPowerShell\v1.0;%PATH%"

set "QUIET="
:: The install folder whose processes this stops. By default the folder this
:: script is in; the installer passes $INSTDIR, because before it replaces
:: files it runs a copy of this script from its temporary plugins folder,
:: where %~dp0 is not the install (issue #63).
set "GN_DIR=%~dp0"
:args
if "%~1"=="" goto :args_done
if /i "%~1"=="/quiet" (
    set "QUIET=1"
) else if exist "%~1\" (
    set "GN_DIR=%~f1"
    if "!GN_DIR:~-1!"=="\" set "GN_DIR=!GN_DIR:~0,-1!"
    set "GN_DIR=!GN_DIR!\"
)
shift
goto :args
:args_done

if not defined QUIET (
    echo.
    echo  ====================================================
    echo   GOBBONET -- STOP RUNNING PROCESSES
    echo  ====================================================
    echo.
)

set "STOPPED=0"
set "FAILED="

:: The server itself. It supervises llama-server, so it goes first and is
:: given a moment to take its child down cleanly.
call :stop_image "gobbonet.exe"

:: Everything below is matched to THIS install, never by name alone (issue
:: #63). The names are generic: a llama-server.exe someone runs from their own
:: llama.cpp build, another program's launch.bat or fileserver.ps1. Someone
:: stopping GobboNet, or running its uninstaller, has not agreed to lose those.

:: The launch.bat windows of this install -- the window that ran gobbonet.exe,
:: and on a 1.7.x install the health monitor, which would otherwise restart
:: llama-server below. Matched by the full path of this folder's launch.bat on
:: the command line. The window this script is running in, and the ones that
:: started it, are never touched. (From PR #59, orcmaul.)
call :stop_matching "cmd.exe" cmdline "launch.bat" "the launch.bat window"

:: llama.cpp. Normally already gone with its parent; stopped directly in case
:: it was orphaned by an earlier crash, because it holds the GPU. Matched by
:: where the executable lives: inside this install. An engine configured to
:: run from elsewhere still stops with gobbonet.exe, its parent, above.
call :stop_matching "llama-server.exe" path "" "llama-server"

:: The legacy PowerShell file server, removed in 1.8.0. One started before an
:: upgrade keeps running -- and keeps the web port -- until something stops
:: it, so it is still stopped here. Matched by this install's copy on the
:: command line: killing every powershell.exe would take unrelated work with
:: it.
call :stop_matching "powershell.exe" cmdline "fileserver.ps1" "the legacy PowerShell file server"

:: Give Windows a moment to release the file handles. Without this the
:: delete that follows can still fail on a process that has just exited.
if "!STOPPED!"=="1" ping -n 2 127.0.0.1 >nul 2>&1

if not defined QUIET (
    echo.
    rem Pause only when something needs reading; otherwise close by itself
    rem after a few seconds, or at once on a keypress. From PR #59.
    if defined FAILED (
        echo  [*] Something would not stop. Close it and run this again,
        echo      or reboot -- a reboot always clears it.
        echo.
        pause
    ) else if "!STOPPED!"=="1" (
        echo  [OK] Done. Nothing of GobboNet's is running now.
        echo.
        timeout /t 10 >nul
    ) else (
        echo  [OK] Nothing was running.
        echo.
        timeout /t 10 >nul
    )
)
if defined FAILED exit /b 1
exit /b 0

:: ===============================================================
:: :stop_image <exe name> -- stop it if it is running, politely then not.
:: ===============================================================
goto :after_subs

:stop_image
setlocal EnableDelayedExpansion
set "_IMG=%~1"
tasklist /fi "imagename eq !_IMG!" 2>nul | findstr /i "!_IMG!" >nul 2>&1
if errorlevel 1 (
    endlocal & goto :eof
)

:: Ask first. A clean exit lets the server shut its child down and release
:: the port itself, which /F does not.
taskkill /IM "!_IMG!" >nul 2>&1
ping -n 3 127.0.0.1 >nul 2>&1

tasklist /fi "imagename eq !_IMG!" 2>nul | findstr /i "!_IMG!" >nul 2>&1
if not errorlevel 1 (
    taskkill /F /IM "!_IMG!" >nul 2>&1
    rem Longer than the polite wait: a forced kill can take a few seconds to
    rem release the GPU and the port. From PR #59.
    ping -n 6 127.0.0.1 >nul 2>&1
)

tasklist /fi "imagename eq !_IMG!" 2>nul | findstr /i "!_IMG!" >nul 2>&1
if not errorlevel 1 (
    echo  [*] Could not stop !_IMG!. Close it and run this again.
    rem FAILED, not STOPPED: reporting 'nothing is running now' while something
    rem still holds the port is the exact false reassurance this script exists
    rem to remove.
    endlocal & set "STOPPED=1" & set "FAILED=1" & goto :eof
)
echo  [OK] Stopped !_IMG!
endlocal & set "STOPPED=1" & goto :eof

:: ===============================================================
:: :stop_matching <process name> <path^|cmdline> <file in the install> <label>
::
:: Stops the processes of that name that belong to THIS install (GN_DIR):
::   path     its executable lives anywhere under GN_DIR
::   cmdline  its command line names GN_DIR plus <file>
:: The process running this script and every process above it are skipped,
:: so running it from a launch.bat window cannot end its own window.
::
:: The values travel in environment variables rather than inside the
:: command, so a folder with spaces, quotes or brackets in its name cannot
:: break the quoting. The PowerShell carries no ! % or ^, which cmd would
:: eat with delayed expansion on. Exit: 0 none found, 10 all stopped,
:: 11 something survived. Matching is case-insensitive, as Windows paths are.
:: ===============================================================
:stop_matching
set "GN_NAME=%~1"
set "GN_MODE=%~2"
set "GN_FILE=%~3"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:GN_DIR; $mode=$env:GN_MODE; $needle=$d+$env:GN_FILE; $skip=@{}; $q=$PID; while ($q -and -not $skip.ContainsKey([int]$q)) { $skip[[int]$q]=1; $q=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$q) -ErrorAction SilentlyContinue).ParentProcessId }; $p=@(Get-CimInstance Win32_Process -Filter ('Name='''+$env:GN_NAME+'''') -ErrorAction SilentlyContinue | Where-Object { $v = if ($mode -eq 'path') { $_.ExecutablePath } else { $_.CommandLine }; if (-not $v -or $skip.ContainsKey([int]$_.ProcessId)) { $false } elseif ($mode -eq 'path') { $v.StartsWith($needle, [StringComparison]::OrdinalIgnoreCase) } else { $v.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } }); if ($p.Count -eq 0) { exit 0 }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; for ($i=0; $i -lt 20; $i++) { if (-not @($p | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })) { exit 10 }; Start-Sleep -Milliseconds 250 }; exit 11" >nul 2>&1
set "_RC=!errorlevel!"
set "GN_NAME="
set "GN_MODE="
set "GN_FILE="
if "!_RC!"=="10" (
    if not defined QUIET echo  [OK] Stopped %~4.
    set "STOPPED=1"
)
if "!_RC!"=="11" (
    echo  [*] Could not stop %~4. Close it and run this again.
    set "STOPPED=1"
    set "FAILED=1"
)
goto :eof

:after_subs
