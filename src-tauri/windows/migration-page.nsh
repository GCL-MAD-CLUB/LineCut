!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!define MUI_CUSTOMFUNCTION_ABORT MigrationUserAbort

Var MigrationProcess
Var MigrationComplete
Var MigrationSkipped
Var MigrationAllowed
Var MigrationEligible
Var MigrationDataRoot
Var MigrationLegacyRoot
Var MigrationHasSource
Var MigrationRetry
Var MigrationResumable
Var MigrationEntryOwned
Var MigrationStageStem
Var MigrationPendingBlocked
Var MigrationPendingInstallDir
Var MigrationDirectoryIsInstallerOnly
Var MigrationJob
Var MigrationCancelRequested
Var MigrationCancelStarted
Var MigrationStarted
Var MigrationTimedOut
Var MigrationQuitRequested
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
Var MigrationSkipButton
Var MigrationNextButton

!ifndef LOCUTION_MIGRATION_CANCEL_GRACE_MS
  !define LOCUTION_MIGRATION_CANCEL_GRACE_MS 15000
!endif
!ifndef LOCUTION_MIGRATION_SILENT_TIMEOUT_MS
  !define LOCUTION_MIGRATION_SILENT_TIMEOUT_MS 1800000
!endif
!ifndef LOCUTION_MIGRATION_LOCAL_ROOT
  !define LOCUTION_MIGRATION_LOCAL_ROOT "$LOCALAPPDATA"
  !define LOCUTION_MIGRATION_ROAMING_ROOT "$APPDATA"
!endif

