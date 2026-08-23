@echo off
:: ---------------------------------------------------------------
:: KEEP-OPEN GUARD -- this window can NEVER silently vanish.
:: If anything fails (a crash, a blocked tool, a bad path, even a
:: stray syntax error), the message stays on screen instead of the
:: window closing too fast to read. We relaunch ourselves once
:: inside "cmd /k", which holds the window open at a prompt no
:: matter how the script exits. The env var is inherited by the
:: relaunch, so this happens exactly once and then never again.
:: ---------------------------------------------------------------
if not defined GOBBONET_KEEPOPEN (
    set "GOBBONET_KEEPOPEN=1"
    cmd /k ""%~f0" %*"
    exit /b
)
setlocal EnableDelayedExpansion
title Gobbonet - Local AI Chat [llama.cpp]
color 0A

:: ---------------------------------------------------------------
:: PREFLIGHT -- confirm the external tools this script leans on.
::
:: All four ship in System32 on Windows 10 1803+, so on a healthy box
:: this costs a few milliseconds and prints nothing. It exists because
:: when one of them is missing the failure used to surface several
:: steps later disguised as something else -- a download that "failed"
:: with an empty log, or a password prompt that silently wrote nothing.
::
:: Each probe RUNS the tool rather than looking for the file, so a
:: present-but-broken tool is caught too.
:: ---------------------------------------------------------------
set "HAVE_CURL="
set "HAVE_PS="
set "HAVE_CERTUTIL="
set "HAVE_TAR="

curl.exe --version >nul 2>&1
if not errorlevel 1 set "HAVE_CURL=1"

:: An exit-code check is NOT enough here. Wine ships a powershell.exe
:: stub that exits cleanly while being unable to execute anything, so
:: "did it return 0" waves those systems through to fail much later
:: inside fileserver.ps1 with something unreadable. Instead we require
:: PowerShell to echo a marker back AND to resolve the .NET type the
:: file server is actually built on. Either failure means there is no
:: usable PowerShell on this machine.
set "PS_PROBE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$null=[System.Net.HttpListener]; Write-Output 'GOBBONET_PS_OK'" 2^>nul`) do set "PS_PROBE=%%P"
if /i "!PS_PROBE!"=="GOBBONET_PS_OK" set "HAVE_PS=1"

certutil -? >nul 2>&1
if not errorlevel 1 set "HAVE_CERTUTIL=1"

tar --version >nul 2>&1
if not errorlevel 1 set "HAVE_TAR=1"

:: Are we on Wine? A registry probe answers this without needing
:: PowerShell -- which matters, because putting this notice inside
:: hardware-probe.ps1 would be useless on exactly the systems that
:: need to see it.
set "ON_WINE="
reg query "HKCU\Software\Wine" >nul 2>&1
if not errorlevel 1 set "ON_WINE=1"

if defined ON_WINE (
    echo.
    echo  [*] Looks like you're running under Wine on Linux.
    echo.
    echo      GobboNet isn't built for Linux yet. That's on the list,
    echo      just not today. The Windows-specific parts are PowerShell
    echo      and a handful of System32 tools.
    echo.
    echo      If you're comfortable modifying things, carry on -- people
    echo      have already got it running this way. Nothing below will
    echo      stop you; you'll just be patching around the gaps yourself.
    echo.
)

if not defined HAVE_PS (
    echo.
    echo  [*] No working PowerShell found.
    echo.
    echo      GobboNet leans on it hard: the chat server itself
    echo      ^(fileserver.ps1^), the hardware probe and the model
    echo      identifier are all PowerShell. Those parts won't start
    echo      without it.
    echo.
    echo      Worth knowing: Wine ships a powershell.exe that exists but
    echo      can't actually run anything, so finding the file is not the
    echo      same as having it work. Check with:
    echo          powershell -Command "Write-Output 'ok'"
    echo.
    echo      On real Windows this usually means PowerShell was removed
    echo      or blocked by group policy.
    echo.
    echo      Continuing anyway. If you've swapped those pieces out
    echo      yourself, this message is expected -- ignore it.
    echo.
)

if not defined HAVE_CURL (
    echo  [*] curl.exe not found -- using PowerShell for downloads instead.
    echo      Slower and without a progress bar, but functional. curl ships
    echo      in System32 on Windows 10 1803+; a missing one usually means
    echo      System32 has been dropped from PATH.
)
if not defined HAVE_CERTUTIL (
    echo  [*] certutil.exe not found -- downloads cannot be checksum-verified.
    echo      They will still be size-checked before use.
)

:: ===============================================================
:: CONFIG - edit these if you want a different model or port
:: ===============================================================
:: ---------------------------------------------------------------
:: SERVICE PORTS
::
:: 11434 was llama.cpp's port here, and 11434 is also Ollama's default.
:: On any machine with Ollama installed -- which is a lot of them -- the
:: two collide, and the failure was ugly: the launcher saw *something*
:: answering on 11434, said "llama-server already running", skipped
:: starting its own, then discovered nothing was healthy and restarted
:: into a port Ollama already owned. A restart loop caused entirely by
:: sharing a well-known port with the most popular tool in the category.
::
:: Moved to 11437. Same reasoning as leaving 8080 for the web UI: a good
:: default does not squat where the neighbours already live.
::
:: All three are overridable for the same reason the web port is.
:: ---------------------------------------------------------------
if defined GEMMA_LLM_PORT (
    set "SERVER_PORT=!GEMMA_LLM_PORT!"
) else (
    set "SERVER_PORT=11437"
)
:: ---------------------------------------------------------------
:: WEB UI PORT
::
:: Default 9066 ("gobb" on a phone keypad). It used to be 8080, which was
:: a mistake: 8080 is the single most contended port on a developer
:: machine. Tomcat, Jenkins, countless dev servers and half of every
:: tutorial reach for it, and Hyper-V, WSL2, Docker Desktop and the
:: Windows NAT service reserve dynamic blocks that swallow it. A default
:: that squats on the port everyone else wants is a bad neighbour, and it
:: made GobboNet the thing you had to shut down to get work done.
::
:: 9066 sits above the common dev range and outside the usual reserved
:: blocks. Nothing else standard claims it.
::
:: Resolution order, highest first:
::   1. GEMMA_LISTEN_PORT   -- one-off override for a single run
::   2. .gobbonet-port      -- written by the installer if you chose one
::   3. 9066                -- the default
:: ---------------------------------------------------------------
set "WEB_PORT="
set "WEB_PORT_SRC="
if exist "%~dp0.gobbonet-port" (
    :: Digits only, deliberately.
    ::
    :: A plain `for /f` read of this file is fragile in ways that all look
    :: identical from the outside: a UTF-8 BOM, a UTF-16 file (which some
    :: installer toolchains produce), a trailing CR, or a stray space each
    :: yield a value that fails the numeric test below. The old code then
    :: fell back to 9066 SILENTLY -- so a user who picked 8420 during setup
    :: got 9066 with no explanation, which reads exactly like "custom ports
    :: do not work". Strip everything that is not a digit and the file
    :: parses the same whatever wrote it.
    for /f "usebackq delims=" %%P in ("%~dp0.gobbonet-port") do if not defined WEB_PORT_SRC set "WEB_PORT_SRC=%%P"
    if defined HAVE_PS (
        set "GN_RAWPORT=!WEB_PORT_SRC!"
        for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "($env:GN_RAWPORT -replace '[^0-9]','')"`) do set "WEB_PORT=%%D"
        set "GN_RAWPORT="
    ) else (
        set "WEB_PORT=!WEB_PORT_SRC!"
    )
)
if defined GEMMA_LISTEN_PORT set "WEB_PORT=!GEMMA_LISTEN_PORT!"
if not defined WEB_PORT set "WEB_PORT=9066"

:: Reject anything that is not a plain number in the usable range rather
:: than passing it to HttpListener and getting an opaque bind failure. Every
:: rejection below SAYS SO -- a silently corrected port is indistinguishable
:: from a broken feature.
echo !WEB_PORT!| findstr /r "^[0-9][0-9]*$" >nul 2>&1
if errorlevel 1 (
    echo  [*] Could not read a port number from .gobbonet-port -- using 9066.
    if defined WEB_PORT_SRC echo      The file contained: "!WEB_PORT_SRC!"
    echo      Delete .gobbonet-port and reinstall, or put a single number in it.
    set "WEB_PORT=9066"
)
if !WEB_PORT! lss 1024 (
    echo  [*] Web port !WEB_PORT! is below 1024 ^(reserved by Windows^) -- using 9066.
    set "WEB_PORT=9066"
)
:: Upper bound is 32767, not 65535, on purpose. Windows hands out
:: ephemeral client ports from 49152 upward, and the dynamic ranges that
:: Hyper-V, WSL2 and Docker reserve live in the high tens of thousands
:: too. A listener parked up there can be stolen by an outbound socket
:: that grabbed the same number first, which produces an intermittent
:: bind failure that is miserable to diagnose. Staying below 32768 keeps
:: us clear of both, and 9066 is comfortably inside it.
if !WEB_PORT! gtr 32767 (
    echo  [*] Web port !WEB_PORT! is above 32767 -- using 9066.
    echo      Ports above that overlap Windows' ephemeral and reserved
    echo      ranges and can be taken by an outbound connection.
    set "WEB_PORT=9066"
)
set "CTX_SIZE=16384"
set "GPU_LAYERS=99"
set "KV_CACHE_TYPE=q8_0"

:: ---------------------------------------------------------------
:: SECURITY -- access password (hashed, set by you on first run)
::
:: The web UI is password-gated: anyone on your Wi-Fi can reach port
:: the web UI port, so without a password a roommate/guest/IoT device could read
:: your chats and use your GPU.
::
:: There is NO password baked into this file. On first run you choose
:: one; we store only a salted SHA-256 HASH of it in ".gobbonet-secret"
:: (kept next to this script and excluded from source control). The
:: plaintext is never written to disk and never put in an environment
:: variable -- only the salt+hash are passed to the file server, which
:: re-hashes what you type at login and compares.
::
:: To change the password later: run  launch.bat reset-password
:: (or just delete the .gobbonet-secret file and relaunch).
::
:: llama-server is bound to 127.0.0.1 (loopback) below, so it is not
:: reachable from the LAN at all -- only this machine's file server
:: proxy can talk to it. That binding is the access control for the
:: model; no separate API key is needed.
:: ---------------------------------------------------------------
set "SECRET_FILE=%~dp0.gobbonet-secret"

:: Allow "launch.bat reset-password" to force re-entry.
if /i "%~1"=="reset-password" (
    if exist "!SECRET_FILE!" del "!SECRET_FILE!"
    echo  [..] Password reset requested -- you'll set a new one now.
)

if not exist "!SECRET_FILE!" call :setup_password
if not exist "!SECRET_FILE!" (
    echo  [ERROR] No password was set. Cannot start securely. Exiting.
    pause
    exit /b 1
)

:: Load the stored salt:hash for handoff to the file server.
::
:: This is validated on EVERY run, not just the run that created it.
:: Previously the first-run path checked what landed on disk and every
:: later run read the file blind -- so if .gobbonet-secret was later
:: emptied, truncated or locked by antivirus, ACCESS_SECRET came back
:: empty, GEMMA_ACCESS_SECRET was empty, and fileserver.ps1 exited
:: instantly inside a hidden window. From the outside that is
:: indistinguishable from a port or firewall failure, and it sends
:: everyone hunting the wrong thing.
set "ACCESS_SECRET="
for /f "usebackq delims=" %%S in ("!SECRET_FILE!") do if not defined ACCESS_SECRET set "ACCESS_SECRET=%%S"

if not defined ACCESS_SECRET (
    echo.
    echo  [ERROR] .gobbonet-secret exists but is empty or unreadable.
    echo          Antivirus locking the file is the usual cause.
    echo.
    echo          Fix: delete it and run launch.bat again to set a new
    echo          password:
    echo             del "!SECRET_FILE!"
    echo.
    pause
    exit /b 1
)

:: Ask the consumer's own question -- fileserver.ps1 tests this exact
:: pattern at startup, so a pass here cannot become a failure there.
if not defined HAVE_PS goto :secret_shape_ok
set "GN_PWCHECK=!ACCESS_SECRET!"
powershell -NoProfile -Command "if ($env:GN_PWCHECK -match '^([0-9a-fA-F]+):([0-9a-fA-F]+)$') { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 goto :secret_shape_bad
set "GN_PWCHECK="
goto :secret_shape_ok

:secret_shape_bad
set "GN_PWCHECK="
echo.
echo  [ERROR] .gobbonet-secret is malformed. Expected one line of
echo          ^<hex^>:^<hex^> with no trailing newline.
echo.
echo          Fix: delete it and run launch.bat again to set a new one:
echo             del "!SECRET_FILE!"
echo.
pause
exit /b 1

:secret_shape_ok

:: CTX_SIZE notes:
::   This is the default starting value. When you pick a model from
::   the download menu, the script will automatically suggest a better
::   value for that model's architecture and your likely VRAM.
::   You can always override it here manually.
::
:: KV_CACHE_TYPE options:
::   f16   = full precision (best quality, ~8-12K max on 16 GB)
::   q8_0  = 8-bit quantized (~30-45K tokens on 16 GB) [DEFAULT]
::   q4_0  = 4-bit quantized (65K+ tokens, slight quality loss)
::
:: MODEL_GGUF - leave empty to auto-detect, or set a specific filename.
::   If only one .gguf exists in models\, it is used automatically.
::   If multiple .gguf files exist, the script will ask you to choose.

