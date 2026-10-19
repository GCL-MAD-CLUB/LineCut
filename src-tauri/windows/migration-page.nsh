!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!define MUI_CUSTOMFUNCTION_ABORT MigrationUserAbort

Var MigrationProcess
Var MigrationComplete
Var MigrationAllowed
Var MigrationProgressFile
Var MigrationCancelFile
Var MigrationState
Var MigrationError
Var MigrationPhaseLabel
Var MigrationCopiedLabel
Var MigrationVerifiedLabel
Var MigrationFileLabel
Var MigrationErrorLabel
Var MigrationBar
Var MigrationActionButton
Var MigrationNextButton

Function CheckMigrationAllowed
  StrCpy $MigrationAllowed 1
  ; Do not mistake an elevated administrator profile for every machine-wide user.
  !if "${INSTALLMODE}" == "perMachine"
    StrCpy $MigrationAllowed 0
  !else if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      StrCpy $MigrationAllowed 0
    ${EndIf}
  !endif
FunctionEnd

Function StartMigration
  InitPluginsDir
  StrCpy $MigrationProgressFile "$PLUGINSDIR\migration-progress.ini"
  StrCpy $MigrationCancelFile "$PLUGINSDIR\migration.cancel"
  Delete "$MigrationProgressFile"
  Delete "$MigrationCancelFile"
  StrCpy $MigrationProcess 0
  StrCpy $MigrationComplete 0
  StrCpy $MigrationState "running"
  StrCpy $MigrationError ""
  StrCpy $0 '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --migrate-legacy-data --migration-silent --migration-progress $\"$MigrationProgressFile$\" --migration-cancel $\"$MigrationCancelFile$\"'
  ; The NSIS engine is 32-bit even when installing a 64-bit application.
  ; STARTUPINFOW is 68 bytes; PROCESS_INFORMATION is 16 bytes.
  System::Call '*(i68, p0, p0, p0, i0, i0, i0, i0, i0, i0, i0, i0, &i2 0, &i2 0, p0, p0, p0, p0) p.r1'
  System::Call '*(p0, p0, i0, i0) p.r2'
  ; CREATE_NO_WINDOW prevents a console as well as any independent migration window.
  System::Call 'kernel32::CreateProcessW(p0, w r0, p0, p0, i0, i0x08000000, p0, w "$INSTDIR", p r1, p r2) i.r3'
  ${If} $3 != 0
    System::Call '*$2(p.r4, p.r5)'
    StrCpy $MigrationProcess $4
    System::Call 'kernel32::CloseHandle(p r5)'
  ${Else}
    System::Call 'kernel32::GetLastError() i.r3'
    StrCpy $MigrationState "error"
    StrCpy $MigrationError "无法启动数据迁移（错误 $3）。请检查安装目录的访问权限，然后重试。"
  ${EndIf}
  System::Free $1
  System::Free $2
FunctionEnd

Function PollMigrationProcess
  ${If} $MigrationProcess = 0
    Return
  ${EndIf}
  System::Call 'kernel32::GetExitCodeProcess(p $MigrationProcess, *i.r0) i.r1'
  ${If} $1 != 0
  ${AndIf} $0 = 259
    Return
  ${EndIf}
  ; A terminal snapshot alone is insufficient: the worker must also exit successfully.
  System::Call 'kernel32::CloseHandle(p $MigrationProcess)'
  StrCpy $MigrationProcess 0
  ReadINIStr $MigrationState "$MigrationProgressFile" "Migration" "State"
  ReadINIStr $MigrationError "$MigrationProgressFile" "Migration" "Error"
  ${If} $1 != 0
  ${AndIf} $0 = 0
  ${AndIf} $MigrationState == "complete"
    StrCpy $MigrationComplete 1
  ${Else}
    ${If} $MigrationError == ""
      StrCpy $MigrationError "数据迁移未完成（退出码 $0）。原数据仍保留，请重试。"
    ${EndIf}
    ${If} $MigrationState != "cancelled"
      StrCpy $MigrationState "error"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CancelMigration
  ${If} $MigrationProcess != 0
    FileOpen $0 "$MigrationCancelFile" w
    FileWrite $0 "cancel"
    FileClose $0
  ${EndIf}
FunctionEnd

Function MigrationUserAbort
  ${If} $MigrationProcess != 0
  ${AndIf} $MigrationProcess != ""
    Call CancelMigration
    Abort
  ${EndIf}
FunctionEnd