; Capture before language selection, file extraction, hooks or registration write new data.
Function CaptureMigrationEligibility
  StrCpy $MigrationEligible 1
  StrCpy $MigrationSkipped 0
  ReadEnvStr $MigrationDataRoot "LOCUTION_PRO_DATA_DIR"
  ${If} $MigrationDataRoot == ""
    StrCpy $MigrationDataRoot "${LOCUTION_MIGRATION_LOCAL_ROOT}\Locution Pro"
  ${EndIf}
  ReadEnvStr $MigrationLegacyRoot "LINECUT_DATA_DIR"
  ${If} $MigrationLegacyRoot == ""
    StrCpy $MigrationLegacyRoot "${LOCUTION_MIGRATION_LOCAL_ROOT}\LineCut"
  ${EndIf}
  StrCpy $MigrationRetry 0
  StrCpy $MigrationResumable 0
  StrCpy $MigrationPendingBlocked 0
  StrCpy $MigrationPendingInstallDir ""
  !macro CheckLocutionRegistrations ROOT
    ReadRegDWORD $0 ${ROOT} "${MANUPRODUCTKEY}" "MigrationSkipped"
    ${If} $0 = 1
      StrCpy $MigrationSkipped 1
      StrCpy $MigrationEligible 0
    ${EndIf}
    ClearErrors
    EnumRegValue $0 ${ROOT} "${MANUPRODUCTKEY}" 0
    StrCpy $3 0
    ${IfNot} ${Errors}
      StrCpy $3 1
    ${EndIf}
    ClearErrors
    EnumRegValue $0 ${ROOT} "${UNINSTKEY}" 0
    ${IfNot} ${Errors}
      StrCpy $3 1
    ${EndIf}
    ${If} $3 = 1
      ReadRegDWORD $0 ${ROOT} "${MANUPRODUCTKEY}" "MigrationPending"
      ReadRegStr $1 ${ROOT} "${MANUPRODUCTKEY}" "MigrationDataRoot"
      ReadRegStr $2 ${ROOT} "${MANUPRODUCTKEY}" "MigrationInstallDir"
      ${If} $0 = 1
      ${AndIf} $1 == $MigrationDataRoot
        ${If} $MigrationRetry = 1
        ${AndIf} $MigrationPendingInstallDir != $2
          StrCpy $MigrationEligible 0
        ${EndIf}
        StrCpy $MigrationRetry 1
        StrCpy $MigrationPendingInstallDir $2
      ${Else}
        StrCpy $MigrationEligible 0
      ${EndIf}
    ${EndIf}
  !macroend
  SetRegView 64
  !insertmacro CheckLocutionRegistrations HKCU
  !insertmacro CheckLocutionRegistrations HKLM
  SetRegView 32
  !insertmacro CheckLocutionRegistrations HKCU
  !insertmacro CheckLocutionRegistrations HKLM
  SetRegView lastused
  ${If} $MigrationRetry = 1
  ${AndIfNot} ${FileExists} "$MigrationDataRoot\cache-version"
  ${AndIfNot} ${FileExists} "$MigrationDataRoot\.locution-pro-import-complete"
    ClearErrors
    FileOpen $0 "$MigrationDataRoot\.locution-pro-import-owned" r
    ${IfNot} ${Errors}
      FileSeek $0 2 SET
      FileReadUTF16LE $0 $1
      FileClose $0
      ${If} $1 == "locution-pro-import-v1$\r$\n"
        StrCpy $MigrationResumable 1
      ${EndIf}
    ${EndIf}
    ; Compatibility with an interrupted worker from before ownership journals existed.
    ${If} ${FileExists} "$MigrationDataRoot\.locution-pro-migration-v2"
      StrCpy $MigrationResumable 1
    ${EndIf}
  ${EndIf}
  StrCpy $4 "${LOCUTION_MIGRATION_LOCAL_ROOT}\com.locutionpro.desktop"
  Call CheckPendingProfile
  StrCpy $4 "${LOCUTION_MIGRATION_ROAMING_ROOT}\com.locutionpro.desktop"
  Call CheckPendingProfile
  StrCpy $4 $MigrationDataRoot
  Call CheckPendingDataDirectory
  StrCpy $4 "${LOCUTION_MIGRATION_LOCAL_ROOT}\Locution Pro"
  Call CheckPendingDataDirectory
  ${If} $MigrationEligible = 1
    StrCpy $MigrationHasSource 0
    StrCpy $4 $MigrationLegacyRoot
    Call CheckLegacyDataDirectory
    StrCpy $4 "${LOCUTION_MIGRATION_LOCAL_ROOT}\com.linecut.desktop"
    Call CheckLegacyDataDirectory
    StrCpy $4 "${LOCUTION_MIGRATION_ROAMING_ROOT}\com.linecut.desktop"
    Call CheckLegacyDataDirectory
    ${If} $MigrationHasSource = 0
      StrCpy $MigrationEligible 0
    ${EndIf}
  ${EndIf}
  ${If} $MigrationRetry = 1
  ${AndIf} $MigrationEligible != 1
  ${AndIfNot} ${FileExists} "$MigrationDataRoot\.locution-pro-import-complete"
    StrCpy $MigrationPendingBlocked 1
  ${EndIf}
  ${If} $MigrationEligible != 1
  ${AndIfNot} ${FileExists} "$MigrationDataRoot\.locution-pro-import-complete"
    ${If} ${FileExists} "$MigrationDataRoot\.locution-pro-migration-v2"
    ${OrIf} ${FileExists} "$MigrationDataRoot\.locution-pro-import-owned"
      StrCpy $MigrationPendingBlocked 1
    ${EndIf}
  ${EndIf}

  ${If} $MigrationSkipped = 1
    StrCpy $MigrationEligible 0
    StrCpy $MigrationPendingBlocked 0
  ${EndIf}
FunctionEnd

Function CheckPendingProfile
  ${IfNot} ${FileExists} "$4"
    Return
  ${EndIf}
  ReadINIStr $0 "$4\.locution-pro-profile-import.ini" "Migration" "DataRoot"
  ${If} $MigrationResumable != 1
  ${OrIf} $0 != $MigrationDataRoot
    StrCpy $MigrationEligible 0
  ${EndIf}
FunctionEnd

; GetBaseName alone treats a leading-dot filename as an extension.
Function MigrationEntryStem
  Exch $R5
  Push $R6
  ${GetBaseName} "$R5" $R6
  ${If} $R6 == ""
    StrCpy $R6 $R5
  ${EndIf}
  StrCpy $R5 $R6
  Pop $R6
  Exch $R5
FunctionEnd

