@echo off
:: EnableDelayedExpansion is required: the web UI port is resolved at
:: runtime into WEB_PORT and every rule below refers to it with !WEB_PORT!.
:: With plain setlocal those would expand to literal text and the firewall
:: rules would be written for a port called "!WEB_PORT!" -- which fails
:: quietly and looks exactly like a firewall that did not work.
setlocal EnableDelayedExpansion
title Gemma 4 -- LAN Access Setup (one-time)
color 0A

echo.
echo  ====================================================
echo   GEMMA 4 -- LAN ACCESS SETUP
echo.
echo   This script configures Windows to let your phone
echo   connect to the chat over your local network.
echo.
echo   Access is limited to devices on your local subnet,
echo   and the chat itself requires a password (set in
echo   launch.bat). The wider internet cannot reach it, and
echo   nobody on your network gets in without the password.
echo.
echo   NOTE: if you re-run this after an earlier version, it
echo   will UPDATE the existing rules to the current scope.
echo.
echo   It must be run ONCE as Administrator.
echo   You do NOT need to run this again after the first
echo   time, even after reboots.
echo  ====================================================
echo.

:: Check for admin
net session >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] This script must be run as Administrator.
    echo.
    echo          Right-click setup-lan.bat and choose
    echo          "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  [OK] Running with Administrator privileges.
echo.

:: ---------------------------------------------------------------
:: Resolve the web UI port exactly the way launch.bat does, or the
:: firewall rule and the URL ACL end up on a port nothing listens on --
:: which looks like a broken firewall and is nothing of the kind.
:: ---------------------------------------------------------------
set "WEB_PORT="
if exist "%~dp0.gobbonet-port" (
    for /f "usebackq delims=" %%P in ("%~dp0.gobbonet-port") do if not defined WEB_PORT set "WEB_PORT=%%P"
)
if defined GEMMA_LISTEN_PORT set "WEB_PORT=!GEMMA_LISTEN_PORT!"
if not defined WEB_PORT set "WEB_PORT=9066"
echo !WEB_PORT!| findstr /r "^[0-9][0-9]*$" >nul 2>&1
if errorlevel 1 set "WEB_PORT=9066"
if !WEB_PORT! lss 1024 set "WEB_PORT=9066"
if !WEB_PORT! gtr 32767 set "WEB_PORT=9066"
echo  [OK] Web UI port: !WEB_PORT!

:: Service ports, resolved exactly as launch.bat resolves them. llama.cpp
:: moved off 11434 because that is Ollama's default and the two collided.
if defined GEMMA_LLM_PORT (
    set "LLM_PORT=!GEMMA_LLM_PORT!"
) else (
    set "LLM_PORT=11437"
)
if defined GEMMA_SEARCH_PORT (
    set "SEARCH_PORT=!GEMMA_SEARCH_PORT!"
) else (
    set "SEARCH_PORT=11435"
)
echo  [OK] llama.cpp port: !LLM_PORT!   search proxy port: !SEARCH_PORT!
echo.

:: ---------------------------------------------------------------
:: FIREWALL RULES
:: ---------------------------------------------------------------
echo  [..] Adding firewall rules...

netsh advfirewall firewall show rule name="Gemma4-LLM" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-LLM" dir=in action=allow protocol=TCP localport=!LLM_PORT! profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-LLM (port !LLM_PORT!, llama.cpp, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-LLM" new dir=in action=allow protocol=TCP localport=!LLM_PORT! profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-LLM (re-scoped to local subnet only)
)

netsh advfirewall firewall show rule name="Gemma4-Search" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-Search" dir=in action=allow protocol=TCP localport=11435 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-Search (port 11435, search proxy, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-Search" new dir=in action=allow protocol=TCP localport=11435 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-Search (re-scoped to local subnet only)
)

netsh advfirewall firewall show rule name="Gemma4-Web" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-Web" dir=in action=allow protocol=TCP localport=!WEB_PORT! profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-Web (port !WEB_PORT!, file server, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-Web" new dir=in action=allow protocol=TCP localport=!WEB_PORT! profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-Web (re-scoped to local subnet only)
)

echo.

