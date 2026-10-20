!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var IndependentInstallLocation

; Stack in/out. Unlike the NSIS instruction, Win32 normalization accepts missing leaves.
Function NormalizeInstallPath
  Exch $R8
  Push $R9
  Push $R7
  ClearErrors
  ${If} $R8 == ""
    Goto normalize_install_failed
  ${EndIf}
  StrCpy $R7 0
  normalize_install_character:
    StrCpy $R9 $R8 1 $R7
    ${If} $R9 == ""
      Goto normalize_install_api
    ${EndIf}
    ${If} $R9 == '$\"'
    ${OrIf} $R9 == "<"
    ${OrIf} $R9 == ">"
    ${OrIf} $R9 == "|"
    ${OrIf} $R9 == "*"
    ${OrIf} $R9 == "?"
      Goto normalize_install_failed
    ${EndIf}
    ${If} $R9 == ":"
    ${AndIf} $R7 != 1
      Goto normalize_install_failed
    ${EndIf}
    IntOp $R7 $R7 + 1
    Goto normalize_install_character
  normalize_install_api:
    System::Call 'kernel32::GetFullPathNameW(w R8, i ${NSIS_MAX_STRLEN}, w .R8, p0) i.R9'
    ${If} $R9 = 0
    ${OrIf} $R9 >= ${NSIS_MAX_STRLEN}
    ${OrIf} $R8 == ""
      Goto normalize_install_failed
    ${EndIf}
    Goto normalize_install_done
  normalize_install_failed:
    StrCpy $R8 ""
    SetErrors
  normalize_install_done:
    Pop $R7
    Pop $R9
    Exch $R8
FunctionEnd

; $4 is the candidate directory. Neither automatic restoration nor /D may target LineCut.
Function CheckIndependentInstallLocation
  Push $R8
  Push $R9
  StrCpy $IndependentInstallLocation 0
  ${If} $4 == ""
    StrCpy $IndependentInstallLocation 0
    Goto independent_location_done
  ${EndIf}
  Push $4
  Call NormalizeInstallPath
  Pop $R8
  ${If} ${Errors}
  ${OrIf} $R8 == ""
    Goto independent_location_done
  ${EndIf}
  StrCpy $IndependentInstallLocation 1
  independent_location_loop:
    ${GetFileName} "$R8" $R9
    ; Win32 treats trailing dots/spaces as aliases of the same directory component.
    independent_component_trim:
      Push $R7
      StrCpy $R7 $R9 1 -1
      ${If} $R7 == "."
      ${OrIf} $R7 == " "
        StrCpy $R9 $R9 -1
        Pop $R7
        Goto independent_component_trim
      ${EndIf}
      Pop $R7
    ${If} $R9 == "LineCut"
    ${OrIf} ${FileExists} "$R8\linecut.exe"
      StrCpy $IndependentInstallLocation 0
      Goto independent_location_done
    ${EndIf}
    ${GetParent} "$R8" $R9
    ${If} $R9 != ""
    ${AndIf} $R9 != $R8
      StrCpy $R8 $R9
      Goto independent_location_loop
    ${EndIf}
  independent_location_done:
  Pop $R9
  Pop $R8
FunctionEnd

Function EnsureIndependentInstallLocation
  Push $4
  Push $INSTDIR
  Call NormalizeInstallPath
  Pop $4
  Call CheckIndependentInstallLocation
  ${If} $IndependentInstallLocation = 1
    StrCpy $INSTDIR $4
  ${EndIf}
  Pop $4
  ${If} $IndependentInstallLocation != 1
    DetailPrint "Locution Pro 是独立软件，请选择 LineCut 安装目录之外的位置。"
    IfSilent +2
      MessageBox MB_ICONEXCLAMATION|MB_OK "Locution Pro 是 LineCut 的独立续作，不能安装到 LineCut 目录中。请选择其他目录。"
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

; Register our own Open With entry without taking over another application's default.
!macro LOCUTION_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == ""
    ; A per-machine default is also a foreign association for a per-user install.
    ReadRegStr $R0 HKLM "Software\Classes\.${EXT}" ""
    ${If} $R0 == ""
      WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "${FILECLASS}"
    ${EndIf}
  ${EndIf}
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open\command" "" `${COMMAND}`
!macroend

!macro LOCUTION_UNASSOCIATE EXT FILECLASS
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${FILECLASS}"
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey SHCTX "Software\Classes\${FILECLASS}"
!macroend
