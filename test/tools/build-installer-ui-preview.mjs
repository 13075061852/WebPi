/** Build a UI fixture that never installs or launches Pi Halo. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nsisIndex = process.argv.indexOf('--nsis');
const compilerArgument = nsisIndex >= 0 ? process.argv[nsisIndex + 1] : null;
assert.equal(process.platform, 'win32', 'The NSIS UI preview is a Windows fixture.');
assert.ok(compilerArgument, 'Pass --nsis <makensis.exe>.');
const compiler = path.resolve(compilerArgument);
assert.ok(fs.statSync(compiler).isFile(), `NSIS compiler missing: ${compiler}`);
const delayIndex = process.argv.indexOf('--launch-delay-ms');
const delayArgument = delayIndex >= 0 ? process.argv[delayIndex + 1] : '0';
assert.ok(/^\d+$/.test(delayArgument ?? ''), '--launch-delay-ms must be an integer.');
const launchDelayMs = Number(delayArgument);
assert.ok(launchDelayMs <= 10000, '--launch-delay-ms must be between 0 and 10000.');
const finishOnly = process.argv.includes('--finish-only');
const hideRun = process.argv.includes('--hide-run');
const rebootRequired = process.argv.includes('--reboot-required');

// Only this dedicated fixture directory receives persistent files. The chosen
// installation path is displayed and validated by MUI, but is never written.
const fixtureId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const directory = path.join(root, 'tmp', 'installer-ui-preview', fixtureId);
fs.mkdirSync(directory, { recursive: true });
const sourcePath = path.join(directory, 'preview.nsi');
const executable = path.join(directory, 'preview.exe');
// A fresh marker name makes Cancel-before-Finish checks independent of earlier
// completed previews, without deleting any previous diagnostic evidence.
const marker = path.join(directory, `launched-${fixtureId}.txt`);
const startedMarker = path.join(directory, `launch-started-${fixtureId}.txt`);
const metadataPath = path.join(directory, 'metadata.json');
const resources = path.join(root, 'build');
const escapeNsis = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const source = String.raw`Unicode true
Name "Pi Halo 界面预览（不会安装）"
OutFile "${escapeNsis(executable)}"
RequestExecutionLevel user
InstallDir "$TEMP\Pi-Halo-Preview"
ShowInstDetails nevershow
BrandingText " "
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "202126"
!define MUI_INSTFILESPAGE_COLORS "202126 FFFFFF"
!define MUI_CUSTOMFUNCTION_GUIINIT PiHaloGuiInit
; This fixture must never reboot Windows, even when testing the reboot guard.
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
Var mui.FinishPage.RebootNow
Var mui.FinishPage.RebootLater
${hideRun ? '!define HIDE_RUN_AFTER_FINISH' : ''}
; Suppress the obsolete scope-page function and its MultiUser dependencies.
!define INSTALL_MODE_PER_ALL_USERS
Var PiHaloStartedAt
Var PreviewCounter
Var PreviewLaunchCount
!macro PiHaloDetail TEXT
!macroend
!define BUILD_RESOURCES_DIR "${escapeNsis(resources)}"
!include "${escapeNsis(path.join(resources, 'installer-ui.nsh'))}"

${finishOnly ? `; Declare handles used by the shared production functions without
; adding pages or running the simulated installation section.
!insertmacro MUI_DIRECTORYPAGE_INTERFACE
!insertmacro MUI_INSTFILESPAGE_INTERFACE` : `!define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloDirectoryShow
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PiHaloInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES`}
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT " "
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PiHaloFinishShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PiHaloFinishLeave
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro PiHaloInstFilesFunctions

Function .onInit
  StrCpy $PreviewLaunchCount 0
  ${rebootRequired ? 'SetRebootFlag true' : 'SetRebootFlag false'}
FunctionEnd

Function PiHaloStartApp
  ; Exercise the production Finish callback, without starting an application.
  IntOp $PreviewLaunchCount $PreviewLaunchCount + 1
  System::Call 'kernel32::GetTickCount()i.r1'
  System::Call 'user32::IsWindow(p $HWNDPARENT)i.r2'
  FileOpen $0 "${escapeNsis(startedMarker)}" w
  FileWrite $0 "finish-launch-count=$PreviewLaunchCount$\r$\n"
  FileWrite $0 "installer-window-exists=$2$\r$\n"
  FileWrite $0 "launch-started-tick=$1$\r$\n"
  FileClose $0
  Sleep ${launchDelayMs}
  System::Call 'kernel32::GetTickCount()i.r3'
  FileOpen $0 "${escapeNsis(marker)}" w
  FileWrite $0 "finish-launch-count=$PreviewLaunchCount$\r$\n"
  FileWrite $0 "installer-window-exists=$2$\r$\n"
  FileWrite $0 "launch-started-tick=$1$\r$\n"
  FileWrite $0 "launch-finished-tick=$3$\r$\n"
  FileClose $0
FunctionEnd

Section "Preview only"
${finishOnly ? '  ; Empty mandatory section: this fixture starts on Finish.' : String.raw`  SendMessage $PiHaloStatus ${'${WM_SETTEXT}'} 0 "STR:正在安装…"
  SendMessage $mui.InstFilesPage.ProgressBar 0x0401 0 0x00640000
  StrCpy $PreviewCounter 0
  ${'${Do}'}
    SendMessage $mui.InstFilesPage.ProgressBar 0x0402 $PreviewCounter 0
    Sleep 40
    IntOp $PreviewCounter $PreviewCounter + 1
  ${'${LoopUntil}'} $PreviewCounter > 100
  SendMessage $PiHaloStatus ${'${WM_SETTEXT}'} 0 "STR:安装完成"`}
SectionEnd
`;
fs.writeFileSync(sourcePath, source);
const startedAt = Date.now();
const result = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', sourcePath], {
  cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
assert.ok(fs.statSync(executable).size > 0, 'NSIS did not generate a preview executable.');
const metadata = {
  fixtureId, createdAt: new Date(startedAt).toISOString(), sourcePath, executable,
  marker, startedMarker, metadataPath, launchDelayMs, hideRun, rebootRequired,
  expectedLaunch: !hideRun && !rebootRequired,
  compileDurationMs: Date.now() - startedAt,
  installs: false, launchesApplication: false, rebootsWindows: false,
  firstPage: finishOnly ? 'finish' : 'directory',
};
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
