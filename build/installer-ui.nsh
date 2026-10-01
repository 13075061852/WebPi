!include "nsDialogs.nsh"
Var PiHaloStatus
Var PiHaloLogo
Var PiHaloBrand
Var PiHaloFont
Var PiHaloBrandFont
Var PiHaloTextFont
Var PiHaloWidth
Var PiHaloHeight
Var PiHaloDpi
Var PiHaloPage
Var PiHaloModule
Var PiHaloAttach
Var PiHaloRefresh
Var PiHaloStyleDirectory
Var PiHaloLaunchPending

!macro PiHaloMove CONTROL X Y W H
  System::Call 'user32::MoveWindow(p ${CONTROL}, i ${X}, i ${Y}, i ${W}, i ${H}, i 1)'
!macroend

!macro PiHaloExtractUi
  InitPluginsDir
  ; GUI initialization precedes the section's $OUTDIR setup. Always extract
  ; into NSIS's private directory, including readonly launch directories.
  File /oname=$PLUGINSDIR\halo-installer-ui.dll "${BUILD_RESOURCES_DIR}\installer-window.dll"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\halo-installer-ui.dll")p.s'
  Pop $PiHaloModule
  System::Call 'kernel32::GetProcAddress(p $PiHaloModule,m "Attach")p.s'
  Pop $PiHaloAttach
  System::Call 'kernel32::GetProcAddress(p $PiHaloModule,m "Refresh")p.s'
  Pop $PiHaloRefresh
  System::Call 'kernel32::GetProcAddress(p $PiHaloModule,m "StyleDirectory")p.s'
  Pop $PiHaloStyleDirectory
!macroend

; Pixel geometry is scaled from the window's DPI. Keep the stock page handlers
; and navigation buttons as the authority for validation, UAC and cancellation.
!macro PiHaloInstFilesFunctions
Function PiHaloGuiInit
  StrCpy $PiHaloLaunchPending 0
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  StrCpy $PiHaloDpi $0
  ${If} $PiHaloDpi == 0
    StrCpy $PiHaloDpi 96
  ${EndIf}
  IntOp $PiHaloWidth 600 * $PiHaloDpi
  IntOp $PiHaloWidth $PiHaloWidth / 96
  IntOp $PiHaloHeight 440 * $PiHaloDpi
  IntOp $PiHaloHeight $PiHaloHeight / 96
  SetCtlColors $HWNDPARENT "202126" "FFFFFF"
  CreateFont $PiHaloFont "Segoe UI" 44 400
  CreateFont $PiHaloBrandFont "Microsoft YaHei UI" 15 500
  CreateFont $PiHaloTextFont "Microsoft YaHei UI" 9 400
  !insertmacro PiHaloExtractUi
  ${If} $PiHaloAttach == 0
  ${OrIf} $PiHaloRefresh == 0
  ${OrIf} $PiHaloStyleDirectory == 0
    MessageBox MB_OK|MB_ICONSTOP "安装界面初始化失败，请重新下载安装包。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  System::Call '::$PiHaloAttach(p $HWNDPARENT,i $PiHaloDpi)v?c'
FunctionEnd

