; ============================================================================
;  GobboNet installer -- Elodine / GoblinCorps
;
;  Build:  makensis -DAPPSRC=<dir with the app files> gobbonet.nsi
;
;  Two decisions are baked in here and both are deliberate:
;
;  1. PER-USER INSTALL to $LOCALAPPDATA.
;     GobboNet writes into its own folder -- logs, models\, the downloaded
;     llama-cpp\, models-list.json, hardware.json, the password store.
;     Program Files is not writable by standard users, so installing there
;     would mean rewriting every %~dp0 reference across launch.bat and the
;     three PowerShell scripts. Installing per-user keeps all of that
;     working untouched, and means the installer needs no elevation at all.
;     Only setup-lan.bat needs admin, and that is handled separately by
;     launchLAN.exe at runtime.
;
;  2. GENERATED STATE IS NOT SHIPPED.
;     models-list.json, hardware.json, .hw-parsed.env, *.log and the
;     generated .jinja chat templates are all per-machine artifacts. If we
;     shipped them, every user would inherit the build machine's active
;     model and template hashes. They are excluded below and regenerated on
;     first run by :write_model_json and hardware-probe.ps1.
; ============================================================================

Unicode true

!ifndef APPSRC
  !define APPSRC "..\staging"
!endif

!define APPNAME     "GobboNet"
!define APPVER      "1.7.3"
; 1.3 shipped launch.exe / launchLAN.exe: small C shims whose only job was to
; locate the install folder and ShellExecute a .bat. They are gone. The
; shortcuts and the finish-page checkboxes point at the batch files directly,
; which is why these two now name .bat files rather than .exe stubs.
!define APPEXE      "launch.bat"
!define PUBLISHER   "Elodine"
!define HOMEPAGE    "https://github.com/ElodineOfficial"
!define LANEXE      "setup-lan.bat"
!define REGKEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name              "${APPNAME}"
OutFile           "GobboNetSetup-1_7_3.exe"
InstallDir        "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey  HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails   show
ShowUninstDetails show

VIProductVersion "1.7.3.0"
VIAddVersionKey  "ProductName"     "${APPNAME}"
VIAddVersionKey  "FileDescription" "${APPNAME} Installer"
VIAddVersionKey  "FileVersion"     "1.7.0.0"
VIAddVersionKey  "ProductVersion"  "${APPVER}"
VIAddVersionKey  "CompanyName"     "${PUBLISHER}"
VIAddVersionKey  "LegalCopyright"  "Elodine / GoblinCorps -- free to use, copy and modify"

; ---------------------------------------------------------------- interface
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

; ---- access password, collected in the wizard --------------------------
; launch.bat can still prompt for this on first run and that path is
; untouched. Doing it here is strictly an upgrade: a real dialog with a
; confirm field and validation, instead of a masked console prompt that
; cannot tell you what went wrong. If anything below fails the secret is
; simply not written and launch.bat asks for it exactly as it does today,
; so this cannot make the product worse -- only skippable.
Var Dialog
Var hPort
Var hDefender
Var hPortWarn
Var PortValue
Var hPw1
Var hPw2
Var hPwSkip
Var PwPlain
Var PwSkipped

!define MUI_ICON   "art\gobbonet.ico"
!define MUI_UNICON "art\gobbonet.ico"
!define MUI_ABORTWARNING

; ---- theme ----------------------------------------------------------------
; Sizes are fixed by NSIS: 150x57 header, 164x314 sidebar, 24-bit BMP.
; make-branding.py generates all four; do not hand-edit them.
;
; The uninstaller shares the installer's two bitmaps rather than carrying its
; own -un pair. There is one set of 1.7 art and this is it, so pointing both
; at the same files is what keeps the uninstaller looking like the thing it
; is uninstalling.
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP   "art\modern-header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "art\modern-header.bmp"

!define MUI_WELCOMEFINISHPAGE_BITMAP   "art\modern-wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "art\modern-wizard.bmp"

; Welcome/finish pages only -- the directory and confirm pages are standard
; Windows dialogs and stay that way.
!define MUI_BGCOLOR   "0D0E12"
!define MUI_TEXTCOLOR "CEE2BA"
!define GN_CHECKCOLOR "F2FAE8"   ; brighter: checkbox labels need more punch
!define GN_BRANDCOLOR "4D5A4A"   ; branding strip: deliberately the quietest text present

; Details listbox on the install/uninstall pages: green on black.
InstallColors 97E031 0D0E12

BrandingText "GobboNet ${APPVER}  --  Elodine / GoblinCorps"

; MUI paints the header bar and the welcome/finish bodies. It does NOT
; paint the parent window, which is what shows through underneath every
; standard page and behind the Back/Next/Cancel row -- so without this the
; wizard is dark at the top, dark on the first and last screens, and
; Windows grey everywhere in between. GUIINIT runs once, before any page.
!define MUI_CUSTOMFUNCTION_GUIINIT StyleParentWindow
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.StyleParentWindow

!define MUI_WELCOMEPAGE_TITLE "GobboNet ${APPVER}"
!define MUI_WELCOMEPAGE_TEXT  "Local chat for local models. No account, no API key, no telemetry, no corpo middleman. What you type stays on the machine you type it on.$\r$\n$\r$\nAGPLv3 licensed and built to be taken apart. The install folder is plain scripts and one web page -- hand the whole thing to a large cloud model and ask for changes in plain English. Note the split: you need a frontier model to MODIFY GobboNet, but only a local one to RUN it. The codebase is far past what a local model can hold in context.$\r$\n$\r$\nOn first run GobboNet pulls llama.cpp, probes your GPU, and offers a model catalogue matched to what it actually finds. Installs to your user folder -- no administrator rights needed."

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_SHOW DirectoryPageShow
!insertmacro MUI_PAGE_DIRECTORY
Page custom PasswordPageCreate PasswordPageLeave
Page custom PortPageCreate PortPageLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstFilesPageShow
!insertmacro MUI_PAGE_INSTFILES

; Sits between the install and the finish page on purpose: it has to be read
; BEFORE the Launch GobboNet checkbox, because the first launch is exactly
; when Defender is most likely to interfere.
Page custom DefenderPageCreate

; No value, paired with MUI_FINISHPAGE_RUN_FUNCTION below. MUI's default
; handling for a bare MUI_FINISHPAGE_RUN path is Exec, which wraps
; CreateProcess -- and CreateProcess cannot start a .bat, it needs an
; executable image. With the launch.exe shim gone the target is a batch file,
; so the checkbox has to go through ShellExecute instead or it silently does
; nothing. Same reason RunLanSetup below uses ExecShell.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch GobboNet"
!define MUI_FINISHPAGE_RUN_FUNCTION RunGobboNet
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Set up phone access over the LAN (needs administrator)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION RunLanSetup
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
!define MUI_FINISHPAGE_TEXT "Installed.$\r$\n$\r$\nFirst launch fetches llama.cpp and opens the model catalogue. Budget some time for whichever model you pick -- that is the only large download here, and it goes from HuggingFace straight to your disk.$\r$\n$\r$\nThe chat opens at http://127.0.0.1:9066 unless you changed the port. Everything in the install folder is plain text you can read, break and rebuild. That is the point."
!insertmacro MUI_PAGE_FINISH

; MUI2 unsets each page's defines once the page macro is inserted, so the
; installer's "Launch GobboNet" checkbox does not leak onto the
; uninstaller's finish page. That means these are fresh definitions, not
; overrides -- do not add !undef lines here, they will warn.
!define MUI_WELCOMEPAGE_TITLE "Uninstalling GobboNet"
!define MUI_WELCOMEPAGE_TEXT  "Thanks for giving it a run.$\r$\n$\r$\nThis removes GobboNet cleanly. No leftovers, no registry cruft, nothing phoning home on the way out. Your downloaded models are kept unless you say otherwise -- they're slow to fetch and they're yours.$\r$\n$\r$\nIf it didn't fit the way you work, that's fair. A local model front end is a particular kind of tool and it isn't the right one for everybody."
!insertmacro MUI_UNPAGE_WELCOME

!define MUI_UNCONFIRMPAGE_TEXT_TOP "This removes GobboNet from the folder below. You'll be asked about your downloaded models before anything large is deleted."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.UnConfirmPageShow
!insertmacro MUI_UNPAGE_CONFIRM

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.InstFilesPageShow
!insertmacro MUI_UNPAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "GobboNet removed"
!define MUI_FINISHPAGE_TEXT  "Removed. Thanks for running something local, even for a while.$\r$\n$\r$\nIf you've found a tool that fits your setup better, that's a good outcome. The point was always that you run what you want on hardware you own -- not that you run ours.$\r$\n$\r$\nThe code stays free and open either way, and the door's open if you're ever back."
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; Theming the standard pages.
;
; MUI2 hands each page's control handles to the SHOW hook after it has
; fetched them (Pages/Directory.nsh:106-112 then :119), so these run late
; enough to colour real windows.
;
; Buttons are left alone on purpose. SetCtlColors cannot recolour a themed
; button's label -- the visual style draws it -- and detaching the theme to
; force it makes a Windows 95 button, which looks broken next to everything
; else rather than merely light. A standard button on a dark page reads as
; a system control; a classic one reads as a bug.
; ---------------------------------------------------------------------------

