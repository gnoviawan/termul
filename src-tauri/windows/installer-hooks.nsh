; Troupe shipped as "Termul Manager" up to 0.4.60. Tauri's NSIS template keys
; the install folder and the Apps & features entry on PRODUCTNAME, so without
; these hooks installing or auto-updating to Troupe leaves Termul Manager
; installed next to it (tauri-apps/tauri#14175).
;
; PREINSTALL runs the old uninstaller silently and waits for it. App data stays:
; it lives under the unchanged identifier (com.termul-manager.app), and the
; uninstaller only deletes it when its "delete app data" checkbox is ticked,
; which a silent run never shows.

!define TROUPE_LEGACY_PRODUCTNAME "Termul Manager"
!define TROUPE_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${TROUPE_LEGACY_PRODUCTNAME}"

Var TroupeLegacyDir
Var TroupeLegacyBinary
Var TroupeLegacyStartMenu
Var TroupeLegacyDesktop

!macro NSIS_HOOK_PREINSTALL
  StrCpy $TroupeLegacyStartMenu 0
  StrCpy $TroupeLegacyDesktop 0

  ; Released builds install per user (HKCU); a per-machine install lands in HKLM.
  ReadRegStr $TroupeLegacyDir HKCU "${TROUPE_LEGACY_UNINSTKEY}" "InstallLocation"
  ReadRegStr $TroupeLegacyBinary HKCU "${TROUPE_LEGACY_UNINSTKEY}" "MainBinaryName"
  ${If} $TroupeLegacyDir == ""
    ReadRegStr $TroupeLegacyDir HKLM "${TROUPE_LEGACY_UNINSTKEY}" "InstallLocation"
    ReadRegStr $TroupeLegacyBinary HKLM "${TROUPE_LEGACY_UNINSTKEY}" "MainBinaryName"
  ${EndIf}

  ; The template writes InstallLocation wrapped in quotes.
  StrCpy $0 $TroupeLegacyDir 1
  ${If} $0 == '"'
    StrCpy $TroupeLegacyDir $TroupeLegacyDir "" 1
    StrCpy $TroupeLegacyDir $TroupeLegacyDir -1
  ${EndIf}
  ${If} $TroupeLegacyBinary == ""
    StrCpy $TroupeLegacyBinary "termul-manager.exe"
  ${EndIf}

  ${If} $TroupeLegacyDir != ""
  ${AndIf} ${FileExists} "$TroupeLegacyDir\uninstall.exe"
    ; The uninstaller deletes these; POSTINSTALL recreates them for Troupe,
    ; because an update-mode install never creates shortcuts itself.
    ${If} ${FileExists} "$SMPROGRAMS\${TROUPE_LEGACY_PRODUCTNAME}.lnk"
      StrCpy $TroupeLegacyStartMenu 1
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\${TROUPE_LEGACY_PRODUCTNAME}.lnk"
      StrCpy $TroupeLegacyDesktop 1
    ${EndIf}

    ; Asks before closing a running Termul Manager, or closes it in passive and
    ; silent mode, so the uninstaller below does not kill it unannounced.
    !insertmacro CheckIfAppIsRunning "$TroupeLegacyDir\$TroupeLegacyBinary" "${TROUPE_LEGACY_PRODUCTNAME}"

    DetailPrint "Removing ${TROUPE_LEGACY_PRODUCTNAME} from $TroupeLegacyDir"
    ; _?= runs the uninstaller in place instead of from a temp copy, so ExecWait
    ; really waits. It cannot delete itself while running, so that is done here.
    ClearErrors
    ExecWait '"$TroupeLegacyDir\uninstall.exe" /S _?=$TroupeLegacyDir' $0
    ${If} ${Errors}
    ${OrIf} $0 <> 0
      DetailPrint "${TROUPE_LEGACY_PRODUCTNAME} uninstaller failed (exit code $0); it stays installed"
    ${Else}
      Delete "$TroupeLegacyDir\uninstall.exe"
      RMDir "$TroupeLegacyDir"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $TroupeLegacyStartMenu = 1
  ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $TroupeLegacyDesktop = 1
  ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend
