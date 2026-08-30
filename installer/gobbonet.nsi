; ================================================================
; GobboNet installer -- Go server edition
;
; Goal: the user goes from "downloaded the setup exe" to "chatting"
; without a single console window. Everything the old launch.bat
; asked at a C:\> prompt is now a wizard page, and the finish page's
; "Start GobboNet" checkbox lands on a working chat.
;
; WHAT IS BUNDLED vs DOWNLOADED
;   bundled:     gobbonet.exe, web assets, llama.cpp, the .ps1 helpers
;   downloaded:  the GGUF model, and only the GGUF model
;
; That split is deliberate. launch.bat documents at length that
; "cmd -> temp .ps1 with Bypass -> downloads an executable archive"
; is the shape behavioral AV reads as malware staging, and that it
; kills the process tree with no error text. An unsigned installer
; fetching a zip full of .exe files is the same shape with a worse
; parent process, so llama.cpp ships inside the installer instead.
; A .gguf is inert data and carries no such signature, so that one
; download stays online -- it is also the only file too large to
; bundle.
;
; The PowerShell we do run (hardware-probe.ps1) only reads WMI,
; the registry and nvidia-smi. It downloads nothing, so it is not
; the pattern launch.bat removed -- and launch.bat already invokes
; it exactly this way.
;
; BUILD: ../installer/build-installer.sh  (do not call makensis directly;
;        the payload staging and version stamp happen there)
; ================================================================

Unicode true

; Must come before anything that emits data (ReserveFile, File, plugins).
; NSIS refuses to change compressor once the header has been touched.
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

; INetC ships in-tree so the build does not depend on what happens to be
; installed in the system NSIS plugin folder. x86-unicode is the correct
; variant: this is a Unicode installer, and the 1.3 build was too.
!addplugindir /x86-unicode "plugins\x86-unicode"

; FileFunc's ${GetSize} has to be instantiated before use.
!insertmacro GetSize

; models.ini is read in .onInit, before any section runs. With SetCompressor
; /SOLID the whole archive would otherwise have to be decompressed to reach
; it; ReserveFile puts it first in the data block instead.
ReserveFile "models.ini"

;-------------------------------------------------------------------
; Build-time inputs. build-installer.sh passes these with -D.
;-------------------------------------------------------------------
!ifndef VERSION
  !error "VERSION not defined -- build via build-installer.sh"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD not defined -- build via build-installer.sh"
!endif

Name "GobboNet"
OutFile "GobboNetSetup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\GobboNet"
InstallDirRegKey HKCU "Software\GobboNet" "InstallDir"

; Per-user install. The 1.3 installer made the same call and its welcome
; page advertises it: "Installs to your user folder. No administrator
; rights required." Asking for elevation here would be a regression, and
; a per-user install is also what keeps the LAN step opt-in.
RequestExecutionLevel user


VIProductVersion "${VERSION_QUAD}"
VIAddVersionKey "ProductName"     "GobboNet"
VIAddVersionKey "FileDescription" "GobboNet Installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "CompanyName"     "Elodine"
VIAddVersionKey "LegalCopyright"  "Elodine / GoblinCorps -- free to use, copy and modify"

;-------------------------------------------------------------------
; State
;-------------------------------------------------------------------
Var Backend          ; "local" | "remote"
Var RemoteUrl
Var RemoteKey

Var HwIni            ; path to the probe's flat INI
Var HwVram
Var HwRam
Var HwDiskFree
Var HwTier
Var HwGpuName
Var HwProbed        ; "1" once the probe has run

Var Pick             ; chosen catalogue index, or "0" for "skip"
Var PickRecommended  ; index the hardware recommends
Var PickDisplay
Var PickRepo
Var PickFile
Var PickSizeGb
Var PickCtx
Var PickKv

Var CatalogIni
Var ChkLan           ; finish-page: LAN setup checkbox

; page control handles
Var Dlg
Var Lbl
Var ModelList
Var RemoteUrlBox
Var RemoteKeyBox
Var RbLocal
Var RbRemote
Var ChkStart

;-------------------------------------------------------------------
; MUI look. Reuses the 1.3 artwork so the wizard still reads as
; Elodine's, not as a generic NSIS default.
;-------------------------------------------------------------------
!define MUI_ABORTWARNING
; Compiled into the exe's resources, so it comes from art/ at build time.
; The payload also carries a copy, but that one is for the shortcuts to
; point at after install.
!define MUI_ICON   "art\gobbonet.ico"
!define MUI_UNICON "art\gobbonet.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "art\modern-header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "art\modern-wizard.bmp"

!define MUI_WELCOMEPAGE_TITLE "GobboNet ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT \
"Local chat for local models. No account, no API key, no telemetry, no corpo middleman. What you type stays on the machine you type it on.$\r$\n$\r$\n\
This installer carries llama.cpp with it. The only thing it fetches is the model you pick, and that comes straight from HuggingFace.$\r$\n$\r$\n\
Installs to your user folder. No administrator rights required."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY

Page custom BackendPageCreate BackendPageLeave
Page custom ProbePageCreate   ProbePageLeave
Page custom ModelPageCreate   ModelPageLeave

!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPageCreate  FinishPageLeave

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;===================================================================
; Helpers
;===================================================================

