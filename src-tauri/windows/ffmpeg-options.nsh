!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var LineCutBundleFfmpeg
Var LineCutFfmpegPath
Var LineCutFfprobePath
Var LineCutBundledRadio
Var LineCutExternalRadio
Var LineCutFfmpegInput

Function LineCutGetFirstLine
  Exch $0
  StrCpy $1 0
linecut_first_line_loop:
  StrCpy $2 $0 1 $1
  StrCmp $2 "" linecut_first_line_done
  StrCmp $2 "$\r" linecut_first_line_done
  StrCmp $2 "$\n" linecut_first_line_done
  IntOp $1 $1 + 1
  Goto linecut_first_line_loop
linecut_first_line_done:
  StrCpy $0 $0 $1
  Exch $0
FunctionEnd

Function LineCutDetectFfmpeg
  StrCpy $LineCutFfmpegPath "ffmpeg"
  nsExec::ExecToStack '"$SYSDIR\where.exe" ffmpeg.exe'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Push $1
    Call LineCutGetFirstLine
    Pop $LineCutFfmpegPath
  ${Else}
    IfFileExists "$PROGRAMFILES\ffmpeg\bin\ffmpeg.exe" 0 +3
      StrCpy $LineCutFfmpegPath "$PROGRAMFILES\ffmpeg\bin\ffmpeg.exe"
      Goto linecut_detect_done
    IfFileExists "$PROGRAMFILES64\ffmpeg\bin\ffmpeg.exe" 0 +3
      StrCpy $LineCutFfmpegPath "$PROGRAMFILES64\ffmpeg\bin\ffmpeg.exe"
      Goto linecut_detect_done
    IfFileExists "$LOCALAPPDATA\ffmpeg\bin\ffmpeg.exe" 0 linecut_detect_done
      StrCpy $LineCutFfmpegPath "$LOCALAPPDATA\ffmpeg\bin\ffmpeg.exe"
  ${EndIf}
linecut_detect_done:
FunctionEnd

Function LineCutUpdateFfmpegControls
  ${NSD_GetState} $LineCutExternalRadio $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $LineCutFfmpegInput 1
    SendMessage $LineCutFfmpegInput ${EM_SETSEL} 0 -1
  ${Else}
    EnableWindow $LineCutFfmpegInput 0
  ${EndIf}
FunctionEnd

Function LineCutFfmpegSelectionChanged
  Pop $0
  Call LineCutUpdateFfmpegControls
FunctionEnd

Function LineCutFfmpegPageCreate
  Call LineCutDetectFfmpeg
  !insertmacro MUI_HEADER_TEXT "选择是否内置 FFmpeg" "选择 LineCut 使用 FFmpeg 的方式。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "请选择 FFmpeg 的安装方式："
  Pop $0
  ${NSD_CreateGroupBox} 0 26u 100% 118u "FFmpeg 设置"
  Pop $0
  ${NSD_CreateRadioButton} 12u 42u 88% 12u "内置 FFmpeg（推荐，默认）"
  Pop $LineCutBundledRadio
  ${NSD_CreateRadioButton} 12u 62u 88% 12u "不内置 FFmpeg，使用电脑中已有的 FFmpeg"
  Pop $LineCutExternalRadio
  ${NSD_CreateLabel} 24u 84u 76% 18u "已从 PATH 环境变量自动查找；你可以修改："
  Pop $0
  ${NSD_CreateText} 24u 104u 76% 12u "$LineCutFfmpegPath"
  Pop $LineCutFfmpegInput
  ${NSD_CreateLabel} 24u 124u 76% 12u "FFprobe 默认使用同目录下的 ffprobe.exe；填写 ffmpeg 时从 PATH 查找。"
  Pop $0

  ${NSD_Check} $LineCutBundledRadio
  ${NSD_OnClick} $LineCutBundledRadio LineCutFfmpegSelectionChanged
  ${NSD_OnClick} $LineCutExternalRadio LineCutFfmpegSelectionChanged
  Call LineCutUpdateFfmpegControls
  nsDialogs::Show
FunctionEnd

Function LineCutFfmpegPageLeave
  ${NSD_GetState} $LineCutBundledRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LineCutBundleFfmpeg 1
    Return
  ${EndIf}

  ${NSD_GetText} $LineCutFfmpegInput $LineCutFfmpegPath
  ${If} $LineCutFfmpegPath == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请输入 FFmpeg 路径，或填写 ffmpeg 以从 PATH 查找。"
    Abort
  ${EndIf}
  StrCpy $LineCutBundleFfmpeg 0

  StrCpy $LineCutFfprobePath "ffprobe"
  StrCpy $0 $LineCutFfmpegPath -10
  StrCmp $0 "" linecut_ffmpeg_page_done
  StrCpy $LineCutFfprobePath "$0ffprobe.exe"
linecut_ffmpeg_page_done:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ${If} $LineCutBundleFfmpeg == 1
    Delete "$LOCALAPPDATA\LineCut\installer-media-paths.ini"
  ${Else}
    CreateDirectory "$LOCALAPPDATA\LineCut"
    FileOpen $0 "$LOCALAPPDATA\LineCut\installer-media-paths.ini" w
    FileWrite $0 "ffmpeg_path=$LineCutFfmpegPath$\r$\n"
    FileWrite $0 "ffprobe_path=$LineCutFfprobePath$\r$\n"
    FileClose $0
  ${EndIf}
!macroend
