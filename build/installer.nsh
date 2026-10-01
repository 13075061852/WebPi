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
!define MUI_TEXTCOLOR "202126"
!define MUI_INSTFILESPAGE_COLORS "202126 FFFFFF"

; electron-builder already measured the archive at build time. Avoid walking
; every installed dependency again merely to populate Windows' EstimatedSize.
!ifdef APP_64_UNPACKED_SIZE
  !ifndef ESTIMATED_SIZE
    !define ESTIMATED_SIZE ${APP_64_UNPACKED_SIZE}
  !endif
!endif

!macro customHeader
  SetFont "Microsoft YaHei UI" 9
  BrandingText "Pi Halo ${VERSION}"
  ShowInstDetails nevershow
  ShowUninstDetails show
  !ifndef BUILD_UNINSTALLER
    ; Builder appends its plugin search paths after loading this include.
    ; Compile functions only after the complete header has been processed.
    !insertmacro PiHaloInstFilesFunctions
    !insertmacro PiHaloLaunchFunctions
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT PiHaloGuiInit
Var PiHaloStartedAt
Var PiHaloLog
Var PiHaloLogPath
Var PiHaloInstallSeconds

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"
!define MUI_FINISHPAGE_TITLE "Pi Halo 已安装完成"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_TEXT "一切就绪。"
!define MUI_FINISHPAGE_BUTTON "完成"

!ifndef INSTALL_MODE_PER_ALL_USERS
!macro customInstallMode
  ; Skip the scope page before it creates its controls. Fresh/manual installs
  ; use the current user; updates keep an existing per-machine installation.
  ${If} ${isUpdated}
  ${AndIf} $installMode == "all"
    StrCpy $isForceMachineInstall "1"
  ${Else}
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend
!endif

!macro PiHaloDetail TEXT
  Push $0
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $0 $0 - $PiHaloStartedAt
  IntOp $0 $0 / 1000
  SetDetailsPrint listonly
  DetailPrint "[$0 秒] ${TEXT}"
  ${If} $PiHaloLog != ""
    FileWriteUTF16LE $PiHaloLog "[$0 秒] ${TEXT}$\r$\n"
  ${EndIf}
  SetDetailsPrint none
  Pop $0
!macroend

!macro PiHaloStage TITLE TEXT
  ${IfNot} ${Silent}
    SendMessage $PiHaloStatus ${WM_SETTEXT} 0 "STR:${TITLE}"
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
  !define MUI_PAGE_HEADER_SUBTEXT "正在准备安装"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloInstFilesShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE PiHaloInstFilesLeave
!macroend

!include "${BUILD_RESOURCES_DIR}\installer-ui.nsh"

!macro customInstall
  !insertmacro PiHaloStage "即将完成" "检查启动程序、应用资源与卸载程序是否就绪。"
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
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE PiHaloFinishLeave
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif
