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

:: Fallback for when gobbonet.exe cannot answer -- missing, quarantined, or a
:: config it cannot read. .gobbonet-port records the port last actually bound.
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
:: No search port any more -- gobbonet.exe serves /search itself, so
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
echo  [*] Windows has marked the network this PC is on as PUBLIC.
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
echo  [*] Windows would not change the network to Private. Do it by hand:
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
echo  [*] Opening GobboNet on PUBLIC networks too ^(cafes, hotels, airports^).
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
    echo  [*] Found !GN_BLOCKED! rule^(s^) blocking gobbonet.exe. Removing them --
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
:: URL RESERVATIONS -- removed, never added (1.8.0)
::
:: An HTTP.SYS URL reservation (netsh http add urlacl) was only ever for
:: the PowerShell server, which listened through HTTP.SYS. gobbonet.exe
:: binds with Winsock and needs none, and that server was removed in
:: 1.8.0. So this script adds no reservation, and it removes the ones
:: older versions left behind:
::
::   * the web port's. Up to 1.7.8 it was granted to Everyone, and any
::     account on this PC could use it to serve its own page -- a fake
::     sign-in, say -- at the chat's address while GobboNet is stopped.
::     A reservation with nothing behind it also makes Windows answer the
::     port with 503 by itself. Nothing needs it now.
::   * 11435, the old search proxy's, and 8080, the default before 1.5.5.
::
:: GOTCHA: `netsh http show urlacl url=<x>` ALWAYS exits 0, whether or not
:: anything matched, so only findstr's result can be branched on. And it
:: matches the URL, never netsh's header text: the header is translated
:: on a localised Windows, the URL never is. Each removal is verified,
:: because "it said OK" was once taken as proof of something that had not
:: happened at all.
:: ---------------------------------------------------------------
echo  [..] Removing URL reservations from older versions, if any...
call :drop_urlacl !WEB_PORT!
call :drop_urlacl 11435
if not "!WEB_PORT!"=="8080" call :drop_urlacl 8080
echo  [OK] No URL reservation is needed; gobbonet.exe does not use one.
echo.

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
    echo  [*] Port !WEB_PORT! is inside a RESERVED range ^(!PORT_RESERVED!^).
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
echo   All done. You can now run launch.bat normally.
echo.
echo   Your phone will be able to connect at:
echo     http://%COMPUTERNAME%.local:!WEB_PORT!  [recommended]
echo     http://YOUR_PC_IP:!WEB_PORT!            [alternate]
echo.
echo   The .local URL is preferred -- it stays the same
echo   even when your PC's IP rotates, so your phone's
echo   bookmark and saved chats never break.
echo.
echo   GobboNet shows the exact URLs when it starts.
echo.
echo   To UNDO these changes later, right-click this and
echo   choose "Run as administrator":
echo     teardown-lan.bat
echo.
echo   That matters more than it sounds. The firewall rules
echo   made above live in Windows, not in this folder --
echo   uninstalling, deleting the folder and reinstalling all
echo   leave them in place. teardown-lan.bat is what clears them.
echo  ====================================================

:: ===============================================================
:: :drop_urlacl <port>
:: Removes the URL reservation http://+:<port>/ if there is one, and
:: checks that it went. goto :after_subs stops the main flow falling
:: into it.
:: ===============================================================
goto :after_subs

:drop_urlacl
setlocal EnableDelayedExpansion
set "_PORT=%~1"
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 endlocal & goto :eof
netsh http delete urlacl url=http://+:!_PORT!/ >nul 2>&1
netsh http show urlacl url=http://+:!_PORT!/ 2>nul | findstr /i ":!_PORT!/" >nul 2>&1
if errorlevel 1 (
    echo  [OK] Removed the old URL reservation for http://+:!_PORT!/ ^(nothing uses it^)
) else (
    echo  [*] Could not remove the URL reservation for http://+:!_PORT!/
    echo      Remove it from an Administrator window with:
    echo          netsh http delete urlacl url=http://+:!_PORT!/
)
endlocal & goto :eof

:after_subs
echo.
pause