; Silent/passive installs have no custom page. They use the same worker and completion checks.
Function MigrateLegacyData
  Call CheckMigrationAllowed
  ${If} $MigrationAllowed = 0
    StrCpy $MigrationComplete 1
    DetailPrint "机器级安装不迁移用户数据。如需迁移旧数据，请使用当前用户安装。"
    Return
  ${EndIf}
  DetailPrint "正在迁移并校验 LineCut 数据…"
  Call StartMigration
  migration_wait:
    Call PollMigrationProcess
    ${If} $MigrationProcess != 0
      Sleep 100
      Goto migration_wait
    ${EndIf}
  ${If} $MigrationComplete = 1
    DetailPrint "数据迁移和校验完成。"
  ${Else}
    DetailPrint "$MigrationError"
    SetErrorLevel 2
  ${EndIf}
FunctionEnd

Function MigrationPageCreate
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  Call CheckMigrationAllowed
  ${If} $MigrationAllowed = 0
    StrCpy $MigrationComplete 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "迁移旧数据" "正在迁移 LineCut 设置、缓存和浏览器数据，并校验文件完整性。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 18u "正在准备数据迁移…"
  Pop $MigrationPhaseLabel
  ${NSD_CreateProgressBar} 0 22u 100% 12u ""
  Pop $MigrationBar
  ${NSD_AddStyle} $MigrationBar 0x8 ; PBS_MARQUEE
  ${NSD_CreateLabel} 0 40u 100% 12u "已复制：0 / 0.0 MiB"
  Pop $MigrationCopiedLabel
  ${NSD_CreateLabel} 0 56u 100% 12u "已校验：0 / 0.0 MiB"
  Pop $MigrationVerifiedLabel
  ${NSD_CreateLabel} 0 72u 100% 24u ""
  Pop $MigrationFileLabel
  ${NSD_CreateLabel} 0 100u 100% 32u ""
  Pop $MigrationErrorLabel
  ${NSD_CreateButton} 0 138u 72u 16u "取消迁移"
  Pop $MigrationActionButton
  ${NSD_OnClick} $MigrationActionButton MigrationAction
  ${NSD_CreateLabel} 82u 138u -82u 20u "原数据会保留，迁移和校验完成后将自动进入完成页。"
  Pop $0
  GetDlgItem $MigrationNextButton $HWNDPARENT 1
  EnableWindow $MigrationNextButton 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  Call StartMigration
  SendMessage $MigrationBar ${PBM_SETMARQUEE} 1 40
  ${NSD_CreateTimer} MigrationPoll 100
  nsDialogs::Show
  ${NSD_KillTimer} MigrationPoll
FunctionEnd

Function MigrationPageLeave
  ${If} $MigrationComplete != 1
    Abort
  ${EndIf}
FunctionEnd

Function MigrationAction
  Pop $0
  ${If} $MigrationProcess != 0
    Call CancelMigration
    ${NSD_SetText} $MigrationPhaseLabel "正在停止迁移，请稍候…"
    EnableWindow $MigrationActionButton 0
  ${Else}
    ${NSD_SetText} $MigrationErrorLabel ""
    ${NSD_SetText} $MigrationPhaseLabel "正在准备数据迁移…"
    ${NSD_SetText} $MigrationActionButton "取消迁移"
    Call StartMigration
    SendMessage $MigrationBar ${PBM_SETMARQUEE} 1 40
  ${EndIf}
FunctionEnd

Function MigrationPoll
  Call PollMigrationProcess
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Phase"
  ${If} $0 != ""
    ${NSD_SetText} $MigrationPhaseLabel "$0"
  ${EndIf}
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Copied"
  ${NSD_SetText} $MigrationCopiedLabel "已复制：$0"
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Verified"
  ${NSD_SetText} $MigrationVerifiedLabel "已校验：$0"
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "File"
  ${NSD_SetText} $MigrationFileLabel "$0"
  ${If} $MigrationProcess != 0
    Return
  ${EndIf}
  SendMessage $MigrationBar ${PBM_SETMARQUEE} 0 0
  ${If} $MigrationComplete = 1
    ${NSD_KillTimer} MigrationPoll
    EnableWindow $MigrationNextButton 1
    ; Queue Next only after this timer callback returns; never advance on failure/cancellation.
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p1, p0)'
  ${Else}
    ${NSD_SetText} $MigrationErrorLabel "$MigrationError"
    ${NSD_SetText} $MigrationActionButton "重试"
    EnableWindow $MigrationActionButton 1
  ${EndIf}
FunctionEnd