; Run a command, streaming its output into the details pane, and abort
; the install if it exits non-zero. Every external call in this script
; goes through here so that a failure stops the install instead of
; leaving a half-configured folder that looks installed.
!macro RunChecked cmd what
  DetailPrint "${what}"
  nsExec::ExecToLog '${cmd}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "  [ERROR] ${what} failed (exit $0)"
    Abort "${what} failed with exit code $0. See the details pane above."
  ${EndIf}
!macroend

;-------------------------------------------------------------------
; Read a hex SHA-256 out of certutil's output file.
; certutil prints:
;   line 1: "SHA256 hash of file X:"
;   line 2: the hash (older builds space-separate the bytes)
;   line 3: "CertUtil: -hashfile command completed successfully."
; Stack: (out) hash-or-empty
;-------------------------------------------------------------------
Function ReadCertutilHash
  Push $0
  Push $1
  Push $2
  StrCpy $2 ""
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\hash.txt" r
  ${IfNot} ${Errors}
    FileRead $0 $1          ; header line, discarded
    FileRead $0 $1          ; the hash
    FileClose $0
    ; strip spaces and CR/LF
    Push $1
    Call TrimHex
    Pop $2
  ${EndIf}
  ; Restore $0-$2 and leave the hash on the stack. Exch $2 swaps the
  ; result out of $2 (restoring it) and onto the stack; Exch 2 then sinks
  ; that result below the two remaining saved registers.
  Exch $2
  Exch 2
  Pop $0
  Pop $1
FunctionEnd

; Stack: (in) string -> (out) string with spaces, CR and LF removed
Function TrimHex
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $2 ""
  StrCpy $3 0
  loop:
    StrCpy $1 $0 1 $3
    StrCmp $1 "" done
    IntOp $3 $3 + 1
    StrCmp $1 " "  loop
    StrCmp $1 "$\r" loop
    StrCmp $1 "$\n" loop
    StrCpy $2 "$2$1"
    Goto loop
  done:
  StrCpy $0 $2
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; Find "sha256:" in the HuggingFace LFS pointer and return the hex after it.
; Stack: (in) pointer-file-path -> (out) hash or ""
Function ParseLfsPointer
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $4 ""
  ClearErrors
  FileOpen $1 $0 r
  ${If} ${Errors}
    Goto ptr_done
  ${EndIf}
  ptr_loop:
    FileRead $1 $2
    ${If} ${Errors}
      Goto ptr_close
    ${EndIf}
    StrCpy $3 $2 7
    ${If} $3 == "oid sha"
      ; line looks like: "oid sha256:<hex>"
      StrCpy $4 $2 64 11
      Push $4
      Call TrimHex
      Pop $4
      Goto ptr_close
    ${EndIf}
    Goto ptr_loop
  ptr_close:
  FileClose $1
  ptr_done:
  StrCpy $0 $4
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

;===================================================================
; PAGE 1 -- backend: this machine, or a server elsewhere
;===================================================================
Function BackendPageCreate
  !insertmacro MUI_HEADER_TEXT "Where do the models run?" \
    "GobboNet can drive llama.cpp on this PC, or talk to a server you already have."

  nsDialogs::Create 1018
  Pop $Dlg
  ${If} $Dlg == error
    Abort
  ${EndIf}

  ${NSD_CreateRadioButton} 0 0u 100% 12u "On this PC (bundled llama.cpp)"
  Pop $RbLocal
  ${NSD_CreateLabel} 12u 14u 100% 20u \
    "Picks a model to match your hardware and downloads it now. Everything runs offline afterwards."
  Pop $Lbl

  ${NSD_CreateRadioButton} 0 40u 100% 12u "On another machine (remote llama.cpp)"
  Pop $RbRemote
  ${NSD_CreateLabel} 12u 54u 100% 16u \
    "No model download. Point GobboNet at a server that is already running."
  Pop $Lbl

  ${NSD_CreateLabel} 12u 74u 30u 12u "URL:"
  Pop $Lbl
  ${NSD_CreateText} 44u 72u 70% 12u "$RemoteUrl"
  Pop $RemoteUrlBox

  ${NSD_CreateLabel} 12u 90u 30u 12u "API key:"
  Pop $Lbl
  ${NSD_CreateText} 44u 88u 70% 12u "$RemoteKey"
  Pop $RemoteKeyBox

  ${NSD_CreateLabel} 12u 106u 100% 20u \
    "Leave the key blank if the server does not require one. It is stored in gobbonet.toml and never sent to the browser."
  Pop $Lbl

  ${If} $Backend == "remote"
    ${NSD_Check} $RbRemote
  ${Else}
    ${NSD_Check} $RbLocal
  ${EndIf}

  ${NSD_OnClick} $RbLocal  BackendToggle
  ${NSD_OnClick} $RbRemote BackendToggle
  Call BackendToggle

  nsDialogs::Show
FunctionEnd

Function BackendToggle
  Push $0
  ${NSD_GetState} $RbRemote $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $RemoteUrlBox 1
    EnableWindow $RemoteKeyBox 1
  ${Else}
    EnableWindow $RemoteUrlBox 0
    EnableWindow $RemoteKeyBox 0
  ${EndIf}
  Pop $0
FunctionEnd

Function BackendPageLeave
  ${NSD_GetState} $RbRemote $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Backend "remote"
    ${NSD_GetText} $RemoteUrlBox $RemoteUrl
    ${NSD_GetText} $RemoteKeyBox $RemoteKey

    ; A remote install whose URL is blank produces a config that cannot
    ; work, so refuse it here rather than at first launch.
    StrCpy $0 $RemoteUrl 4
    ${If} $0 != "http"
      MessageBox MB_ICONEXCLAMATION|MB_OK \
        "Enter the server URL, including http:// or https://$\r$\n$\r$\nExample: http://192.168.1.100:8080"
      Abort
    ${EndIf}
  ${Else}
    StrCpy $Backend "local"
  ${EndIf}
FunctionEnd

;===================================================================
; PAGE 2 -- hardware probe (local only)
;
; The probe is run from a timer rather than inline so the page paints
; its "checking..." text first. dxdiag's fallback path can take ~10s
; and a frozen blank wizard reads as a crash.
;===================================================================
Function ProbePageCreate
  ${If} $Backend != "local"
    Abort            ; skip page
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Checking your hardware" \
    "So the model list can be filtered to what will actually run well."

  nsDialogs::Create 1018
  Pop $Dlg
  ${If} $Dlg == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 100% 40u "Detecting GPU, memory and free disk space..."
  Pop $Lbl

  ${If} $HwProbed != "1"
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0                       ; disable Next during the probe
    ${NSD_CreateTimer} RunProbe 200
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function RunProbe
  ${NSD_KillTimer} RunProbe

  StrCpy $HwIni "$PLUGINSDIR\hardware.ini"

  ; -Quiet keeps the console chatter out; we read the INI for the numbers.
  ; Not fatal on failure: a probe that cannot see the GPU should leave the
  ; user with an unfiltered catalogue, not a dead installer.
  ;
  ; Everything here lives in $PLUGINSDIR, not $INSTDIR: this page runs before
  ; the install section, so $INSTDIR holds nothing yet and may not even exist.
  ; SecMain copies hardware.json across afterwards so launch.bat inherits the
  ; probe rather than re-running it.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile \
    -ExecutionPolicy Bypass -File "$PLUGINSDIR\hardware-probe.ps1" \
    -OutputPath "$PLUGINSDIR\hardware.json" -IniPath "$HwIni" \
    -ModelsDir "$INSTDIR\models" -Quiet'
  Pop $0

  StrCpy $HwProbed "1"
  StrCpy $HwVram 0
  StrCpy $HwRam 0
  StrCpy $HwDiskFree 0
  StrCpy $HwTier "unknown"
  StrCpy $HwGpuName "unknown"

  ${If} $0 == 0
    ReadINIStr $HwGpuName  "$HwIni" "hardware" "gpu_name"
    ReadINIStr $HwVram     "$HwIni" "hardware" "vram_gb"
    ReadINIStr $HwRam      "$HwIni" "hardware" "ram_gb"
    ReadINIStr $HwDiskFree "$HwIni" "hardware" "disk_free_gb"
    ReadINIStr $HwTier     "$HwIni" "hardware" "recommended_tier"
    ${NSD_SetText} $Lbl "GPU:  $HwGpuName$\r$\nVRAM: $HwVram GB$\r$\n\
RAM:  $HwRam GB$\r$\nFree disk: $HwDiskFree GB$\r$\n$\r$\nSuggested tier: $HwTier"
  ${Else}
    ${NSD_SetText} $Lbl "Could not read this machine's hardware.$\r$\n$\r$\n\
The full model list will be offered without size filtering. Pick one that fits \
your GPU, or skip the download and add a .gguf yourself later."
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
FunctionEnd

; No skip check here: when the create function Aborts, the page is never
; shown and NSIS never calls its leave function.
Function ProbePageLeave
FunctionEnd