; $1 is the root filename. Preserve the surrounding FindFirst/FindNext loop registers.
Function CheckOwnedMigrationEntry
  Push $7
  Push $8
  Push $9
  StrCpy $MigrationEntryOwned 0
  ${If} $MigrationResumable != 1
    Goto owned_entry_done
  ${EndIf}
  ClearErrors
  FileOpen $7 "$MigrationDataRoot\.locution-pro-import-owned" r
  ${IfNot} ${Errors}
    FileSeek $7 2 SET
    FileReadUTF16LE $7 $8
    owned_entry_read:
      ClearErrors
      FileReadUTF16LE $7 $8
      ${If} ${Errors}
        FileClose $7
        Goto owned_entry_legacy
      ${EndIf}
      owned_entry_trim:
        StrCpy $9 $8 1 -1
        ${If} $9 == "$\r"
        ${OrIf} $9 == "$\n"
          StrCpy $8 $8 -1
          Goto owned_entry_trim
        ${EndIf}
      ${If} $1 == $8
        FileClose $7
        StrCpy $MigrationEntryOwned 1
        Goto owned_entry_done
      ${EndIf}
      ${If} $MigrationStageStem != ""
        Push $8
        Call MigrationEntryStem
        Pop $9
        ${If} $MigrationStageStem == $9
          FileClose $7
          StrCpy $MigrationEntryOwned 1
          Goto owned_entry_done
        ${EndIf}
      ${EndIf}
      Goto owned_entry_read
  ${EndIf}
  owned_entry_legacy:
    ${If} ${FileExists} "$MigrationDataRoot\.locution-pro-migration-v2"
      ${If} ${FileExists} "$MigrationLegacyRoot\$1"
      ${OrIf} $1 == "preferences.json"
      ${OrIf} $1 == ".locution-pro-migration-v2"
        StrCpy $MigrationEntryOwned 1
      ${EndIf}
      ${If} $1 == "Locution Pro Auto-Save"
      ${AndIf} ${FileExists} "$MigrationLegacyRoot\LineCut Auto-Save"
        StrCpy $MigrationEntryOwned 1
      ${EndIf}
      ${If} $MigrationStageStem != ""
        FindFirst $7 $8 "$MigrationLegacyRoot\*"
        owned_stage_source:
          ${If} $8 == ""
            FindClose $7
            Goto owned_entry_done
          ${EndIf}
          Push $8
          Call MigrationEntryStem
          Pop $9
          ${If} $MigrationStageStem == $9
            FindClose $7
            StrCpy $MigrationEntryOwned 1
            Goto owned_entry_done
          ${EndIf}
          FindNext $7 $8
          Goto owned_stage_source
      ${EndIf}
    ${EndIf}
  owned_entry_done:
    Pop $9
    Pop $8
    Pop $7
FunctionEnd

; Match the exact UUID suffix used by the worker, never an arbitrary wildcard filename.
Function CheckMigrationStageEntry
  Push $7
  Push $8
  Push $9
  StrCpy $MigrationEntryOwned 0
  ${GetFileExt} "$1" $7
  StrLen $8 $7
  ${If} $8 != 46
    Goto stage_entry_done
  ${EndIf}
  StrCpy $8 $7 10
  ${If} $8 != "migration-"
    Goto stage_entry_done
  ${EndIf}
  StrCpy $7 $7 "" 10
  System::Call '*(i0, i0, i0, i0) p.r8'
  System::Call 'ole32::CLSIDFromString(w "{$7}", p r8) i.r9'
  System::Free $8
  ${If} $9 = 0
    Push $1
    Call MigrationEntryStem
    Pop $MigrationStageStem
    ${If} $MigrationStageStem == ".locution-pro-import-owned"
      StrCpy $MigrationEntryOwned 1
    ${Else}
      Call CheckOwnedMigrationEntry
    ${EndIf}
    StrCpy $MigrationStageStem ""
  ${EndIf}
  stage_entry_done:
    Pop $9
    Pop $8
    Pop $7
FunctionEnd

; An empty directory or just an old executable is not user data.
Function CheckLegacyDataDirectory
  FindFirst $0 $1 "$4\*"
  legacy_data_next:
    ${If} $1 == ""
      Goto legacy_data_done
    ${EndIf}
    ${GetFileExt} "$1" $2
    ${If} $1 != "."
    ${AndIf} $1 != ".."
    ${AndIf} $1 != "cache-version"
    ${AndIf} $1 != "installer-media-paths.ini"
    ${AndIf} $1 != "transnetv2"
    ${AndIf} $1 != "semantic-search"
    ${AndIf} $1 != "storyboard-semantic"
    ${AndIf} $1 != "licenses"
    ${AndIf} $1 != "LICENSE"
    ${AndIf} $1 != "THIRD_PARTY_NOTICES.md"
    ${AndIf} $2 != "exe"
    ${AndIf} $2 != "dll"
      StrCpy $MigrationHasSource 1
      Goto legacy_data_done
    ${EndIf}
    FindNext $0 $1
    Goto legacy_data_next
  legacy_data_done:
    FindClose $0
FunctionEnd

!macro MigrationArtifactEntry NAME
  ${If} $1 == "${NAME}"
    Goto pending_data_next
  ${EndIf}
!macroend

; A journal proves which settings/workspace files belong to the unfinished import.
Function CheckPendingDataDirectory
  ${IfNot} ${FileExists} "$4"
    Return
  ${EndIf}
  ${If} $MigrationRetry != 1
    StrCpy $MigrationEligible 0
    Return
  ${EndIf}
  Push $4
  Call NormalizeInstallPath
  Pop $5
  Push $MigrationPendingInstallDir
  Call NormalizeInstallPath
  Pop $6
  StrCpy $MigrationDirectoryIsInstallerOnly 1
  FindFirst $0 $1 "$4\*"
  pending_data_loop:
    ${If} $1 == ""
      Goto pending_data_done
    ${EndIf}
    !insertmacro MigrationArtifactEntry "."
    !insertmacro MigrationArtifactEntry ".."
    !insertmacro MigrationArtifactEntry ".locution-pro-install-session"
    !insertmacro MigrationArtifactEntry "installer-media-paths.ini"
    !insertmacro MigrationArtifactEntry ".locution-pro-import-owned"
    ; An interrupted import may have verified cache copies, but never app-created state.
    !insertmacro MigrationArtifactEntry "cache"
    ${If} $MigrationPendingInstallDir != ""
    ${AndIf} $5 == $6
      !insertmacro MigrationArtifactEntry "${MAINBINARYNAME}.exe"
      !insertmacro MigrationArtifactEntry "uninstall.exe"
      !insertmacro MigrationArtifactEntry "ffmpeg.exe"
      !insertmacro MigrationArtifactEntry "ffprobe.exe"
      !insertmacro MigrationArtifactEntry "locution_pro_thumbnail_provider.dll"
      !insertmacro MigrationArtifactEntry "transnetv2"
      !insertmacro MigrationArtifactEntry "semantic-search"
      !insertmacro MigrationArtifactEntry "storyboard-semantic"
      !insertmacro MigrationArtifactEntry "licenses"
      !insertmacro MigrationArtifactEntry "LICENSE"
      !insertmacro MigrationArtifactEntry "THIRD_PARTY_NOTICES.md"
    ${EndIf}
    ${If} $1 != "cache-version"
    ${AndIf} $1 != ".locution-pro-import-complete"
      Call CheckOwnedMigrationEntry
      ${If} $MigrationEntryOwned = 1
        Goto pending_data_next
      ${EndIf}
      ; A killed worker may leave a UUID staging file before its ownership journal commits.
      Call CheckMigrationStageEntry
      ${If} $MigrationEntryOwned = 1
        Goto pending_data_next
      ${EndIf}
    ${EndIf}
    StrCpy $MigrationDirectoryIsInstallerOnly 0
    Goto pending_data_done
  pending_data_next:
    FindNext $0 $1
    Goto pending_data_loop
  pending_data_done:
    FindClose $0
    ${If} $MigrationDirectoryIsInstallerOnly != 1
      StrCpy $MigrationEligible 0
    ${EndIf}
FunctionEnd

