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

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"

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

:: llama.cpp. Normally already gone with its parent; killed directly in case
:: it was orphaned by an earlier crash, because it holds the GPU.
call :stop_image "llama-server.exe"

:: The legacy PowerShell file server, from installs that predate the Go
:: server. Targeted by COMMAND LINE, not by image name: killing every
:: powershell.exe on the machine would take unrelated work with it, and
:: someone running an uninstaller has not agreed to that.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*fileserver.ps1*' }); if ($p.Count -gt 0) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 10 } else { exit 0 }" >nul 2>&1
if errorlevel 10 (
    if not defined QUIET echo  [OK] Stopped the legacy PowerShell file server.
    set "STOPPED=1"
)

:: Give Windows a moment to release the file handles. Without this the
:: delete that follows can still fail on a process that has just exited.
if "!STOPPED!"=="1" ping -n 2 127.0.0.1 >nul 2>&1

if not defined QUIET (
    echo.
    if defined FAILED (
        echo  [!] Something would not stop. Close it and run this again,
        echo      or reboot -- a reboot always clears it.
    ) else if "!STOPPED!"=="1" (
        echo  [OK] Done. Nothing of GobboNet's is running now.
    ) else (
        echo  [OK] Nothing was running.
    )
    echo.
    pause
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
    ping -n 2 127.0.0.1 >nul 2>&1
)

tasklist /fi "imagename eq !_IMG!" 2>nul | findstr /i "!_IMG!" >nul 2>&1
if not errorlevel 1 (
    echo  [!] Could not stop !_IMG!. Close it and run this again.
    :: FAILED, not STOPPED: reporting "nothing is running now" while something
    :: still holds the port is the exact false reassurance this script exists
    :: to remove.
    endlocal & set "STOPPED=1" & set "FAILED=1" & goto :eof
)
echo  [OK] Stopped !_IMG!
endlocal & set "STOPPED=1" & goto :eof

:after_subs
