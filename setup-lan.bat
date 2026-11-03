@echo off
:: EnableDelayedExpansion is required: the web UI port is resolved at
:: runtime into WEB_PORT and every rule below refers to it with !WEB_PORT!.
:: With plain setlocal those would expand to literal text and the firewall
:: rules would be written for a port called "!WEB_PORT!" -- which fails
:: quietly and looks exactly like a firewall that did not work.
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
title GobboNet -- LAN Access Setup (one-time)
color 0A

echo.
echo  ====================================================
echo   GOBBONET -- LAN ACCESS SETUP
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
echo   Home and work networks only. To allow Public networks
echo   ^(cafes, hotels^) as well, run:  setup-lan.bat /public
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
set "WEB_PORT_SRC="

:: ASK THE BINARY FIRST. `gobbonet config get listen_port` resolves the port
:: exactly as the server will: the config file, then GOBBONET_* / GEMMA_*
:: overrides on top. That is the whole resolution order in one call, and it is
:: the only source here that is correct BEFORE the server has ever run.
::
:: Three separate failures came out of not doing this:
::
::   1. .gobbonet-port is written AFTER a successful bind, which on a first run
::      is minutes away past the model load. The installer's finish page starts
::      gobbonet.exe and this script in the same second, so the file has never
::      existed yet and we always fell through to the default.
::   2. 1.5.5 moved the default from 8080 to 9066, but a config written before
::      that carries 8080 explicitly and config.toml lives in %USERPROFILE%,
::      outside the install folder, where no uninstaller touches it. So an
::      upgrader is on 8080 and we opened 9066 -- for as many reinstalls as
::      they cared to try.
::   3. Only GEMMA_LISTEN_PORT was read here. The binary prefers
::      GOBBONET_LISTEN_PORT and warns that GEMMA_* is deprecated, so anyone
::      who followed the deprecation moved the server and not the firewall.
::
:: All three are the same bug -- the rule on a port nothing listens on -- and
:: all three are gone if we stop reproducing the resolution and just ask.
if exist "%~dp0gobbonet.exe" (
    for /f "usebackq delims=" %%P in (`"%~dp0gobbonet.exe" config get listen_port 2^>nul`) do if not defined WEB_PORT_SRC set "WEB_PORT_SRC=%%P"
    if defined WEB_PORT_SRC (
        set "GN_RAWPORT=!WEB_PORT_SRC!"
        for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "($env:GN_RAWPORT -replace '[^0-9]','')"`) do set "WEB_PORT=%%D"
        set "GN_RAWPORT="
        if defined WEB_PORT echo  [OK] Port read from the GobboNet config.
    )
)

:: Fallback for the launch.bat / fileserver.ps1 path, which has no gobbonet.exe
:: to ask. .gobbonet-port records the port that was last actually bound.
if not defined WEB_PORT (
    if exist "%~dp0.gobbonet-port" (
        rem Digits only, matching launch.bat. If these two ever disagree about the
        rem port, the firewall rule and the URL reservation land on a port nothing
        rem listens on -- which looks like a broken firewall and is nothing of the
        rem kind. Same parse, same result, whatever wrote the file.
        set "WEB_PORT_SRC="
        for /f "usebackq delims=" %%P in ("%~dp0.gobbonet-port") do if not defined WEB_PORT_SRC set "WEB_PORT_SRC=%%P"
        set "GN_RAWPORT=!WEB_PORT_SRC!"
        for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "($env:GN_RAWPORT -replace '[^0-9]','')"`) do set "WEB_PORT=%%D"
        set "GN_RAWPORT="
    )
    rem GOBBONET_ wins over GEMMA_, matching the binary's own precedence.
    if defined GEMMA_LISTEN_PORT set "WEB_PORT=!GEMMA_LISTEN_PORT!"
    if defined GOBBONET_LISTEN_PORT set "WEB_PORT=!GOBBONET_LISTEN_PORT!"
)
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
:: No search port any more -- fileserver.ps1 serves /search itself, so
:: nothing binds 11435. The firewall rule and URL reservation for it are
:: removed below rather than maintained.
echo  [OK] llama.cpp port: !LLM_PORT!
echo.