; These registry values are installer state, not a migration admission token.
Function RecordPendingMigration
  Call CheckMigrationAllowed
  ${If} $MigrationAllowed = 1
    ClearErrors
    WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "MigrationPending" 1
    WriteRegStr SHCTX "${MANUPRODUCTKEY}" "MigrationDataRoot" "$MigrationDataRoot"
    ${If} ${Errors}
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function PrepareMigrationInstall
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Push $INSTDIR
    Call NormalizeInstallPath
    Pop $0
    Push $MigrationPendingInstallDir
    Call NormalizeInstallPath
    Pop $1
    ${If} $MigrationRetry != 1
    ${OrIf} $0 != $1
      StrCpy $MigrationEligible 0
    ${EndIf}
  ${EndIf}
  Call RecordPendingMigration
  Call CheckMigrationAllowed
  ${If} $MigrationAllowed = 1
    ClearErrors
    WriteRegStr SHCTX "${MANUPRODUCTKEY}" "MigrationInstallDir" "$INSTDIR"
    ${If} ${Errors}
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; Write admission only immediately before launching the migration worker.
Function BeginMigrationSession
  InitPluginsDir
  CreateDirectory "$MigrationDataRoot"
  ClearErrors
  FileOpen $0 "$MigrationDataRoot\.locution-pro-install-session" w
  ${If} ${Errors}
    Goto migration_session_failed
  ${EndIf}
  FileWriteUTF16LE /BOM $0 "$PLUGINSDIR"
  ${If} ${Errors}
    FileClose $0
    Goto migration_session_failed
  ${EndIf}
  FileClose $0
  ${If} ${Errors}
    Goto migration_session_failed
  ${EndIf}
  ClearErrors
  FileOpen $0 "$MigrationDataRoot\.locution-pro-install-session" r
  ${If} ${Errors}
    Goto migration_session_failed
  ${EndIf}
  FileSeek $0 2 SET
  FileReadUTF16LE $0 $1
  ${If} ${Errors}
    FileClose $0
    Goto migration_session_failed
  ${EndIf}
  FileClose $0
  ${If} $1 != $PLUGINSDIR
    Goto migration_session_failed
  ${EndIf}
  Return
  migration_session_failed:
    StrCpy $MigrationState "error"
    StrCpy $MigrationError "无法写入或校验迁移会话，请检查目录权限后重试。"
FunctionEnd

Function CheckMigrationAllowed
  StrCpy $MigrationAllowed $MigrationEligible
  ; Do not mistake an elevated administrator profile for every machine-wide user.
  !if "${INSTALLMODE}" == "perMachine"
    StrCpy $MigrationAllowed 0
  !else if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      StrCpy $MigrationAllowed 0
    ${EndIf}
  !endif
FunctionEnd

Function CloseMigrationJob
  ${If} $MigrationJob != 0
  ${AndIf} $MigrationJob != ""
    System::Call 'kernel32::CloseHandle(p $MigrationJob)'
    StrCpy $MigrationJob 0
  ${EndIf}
FunctionEnd

Function ClearPendingMigration
  DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "MigrationPending"
  DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "MigrationDataRoot"
  DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "MigrationInstallDir"
FunctionEnd

Function .onGUIEnd
  ; Also covers error paths that exit without going through the custom page.
  Call CloseMigrationJob
FunctionEnd

