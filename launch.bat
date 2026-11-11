@echo off
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
:: further down is never probed and never gets to complain.
::
:: Kept as hardening rather than as a proven cure. One machine that
:: still showed the message turned out to have no dead %PATH% entry at
:: all, and its bare lookups were silent when run by hand -- so this
:: does not explain every report, and may explain none of them. It
:: costs one line, cannot regress a healthy box, and stops anything
:: earlier in %PATH% shadowing curl or certutil, which is worth having
:: on its own since those two download and checksum the models.
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
::
:: This sits ABOVE the keep-open guard on purpose: the guard's own
:: `cmd /k` is a bare-name lookup too, so anchoring after it would
:: leave one stray line still printing before anything else runs.
:: The relaunched copy inherits the anchored %PATH% and re-runs these
:: three lines harmlessly; a duplicate System32 entry costs nothing.
:: ---------------------------------------------------------------
set "SYS32=%SystemRoot%\System32"
if not exist "%SYS32%\cmd.exe" set "SYS32=%windir%\System32"
if exist "%SYS32%\cmd.exe" set "PATH=%SYS32%;%SYS32%\WindowsPowerShell\v1.0;%PATH%"

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

:: Each probe below runs the tool from its absolute System32 path, and
:: only falls back to a bare name if the tool genuinely is not there
:: (a pre-1803 Windows, or a custom build). The absolute path is belt
:: and braces on top of the PATH anchor above: it means these five --
:: the ones that run before anything is printed, and so the ones users
:: actually see complain -- never touch %PATH% at all, not even on a
:: machine where the tool is missing and the search would otherwise
:: walk every folder in the list looking for it.
set "T_CURL=%SYS32%\curl.exe"
if not exist "!T_CURL!" set "T_CURL=curl.exe"
set "T_PS=%SYS32%\WindowsPowerShell\v1.0\powershell.exe"
if not exist "!T_PS!" set "T_PS=powershell"
set "T_CERTUTIL=%SYS32%\certutil.exe"
if not exist "!T_CERTUTIL!" set "T_CERTUTIL=certutil"
set "T_TAR=%SYS32%\tar.exe"
if not exist "!T_TAR!" set "T_TAR=tar"
set "T_REG=%SYS32%\reg.exe"
if not exist "!T_REG!" set "T_REG=reg"

"!T_CURL!" --version >nul 2>&1
if not errorlevel 1 set "HAVE_CURL=1"

:: An exit-code check is NOT enough here. Wine ships a powershell.exe
:: stub that exits cleanly while being unable to execute anything, so
:: "did it return 0" waves those systems through to fail much later
:: inside the hardware probe or a download with something unreadable.
:: Instead we require PowerShell to echo a marker back AND to resolve
:: the .NET type the download fallback (:http_get) is built on. Either
:: failure means there is no usable PowerShell on this machine.
::
:: The path here is deliberately NOT quoted, and that is load-bearing.
:: `for /f` hands its command to a second cmd, which strips one quote
:: off the front and one off the end before running it. A command that
:: BEGINS with a quote therefore arrives mangled, the probe captures
:: nothing, and the script wrongly concludes PowerShell is broken --
:: measured on Windows 10.0.26200: quoted returns empty, unquoted and
:: bare both return the marker. %SystemRoot% cannot contain a space, so
:: leaving the quotes off is safe; the bare-name fallback above needs
:: none either.
set "PS_PROBE="
for /f "usebackq delims=" %%P in (`!T_PS! -NoProfile -Command "$null=[System.Net.WebClient]; Write-Output 'GOBBONET_PS_OK'" 2^>nul`) do set "PS_PROBE=%%P"
if /i "!PS_PROBE!"=="GOBBONET_PS_OK" set "HAVE_PS=1"

"!T_CERTUTIL!" -? >nul 2>&1
if not errorlevel 1 set "HAVE_CERTUTIL=1"

"!T_TAR!" --version >nul 2>&1
if not errorlevel 1 set "HAVE_TAR=1"

:: Are we on Wine? A registry probe answers this without needing
:: PowerShell -- which matters, because putting this notice inside
:: hardware-probe.ps1 would be useless on exactly the systems that
:: need to see it.
set "ON_WINE="
"!T_REG!" query "HKCU\Software\Wine" >nul 2>&1
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
    echo      This window leans on it: the hardware probe, the model
    echo      identifier and the password check are all PowerShell.
    echo      Those parts won't run without it. gobbonet.exe itself
    echo      does not need it.
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