:: ---------------------------------------------------------------
:: NETWORK PROFILES (1.7.9, PR #7)
::
:: Rules used to be written for the Domain, Private AND Public profiles.
:: Public is what Windows calls a cafe, airport or hotel network, and an
:: unencrypted chat has no business being reachable there just because the
:: laptop joined one. So the rules now cover Domain and Private only.
::
:: The catch is that Windows often labels a HOME network Public too, and on
:: such a network the phone would now be refused with no explanation. So if
:: the network this PC is on right now is Public, we say so and ask:
::
::   [P] make this network Private   -- the right fix for a home network
::   [A] allow Public networks too   -- the old behaviour, now a choice
::   [S] skip                        -- leave it; phones can't reach it here
::
:: `setup-lan.bat /public` chooses [A] without asking. The question times out
:: to [S] after 60 seconds, so an unattended run never widens anything.
::
:: No pipes in the PowerShell below, on purpose: a pipe inside a quoted
:: command needs escaping rules that differ between `for /f` and a plain
:: line, and a wrong guess makes the check fail silently.
:: ---------------------------------------------------------------
set "GN_PROFILES=domain,private"
set "GN_PROFILE_LIST=domain private"
if /i "%~1"=="/public" goto :profiles_public
set "GN_NETCAT="
for /f "usebackq delims=" %%C in (`powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; if (@(Get-NetConnectionProfile).NetworkCategory -contains 'Public') { 'public' }" 2^>nul`) do set "GN_NETCAT=%%C"
if /i not "!GN_NETCAT!"=="public" goto :profiles_done
echo  [!] Windows has marked the network this PC is on as PUBLIC.
echo      GobboNet's firewall rules cover Private and work networks only,
echo      so a phone on THIS network will not be able to connect yet.
echo.
echo      If this is your home network, make it Private. That is what
echo      Windows means it to be, and it changes nothing else here.
echo.
choice /c PAS /n /t 60 /d S /m "     [P] make this network Private   [A] allow Public networks too   [S] skip: "
if errorlevel 3 goto :profiles_skip
if errorlevel 2 goto :profiles_public
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; foreach ($p in @(Get-NetConnectionProfile)) { if ($p.NetworkCategory -eq 'Public') { Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private } }" >nul 2>&1
if errorlevel 1 goto :profiles_private_failed
echo  [OK] This network is now Private. Phones on it can connect.
goto :profiles_done
:profiles_private_failed
echo  [!] Windows would not change the network to Private. Do it by hand:
echo      Settings ^> Network ^& internet ^> your network ^> Private network.
echo      Or run:  setup-lan.bat /public
goto :profiles_done
:profiles_skip
echo  [*] Skipped. Phones can connect once this network is Private, or after
echo      running:  setup-lan.bat /public
goto :profiles_done
:profiles_public
set "GN_PROFILES=domain,private,public"
set "GN_PROFILE_LIST=domain private public"
echo  [!] Opening GobboNet on PUBLIC networks too ^(cafes, hotels, airports^).
echo      Still local subnet only and still behind your password, but the chat
echo      is not encrypted. Anyone on such a network can see the traffic.
:profiles_done
echo  [OK] Firewall profiles: !GN_PROFILES!
echo.

:: ---------------------------------------------------------------
:: FIREWALL RULES
:: ---------------------------------------------------------------
echo  [..] Adding firewall rules...

:: The Gemma4-LLM rule is gone, and any existing one is deleted.
::
:: llama-server is started with --host 127.0.0.1 (launch.bat, the generated
:: .llama-launch.cmd), so it only ever accepts loopback connections. An
:: inbound LAN rule for it could never have done anything except widen the
:: firewall for a port nothing outside this machine can reach -- and if the
:: bind address were ever changed, that rule would silently expose an
:: unauthenticated model server to the whole subnet.
::
:: The chat reaches the model through the file server's /llm proxy, which is
:: behind the password. That is the only path that should exist.
netsh advfirewall firewall show rule name="Gemma4-LLM" >nul 2>&1
if not errorlevel 1 (
    netsh advfirewall firewall delete rule name="Gemma4-LLM" >nul 2>&1
    echo  [OK] Removed the old firewall rule: Gemma4-LLM ^(loopback-only service^)
)

:: The Gemma4-Search rule opened 11435 for a proxy that no longer exists.
:: An inbound rule with nothing listening behind it is pure attack surface
:: and pure antivirus signal, so it is deleted rather than refreshed.
netsh advfirewall firewall show rule name="Gemma4-Search" >nul 2>&1
if not errorlevel 1 (
    netsh advfirewall firewall delete rule name="Gemma4-Search" >nul 2>&1
    echo  [OK] Removed the old firewall rule: Gemma4-Search ^(no longer needed^)
)

:: profile=domain is included. It was omitted for years, which meant a
:: domain-joined machine -- a work or school laptop, and people do run this on
:: one -- got no rule at all and no message saying so. The scope is still
:: LocalSubnet on every profile, so this widens nothing: a domain network the
:: user is actually on is as much "their LAN" as a home one.
:: Public is included only by choice; see NETWORK PROFILES above (1.7.9).
:: Re-running repairs an older rule that covered Public without being asked.
netsh advfirewall firewall show rule name="GobboNet-Web" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="GobboNet-Web" dir=in action=allow protocol=TCP localport=!WEB_PORT! profile=!GN_PROFILES! remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: GobboNet-Web ^(port !WEB_PORT!, local subnet only, !GN_PROFILES!^)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="GobboNet-Web" new dir=in action=allow protocol=TCP localport=!WEB_PORT! profile=!GN_PROFILES! remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: GobboNet-Web ^(re-scoped: local subnet only, !GN_PROFILES!^)
)

