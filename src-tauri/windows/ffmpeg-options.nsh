!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "${__FILEDIR__}\semantic-options.nsh"

Var LocutionProBundleFfmpeg
Var LocutionProFfmpegPath
Var LocutionProFfprobePath
Var LocutionProBundledRadio
Var LocutionProExternalRadio
Var LocutionProFfmpegInput

Function LocutionProGetFirstLine
  Exch $0
  StrCpy $1 0
locution_pro_first_line_loop:
  StrCpy $2 $0 1 $1
  StrCmp $2 "" locution_pro_first_line_done
  StrCmp $2 "$\r" locution_pro_first_line_done
  StrCmp $2 "$\n" locution_pro_first_line_done
  IntOp $1 $1 + 1
  Goto locution_pro_first_line_loop
locution_pro_first_line_done:
  StrCpy $0 $0 $1
  Exch $0
FunctionEnd

Function LocutionProDetectFfmpeg
  StrCpy $LocutionProFfmpegPath "ffmpeg"
  nsExec::ExecToStack '"$SYSDIR\where.exe" ffmpeg.exe'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Push $1
    Call LocutionProGetFirstLine
    Pop $LocutionProFfmpegPath
  ${Else}
    IfFileExists "$PROGRAMFILES\ffmpeg\bin\ffmpeg.exe" 0 +3
      StrCpy $LocutionProFfmpegPath "$PROGRAMFILES\ffmpeg\bin\ffmpeg.exe"
      Goto locution_pro_detect_done
    IfFileExists "$PROGRAMFILES64\ffmpeg\bin\ffmpeg.exe" 0 +3
      StrCpy $LocutionProFfmpegPath "$PROGRAMFILES64\ffmpeg\bin\ffmpeg.exe"
      Goto locution_pro_detect_done
    IfFileExists "$LOCALAPPDATA\ffmpeg\bin\ffmpeg.exe" 0 locution_pro_detect_done
      StrCpy $LocutionProFfmpegPath "$LOCALAPPDATA\ffmpeg\bin\ffmpeg.exe"
  ${EndIf}
locution_pro_detect_done:
FunctionEnd

Function LocutionProUpdateFfmpegControls
  ${NSD_GetState} $LocutionProExternalRadio $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $LocutionProFfmpegInput 1
    SendMessage $LocutionProFfmpegInput ${EM_SETSEL} 0 -1
  ${Else}
    EnableWindow $LocutionProFfmpegInput 0
  ${EndIf}
FunctionEnd

Function LocutionProFfmpegSelectionChanged
  Pop $0
  Call LocutionProUpdateFfmpegControls
FunctionEnd

Function LocutionProFfmpegPageCreate
  Call LocutionProDetectFfmpeg
  !insertmacro MUI_HEADER_TEXT "选择是否内置 FFmpeg" "选择 Locution Pro 使用 FFmpeg 的方式。"
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
  Pop $LocutionProBundledRadio
  ${NSD_CreateRadioButton} 12u 62u 88% 12u "不内置 FFmpeg，使用电脑中已有的 FFmpeg"
  Pop $LocutionProExternalRadio
  ${NSD_CreateLabel} 24u 84u 76% 18u "已从 PATH 环境变量自动查找；你可以修改："
  Pop $0
  ${NSD_CreateText} 24u 104u 76% 12u "$LocutionProFfmpegPath"
  Pop $LocutionProFfmpegInput
  ${NSD_CreateLabel} 24u 124u 76% 12u "FFprobe 默认使用同目录下的 ffprobe.exe；填写 ffmpeg 时从 PATH 查找。"
  Pop $0

  ${NSD_Check} $LocutionProBundledRadio
  ${NSD_OnClick} $LocutionProBundledRadio LocutionProFfmpegSelectionChanged
  ${NSD_OnClick} $LocutionProExternalRadio LocutionProFfmpegSelectionChanged
  Call LocutionProUpdateFfmpegControls
  nsDialogs::Show
FunctionEnd

Function LocutionProFfmpegPageLeave
  ${NSD_GetState} $LocutionProBundledRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LocutionProBundleFfmpeg 1
    Return
  ${EndIf}

  ${NSD_GetText} $LocutionProFfmpegInput $LocutionProFfmpegPath
  ${If} $LocutionProFfmpegPath == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "请输入 FFmpeg 路径，或填写 ffmpeg 以从 PATH 查找。"
    Abort
  ${EndIf}
  StrCpy $LocutionProBundleFfmpeg 0

  StrCpy $LocutionProFfprobePath "ffprobe"
  StrCpy $0 $LocutionProFfmpegPath -10
  StrCmp $0 "" locution_pro_ffmpeg_page_done
  StrCpy $LocutionProFfprobePath "$0ffprobe.exe"
locution_pro_ffmpeg_page_done:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; An empty current file records the bundled choice and prevents migration
  ; from restoring the previous installer's external-tool selection.
  CreateDirectory "$LOCALAPPDATA\Locution Pro"
  FileOpen $0 "$LOCALAPPDATA\Locution Pro\installer-media-paths.ini" w
  ${If} $LocutionProBundleFfmpeg != 1
    FileWrite $0 "ffmpeg_path=$LocutionProFfmpegPath$\r$\n"
    FileWrite $0 "ffprobe_path=$LocutionProFfprobePath$\r$\n"
  ${EndIf}
  FileClose $0
!macroend