;===================================================================
; PAGE 3 -- model catalogue
;
; The list, the sizes and the recommendation all come from models.ini,
; which gen-catalog.py regenerates from launch.bat. Nothing about the
; catalogue is written twice.
;===================================================================
Function ModelPageCreate
  ${If} $Backend != "local"
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Pick a model" \
    "This is the only download. You can add more later from launch.bat."

  StrCpy $CatalogIni "$PLUGINSDIR\models.ini"

  ; --- work out the recommendation by replaying launch.bat's ladder ---
  StrCpy $PickRecommended 0
  ReadINIStr $2 "$CatalogIni" "recommend" "cpu_only"
  ${If} $HwTier == "cpu_only"
    StrCpy $PickRecommended $2
  ${Else}
    ReadINIStr $3 "$CatalogIni" "recommend" "rungs"
    StrCpy $1 1
    rung_loop:
      ${If} $1 > $3
        Goto rung_done
      ${EndIf}
      ReadINIStr $4 "$CatalogIni" "recommend" "rung$1_vram"
      ReadINIStr $5 "$CatalogIni" "recommend" "rung$1_pick"
      ${If} $HwVram >= $4
        StrCpy $PickRecommended $5
        Goto rung_done
      ${EndIf}
      IntOp $1 $1 + 1
      Goto rung_loop
    rung_done:
    ${If} $PickRecommended == 0
      ReadINIStr $PickRecommended "$CatalogIni" "recommend" "default"
    ${EndIf}
  ${EndIf}

  nsDialogs::Create 1018
  Pop $Dlg
  ${If} $Dlg == error
    Abort
  ${EndIf}

  ${NSD_CreateListBox} 0 0u 100% 92u ""
  Pop $ModelList

  ; --- build the rows ---
  ReadINIStr $6 "$CatalogIni" "catalog" "max_index"
  StrCpy $1 1
  row_loop:
    ${If} $1 > $6
      Goto row_done
    ${EndIf}
    ReadINIStr $2 "$CatalogIni" "$1" "display"
    ${If} $2 == ""
      IntOp $1 $1 + 1          ; menu numbering has gaps; skip them
      Goto row_loop
    ${EndIf}
    ReadINIStr $3 "$CatalogIni" "$1" "size_gb"
    ReadINIStr $4 "$CatalogIni" "$1" "min_vram"

    StrCpy $5 ""
    ${If} $1 == $PickRecommended
      StrCpy $5 "   [ RECOMMENDED FOR YOUR PC ]"
    ${ElseIf} $HwTier == "cpu_only"
      ${If} $4 > 6
        StrCpy $5 "   [ likely too slow without a GPU ]"
      ${EndIf}
    ${ElseIf} $HwVram > 0
      ${If} $HwVram < $4
        StrCpy $5 "   [ needs ~$4 GB VRAM - will be slow ]"
      ${EndIf}
    ${EndIf}

    SendMessage $ModelList ${LB_ADDSTRING} 0 "STR:$2  --  ~$3 GB$5"
    IntOp $1 $1 + 1
    Goto row_loop
  row_done:

  SendMessage $ModelList ${LB_ADDSTRING} 0 \
    "STR:Skip - I'll add my own .gguf later"

  ; preselect the recommendation
  StrCpy $1 0
  ${If} $PickRecommended > 0
    Call IndexToRow
    Pop $1
  ${EndIf}
  SendMessage $ModelList ${LB_SETCURSEL} $1 0

  ${NSD_CreateLabel} 0 96u 100% 28u \
    "Downloads from HuggingFace and is checked against the checksum HuggingFace \
publishes for it. Free disk: $HwDiskFree GB."
  Pop $Lbl

  nsDialogs::Show
FunctionEnd

; PickRecommended -> listbox row. Stack: (out) row index
Function IndexToRow
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 0        ; row counter
  StrCpy $1 1        ; catalogue index
  ReadINIStr $3 "$CatalogIni" "catalog" "max_index"
  i2r_loop:
    ${If} $1 > $3
      Goto i2r_done
    ${EndIf}
    ReadINIStr $2 "$CatalogIni" "$1" "display"
    ${If} $2 != ""
      ${If} $1 == $PickRecommended
        Goto i2r_done
      ${EndIf}
      IntOp $0 $0 + 1
    ${EndIf}
    IntOp $1 $1 + 1
    Goto i2r_loop
  i2r_done:
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; listbox row -> catalogue index (0 = the trailing "Skip" row)
Function RowToIndex
  Exch $0            ; row wanted
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $1 0        ; row counter
  StrCpy $2 1        ; catalogue index
  StrCpy $4 0        ; result (0 = the trailing "Skip" row)
  ReadINIStr $3 "$CatalogIni" "catalog" "max_index"
  r2i_loop:
    ${If} $2 > $3
      Goto r2i_done
    ${EndIf}
    ReadINIStr $5 "$CatalogIni" "$2" "display"
    ${If} $5 != ""
      ${If} $1 == $0
        StrCpy $4 $2
        Goto r2i_done
      ${EndIf}
      IntOp $1 $1 + 1
    ${EndIf}
    IntOp $2 $2 + 1
    Goto r2i_loop
  r2i_done:
  StrCpy $0 $4
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

Function ModelPageLeave
  SendMessage $ModelList ${LB_GETCURSEL} 0 0 $0
  Push $0
  Call RowToIndex
  Pop $Pick

  ${If} $Pick == 0
    Return                       ; "Skip" -- nothing to download or verify
  ${EndIf}

  ReadINIStr $PickDisplay "$CatalogIni" "$Pick" "display"
  ReadINIStr $PickRepo    "$CatalogIni" "$Pick" "repo"
  ReadINIStr $PickFile    "$CatalogIni" "$Pick" "file"
  ReadINIStr $PickSizeGb  "$CatalogIni" "$Pick" "size_gb"
  ReadINIStr $PickCtx     "$CatalogIni" "$Pick" "ctx"
  ReadINIStr $PickKv      "$CatalogIni" "$Pick" "kv"
  ReadINIStr $1           "$CatalogIni" "$Pick" "min_vram"
  ReadINIStr $3           "$CatalogIni" "$Pick" "size_gb_int"

  ; Disk check first: running out of space 12 GB into a 16 GB download
  ; wastes far more of the user's time than one dialog does. Only when
  ; the probe actually reported a number. size_gb_int, not size_gb --
  ; NSIS would read "4.7" as 4.
  ${If} $HwDiskFree > 0
    IntOp $2 $HwDiskFree - 2       ; leave some headroom
    ${If} $2 < $3
      MessageBox MB_ICONSTOP|MB_OK \
        "$PickDisplay needs about $PickSizeGb GB, but only $HwDiskFree GB is free.\
$\r$\n$\r$\nFree some space, or choose a smaller model."
      Abort
    ${EndIf}
  ${EndIf}

  ; VRAM warning -- launch.bat's "heads up" prompt, as a dialog.
  ${If} $HwVram > 0
  ${AndIf} $HwVram < $1
    MessageBox MB_ICONEXCLAMATION|MB_YESNO \
      "$PickDisplay wants about $1 GB of GPU memory, but only $HwVram GB was \
detected.$\r$\n$\r$\nIt can still run by spilling into system RAM, but expect it \
to be noticeably slower than a model that fits your GPU.$\r$\n$\r$\nDownload it \
anyway?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

;===================================================================
; INSTALL
;===================================================================
Section "GobboNet" SecMain
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; An upgrade over a running install cannot overwrite gobbonet.exe while it
  ; is running -- NSIS reports a write failure on a file the user can plainly
  ; see, which reads as a corrupt download. Extracted to $PLUGINSDIR in
  ; .onInit because on a FIRST install $INSTDIR has no copy yet.
  DetailPrint "Stopping any running GobboNet..."
  stop_retry:
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c ""$PLUGINSDIR\stop-gobbonet.bat" /quiet"'
  Pop $0
  ${If} $0 != 0
    ; Say what is wrong while it can still be fixed. Letting the File command
    ; below hit a locked gobbonet.exe instead produces "could not write to
    ; file", which names the symptom and not the cause.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "GobboNet is still running and could not be stopped automatically.$\r$\n$\r$\n\
Close the GobboNet window (and any llama-server window), then choose Retry.$\r$\n$\r$\n\
If it will not close, a reboot always clears it." \
      IDRETRY stop_retry
    Abort "Setup stopped: GobboNet is still running."
  ${EndIf}

  DetailPrint "Installing GobboNet ${VERSION}..."
  File "${PAYLOAD}\gobbonet.exe"
  File "${PAYLOAD}\gobbonet.ico"
  File /r "${PAYLOAD}\web"

  ; The PowerShell helpers stay: launch.bat still uses them for adding
  ; further models. The probe page ran its own copy out of $PLUGINSDIR
  ; (see .onInit) because this section had not executed yet.
  File "${PAYLOAD}\launch.bat"
  File "${PAYLOAD}\setup-lan.bat"
  ; teardown-lan.bat is the counterpart to setup-lan.bat, and it has to be
  ; installed even for users who never run the LAN setup: the uninstaller
  ; calls it, and it is the only thing that clears a URL reservation.
  File "${PAYLOAD}\teardown-lan.bat"
  File "${PAYLOAD}\stop-gobbonet.bat"
  File "${PAYLOAD}\hardware-probe.ps1"
  File "${PAYLOAD}\identify-model.ps1"
  File "${PAYLOAD}\fileserver.ps1"

  ; The running server needs this too, not just the installer.
  ;
  ; .onInit extracts a copy into $PLUGINSDIR for the model page, and NSIS
  ; deletes $PLUGINSDIR when the installer exits -- so for three releases
  ; nothing named models.ini survived the install. catalog.Discover() looks
  ; beside the exe, found nothing, and the settings panel's Add a Model modal
  ; had no fallback list when the remote catalogue was unreachable. On Windows
  ; that meant a 503 and an empty modal.
  ;
  ; Compile-time source, the same one ReserveFile names, rather than routing
  ; through $PAYLOAD: gen-catalog.py writes it into this directory and there is
  ; no reason for a second staging hop to be able to go stale.
  File "models.ini"

  ; Carry the probe result forward. $PLUGINSDIR is deleted when the
  ; installer exits, and launch.bat reads hardware.json from its own
  ; folder; without this the first launch re-probes for no reason. Silent
  ; and unconditional: a remote-backend install skipped the probe page
  ; entirely, and a missing source here is simply nothing to copy.
  CopyFiles /SILENT "$PLUGINSDIR\hardware.json" "$INSTDIR\hardware.json"

  DetailPrint "Installing bundled llama.cpp..."
  SetOutPath "$INSTDIR\llama-cpp"
  File /r "${PAYLOAD}\llama-cpp\*.*"

  CreateDirectory "$INSTDIR\models"
  SetOutPath "$INSTDIR"

  ;--------------------------------------------------------------
  ; Model download
  ;--------------------------------------------------------------
  ${If} $Backend == "local"
  ${AndIf} $Pick != 0
    StrCpy $R0 "$INSTDIR\models\$PickFile"
    StrCpy $R1 "https://huggingface.co/$PickRepo/resolve/main/$PickFile"
    StrCpy $R2 "https://huggingface.co/$PickRepo/raw/main/$PickFile"

    DetailPrint "Downloading $PickDisplay (~$PickSizeGb GB)..."
    DetailPrint "  from huggingface.co/$PickRepo"
    inetc::get /CAPTION "Downloading $PickDisplay" \
               /BANNER "Fetching $PickFile (~$PickSizeGb GB)" \
               /RESUME "Connection lost. Retry the download?" \
               "$R1" "$R0" /END
    Pop $0
    ${If} $0 != "OK"
      Delete "$R0"
      Abort "Model download failed: $0"
    ${EndIf}
    DetailPrint "  [OK] Download complete."

    ;-- integrity, mirroring launch.bat's policy exactly -------------
    ; HuggingFace serves an LFS pointer (a few hundred bytes of text)
    ; instead of the model when things go wrong, and that arrives as a
    ; clean HTTP 200. Without this check the installer would report
    ; success and hand the user a config pointing at a text file.
    ;
    ; launch.bat's policy: hash mismatch is fatal; an unreadable or
    ; unparseable pointer is a warning, because an HF format change
    ; should not hard-block a good download. The size floor below is
    ; the backstop in that case.
    DetailPrint "Fetching expected SHA-256 from HuggingFace..."
    inetc::get /SILENT "$R2" "$PLUGINSDIR\ptr.txt" /END
    Pop $0
    ${If} $0 != "OK"
      DetailPrint "  [WARN] Could not fetch the checksum pointer; skipping hash check."
    ${Else}
      Push "$PLUGINSDIR\ptr.txt"
      Call ParseLfsPointer
      Pop $R3
      ${If} $R3 == ""
        DetailPrint "  [WARN] Could not read the checksum (HF format may have changed)."
      ${Else}
        DetailPrint "Verifying download against it..."
        nsExec::ExecToLog 'cmd /c certutil -hashfile "$R0" SHA256 > "$PLUGINSDIR\hash.txt"'
        Pop $0
        Call ReadCertutilHash
        Pop $R4
        ${If} $R4 == ""
          DetailPrint "  [WARN] certutil produced no hash; relying on the size check."
        ${ElseIf} $R4 S!= $R3
          Delete "$R0"
          DetailPrint "  [ERROR] expected: $R3"
          DetailPrint "  [ERROR] actual:   $R4"
          Abort "CHECKSUM MISMATCH -- the model file is corrupt or was tampered with. It has been deleted."
        ${Else}
          DetailPrint "  [OK] Model checksum verified."
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ; Size floor -- catches the LFS-pointer case when the hash check
    ; was skipped. Every catalogue entry is >1 GB.
    ${GetSize} "$INSTDIR\models" "/M=$PickFile /S=0K /G=0" $0 $1 $2
    ${If} $0 < 1000000
      Delete "$R0"
      Abort "The downloaded file is only $0 KB. That usually means an error page \
arrived instead of the model. Nothing was installed to the models folder."
    ${EndIf}
  ${EndIf}

  ;--------------------------------------------------------------
  ; Configuration
  ;
  ; Written through the CLI rather than by templating a .toml here,
  ; so the installer cannot drift from the server's own idea of what
  ; a valid config is.
  ;--------------------------------------------------------------
  DetailPrint "Writing configuration..."
  ${If} $Backend == "remote"
    ; Clear server_exe FIRST. Choosing remote used to set llm_url and leave a
    ; server_exe from a previous local install untouched, which meant one of
    ; two wrong outcomes: the install silently stayed in local mode against a
    ; stale binary, or -- if that binary was gone -- every start failed fatally
    ; with an error naming a path this installer wrote and the user never did.
    ; An empty server_exe IS remote mode, so saying so is the whole fix.
    !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set server_exe ""' \
                            "Clearing server_exe (remote mode)"
    !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set llm_url "$RemoteUrl"' \
                            "Setting llm_url"
    ${If} $RemoteKey != ""
      !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set llm_api_key "$RemoteKey"' \
                              "Setting llm_api_key"
    ${EndIf}
  ${Else}
    !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set model_dir "$INSTDIR\models"' \
                            "Setting model_dir"
    ${If} $Pick != 0
      !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set ctx_size "$PickCtx"' \
                              "Setting ctx_size"
      !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set kv_cache_type "$PickKv"' \
                              "Setting kv_cache_type"
    ${EndIf}

    ; server_exe LAST, and only if the binary is really there.
    ; config.go treats a non-empty server_exe pointing at a missing file
    ; as fatal -- correctly -- so writing it optimistically would turn a
    ; partial install into a server that refuses to start.
    ${If} ${FileExists} "$INSTDIR\llama-cpp\llama-server.exe"
      !insertmacro RunChecked \
        '"$INSTDIR\gobbonet.exe" config set server_exe "$INSTDIR\llama-cpp\llama-server.exe"' \
        "Setting server_exe"
    ${Else}
      ; Actually clear it, rather than only saying so.
      ;
      ; This branch printed "leaving server_exe empty ... will start in remote
      ; mode" and then wrote nothing, so on a reinstall the PREVIOUS install's
      ; server_exe survived. The comment above was right that writing a bad
      ; value would be worse -- but leaving a bad one is not better, and the
      ; DetailPrint was a promise the code did not keep. An install with no
      ; engine in the bundle is a remote install, so make the config say that.
      !insertmacro RunChecked '"$INSTDIR\gobbonet.exe" config set server_exe ""' \
                              "Clearing server_exe (no engine bundled)"
      DetailPrint "  [WARN] llama-server.exe not found in the bundle;"
      DetailPrint "         server_exe cleared. GobboNet will start in remote mode."
    ${EndIf}
  ${EndIf}

  ;--------------------------------------------------------------
  ; Shortcuts and uninstall metadata
  ;
  ; The 1.3 payload shipped launch.exe / launchLAN.exe: small C shims
  ; whose only job was to locate the folder and ShellExecute a .bat,
  ; complete with a hardcoded "usually an antivirus block" error path.
  ; gobbonet.exe is a real executable, so the shortcut points at it and
  ; both shims are gone.
  ;--------------------------------------------------------------
  CreateDirectory "$SMPROGRAMS\GobboNet"
  CreateShortcut "$SMPROGRAMS\GobboNet\GobboNet.lnk" \
                 "$INSTDIR\gobbonet.exe" "" "$INSTDIR\gobbonet.ico"
  CreateShortcut "$SMPROGRAMS\GobboNet\GobboNet LAN Setup.lnk" \
                 "$INSTDIR\setup-lan.bat" "" "$INSTDIR\gobbonet.ico"
  CreateShortcut "$SMPROGRAMS\GobboNet\Add another model.lnk" \
                 "$INSTDIR\launch.bat" "" "$INSTDIR\gobbonet.ico"
  CreateShortcut "$SMPROGRAMS\GobboNet\Uninstall GobboNet.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\GobboNet.lnk" \
                 "$INSTDIR\gobbonet.exe" "" "$INSTDIR\gobbonet.ico"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\GobboNet" "InstallDir" "$INSTDIR"

  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GobboNet"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "GobboNet"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\gobbonet.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "Elodine"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout"    "https://github.com/ElodineOfficial"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