:: ---------------------------------------------------------------
:: mDNS (.local hostname) -- enable on the PRIVATE profile only
::
:: Windows ships with built-in 'mDNS (UDP-In)' rules. We enable the
:: rule on Private AND Public profiles, scoped to the local subnet,
:: so phones can resolve <PC>.local on a home network regardless of
:: how Windows auto-classified it (home Wi-Fi is often tagged Public,
:: which would otherwise block .local resolution).
::
:: Access is still bounded two ways: remoteip=LocalSubnet keeps the
:: wider internet out, and the file server itself requires a password
:: (set in launch.bat). So even another device on the same Wi-Fi must
:: know the password to reach your chats -- the firewall and the
:: password together are the boundary, not the network profile alone.
::
:: Why .local matters: when users bookmark http://<PC>.local:<port>
:: instead of the IP, the browser keeps localStorage stable across
:: IP rotations (same hostname = same origin). No more lost chats
:: when DHCP hands out a new lease.
:: ---------------------------------------------------------------
echo  [..] Enabling mDNS (.local hostname) on Private + Public profiles...

netsh advfirewall firewall set rule name="mDNS (UDP-In)" new enable=yes profile=private,public >nul 2>&1
if errorlevel 1 (
    :: Older builds may not have the canonical rule name. Add a fresh
    :: one as a fallback so the .local hostname still works -- scoped
    :: to private + local subnet to match the service rules.
    netsh advfirewall firewall show rule name="Gemma4-mDNS" >nul 2>&1
    if errorlevel 1 (
        netsh advfirewall firewall add rule name="Gemma4-mDNS" dir=in action=allow protocol=UDP localport=5353 profile=private,public remoteip=LocalSubnet >nul
        echo  [OK] Firewall rule added: Gemma4-mDNS (UDP 5353, .local resolution, local subnet only)
    ) else (
        echo  [OK] Firewall rule already exists: Gemma4-mDNS
    )
) else (
    echo  [OK] Built-in 'mDNS (UDP-In)' rule enabled on the Private profile.
)

echo.

:: ---------------------------------------------------------------
:: URL ACL RESERVATIONS
:: PowerShell's HttpListener needs permission to bind to non-
:: localhost addresses. These one-time reservations grant that.
::
:: GOTCHA: `netsh http show urlacl url=<x>` ALWAYS exits with code 0
:: whether or not a reservation actually exists -- when nothing
:: matches, it just prints the "URL Reservations:" header with no
:: entries underneath. So we can't use `if errorlevel 1` to detect
:: a missing ACL. Instead, pipe the output through findstr looking
:: for the "Reserved URL" line that appears in real entries; that
:: gives us a reliable signal we can branch on.
::
:: Background: an earlier version of this script used the errorlevel
:: check, which silently always reported "already exists" and never
:: actually added anything. If Windows Update (or System Restore, or
:: a driver rollback) wipes UrlAclInfo from the registry, the script
:: looked successful but did nothing. The new check actually works.
:: ---------------------------------------------------------------
echo  [..] Adding URL ACL reservations...


:: ---------------------------------------------------------------
:: LOCALE INDEPENDENCE -- read this before simplifying anything below.
::
:: The previous version stacked three English-only assumptions, and on a
:: localised Windows they combined into a script that reported success
:: while doing nothing at all:
::
::   1. findstr matched an ENGLISH netsh header. On a German or French
::      Windows that header is translated, the match always failed, and
::      the script always took the "add" branch.
::   2. The account name in the add command is LOCALISED -- Jeder, Tout
::      le monde, Todos, Wszyscy -- so the add failed with "no such
::      account".
::   3. >nul swallowed that error and nothing checked errorlevel, so it
::      printed [OK] URL ACL added having added nothing.
::
:: Fixes: match on the URL itself, which is never translated; use the
:: SDDL form, where WD is the well-known Everyone SID S-1-1-0 and is
:: byte-identical on every locale; and VERIFY afterwards.
::
:: This matters more than it looks. "I ran setup-lan.bat and it said OK"
:: was being treated as proof the ACL existed, which sent diagnosis of
:: the web-port failures down the wrong path.
:: ---------------------------------------------------------------

call :add_urlacl !SEARCH_PORT! "search proxy"
call :add_urlacl !WEB_PORT! "file server"

:: Upgrade cleanup. Installs before 1.5.5 defaulted to 8080 and left a URL
:: ACL behind for it. It is harmless but it is also a reservation on a port
:: half the developer world wants, which is the exact rudeness that
:: prompted the move. Drop it if we are no longer using it.
if not "!SEARCH_PORT!"=="11435" (
    netsh http show urlacl url=http://+:11435/ 2>nul | findstr /i ":11435/" >nul 2>&1
    if not errorlevel 1 (
        netsh http delete urlacl url=http://+:11435/ >nul 2>&1
        echo  [OK] Removed the old URL ACL for http://+:11435/ ^(no longer used^)
    )
)

if not "!WEB_PORT!"=="8080" (
    netsh http show urlacl url=http://+:8080/ 2>nul | findstr /i ":8080/" >nul 2>&1
    if not errorlevel 1 (
        netsh http delete urlacl url=http://+:8080/ >nul 2>&1
        echo  [OK] Removed the old URL ACL for http://+:8080/ ^(no longer used^)
    )
)

:: ---------------------------------------------------------------
:: RESERVED PORT RANGES -- the one failure this script cannot repair.
::
:: Hyper-V, WSL2, Docker Desktop and the Windows NAT service reserve
:: large dynamic TCP blocks, and a web port can land inside one often enough to
:: be a leading suspect. A reserved port refuses to bind even when it is
:: genuinely free, and even when elevated. netstat cannot see the
:: reservation, so "netstat says nothing is on that port" is true and
:: misleading at once. Say so, rather than letting someone re-run this
:: script forever.
:: ---------------------------------------------------------------
echo  [..] Checking reserved TCP port ranges...
set "PORT_RESERVED="
for /f "tokens=1,2" %%A in ('netsh interface ipv4 show excludedportrange protocol^=tcp 2^>nul') do (
    echo %%A| findstr /r "^[0-9][0-9]*$" >nul 2>&1
    if not errorlevel 1 (
        echo %%B| findstr /r "^[0-9][0-9]*$" >nul 2>&1
        if not errorlevel 1 (
            if %%A leq !WEB_PORT! if %%B geq !WEB_PORT! set "PORT_RESERVED=%%A-%%B"
        )
    )
)
if defined PORT_RESERVED (
    echo  [!] Port !WEB_PORT! is inside a RESERVED range ^(!PORT_RESERVED!^).
    echo      Windows will refuse the bind even though nothing is using
    echo      the port, and even for an Administrator. This script cannot
    echo      fix that. Pick one:
    echo.
    echo        a^) Use a different port. Before launching, run:
    echo             set GEMMA_LISTEN_PORT=8420
    echo           then start launch.bat from that same window.
    echo.
    echo        b^) Reserve !WEB_PORT! back for normal use, then REBOOT:
    echo             netsh int ipv4 add excludedportrange protocol=tcp startport=!WEB_PORT! numberofports=1
) else (
    echo  [OK] Port !WEB_PORT! is not inside a reserved range.
)

echo.
echo  ====================================================
echo   All done! You can now run launch.bat normally.
echo.
echo   Your phone will be able to connect at:
echo     http://%COMPUTERNAME%.local:!WEB_PORT!  [recommended]
echo     http://YOUR_PC_IP:!WEB_PORT!            [alternate]
echo.
echo   The .local URL is preferred -- it stays the same
echo   even when your PC's IP rotates, so your phone's
echo   bookmark and saved chats never break.
echo.
echo   launch.bat will show the exact URLs when it starts.
echo.
echo   To UNDO these changes later, run:
echo     netsh advfirewall firewall delete rule name="Gemma4-LLM"
echo     netsh advfirewall firewall delete rule name="Gemma4-Search"
echo     netsh advfirewall firewall delete rule name="Gemma4-Web"
echo     netsh advfirewall firewall delete rule name="Gemma4-mDNS"
echo     netsh http delete urlacl url=http://+:11435/
echo     netsh http delete urlacl url=http://+:!WEB_PORT!/
echo  ====================================================

:: ===============================================================
:: :add_urlacl <port> <label>
:: Adds a URL ACL for http://+:<port>/ and confirms it landed.
:: goto :eof above this guard stops the main flow falling into it.
:: ===============================================================
goto :after_subs

:add_urlacl
setlocal EnableDelayedExpansion
set "_PORT=%~1"
set "_LABEL=%~2"

:: Match the URL, not the header. netsh translates its headers; it does
:: not translate the reservation it is printing.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if not errorlevel 1 (
    echo  [OK] URL ACL already exists: http://+:!_PORT!/ ^(!_LABEL!^)
    endlocal & goto :eof
)

:: SDDL form. WD is the Everyone SID; GX is the generic-execute right
:: HTTP.SYS checks when handing out a prefix reservation.
netsh http add urlacl url=http://+:!_PORT!/ sddl=D:(A;;GX;;;WD) >nul 2>&1

:: Verify instead of assuming. This is the entire point of the rewrite.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Could not add a URL ACL for http://+:!_PORT!/ ^(!_LABEL!^)
    echo          Run this by hand in this window and paste the output:
    echo            netsh http add urlacl url=http://+:!_PORT!/ sddl=D:^(A;;GX;;;WD^)
    echo          Without it, GobboNet falls back to this PC only -- the
    echo          chat still works locally, but phones will not reach it.
) else (
    echo  [OK] URL ACL added: http://+:!_PORT!/ ^(!_LABEL!^)
)
endlocal & goto :eof

:after_subs
echo.
pause