Function StartMigration
  InitPluginsDir
  StrCpy $MigrationProgressFile "$PLUGINSDIR\migration-progress.ini"
  StrCpy $MigrationCancelFile "$PLUGINSDIR\migration.cancel"
  Delete "$MigrationProgressFile"
  Delete "$MigrationCancelFile"
  StrCpy $MigrationProcess 0
  StrCpy $MigrationJob 0
  StrCpy $MigrationComplete 0
  StrCpy $MigrationCancelRequested 0
  StrCpy $MigrationTimedOut 0
  StrCpy $MigrationQuitRequested 0
  StrCpy $MigrationState "running"
  StrCpy $MigrationError ""
  Call BeginMigrationSession
  ${If} $MigrationState == "error"
    Return
  ${EndIf}
  ; Only this installer owns the non-inheritable job handle. Closing it kills the worker.
  System::Call 'kernel32::CreateJobObjectW(p0, p0) p.r0'
  StrCpy $MigrationJob $0
  ${If} $MigrationJob = 0
    Goto migration_start_failed
  ${EndIf}
  ; The NSIS host is 32-bit: extended job limits are 112 bytes, LimitFlags is at offset 16.
  System::Call 'kernel32::GlobalAlloc(i0x40, p112) p.r6'
  ${If} $6 = 0
    Goto migration_start_failed
  ${EndIf}
  IntOp $7 $6 + 16
  System::Call '*$7(i0x2000)' ; JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  System::Call 'kernel32::SetInformationJobObject(p $MigrationJob, i9, p r6, i112) i.r3'
  System::Call 'kernel32::GlobalFree(p r6)'
  ${If} $3 = 0
    Goto migration_start_failed
  ${EndIf}
  StrCpy $0 '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --migrate-legacy-data --migration-session $\"$PLUGINSDIR$\" --migration-silent --migration-progress $\"$MigrationProgressFile$\" --migration-cancel $\"$MigrationCancelFile$\"'
  ; STARTUPINFOW = 68 bytes; PROCESS_INFORMATION = 16 bytes in the 32-bit installer.
  System::Call '*(i68, p0, p0, p0, i0, i0, i0, i0, i0, i0, i0, i0, &i2 0, &i2 0, p0, p0, p0, p0) p.r1'
  System::Call '*(p0, p0, i0, i0) p.r2'
  ; CREATE_NO_WINDOW | CREATE_SUSPENDED: no migration code can run before job assignment.
  System::Call 'kernel32::CreateProcessW(p0, w r0, p0, p0, i0, i0x08000004, p0, w "$INSTDIR", p r1, p r2) i.r3'
  ${If} $3 != 0
    System::Call '*$2(p.r4, p.r5)'
    StrCpy $MigrationProcess $4
    System::Call 'kernel32::AssignProcessToJobObject(p $MigrationJob, p r4) i.r3'
    ${If} $3 != 0
      System::Call 'kernel32::ResumeThread(p r5) i.r3'
      ${If} $3 = -1
        StrCpy $3 0
      ${Else}
        StrCpy $3 1
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r5)'
  ${EndIf}
  System::Free $1
  System::Free $2
  ${If} $3 = 0
    ${If} $MigrationProcess != 0
      System::Call 'kernel32::TerminateProcess(p $MigrationProcess, i2)'
      System::Call 'kernel32::CloseHandle(p $MigrationProcess)'
      StrCpy $MigrationProcess 0
    ${EndIf}
    Goto migration_start_failed
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $MigrationStarted $0
  Return
  migration_start_failed:
    Call CloseMigrationJob
    StrCpy $MigrationState "error"
    StrCpy $MigrationError "无法启动受安装器管理的迁移进程，请检查权限后重试。"
FunctionEnd

Function ForceStopMigration
  System::Call 'kernel32::TerminateProcess(p $MigrationProcess, i2)'
  Call CloseMigrationJob
  ; Never wait indefinitely for pending I/O cancellation during process termination.
  System::Call 'kernel32::WaitForSingleObject(p $MigrationProcess, i1000)'
  System::Call 'kernel32::CloseHandle(p $MigrationProcess)'
  StrCpy $MigrationProcess 0
  StrCpy $MigrationComplete 0
  StrCpy $MigrationState "cancelled"
  StrCpy $MigrationError "迁移进程取消后仍未响应，已强制终止。原数据仍保留，可重试。"
  ${If} $MigrationTimedOut = 1
    StrCpy $MigrationState "error"
    StrCpy $MigrationError "静默迁移超过时限，已强制终止。原数据仍保留。"
  ${EndIf}
FunctionEnd

Function PollMigrationProcess
  ${If} $MigrationProcess = 0
    Return
  ${EndIf}
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    System::Call 'kernel32::GetTickCount() i.r0'
    IntOp $0 $0 - $MigrationStarted
    ${If} $0 >= ${LOCUTION_MIGRATION_SILENT_TIMEOUT_MS}
    ${AndIf} $MigrationCancelRequested = 0
      StrCpy $MigrationTimedOut 1
      Call CancelMigration
    ${EndIf}
  ${EndIf}
  ${If} $MigrationCancelRequested = 1
    System::Call 'kernel32::GetTickCount() i.r0'
    IntOp $0 $0 - $MigrationCancelStarted
    ${If} $0 >= ${LOCUTION_MIGRATION_CANCEL_GRACE_MS}
      Call ForceStopMigration
      ${If} $MigrationQuitRequested = 1
        SetErrorLevel 2
        Quit
      ${EndIf}
      Return
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetExitCodeProcess(p $MigrationProcess, *i.r0) i.r1'
  ${If} $1 != 0
  ${AndIf} $0 = 259
    Return
  ${EndIf}
  ; A terminal snapshot alone is insufficient: the worker must also exit successfully.
  System::Call 'kernel32::CloseHandle(p $MigrationProcess)'
  StrCpy $MigrationProcess 0
  Call CloseMigrationJob
  ReadINIStr $MigrationState "$MigrationProgressFile" "Migration" "State"
  ReadINIStr $MigrationError "$MigrationProgressFile" "Migration" "Error"
  ${If} $1 != 0
  ${AndIf} $0 = 0
  ${AndIf} $MigrationState == "complete"
  ${AndIf} $MigrationCancelRequested != 1
    StrCpy $MigrationComplete 1
    SetErrorLevel 0
    Call ClearPendingMigration
  ${Else}
    ${If} $MigrationError == ""
      StrCpy $MigrationError "数据迁移未完成（退出码 $0）。原数据仍保留，请重试。"
    ${EndIf}
    ${If} $MigrationState != "cancelled"
      StrCpy $MigrationState "error"
    ${EndIf}
  ${EndIf}
  ${If} $MigrationTimedOut = 1
    StrCpy $MigrationState "error"
    StrCpy $MigrationError "静默迁移超过时限。原数据仍保留。"
  ${ElseIf} $MigrationCancelRequested = 1
    StrCpy $MigrationState "cancelled"
    StrCpy $MigrationError "迁移已取消。原数据仍保留，可重试。"
  ${EndIf}
  ${If} $MigrationQuitRequested = 1
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function CancelMigration
  ${If} $MigrationProcess != 0
  ${AndIf} $MigrationCancelRequested != 1
    StrCpy $MigrationCancelRequested 1
    System::Call 'kernel32::GetTickCount() i.r0'
    StrCpy $MigrationCancelStarted $0
    FileOpen $0 "$MigrationCancelFile" w
    FileWrite $0 "cancel"
    FileClose $0
  ${EndIf}
