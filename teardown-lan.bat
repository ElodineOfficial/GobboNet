@echo off
:: EnableDelayedExpansion for the same reason setup-lan.bat needs it: the
:: port is resolved at runtime into WEB_PORT and every command below refers
:: to it with !WEB_PORT!. With plain setlocal those expand to literal text
:: and the deletes silently target a port called "!WEB_PORT!".
setlocal EnableDelayedExpansion
title GobboNet -- Remove LAN Access
color 0A

echo.
echo  ====================================================
echo   GOBBONET -- REMOVE LAN ACCESS
echo.
echo   This undoes setup-lan.bat: the firewall rules and
echo   the URL reservation it made.
echo.
echo   WHY THIS EXISTS AS A SCRIPT.
echo   The URL reservation is stored in the Windows kernel
echo   (HTTP.SYS), not in the GobboNet folder. Uninstalling
echo   GobboNet, deleting the folder and reinstalling all
echo   leave it exactly where it was -- and a reservation
echo   with no server behind it makes Windows answer that
echo   port with "503 Service Unavailable" all by itself.
echo.
echo   That is why a broken port can survive a reinstall.
echo   This is the only thing that clears it.
echo.
echo   It must be run as Administrator.
echo  ====================================================
echo.

:: Check for admin. netsh http delete urlacl and the firewall deletes both
:: require it, and without elevation they fail quietly -- which would leave
:: the exact stale reservation this script exists to remove.
net session >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] This script must be run as Administrator.
    echo.
    echo          Right-click teardown-lan.bat and choose
    echo          "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  [OK] Running with Administrator privileges.
echo.

:: ---------------------------------------------------------------
:: Resolve the port EXACTLY as setup-lan.bat resolved it, or we delete a
:: reservation for one port and leave the real one in place.
::
:: .gobbonet-port is now written by gobbonet.exe itself when it binds, so
:: this reads the port that was actually served rather than a guess.
:: ---------------------------------------------------------------
set "WEB_PORT="
set "WEB_PORT_SRC="
if exist "%~dp0.gobbonet-port" (
    for /f "usebackq delims=" %%P in ("%~dp0.gobbonet-port") do if not defined WEB_PORT_SRC set "WEB_PORT_SRC=%%P"
    set "GN_RAWPORT=!WEB_PORT_SRC!"
    for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "($env:GN_RAWPORT -replace '[^0-9]','')"`) do set "WEB_PORT=%%D"
    set "GN_RAWPORT="
)
:: An explicit argument wins over everything: the uninstaller passes the
:: port it recorded, and a user cleaning up by hand can name one.
if not "%~1"=="" set "WEB_PORT=%~1"
if defined GEMMA_LISTEN_PORT if "%~1"=="" set "WEB_PORT=!GEMMA_LISTEN_PORT!"
if not defined WEB_PORT set "WEB_PORT=9066"
echo !WEB_PORT!| findstr /r "^[0-9][0-9]*$" >nul 2>&1
if errorlevel 1 set "WEB_PORT=9066"
echo  [OK] Web UI port: !WEB_PORT!
echo.

:: ---------------------------------------------------------------
:: FIREWALL RULES
::
:: All four names are attempted, including the two that current versions no
:: longer create. An upgrade from an older install can still be carrying
:: them, and leaving a stale allow rule behind is the kind of thing nobody
:: finds later.
:: ---------------------------------------------------------------
echo  [..] Removing firewall rules...
call :drop_rule "Gemma4-Web"
call :drop_rule "Gemma4-mDNS"
call :drop_rule "Gemma4-LLM"
call :drop_rule "Gemma4-Search"
echo.

:: ---------------------------------------------------------------
:: URL RESERVATIONS -- the part that survives a reinstall.
:: ---------------------------------------------------------------
echo  [..] Removing URL reservations...
call :drop_urlacl !WEB_PORT!
:: Legacy ports from older layouts. Nothing binds either one now.
call :drop_urlacl 11435
call :drop_urlacl 8080
echo.

:: The marker setup-lan.bat leaves so the uninstaller knows LAN access was
:: configured. Once the rules are gone it is no longer true.
if exist "%~dp0.gobbonet-lan" del /f /q "%~dp0.gobbonet-lan" >nul 2>&1

echo  ====================================================
echo   Done. LAN access has been removed.
echo.
echo   The chat still works on this PC. To let phones back
echo   on your network reach it, run setup-lan.bat again.
echo  ====================================================
echo.
:: Only pause when a human is watching. The uninstaller passes /quiet so a
:: silent teardown cannot hang the uninstall on a prompt nobody sees.
if /i not "%~2"=="/quiet" pause
exit /b 0

:: ===============================================================
:: :drop_rule <name>   -- delete a firewall rule if it is there.
:: :drop_urlacl <port> -- delete a URL reservation if it is there, and
::                        confirm it actually went.
:: goto :eof above these guards stops the main flow falling into them.
:: ===============================================================
goto :after_subs

:drop_rule
setlocal EnableDelayedExpansion
set "_NAME=%~1"
netsh advfirewall firewall show rule name="!_NAME!" >nul 2>&1
if errorlevel 1 (
    echo  [--] No firewall rule named !_NAME!
    endlocal & goto :eof
)
netsh advfirewall firewall delete rule name="!_NAME!" >nul 2>&1
netsh advfirewall firewall show rule name="!_NAME!" >nul 2>&1
if errorlevel 1 (
    echo  [OK] Removed firewall rule: !_NAME!
) else (
    echo  [ERROR] Could not remove the firewall rule !_NAME!
    echo          Run this by hand in this window:
    echo            netsh advfirewall firewall delete rule name="!_NAME!"
)
endlocal & goto :eof

:drop_urlacl
setlocal EnableDelayedExpansion
set "_PORT=%~1"

:: Match on the URL, not on a header. netsh translates its headers but not
:: the reservation it prints, so matching a header reports "nothing here" on
:: a German or French machine -- setup-lan.bat was bitten by exactly that.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 (
    echo  [--] No URL reservation for http://+:!_PORT!/
    endlocal & goto :eof
)

netsh http delete urlacl url=http://+:!_PORT!/ >nul 2>&1

:: Verify rather than assume. netsh exits 0 whether or not it did anything,
:: so the exit code proves nothing and the output has to be re-read.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 (
    echo  [OK] Removed URL reservation: http://+:!_PORT!/
) else (
    echo  [ERROR] Could not remove the URL reservation for port !_PORT!.
    echo          Run this by hand in this window and paste the output:
    echo            netsh http delete urlacl url=http://+:!_PORT!/
    echo          While it exists with nothing listening, Windows answers
    echo          that port with 503 on its own.
)
endlocal & goto :eof

:after_subs