Function StyleParentWindow
  ; The parent is what shows behind the button row and around every page.
  SetCtlColors $HWNDPARENT "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ; Branding strip. MUI has already set both halves to /BRANDING by the
  ; time this runs (Interface.nsh:268-271, and the custom GUIINIT hook is
  ; called after MUI_GUIINIT_OUTERDIALOG), so overriding here sticks.
  ;
  ; /BRANDING resolves to system colours, which on a dark parent means
  ; near-white text: 19:1 against the background, brighter than the body
  ; copy it sits beneath. A footer credit should be the quietest thing on
  ; the screen, not the loudest. ${GN_BRANDCOLOR} is the same value the
  ; site uses for its NO CORPO MONEY line -- same job, same weight.
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "${GN_BRANDCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "${GN_BRANDCOLOR}" "${MUI_BGCOLOR}"
  ; The hairline above the buttons is a static control, and left white it
  ; draws a bright bar across the bottom of every screen.
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 "${MUI_BGCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1045
  SetCtlColors $0 "${MUI_BGCOLOR}" "${MUI_BGCOLOR}"
FunctionEnd

Function DirectoryPageShow
  SetCtlColors $mui.DirectoryPage "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  SetCtlColors $mui.DirectoryPage.Text "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  SetCtlColors $mui.DirectoryPage.DirectoryBox "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  SetCtlColors $mui.DirectoryPage.SpaceRequired "8FA383" "${MUI_BGCOLOR}"
  SetCtlColors $mui.DirectoryPage.SpaceAvailable "8FA383" "${MUI_BGCOLOR}"
  ; The path field is an edit control: give it a panel colour rather than
  ; the page colour so it still reads as something you can type into.
  SetCtlColors $mui.DirectoryPage.Directory "F2FAE8" "1A1D25"
FunctionEnd

Function InstFilesPageShow
  ; Shared by the installer and the uninstaller -- same control layout.
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1006          ; the "Please wait..." status line
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1004          ; the label above the details list
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  ; The details listbox is already green-on-black via InstallColors.
FunctionEnd

; NSIS keeps installer and uninstaller functions in separate namespaces, so
; the uninstaller cannot call the three above -- it needs its own copies
; under the mandatory un. prefix. Duplicated deliberately; there is no
; sharing mechanism to use instead.

