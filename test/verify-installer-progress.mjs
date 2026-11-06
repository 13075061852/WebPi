import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
require('../build/prepare-installer.cjs')();
const ui = fs.readFileSync('build/installer-ui.nsh', 'utf8');
const extract = fs.readFileSync('build/generated/extractAppPackage.nsh', 'utf8');
const installer = fs.readFileSync('build/installer.nsh', 'utf8');
assert.match(ui, /ShowWindow \$mui\.InstFilesPage\.ProgressBar 0/);
assert.match(ui, /PiHaloCreateProgress \$PiHaloPage/);
assert.equal((extract.match(/Nsis7z::ExtractWithCallback/g) || []).length, 2, 'Initial extraction and retry must use byte progress');
assert.doesNotMatch(extract, /Nsis7z::Extract /);
assert.ok(installer.indexOf('PiHaloProgress 1000') > installer.indexOf('关键程序文件缺失'), 'Only successful validation may complete progress');
console.log('PASS independent installer progress, real extraction callback and completion after file validation');

if (process.argv.includes('--runtime')) {
  assert.equal(process.platform, 'win32');
  const index = process.argv.indexOf('--nsis');
  const compiler = path.resolve(process.argv[index + 1]);
  assert.ok(index >= 0 && fs.existsSync(compiler), 'Pass --nsis <makensis.exe>');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-installer-progress-'));
  try {
    const plugin = path.resolve('tmp/electron-builder-cache/nsis-resources-3.4.1/nsis-resources-3.4.1-2jx2y/plugins/x86-unicode');
    const archiveTool = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor/7z.exe');
    fs.writeFileSync(path.join(fixture, 'payload.txt'), '真实解压进度\n'.repeat(500000));
    const archived = spawnSync(archiveTool, ['a', '-t7z', '-m0=lzma2', path.join(fixture, 'payload.7z'), path.join(fixture, 'payload.txt')], { encoding: 'utf8', windowsHide: true });
    assert.equal(archived.status, 0, archived.stdout + archived.stderr);
    // Instrument observation only; all calculations/control creation are the
    // production NSIS macros and the actual bundled Nsis7z plugin.
    fs.writeFileSync(path.join(fixture, 'ui.nsh'), ui.replace('Function PiHaloExtractProgress', 'Function PiHaloExtractProgress\n  IntOp $Callbacks $Callbacks + 1'));
    const script = String.raw`Unicode true
Name "Pi Halo progress regression (no installation)"
OutFile "${fixture}\probe.exe"
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!addplugindir "${plugin}"
Var Callbacks
!include "${fixture}\ui.nsh"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowProgress
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro PiHaloProgressFunctions
!macro CheckPos VALUE
  SendMessage $PiHaloProgressBar 0x0408 0 0 $0
  ${'${If}'} $0 != ${'${VALUE}'}
    SetErrorLevel 11
    Quit
  ${'${EndIf}'}
!macroend
!macro Bytes DONE TOTAL EXPECTED
  Push "stack-sentinel"
  Push "${'${TOTAL}'}"
  Push "${'${DONE}'}"
  Call PiHaloExtractProgress
  Pop $0
  ${'${If}'} $0 != "stack-sentinel"
    SetErrorLevel 12
    Quit
  ${'${EndIf}'}
  !insertmacro CheckPos ${'${EXPECTED}'}
!macroend
Function ShowProgress
  ShowWindow $mui.InstFilesPage.ProgressBar 0
  !insertmacro PiHaloCreateProgress $mui.InstFilesPage 20 20 300 8
FunctionEnd
Section
  StrCpy $R1 "register-sentinel"
  !insertmacro PiHaloProgress 150
  !insertmacro Bytes 50 100 500
  !insertmacro Bytes 0 100 500
  !insertmacro Bytes 0 0 500
  !insertmacro Bytes 0 -1 500
  !insertmacro Bytes -1 100 500
  !insertmacro Bytes 101 100 500
  !insertmacro Bytes 2250000000 3000000000 675
  ; The original control can wrap, change range or reach 100% independently.
  SendMessage $mui.InstFilesPage.ProgressBar 0x0406 0 100
  SendMessage $mui.InstFilesPage.ProgressBar 0x0402 100 0
  SendMessage $mui.InstFilesPage.ProgressBar 0x0402 0 0
  !insertmacro CheckPos 675
  !insertmacro PiHaloProgress 850
  !insertmacro Bytes 50 100 850
  !insertmacro PiHaloProgress 980
  !insertmacro CheckPos 980
  ${'${If}'} $R1 != "register-sentinel"
    SetErrorLevel 13
    Quit
  ${'${EndIf}'}
  ; Start a fresh control for real archive extraction, not a simulated counter.
  System::Call 'user32::DestroyWindow(p $PiHaloProgressBar)'
  !insertmacro PiHaloCreateProgress $mui.InstFilesPage 20 20 300 8
  !insertmacro PiHaloProgress 150
  InitPluginsDir
  File /oname=$PLUGINSDIR\payload.7z "${fixture}\payload.7z"
  SetOutPath "$PLUGINSDIR\out"
  StrCpy $Callbacks 0
  GetFunctionAddress $PiHaloExtractCallback PiHaloExtractProgress
  Nsis7z::ExtractWithCallback "$PLUGINSDIR\payload.7z" $PiHaloExtractCallback
  ${'${If}'} $Callbacks < 1
    SetErrorLevel 14
    Quit
  ${'${EndIf}'}
  !insertmacro CheckPos 850
  IfFileExists "$OUTDIR\payload.txt" +3
    SetErrorLevel 15
    Quit
  !insertmacro PiHaloProgress 900
  !insertmacro PiHaloProgress 940
  !insertmacro PiHaloProgress 960
  !insertmacro PiHaloProgress 980
  !insertmacro CheckPos 980
  !insertmacro PiHaloProgress 1000
  !insertmacro CheckPos 1000
  ; Silent callbacks must still consume both stack arguments.
  SetSilent silent
  !insertmacro Bytes 0 100 1000
  FileOpen $0 "${fixture}\passed.txt" w
  FileWrite $0 "callbacks=$Callbacks"
  FileClose $0
  SetErrorLevel 0
  Quit
SectionEnd
`;
    fs.writeFileSync(path.join(fixture, 'probe.nsi'), script);
    const compiled = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', path.join(fixture, 'probe.nsi')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(path.join(fixture, 'probe.exe'), [], { windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error('Native progress regression timed out')); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', result => { clearTimeout(timer); resolve(result); });
    });
    assert.equal(code, 0, `Native progress regression failed with code ${code}`);
    assert.match(fs.readFileSync(path.join(fixture, 'passed.txt'), 'utf8'), /callbacks=\d+/);
    fs.mkdirSync('test/results', { recursive: true });
    fs.writeFileSync('test/results/installer-progress.json', JSON.stringify({ passed: true, at: new Date().toISOString(), realExtraction: true,
      checks: ['separate control', 'no backwards movement', 'unknown and invalid totals', '64-bit byte counts', 'stack and register preservation', 'actual Nsis7z extraction', 'success-only completion', 'silent callback'] }, null, 2));
    console.log('PASS native NSIS progress: byte callbacks, no resets, 64-bit totals, stack/registers, real extraction, silent mode and final completion');
  } finally {
    assert.equal(path.dirname(fixture), os.tmpdir());
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