FunctionEnd

Function MigrationUserAbort
  ${If} $MigrationProcess != 0
  ${AndIf} $MigrationProcess != ""
    StrCpy $MigrationQuitRequested 1
    Call CancelMigration
    Abort
  ${EndIf}
FunctionEnd

Function ReportBlockedMigration
  StrCpy $MigrationComplete 0
  StrCpy $MigrationState "error"
  StrCpy $MigrationError "上次迁移尚未完成，当前数据无法安全续传。现有数据和记录均已保留，可检查后重试，或跳过迁移完成安装。"
  DetailPrint "$MigrationError"
  SetErrorLevel 2
FunctionEnd

; Silent/passive installs have no custom page. They use the same worker and completion checks.
Function MigrateLegacyData
  Call CheckMigrationAllowed
  ${If} $MigrationAllowed = 0
    ${If} $MigrationPendingBlocked = 1
      Call ReportBlockedMigration
      Return
    ${EndIf}
    StrCpy $MigrationComplete 1
    Call ClearPendingMigration
    DetailPrint "跳过旧数据迁移：仅首次当前用户安装且存在 LineCut 数据时执行。"
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
    ${If} $MigrationPendingBlocked = 1
      Call ReportBlockedMigration
    ${Else}
      StrCpy $MigrationComplete 1
      Call ClearPendingMigration
      Abort
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  StrCpy $MigrationProgressFile "$PLUGINSDIR\migration-progress.ini"
  !insertmacro MUI_HEADER_TEXT "迁移旧数据" "复制 LineCut 设置、缓存和浏览器数据并校验完整性，原始数据保留。"
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
  ${NSD_CreateButton} 82u 138u -82u 16u "跳过迁移并完成安装"
  Pop $MigrationSkipButton
  ${NSD_OnClick} $MigrationSkipButton MigrationSkip
  EnableWindow $MigrationSkipButton 0
  GetDlgItem $MigrationNextButton $HWNDPARENT 1
  EnableWindow $MigrationNextButton 0
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  ${If} $MigrationPendingBlocked != 1
    Call StartMigration
    SendMessage $MigrationBar ${PBM_SETMARQUEE} 1 40
  ${EndIf}
  ${NSD_CreateTimer} MigrationPoll 100
  nsDialogs::Show
  ${NSD_KillTimer} MigrationPoll
FunctionEnd

Function MigrationPageLeave
  ${If} $MigrationComplete != 1
  ${AndIf} $MigrationSkipped != 1
    Abort
  ${EndIf}
FunctionEnd