:: Model metadata - set automatically by the download menu or filename
:: detection. You can also set these manually if you know your model.
::
:: MODEL_THINK_FMT - how the model emits chain-of-thought:
::   none     = no thinking         (Llama, Mistral, Phi, Gemma 3 base, Command R)
::   deepseek = <think>...</think>  (R1, Qwen3, QwQ, GLM thinking, Granite, Hunyuan)
::   harmony  = <|channel|>...      (gpt-oss-20b, gpt-oss-120b)
::   gemma    = <channel|>          (Gemma 4)
::
:: chat.html accepts a few aliases (qwen, qwen3, gpt-oss, oss, think, etc.)
:: but the launch script writes the canonical name above to active-model.json.
set "MODEL_ID=custom"
set "MODEL_DISPLAY=Custom GGUF"
set "MODEL_FAMILY=custom"
set "MODEL_MAX_CTX=131072"
set "MODEL_THINK_FMT=none"

:: MODEL_USE_JINJA / MODEL_CHAT_TEMPLATE - chat-template handling.
::   Default is --jinja (use the template baked into the GGUF). That works
::   for most modern GGUFs (Gemma 4 channels, gpt-oss Harmony, Mistral Small
::   v7-tekken, Qwen3 think mode, etc.).
::
::   Some model families have a chat_template that --jinja cannot render
::   cleanly. The classic case is Mistral Nemo merges (MN-*, *-nemo-*):
::   mergekit-produced GGUFs often have an incomplete or mangled
::   chat_template inherited from Mistral-Nemo-Instruct-2407's tool-calling
::   blocks. With --jinja, minja chokes on the [AVAILABLE_TOOLS] /
::   [TOOL_CALLS] sections and the model either fails to load, returns 500s,
::   or echoes the raw system prompt instead of chatting.
::
::   The fix for those models: drop --jinja and tell llama-server to use its
::   built-in C++ template by name (set MODEL_USE_JINJA=0 and
::   MODEL_CHAT_TEMPLATE=<name>). Available built-in template names include:
::     mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7, mistral-v7-tekken,
::     llama2, llama3, chatml, gemma, gpt-oss, deepseek3, ... (see llama-server
::     --help for the full list).
::
::   CAUTION: "mistral-v7-tekken" was added to llama.cpp's built-in name table
::   only in recent builds; the build this project pins does NOT know it. If you
::   set an unrecognized name, llama-server treats the literal text as the
::   template body and the model is fed that constant string instead of your
::   chat (it ends up babbling about "tekken"). Use "mistral-v7" for Mistral
::   Small 24B / its finetunes -- the guard further down rewrites the -tekken
::   form to it automatically, but don't rely on that; prefer the working name.
::
::   The :identify_model block below sets these per family.
set "MODEL_USE_JINJA=1"
set "MODEL_CHAT_TEMPLATE="
set "MODEL_CHAT_TEMPLATE_FILE="

:: Install folder (relative to this script)
set "LLAMA_DIR=%~dp0llama-cpp"
set "MODEL_DIR=%~dp0models"
set "SERVER_EXE=!LLAMA_DIR!\llama-server.exe"
set "LOG_FILE=%~dp0llama-server.log"

:: llama.cpp release pin. The auto-download verifies the zip's SHA-256 against
:: the digest GitHub's API reports for the asset, then only extracts on a match.
:: Pinning to a known-good tag (rather than always taking 'latest') means a bad
:: or hijacked future release can't silently land on users' machines -- you bump
:: this deliberately after testing a new build. Leave empty to use 'latest'.
set "LLAMA_PIN_TAG=b9294"
:: SHA-256 of llama-b9294-bin-win-vulkan-x64.zip as GitHub publishes it.
::
:: Pinning means the zip is refused if the asset is ever replaced under the
:: same tag (GitHub permits that), if a TLS-intercepting proxy substitutes
:: it, or if the download is simply truncated -- none of which HTTPS alone
:: catches. This matters more here than almost anywhere else in the file:
:: the zip contains the executables that run the model.
::
:: This value must correspond to LLAMA_PIN_TAG above; if you bump the tag,
:: clear this and re-pin from the next download. Leaving it EMPTY still
:: works but now asks for confirmation before running the result.
::
:: Verified 2026-08-19 by downloading the asset and hashing it, not copied
:: from a third party.
set "LLAMA_PIN_SHA256=1aff5b8159303b44a5570b85f99d730336935314dec389f0857f992699f43d44"

:: LAUNCH_SCRIPT holds the cmd line we hand to the OS to start llama-server.
:: It lives in the project root (not %TEMP%) on purpose: fileserver.ps1
:: needs to be able to overwrite it during a hot-swap, and the monitor
:: loop here needs the same fixed location to restart after a crash.
:: Either party may rewrite this file; whichever did it last wins, and
:: the next restart picks up the new contents. Keep these paths in sync
:: with fileserver.ps1's GEMMA_LAUNCH_SCRIPT / SwapLock / SwapStatus.
set "LAUNCH_SCRIPT=%~dp0.llama-launch.cmd"
set "SWAP_LOCK=%~dp0.swap-in-progress"
set "SWAP_STATUS=%~dp0.swap-status.json"

:: Model GGUF - set this to use a specific file.
:: Leave empty to auto-detect the first .gguf in the models folder.
set "MODEL_GGUF="

:: ---------------------------------------------------------------
:: EMBEDDING SERVER (RAG Retriever A) -- optional, CPU by default
::
:: A second llama-server instance with --embeddings powers semantic
:: retrieval for the RAG. It is OPTIONAL: if the model cannot be
:: fetched or the server will not start, chat works normally and the
:: RAG falls back to tag-only retrieval (Retriever B). It is CPU-only
:: by default (EMBED_GPU_LAYERS=0) so it never steals VRAM from the
:: chat model -- embeddings are cheap on CPU. Set EMBED_GPU_LAYERS=99
:: to opt into GPU offload.
::
:: To disable entirely: set EMBED_ENABLE=0.
:: nomic-embed-text wants the search_document:/search_query: task
:: prefixes (chat.html adds them) and mean pooling (--pooling mean,
:: set in the launch line further down). A lighter alternative is
:: bge-small-en; if you swap models, update EMBED_MODEL_GGUF + URL.
:: ---------------------------------------------------------------
set "EMBED_ENABLE=1"
if defined GEMMA_EMBED_PORT (
    set "EMBED_PORT=!GEMMA_EMBED_PORT!"
) else (
    set "EMBED_PORT=11436"
)
:: SEARCH_PORT is gone. Web search is served by fileserver.ps1 on the web UI
:: port now, so nothing binds 11435 and GEMMA_SEARCH_PORT no longer does
:: anything. Setting it is harmless; it is simply ignored.
set "EMBED_CTX=2048"
set "EMBED_GPU_LAYERS=0"
set "EMBED_MODEL_GGUF=nomic-embed-text-v1.5.Q8_0.gguf"
set "EMBED_MODEL_URL=https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf?download=true"
:: Known-good SHA-256 of the embedding GGUF -- the sha256 HuggingFace
:: records for that LFS object. Leave EMPTY to download without verifying;
:: the script then prints the hash and the exact line to paste here (same
:: mechanism as LLAMA_PIN_SHA256 above).
::
:: The failure mode here is deliberately softer than the engine's: a
:: mismatch discards the file and leaves semantic retrieval off rather than
:: failing the launch, because this model is optional. That softness is
:: also why a WRONG pin is dangerous in a quiet way -- it would turn RAG
:: off for every user with no obvious cause -- so the mismatch message
:: below names that possibility explicitly.
set "EMBED_PIN_SHA256=3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7"
set "EMBED_LOG_FILE=%~dp0embed-server.log"
set "EMBED_LAUNCH_SCRIPT=%~dp0.embed-launch.cmd"

goto :main

:: ===============================================================
:fatal
echo.
echo  [FATAL] See the error above. Press any key to close.
pause >nul
exit /b 1

:prompt_yn
:: Usage: call :prompt_yn "Question?" RESULT_VAR
:: Sets RESULT_VAR to Y or N
set "%~2=N"
set /p "_YN=%~1 (Y/N): "
if /i "!_YN!"=="Y" set "%~2=Y"
if /i "!_YN!"=="YES" set "%~2=Y"
exit /b

:setup_password
:: First-run password setup. Reads the password WITHOUT echoing, confirms it,
:: enforces a minimum length, then writes a salted SHA-256 hash to SECRET_FILE.
:: All of this happens inside PowerShell so the plaintext never lands in a
:: batch variable, the environment, or the console.
::
:: We write the PowerShell to a temp .ps1 and run it with -File rather than
:: cramming it into -Command with caret line-continuations. The -File form is
:: immune to batch's quoting / caret / delayed-expansion quirks, which is the
:: difference between "works on every machine" and "breaks mysteriously on one".
:: The target path is passed via an env var (read with $env:) so spaces in the
:: path can't break anything.
echo.
echo  ====================================================
echo   SET YOUR ACCESS PASSWORD  (first-time setup)
echo.
echo   This password protects the chat from anyone else on
echo   your network. You'll enter it once here, then type it
echo   on your phone/browser the first time you connect.
echo.
echo   It is stored only as a salted hash -- not as plain
echo   text -- and never leaves this machine.
echo  ====================================================
echo.
set "GOBBONET_SECRET_OUT=!SECRET_FILE!"
set "PW_SCRIPT=%TEMP%\gobbonet_setpw_%RANDOM%.ps1"
(
echo $min = 6
echo while ^($true^) {
echo     $p1 = Read-Host 'Enter a password' -AsSecureString
echo     $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR^($p1^)
echo     $t1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR^($b1^)
echo     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR^($b1^)
echo     if ^($t1.Length -lt $min^) { Write-Host ^("  Too short -- use at least $min characters."^) -Foreground Yellow; continue }
echo     $p2 = Read-Host 'Confirm password' -AsSecureString
echo     $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR^($p2^)
echo     $t2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR^($b2^)
echo     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR^($b2^)
echo     if ^($t1 -ne $t2^) { Write-Host '  Passwords did not match -- try again.' -Foreground Yellow; continue }
echo     $saltBytes = New-Object byte[] 16
echo     [Security.Cryptography.RandomNumberGenerator]::Create^(^).GetBytes^($saltBytes^)
echo     $salt = ^([BitConverter]::ToString^($saltBytes^) -replace '-'^).ToLower^(^)
echo     $sha = [Security.Cryptography.SHA256]::Create^(^)
echo     $bytes = [Text.Encoding]::UTF8.GetBytes^($salt + $t1^)
echo     $hash = ^([BitConverter]::ToString^($sha.ComputeHash^($bytes^)^) -replace '-'^).ToLower^(^)
echo     Set-Content -Path $env:GOBBONET_SECRET_OUT -Value ^($salt + ':' + $hash^) -Encoding ascii -NoNewline
echo     Write-Host '  [OK] Password set.' -Foreground Green
echo     break
echo }
) > "!PW_SCRIPT!"
powershell -NoProfile -ExecutionPolicy Bypass -File "!PW_SCRIPT!"
del /f /q "!PW_SCRIPT!" >nul 2>&1
set "GOBBONET_SECRET_OUT="

:: Verify what actually reached the disk, rather than assuming PowerShell
:: succeeded. It can fail here in ways that print nothing useful: an
:: execution policy that blocks -File, a Set-Content -NoNewline on
:: PowerShell older than 5.0, or a redirected stdin that makes Read-Host
:: return empty. Every one of those used to surface as "No password was
:: set. Cannot start securely." several lines later, with no hint why.
::
:: The file must be one line of <hex>:<hex> -- that is exactly what
:: fileserver.ps1 parses at startup, so if it does not match here it was
:: never going to work there either.
set "PW_OK="
set "PW_LINE="
set "PW_TRIES=0"

:pw_verify_read
set /a PW_TRIES+=1
set "PW_LINE="
if exist "!SECRET_FILE!" (
    for /f "usebackq delims=" %%S in ("!SECRET_FILE!") do if not defined PW_LINE set "PW_LINE=%%S"
)
:: Antivirus real-time scanning can hold a brief lock on a file the instant
:: it is created, so the first read straight after Set-Content occasionally
:: comes back empty through nobody's fault. Give it a few seconds before
:: concluding anything.
if not defined PW_LINE if !PW_TRIES! lss 5 (
    timeout /t 1 /nobreak >nul 2>&1
    goto :pw_verify_read
)

if not defined PW_LINE goto :pw_verdict
if not defined HAVE_PS goto :pw_batch_check

:: Ask the consumer's own question. Passing through an environment variable
:: rather than interpolating keeps a malformed secret off the command line.
set "GN_PWCHECK=!PW_LINE!"
powershell -NoProfile -Command "if ($env:GN_PWCHECK -match '^([0-9a-fA-F]+):([0-9a-fA-F]+)$') { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set "PW_OK=1"
set "GN_PWCHECK="
goto :pw_verdict

:pw_batch_check
:: No PowerShell to ask. "Something on both sides of a colon" is the most a
:: batch file can honestly determine, and it is deliberately looser than the
:: real check rather than tighter -- a validator that is stricter than its
:: consumer rejects working configurations.
for /f "tokens=1,2 delims=:" %%A in ("!PW_LINE!") do if not "%%A"=="" if not "%%B"=="" set "PW_OK=1"

:pw_verdict
if defined PW_OK goto :pw_done

:: Do NOT delete. An earlier version did, and when this check was wrong it
:: destroyed a perfectly good password file and forced setup on every
:: launch. Renaming lets setup run again next time while keeping the
:: evidence for anyone diagnosing it.
if exist "!SECRET_FILE!" move /y "!SECRET_FILE!" "!SECRET_FILE!.bad" >nul 2>&1