;===================================================================
; FINISH -- the checkbox this whole exercise is for
;===================================================================
Function FinishPageCreate
  !insertmacro MUI_HEADER_TEXT "Done" "GobboNet is installed and configured."

  nsDialogs::Create 1018
  Pop $Dlg
  ${If} $Dlg == error
    Abort
  ${EndIf}

  ${If} $Backend == "remote"
    StrCpy $1 "Configured to use $RemoteUrl."
  ${ElseIf} $Pick == 0
    StrCpy $1 "No model was downloaded. Drop a .gguf into $INSTDIR\models, or use \
'Add another model' in the Start menu."
  ${Else}
    StrCpy $1 "$PickDisplay is installed and ready. llama.cpp starts automatically."
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 100% 40u "$1$\r$\n$\r$\n\
Everything in the install folder is plain text you can read, break and rebuild. \
That is the point."
  Pop $Lbl

  ${NSD_CreateCheckbox} 0 48u 100% 12u "Start GobboNet"
  Pop $ChkStart
  ${NSD_Check} $ChkStart

  ; Kept as a separate opt-in: it needs administrator rights, which the
  ; rest of this install deliberately does not.
  ${NSD_CreateCheckbox} 0 64u 100% 12u \
    "Set up phone access over the LAN (needs administrator)"
  Pop $ChkLan

  ; The Next button is the last one on this page.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:&Finish"

  nsDialogs::Show