Function un.StyleParentWindow
  SetCtlColors $HWNDPARENT "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "${GN_BRANDCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "${GN_BRANDCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 "${MUI_BGCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1045
  SetCtlColors $0 "${MUI_BGCOLOR}" "${MUI_BGCOLOR}"
FunctionEnd

Function un.InstFilesPageShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1006
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1004
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
FunctionEnd

Function un.UnConfirmPageShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1006
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1000
  SetCtlColors $1 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $1 $0 1019
  SetCtlColors $1 "F2FAE8" "1A1D25"
FunctionEnd

Function PasswordPageCreate
  !insertmacro MUI_HEADER_TEXT "Access Password" "Keeps other people on your network out of your chat."
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ; A custom page is a bare system dialog -- MUI only paints the header bar
  ; and the welcome/finish bodies, so without this the page arrives in
  ; Windows grey while every other screen is near-black. Each control has to
  ; be coloured individually; there is no inherited style to lean on.
  SetCtlColors $Dialog "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 0 100% 34u "If you later open GobboNet to your home network, this password is what stops anyone else on that network reading your chats. It is stored only as a salted SHA-256 hash, never as plain text, and never leaves this machine."
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 42u 30% 12u "Password:"
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  ${NSD_CreatePassword} 31% 40u 67% 12u ""
  Pop $hPw1
  ; Input fields stay light-on-dark rather than transparent: an edit control
  ; with a transparent background paints its own white box on focus.
  SetCtlColors $hPw1 "F2FAE8" "1A1D25"

  ${NSD_CreateLabel} 0 60u 30% 12u "Confirm:"
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  ${NSD_CreatePassword} 31% 58u 67% 12u ""
  Pop $hPw2
  SetCtlColors $hPw2 "F2FAE8" "1A1D25"

  ${NSD_CreateCheckbox} 0 78u 100% 12u "Skip - ask me on first run instead"
  Pop $hPwSkip
  ; Same themed-button problem as the finish page: SetCtlColors paints the
  ; background but a themed checkbox draws its own label with DrawThemeText
  ; and ignores the text colour, so it has to be detached from the visual
  ; style first. See FinishPageShow for the longer version.
  System::Call 'uxtheme::SetWindowTheme(p $hPwSkip, t " ", t " ")'
  SetCtlColors $hPwSkip "${GN_CHECKCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 94u 100% 20u "Six characters minimum. You will type this once on your phone the first time it connects."
  Pop $0
  SetCtlColors $0 "8FA383" "${MUI_BGCOLOR}"

  nsDialogs::Show
FunctionEnd

Function PasswordPageLeave
  StrCpy $PwSkipped "0"
  ${NSD_GetState} $hPwSkip $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $PwSkipped "1"
    StrCpy $PwPlain ""
    Return
  ${EndIf}

  ${NSD_GetText} $hPw1 $1
  ${NSD_GetText} $hPw2 $2

  ${If} $1 == ""
    MessageBox MB_ICONEXCLAMATION "Enter a password, or tick the skip box and set it on first run."
    Abort
  ${EndIf}
  ; Six, matching launch.bat's console prompt ($min = 6). These two are the
  ; only ways a password gets set, and a rule that differs between them
  ; means the wizard accepts something the fallback path would reject.
  StrLen $3 $1
  ${If} $3 < 6
    MessageBox MB_ICONEXCLAMATION "Use at least six characters."
    Abort
  ${EndIf}
  ${If} $1 != $2
    MessageBox MB_ICONEXCLAMATION "The two passwords do not match."
    Abort
  ${EndIf}

  StrCpy $PwPlain $1
FunctionEnd

Function PortPageCreate
  !insertmacro MUI_HEADER_TEXT "Network Port" "Leave this alone unless you know you need to change it."
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  SetCtlColors $Dialog "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 0 100% 34u "GobboNet serves its chat page on this port. The default is 9066, chosen because almost nothing else uses it. Earlier versions used 8080 and kept colliding with other software."
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 42u 26% 12u "Port:"
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  ${NSD_CreateNumber} 27% 40u 20% 12u "9066"
  Pop $hPort
  SetCtlColors $hPort "F2FAE8" "1A1D25"

  ${NSD_CreateLabel} 0 62u 100% 40u "Only change this if you already know that something else on this PC is using 9066. If you pick a port that is in use, or one Windows has reserved, GobboNet will not start and the reason will not be obvious.$\r$\n$\r$\nIf you are not sure: leave it. You can change it later without reinstalling."
  Pop $hPortWarn
  SetCtlColors $hPortWarn "E8B34A" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 106u 100% 12u "Valid range 1024-32767."
  Pop $0
  SetCtlColors $0 "8FA383" "${MUI_BGCOLOR}"

  nsDialogs::Show
FunctionEnd

Function PortPageLeave
  ${NSD_GetText} $hPort $0
  ${If} $0 == ""
    StrCpy $PortValue "9066"
    Return
  ${EndIf}
  ${If} $0 < 1024
    MessageBox MB_ICONEXCLAMATION "Ports below 1024 are reserved by Windows for system services. Pick something between 1024 and 65535, or leave it at 9066."
    Abort
  ${EndIf}
  ${If} $0 > 32767
    MessageBox MB_ICONEXCLAMATION "Use a port below 32768. Above that, Windows hands out ephemeral connection ports and reserved ranges, so a listener up there can be taken by an outbound connection and fail to start intermittently. Leave it at 9066 unless you have a reason."
    Abort
  ${EndIf}
  StrCpy $PortValue $0
FunctionEnd

Function DefenderPageCreate
  !insertmacro MUI_HEADER_TEXT "One Thing Before You Start" "Windows Defender and GobboNet."
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  SetCtlColors $Dialog "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 0 100% 44u "GobboNet can make Windows Defender very unhappy. It downloads a large file, starts several local servers, and runs scripts out of a folder in your user profile. Defender reads that shape rather than what the program actually does, and sometimes decides it looks wrong. The GobboNet GitHub page has the specifics."
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 50u 100% 12u "To stop Windows changing things behind your back:"
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ; Boxed and set apart so it reads as a path to follow, not as more prose.
  ${NSD_CreateLabel} 0 64u 100% 28u "   Windows Security  >  Virus & threat protection  >$\r$\n   Manage settings  >  Exclusions  >  Add an exclusion  >$\r$\n   Folder  >  then pick your GobboNet folder"
  Pop $hDefender
  SetCtlColors $hDefender "${GN_CHECKCOLOR}" "1A1D25"

  ${NSD_CreateLabel} 0 96u 100% 32u "Excluding that folder is what stops GobboNet being quietly quarantined during an overnight scan while you are away from the PC. If files start disappearing later, or a model refuses to load for no clear reason, this is the first thing to check."
  Pop $0
  SetCtlColors $0 "8FA383" "${MUI_BGCOLOR}"

  ${NSD_CreateLabel} 0 132u 100% 12u "The folder to exclude is: $INSTDIR"
  Pop $0
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  nsDialogs::Show
FunctionEnd

Function RunGobboNet
  ExecShell "" "$INSTDIR\${APPEXE}"
FunctionEnd

; setup-lan.bat needs administrator rights: it adds a firewall rule and a URL
; ACL. launchLAN.exe used to carry a manifest that asked for elevation on its
; own, so the old call here was a plain ExecShell. With the shim gone the
; request has to be made explicitly, hence the runas verb -- otherwise the
; batch file starts unelevated and fails partway through, which is worse than
; not starting at all.
Function RunLanSetup
  ExecShell "runas" "$INSTDIR\${LANEXE}"
FunctionEnd

; ---------------------------------------------------------------------------
; Finish-page checkbox legibility.
;
; MUI2 already calls SetCtlColors on both checkboxes (Finish.nsh:378,387),
; but that is not enough on its own. SetCtlColors works by answering
; WM_CTLCOLORSTATIC with a brush and text colour -- and a *themed*
; checkbox ignores the text colour, because the visual style draws the
; label itself with DrawThemeText. Result: the background turns dark as
; asked and the text stays theme-black, which is invisible on 0D0E12.
;
; SetWindowTheme(hwnd, " ", " ") detaches the control from the visual
; style, after which it falls back to classic drawing and honours the
; colour we set. Harmless where theming is already off -- the control was
; obeying SetCtlColors anyway.
;
; This runs from CUSTOMFUNCTION_SHOW, which MUI2 invokes after the
; checkboxes are created (Finish.nsh:432) and before the page is shown.
; ---------------------------------------------------------------------------
Function FinishPageShow
  StrCpy $0 $mui.FinishPage.Run
  System::Call 'uxtheme::SetWindowTheme(p r0, t " ", t " ")'
  SetCtlColors $0 "${GN_CHECKCOLOR}" "${MUI_BGCOLOR}"

  StrCpy $1 $mui.FinishPage.ShowReadme
  System::Call 'uxtheme::SetWindowTheme(p r1, t " ", t " ")'
  SetCtlColors $1 "${GN_CHECKCOLOR}" "${MUI_BGCOLOR}"
FunctionEnd

; ---------------------------------------------------------------- install
Section "GobboNet" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; --- launcher shims -----------------------------------------------------
  ; Gone as of 1.7. launch.exe / launchLAN.exe were C shims that located the
  ; folder and ShellExecute'd a .bat; the shortcuts and finish-page checkboxes
  ; now point at those .bat files directly, so there is nothing left to ship.
  File "art\gobbonet.ico"

  ; --- application --------------------------------------------------------
  ; Explicit file list rather than a wildcard: a wildcard would sweep up
  ; whatever generated state happens to be sitting in the build folder.
  File "${APPSRC}\launch.bat"
  File "${APPSRC}\setup-lan.bat"
  ; Both new in 1.7 and both required: launch.bat hands off to stop-gobbonet.bat
  ; to bring the servers down, and teardown-lan.bat is the documented undo for
  ; setup-lan.bat's firewall rule and URL ACL.
  File "${APPSRC}\teardown-lan.bat"
  File "${APPSRC}\stop-gobbonet.bat"
  File "${APPSRC}\fileserver.ps1"
  File "${APPSRC}\hardware-probe.ps1"
  File "${APPSRC}\identify-model.ps1"
  File "${APPSRC}\hw-recommend.ps1"
  File "${APPSRC}\chat.html"
  File "${APPSRC}\default-characters.json"
  File "${APPSRC}\LICENSE"
  File "${APPSRC}\TROUBLESHOOTING.md"
  File "${APPSRC}\PURGE.md"
  File "${APPSRC}\SECURITY.md"

  ; --- js\ and css\ ---------------------------------------------------------
  ; Wildcards here, unlike the root, and that exception is deliberate. The
  ; root list is explicit because generated state (models-list.json,
  ; hardware.json, *.log) lands there and a wildcard would ship the build
  ; machine's copy to every user. Nothing is ever generated into js\ or
  ; css\ -- extensions are stored in the browser, not on disk -- so a
  ; wildcard is safe and means a new module ships without editing this file.
  ;
  ; style.css is gone on purpose: it is now css\01 through css\12. Shipping
  ; both would apply every rule twice.
  SetOutPath "$INSTDIR\js"
  File "${APPSRC}\js\*.js"
  SetOutPath "$INSTDIR\css"
  File "${APPSRC}\css\*.css"
  SetOutPath "$INSTDIR"

  ; --- NO pre-created data directories ------------------------------------
  ; Deliberately absent. launch.bat creates models\ and llama-cpp\ itself
  ; (lines 427 and 463), and pre-creating llama-cpp\ actively breaks it:
  ; its "is llama.cpp already here?" check is
  ;
  ;     if exist "!LLAMA_DIR!" ( for /r "!LLAMA_DIR!" %%F in (llama-server.exe) ...
  ;
  ; and `for /r` with a non-wildcard filename does not test existence -- it
  ; emits <dir>\llama-server.exe for every directory in the tree. An empty
  ; llama-cpp\ therefore reports a false hit on the very first iteration,
  ; points SERVER_EXE at a file that is not there, and skips the llama.cpp
  ; download entirely. The model then downloads fine and the server dies
  ; instantly with an empty log. Do not add these back.

  ; --- shortcuts ----------------------------------------------------------
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" \
                 "$INSTDIR\${APPEXE}" "" "$INSTDIR\gobbonet.ico" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME} LAN Setup.lnk" \
                 "$INSTDIR\${LANEXE}" "" "$INSTDIR\gobbonet.ico" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" \
                 "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" \
                 "$INSTDIR\${APPEXE}" "" "$INSTDIR\gobbonet.ico" 0

  ; --- registration -------------------------------------------------------
  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${REGKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion"  "${APPVER}"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon"     "$INSTDIR\gobbonet.ico"
  WriteRegStr HKCU "${REGKEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr HKCU "${REGKEY}" "URLInfoAbout"    "${HOMEPAGE}"
  WriteRegStr HKCU "${REGKEY}" "HelpLink"        "${HOMEPAGE}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1

  ; --- record the chosen port ---------------------------------------------
  ; launch.bat, setup-lan.bat and fileserver.ps1 all resolve the port the
  ; same way, and .gobbonet-port is the middle rung: an environment
  ; variable beats it for one-off runs, and 9066 is the fallback if it is
  ; absent or unreadable. Written unconditionally so there is one file to
  ; look at when someone asks "which port is this install on".
  ${If} $PortValue == ""
    StrCpy $PortValue "9066"
  ${EndIf}
  ; Written one byte at a time as raw ASCII digits.
  ;
  ; FileWrite's encoding in a Unicode build is a detail nobody should have to
  ; know, and if it ever produced UTF-16 or a BOM here the launcher would read
  ; a garbled port, fall back to 9066, and the user's chosen port would look
  ; like a feature that does not work. Emitting the digits as bytes removes the
  ; question entirely. The launcher strips non-digits anyway, so this is belt
  ; and braces on the one setting a user explicitly asked for.
  FileOpen $9 "$INSTDIR\.gobbonet-port" w
  StrCpy $R0 0
  ${Do}
    StrCpy $R1 $PortValue 1 $R0
    ${If} $R1 == ""
      ${Break}
    ${EndIf}
    ; digits only, so a direct code-point map is exact and avoids pulling in
    ; a character-to-byte helper for four possible values
    ${If} $R1 == "0"
      FileWriteByte $9 48
    ${ElseIf} $R1 == "1"
      FileWriteByte $9 49
    ${ElseIf} $R1 == "2"
      FileWriteByte $9 50
    ${ElseIf} $R1 == "3"
      FileWriteByte $9 51
    ${ElseIf} $R1 == "4"
      FileWriteByte $9 52
    ${ElseIf} $R1 == "5"
      FileWriteByte $9 53
    ${ElseIf} $R1 == "6"
      FileWriteByte $9 54
    ${ElseIf} $R1 == "7"
      FileWriteByte $9 55
    ${ElseIf} $R1 == "8"
      FileWriteByte $9 56
    ${ElseIf} $R1 == "9"
      FileWriteByte $9 57
    ${EndIf}
    IntOp $R0 $R0 + 1
  ${Loop}
  FileClose $9
  DetailPrint "Web UI port: $PortValue"

  ; --- write the access secret, if one was set in the wizard --------------
  ; The password reaches PowerShell through an environment variable, never
  ; the command line: command lines are readable from the process list by
  ; anything running on the machine, environment blocks are not. The helper
  ; script lands in $PLUGINSDIR, which NSIS wipes on exit.
  ;
  ; The format is <32 hex salt>:<sha256 of salt+password>, which is what
  ; fileserver.ps1 parses and what launch.bat's own setup writes. If any
  ; step here fails we simply leave no file behind and launch.bat prompts
  ; on first run exactly as before.
  ${If} $PwSkipped != "1"
  ${AndIf} $PwPlain != ""
    InitPluginsDir
    StrCpy $0 $PwPlain
    System::Call 'kernel32::SetEnvironmentVariable(t "GN_SETUP_PW", t r0)'
    StrCpy $0 "$INSTDIR\.gobbonet-secret"
    System::Call 'kernel32::SetEnvironmentVariable(t "GN_SETUP_OUT", t r0)'

    FileOpen $9 "$PLUGINSDIR\setpw.ps1" w
    FileWrite $9 "$$ErrorActionPreference = 'Stop'$\r$\n"
    FileWrite $9 "try {$\r$\n"
    FileWrite $9 "  $$b = New-Object byte[] 16$\r$\n"
    FileWrite $9 "  ([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($$b)$\r$\n"
    FileWrite $9 "  $$salt = -join ($$b | ForEach-Object { $$_.ToString('x2') })$\r$\n"
    FileWrite $9 "  $$bytes = [Text.Encoding]::UTF8.GetBytes($$salt + $$env:GN_SETUP_PW)$\r$\n"
    FileWrite $9 "  $$h = ([Security.Cryptography.SHA256]::Create()).ComputeHash($$bytes)$\r$\n"
    FileWrite $9 "  $$hash = -join ($$h | ForEach-Object { $$_.ToString('x2') })$\r$\n"
    FileWrite $9 "  Set-Content -Path $$env:GN_SETUP_OUT -Value ($$salt + ':' + $$hash) -Encoding ascii -NoNewline$\r$\n"
    FileWrite $9 "  Write-Host '  Access password stored as a salted hash.'$\r$\n"
    FileWrite $9 "} catch {$\r$\n"
    FileWrite $9 "  Write-Host '  Could not store the password here; GobboNet will ask on first run.'$\r$\n"
    FileWrite $9 "}$\r$\n"
    FileClose $9

    DetailPrint "Storing access password..."
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\setpw.ps1"'
    Pop $0

    ; Clear both immediately -- the installer process lives on through the
    ; finish page, and there is no reason for the plaintext to outlive this.
    System::Call 'kernel32::SetEnvironmentVariable(t "GN_SETUP_PW", i 0)'
    System::Call 'kernel32::SetEnvironmentVariable(t "GN_SETUP_OUT", i 0)'
    StrCpy $PwPlain ""
    Delete "$PLUGINSDIR\setpw.ps1"

    ${IfNot} ${FileExists} "$INSTDIR\.gobbonet-secret"
      DetailPrint "  (not stored - GobboNet will ask for it on first run)"
    ${EndIf}
  ${EndIf}

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" "$0"
SectionEnd

; ---------------------------------------------------------------- uninstall
Section "Uninstall"

  ; Remove only what we installed. Never RMDir /r $INSTDIR -- that would
  ; take models\ with it, and nobody wants to redownload 40 GB because
  ; they reinstalled.
  ; ${APPEXE} and ${LANEXE} are launch.bat and setup-lan.bat as of 1.7 and are
  ; named explicitly below, so the two stub-exe lines that used to head this
  ; list are gone with the shims themselves. The two Deletes that replace them
  ; are for upgrades: a 1.6 install has real launch.exe / launchLAN.exe files
  ; sitting in the folder, and nothing else here would ever remove them. Same
  ; reasoning as the stale style.css line further down.
  Delete "$INSTDIR\launch.exe"
  Delete "$INSTDIR\launchLAN.exe"
  Delete "$INSTDIR\gobbonet.ico"
  Delete "$INSTDIR\launch.bat"
  Delete "$INSTDIR\setup-lan.bat"
  Delete "$INSTDIR\teardown-lan.bat"
  Delete "$INSTDIR\stop-gobbonet.bat"
  Delete "$INSTDIR\fileserver.ps1"
  Delete "$INSTDIR\hardware-probe.ps1"
  Delete "$INSTDIR\identify-model.ps1"
  Delete "$INSTDIR\hw-recommend.ps1"
  Delete "$INSTDIR\chat.html"
  Delete "$INSTDIR\default-characters.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\TROUBLESHOOTING.md"
  Delete "$INSTDIR\PURGE.md"
  Delete "$INSTDIR\SECURITY.md"
  Delete "$INSTDIR\style.css"   ; pre-1.4 installs shipped this; remove the stale copy

  Delete "$INSTDIR\js\*.js"
  RMDir  "$INSTDIR\js"
  Delete "$INSTDIR\css\*.css"
  RMDir  "$INSTDIR\css"

  ; Generated state -- safe to remove, regenerated on next install.
  Delete "$INSTDIR\models-list.json"
  Delete "$INSTDIR\hardware.json"
  Delete "$INSTDIR\.hw-parsed.env"
  Delete "$INSTDIR\.gobbonet-perf.json"
  Delete "$INSTDIR\.gobbonet-port"
  Delete "$INSTDIR\.gobbonet-secret"
  Delete "$INSTDIR\.gobbonet-secret.bad"
  Delete "$INSTDIR\*.log"
  ; fileserver.ps1 writes this on every start so its startup diagnostics
  ; survive the hidden window. Covered by *.log above, named for clarity.
  Delete "$INSTDIR\fileserver.log"

  ; --- CONVERSATION DATA -------------------------------------------------
  ; fileserver.ps1 mirrors the entire chat state to .gobbonet-state.json in
  ; this folder (fileserver.ps1:63), and spools each generation through
  ; .jobs\*.json (:73). Neither was in this list, so uninstalling removed
  ; the program and left every conversation on disk -- and a reinstall found
  ; them and synced them straight back, which looks exactly like the
  ; installer carrying data it never touched.
  ;
  ; Uninstall means uninstall. This is the one category that gets removed
  ; without asking, because leaving someone's private conversations behind
  ; after they asked for the software to be gone is not a convenience.
  Delete "$INSTDIR\.gobbonet-state.json"
  Delete "$INSTDIR\.gobbonet-state.json.bak"
  Delete "$INSTDIR\.jobs\*.json"
  RMDir  "$INSTDIR\.jobs"

  ; Transient runtime scratch, same reasoning, less sensitive.
  Delete "$INSTDIR\.swap-status.json"
  Delete "$INSTDIR\.swap-in-progress"
  Delete "$INSTDIR\.llama-launch.cmd"
  Delete "$INSTDIR\.embed-launch.cmd"
  Delete "$INSTDIR\.last-lan-ip"

  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME} LAN Setup.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"

  ; llama.cpp is a few hundred MB and re-downloadable; take it silently.
  RMDir /r "$INSTDIR\llama-cpp"

  ; Models are the expensive thing. Ask.
  ${If} ${FileExists} "$INSTDIR\models\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Delete the downloaded models too?$\r$\n$\r$\nThese run to tens of gigabytes and are slow to fetch again. Choose No to keep them for a future install." \
      IDYES deleteModels IDNO keepModels
    deleteModels:
      RMDir /r "$INSTDIR\models"
      Goto modelsDone
    keepModels:
    modelsDone:
  ${EndIf}

  Delete "$INSTDIR\uninstall.exe"

  ; Only removes the folder if it is genuinely empty -- so a kept models\
  ; directory survives intact.
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\${APPNAME}"

  ${If} ${FileExists} "$INSTDIR\models\*.*"
    MessageBox MB_OK|MB_ICONINFORMATION \
      "GobboNet is gone, and so are your conversations - the chat state file and job spool were removed with it.$\r$\n$\r$\nYour models were left where they were:$\r$\n$INSTDIR\models$\r$\n$\r$\nOne copy remains that no uninstaller can reach: the browser's own storage for this site. Clear it from the browser that opened the chat, under site data for the address you used."
  ${EndIf}

  ; Note: firewall rules and URL ACLs created by setup-lan.bat are left in
  ; place. Removing them needs administrator rights, which this per-user
  ; uninstaller does not have. The undo commands are printed at the end of
  ; setup-lan.bat.
SectionEnd
