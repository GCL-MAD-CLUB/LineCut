!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var LineCutBundleSemantic
Var LineCutSemanticCheckbox

Function LineCutSemanticSelectionChanged
  Pop $0
  ${NSD_GetState} $LineCutSemanticCheckbox $LineCutBundleSemantic
FunctionEnd

Function LineCutSemanticPageCreate
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "选择是否附带语义检索" "选择是否安装字幕与分镜语义检索组件。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "包含字幕语义检索与分镜选帧组件，模型在本机运行。"
  Pop $0
  ${NSD_CreateGroupBox} 0 30u 100% 90u "字幕与分镜语义检索"
  Pop $0
  ${NSD_CreateCheckbox} 12u 48u 88% 12u "附带语义检索组件（默认勾选）"
  Pop $LineCutSemanticCheckbox
  ${NSD_SetState} $LineCutSemanticCheckbox $LineCutBundleSemantic
  ${NSD_OnClick} $LineCutSemanticCheckbox LineCutSemanticSelectionChanged
  ${NSD_CreateLabel} 12u 70u 88% 36u "组件包含语义模型，需要额外磁盘空间。不勾选时，程序的搜索模式中不会出现“语义”选项。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function LineCutSemanticPageLeave
  ${NSD_GetState} $LineCutSemanticCheckbox $LineCutBundleSemantic
FunctionEnd