Function MigrationAction
  Pop $0
  ${If} $MigrationSkipped = 1
    Return
  ${EndIf}
  ${If} $MigrationProcess != 0
    Call CancelMigration
    ${NSD_SetText} $MigrationPhaseLabel "正在停止迁移，请稍候…"
    EnableWindow $MigrationActionButton 0
  ${Else}
    ${If} $MigrationPendingBlocked = 1
      Call CaptureMigrationEligibility
      Call CheckMigrationAllowed
      ${If} $MigrationAllowed = 0
        Call ReportBlockedMigration
        Return
      ${EndIf}
    ${EndIf}
    EnableWindow $MigrationSkipButton 0
    ${NSD_SetText} $MigrationErrorLabel ""
    ${NSD_SetText} $MigrationPhaseLabel "正在准备数据迁移…"
    ${NSD_SetText} $MigrationActionButton "取消迁移"
    Call StartMigration
    SendMessage $MigrationBar ${PBM_SETMARQUEE} 1 40
  ${EndIf}
FunctionEnd

Function MigrationSkip
  Pop $0
  ${If} $MigrationProcess != 0
  ${OrIf} $MigrationComplete = 1
  ${OrIf} $MigrationSkipped = 1
    Return
  ${EndIf}
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "是否跳过剩余数据迁移并完成安装？$\r$\n$\r$\nLineCut 原始数据和已复制的副本都会保留。剩余数据不会继续导入，后续安装也不会自动续传。" IDYES migration_skip_confirmed
  Return
  migration_skip_confirmed:
    Call FinishWithoutMigration
FunctionEnd

Function FinishWithoutMigration
  ${If} $MigrationProcess != 0
  ${OrIf} $MigrationComplete = 1
  ${OrIf} $MigrationSkipped = 1
    Return
  ${EndIf}
  ; Store an explicit opt-out, never a migration-complete marker or a successful copy state.
  ClearErrors
  WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "MigrationSkipped" 1
  ${If} ${Errors}
    StrCpy $MigrationError "无法保存跳过迁移的选择，请检查权限后重试。"
    Return
  ${EndIf}
  ReadRegDWORD $0 SHCTX "${MANUPRODUCTKEY}" "MigrationSkipped"
  ${If} ${Errors}
  ${OrIf} $0 != 1
    StrCpy $MigrationError "无法校验跳过迁移的选择，请检查权限后重试。"
    Return
  ${EndIf}
  Call ClearPendingMigration
  StrCpy $MigrationSkipped 1
  StrCpy $MigrationState "skipped"
  StrCpy $MigrationPendingBlocked 0
  DetailPrint "已按用户选择跳过剩余迁移，原始数据和已复制的副本保留。"
  SetErrorLevel 0
  ${NSD_KillTimer} MigrationPoll
  EnableWindow $MigrationActionButton 0
  EnableWindow $MigrationSkipButton 0
  SendMessage $MigrationBar ${PBM_SETMARQUEE} 0 0
  ${NSD_SetText} $MigrationPhaseLabel "已跳过迁移，正在完成安装…"
  ${NSD_SetText} $MigrationErrorLabel ""
  EnableWindow $MigrationNextButton 1
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p1, p0)'
FunctionEnd

Function MigrationPoll
  ${If} $MigrationSkipped = 1
    Return
  ${EndIf}
  Call PollMigrationProcess
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Phase"
  ${If} $MigrationCancelRequested = 1
  ${AndIf} $MigrationProcess != 0
    ${NSD_SetText} $MigrationPhaseLabel "正在停止迁移，最多等待 15 秒…"
  ${ElseIf} $MigrationProcess = 0
  ${AndIf} $MigrationComplete != 1
    ${If} $MigrationState == "cancelled"
      ${NSD_SetText} $MigrationPhaseLabel "迁移已取消"
    ${Else}
      ${NSD_SetText} $MigrationPhaseLabel "迁移未完成"
    ${EndIf}
  ${ElseIf} $0 != ""
    ${NSD_SetText} $MigrationPhaseLabel "$0"
  ${EndIf}
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Copied"
  ${NSD_SetText} $MigrationCopiedLabel "已复制：$0"
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "Verified"
  ${NSD_SetText} $MigrationVerifiedLabel "已校验：$0"
  ReadINIStr $0 "$MigrationProgressFile" "Migration" "File"
  ${NSD_SetText} $MigrationFileLabel "$0"
  ${If} $MigrationProcess != 0
    EnableWindow $MigrationSkipButton 0
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
    EnableWindow $MigrationSkipButton 1
  ${EndIf}
FunctionEnd