FunctionEnd

Function FinishPageLeave
  ${NSD_GetState} $ChkStart $0
  ${If} $0 == ${BST_CHECKED}
    ; gobbonet.exe starts llama-server itself when server_exe is set,
    ; so this single call is the whole "installed -> running" step.
    Exec '"$INSTDIR\gobbonet.exe"'
  ${EndIf}

  ${NSD_GetState} $ChkLan $0
  ${If} $0 == ${BST_CHECKED}
    ExecShell "runas" "$INSTDIR\setup-lan.bat"
  ${EndIf}
FunctionEnd

;===================================================================
Function .onInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\models.ini "models.ini"
  ; The probe page runs BEFORE MUI_PAGE_INSTFILES, so nothing has been
  ; written to $INSTDIR yet when it fires. Extract the probe here, into
  ; the temp plugins dir, or RunProbe invokes a path that does not exist
  ; and every install silently takes the "could not read this machine's
  ; hardware" branch. Section SecMain still installs its own copy into
  ; $INSTDIR -- launch.bat calls it later, long after $PLUGINSDIR is gone.
  File /oname=$PLUGINSDIR\hardware-probe.ps1 "${PAYLOAD}\hardware-probe.ps1"
  ; Same reasoning: SecMain runs it before it has installed anything, so it
  ; cannot come from $INSTDIR on a first install.
  File /oname=$PLUGINSDIR\stop-gobbonet.bat "${PAYLOAD}\stop-gobbonet.bat"

  StrCpy $Backend "local"
  StrCpy $RemoteUrl "http://"
  StrCpy $RemoteKey ""
  StrCpy $HwProbed "0"
  StrCpy $HwVram 0
  StrCpy $HwDiskFree 0
  StrCpy $HwTier "unknown"
  StrCpy $Pick 0
FunctionEnd

;===================================================================
Section "Uninstall"
  ;--------------------------------------------------------------
  ; STOP EVERYTHING FIRST.
  ;
  ; This section used to go straight to Delete "$INSTDIR\gobbonet.exe" with
  ; nothing stopped. A running server holds its own binary and the install
  ; folder open, so the delete fails and Windows says "the folder is still
  ; open in another program" -- which reads as a stuck uninstall and leaves a
  ; server still holding the web port after the user believes it is gone.
  ;--------------------------------------------------------------
  DetailPrint "Stopping GobboNet..."
  ${If} ${FileExists} "$INSTDIR\stop-gobbonet.bat"
    un_stop_retry:
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c ""$INSTDIR\stop-gobbonet.bat" /quiet"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "GobboNet is still running and could not be stopped automatically.$\r$\n$\r$\n\
Close it, then choose Retry. Continuing now would leave files behind and \
report that the folder is still open in another program." \
        IDRETRY un_stop_retry
      Abort "Uninstall stopped: GobboNet is still running."
    ${EndIf}
  ${Else}
    ; Upgrading from a build that predates the helper: do the two that matter
    ; inline. taskkill needs no elevation for this user's own processes.
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM gobbonet.exe'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM llama-server.exe'
    Pop $0
  ${EndIf}

  ;--------------------------------------------------------------
  ; LAN TEARDOWN -- the reason a broken port survives a reinstall.
  ;
  ; setup-lan.bat registers a machine-wide URL reservation with HTTP.SYS.
  ; That lives in the kernel, not in $INSTDIR, so deleting this folder does
  ; not touch it -- and a reservation with no listener behind it makes
  ; Windows answer the port with 503 on its own. That is why uninstalling,
  ; wiping the folder and reinstalling can all fail to fix it.
  ;
  ; It cannot be removed from here directly: this is a per-user install
  ; (RequestExecutionLevel user) and netsh needs Administrator. So the work
  ; is in teardown-lan.bat and we ask for elevation only when there is
  ; something to remove -- .gobbonet-lan is written by setup-lan.bat, so a
  ; user who never configured LAN access is never prompted.
  ;--------------------------------------------------------------
  ${If} ${FileExists} "$INSTDIR\.gobbonet-lan"
  ${AndIf} ${FileExists} "$INSTDIR\teardown-lan.bat"
    MessageBox MB_ICONQUESTION|MB_YESNO \
      "Remove the LAN access rules as well?$\r$\n$\r$\n\
setup-lan.bat added a Windows firewall rule and a port reservation. The \
reservation is stored by Windows itself, so it is NOT removed by \
uninstalling, and a leftover one makes that port answer with a 503 error \
even after a fresh reinstall.$\r$\n$\r$\n\
This needs Administrator approval." \
      IDNO skip_lan
    ; Wait: the script lives in $INSTDIR and this section is about to delete it.
    ExecShellWait "runas" "$INSTDIR\teardown-lan.bat" "/quiet"
    skip_lan:
  ${EndIf}

  ;--------------------------------------------------------------
  ; THE USER'S OWN DATA.
  ;
  ; config.toml and state do NOT live under $INSTDIR. ConfigDir() and
  ; DataDir() are XDG paths on every platform, Windows included, so the real
  ; locations are %USERPROFILE%\.config\gobbonet and
  ; %USERPROFILE%\.local\share\gobbonet. Deleting the install folder has
  ; never touched either, which is why a reinstall kept finding the same
  ; broken settings -- including a server_exe pointing at a folder that no
  ; longer existed.
  ;
  ; gobbonet.exe already knows how to clear them properly (and how to ask
  ; about models), so this offers to run it rather than reimplementing the
  ; policy here -- and it has to run BEFORE the binary is deleted.
  ;--------------------------------------------------------------
  ${If} ${FileExists} "$INSTDIR\gobbonet.exe"
    MessageBox MB_ICONQUESTION|MB_YESNO \
      "Also remove your GobboNet settings and conversations?$\r$\n$\r$\n\
These are stored in your user folder, not in the program folder, so they \
are normally kept -- a reinstall picks up where you left off.$\r$\n$\r$\n\
Choose Yes if you are uninstalling to fix a problem: settings that survive \
an uninstall are the usual reason a reinstall behaves exactly the same way.\
$\r$\n$\r$\nYour downloaded models are asked about separately." \
      IDNO skip_userdata
    nsExec::ExecToLog '"$INSTDIR\gobbonet.exe" uninstall --yes --keep-models'
    Pop $0
    ${If} $0 != 0
      DetailPrint "  [WARN] could not clear user settings (exit $0)."
      DetailPrint "         Run: gobbonet uninstall"
    ${EndIf}
    skip_userdata:
  ${EndIf}

  ; Models are the user's property and are the expensive thing to
  ; replace, so they are left behind unless explicitly confirmed.
  ${If} ${FileExists} "$INSTDIR\models\*.gguf"
    MessageBox MB_ICONQUESTION|MB_YESNO \
      "Also delete the downloaded models in $INSTDIR\models?$\r$\n$\r$\n\
These are large files that would have to be downloaded again." \
      IDNO keep_models
    RMDir /r "$INSTDIR\models"
    keep_models:
  ${EndIf}

  Delete "$INSTDIR\gobbonet.exe"
  Delete "$INSTDIR\gobbonet.ico"
  Delete "$INSTDIR\*.bat"
  Delete "$INSTDIR\*.ps1"
  Delete "$INSTDIR\hardware.json"
  Delete "$INSTDIR\models.ini"
  Delete "$INSTDIR\uninstall.exe"
  ; Dotfiles: *.bat above does not match these, and a leftover .gobbonet-port
  ; would outlive the install and feed a stale port to the next setup-lan.bat.
  Delete "$INSTDIR\.gobbonet-port"
  Delete "$INSTDIR\.gobbonet-lan"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\llama-cpp"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\GobboNet\*.lnk"
  RMDir  "$SMPROGRAMS\GobboNet"
  Delete "$DESKTOP\GobboNet.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GobboNet"
  DeleteRegKey HKCU "Software\GobboNet"
SectionEnd
