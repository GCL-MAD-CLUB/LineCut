!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var IndependentInstallLocation

; $4 is the candidate directory. Neither automatic restoration nor /D may target LineCut.
Function CheckIndependentInstallLocation
  Push $R8
  Push $R9
  StrCpy $IndependentInstallLocation 1
  ${If} $4 == ""
    StrCpy $IndependentInstallLocation 0
    Goto independent_location_done
  ${EndIf}
  GetFullPathName $R8 "$4"
  independent_location_loop:
    ${GetFileName} "$R8" $R9
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
  StrCpy $4 $INSTDIR
  Call CheckIndependentInstallLocation
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