:: ---------------------------------------------------------------
:: gobbonet.exe IS THE SERVER (1.8.0)
::
:: Up to 1.7.9 a missing gobbonet.exe, or GOBBONET_LEGACY_SERVER=1, sent
:: this script down a second path: it started llama-server itself and
:: served the chat from a PowerShell script. That path was deprecated in
:: 1.7.9 and is gone. Checking here, before the password prompt and the
:: downloads, means nobody answers every question only to be told at the
:: end that there is nothing to hand the answers to.
:: ---------------------------------------------------------------
if not exist "%~dp0gobbonet.exe" goto :no_gobbonet_exe
if defined GOBBONET_LEGACY_SERVER (
    echo  [*] GOBBONET_LEGACY_SERVER is set, but the legacy PowerShell server was
    echo      removed in GobboNet 1.8. The setting is ignored; gobbonet.exe runs.
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
::   2. .gobbonet-port      -- written by gobbonet.exe when it binds
::   3. 9066                -- the default
:: ---------------------------------------------------------------
set "WEB_PORT="
set "WEB_PORT_SRC="
if exist "%~dp0.gobbonet-port" (
    rem Digits only, deliberately.
    rem
    rem A plain `for /f` read of this file is fragile in ways that all look
    rem identical from the outside: a UTF-8 BOM, a UTF-16 file [which some
    rem installer toolchains produce], a trailing CR, or a stray space each
    rem yield a value that fails the numeric test below. The old code then
    rem fell back to 9066 SILENTLY -- so a user who picked 8420 during setup
    rem got 9066 with no explanation, which reads exactly like 'custom ports
    rem do not work'. Strip everything that is not a digit and the file
    rem parses the same whatever wrote it.
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
    echo      Delete .gobbonet-port and start GobboNet once to rewrite it,
    echo      or put a single number in it.
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
set "GPU_LAYERS=-1"
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
:: variable -- only the salt+hash are passed to gobbonet.exe, which
:: re-hashes what you type at login and compares.
::
:: To change the password later: run  launch.bat reset-password
:: (or just delete the .gobbonet-secret file and relaunch).
::
:: gobbonet.exe binds llama-server to 127.0.0.1 (loopback), so it is not
:: reachable from the LAN at all -- only gobbonet.exe's own proxy can
:: talk to it. That binding is the access control for the
:: model; no separate API key is needed.
:: ---------------------------------------------------------------
set "SECRET_FILE=%~dp0.gobbonet-secret"

:: Allow "launch.bat reset-password" to force re-entry.
if /i "%~1"=="reset-password" (
    if exist "!SECRET_FILE!" del "!SECRET_FILE!"
    echo  [..] Password reset requested -- you'll set a new one now.
)

if not exist "!SECRET_FILE!" (
    call :setup_password
)
if not exist "!SECRET_FILE!" (
    echo  [ERROR] No password was set. Cannot start securely. Exiting.
    pause
    exit /b 1
)

:: Load the stored salt:hash for handoff to gobbonet.exe.
::
:: This is validated on EVERY run, not just the run that created it.
:: Previously the first-run path checked what landed on disk and every
:: later run read the file blind -- so if .gobbonet-secret was later
:: emptied, truncated or locked by antivirus, ACCESS_SECRET came back
:: empty and the server that was handed it exited instantly inside a
:: hidden window. From the outside that is indistinguishable from a port
:: or firewall failure, and it sends everyone hunting the wrong thing.
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

:: The shape gobbonet.exe accepts for a stored password (salt:hash, both
:: hex; internal/auth/secret.go), checked here so a bad file is named
:: before the questions start rather than at the login screen.
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

:: Hand the password to gobbonet.exe now, not only at :launch (issue #63).
:: :launch is the last step before the server starts, so a run that stopped
:: anywhere in between -- a cancelled download, a closed window, the model
:: menu -- left .gobbonet-secret on disk and gobbonet.exe's config.toml with
:: no password. Starting gobbonet.exe directly after that (the Start menu
:: shortcut does) asked the user to choose a password a second time.
::
:: Same command, same default config file and same salt:hash value as the
:: write at :launch, which still runs too; this one only lands earlier. The
:: server accepts the salt:hash form and upgrades it on first login
:: (internal/auth/secret.go).
::
:: The write creates config.toml on a first run, and `gobbonet.exe launch`
:: (the Start menu and desktop shortcuts) serves any config.toml it finds.
:: So the run also leaves .gobbonet-setup-pending until :launch: while it is
:: there and the config still names no engine, launch runs this setup again
:: instead of serving nothing (cmd/gobbonet/launch.go).
type nul > "%~dp0.gobbonet-setup-pending" 2>nul
"%~dp0gobbonet.exe" config set access_secret "!ACCESS_SECRET!" >nul 2>&1

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
::   Since 1.8.0 these describe the model in this window only: gobbonet.exe
::   starts llama-server and chooses the same flags for itself
::   (internal/supervisor). The notes below explain what it chooses.
::
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
::   Small 24B / its finetunes.
::
::   The :identify_model block below sets these per family.
set "MODEL_USE_JINJA=1"
set "MODEL_CHAT_TEMPLATE="
set "MODEL_CHAT_TEMPLATE_FILE="

:: Install folder (relative to this script)
set "LLAMA_DIR=%~dp0llama-cpp"
set "MODEL_DIR=%~dp0models"
set "SERVER_EXE=!LLAMA_DIR!\llama-server.exe"

:: llama.cpp release pin, read from engine.sha256 beside this script (issue #63).
::
:: engine.sha256 is the one pin every builder reads -- build-deb.sh,
:: build-rpm.sh, the installers -- and so does `gobbonet engine install`. This
:: script used to carry its own copy, and the two drifted: Linux shipped b10456
:: while every Windows first run downloaded b9294. Reading the same file is what
:: keeps them one pin.
::
:: Pinning (rather than always taking 'latest') means a bad or hijacked future
:: release can't silently land on users' machines. The hash refuses the zip if
:: the asset is ever replaced under the same tag (GitHub permits that), if a
:: TLS-intercepting proxy substitutes it, or if the download is truncated --
:: none of which HTTPS alone catches. It matters here more than almost anywhere:
:: the zip contains the executables that run the model.
::
:: If engine.sha256 is present but lacks a value, that value stays empty and the
:: checks below fail closed: a missing tag means the hash cannot match, and a
:: missing hash asks for an explicit YES before running anything.
set "LLAMA_PIN_TAG="
set "LLAMA_PIN_SHA256="
if exist "%~dp0engine.sha256" (
    for /f "usebackq eol=# tokens=1,* delims==" %%K in ("%~dp0engine.sha256") do (
        if /i "%%K"=="LLAMA_BUILD" set "LLAMA_PIN_TAG=%%L"
        if /i "%%K"=="WIN_GPU_SHA256" set "LLAMA_PIN_SHA256=%%L"
    )
) else (
    rem An install from before engine.sha256 shipped beside this script.
    rem The same pin as engine.sha256 -- tests/test-engine-pin.py fails the
    rem build if these two lines and that file ever disagree.
    set "LLAMA_PIN_TAG=b10456"
    set "LLAMA_PIN_SHA256=60f3d31cc7c2fe62de8f34f8d75ffd06655b4de83bcc5aa6f08df56be42ebb91"
)

:: Model GGUF - set this to use a specific file.
:: Leave empty to auto-detect the first .gguf in the models folder.
set "MODEL_GGUF="

:: ---------------------------------------------------------------
:: EMBEDDING MODEL (RAG Retriever A) -- optional
::
:: A second llama-server instance with --embeddings powers semantic
:: retrieval for the RAG. It is OPTIONAL: if the model cannot be
:: fetched, chat works normally and the RAG falls back to tag-only
:: retrieval (Retriever B).
::
:: Since 1.8.0 this script only DOWNLOADS the model, into models\ as
:: before. gobbonet.exe starts the embedding server, restarts it if it
:: crashes, and stands it down with the chat model -- including when it
:: is started from the Start menu, which never runs this script. How it
:: runs is set in config.toml: embed_mode, embed_model, embed_gpu_layers
:: (CPU by default, so it never takes VRAM from the chat model) and
:: embed_ctx. See CONFIG > Advanced > Config File.
::
:: To skip the download and switch semantic search off: set
:: EMBED_ENABLE=0. This writes embed_mode = "off" into config.toml; to
:: switch it back on, set embed_mode = "managed" there.
:: nomic-embed-text wants the search_document:/search_query: task
:: prefixes (chat.html adds them). A lighter alternative is
:: bge-small-en; point embed_model at it in config.toml.
:: ---------------------------------------------------------------
set "EMBED_ENABLE=1"
if defined GEMMA_EMBED_PORT (
    set "EMBED_PORT=!GEMMA_EMBED_PORT!"
) else (
    set "EMBED_PORT=11436"
)
:: SEARCH_PORT is gone. Web search is served by gobbonet.exe on the web UI
:: port, so nothing binds 11435 and GEMMA_SEARCH_PORT no longer does
:: anything. Setting it is harmless; it is simply ignored.
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
::
:: gobbonet.exe checks the model against its own copy of this pin before
:: every start (internal/config/embed.go); tests/test-embed-supervisor.py
:: keeps the two equal.
set "EMBED_PIN_SHA256=3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7"

goto :main

:: ===============================================================
:no_gobbonet_exe
echo.
echo  [ERROR] gobbonet.exe is missing from:
echo          %~dp0
echo.
echo      GobboNet runs everything through gobbonet.exe. Extract the full
echo      GobboNet package into this folder again, or reinstall. If the
echo      file disappears again, your antivirus has probably quarantined
echo      it: restore it there and add an exclusion for this folder.
goto :fatal

:fatal
echo.
echo  [FATAL] See the error above. Press any key to close.
pause >nul
exit /b 1

:prompt_yn
:: Usage: call :prompt_yn "Question?" RESULT_VAR
:: Sets RESULT_VAR to Y or N. Anything that is not an explicit yes is N.
::
:: _YN is cleared BEFORE the read, and that line is the entire point of this
:: routine existing rather than an inline `set /p`.
::
:: `set /p` does not touch its variable when the user submits an empty line --
:: it leaves whatever was there before. Because every prompt in this file shares
:: one _YN, a Y typed at any question stayed in the variable and was re-read as
:: the answer to the next one. Reported by John McCardle, who put it exactly:
:: "one Y = two answers answered at the same time."
::
:: The pair that made it dangerous sits about 100 lines apart: the llama.cpp
:: download prompt (DO_DOWNLOAD), then the unpinned-hash gate
:: (LLAMA_UNPINNED_OK). Everyone answers Y to the first. The second exists to
:: make someone consciously accept an UNVERIFIED executable, and it was being
:: satisfied by a keystroke aimed at a different question. The gate failed OPEN.
::
:: Cleared after the read as well, so a stale answer cannot outlive this call.
set "%~2=N"
set "_YN="
set /p "_YN=%~1 (Y/N): "
if /i "!_YN!"=="Y" set "%~2=Y"
if /i "!_YN!"=="YES" set "%~2=Y"
set "_YN="
exit /b

:prompt_confirm
:: Usage: call :prompt_confirm "Question?" RESULT_VAR
:: Like :prompt_yn, but demands the whole word YES.
::
:: Clearing _YN closes the stale-value path above. It does not close type-ahead:
:: a user who mashed Y and Enter during the download still has that sitting in
:: the console buffer when the next prompt paints, and cmd has no portable way
:: to flush it.
::
:: So for the one prompt where a wrong answer runs an unverified binary, require
:: a token that cannot be left over from a Y/N question. A buffered Y is not
:: YES, so it fails closed and the user is asked again by a prompt they can
:: actually see.
set "%~2=N"
set "_YN="
set /p "_YN=%~1 (type YES to continue): "
if /i "!_YN!"=="YES" set "%~2=Y"
set "_YN="
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
:: 1.7.9: the minimum is min_password_length from config.toml (8 unless the
:: user set it, never below 4), read by the script itself through
:: gobbonet.exe so no install path goes through cmd quoting. No config yet,
:: or no gobbonet.exe: 8. It only applies to a password being chosen here.
set "GOBBONET_DIR=%~dp0"
(
echo $min = 8
echo $gn = Join-Path $env:GOBBONET_DIR 'gobbonet.exe'
echo if ^(Test-Path -LiteralPath $gn^) { $v = ^& $gn config get min_password_length 2^>$null; if ^("$v" -match '^^\d+$'^) { $min = [Math]::Max^(4, [int]"$v"^) } }
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
:: The file must be one line of <hex>:<hex> -- the form gobbonet.exe
:: reads, so if it does not match here it was never going to work there
:: either.
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
    echo   gobbonet.exe can read.
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
echo      replaced later, and a proxy that intercepts TLS. To pin what
echo      you just downloaded, add this line to engine.sha256 beside
echo      launch.bat:
echo.
echo        WIN_GPU_SHA256=!LLAMA_ACTUAL!
echo.
call :prompt_confirm "  Extract and run this UNVERIFIED download?" LLAMA_UNPINNED_OK
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
:: truth), NOT the filename. identify-model.ps1 reads it here for the
:: summary in this window; gobbonet.exe does the same detection in Go
:: (internal/models) for the model it actually starts.
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
:: into the current environment so they feed the summary below and
:: active-model.json. gobbonet.exe picks the engine's template flags itself.
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
:: markers (MK_1..MK_17) and a recommended option number (REC).
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
echo    [12] Llama 3.2 1B Instruct  Q8_0    ~1.3 GB  !MK_12!
echo         Meta - tiny; runs on almost anything, even without a GPU
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
echo    [13] Mistral Nemo 12B       Q4_K_M  ~7.5 GB  !MK_13!
echo         Mistral AI - a roleplay favourite, 128K context
echo.
echo     [7] DeepSeek-R1 8B         Q8_0    ~8.5 GB  !MK_7!
echo         Reasoning-focused model (Qwen3 distill)
echo         Shows chain-of-thought by default
echo.
echo    [14] Phi-4 14B              Q4_K_M  ~9.1 GB  !MK_14!
echo         Microsoft - careful reasoning and code
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
echo    [15] Mistral Small 3.2 24B  Q4_K_M  ~14.3 GB !MK_15!
echo         Mistral AI - strong dense all-rounder, needs ~18 GB
echo.
echo    [10] Command R 35B (08-2024) Q4_K_S ~19 GB   !MK_10!
echo         Cohere - heavy chat model, needs ~24 GB VRAM
echo         Multilingual strength, 128K context
echo.
echo    [16] Gemma 4 31B IT         Q4_K_M  ~19.6 GB !MK_16!
echo         Google - the largest dense Gemma 4, needs ~24 GB
echo.
echo    [17] Qwen3-Coder 30B-A3B MoE Q4_K_M ~18.6 GB !MK_17!
echo         Alibaba - coding specialist; MoE runs fast
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
:: Only 1-17 is an answer (issue #63). Anything else used to fall through
:: every branch below into the [11] "add my own .gguf" path, which ends at
:: :fatal. The prompt just above this menu is a Y/N question, so "y" was
:: the natural thing to type, and it closed the window with [FATAL]. Ask
:: again instead, without reprinting the menu, so the hint stays on screen.
::
:: Capped at 5 tries: with no console behind it (input at EOF) set /p returns
:: empty forever, and an uncapped loop would spin where the old code exited.
:: After the cap it takes the same [11] path it always did.
set "_MC_TRIES=0"
:ask_model_choice
set "MODEL_CHOICE="
set /p "MODEL_CHOICE=  Your choice [1-17]: "
if not defined MODEL_CHOICE if not "!REC!"=="0" set "MODEL_CHOICE=!REC!"
set "_MC_OK="
for %%N in (1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17) do if "!MODEL_CHOICE!"=="%%N" set "_MC_OK=1"
if not defined _MC_OK (
    set /a _MC_TRIES+=1
    echo.
    if !_MC_TRIES! geq 5 (
        echo  [*] Still no valid choice, so nothing will be downloaded.
        set "MODEL_CHOICE=11"
    ) else (
        if "!REC!"=="0" (
            echo  [*] That is not one of the choices. Type a number from 1 to 17.
        ) else (
            echo  [*] That is not one of the choices. Type a number from 1 to 17,
            echo      or press ENTER for the recommended pick [!REC!].
        )
        echo.
        goto :ask_model_choice
    )
)
set "_MC_OK="

:: VRAM safety net -- if the chosen model wants more GPU memory than we
:: detected, warn and confirm rather than letting a non-technical user
:: download 16 GB of model that will crawl. Skipped when VRAM is unknown
:: (HW_VRAM=0) so we never block on a failed probe.
set "PICK_MIN=0"
if "!MODEL_CHOICE!"=="1" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="2" set "PICK_MIN=6"
if "!MODEL_CHOICE!"=="3" set "PICK_MIN=10"
if "!MODEL_CHOICE!"=="4" set "PICK_MIN=9"
if "!MODEL_CHOICE!"=="5" set "PICK_MIN=18"
if "!MODEL_CHOICE!"=="6" set "PICK_MIN=24"
if "!MODEL_CHOICE!"=="7" set "PICK_MIN=11"
if "!MODEL_CHOICE!"=="8" set "PICK_MIN=14"
:: 9 and 10 had no gate at all, so the VRAM warning never fired for them --
:: including for slot 10, which is the second-largest model in the list.
if "!MODEL_CHOICE!"=="9" set "PICK_MIN=9"
if "!MODEL_CHOICE!"=="10" set "PICK_MIN=24"
if "!MODEL_CHOICE!"=="12" set "PICK_MIN=4"
if "!MODEL_CHOICE!"=="13" set "PICK_MIN=10"
if "!MODEL_CHOICE!"=="14" set "PICK_MIN=12"
if "!MODEL_CHOICE!"=="15" set "PICK_MIN=18"
if "!MODEL_CHOICE!"=="16" set "PICK_MIN=24"
if "!MODEL_CHOICE!"=="17" set "PICK_MIN=22"
if not defined HW_VRAM set "HW_VRAM=0"
:: Mixture-of-Experts models also fit a smaller card, when system RAM can hold
:: the experts that do not fit on it (issue #65): MOE_MIN_VRAM of VRAM and the
:: PICK_MOE_RAM below. The same figures as $moeVram and $moeRam in
:: hw-recommend.ps1, which explains them; gen-catalog.py checks they agree.
set "MOE_MIN_VRAM=8"
set "PICK_MOE_RAM=0"
if "!MODEL_CHOICE!"=="5" set "PICK_MOE_RAM=24"
if "!MODEL_CHOICE!"=="6" set "PICK_MOE_RAM=32"
if "!MODEL_CHOICE!"=="8" set "PICK_MOE_RAM=16"
if "!MODEL_CHOICE!"=="17" set "PICK_MOE_RAM=24"
if not defined HW_RAM set "HW_RAM=0"
if !PICK_MOE_RAM! gtr 0 if !HW_VRAM! geq !MOE_MIN_VRAM! if !HW_RAM! geq !PICK_MOE_RAM! set "PICK_MIN=0"
if !HW_VRAM! gtr 0 if !PICK_MIN! gtr 0 if !HW_VRAM! lss !PICK_MIN! (
    echo.
    echo  [*] Heads up: this model wants about !PICK_MIN! GB of GPU
    echo       memory, but only !HW_VRAM! GB was detected. It may run
    echo       far more slowly than a model that fits, and on a large
    echo       enough shortfall llama-server will fail to start at all
    echo       rather than fall back to system RAM.
    if !PICK_MOE_RAM! gtr 0 (
        echo.
        echo       It is a Mixture-of-Experts model, so a card with at least
        echo       !MOE_MIN_VRAM! GB also runs it well beside !PICK_MOE_RAM! GB of
        echo       system RAM. This PC reports !HW_RAM! GB of RAM.
    )
    echo.
    call :prompt_yn "  Download it anyway?" GO_BIG
    if /i "!GO_BIG!"=="N" goto :show_catalog
    echo.
)

:: MODEL_TAGS sorts each model into the Add a Model window's buckets
:: (roadmap 1.7.7): coding, roleplay, jack-of-all-trades. launch.bat
:: itself never reads it; catalog/gen-catalog.py carries it into
:: models.ini, the same way it carries DL_SHA256. A model can be in more
:: than one bucket (comma-separated), and one in none still shows under
:: ALL MODELS.
::
:: DL_SHA256, where set, is the checksum pinned in the catalogue (1.7.9):
:: the download is checked against it instead of HuggingFace's own record.
:: catalog/pin-hashes.py fills it in. Cleared first so nothing stale leaks in.
set "DL_SHA256="
if "!MODEL_CHOICE!"=="1" (
    set "DL_REPO=bartowski/google_gemma-4-E4B-it-GGUF"
    set "DL_FILE=google_gemma-4-E4B-it-Q4_K_M.gguf"
    set "DL_SHA256=d35a3aa7a6d47de237fd488bb6f7f3efd62908d828f85a63da0ee93acdbefe9f"
    set "MODEL_ID=gemma4-e4b"
    set "MODEL_DISPLAY=Gemma 4 E4B IT"
    set "MODEL_TAGS=jack-of-all-trades"
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
    set "DL_SHA256=b5607b5090a8280063fff2d706bb3408ca6542341b06aab39c3eca0a28575921"
    set "MODEL_ID=llama32-3b"
    set "MODEL_DISPLAY=Llama 3.2 3B Instruct"
    set "MODEL_TAGS=jack-of-all-trades"
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
    set "DL_SHA256=757d75df89821a94841f341f3270b0709d36891dd8fbc41dfd059d213b54c3f5"
    set "MODEL_ID=mistral-7b"
    set "MODEL_DISPLAY=Mistral 7B v0.3"
    set "MODEL_TAGS=roleplay"
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
    set "DL_SHA256=d784ce9eda1a5a7b51e8f705a9e6310844bf4f173654d115823c775fdea56d43"
    set "MODEL_ID=qwen35-9b"
    set "MODEL_DISPLAY=Qwen3.5 9B"
    set "MODEL_TAGS=coding"
    set "MODEL_FAMILY=qwen"
    set "MODEL_MAX_CTX=131072"
    rem Qwen3.5 emits reasoning between [think] tags like the rest of the
    rem Qwen3 line. identify-model.ps1 re-detects this from the GGUF after
    rem download, so this value only has to be right enough to start with.
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="5" (
    set "DL_REPO=bartowski/google_gemma-4-26B-A4B-it-GGUF"
    set "DL_FILE=google_gemma-4-26B-A4B-it-Q4_K_S.gguf"
    set "DL_SHA256=2700522f644211990d7082f480e7f564a05b4613e93e54d7e274be7e727e5916"
    set "MODEL_ID=gemma4-26b"
    set "MODEL_DISPLAY=Gemma 4 26B-A4B MoE"
    set "MODEL_TAGS=roleplay,jack-of-all-trades"
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
    set "DL_SHA256=b46fedd33e0bfb0cae308aa3c158d0a4b2c4a1d2185a1ed6f093cdaf39064772"
    set "MODEL_ID=qwen36-35b"
    set "MODEL_DISPLAY=Qwen3.6 35B-A3B MoE"
    set "MODEL_TAGS=coding,jack-of-all-trades"
    set "MODEL_FAMILY=qwen"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=deepseek"
    rem 8192, not the 16384 its predecessor used. The weights are 22.29 GB
    rem and the gate below asks for 24 GB, so on a card that only just
    rem qualifies there is under 2 GB left for the KV cache. A context that
    rem does not fit fails at load with an out-of-memory error rather than
    rem degrading, so the default errs small; the config panel raises it for
    rem anyone with headroom.
    set "CTX_SIZE=8192"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="7" (
    rem The repo and the filename both carry a deepseek-ai_ prefix. Without
    rem it the URL 404s, which is what made this slot uninstallable.
    set "DL_REPO=bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF"
    set "DL_FILE=deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q8_0.gguf"
    set "DL_SHA256=9144694fd6a4347d9842b20797946754fb673871b92ba966e32e51b9057fa428"
    set "MODEL_ID=deepseek-r1-8b"
    set "MODEL_DISPLAY=DeepSeek-R1 8B"
    set "MODEL_TAGS=coding"
    set "MODEL_FAMILY=deepseek"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="8" (
    set "DL_REPO=ggml-org/gpt-oss-20b-GGUF"
    rem MXFP4 uppercase. Hugging Face paths are case-sensitive, so the
    rem lowercase spelling 404s.
    set "DL_FILE=gpt-oss-20b-MXFP4.gguf"
    set "DL_SHA256=27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901"
    set "MODEL_ID=gpt-oss-20b"
    set "MODEL_DISPLAY=gpt-oss 20B"
    set "MODEL_TAGS=coding,jack-of-all-trades"
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
    set "DL_SHA256=a19c0e9ceb5b29da7059acd4db343d445980e267caa34b3b37864b4f965b7126"
    set "MODEL_ID=command-r7b"
    set "MODEL_DISPLAY=Command R 7B (12-2024)"
    set "MODEL_TAGS=jack-of-all-trades"
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
    set "DL_SHA256=036ef6a9fd808b2fb09a3b1bca79da5ebc16e20ae5c27a714a2319b43ef89a17"
    set "MODEL_ID=command-r-35b"
    set "MODEL_DISPLAY=Command R 35B (08-2024)"
    set "MODEL_TAGS=roleplay"
    set "MODEL_FAMILY=cohere"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="12" (
    set "DL_REPO=bartowski/Llama-3.2-1B-Instruct-GGUF"
    set "DL_FILE=Llama-3.2-1B-Instruct-Q8_0.gguf"
    set "DL_SHA256=432f310a77f4650a88d0fd59ecdd7cebed8d684bafea53cbff0473542964f0c3"
    set "MODEL_ID=llama32-1b"
    set "MODEL_DISPLAY=Llama 3.2 1B Instruct"
    set "MODEL_TAGS=jack-of-all-trades"
    set "MODEL_FAMILY=llama"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="13" (
    set "DL_REPO=bartowski/Mistral-Nemo-Instruct-2407-GGUF"
    set "DL_FILE=Mistral-Nemo-Instruct-2407-Q4_K_M.gguf"
    set "DL_SHA256=7c1a10d202d8788dbe5628dc962254d10654c853cae6aaeca0618f05490d4a46"
    set "MODEL_ID=mistral-nemo-12b"
    set "MODEL_DISPLAY=Mistral Nemo 12B (2407)"
    set "MODEL_TAGS=roleplay"
    set "MODEL_FAMILY=mistral"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    rem A Tekken-tokenizer model: the 1.7.9 Tekken fix (--no-jinja with the
    rem built-in template) is what makes it answer properly.
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="14" (
    set "DL_REPO=bartowski/phi-4-GGUF"
    set "DL_FILE=phi-4-Q4_K_M.gguf"
    set "DL_SHA256=009aba717c09d4a35890c7d35eb59d54e1dba884c7c526e7197d9c13ab5911d9"
    set "MODEL_ID=phi4-14b"
    set "MODEL_DISPLAY=Phi-4 14B"
    set "MODEL_TAGS=coding,jack-of-all-trades"
    set "MODEL_FAMILY=phi"
    set "MODEL_MAX_CTX=16384"
    set "MODEL_THINK_FMT=none"
    rem Lower-case repo and file. Hugging Face paths are case-sensitive.
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="15" (
    set "DL_REPO=bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF"
    set "DL_FILE=mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf"
    set "DL_SHA256=80f5bda68f156f12650ca03a0a2dbfae06a215ac41caa773b8631a479f82415e"
    set "MODEL_ID=mistral-small-32-24b"
    set "MODEL_DISPLAY=Mistral Small 3.2 24B (2506)"
    set "MODEL_TAGS=roleplay,jack-of-all-trades"
    set "MODEL_FAMILY=mistral"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="16" (
    set "DL_REPO=bartowski/google_gemma-4-31B-it-GGUF"
    set "DL_FILE=google_gemma-4-31B-it-Q4_K_M.gguf"
    set "DL_SHA256=2959c1b0a4f792493bb0092846ea06aec54547e47be979c282634d938d501b75"
    set "MODEL_ID=gemma4-31b"
    set "MODEL_DISPLAY=Gemma 4 31B IT"
    set "MODEL_TAGS=roleplay,jack-of-all-trades"
    set "MODEL_FAMILY=gemma"
    set "MODEL_MAX_CTX=262144"
    set "MODEL_THINK_FMT=gemma"
    rem 8192 for the reason slot 6 gives: 19.6 GB of weights on a 24 GB card
    rem leaves little for the KV cache. CONFIG raises it for anyone with room.
    set "CTX_SIZE=8192"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="17" (
    set "DL_REPO=unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    set "DL_FILE=Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
    set "DL_SHA256=fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad"
    set "MODEL_ID=qwen3-coder-30b"
    set "MODEL_DISPLAY=Qwen3-Coder 30B-A3B MoE"
    set "MODEL_TAGS=coding"
    set "MODEL_FAMILY=qwen"
    set "MODEL_MAX_CTX=262144"
    set "MODEL_THINK_FMT=none"
    rem Qwen3-Coder answers directly; it has no thinking mode.
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
    rem The partial file is kept on a TRANSPORT failure, deliberately, so
    rem re-running resumes instead of starting a multi-gigabyte transfer
    rem over. It is still deleted further down when VERIFICATION fails --
    rem a file that arrived intact but hashes wrong is not something to
    rem resume, it is something to discard.
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

:: A checksum pinned in the catalogue (1.7.9) wins: it was recorded when the
:: catalogue was made, so it does not come from the host serving the file.
set "MODEL_EXPECTED="
if defined DL_SHA256 (
    echo  [..] Using the SHA-256 pinned in the model catalogue.
    set "MODEL_EXPECTED=!DL_SHA256!"
    goto :model_hash_compare
)

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

:model_hash_compare
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
:: GGUF_BASENAME from GGUF_PATH and carries on at :write_model_json.
goto :identify_model

:: ---------------------------------------------------------------
:: MODEL IDENTIFIED
::
:: Up to 1.7.9 this point wrote active-model.json and models-list.json
:: for the PowerShell server to hand to the page. gobbonet.exe answers
:: both itself, from its own scan of models\ (internal/models/info.go),
:: so nothing is written here any more.
:: ---------------------------------------------------------------
:write_model_json

:: ---------------------------------------------------------------
:: STEP 3: LLAMA-SERVER (gobbonet.exe starts it)
::
:: Everything above this line asks and fetches: the password, the
:: engine, the hardware probe, the model menu and the checksum of what
:: it downloaded. That is the Windows experience and it stays in this
:: window.
::
:: This script does not start the chat model. gobbonet.exe does, at
:: STEP 5, with the choices collected above -- it has to own the process
:: for idle stand-down, hot-swaps and restarts to work at all.
:: ---------------------------------------------------------------
:start_server
echo  [OK] gobbonet.exe will start llama-server itself.
echo       Your model choice and settings are handed to it below, and
echo       its output appears in THIS window.
echo.

:: ---------------------------------------------------------------
:: STEP 3c: EMBEDDING MODEL (RAG Retriever A) -- optional
:: Downloaded once into models\, where gobbonet.exe finds it and starts
:: the embedding server itself (1.8.0). Degrade-safe: any failure just
:: logs a note and continues to the hand-over; chat is never blocked.
:: ---------------------------------------------------------------
:start_embed
if /i "!EMBED_ENABLE!"=="0" (
    echo  [*] Embedding model skipped ^(EMBED_ENABLE=0^) -- RAG uses tag-only retrieval.
    "%~dp0gobbonet.exe" config set embed_mode off >nul 2>&1
    goto :start_proxy
)

set "EMBED_PATH=!MODEL_DIR!\!EMBED_MODEL_GGUF!"
if exist "!EMBED_PATH!" (
    echo  [OK] Embedding model is here -- gobbonet.exe starts the embedding server.
    goto :start_proxy
)

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

:: Into place: gobbonet.exe starts the embedding server from it.
echo  [OK] Embedding model ready -- gobbonet.exe starts the embedding server.
echo.

:: ---------------------------------------------------------------
:: STEP 4: WEB SEARCH
::
:: There is no separate process for this any more -- gobbonet.exe
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
:: The server now answers /search itself. Same destination, same forwarded
:: header, one fewer process, one fewer port, and no encoded payload anywhere
:: in the project.

:: ---------------------------------------------------------------
:: STEP 5: HAND OVER TO gobbonet.exe (it serves the chat, here and on the LAN)
:: ---------------------------------------------------------------
:launch

:: ---------------------------------------------------------------
:: HAND THE SERVER ROLE TO gobbonet.exe
::
:: Not a different experience -- the same window, carrying on. Every
:: question was asked above; this passes the answers to the program
:: that now serves them, and runs it HERE rather than in a minimised
:: window, so the loading output, the GPU check and any errors land
:: in front of the person who has been reading this screen.
::
:: The password needs no re-asking: .gobbonet-secret holds a
:: salt:hash pair, which is exactly the legacy form gobbonet accepts
:: (internal/auth/secret.go) and quietly upgrades to Argon2id on the
:: first successful login.
:: ---------------------------------------------------------------
:: Checked once more: an antivirus scan can quarantine the file between the
:: first check and now, and "the system cannot find the file" is a worse
:: message than the one :no_gobbonet_exe gives.
if not exist "%~dp0gobbonet.exe" goto :no_gobbonet_exe

echo  [..] Handing over to gobbonet.exe with the settings from this run...
set "GN=%~dp0gobbonet.exe"
"!GN!" config set server_exe      "!SERVER_EXE!"                >nul 2>&1
"!GN!" config set model_dir       "!MODEL_DIR!"                 >nul 2>&1
"!GN!" config set ctx_size        "!CTX_SIZE!"                  >nul 2>&1
"!GN!" config set gpu_layers      "!GPU_LAYERS!"                >nul 2>&1
"!GN!" config set kv_cache_type   "!KV_CACHE_TYPE!"             >nul 2>&1
"!GN!" config set listen_port     "!WEB_PORT!"                  >nul 2>&1
"!GN!" config set llm_url         "http://127.0.0.1:!SERVER_PORT!" >nul 2>&1
"!GN!" config set embed_url       "http://127.0.0.1:!EMBED_PORT!"  >nul 2>&1
"!GN!" config set access_secret   "!ACCESS_SECRET!"             >nul 2>&1
:: Setup reached the end: the config names its engine now, and launch can
:: serve it directly from here on.
if exist "%~dp0.gobbonet-setup-pending" del /q "%~dp0.gobbonet-setup-pending" >nul 2>&1
echo  [OK] Settings written.
echo.

:: 1.8.0 (PR #58): open_browser in config.toml decides whether the chat
:: opens in a browser, here as on every other start -- "Setup or add a
:: model" too. It is read into a file and back rather than through
:: for /f, so the install path never goes through cmd's quote handling.
:: gobbonet launch --no-browser sets GOBBONET_OPEN_BROWSER=false for this
:: run, and that beats the file. Anything else, or nothing, means open.
set "GN_OPEN=--open"
set "GN_OPEN_VAL="
set "GN_OPEN_FILE=%TEMP%\gobbonet_open_browser_%RANDOM%.txt"
"!GN!" config get open_browser > "!GN_OPEN_FILE!" 2>nul
if exist "!GN_OPEN_FILE!" set /p GN_OPEN_VAL=<"!GN_OPEN_FILE!"
del /q "!GN_OPEN_FILE!" >nul 2>&1
if /i "!GN_OPEN_VAL!"=="false" set "GN_OPEN="
if /i "!GOBBONET_OPEN_BROWSER!"=="false" set "GN_OPEN="
if not defined GN_OPEN echo  [..] Not opening a browser ^(open_browser = false^). The chat will be at http://127.0.0.1:!WEB_PORT!/

:: --model, because STEP 2 just asked which one. Letting the server
:: pick the first file it scans would make that menu decorative.
set "GOBBONET_BANNER_SHOWN=1"
"!GN!" !GN_OPEN! --model "!GGUF_BASENAME!"
set "GN_RC=!errorlevel!"
set "GOBBONET_BANNER_SHOWN="

:: 3 is RESTART NOW in ABOUT (the update button, 1.8.0): the updated
:: gobbonet.exe is already running in this window, and this script steps out
:: of its way. `exit`, not `exit /b`, so the keep-open guard's prompt does not
:: open underneath it either.
if "!GN_RC!"=="3" exit 0

:: gobbonet runs until Ctrl+C. Reaching here means it stopped; the
:: keep-open guard holds the window so its last words stay readable.
echo.
echo  [..] GobboNet has stopped.
exit /b

:: ===============================================================
:: UTILITY SUBROUTINES
:: ===============================================================
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
        rem -C - continues a partial file instead of starting over. Worth
        rem having for a 22 GB model on a domestic connection, where losing
        rem 90%% of a download to a dropped Wi-Fi link is a real event.
        curl.exe -L --fail --retry 3 -C - --progress-bar -o "!_O!" "!_U!"
        if not errorlevel 1 set "_OK=1"
        rem A server that does not honour range requests fails the resume
        rem rather than ignoring it, and so does a .part left over from an
        rem interrupted transfer of a DIFFERENT build of the same filename.
        rem Both are fixed by starting clean, so try exactly once more.
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

:: :http_alive <url>  -> errorlevel 0 if the URL returned HTTP 200 AND the
::                       body contains "status". It answers "is MY service
::                       on this port".
::
:: Why it is strict: a lenient probe answers "did anything answer at all",
:: which is the wrong question for a port that something else might own. curl -s
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
::
:: WHY THIS IS PIPED rather than staged through a scratch file in %TEMP%,
:: which is what it used to do (issue #36 follow-up). The file version
:: printed "The system cannot find the drive specified." once per call on
:: some machines. :http_health, removed with the legacy server in 1.8.0,
:: had always had this piped shape and never printed it -- including one
:: session where it polled five times in a row silently while all three
:: :http_alive calls complained.
:: Running the old body statement by statement outside the launcher
:: reproduced nothing at all, so rather than keep hunting for which line
:: was talking, this drops the scratch file, the delete and %TEMP%
:: entirely. The two probes are now the same routine bar the -f flag and
:: the token they match, which puts this one on the shape already known
:: to be quiet.
::
:: With -f, a non-2xx reply reaches findstr as nothing at all and the
:: match fails, so the pipe carries the same meaning the two-step version
:: did: RC=0 only on a 2xx body that actually contains "status".
:http_alive
setlocal EnableDelayedExpansion
set "_RC=1"
if defined HAVE_CURL (
    rem -f makes curl fail on any status of 400 or above instead of emitting
    rem the error page and exiting 0.
    curl.exe -s -f "%~1" 2>nul | findstr /i "status" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
) else (
    set "GN_URL=%~1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=[Net.WebRequest]::Create($env:GN_URL); $r.Timeout=3000; $resp=$r.GetResponse(); if ([int]$resp.StatusCode -ne 200) { $resp.Close(); exit 1 }; $sr=New-Object IO.StreamReader($resp.GetResponseStream()); $b=$sr.ReadToEnd(); $sr.Close(); $resp.Close(); if ($b -match 'status') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "_RC=0"
)
endlocal & exit /b %_RC%