echo.
echo  [ERROR] The password file could not be read back.
echo.
if not defined PW_LINE (
    echo   Nothing could be read from the file after 5 attempts. That
    echo   usually means it was never written, or something is holding it
    echo   open. Windows Defender's real-time scanning can do that briefly;
    echo   an exclusion for this folder rules it out.
) else (
    echo   The file was read, but its contents are not in the form
    echo   fileserver.ps1 can parse.
)
echo.
echo   The file is one line, no trailing newline, in this exact form:
echo.
echo       salt:hash
echo.
echo   salt = 32 lowercase hex characters, from 16 random bytes
echo   hash = sha256 of salt+password, as 64 lowercase hex characters
echo.
echo   The hash covers the salt and the password concatenated, in that
echo   order, encoded UTF-8. Save the result as:
echo       !SECRET_FILE!
echo.
echo   It must be plain ASCII with no byte-order mark. Writing it from
echo   PowerShell with ^> or Out-File produces UTF-16 and will not work;
echo   use Set-Content -Encoding ascii -NoNewline instead.
echo.
if exist "!SECRET_FILE!.bad" (
    echo   What was actually written has been kept for inspection at:
    echo       !SECRET_FILE!.bad
    echo.
)

:pw_done
echo.
exit /b

:: ===============================================================
:main
echo.
echo  ====================================================
echo       GOBBONET - LOCAL AI CHAT
echo       Powered by llama.cpp  //  Vulkan GPU
echo       PRIVACY: FULLY OFFLINE - ZERO TELEMETRY
echo  ====================================================
echo.

:: Clear any stale hot-swap state from a previous crash. These files
:: coordinate between fileserver.ps1 (which initiates swaps) and the
:: monitor loop below (which would otherwise try to "fix" the server
:: going down mid-swap). If we crashed mid-swap last time the lock
:: would still be sitting here, telling the monitor to do nothing
:: forever -- so blow it away on a clean boot.
if exist "!SWAP_LOCK!"   del /f /q "!SWAP_LOCK!"   >nul 2>&1
if exist "!SWAP_STATUS!" del /f /q "!SWAP_STATUS!" >nul 2>&1

:: ---------------------------------------------------------------
:: STEP 1: CHECK FOR LLAMA-SERVER
:: ---------------------------------------------------------------
if exist "!SERVER_EXE!" (
    echo  [OK] llama-server found: !SERVER_EXE!
    goto :check_model
)

:: Server not at expected root - check subdirectories (common after zip extraction)
if exist "!LLAMA_DIR!" (
    for /r "!LLAMA_DIR!" %%F in (llama-server.exe) do if exist "%%F" (
        echo  [OK] Found llama-server in subdirectory: %%F
        set "SERVER_EXE=%%F"
        set "LLAMA_DIR=%%~dpF"
        goto :check_model
    )
)

echo  [..] llama-server.exe not found in: !LLAMA_DIR!
echo.
echo  ====================================================
echo   llama.cpp needs to be downloaded.
echo   This is about 300 MB and runs entirely offline.
echo   No accounts, no telemetry, no internet required
echo   after this one-time download.
echo  ====================================================
echo.

call :prompt_yn "  Download llama.cpp now?" DO_DOWNLOAD
if /i "!DO_DOWNLOAD!"=="N" (
    echo.
    echo  [INFO] You can also download manually:
    echo         https://github.com/ggml-org/llama.cpp/releases
    echo         Get the file ending in: -win-vulkan-x64.zip
    echo         Extract to: !LLAMA_DIR!\
    goto :fatal
)

echo.
echo  [..] Downloading llama.cpp (Vulkan build for Windows x64)...
echo      About 300 MB. This is the only network step.
echo.
echo  ====================================================
echo   If this window VANISHES during the download with no
echo   error text, an antivirus / endpoint-protection product
echo   is blocking it. Running as Administrator will NOT help.
echo.
echo   Fastest fix: copy the  llama-cpp\  folder from a PC
echo   where it already works into this folder, then re-run --
echo   the download is skipped entirely (nothing to block).
echo   Or add a Defender folder exclusion for:
echo     %~dp0
echo   Or install manually:
echo     https://github.com/ggml-org/llama.cpp/releases
echo     (file ending in: -win-vulkan-x64.zip), extract to:
echo     !LLAMA_DIR!\
echo  ====================================================
echo.

:: -----------------------------------------------------------------
:: Engine download -- cmd-native, NO PowerShell.
::
:: The previous version wrote a .ps1 into %TEMP% and ran it with
:: -ExecutionPolicy Bypass to fetch the zip. That exact shape
:: (cmd -^> temp .ps1 with Bypass -^> downloads an executable archive)
:: is what behavioral AV engines read as malware staging, and several
:: respond by killing the whole process tree -- the console window
:: just disappears mid-download with no error and no log, and elevation
:: does not exempt you (admin does not bypass Defender).
::
:: This version uses only the Microsoft-signed tools that ship in
:: System32 on every Windows 10 1803+ machine, called straight from
:: cmd: curl.exe (download), certutil.exe (hash), tar.exe (extract).
:: No script file, no Bypass, no PowerShell-initiated download -- so
:: there is no staging pattern for the heuristic to trip on. It also
:: works where PowerShell script execution is disabled by policy.
::
:: The asset URL is built directly from the pinned tag (set near the
:: top of this file), which is bumped only after testing, so the
:: deterministic asset name is known-good for the pinned release.
:: -----------------------------------------------------------------
set "LLAMA_ASSET=llama-!LLAMA_PIN_TAG!-bin-win-vulkan-x64.zip"
set "LLAMA_URL=https://github.com/ggml-org/llama.cpp/releases/download/!LLAMA_PIN_TAG!/!LLAMA_ASSET!"
set "LLAMA_ZIP=%TEMP%\!LLAMA_ASSET!"

call :http_get "!LLAMA_URL!" "!LLAMA_ZIP!"
if not "!HTTP_OK!"=="1" (
    echo.
    echo  [ERROR] Download failed -- curl could not fetch the release zip.
    echo          Common causes: no internet, GitHub unreachable, or this
    echo          exact build/tag is no longer published.
    echo.
    echo          Install manually instead:
    echo            !LLAMA_URL!
    echo          ...or browse: https://github.com/ggml-org/llama.cpp/releases
    echo          ^(get the file ending in: -win-vulkan-x64.zip^)
    echo          and extract it into:  !LLAMA_DIR!\
    del /f /q "!LLAMA_ZIP!" >nul 2>&1
    goto :fatal
)
echo.
echo  [OK] Download complete.

:: --- Integrity check (certutil, no PowerShell) -------------------
set "LLAMA_ACTUAL="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!LLAMA_ZIP!" SHA256 2^>nul') do if not defined LLAMA_ACTUAL set "LLAMA_ACTUAL=%%H"
set "LLAMA_ACTUAL=!LLAMA_ACTUAL: =!"

if not defined LLAMA_PIN_SHA256 goto :llama_hash_unpinned
if /i "!LLAMA_ACTUAL!"=="!LLAMA_PIN_SHA256!" goto :llama_hash_ok
echo.
echo  [ERROR] CHECKSUM MISMATCH -- the download is corrupt or tampered.
echo            expected: !LLAMA_PIN_SHA256!
echo            actual:   !LLAMA_ACTUAL!
echo          Refusing to extract. The zip has been deleted.
del /f /q "!LLAMA_ZIP!" >nul 2>&1
goto :fatal

:llama_hash_unpinned
echo.
echo  [*] WARNING: no SHA-256 is pinned for this build, so this download
echo      was NOT verified against a known-good hash. What is about to be
echo      extracted includes the executables that run the model on this
echo      machine.
echo.
echo      It arrived over HTTPS from github.com, which is normally fine.
echo      Pinning it additionally refuses a release asset that gets
echo      replaced later, and a proxy that intercepts TLS. Set this near
echo      the top of launch.bat to pin what you just downloaded:
echo.
echo        set "LLAMA_PIN_SHA256=!LLAMA_ACTUAL!"
echo.
call :prompt_yn "  Extract and run this UNVERIFIED download?" LLAMA_UNPINNED_OK
if /i not "!LLAMA_UNPINNED_OK!"=="Y" (
    echo  [*] Cancelled. The downloaded zip has been deleted.
    del /f /q "!LLAMA_ZIP!" >nul 2>&1
    goto :fatal
)
goto :llama_extract

:llama_hash_ok
echo  [OK] Checksum verified against pinned SHA-256.

:llama_extract
if not exist "!LLAMA_DIR!" mkdir "!LLAMA_DIR!"
echo  [..] Extracting...
tar.exe -xf "!LLAMA_ZIP!" -C "!LLAMA_DIR!"
if errorlevel 1 (
    echo.
    echo  [ERROR] Extraction failed -- tar.exe could not unpack the zip.
    echo          The download may be incomplete. Delete anything in
    echo          !LLAMA_DIR!\ and re-run, or install manually:
    echo            !LLAMA_URL!
    del /f /q "!LLAMA_ZIP!" >nul 2>&1
    goto :fatal
)
del /f /q "!LLAMA_ZIP!" >nul 2>&1
echo  [OK] Extracted to: !LLAMA_DIR!\

:: After extraction, the exe might be in a subdirectory. Find it.
if not exist "!SERVER_EXE!" (
    echo  [..] Searching for llama-server.exe in extracted files...
    for /r "!LLAMA_DIR!" %%F in (llama-server.exe) do if exist "%%F" (
        echo  [OK] Found: %%F
        set "SERVER_EXE=%%F"
        set "LLAMA_DIR=%%~dpF"
        goto :server_found
    )
    echo  [ERROR] llama-server.exe not found after extraction.
    echo         Check the contents of: !LLAMA_DIR!
    goto :fatal
)
:server_found
echo  [OK] llama-server ready: !SERVER_EXE!
echo.

:: ---------------------------------------------------------------
:: STEP 2: CHECK FOR MODEL GGUF
:: ---------------------------------------------------------------
:check_model
if not exist "!MODEL_DIR!" mkdir "!MODEL_DIR!"

:: If a specific GGUF is set, check for it
if defined MODEL_GGUF if not "!MODEL_GGUF!"=="" (
    if exist "!MODEL_DIR!\!MODEL_GGUF!" (
        echo  [OK] Model: !MODEL_GGUF!
        set "GGUF_PATH=!MODEL_DIR!\!MODEL_GGUF!"
        goto :identify_model
    )
    if exist "!MODEL_GGUF!" (
        echo  [OK] Model: !MODEL_GGUF!
        set "GGUF_PATH=!MODEL_GGUF!"
        goto :identify_model
    )
)

:: Auto-detect GGUFs in models folder
set "GGUF_COUNT=0"
for %%F in ("!MODEL_DIR!\*.gguf") do set /a GGUF_COUNT+=1

if !GGUF_COUNT! == 0 goto :model_download_menu

if !GGUF_COUNT! == 1 (
    for %%F in ("!MODEL_DIR!\*.gguf") do (
        echo  [OK] Model found: %%~nxF
        set "GGUF_PATH=%%F"
        goto :identify_model
    )
)

:: Multiple GGUFs found - let the user choose
echo  [..] Multiple model files found in models\
echo.
set "GGUF_IDX=0"
for %%F in ("!MODEL_DIR!\*.gguf") do (
    set /a GGUF_IDX+=1
    echo   [!GGUF_IDX!] %%~nxF
    set "GGUF_CHOICE_!GGUF_IDX!=%%F"
)
echo.
set /p "_GCHOICE=  Select model [1-!GGUF_COUNT!]: "
if defined GGUF_CHOICE_!_GCHOICE! (
    set "GGUF_PATH=!GGUF_CHOICE_%_GCHOICE%!"
    for %%F in ("!GGUF_PATH!") do echo  [OK] Using: %%~nxF
    goto :identify_model
)
echo  [ERROR] Invalid selection. Please restart and enter a number from the list.
goto :fatal

:: ---------------------------------------------------------------
:: IDENTIFY MODEL -- read the chat template baked into the GGUF
::
:: Detection is driven by the embedded tokenizer.chat_template (ground
:: truth), NOT the filename. identify-model.ps1 is the single source of
:: truth, shared with the models-list.json builder further down, so the
:: initial launch and the hot-swap dropdown can never disagree.
::
:: Thinking-format names mirror chat.html's registry:
::   none      = no thinking (Llama, Mistral, Phi, Gemma 3 base)
::   deepseek  = <think>...</think>  (R1, Qwen3, QwQ, GLM thinking, etc.)
::   harmony   = gpt-oss channels
::   gemma     = Gemma channel thinking (Gemma 4)
:: ---------------------------------------------------------------
:identify_model
for %%F in ("!GGUF_PATH!") do set "GGUF_BASENAME=%%~nxF"

:: Defaults, overwritten by the identifier (or kept if it is missing).
set "MODEL_ID=custom"
set "MODEL_DISPLAY=!GGUF_BASENAME!"
set "MODEL_FAMILY=custom"
set "MODEL_MAX_CTX=131072"
set "MODEL_THINK_FMT=none"
set "MODEL_USE_JINJA=1"
set "MODEL_CHAT_TEMPLATE="
set "MODEL_CHAT_TEMPLATE_FILE="

:: identify-model.ps1 prints a block of `set` statements; we CALL them
:: into the current environment so they feed the launch command below.
set "ID_SCRIPT=%~dp0identify-model.ps1"
set "ID_OUT=%TEMP%\gobbo_model_%RANDOM%.cmd"
if exist "!ID_SCRIPT!" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "!ID_SCRIPT!" -GgufPath "!GGUF_PATH!" -Emit batch -OutFile "!ID_OUT!" 2>nul
    if exist "!ID_OUT!" (
        call "!ID_OUT!"
        del "!ID_OUT!" >nul 2>&1
    )
    echo  [OK] Identified: !MODEL_DISPLAY!  ^(family=!MODEL_FAMILY!, jinja=!MODEL_USE_JINJA!^)
    if not "!MODEL_CHAT_TEMPLATE!"=="" (
        echo       Using llama-server built-in template: !MODEL_CHAT_TEMPLATE!  ^(--jinja disabled^)
    )
) else (
    echo  [*] identify-model.ps1 not found next to launch.bat.
    echo       Falling back to generic settings ^(embedded template via --jinja^).
    echo  !GGUF_BASENAME! | findstr /i /c:"think" /c:"reason" >nul 2>&1
    if not errorlevel 1 set "MODEL_THINK_FMT=deepseek"
)

goto :write_model_json

:: ---------------------------------------------------------------
:: MODEL DOWNLOAD MENU
:: ---------------------------------------------------------------
:model_download_menu
:: ---------------------------------------------------------------
:: HARDWARE-AWARE MODEL SUGGESTION
::
:: Run hardware-probe.ps1 (visible, so the user sees their GPU/RAM
:: detected), then parse hardware.json into HW_* vars plus per-model
:: markers (MK_1..MK_8) and a recommended option number (REC).
::
:: REC = best model that fits detected VRAM (flagship-first):
::   >=16 GB -> 5 (Gemma 4 26B)   >=12 -> 8 (gpt-oss 20B)
::   >=8  GB -> 4 (Qwen3.5 9B)    >=6  -> 1 (Gemma 4 E4B)
::   cpu_only / tiny -> 2 (Llama 3.2 3B)
:: MK_n is one of:
::   "[ RECOMMENDED FOR YOUR PC ]"      (the REC option)
::   "[ needs ~N GB VRAM - will be slow ]"  (model bigger than VRAM)
::   "[ likely too slow without a GPU ]"    (cpu_only + non-tiny model)
::   ""                                  (fits fine, no marker)
::
:: If hardware-probe.ps1 is missing or the probe/parse fails, we set
:: HW_TIER=unknown / REC=0 and every MK_n="" -- so the menu prints
:: EXACTLY as it always did (static catalog, no recommendation).
:: This is the no-regression fallback.
:: ---------------------------------------------------------------
echo.
echo  [..] Checking your hardware to suggest the best model...
echo       (one-time, runs locally -- no internet needed for this)
echo.
if exist "%~dp0hardware-probe.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hardware-probe.ps1" -OutputPath "%~dp0hardware.json" -ModelsDir "!MODEL_DIR!"
) else (
    echo  [*] hardware-probe.ps1 not found -- showing the full catalog
    echo       without hardware-based suggestions.
)
echo.

:: Defaults in case the parse below produces nothing (PowerShell blocked,
:: etc.). With REC=0 and unknown tier the menu renders statically.
set "HW_OK=0"
set "HW_TIER=unknown"
set "HW_VRAM=0"
set "HW_RAM=0"
set "HW_DISK=0"
set "REC=0"

:: Parse hardware.json into KEY=VALUE lines. We run PowerShell DIRECTLY
:: (not inside a for/f backtick) and redirect its stdout to a small temp
:: file, then read that file with for/f. This matches the proven direct-
:: invocation pattern used by the models-list.json writer below and avoids
:: any cmd paren/quote-matching fragility inside a for/f command. The
:: payload is pure single-quoted PowerShell + string concatenation (no
:: embedded double quotes, no pipes, no '!', output is pure ASCII) so the
:: redirect and for/f read it back cleanly regardless of console encoding.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hw-recommend.ps1" > "%~dp0.hw-parsed.env" 2>nul

if exist "%~dp0.hw-parsed.env" (
    for /f "usebackq tokens=1,* delims==" %%K in ("%~dp0.hw-parsed.env") do set "%%K=%%L"
    del "%~dp0.hw-parsed.env" >nul 2>&1
)

:show_catalog
echo.
echo  ====================================================
echo   CHOOSE A MODEL TO DOWNLOAD
echo.
if "!HW_OK!"=="1" (
    echo   Detected: !HW_VRAM! GB VRAM, !HW_RAM! GB RAM, !HW_DISK! GB free disk
    echo   Suggested tier: !HW_TIER! -- the recommended pick is marked below.
    echo.
)
echo   All models run 100%% offline after download.
echo   VRAM estimates are approximate at default CTX_SIZE.
echo   Adjust CTX_SIZE and KV_CACHE_TYPE at the top of
echo   this script to trade context length vs VRAM usage.
echo.
echo   -- SMALL (fits ~6 GB VRAM) ----------------------
echo.
echo     [2] Llama 3.2 3B Instruct  Q8_0    ~3.4 GB  !MK_2!
echo         Meta - ultra-light, surprisingly good chat
echo.
echo     [1] Gemma 4 E4B IT         Q4_K_M  ~5.4 GB  !MK_1!
echo         Google - fast and sharp for its size
echo.
echo   -- MEDIUM (fits ~8-12 GB VRAM) ------------------
echo.
echo     [4] Qwen3.5 9B             Q4_K_M  ~6.2 GB  !MK_4!
echo         Alibaba - strong all-rounder, 128K context
echo         Emits chain-of-thought between ^<think^> tags
echo.
echo     [9] Command R 7B (12-2024) Q6_K    ~6.6 GB  !MK_9!
echo         Cohere - strong instruction following, 128K
echo         Multilingual; no chain-of-thought
echo.
echo     [3] Mistral 7B v0.3        Q6_K    ~7.5 GB  !MK_3!
echo         Mistral AI - tight instruction following
echo.
echo     [7] DeepSeek-R1 8B         Q8_0    ~8.5 GB  !MK_7!
echo         Reasoning-focused model (Qwen3 distill)
echo         Shows chain-of-thought by default
echo.
echo     [8] gpt-oss 20B            MXFP4   ~12 GB   !MK_8!
echo         OpenAI - open-weights reasoning model
echo         Uses Harmony channel format for CoT
echo.
echo   -- LARGE (16 GB VRAM and up) --------------------
echo.
echo     [5] Gemma 4 26B-A4B MoE    Q4_K_S  ~16 GB   !MK_5!
echo         Google - MoE runs FAST despite large size
echo         Great default for 16 GB GPUs
echo.
echo    [10] Command R 35B (08-2024) Q4_K_S ~19 GB   !MK_10!
echo         Cohere - heavy chat model, needs ~24 GB VRAM
echo         Multilingual strength, 128K context
echo.
echo     [6] Qwen3.6 35B-A3B MoE    Q4_K_M  ~22 GB   !MK_6!
echo         Alibaba - largest in this list, needs ~24 GB
echo         Strong reasoning; ^<think^> tags; 128K context
echo.
echo   -- MANUAL ---------------------------------------
echo.
echo    [11] Skip - I'll add my own .gguf
echo         Place any GGUF in the models\ folder
echo.
echo   Note: If a download link fails, check the updated
echo   repo at https://huggingface.co/bartowski
echo  ====================================================
echo.
if not "!REC!"=="0" (
    echo   Press ENTER to accept the recommended pick [!REC!],
    echo   or type a number to choose a different model.
    echo.
)
set "MODEL_CHOICE="
set /p "MODEL_CHOICE=  Your choice [1-11]: "
if not defined MODEL_CHOICE if not "!REC!"=="0" set "MODEL_CHOICE=!REC!"

:: VRAM safety net -- if the chosen model wants more GPU memory than we
:: detected, warn and confirm rather than letting a non-technical user
:: download 16 GB of model that will crawl. Skipped when VRAM is unknown
:: (HW_VRAM=0) so we never block on a failed probe.
set "PICK_MIN=0"
if "!MODEL_CHOICE!"=="1" set "PICK_MIN=6"
if "!MODEL_CHOICE!"=="2" set "PICK_MIN=4"
if "!MODEL_CHOICE!"=="3" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="4" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="5" set "PICK_MIN=16"
if "!MODEL_CHOICE!"=="6" set "PICK_MIN=24"
if "!MODEL_CHOICE!"=="7" set "PICK_MIN=10"
if "!MODEL_CHOICE!"=="8" set "PICK_MIN=12"
:: 9 and 10 had no gate at all, so the VRAM warning never fired for them --
:: including for slot 10, which is the second-largest model in the list.
if "!MODEL_CHOICE!"=="9" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="10" set "PICK_MIN=24"
if not defined HW_VRAM set "HW_VRAM=0"
if !HW_VRAM! gtr 0 if !PICK_MIN! gtr 0 if !HW_VRAM! lss !PICK_MIN! (
    echo.
    echo  [*] Heads up: this model wants about !PICK_MIN! GB of GPU
    echo       memory, but only !HW_VRAM! GB was detected. It can still
    echo       run by spilling into system RAM, but expect it to be
    echo       noticeably slower than a model that fits your GPU.
    echo.
    call :prompt_yn "  Download it anyway?" GO_BIG
    if /i "!GO_BIG!"=="N" goto :show_catalog
    echo.
)

