; Pi Halo installer UI. Keep electron-builder's own installer.nsi so updater,
; previous-version removal, signed uninstaller and size checks remain enabled.
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "UAC.nsh"

; The stock compiler runs in its template directory. Change only preprocessing
; include resolution; generated files instrument real operations in stock code.
!addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
!cd "${BUILD_RESOURCES_DIR}\generated"

!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "19253D"
!define MUI_INSTFILESPAGE_COLORS "19253D F3F6FB"

; electron-builder already measured the archive at build time. Avoid walking
; every installed dependency again merely to populate Windows' EstimatedSize.
!ifdef APP_64_UNPACKED_SIZE
  !ifndef ESTIMATED_SIZE
    !define ESTIMATED_SIZE ${APP_64_UNPACKED_SIZE}
  !endif
!endif

!macro customHeader
  SetFont "Microsoft YaHei UI" 9
  BrandingText "Pi Halo ${VERSION}  |  安装与更新"
  ShowInstDetails show
  ShowUninstDetails show
  !ifndef BUILD_UNINSTALLER
    ; Builder appends its plugin search paths after loading this include.
    ; Compile functions only after the complete header has been processed.
    !insertmacro PiHaloInstFilesFunctions
    !insertmacro PiHaloLaunchFunctions
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Var PiHaloStartedAt
Var PiHaloLog
Var PiHaloLogPath
Var PiHaloInstallSeconds

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 Pi Halo 的安装位置。$\r$\n$\r$\n接下来会依次检查环境、解压并写入文件、配置快捷方式、验证安装结果。安装期间可查看当前操作和完整阶段记录。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"
!define MUI_FINISHPAGE_TITLE "Pi Halo 已安装完成"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_TEXT "Pi Halo 已准备就绪。$\r$\n安装耗时：$PiHaloInstallSeconds 秒。$\r$\n$\r$\n操作记录已保存至安装目录中的 install.log。"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Pi Halo"
!define MUI_FINISHPAGE_BUTTON "完成"

!macro PiHaloDetail TEXT
  Push $0
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $0 $0 - $PiHaloStartedAt
  IntOp $0 $0 / 1000
  SetDetailsPrint both
  DetailPrint "[$0 秒] ${TEXT}"
  ${If} $PiHaloLog != ""
    FileWriteUTF16LE $PiHaloLog "[$0 秒] ${TEXT}$\r$\n"
  ${EndIf}
  SetDetailsPrint textonly
  Pop $0
!macroend

!macro PiHaloStage TITLE TEXT
  ${IfNot} ${Silent}
    !insertmacro MUI_HEADER_TEXT "${TITLE}" "${TEXT}"
  ${EndIf}
  !insertmacro PiHaloDetail "${TITLE} — ${TEXT}"
!macroend

!macro customInit
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $PiHaloStartedAt $0
  ; Keep a diagnostic log even if installation exits before customInstall.
  StrCpy $PiHaloLogPath "$TEMP\Pi-Halo-${VERSION}-install.log"
  ClearErrors
  FileOpen $PiHaloLog "$PiHaloLogPath" w
  ${If} ${Errors}
    StrCpy $PiHaloLog ""
    ClearErrors
  ${Else}
    FileWriteUTF16LE /BOM $PiHaloLog "Pi Halo ${VERSION} 安装记录$\r$\n"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "安装 Pi Halo"
  !define MUI_PAGE_HEADER_SUBTEXT "下方会实时显示当前阶段、正在处理的内容和操作记录。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloInstFilesShow
!macroend

!macro PiHaloInstFilesFunctions
Function PiHaloInstFilesShow
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $PiHaloStartedAt $0
  SetDetailsView show
  !insertmacro PiHaloDetail "安装位置：$INSTDIR"
FunctionEnd
!macroend

!macro customInstall
  !insertmacro PiHaloStage "9 / 9  验证安装结果" "检查启动程序、应用资源与卸载程序是否就绪。"
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${OrIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
  ${OrIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    !insertmacro PiHaloDetail "安装失败：缺少关键程序文件。请关闭占用文件的程序后重试。"
    ${If} $PiHaloLog != ""
      FileClose $PiHaloLog
      StrCpy $PiHaloLog ""
      CopyFiles /SILENT "$PiHaloLogPath" "$INSTDIR\install.log"
    ${EndIf}
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "安装未完成：关键程序文件缺失。请关闭正在运行的 Pi Halo 后重试。$\r$\n$\r$\n安装记录：$PiHaloLogPath" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $PiHaloInstallSeconds $0 - $PiHaloStartedAt
  IntOp $PiHaloInstallSeconds $PiHaloInstallSeconds / 1000
  !insertmacro PiHaloStage "安装完成" "应用已就绪，实际安装耗时 $PiHaloInstallSeconds 秒。"
  ${If} $PiHaloLog != ""
    FileClose $PiHaloLog
    StrCpy $PiHaloLog ""
    CopyFiles /SILENT "$PiHaloLogPath" "$INSTDIR\install.log"
    ClearErrors
  ${EndIf}
!macroend

; CreateProcess returns as soon as the app is created. It does not wait for
; Electron or depend on Explorer resolving a shortcut through shell COM.
!macro PiHaloLaunchFunctions
Function PiHaloExecApp
  ClearErrors
  Exec '"$INSTDIR\${PRODUCT_FILENAME}.exe" $1'
  ${If} ${Errors}
    StrCpy $0 "error"
  ${Else}
    StrCpy $0 "ok"
  ${EndIf}
FunctionEnd

Function PiHaloStartApp
  ${If} ${isUpdated}
    StrCpy $1 "--updated"
  ${Else}
    StrCpy $1 ""
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    ; Use the existing unelevated outer installer, preserving the user's token.
    !insertmacro UAC_AsUser_Call Function PiHaloExecApp ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}|${UAC_SYNCOUTDIR}
  ${ElseIfNot} ${UAC_IsAdmin}
    Call PiHaloExecApp
  ${Else}
    ; Explicit "Run as administrator" has no unelevated parent. Keep the
    ; stock secure shell broker for this exceptional path, never launch the app
    ; with administrator privileges merely to avoid a shell delay.
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${PRODUCT_FILENAME}.exe" "open" "$1"
  ${EndIf}
  ${If} $0 == "error"
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装已完成，但暂时无法启动 Pi Halo。请使用桌面或开始菜单中的快捷方式打开。" /SD IDOK
  ${EndIf}
FunctionEnd
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "PiHaloStartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif
