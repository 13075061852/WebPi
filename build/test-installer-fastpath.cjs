'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const prepareInstaller = require('./prepare-installer.cjs');

if (process.platform !== 'win32') throw new Error('The NSIS filesystem fixture requires Windows.');
prepareInstaller();
const project = path.resolve(__dirname, '..');
const work = path.join(project, 'tmp', `installer-fastpath-tests-${Date.now()}`);
fs.mkdirSync(work, { recursive: true });
const cache = path.join(project, 'tmp', 'electron-builder-cache', 'nsis-3.0.4.1');
const nsisDir = fs.readdirSync(cache).map(name => path.join(cache, name)).find(dir => fs.existsSync(path.join(dir, 'Bin', 'makensis.exe')));
if (!nsisDir) throw new Error('Build the Windows installer first to populate the NSIS compiler cache.');
const extraction = fs.readFileSync(path.join(__dirname, 'generated', 'extractAppPackage.nsh'), 'utf8');
const start = extraction.indexOf('  ; Per-user, empty, same-volume targets');
const end = extraction.indexOf('  # Retry counter', start);
assert(start >= 0 && end > start, 'Missing generated fast-path block');
const originalFastPath = extraction.slice(start, end);
const renameLine = '      Rename "$PLUGINSDIR\\7z-out" "$R2"';
assert.equal(originalFastPath.split(renameLine).length, 2, 'Unexpected rename operation in generated block');
// Inject only the Rename error flag for the fourth scenario. This exercises
// destination recreation and the real fallback copy without requiring another
// physical volume or changing filesystem permissions on this computer.
const fastPath = originalFastPath.replace(renameLine, [
  '      ${If} $FixtureCase == "renameFailure"',
  '        SetErrors',
  '      ${Else}',
  renameLine,
  '      ${EndIf}',
].join('\n'));
// The fixture has no registry, shortcuts, application data, or user directory
// access. It exercises the exact generated block in new workspace test folders.
const script = [
  'Unicode true',
  '!include LogicLib.nsh',
  'Name "Pi Halo filesystem fixture"',
  `OutFile "${path.join(work, 'fixture.exe')}"`,
  'RequestExecutionLevel user',
  'SilentInstall silent',
  'Var installMode',
  'Var FixtureCase',
  '!macro PiHaloDetail TEXT',
  '  DetailPrint "${TEXT}"',
  '!macroend',
  'Function CopyScenario',
  fastPath,
  '  CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
  '  IfErrors 0 DoneExtract7za',
  '  SetErrorLevel 2',
  '  Quit',
  '  DoneExtract7za:',
  'FunctionEnd',
  '!macro Scenario LABEL MODE SENTINEL',
  '  StrCpy $installMode "${MODE}"',
  '  StrCpy $FixtureCase "${LABEL}"',
  '  SetOutPath "$PLUGINSDIR\\7z-out"',
  '  FileOpen $0 "$OUTDIR\\payload.txt" w',
  '  FileWrite $0 "payload-${LABEL}"',
  '  FileClose $0',
  '  SetOutPath "$EXEDIR\\${LABEL}"',
  '  !if ${SENTINEL} == 1',
  '    FileOpen $0 "$OUTDIR\\keep-me.txt" w',
  '    FileWrite $0 "preserved-user-file"',
  '    FileClose $0',
  '  !endif',
  '  Call CopyScenario',
  '  ${If} ${FileExists} "$PLUGINSDIR\\7z-out\\payload.txt"',
  '    FileWrite $9 "${LABEL}=copy$\\r$\\n"',
  '  ${Else}',
  '    FileWrite $9 "${LABEL}=rename$\\r$\\n"',
  '  ${EndIf}',
  '!macroend',
  'Section',
  '  InitPluginsDir',
  '  FileOpen $9 "$EXEDIR\\results.txt" w',
  '  !insertmacro Scenario empty CurrentUser 0',
  '  !insertmacro Scenario nonempty CurrentUser 1',
  '  !insertmacro Scenario machine all 0',
  '  !insertmacro Scenario renameFailure CurrentUser 0',
  '  FileClose $9',
  'SectionEnd',
  '',
].join('\n');
const scriptPath = path.join(work, 'fixture.nsi');
fs.writeFileSync(scriptPath, script);
execFileSync(path.join(nsisDir, 'Bin', 'makensis.exe'), ['-WX', '-INPUTCHARSET', 'UTF8', scriptPath], { cwd: project, windowsHide: true, stdio: 'pipe' });
execFileSync(path.join(work, 'fixture.exe'), [], { cwd: work, windowsHide: true, stdio: 'pipe', timeout: 30000 });
const result = fs.readFileSync(path.join(work, 'results.txt'), 'utf8').trim().split(/\r?\n/);
assert.deepEqual(result, ['empty=rename', 'nonempty=copy', 'machine=copy', 'renameFailure=copy']);
for (const scenario of ['empty', 'nonempty', 'machine', 'renameFailure']) {
  assert.equal(fs.readFileSync(path.join(work, scenario, 'payload.txt'), 'utf8'), `payload-${scenario}`);
}
assert.equal(fs.readFileSync(path.join(work, 'nonempty', 'keep-me.txt'), 'utf8'), 'preserved-user-file');
console.log(`NSIS fast-path fixture passed: empty destination renamed; nonempty, per-machine and failed-rename branches copied; existing file preserved.\nEvidence: ${work}`);