:: Until 1.7.8 the rule above was named Gemma4-Web, after the model the project
:: started with (issue #63). It is replaced, not kept beside the new one: two
:: allow rules for one port is twice the surface and a confusing firewall list.
:: Deleted only once GobboNet-Web is confirmed to exist, so a failed add never
:: leaves the phone with no rule at all. gobbonet doctor recognises either name.
netsh advfirewall firewall show rule name="GobboNet-Web" >nul 2>&1
if not errorlevel 1 (
    netsh advfirewall firewall show rule name="Gemma4-Web" >nul 2>&1
    if not errorlevel 1 (
        netsh advfirewall firewall delete rule name="Gemma4-Web" >nul 2>&1
        echo  [OK] Removed the old firewall rule: Gemma4-Web ^(replaced by GobboNet-Web^)
    )
)

:: ---------------------------------------------------------------
:: BLOCK RULES -- the failure that made every rule above look like a lie.
::
:: Windows raises "Windows Defender Firewall has blocked some features of this
:: app" the first time gobbonet.exe binds a network address. The install is
:: deliberately per-user and non-elevated, so that prompt arrives with no way to
:: answer it correctly -- and the installer's finish page fires the server and
:: this script in the same second, so it lands stacked under a UAC prompt.
::
:: Dismiss it, or click Cancel, and Windows writes program-scoped BLOCK rules
:: for gobbonet.exe on each profile. In Windows Firewall a Block rule beats an
:: Allow rule, so those silently override the port rule added above -- and this
:: script goes on printing [OK] for everything it did, because everything it did
:: succeeded. Nothing on the machine says otherwise. It survives reinstalling,
:: because the rules are machine-wide and the installer never made them.
::
:: So: delete them, and say so. Deleting is safe -- these are rules Windows
:: invented on our behalf from a dialog the user could not answer, not anything
:: they configured. The explicit allow below is what replaces them.
:: ---------------------------------------------------------------
echo  [..] Checking for blocking rules on gobbonet.exe...
set "GN_BLOCKED="
for /f "usebackq delims=" %%B in (`powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $n = 0; foreach ($r in @(Get-NetFirewallRule -Direction Inbound -Action Block)) { if ((Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $r).Program -like '*gobbonet.exe') { $n++ } }; $n" 2^>nul`) do set "GN_BLOCKED=%%B"
if not defined GN_BLOCKED set "GN_BLOCKED=0"
if !GN_BLOCKED! gtr 0 (
    echo  [!] Found !GN_BLOCKED! rule^(s^) blocking gobbonet.exe. Removing them --
    echo      a Block rule overrides the allow rule above, which is why phone
    echo      access can fail on a machine where this script reported success.
    powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; foreach ($r in @(Get-NetFirewallRule -Direction Inbound -Action Block)) { if ((Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $r).Program -like '*gobbonet.exe') { Remove-NetFirewallRule -InputObject $r } }" >nul 2>&1
    echo  [OK] Blocking rules removed.
) else (
    echo  [OK] No blocking rules for gobbonet.exe.
)

:: ---------------------------------------------------------------
:: PROGRAM RULE -- so the prompt above never gets a chance to appear again.
::
:: An explicit allow for the binary means Windows has its answer in advance and
:: raises no dialog on the next bind. Without it we relied on the user getting
:: one modal right, once, forever -- which is the single least reliable step in
:: the whole install.
::
:: Only when gobbonet.exe is actually here. The launch.bat path serves from
:: powershell.exe, and a rule allowing THAT would open every PowerShell script
:: on the machine to inbound LAN connections. The port rule covers that path.
:: ---------------------------------------------------------------
if exist "%~dp0gobbonet.exe" (
    netsh advfirewall firewall delete rule name="GobboNet" program="%~dp0gobbonet.exe" >nul 2>&1
    netsh advfirewall firewall add rule name="GobboNet" dir=in action=allow program="%~dp0gobbonet.exe" enable=yes profile=!GN_PROFILES! remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: GobboNet ^(gobbonet.exe, local subnet only, !GN_PROFILES!^)
)

echo.

:: ---------------------------------------------------------------
:: mDNS (.local hostname) -- for the same profiles as the rules above
::
:: Windows ships built-in 'mDNS (UDP-In)' rules, one per profile. Until
:: 1.7.9 this script re-scoped ALL of them to every profile, Public
:: included -- a change to a Windows rule that other programs rely on,
:: made on networks the user never chose (PR #7). Now it only switches
:: on the built-in rule for each profile in GN_PROFILES, and leaves the
:: networks each rule covers exactly as Windows set them.
::
:: If none matches (older builds without the built-in rules), a
:: GobboNet-mDNS rule is added instead, for GN_PROFILES and the local
:: subnet only.
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
echo  [..] Enabling mDNS ^(.local hostname^) for: !GN_PROFILES!

set "GN_MDNS_OK="
set "GN_MDNS_ANY="
for %%F in (!GN_PROFILE_LIST!) do (
    netsh advfirewall firewall set rule name="mDNS (UDP-In)" profile=%%F new enable=yes >nul 2>&1
    if not errorlevel 1 set "GN_MDNS_ANY=1"
)
if not defined GN_MDNS_ANY (
    rem Older builds may not have the canonical rule name. Add a fresh
    rem one as a fallback so the .local hostname still works -- scoped
    rem to private + local subnet to match the service rules.
    netsh advfirewall firewall show rule name="GobboNet-mDNS" >nul 2>&1
    if errorlevel 1 (
        netsh advfirewall firewall add rule name="GobboNet-mDNS" dir=in action=allow protocol=UDP localport=5353 profile=!GN_PROFILES! remoteip=LocalSubnet >nul
        if not errorlevel 1 set "GN_MDNS_OK=1"
        echo  [OK] Firewall rule added: GobboNet-mDNS ^(UDP 5353, local subnet only, !GN_PROFILES!^)
    ) else (
        set "GN_MDNS_OK=1"
        echo  [OK] Firewall rule already exists: GobboNet-mDNS
    )
) else (
    set "GN_MDNS_OK=1"
    echo  [OK] Built-in 'mDNS ^(UDP-In^)' rule enabled for: !GN_PROFILES!
)

:: The fallback rule was named Gemma4-mDNS until 1.7.8 (issue #63). Once mDNS
:: is confirmed allowed -- by the built-in rule or by GobboNet-mDNS, judged by
:: netsh's exit codes, never by its translated output -- the old one is
:: redundant and is deleted. If neither was confirmed it is left alone, so a
:: failed enable or add never takes .local resolution away.
if defined GN_MDNS_OK (
    netsh advfirewall firewall show rule name="Gemma4-mDNS" >nul 2>&1
    if not errorlevel 1 (
        netsh advfirewall firewall delete rule name="Gemma4-mDNS" >nul 2>&1
        echo  [OK] Removed the old firewall rule: Gemma4-mDNS ^(replaced^)
    )
)
set "GN_MDNS_OK="

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

:: WHO GETS THE RESERVATION (1.7.9, PR #7)
::
:: It used to be granted to Everyone (SID WD). That let ANY account on this
:: PC claim the chat's address through HTTP.SYS and serve its own page there
:: -- a fake sign-in page, say -- to every phone on the network. It is now
:: granted to one account: the person signed in at this PC's console, which
:: is who runs GobboNet. If this window was elevated with a different admin
:: account, that admin is NOT who gets it -- which is the mistake the old
:: printout could not show. If no console user can be found (a remote
:: desktop session, say), the account running this script is used.
::
:: Who that is gets printed, so a wrong guess is visible. The SID form keeps
:: the locale fix described above: no account name goes through netsh.
::
:: gobbonet.exe does not need the reservation at all: it binds with Winsock,
:: not HTTP.SYS. Only the legacy PowerShell server (deprecated, gone in 1.8)
:: uses it. So when no account can be determined the reservation is skipped
:: rather than handed to Everyone again.
set "GN_ACL_SID="
set "GN_ACL_USER="
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $u = (Get-CimInstance Win32_ComputerSystem).UserName; if (-not $u) { $u = [Security.Principal.WindowsIdentity]::GetCurrent().Name }; (New-Object Security.Principal.NTAccount($u)).Translate([Security.Principal.SecurityIdentifier]).Value" 2^>nul`) do set "GN_ACL_SID=%%S"
for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $u = (Get-CimInstance Win32_ComputerSystem).UserName; if (-not $u) { $u = [Security.Principal.WindowsIdentity]::GetCurrent().Name }; $u" 2^>nul`) do set "GN_ACL_USER=%%U"
if defined GN_ACL_SID (
    echo !GN_ACL_SID!| findstr /r "^S-1-[0-9][0-9-]*$" >nul 2>&1
    if errorlevel 1 set "GN_ACL_SID="
)
if defined GN_ACL_SID (
    echo  [OK] The reservation will belong to: !GN_ACL_USER!
) else (
    echo  [!] Could not work out which account runs GobboNet, so no URL
    echo      reservation is made. gobbonet.exe does not need one; only the
    echo      deprecated legacy PowerShell server does.
)

:: (no search proxy ACL -- nothing binds that port now)
call :add_urlacl !WEB_PORT! "file server"

:: Upgrade cleanup. Installs before 1.5.5 defaulted to 8080 and left a URL
:: ACL behind for it. It is harmless but it is also a reservation on a port
:: half the developer world wants, which is the exact rudeness that
:: prompted the move. Drop it if we are no longer using it.
:: Unconditional now: nothing binds 11435 in any configuration.
netsh http show urlacl url=http://+:11435/ 2>nul | findstr /i ":11435/" >nul 2>&1
if not errorlevel 1 (
    netsh http delete urlacl url=http://+:11435/ >nul 2>&1
    echo  [OK] Removed the old URL ACL for http://+:11435/ ^(no longer used^)
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


:: Record that LAN access was configured, and for which port. The uninstaller
:: reads this to decide whether to offer the elevated teardown at all: someone
:: who never ran this script has no rules to remove and should not be asked to
:: approve an Administrator prompt for nothing.
> "%~dp0.gobbonet-lan" echo !WEB_PORT!

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
echo   To UNDO these changes later, right-click this and
echo   choose "Run as administrator":
echo     teardown-lan.bat
echo.
echo   That matters more than it sounds. The URL reservation
echo   made above lives in the Windows kernel, not in this
echo   folder -- uninstalling, deleting the folder and
echo   reinstalling all leave it in place, and a reservation
echo   with nothing behind it makes Windows answer this port
echo   with 503 by itself. teardown-lan.bat is what clears it.
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

if not defined GN_ACL_SID endlocal & goto :eof

:: Match the URL, not the header. netsh translates its headers; it does
:: not translate the reservation it is printing.
::
:: An existing reservation is REPLACED, not kept (1.7.9): one made by an
:: older version of this script belongs to Everyone, and keeping it would
:: keep the hole. Deleting and re-adding is idempotent for a reservation
:: that is already right.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if not errorlevel 1 (
    netsh http delete urlacl url=http://+:!_PORT!/ >nul 2>&1
    echo  [OK] Replacing the existing URL reservation for http://+:!_PORT!/
)

:: SDDL form, with the SID found above; GX is the generic-execute right
:: HTTP.SYS checks when handing out a prefix reservation.
netsh http add urlacl url=http://+:!_PORT!/ sddl=D:(A;;GX;;;!GN_ACL_SID!) >nul 2>&1

:: Verify instead of assuming. This is the entire point of the rewrite.
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Could not add a URL ACL for http://+:!_PORT!/ ^(!_LABEL!^)
    echo          Run this by hand in this window and paste the output:
    echo            netsh http add urlacl url=http://+:!_PORT!/ sddl=D:^(A;;GX;;;!GN_ACL_SID!^)
    echo          gobbonet.exe does not need it. Only the deprecated legacy
    echo          PowerShell server does, and without it that falls back to
    echo          this PC only.
) else (
    echo  [OK] URL reservation added: http://+:!_PORT!/ ^(!_LABEL!, for !GN_ACL_USER! only^)
)
endlocal & goto :eof

:after_subs
echo.
pause