if "!MODEL_CHOICE!"=="1" (
    set "DL_REPO=bartowski/google_gemma-4-E4B-it-GGUF"
    set "DL_FILE=google_gemma-4-E4B-it-Q4_K_M.gguf"
    set "MODEL_ID=gemma4-e4b"
    set "MODEL_DISPLAY=Gemma 4 E4B IT"
    set "MODEL_FAMILY=gemma"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="2" (
    set "DL_REPO=bartowski/Llama-3.2-3B-Instruct-GGUF"
    set "DL_FILE=Llama-3.2-3B-Instruct-Q8_0.gguf"
    set "MODEL_ID=llama32-3b"
    set "MODEL_DISPLAY=Llama 3.2 3B Instruct"
    set "MODEL_FAMILY=llama"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="3" (
    set "DL_REPO=bartowski/Mistral-7B-Instruct-v0.3-GGUF"
    set "DL_FILE=Mistral-7B-Instruct-v0.3-Q6_K.gguf"
    set "MODEL_ID=mistral-7b"
    set "MODEL_DISPLAY=Mistral 7B v0.3"
    set "MODEL_FAMILY=mistral"
    set "MODEL_MAX_CTX=32768"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="4" (
    set "DL_REPO=bartowski/Qwen_Qwen3.5-9B-GGUF"
    set "DL_FILE=Qwen_Qwen3.5-9B-Q4_K_M.gguf"
    set "MODEL_ID=qwen35-9b"
    set "MODEL_DISPLAY=Qwen3.5 9B"
    set "MODEL_FAMILY=qwen"
    set "MODEL_MAX_CTX=131072"
    :: Qwen3.5 emits reasoning between <think> tags like the rest of the
    :: Qwen3 line. identify-model.ps1 re-detects this from the GGUF after
    :: download, so this value only has to be right enough to start with.
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="5" (
    set "DL_REPO=bartowski/google_gemma-4-26B-A4B-it-GGUF"
    set "DL_FILE=google_gemma-4-26B-A4B-it-Q4_K_S.gguf"
    set "MODEL_ID=gemma4-26b"
    set "MODEL_DISPLAY=Gemma 4 26B-A4B MoE"
    set "MODEL_FAMILY=gemma"
    set "MODEL_MAX_CTX=262144"
    set "MODEL_THINK_FMT=gemma"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="6" (
    set "DL_REPO=bartowski/Qwen_Qwen3.6-35B-A3B-GGUF"
    set "DL_FILE=Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf"
    set "MODEL_ID=qwen36-35b"
    set "MODEL_DISPLAY=Qwen3.6 35B-A3B MoE"
    set "MODEL_FAMILY=qwen"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=deepseek"
    :: 8192, not the 16384 its predecessor used. The weights are 22.29 GB
    :: and the gate below asks for 24 GB, so on a card that only just
    :: qualifies there is under 2 GB left for the KV cache. A context that
    :: does not fit fails at load with an out-of-memory error rather than
    :: degrading, so the default errs small; the config panel raises it for
    :: anyone with headroom.
    set "CTX_SIZE=8192"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="7" (
    :: The repo and the filename both carry a deepseek-ai_ prefix. Without
    :: it the URL 404s, which is what made this slot uninstallable.
    set "DL_REPO=bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF"
    set "DL_FILE=deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q8_0.gguf"
    set "MODEL_ID=deepseek-r1-8b"
    set "MODEL_DISPLAY=DeepSeek-R1 8B"
    set "MODEL_FAMILY=deepseek"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="8" (
    set "DL_REPO=ggml-org/gpt-oss-20b-GGUF"
    :: MXFP4 uppercase. Hugging Face paths are case-sensitive, so the
    :: lowercase spelling 404s.
    set "DL_FILE=gpt-oss-20b-MXFP4.gguf"
    set "MODEL_ID=gpt-oss-20b"
    set "MODEL_DISPLAY=gpt-oss 20B"
    set "MODEL_FAMILY=gpt-oss"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=harmony"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="9" (
    set "DL_REPO=bartowski/c4ai-command-r7b-12-2024-GGUF"
    set "DL_FILE=c4ai-command-r7b-12-2024-Q6_K.gguf"
    set "MODEL_ID=command-r7b"
    set "MODEL_DISPLAY=Command R 7B (12-2024)"
    set "MODEL_FAMILY=cohere"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="10" (
    set "DL_REPO=bartowski/c4ai-command-r-08-2024-GGUF"
    set "DL_FILE=c4ai-command-r-08-2024-Q4_K_S.gguf"
    set "MODEL_ID=command-r-35b"
    set "MODEL_DISPLAY=Command R 35B (08-2024)"
    set "MODEL_FAMILY=cohere"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)

echo.
echo  [INFO] Place your .gguf file in: !MODEL_DIR!
echo         Then run this script again.
echo.
echo  Popular GGUF sources:
echo    https://huggingface.co/bartowski
echo    https://huggingface.co/unsloth
echo.
goto :fatal

:download_model
set "DL_URL=https://huggingface.co/!DL_REPO!/resolve/main/!DL_FILE!"
set "GGUF_PATH=!MODEL_DIR!\!DL_FILE!"
set "GGUF_PART=!MODEL_DIR!\!DL_FILE!.part"

:: If the file is already in models\, use it and download nothing.
:: This is what makes hand-placing a .gguf a supported way to install
:: one: we never fetch over it, never hash it against a pointer we did
:: not fetch it from, and never delete it. Before this guard existed,
:: picking a model you had already copied in by hand and then hitting
:: any download error would remove your file.
if exist "!GGUF_PATH!" (
    echo.
    echo  [OK] Already in models\ -- skipping download: !DL_FILE!
    goto :model_file_ready
)

echo.
echo  [..] Downloading: !DL_FILE!
echo       From: huggingface.co/!DL_REPO!
echo       To:   !MODEL_DIR!\
echo.
echo       This is a large file. It may take 10-30 minutes
echo       depending on your connection speed.
echo.

:: Download to <name>.part and rename only after it verifies. Nothing in
:: models\ that this script did not create is ever touched, and an aborted
:: download cannot leave a half-file for the models\*.gguf scan to find.
call :http_get "!DL_URL!" "!GGUF_PART!" resume
if not "!HTTP_OK!"=="1" (
    echo.
    echo  [ERROR] Download failed.
    echo.
    :: The partial file is kept on a TRANSPORT failure, deliberately, so
    :: re-running resumes instead of starting a multi-gigabyte transfer
    :: over. It is still deleted further down when VERIFICATION fails --
    :: a file that arrived intact but hashes wrong is not something to
    :: resume, it is something to discard.
    if exist "!GGUF_PART!" (
        for %%A in ("!GGUF_PART!") do set "PART_MB=%%~zA"
        echo         The partial download has been kept. Run launch.bat
        echo         again and pick the same model to carry on from where
        echo         it stopped -- it will not start over.
        echo.
        echo         To start clean instead, delete:
        echo         !GGUF_PART!
    ) else (
        echo         Nothing was downloaded. Check your connection.
    )
    echo.
    echo         Or fetch it by hand:
    echo         !DL_URL!
    echo         Save to: !MODEL_DIR!\
    goto :fatal
)

:: ---------------------------------------------------------------
:: INTEGRITY CHECK -- cmd-native, NO PowerShell.
:: HuggingFace stores LFS files behind a pointer that records the
:: canonical SHA-256. We fetch that small text pointer with curl
:: (over TLS, from the /raw/ path), pull "sha256:<hex>" out of it
:: with findstr, and compare to certutil's hash of the file we
:: actually downloaded. Same reasoning as the engine step: no temp
:: .ps1, no -ExecutionPolicy Bypass, nothing a behavioral AV reads
:: as download-staging.
::   - mismatch              -^> abort and delete (corrupt/tampered)
::   - no pointer/parse fail  -^> warn but continue (rely on the
::     ^>=1GB size sanity check below); HF format changes shouldn't
::     hard-block a good file.
:: ---------------------------------------------------------------
set "POINTER_URL=https://huggingface.co/!DL_REPO!/raw/main/!DL_FILE!"
set "PTR_FILE=%TEMP%\gobbonet_ptr_%RANDOM%.txt"
set "VERIFY_RESULT=2"

echo  [..] Fetching expected SHA-256 from HuggingFace...
call :http_get "!POINTER_URL!" "!PTR_FILE!" quiet
if not "!HTTP_OK!"=="1" (
    echo  [WARN] Could not fetch the HuggingFace checksum pointer.
    echo         Skipping hash check; size sanity check still applies.
    goto :model_verify_done
)

set "MODEL_EXPECTED="
for /f "tokens=2 delims=:" %%H in ('findstr /i "sha256:" "!PTR_FILE!"') do if not defined MODEL_EXPECTED set "MODEL_EXPECTED=%%H"
set "MODEL_EXPECTED=!MODEL_EXPECTED: =!"
if not defined MODEL_EXPECTED (
    echo  [WARN] Could not read the checksum from HuggingFace ^(format may have changed^).
    echo         Skipping hash check; size sanity check still applies.
    goto :model_verify_done
)

set "MODEL_ACTUAL="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!GGUF_PART!" SHA256 2^>nul') do if not defined MODEL_ACTUAL set "MODEL_ACTUAL=%%H"
set "MODEL_ACTUAL=!MODEL_ACTUAL: =!"
echo  [..] Verifying download against it...
if /i "!MODEL_ACTUAL!"=="!MODEL_EXPECTED!" (
    echo  [OK] Model checksum verified.
    set "VERIFY_RESULT=0"
) else (
    echo  [ERROR] CHECKSUM MISMATCH -- model file is corrupt or tampered.
    echo            expected: !MODEL_EXPECTED!
    echo            actual:   !MODEL_ACTUAL!
    set "VERIFY_RESULT=1"
)

:model_verify_done
del /f /q "!PTR_FILE!" >nul 2>&1
if "!VERIFY_RESULT!"=="1" (
    echo.
    echo  [ERROR] The downloaded model failed its integrity check and has
    echo          been deleted. This can mean a corrupted download or that
    echo          the file was tampered with. Try again, or download manually.
    del "!GGUF_PART!" 2>nul
    goto :fatal
)

:: Sanity check - file should be at least 1 GB
for %%A in ("!GGUF_PART!") do set "FSIZE=%%~zA"
if !FSIZE! LSS 1000000000 (
    echo  [ERROR] Downloaded file is too small - !FSIZE! bytes.
    echo         This usually means the download link returned an
    echo         error page instead of the model file.
    echo.
    echo         The GGUF repo or filename may have changed.
    echo         Check: https://huggingface.co/bartowski
    echo         Download manually and place in: !MODEL_DIR!\
    del "!GGUF_PART!" 2>nul
    goto :fatal
)

:: Verified -- now put it in place under its real name.
move /y "!GGUF_PART!" "!GGUF_PATH!" >nul
if errorlevel 1 (
    echo  [ERROR] Could not move the verified download into place.
    echo          Check that nothing else has !DL_FILE! open.
    del "!GGUF_PART!" 2>nul
    goto :fatal
)

:model_file_ready
echo  [OK] Model ready: !DL_FILE!
echo.

:: A just-downloaded model must be identified exactly like an existing
:: one, so MODEL_* settings (context, jinja mode, chat template, thinking
:: format) get populated. Skipping this was why a freshly downloaded model
:: launched with empty settings and stalled on the first run, while a
:: restart -- which DOES identify the model -- worked. :identify_model sets
:: GGUF_BASENAME from GGUF_PATH and returns via :write_model_json.
goto :identify_model

:: ---------------------------------------------------------------
:: WRITE ACTIVE-MODEL.JSON
:: Tells chat.html which model is loaded so it can update the UI.
:: Served by the file server at /active-model.json
:: ---------------------------------------------------------------
:write_model_json
echo  [..] Writing active-model.json...
(
    echo {
    echo   "id": "!MODEL_ID!",
    echo   "name": "!MODEL_DISPLAY!",
    echo   "family": "!MODEL_FAMILY!",
    echo   "ggufFile": "!GGUF_BASENAME!",
    echo   "maxCtx": !MODEL_MAX_CTX!,
    echo   "defaultCtx": !CTX_SIZE!,
    echo   "thinkingFormat": "!MODEL_THINK_FMT!"
    echo }
) > "%~dp0active-model.json"
echo  [OK] active-model.json written ^(!MODEL_DISPLAY!^)
echo.

:: ---------------------------------------------------------------
:: WRITE MODELS-LIST.JSON
::
:: chat.html's header dropdown is populated by fetching this file
:: from the file server. It needs one record per .gguf in models\,
:: with the same metadata launch.bat would have set if THAT file had
:: been the active choice (family, thinking format, max context,
:: useJinja, chatTemplate). When the user picks a different option,
:: fileserver.ps1 reads the record back out of this file and uses it
:: to build the swap command line -- so the per-model quirks (e.g.
:: Mistral Nemo's MODEL_USE_JINJA=0 + mistral-v3-tekken template)
:: ride along correctly without launch.bat being in the loop.
::
:: identify-model.ps1 (the SAME script :identify_model used above) reads
:: every GGUF in models\ and writes one record per file. Detection lives
:: in exactly one place now, so the dropdown, the hot-swap launcher and
:: the initial launch can never disagree about a model template/jinja mode.
:: ---------------------------------------------------------------
echo  [..] Writing models-list.json...
set "MODELS_LIST_JSON=%~dp0models-list.json"
set "ACTIVE_GGUF_NAME=!GGUF_BASENAME!"
if exist "%~dp0identify-model.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0identify-model.ps1" -ModelsDir "!MODEL_DIR!" -Active "!ACTIVE_GGUF_NAME!" -OutFile "!MODELS_LIST_JSON!"
) else (
    echo  [*] identify-model.ps1 not found; cannot build models-list.json.
)

if errorlevel 1 (
    echo  [*] models-list.json write failed; header dropdown will be empty.
    echo       Hot-swap requires this file -- check that PowerShell can run.
)
echo.

:: ---------------------------------------------------------------
:: STEP 3: START LLAMA-SERVER
:: ---------------------------------------------------------------
:start_server
echo  [..] Checking for running llama-server...

call :http_alive "http://127.0.0.1:!SERVER_PORT!/health"
if not errorlevel 1 (
    echo  [OK] llama-server already running on port !SERVER_PORT!
    goto :verify_gpu
)

:: Log file for diagnostics - lives next to this script
echo  [..] Starting llama-server...
echo       Model:      !GGUF_PATH!
echo       Port:       !SERVER_PORT!
echo       Context:    !CTX_SIZE! tokens
echo       KV Cache:   !KV_CACHE_TYPE! (quantized for max context)
echo       GPU layers: !GPU_LAYERS!
echo       Log file:   !LOG_FILE!
echo.
echo       NOTE: The GGUF file usually contains its own chat template.
if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    echo             Using project template file: !MODEL_CHAT_TEMPLATE_FILE!
    echo             ^(--jinja on, embedded template overridden^)
) else (
    if "!MODEL_USE_JINJA!"=="1" (
        if not "!MODEL_CHAT_TEMPLATE!"=="" (
            echo             Using --jinja with override: !MODEL_CHAT_TEMPLATE!
        ) else (
            echo             Using --jinja to honor the embedded Jinja template.
        )
    ) else (
        if not "!MODEL_CHAT_TEMPLATE!"=="" (
            echo             Using llama-server built-in: !MODEL_CHAT_TEMPLATE!
            echo             ^(--jinja disabled for this model family^)
        ) else (
            echo             --jinja disabled; falling back to fingerprint match.
        )
    )
)
echo.

:: CHAT TEMPLATE HANDLING
::
:: --jinja tells llama-server to use the chat_template baked into the GGUF.
:: That's the default and works for most modern models (Gemma 4 channels,
:: gpt-oss Harmony, Mistral Small v7-tekken, Qwen3 think mode, etc.).
::
:: For a handful of families, --jinja produces garbage because the embedded
:: template is incomplete or contains Jinja constructs that minja can't
:: render. Mistral Nemo merges are the canonical example - see the comment
:: at the top of this script. For those, :identify_model sets:
::   MODEL_USE_JINJA=0
::   MODEL_CHAT_TEMPLATE=<built-in template name, e.g. mistral-v3-tekken>
:: which makes us pass --chat-template <name> instead of --jinja, using
:: llama-server's C++ reference implementation of the template.
::
:: Important: we ONLY pass --chat-template when MODEL_CHAT_TEMPLATE names a
:: built-in. Passing an arbitrary template name silently falls back to a
:: wrong format and causes the model to echo system info instead of
:: chatting - that's the footgun the old comment here was guarding against.

:: --parallel 1 pins the server to a single slot. The default ('auto'
:: -> 4 slots) splits the unified KV cache four ways and causes the
:: server to bounce between slots via LRU/LCP selection. With two
:: differently-shaped requests in flight (e.g. lore summarization +
:: chat completion), slot churn invalidates cached prefixes on both
:: sides, forcing a full prompt re-prefill (~27s on a 11K context).
:: One slot = consistent cache reuse = the followup chat call after
:: a summarization is fast instead of doing prefill from scratch.
::
:: --reasoning-format auto asks the server to route chain-of-thought
:: into a separate reasoning_content channel. Without it, CoT arrives
:: inline in 'content' and we rely entirely on the client-side parser.
:: With it, the server does the split for us and the client parser
:: becomes a safety net rather than the only line of defense. This is
:: a no-op for non-reasoning models, so it's safe to always pass.

:: Build optional flags conditionally so we don't accidentally emit
:: '--jinja' and '--chat-template <name>' together (mixing the two is
:: legal but defeats the point of routing around a broken Jinja template).
::
:: Precedence for the template source:
::   1. MODEL_CHAT_TEMPLATE_FILE -- a real .jinja file shipped with the
::      project (e.g. granite.jinja). REQUIRES --jinja to be honored as a
::      template (without --jinja, --chat-template-file is ignored). This
::      feeds our file INSTEAD of the GGUF's embedded template, so it both
::      sidesteps a broken embedded template and formats correctly. Used
::      for Granite, whose embedded template crashes the loader AND whose
::      built-in NAME doesn't resolve on current builds (it gets treated as
::      a literal template -- the model ends up fed just the word "granite").
::   2. MODEL_CHAT_TEMPLATE -- a built-in template NAME (e.g.
::      mistral-v3-tekken). Used with --jinja DISABLED; llama-server's C++
::      reference implementation renders it.
::   3. Neither -- plain --jinja, honoring the GGUF's embedded template.
set "JINJA_FLAG="
set "CHAT_TEMPLATE_FLAG="

:: Guard (defense-in-depth): the pinned llama.cpp build does not recognize
:: "mistral-v7-tekken" as a built-in name, so passing it bare to --chat-template
:: makes the server treat the literal text as the template body -- the model is
:: then fed a constant string and rambles about "tekken". Rewrite to the name
:: that IS registered. (identify-model.ps1 already emits mistral-v7, but a user
:: could hand-set this from the CONFIG comment above, or a stale value could
:: arrive some other way -- so we normalize here too.)
if /i "!MODEL_CHAT_TEMPLATE!"=="mistral-v7-tekken" (
    set "MODEL_CHAT_TEMPLATE=mistral-v7"
    set "MODEL_USE_JINJA=0"
    echo  [..] Normalized chat template mistral-v7-tekken -^> mistral-v7 ^(unrecognized on pinned build^).
)

:: Guard: if a template FILE was specified, make sure it is actually a Jinja
:: template and not an empty file or a failed download (the classic "Entry not
:: found" 404 body). A bad file fed via --chat-template-file renders to a
:: constant string for every turn, exactly like the -tekken trap above. If it
:: looks unusable, drop it and fall back to the embedded template via --jinja.
if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    set "TEMPLATE_FILE_PATH=%~dp0!MODEL_CHAT_TEMPLATE_FILE!"
    if exist "!TEMPLATE_FILE_PATH!" (
        findstr /c:"{%%" /c:"{{" "!TEMPLATE_FILE_PATH!" >nul 2>&1
        if errorlevel 1 (
            echo  [*] Template file has no Jinja markers ^(empty / failed download?^): !MODEL_CHAT_TEMPLATE_FILE!
            echo       Ignoring it and using the embedded template instead.
            set "MODEL_CHAT_TEMPLATE_FILE="
        )
    )
)

if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    rem Resolve the filename against the project root (same dir as this
    rem script / the server exe). A bare filename keeps models-list.json
    rem portable; we expand to a full path only at launch time.
    set "TEMPLATE_FILE_PATH=%~dp0!MODEL_CHAT_TEMPLATE_FILE!"
    if exist "!TEMPLATE_FILE_PATH!" (
        set "JINJA_FLAG=--jinja"
        rem Note: value intentionally contains embedded quotes around the
        rem path (it may contain spaces). Using the set VAR=value form
        rem (no outer quotes) so the quotes belong to the value itself.
        set CHAT_TEMPLATE_FLAG=--chat-template-file "!TEMPLATE_FILE_PATH!"
    ) else (
        echo  [*] Chat-template file not found: !TEMPLATE_FILE_PATH!
        echo       Falling back to embedded template via --jinja.
        set "JINJA_FLAG=--jinja"
    )
) else (
    if "!MODEL_USE_JINJA!"=="1" set "JINJA_FLAG=--jinja"
    if not "!MODEL_CHAT_TEMPLATE!"=="" (
        set "CHAT_TEMPLATE_FLAG=--chat-template !MODEL_CHAT_TEMPLATE!"
    )
)

:: Write a small launcher script so we can reliably redirect output
:: to a log file. (start + cmd /c + multi-line caret = quoting hell.)
:: LAUNCH_SCRIPT lives in the project root (see CONFIG at the top of
:: this script) instead of %TEMP% so fileserver.ps1 can rewrite it
:: during a hot-swap and the next monitor-loop restart picks up the
:: new model.
> "!LAUNCH_SCRIPT!" (
    echo @echo off
    echo "!SERVER_EXE!" --model "!GGUF_PATH!" --port !SERVER_PORT! --host 127.0.0.1 --ctx-size !CTX_SIZE! --n-gpu-layers !GPU_LAYERS! --cache-type-k !KV_CACHE_TYPE! --cache-type-v !KV_CACHE_TYPE! --parallel 1 !JINJA_FLAG! !CHAT_TEMPLATE_FLAG! --reasoning-format auto ^> "!LOG_FILE!" 2^>^&1
)

start /min "llama-server" "!LAUNCH_SCRIPT!"

echo  [..] Waiting for server to load model...
echo       The first launch on a NEW PC can take several minutes while
echo       your GPU compiles its shaders. Later starts are much faster.
echo       (If the server process stops, we halt and show the log.)
echo.

set "RETRIES=0"
:wait_loop
set /a RETRIES+=1
:: Fast-fail: if the server process has exited, it crashed during load
:: (model too big for VRAM/RAM, or an incompatible GGUF). Don't make the
:: user wait out the full timeout for a server that is already gone.
:: (Skip the first few polls so we don't race the process appearing.)
if !RETRIES! lss 3 goto :wait_poll
tasklist /fi "imagename eq llama-server.exe" 2>nul | findstr /i "llama-server.exe" >nul
if errorlevel 1 (
    echo.
    echo  [ERROR] llama-server stopped during startup -- it could not load the model.
    echo         Most often the model is too large for your VRAM/RAM, or the GGUF
    echo         is incompatible with this llama.cpp build. Try a smaller model.
    echo.
    echo  [LOG] Server log:  !LOG_FILE!
    if exist "!LOG_FILE!" type "!LOG_FILE!"
    goto :fatal
)
:wait_poll
:: Patient cap for a genuine first load: 300 polls x 2s = ~10 minutes,
:: enough for first-ever Vulkan shader compilation on a new machine.
if !RETRIES! gtr 300 (
    echo.
    echo  [ERROR] llama-server did not become ready within ~10 minutes.
    echo         The model may be too large for your hardware. Try a smaller model,
    echo         or reduce GPU_LAYERS in this script.
    echo.
    echo  [LOG] Server log:  !LOG_FILE!
    if exist "!LOG_FILE!" type "!LOG_FILE!"
    goto :fatal
)
timeout /t 2 /nobreak >nul
set /p "=." <nul

call :http_health "http://127.0.0.1:!SERVER_PORT!/health"
if errorlevel 1 goto :wait_loop

echo.
echo  [OK] llama-server is ready!
echo.

:: ---------------------------------------------------------------
:: STEP 3b: VERIFY GPU OFFLOAD
:: Check the log file for Vulkan/GPU info so the user knows
:: whether inference is running on GPU or stuck on CPU.
:: ---------------------------------------------------------------
:verify_gpu
set "GPU_CONFIRMED=0"

:: Check log for Vulkan or CUDA device detection and successful layer offload
if exist "!LOG_FILE!" (
    findstr /i /c:"offloaded" /c:"Vulkan0" /c:"CUDA0" /c:"Metal0" "!LOG_FILE!" >nul 2>&1
    if not errorlevel 1 set "GPU_CONFIRMED=1"
)

if "!GPU_CONFIRMED!"=="1" (
    echo  [OK] GPU acceleration detected
) else (
    echo.
    echo  [*] WARNING: Could not confirm GPU acceleration.
    echo       The model may be running on CPU, which is VERY slow.
    echo.
    echo       Possible causes:
    echo         1. GPU drivers not installed or outdated
    echo            AMD: amd.com/en/support
    echo            NVIDIA: nvidia.com/Download/index.aspx
    echo         2. Wrong llama.cpp build for your GPU
    echo            Vulkan build supports AMD, Intel, and some NVIDIA.
    echo            CUDA build is faster on NVIDIA if available.
    echo         3. GPU doesn't have enough VRAM for this model
    echo            Try a smaller model or lower GPU_LAYERS.
    echo.
    echo       Check the log file for details:
    echo         !LOG_FILE!
    echo.
    if exist "!LOG_FILE!" (
        echo  [LOG] GPU-related log lines:
        findstr /i /c:"Vulkan" /c:"CUDA" /c:"GPU" /c:"backend" /c:"offload" /c:"error" /c:"fail" "!LOG_FILE!" 2>nul
        echo.
    )
    call :prompt_yn "  Continue anyway?" CONTINUE_CPU
    if /i "!CONTINUE_CPU!"=="N" goto :fatal
)

:: Check for VRAM pressure warnings
if exist "!LOG_FILE!" (
    findstr /i /c:"cannot meet free memory" /c:"failed to fit" "!LOG_FILE!" >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo  [*] VRAM WARNING: Model is tight on your GPU memory.
        echo       If you get 500 errors during chat, try:
        echo         - Reduce CTX_SIZE at the top of this script
        echo         - Use a smaller model or quantization
        echo       Current CTX_SIZE = !CTX_SIZE!
    )
)
echo.

:: ---------------------------------------------------------------
:: STEP 3c: EMBEDDING SERVER (RAG Retriever A) -- optional
:: Second llama-server (--embeddings) on loopback :EMBED_PORT, CPU by
:: default. Degrade-safe: any failure just logs a note and continues
:: to the search proxy; chat is never blocked. NOT part of the
:: health-monitor / hot-swap loop -- if it dies, the RAG degrades to
:: tag-only and the chat server is left untouched.
:: ---------------------------------------------------------------
:start_embed
if /i "!EMBED_ENABLE!"=="0" (
    echo  [*] Embedding server disabled ^(EMBED_ENABLE=0^) -- RAG uses tag-only retrieval.
    goto :start_proxy
)

call :http_alive "http://127.0.0.1:!EMBED_PORT!/health"
if not errorlevel 1 (
    echo  [OK] Embedding server already on :!EMBED_PORT!
    goto :start_proxy
)

set "EMBED_PATH=!MODEL_DIR!\!EMBED_MODEL_GGUF!"
if exist "!EMBED_PATH!" goto :embed_spawn

set "EMBED_PART=!EMBED_PATH!.part"
echo  [..] Downloading embedding model ^(one-time, ~146 MB^): !EMBED_MODEL_GGUF!
call :http_get "!EMBED_MODEL_URL!" "!EMBED_PART!"
if not "!HTTP_OK!"=="1" (
    echo  [*] Embedding model download failed -- RAG semantic search will be OFF.
    echo      Chat works normally; weighted-tag retrieval still functions.
    del /f /q "!EMBED_PART!" >nul 2>&1
    goto :start_proxy
)

set "EMBED_ACTUAL="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!EMBED_PART!" SHA256 2^>nul') do if not defined EMBED_ACTUAL set "EMBED_ACTUAL=%%H"
set "EMBED_ACTUAL=!EMBED_ACTUAL: =!"
if not defined EMBED_PIN_SHA256 (
    echo  [*] Embedding model not pinned. To lock it for future installs, set in launch.bat:
    echo        set "EMBED_PIN_SHA256=!EMBED_ACTUAL!"
    goto :embed_finalize
)
if /i "!EMBED_ACTUAL!"=="!EMBED_PIN_SHA256!" (
    echo  [OK] Embedding model checksum verified.
    goto :embed_finalize
)
echo  [*] Embedding model CHECKSUM MISMATCH -- discarding it. Semantic
echo      retrieval will be OFF for this session. Chat is unaffected.
echo        expected: !EMBED_PIN_SHA256!
echo        actual:   !EMBED_ACTUAL!
echo.
echo      Two things this can mean:
echo        1. The download was corrupted or intercepted -- rerun and see
echo           whether the "actual" value changes.
echo        2. EMBED_PIN_SHA256 in launch.bat is wrong. If the "actual"
echo           value is the SAME every time, and other people report the
echo           same hash, that is the likely cause -- please report it.
del /f /q "!EMBED_PART!" >nul 2>&1
goto :start_proxy

:embed_finalize
move /y "!EMBED_PART!" "!EMBED_PATH!" >nul
if errorlevel 1 (
    echo  [*] Could not move the embedding model into place -- RAG semantic search OFF.
    del /f /q "!EMBED_PART!" >nul 2>&1
    goto :start_proxy
)

:embed_spawn
:: Write a small launcher (mirrors the chat server's .llama-launch.cmd).
:: --pooling mean is required by nomic/e5-style embedders; skip it and
:: retrieval quality quietly drops.
:: --batch-size/--ubatch-size are raised to EMBED_CTX because non-causal
:: embedders must fit the WHOLE input in one ubatch. llama-server's
:: default ubatch of 512 silently rejected anything longer, which made
:: long storybook chunks invisible to semantic retrieval (the request
:: 400s, chat.html got null, and the doc just never matched). chat.html
:: now also slices its inputs into sub-512-token segments, so either
:: side alone keeps embeds working -- together they give full headroom.
> "!EMBED_LAUNCH_SCRIPT!" (
    echo @echo off
    echo "!SERVER_EXE!" --model "!EMBED_PATH!" --port !EMBED_PORT! --host 127.0.0.1 --embeddings --pooling mean --ctx-size !EMBED_CTX! --batch-size !EMBED_CTX! --ubatch-size !EMBED_CTX! --n-gpu-layers !EMBED_GPU_LAYERS! ^> "!EMBED_LOG_FILE!" 2^>^&1
)
echo  [..] Starting embedding server on :!EMBED_PORT! ^(CPU^)...
start /min "embed-server" "!EMBED_LAUNCH_SCRIPT!"

set "ERETRIES=0"
:embed_wait
set /a ERETRIES+=1
if !ERETRIES! gtr 40 (
    echo  [*] Embedding server did not come up in time -- RAG semantic search OFF.
    echo      Chat works normally; weighted-tag retrieval still functions.
    goto :start_proxy
)
timeout /t 1 /nobreak >nul
call :http_alive "http://127.0.0.1:!EMBED_PORT!/health"
if errorlevel 1 goto :embed_wait
echo  [OK] Embedding server ready on :!EMBED_PORT!
echo.

:: ---------------------------------------------------------------
:: STEP 4: WEB SEARCH
::
:: There is no separate process for this any more -- fileserver.ps1
:: serves /search directly. The label below is kept because several
:: earlier branches jump to it; it is now just the point where the
:: embedding step finishes.
:: ---------------------------------------------------------------
:start_proxy

:: The search proxy used to live here: a hidden-window PowerShell started with
:: -EncodedCommand and 4,656 characters of base64, opening a listener on its
:: own port and relaying authenticated requests to an external host.
::
:: That is, in shape, a command-and-control relay. Antivirus engines weight
:: encoded PowerShell heavily and largely independently of what the payload
:: actually does, because ordinary software almost never does it -- and this
:: file already carries two comments explaining why the same pattern was
:: removed from the download paths. The search path had kept a worse version.
::
:: fileserver.ps1 now serves /search itself (Handle-Search). Same destination,
:: same forwarded header, one fewer process, one fewer port, and no encoded
:: payload anywhere in the project.

:: ---------------------------------------------------------------
:: STEP 5: FILE SERVER (serves chat.html over HTTP for LAN access)
:: ---------------------------------------------------------------
:launch

if not exist "%~dp0chat.html" (
    echo  [ERROR] chat.html not found in: %~dp0
    goto :fatal
)

:: Start a lightweight HTTP file server on the web UI port
:: This lets your phone load chat.html over the network
:: Lenient on purpose: / answers 401 when not logged in, which is our own
:: auth layer and therefore proof the file server is up.
call :http_probe "http://127.0.0.1:!WEB_PORT!/"
if not errorlevel 1 (
    echo  [OK] File server already running on :!WEB_PORT!
    goto :get_lan_ip
)

:: ---------------------------------------------------------------
:: Is the port already taken, and by what?
::
:: This is the check behind both "custom ports do not work" and "I rebooted
:: and it fixed itself". Same cause: something was already bound to the
:: port. Usually it is a fileserver.ps1 orphaned by a previous run --
:: closing the launcher window does not stop it -- and a reboot clears it,
:: which is why rebooting appears to fix a configuration that was never
:: wrong.
::
:: HttpListener's message for this is unhelpful, so identify the holder here
:: and name it. "PID 9312, powershell.exe" turns a mystery into one Task
:: Manager click.
:: ---------------------------------------------------------------
set "PORT_HOLDER="
if defined HAVE_PS (
    set "GN_CHKPORT=!WEB_PORT!"
    for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "try { $p=[int]$env:GN_CHKPORT; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1; if ($c) { $pr=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; ('PID {0} ({1})' -f $c.OwningProcess, $(if($pr){$pr.ProcessName}else{'unknown'})) } } catch { }"`) do set "PORT_HOLDER=%%H"
    set "GN_CHKPORT="
)
if defined PORT_HOLDER (
    echo.
    echo  [*] Port !WEB_PORT! is already in use by !PORT_HOLDER!.
    echo.
    echo      If that is powershell.exe it is almost certainly a GobboNet
    echo      file server left over from a previous run -- closing the
    echo      launcher window does not stop it. End that PID in Task
    echo      Manager, or reboot, then start again.
    echo.
    echo      If it is something else, that program owns the port. Choose a
    echo      different one: put a number in .gobbonet-port, or run
    echo          set GEMMA_LISTEN_PORT=9067
    echo      in this window and launch again.
    echo.
    call :prompt_yn "  Try to start anyway?" PORT_TRY_ANYWAY
    if /i not "!PORT_TRY_ANYWAY!"=="Y" goto :fatal
)

echo  [..] Starting file server on :!WEB_PORT!...

:: Use the standalone fileserver.ps1 (reverse proxy included).
:: Environment variables pass config without batch escaping issues.
if not exist "%~dp0fileserver.ps1" (
    echo  [ERROR] fileserver.ps1 not found in: %~dp0
    echo         This file should be alongside launch.bat and chat.html.
    goto :fatal
)
set "GEMMA_ROOT=%~dp0."
set "GEMMA_LLM_PORT=!SERVER_PORT!"
set "GEMMA_EMBED_PORT=!EMBED_PORT!"
:: Extra env vars the file server needs to spawn a replacement
:: llama-server during a hot-swap. fileserver.ps1 reads these once at
:: startup and uses them to build the new launch command when the
:: /swap-model endpoint is hit. Keep them consistent with the values
:: used by :start_server above.
set "GEMMA_SERVER_EXE=!SERVER_EXE!"
set "GEMMA_MODEL_DIR=!MODEL_DIR!"
set "GEMMA_CTX_SIZE=!CTX_SIZE!"
set "GEMMA_GPU_LAYERS=!GPU_LAYERS!"
set "GEMMA_KV_CACHE_TYPE=!KV_CACHE_TYPE!"
set "GEMMA_LOG_FILE=!LOG_FILE!"
set "GEMMA_LAUNCH_SCRIPT=!LAUNCH_SCRIPT!"
set "GEMMA_ACCESS_SECRET=!ACCESS_SECRET!"
:: fileserver.ps1 resolves the port the same way, but pass it explicitly so
:: the two can never disagree about which port this run is using.
set "GEMMA_LISTEN_PORT=!WEB_PORT!"
:: -WindowStyle Hidden removed, deliberately, for two reasons.
::
:: 1. A hidden-window PowerShell that binds a LAN-facing port is its own
::    antivirus signal, on top of the encoded-payload one this release
::    already removed. -File against a real .ps1 gets AMSI-scanned in
::    plaintext and reads as what it is: a web server.
::
:: 2. It was actively harmful. fileserver.ps1 records that hidden state
::    propagates to children created by Start-Process, so the cmd it spawns
::    for a model hot-swap never allocated a console and llama-server could
::    not write its log. That comment is still in fileserver.ps1; this is
::    the cause it was working around.
::
:: start /min alone gives a minimised taskbar entry instead of nothing. That
:: is one more button than before -- the honest cost of this change.
start /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fileserver.ps1"

set "FRETRIES=0"
:fserver_wait
set /a FRETRIES+=1
if !FRETRIES! gtr 8 (
    echo.
    echo  [*] File server did not come up on :!WEB_PORT!.
    echo.
    :: fileserver.ps1 has always printed the specific reason -- into a
    :: window started with -WindowStyle Hidden, so nobody ever read it.
    :: It now mirrors startup output to fileserver.log. Print that rather
    :: than guessing; the old guess named one of four possible causes and
    :: was usually the wrong one.
    if exist "%~dp0fileserver.log" (
        echo      --- fileserver.log -------------------------------------
        type "%~dp0fileserver.log"
        echo      -------------------------------------------------------
    ) else (
        echo      fileserver.log was never written, which means PowerShell
        echo      did not run the script at all. Suspect AppLocker or WDAC
        echo      script policy, or antivirus quarantine of fileserver.ps1.
    )
    echo.
    :: The old text said "Desktop chat still works normally." It does not:
    :: chat.html is SERVED by this file server and all model traffic is
    :: proxied same-origin through /llm, so when this is down there is no
    :: chat at all. A leftover from the pre-proxy design, and reporters
    :: were right to call it out.
    echo      Desktop chat is ALSO down -- chat.html is served by this
    echo      server, so there is nothing for the browser to reach.
    echo.
    echo      Stopgap: open chat.html directly from this folder in your
    echo      browser. It falls back to talking to llama-server on
    echo      127.0.0.1:!SERVER_PORT! without the proxy, state sync or
    echo      hot-swap, but it will chat.
    goto :get_lan_ip
)
timeout /t 1 /nobreak >nul
:: Lenient on purpose: / answers 401 when not logged in, which is our own
:: auth layer and therefore proof the file server is up.
call :http_probe "http://127.0.0.1:!WEB_PORT!/"
if errorlevel 1 goto :fserver_wait
echo  [OK] File server on :!WEB_PORT!

:: Did it fall back to loopback? fileserver.ps1 retries 127.0.0.1 when the
:: wildcard prefix is refused, so the chat works here but phones cannot
:: reach it. That is the normal state after changing ports or upgrading
:: from an install that only ever had a URL ACL for the old one -- and it
:: is silent unless someone reads the log, which nobody does when the chat
:: is working. Say it in the window instead.
if exist "%~dp0fileserver.log" (
    findstr /c:"THIS PC ONLY" "%~dp0fileserver.log" >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo  [*] The file server is bound to this PC only.
        echo      Other devices on your network cannot reach it yet.
        echo.
        echo      Windows needs a URL reservation for port !WEB_PORT!, and
        echo      there is not one. If you changed the port, or upgraded from
        echo      a version that used 8080, the old reservation does not
        echo      carry over.
        echo.
        echo      Fix: right-click setup-lan.bat and Run as administrator.
        echo      It reads the same port this launcher is using.
        echo.
    )
)

:: ---------------------------------------------------------------
:: STEP 6: GET LAN IP + LAUNCH BROWSER
:: ---------------------------------------------------------------
:get_lan_ip
:: Detect the local network IP so we can show the phone URL
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
    set "LAN_IP=%%A"
    for /f "tokens=* delims= " %%B in ("!LAN_IP!") do set "LAN_IP=%%B"
    goto :got_ip
)
set "LAN_IP=<could not detect>"
:got_ip

:: ---------------------------------------------------------------
:: HOSTNAME / mDNS DETECTION
::
:: Windows 10 (1703+) and Windows 11 automatically advertise the
:: PC's name on the local network via mDNS through the dnscache
:: service. Modern Android (Nov 2021+) and iOS resolve <name>.local
:: in browsers natively - no app or config needed on the phone.
::
:: The hostname URL is preferred because it's STABLE across IP
:: rotations: the browser keys localStorage by origin, and the
:: hostname stays the same even when the LAN IP changes. Users
:: who bookmark <hostname>.local:<port> won't lose their chats when
:: their PC's DHCP lease rolls over.
:: ---------------------------------------------------------------
set "LAN_HOST=!COMPUTERNAME!"
:: Lowercase the hostname (mDNS is case-insensitive but bookmarks look better)
:: Build a lowercase copy via a small PowerShell call. Falls back to the
:: original case on any error.
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$env:COMPUTERNAME.ToLower()" 2^>nul`) do set "LAN_HOST=%%A"
if not defined LAN_HOST set "LAN_HOST=!COMPUTERNAME!"

:: Quick reachability check - does this PC respond to its own .local name?
:: If yes, mDNS is working and other devices on the LAN should reach us
:: at <LAN_HOST>.local. If no, fall back to recommending the IP URL only.
set "MDNS_OK=0"
ping -n 1 -w 500 "!LAN_HOST!.local" >nul 2>&1
if not errorlevel 1 set "MDNS_OK=1"

:: ---------------------------------------------------------------
:: IP CHANGE DETECTION
::
:: Each LAN IP is a separate browser origin. When this PC's IP
:: rotates between launches, the phone's localStorage at the OLD IP
:: stays put (and unreachable), and the phone bookmark needs to be
:: updated. Without a warning, users think their chats vanished -
:: they didn't, the new origin just has its own (empty) localStorage.
::
:: Also: chat.html now mirrors state to the file server's /state
:: endpoint, so even if the user IS on a new IP, their data will be
:: offered for restore on first load. This warning just gets ahead
:: of the surprise.
::
:: NOTE: this whole problem disappears if users bookmark the .local
:: hostname URL instead of the IP URL. The warning is here for users
:: who haven't switched yet.
:: ---------------------------------------------------------------
set "LAST_IP_FILE=%~dp0.last-lan-ip"
set "PREV_LAN_IP="
if exist "!LAST_IP_FILE!" (
    set /p "PREV_LAN_IP="<"!LAST_IP_FILE!"
)
:: Save current IP for next launch
> "!LAST_IP_FILE!" echo !LAN_IP!

set "IP_CHANGED=0"
if defined PREV_LAN_IP (
    if /i not "!PREV_LAN_IP!"=="!LAN_IP!" (
        if not "!LAN_IP!"=="<could not detect>" (
            set "IP_CHANGED=1"
        )
    )
)

echo.
echo  ====================================================
echo   Ready! Opening chat in your browser.
echo.
if "!IP_CHANGED!"=="1" (
    echo   [*] LAN IP CHANGED since last launch!
    echo       Previous: http://!PREV_LAN_IP!:!WEB_PORT!
    echo       Current:  http://!LAN_IP!:!WEB_PORT!
    echo.
    if "!MDNS_OK!"=="1" (
        echo       TIP: Bookmark http://!LAN_HOST!.local:!WEB_PORT!
        echo       on your phone instead - that URL stays the
        echo       same even when the IP rotates.
    ) else (
        echo       Update your phone's bookmark to the NEW URL.
    )
    echo       Your chats are safe - the chat app will offer
    echo       to restore them automatically on first load.
    echo.
)
echo   PRIVACY SUMMARY:
echo     llama.cpp:    100%% offline, zero telemetry
echo     Search proxy: only active when you click the
echo                   search icon in chat
echo     No accounts, no API keys, no tracking.
echo.
echo   LAN ACCESS (same Wi-Fi / network):
echo     On this PC:    http://127.0.0.1:!WEB_PORT!
if "!MDNS_OK!"=="1" (
    echo     On your phone: http://!LAN_HOST!.local:!WEB_PORT!  [stable, recommended]
    echo                or  http://!LAN_IP!:!WEB_PORT!          [also works]
    echo.
    echo     The .local URL is preferred - it survives IP changes,
    echo     so your bookmarks never break. Works on Android 12+
    echo     and any iPhone or iPad without extra setup.
) else (
    echo     On your phone: http://!LAN_IP!:!WEB_PORT!
    echo.
    echo     [*] mDNS not responding on this PC. The .local
    echo         hostname can't be used until that's fixed -
    echo         see TROUBLESHOOTING.md or run setup-lan.bat
    echo         as Administrator to open UDP 5353.
)
echo.
echo   If your phone can't connect, run setup-lan.bat
echo   as Administrator once to open the firewall.
echo.
echo   ----------------------------------------------------
echo   SECURITY NOTE: connections use plain HTTP, so traffic
echo   on your network is NOT encrypted. The password keeps
echo   strangers out, but anyone who has your Wi-Fi password
echo   and is actively snooping could in theory read it.
echo   This is fine for a home network you trust. Don't run
echo   it on shared/public Wi-Fi, and don't reuse an
echo   important password here. (See SECURITY.md for the
echo   optional HTTPS setup if you want encryption.)
echo   ----------------------------------------------------
echo.
echo   This window will minimize in 8 seconds.
echo   It monitors server health in the background.
echo.
echo   To shut down: restore this window and press Ctrl+C,
echo   or simply close it.
echo  ====================================================
echo.

start "" "http://127.0.0.1:!WEB_PORT!"

:: Pause longer on IP change so the user actually reads the warning
if "!IP_CHANGED!"=="1" (
    timeout /t 15 /nobreak >nul
) else (
    timeout /t 8 /nobreak >nul
)
call :minimize_window

:: ---------------------------------------------------------------
:: HEALTH MONITOR
:: ---------------------------------------------------------------
set "LLM_MISSES=0"

:monitor_loop
timeout /t 15 /nobreak >nul

call :llm_state
if "!LLM_STATE!"=="0" (
    set "LLM_MISSES=0"
    goto :monitor_loop
)

:: ---- llama-server is unreachable ----
::
:: Before assuming a crash, check whether fileserver.ps1 is doing a
:: hot-swap right now. During a swap it intentionally kills the
:: running llama-server, rewrites !LAUNCH_SCRIPT!, and spawns a new
:: one -- if we race in with our own taskkill + restart we end up
:: with two server processes fighting for the same port. The lock
:: file is created BEFORE the kill and removed once the new server
:: reports healthy (or the swap errors out), so it's the source of
:: truth for "leave this alone".
if exist "!SWAP_LOCK!" (
    echo  [..] %TIME% -- llama-server transitioning ^(hot-swap in progress^), monitor standing down.
    goto :monitor_loop
)

:: ---- Server is down - restart it ----
:: State 1 -- the process is alive but /health is not saying "ok" yet.
:: That is loading, or busy serving the generation the user is watching.
:: Killing it here is how a working server got destroyed mid-conversation
:: and then "never came back": the restart wait asked the same question and
:: got the same answer, forever, while the browser carried on fine.
::
:: Give it eight cycles (~2 minutes) before treating it as genuinely wedged.
if "!LLM_STATE!"=="1" (
    set /a LLM_MISSES+=1
    if !LLM_MISSES! lss 8 (
        echo  [..] %TIME% -- llama-server running but not reporting ready ^(loading or busy^). Leaving it alone.
        goto :monitor_loop
    )
    echo.
    echo  [*] %TIME% - llama-server has been running without reporting ready for ~2 minutes.
) else (
    echo.
    echo  [*] %TIME% - llama-server is no longer running.
)

call :restore_window
set "LLM_MISSES=0"
echo  [..] Stopping the chat model on port !SERVER_PORT!...
:: Targeted by port, NOT by image name. The embedding server is the same
:: llama-server.exe binary, so `taskkill /im llama-server.exe` killed it
:: too -- silently taking RAG down on every restart and never bringing it
:: back, because nothing here restarts the embedding server.
set "GN_KILLPORT=!SERVER_PORT!"
if defined HAVE_PS (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:GN_KILLPORT; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' -and $_.CommandLine -like ('*--port ' + $p + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
) else (
    echo      [*] No PowerShell -- falling back to killing every llama-server.exe.
    echo          This also stops the embedding server, so RAG will be off
    echo          until you restart the launcher.
    taskkill /f /im llama-server.exe >nul 2>&1
)
set "GN_KILLPORT="
timeout /t 3 /nobreak >nul

echo  [..] Restarting llama-server...
start /min "llama-server" "!LAUNCH_SCRIPT!"

echo  [..] Waiting for server to come back up...
set "RRETRIES=0"
:restart_wait
set /a RRETRIES+=1
if !RRETRIES! gtr 90 (
    echo.
    echo  [*] %TIME% - Server did not restart within 3 minutes.
    echo       Check the log file for errors:
    echo         !LOG_FILE!
    echo  [LOG] Last 10 lines:
    powershell -NoProfile -Command "Get-Content '!LOG_FILE!' -Tail 10" 2>nul
    echo.
    echo  [..] Will keep trying every 15 seconds...
    goto :monitor_loop
)
timeout /t 2 /nobreak >nul
set /p "=." <nul
call :llm_state
if "!LLM_STATE!"=="0" goto :restart_ok
:: A server that is up and answering, but not saying "ok", is still a server.
:: After ~40s of that we stop demanding the magic word and go back to
:: monitoring -- the alternative is printing dots forever at someone whose
:: chat is working perfectly well.
if "!LLM_STATE!"=="1" if !RRETRIES! gtr 20 (
    echo.
    echo  [OK] %TIME% - llama-server is running and serving requests.
    echo       ^(It is not reporting "ready" on /health, which usually just
    echo        means it is busy with a generation. Resuming monitoring.^)
    goto :restart_resume
)
goto :restart_wait

:restart_ok
echo.
echo  [OK] %TIME% - llama-server restarted successfully!
:restart_resume
timeout /t 5 /nobreak >nul
call :minimize_window
set "LLM_MISSES=0"
goto :monitor_loop

:: ===============================================================
:: UTILITY SUBROUTINES
:: ===============================================================
:minimize_window
powershell -NoProfile -command "try{Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);' -EA Stop}catch{};[C.W]::ShowWindow([C.W]::GetConsoleWindow(),6)" >nul 2>&1
exit /b

:restore_window
powershell -NoProfile -command "try{Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);' -EA Stop}catch{};[C.W]::ShowWindow([C.W]::GetConsoleWindow(),9)" >nul 2>&1
exit /b

:: ---------------------------------------------------------------
:: HTTP HELPERS
::
:: curl is always tried first, with the exact flags the inline calls
:: used before, so on any machine that has curl -- which is every
:: supported Windows -- the command executed is unchanged. The
:: PowerShell branch only ever runs where the old inline call was
:: already failing outright.
::
:: URLs and paths are handed to PowerShell through environment
:: variables rather than interpolated into -Command, so a space or a
:: quote in a path cannot break the command line.
:: ---------------------------------------------------------------

:: :http_get <url> <output> [quiet]   -> sets HTTP_OK to 1 or 0
:http_get
setlocal EnableDelayedExpansion
set "_U=%~1"
set "_O=%~2"
set "_Q=%~3"
set "_OK=0"
if defined HAVE_CURL (
    if /i "!_Q!"=="quiet" (
        curl.exe -s -L --fail --retry 3 -o "!_O!" "!_U!"
        if not errorlevel 1 set "_OK=1"
    ) else if /i "!_Q!"=="resume" (
        :: -C - continues a partial file instead of starting over. Worth
        :: having for a 22 GB model on a domestic connection, where losing
        :: 90%% of a download to a dropped Wi-Fi link is a real event.
        curl.exe -L --fail --retry 3 -C - --progress-bar -o "!_O!" "!_U!"
        if not errorlevel 1 set "_OK=1"
        :: A server that does not honour range requests fails the resume
        :: rather than ignoring it, and so does a .part left over from an
        :: interrupted transfer of a DIFFERENT build of the same filename.
        :: Both are fixed by starting clean, so try exactly once more.
        if not "!_OK!"=="1" (
            echo       [..] resume refused -- restarting this download from the beginning...
            del /f /q "!_O!" >nul 2>&1
            curl.exe -L --fail --retry 3 --progress-bar -o "!_O!" "!_U!"
            if not errorlevel 1 set "_OK=1"
        )
    ) else (
        curl.exe -L --fail --retry 3 --progress-bar -o "!_O!" "!_U!"
        if not errorlevel 1 set "_OK=1"
    )
)
if "!_OK!"=="0" if defined HAVE_PS (
    if /i not "!_Q!"=="quiet" echo       [..] fetching via PowerShell -- no progress bar, please wait...
    set "GN_URL=!_U!"
    set "GN_OUT=!_O!"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $w = New-Object Net.WebClient; $w.DownloadFile($env:GN_URL, $env:GN_OUT); exit 0 } catch { exit 1 }"
    if not errorlevel 1 set "_OK=1"
)
endlocal & set "HTTP_OK=%_OK%"
goto :eof

:: :http_probe <url>   -> errorlevel 0 if ANYTHING answered, including a
::                        404, 401 or 503.
::
:: Deliberately lenient, and correct for exactly one caller: the file
:: server, which answers / with 401 when you are not logged in. A 401 there
:: IS proof of life -- it is our own auth layer talking.
::
:: For every other service use :http_alive. "Something answered" is not the
:: same question as "my service is running", and conflating them is what
:: made Ollama look like llama.cpp.
:http_probe
setlocal EnableDelayedExpansion
set "_RC=1"
if defined HAVE_CURL (
    curl.exe -s -o nul "%~1" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
) else (
    set "GN_URL=%~1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=[Net.WebRequest]::Create($env:GN_URL); $r.Timeout=3000; $r.GetResponse().Close(); exit 0 } catch [Net.WebException] { if ($_.Exception.Response) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
)
endlocal & exit /b %_RC%

:: :llm_state -> sets LLM_STATE:  0 = healthy
::                                1 = process running, not answering "ok" yet
::                                2 = no llama-server process at all
::
:: The monitor used to ask one question -- does /health say ok -- and treat
:: anything else as death. That is too blunt. A server that is loading a
:: model, or busy with the generation the user is watching, can fail that
:: check while being perfectly alive, which is how the launcher ended up
:: killing a working server and then waiting forever for it to "come back"
:: while the user carried on chatting in the browser.
::
:: Distinguishing "not ready" from "not there" is the whole fix. Only state
:: 2 justifies killing anything.
:llm_state
setlocal EnableDelayedExpansion
set "_S=2"
tasklist /fi "imagename eq llama-server.exe" 2>nul | findstr /i "llama-server.exe" >nul 2>&1
if not errorlevel 1 set "_S=1"
if "!_S!"=="1" (
    call :http_health "http://127.0.0.1:!SERVER_PORT!/health"
    if not errorlevel 1 set "_S=0"
)
endlocal & set "LLM_STATE=%_S%"
goto :eof

:: :http_alive <url>  -> errorlevel 0 if the URL returned HTTP 200 AND the
::                       body contains "status". Use this to answer "is MY
::                       service on this port", never :http_probe.
::
:: Why this exists: :http_probe answers "did anything answer at all", which
:: is the wrong question for a port that something else might own. curl -s
:: exits 0 on a 404, and the PowerShell fallback treats any HTTP response as
:: success, so a machine running Ollama on 11434 reported
::     [OK] llama-server already running on port 11434
:: because Ollama answered /health with a 404. The launcher then skipped
:: starting llama.cpp, the monitor later noticed nothing was healthy, and it
:: restarted into a port Ollama already owned -- a restart loop, from one
:: over-generous probe. The search proxy had the same failure with an
:: HTTP.SYS 503, which is what a URL ACL with no listener behind it returns.
::
:: Both llama.cpp and our search proxy answer /health with 200 and
:: {"status":"ok"}, so requiring the status line AND that token identifies
:: ours and rejects a stranger's. Matching on "status" rather than "ok"
:: matters: "ok" appears inside "cookie", "broken" and "look", which show up
:: in ordinary HTML error pages.
:http_alive
setlocal EnableDelayedExpansion
set "_RC=1"
set "_BODY=%TEMP%\gn_probe_%RANDOM%.txt"
if defined HAVE_CURL (
    :: -f makes curl fail on any status >= 400 instead of quietly saving the
    :: error page and exiting 0.
    curl.exe -s -f -o "!_BODY!" "%~1" >nul 2>&1
    if not errorlevel 1 (
        findstr /i "status" "!_BODY!" >nul 2>&1
        if not errorlevel 1 set "_RC=0"
    )
) else (
    set "GN_URL=%~1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=[Net.WebRequest]::Create($env:GN_URL); $r.Timeout=3000; $resp=$r.GetResponse(); if ([int]$resp.StatusCode -ne 200) { $resp.Close(); exit 1 }; $sr=New-Object IO.StreamReader($resp.GetResponseStream()); $b=$sr.ReadToEnd(); $sr.Close(); $resp.Close(); if ($b -match 'status') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
)
del /f /q "!_BODY!" >nul 2>&1
endlocal & exit /b %_RC%

:: :http_health <url>  -> errorlevel 0 if the body contains "ok"
:http_health
setlocal EnableDelayedExpansion
set "_RC=1"
if defined HAVE_CURL (
    curl.exe -s "%~1" 2>nul | findstr /i "ok" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
) else (
    set "GN_URL=%~1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c=(New-Object Net.WebClient).DownloadString($env:GN_URL); if ($c -match 'ok') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
)
endlocal & exit /b %_RC%