Function PiHaloLayoutPage
  ; Reserve space for sibling caption/navigation windows so nsDialogs::Show
  ; cannot cover them when it raises the active page.
  IntOp $1 48 * $PiHaloDpi
  IntOp $1 $1 / 96
  IntOp $2 128 * $PiHaloDpi
  IntOp $2 $2 / 96
  IntOp $2 $PiHaloHeight - $2
  !insertmacro PiHaloMove $PiHaloPage 0 $1 $PiHaloWidth $2
  SetCtlColors $PiHaloPage "202126" "FFFFFF"
  ShowWindow $mui.Header.Text 0
  ShowWindow $mui.Header.SubText 0
  ShowWindow $mui.Header.Image 0
  ShowWindow $mui.Header.Background 0
  ShowWindow $mui.Branding.Background 0
  ShowWindow $mui.Line.Standard 0
  ShowWindow $mui.Line.FullWindow 0
  ShowWindow $mui.Branding.Text 0
  ShowWindow $mui.Button.Back 0
  ShowWindow $mui.Button.Next 0
  ShowWindow $mui.Button.Cancel 0
  IntOp $1 68 * $PiHaloDpi
  IntOp $1 $1 / 96
  IntOp $2 80 * $PiHaloDpi
  IntOp $2 $2 / 96
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "π",i 0x50000101,i 0,i r1,i $PiHaloWidth,i r2,p $PiHaloPage,p 0,p 0,p 0)p.s'
  Pop $PiHaloLogo
  SendMessage $PiHaloLogo ${WM_SETFONT} $PiHaloFont 1
  SetCtlColors $PiHaloLogo "25262C" "FFFFFF"
  IntOp $1 $1 + $2
  IntOp $2 32 * $PiHaloDpi
  IntOp $2 $2 / 96
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "Pi Halo · 星环",i 0x50000101,i 0,i r1,i $PiHaloWidth,i r2,p $PiHaloPage,p 0,p 0,p 0)p.s'
  Pop $PiHaloBrand
  SendMessage $PiHaloBrand ${WM_SETFONT} $PiHaloBrandFont 1
  SetCtlColors $PiHaloBrand "202126" "FFFFFF"
FunctionEnd

Function PiHaloDirectoryShow
  StrCpy $PiHaloPage $mui.DirectoryPage
  Call PiHaloLayoutPage
  ShowWindow $mui.DirectoryPage.Text 0
  ShowWindow $mui.DirectoryPage.DirectoryBox 0
  ShowWindow $mui.DirectoryPage.SpaceRequired 0
  ShowWindow $mui.DirectoryPage.SpaceAvailable 0
  IntOp $1 60 * $PiHaloDpi
  IntOp $1 $1 / 96
  IntOp $2 480 * $PiHaloDpi
  IntOp $2 $2 / 96
  IntOp $3 200 * $PiHaloDpi
  IntOp $3 $3 / 96
  IntOp $4 20 * $PiHaloDpi
  IntOp $4 $4 / 96
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "安装位置",i 0x50000000,i r1,i r3,i r2,i r4,p $PiHaloPage,p 0,p 0,p 0)p.s'
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PiHaloTextFont 1
  SetCtlColors $0 "777982" "FFFFFF"
  IntOp $1 74 * $PiHaloDpi
  IntOp $1 $1 / 96
  IntOp $2 374 * $PiHaloDpi
  IntOp $2 $2 / 96
  IntOp $3 239 * $PiHaloDpi
  IntOp $3 $3 / 96
  !insertmacro PiHaloMove $mui.DirectoryPage.Directory $1 $3 $2 $4
  IntOp $1 460 * $PiHaloDpi
  IntOp $1 $1 / 96
  IntOp $2 72 * $PiHaloDpi
  IntOp $2 $2 / 96
  IntOp $3 229 * $PiHaloDpi
  IntOp $3 $3 / 96
  IntOp $4 40 * $PiHaloDpi
  IntOp $4 $4 / 96
  !insertmacro PiHaloMove $mui.DirectoryPage.BrowseButton $1 $3 $2 $4
  SendMessage $mui.DirectoryPage.Directory ${WM_SETFONT} $PiHaloTextFont 1
  SetCtlColors $mui.DirectoryPage.Directory "202126" "F7F7F8"
  System::Call 'uxtheme::SetWindowTheme(p $mui.DirectoryPage.Directory,w "",w "")'
  System::Call '::$PiHaloStyleDirectory(p $mui.DirectoryPage.Directory,p $mui.DirectoryPage.BrowseButton)v?c'
  SendMessage $mui.DirectoryPage.BrowseButton ${WM_SETTEXT} 0 "STR:浏览"
  SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:安装"
  SendMessage $mui.Button.Back ${WM_SETTEXT} 0 "STR:返回"
  System::Call '::$PiHaloRefresh(i 1)v?c'
FunctionEnd

Function PiHaloInstFilesShow
  System::Call 'kernel32::GetTickCount() i.r0'
  StrCpy $PiHaloStartedAt $0
  SetAutoClose true
  SetDetailsView hide
  !insertmacro PiHaloDetail "安装位置：$INSTDIR"
  StrCpy $PiHaloPage $mui.InstFilesPage
  Call PiHaloLayoutPage
  System::Call '::$PiHaloRefresh(i 2)v?c'
  ShowWindow $mui.InstFilesPage.Text 0
  ShowWindow $mui.InstFilesPage.ShowLogButton 0
  ShowWindow $mui.InstFilesPage.Log 0
  IntOp $1 $PiHaloWidth / 10
  IntOp $2 $PiHaloWidth * 8
  IntOp $2 $2 / 10
  IntOp $3 244 * $PiHaloDpi
  IntOp $3 $3 / 96
  IntOp $4 5 * $PiHaloDpi
  IntOp $4 $4 / 96
  System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar,w "",w "")'
  System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar,i -16)i.r0'
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar,i -16,i r0)'
  System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar,i -20)i.r0'
  IntOp $0 $0 & 0xFFFDFDFF
  System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar,i -20,i r0)'
  SendMessage $mui.InstFilesPage.ProgressBar 0x0409 0 0x00262120
  SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0x00EDEBE8
  !insertmacro PiHaloMove $mui.InstFilesPage.ProgressBar $1 $3 $2 $4
  IntOp $4 24 * $PiHaloDpi
  IntOp $4 $4 / 96
  IntOp $3 $3 + $4
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在安装…",i 0x50000101,i r1,i r3,i r2,i r4,p $PiHaloPage,p 0,p 0,p 0)p.s'
  Pop $PiHaloStatus
  SendMessage $PiHaloStatus ${WM_SETFONT} $PiHaloTextFont 1
  SetCtlColors $PiHaloStatus "777982" "FFFFFF"
FunctionEnd

Function PiHaloInstFilesLeave
  ; Every page keeps the same window dimensions and white surface.
FunctionEnd

Function PiHaloFinishShow
  StrCpy $PiHaloPage $mui.FinishPage
  Call PiHaloLayoutPage
  ShowWindow $mui.FinishPage.Image 0
  ShowWindow $mui.FinishPage.Title 0
  ShowWindow $mui.FinishPage.Text 0
  ShowWindow $mui.Button.Back 0
  SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:完成"
  System::Call '::$PiHaloRefresh(i 3)v?c'
  IntOp $1 $PiHaloWidth / 2
  IntOp $2 280 * $PiHaloDpi
  IntOp $2 $2 / 96
  IntOp $3 $2 / 2
  IntOp $1 $1 - $3
  IntOp $3 216 * $PiHaloDpi
  IntOp $3 $3 / 96
  IntOp $4 28 * $PiHaloDpi
  IntOp $4 $4 / 96
  ; Reboot choices remain visible and usable if required by Windows.
  ${If} ${RebootFlag}
    !insertmacro PiHaloMove $mui.FinishPage.RebootNow $1 $3 $2 $4
    IntOp $3 $3 + $4
    !insertmacro PiHaloMove $mui.FinishPage.RebootLater $1 $3 $2 $4
  ${EndIf}
FunctionEnd

Function PiHaloFinishLeave
  ; The Finish callback runs while the dialog still exists. Only queue launch
  ; here so slow process creation or the shell broker cannot freeze this page.
  !ifndef HIDE_RUN_AFTER_FINISH
    ${IfNot} ${RebootFlag}
      StrCpy $PiHaloLaunchPending 1
      HideWindow
    ${EndIf}
  !endif
FunctionEnd

Function .onGUIEnd
  ; NSIS has already closed the installer window. Clear before launching to
  ; guarantee one launch; Cancel/reboot never queue it. Silent --force-run keeps
  ; the stock install-section path because silent installs have no GUI callback.
  ${If} $PiHaloLaunchPending == 1
    StrCpy $PiHaloLaunchPending 0
    Call PiHaloStartApp
  ${EndIf}
FunctionEnd
!macroend
