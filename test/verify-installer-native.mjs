import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
createRequire(import.meta.url)('../build/compile-installer-window.cjs')();
if (process.argv.includes('--runtime')) {
  assert.equal(process.platform, 'win32');
  const index = process.argv.indexOf('--nsis');
  const compiler = index >= 0 ? path.resolve(process.argv[index + 1]) : null;
  assert.ok(compiler && fs.existsSync(compiler), 'Pass --nsis <makensis.exe> for the native runtime regression.');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-installer-native-'));
  try {
    const output = path.join(sandbox, 'probe.exe');
    const fixture = path.join(sandbox, 'probe.nsi');
    fs.writeFileSync(fixture, `Unicode true
Name "Pi Halo DLL extraction probe"
OutFile "${output}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"
!define BUILD_RESOURCES_DIR "${path.join(root, 'build')}"
!include "${path.join(root, 'build/installer-ui.nsh')}"
Function .onInit
  ; Reproduce GUI init before any output/install directory exists.
  StrCpy $OUTDIR "${path.join(sandbox, 'missing-output-directory')}"
  !insertmacro PiHaloExtractUi
  IfFileExists "$PLUGINSDIR\\halo-installer-ui.dll" +3
    SetErrorLevel 10
    Quit
  \${If} $PiHaloAttach == 0
  \${OrIf} $PiHaloRefresh == 0
  \${OrIf} $PiHaloStyleDirectory == 0
    SetErrorLevel 11
    Quit
  \${EndIf}
  \${GetParameters} $0
  \${GetOptions} $0 "/result=" $1
  FileOpen $2 "$1" w
  FileWrite $2 "$PLUGINSDIR"
  FileClose $2
FunctionEnd
Section
SectionEnd
`);
    const built = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V1', fixture],
      { cwd: sandbox, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(built.status, 0, built.error?.message || built.stdout + built.stderr);
    const run = suffix => new Promise((resolve, reject) => {
      const result = path.join(sandbox, `result-${suffix}.txt`);
      const child = spawn(output, ['/S', `/result=${result}`], { cwd: sandbox, windowsHide: true });
      const timeout = setTimeout(() => { child.kill(); reject(Error('DLL extraction probe stalled.')); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => {
        clearTimeout(timeout);
        try {
          assert.equal(code, 0, `DLL extraction probe ${suffix} exited ${code}`);
          assert.ok(fs.existsSync(result), 'Probe must reach the success marker.');
          resolve(fs.readFileSync(result, 'utf8'));
        } catch (error) { reject(error); }
      });
    });
    const dirs = await Promise.all([run('one'), run('two')]);
    assert.notEqual(dirs[0], dirs[1], 'Concurrent processes must use separate plugin directories.');
    assert.equal(fs.existsSync(path.join(sandbox, 'missing-output-directory')), false,
      'Extraction must not write or create $OUTDIR.');
    assert.equal(fs.existsSync(path.join(sandbox, 'halo-installer-ui.dll')), false,
      'Extraction must not write beside the setup executable.');
    console.log('PASS native DLL extraction/loading: missing OUTDIR, concurrent isolated processes, no modal errors.');
  } finally {
    assert.equal(path.dirname(sandbox), os.tmpdir());
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
console.log('PASS installer UI source/binary integrity and x86 architecture.');
