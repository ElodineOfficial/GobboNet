@echo off
setlocal
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
:: FIREWALL RULES
:: ---------------------------------------------------------------
echo  [..] Adding firewall rules...

:: Ports 11434 (llama-server) and 11435 (search proxy) do NOT get a rule.
:: Both bind 127.0.0.1 only -- launch.bat passes --host 127.0.0.1 and the
:: proxy listens on http://127.0.0.1:11435/ -- so nothing on the LAN can
:: reach them and an inbound rule only stands to expose whatever else might
:: bind those ports later. Only 8080, the file server the phone actually
:: talks to, needs to be reachable. Earlier versions did open them, so they
:: are removed here rather than left behind.
netsh advfirewall firewall show rule name="Gemma4-LLM" >nul 2>&1
if not errorlevel 1 (
    netsh advfirewall firewall delete rule name="Gemma4-LLM" >nul
    echo  [OK] Firewall rule removed: Gemma4-LLM ^(port 11434 is loopback-only^)
)

netsh advfirewall firewall show rule name="Gemma4-Search" >nul 2>&1
if not errorlevel 1 (
    netsh advfirewall firewall delete rule name="Gemma4-Search" >nul
    echo  [OK] Firewall rule removed: Gemma4-Search ^(port 11435 is loopback-only^)
)

netsh advfirewall firewall show rule name="Gemma4-Web" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-Web" dir=in action=allow protocol=TCP localport=8080 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-Web (port 8080, file server, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-Web" new dir=in action=allow protocol=TCP localport=8080 profile=private,public remoteip=LocalSubnet >nul
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
:: Why .local matters: when users bookmark http://<PC>.local:8080
:: instead of the IP, the browser keeps localStorage stable across
:: IP rotations (same hostname = same origin). No more lost chats
:: when DHCP hands out a new lease.
:: ---------------------------------------------------------------
echo  [..] Enabling mDNS (.local hostname) on the Private profile...

netsh advfirewall firewall set rule name="mDNS (UDP-In)" new enable=yes >nul 2>&1
if errorlevel 1 (
    :: Older builds may not have the canonical rule name. Add a fresh
    :: one as a fallback so the .local hostname still works -- scoped
    :: to private + local subnet to match the service rules.
    netsh advfirewall firewall show rule name="Gemma4-mDNS" >nul 2>&1
    if errorlevel 1 (
        netsh advfirewall firewall add rule name="Gemma4-mDNS" dir=in action=allow protocol=UDP localport=5353 profile=private remoteip=LocalSubnet >nul
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
::
:: SCOPE: these reservations used to be granted to `Everyone`, which is a
:: permanent, machine-wide grant letting ANY local account -- including a
:: low-privilege or service account -- bind those ports on every interface.
:: An account that starts first could squat 8080 and serve a look-alike login
:: page to phones on the LAN, harvesting the chat password. The reservation is
:: now granted to the single account running the setup. Older installs that
:: still carry the Everyone grant are detected and re-scoped below.
echo  [..] Adding URL ACL reservations...

set "ACL_USER=%USERDOMAIN%\%USERNAME%"
echo       Granting to: %ACL_USER%
echo       (this must be the account you run launch.bat as -- if you elevated
echo        with a different admin account, re-run this from your own account)

call :ensure_urlacl 11435 "search proxy"
call :ensure_urlacl 8080 "file server"

echo.
echo  ====================================================
echo   All done! You can now run launch.bat normally.
echo.
echo   Your phone will be able to connect at:
echo     http://%COMPUTERNAME%.local:8080  [recommended]
echo     http://YOUR_PC_IP:8080            [alternate]
echo.
echo   The .local URL is preferred -- it stays the same
echo   even when your PC's IP rotates, so your phone's
echo   bookmark and saved chats never break.
echo.
echo   launch.bat will show the exact URLs when it starts.
echo.
echo   To UNDO these changes later, run:
echo     netsh advfirewall firewall delete rule name="Gemma4-Web"
echo     netsh advfirewall firewall delete rule name="Gemma4-mDNS"
echo     netsh http delete urlacl url=http://+:11435/
echo     netsh http delete urlacl url=http://+:8080/
echo  ====================================================
echo.
pause

goto :eof

:ensure_urlacl
:: %1 = port, %2 = description. Adds the reservation for %ACL_USER%, and
:: replaces an existing one that was granted to Everyone.
netsh http show urlacl url=http://+:%~1/ | findstr /i "Reserved URL" >nul
if errorlevel 1 (
    netsh http add urlacl url=http://+:%~1/ user=%ACL_USER% >nul
    echo  [OK] URL ACL added: http://+:%~1/ ^(%~2^)
    exit /b
)
netsh http show urlacl url=http://+:%~1/ | findstr /i "Everyone" >nul
if errorlevel 1 (
    echo  [OK] URL ACL already scoped: http://+:%~1/ ^(%~2^)
    exit /b
)
netsh http delete urlacl url=http://+:%~1/ >nul
netsh http add urlacl url=http://+:%~1/ user=%ACL_USER% >nul
echo  [OK] URL ACL re-scoped: http://+:%~1/ ^(%~2 -- was Everyone^)
exit /b
