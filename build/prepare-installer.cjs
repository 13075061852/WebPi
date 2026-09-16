'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Preserve electron-builder's default script selection, signed uninstaller,
// updater switches, and final installer size validation. Only instrument the
// stock include files, never set nsis.script or edit node_modules.
function prepareInstaller() {
  const project = path.resolve(__dirname, '..');
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json'));
  const version = require(path.join(builderRoot, 'package.json')).version;
  if (version !== '26.15.3') {
    throw new Error(`NSIS instrumentation requires review for app-builder-lib ${version}; expected 26.15.3.`);
  }
  const templates = path.join(builderRoot, 'templates', 'nsis');
  const generated = path.join(__dirname, 'generated');
  const originals = {};
  const read = (file) => {
    const source = fs.readFileSync(path.join(templates, file), 'utf8').replace(/\r\n/g, '\n');
    originals[file] = crypto.createHash('sha256').update(source).digest('hex');
    return source;
  };
  const replace = (source, needle, replacement, expected = 1) => {
    const count = source.split(needle).length - 1;
    if (count !== expected) throw new Error(`NSIS template changed: expected ${expected} occurrence(s) of ${JSON.stringify(needle)}, found ${count}.`);
    return source.split(needle).join(replacement);
  };
  const stage = (title, text) => `!insertmacro PiHaloStage "${title}" "${text}"`;
  let section = read('installSection.nsh');
  section = replace(section, '!include installer.nsh', '!include "${BUILD_RESOURCES_DIR}\\generated\\installer-files.nsh"');
  section = replace(section, '  SetDetailsPrint none', '  SetDetailsPrint textonly');
  section = replace(section, 'StrCpy $appExe', `${stage('1 / 9  检查安装环境', '检测正在运行的 Pi Halo，确认目标目录。')}\nStrCpy $appExe`);
  section = replace(section, '!insertmacro uninstallOldVersion SHELL_CONTEXT', `${stage('2 / 9  准备安装目录', '检测并移除已有程序文件，保留用户设置与工作数据。')}\n!insertmacro uninstallOldVersion SHELL_CONTEXT`);
  section = replace(section, '!insertmacro registryAddInstallInfo', `${stage('7 / 9  注册应用', '写入版本、安装位置和卸载信息。')}\n!insertmacro registryAddInstallInfo`);
  section = replace(section, '!insertmacro addStartMenuLink $keepShortcuts', `${stage('8 / 9  配置快捷方式', '按原有偏好设置开始菜单与桌面快捷方式。')}\n!insertmacro addStartMenuLink $keepShortcuts`);

  let files = read('include/installer.nsh');
  // The same asynchronous launch path must also cover silent --force-run
  // updates; preserve the stock run condition in installSection.nsh.
  files = '!macroundef StartApp\n!macro StartApp\n  Call PiHaloStartApp\n!macroend\n\n' + files;
  files = replace(files, '!include "extractAppPackage.nsh"', '!include "${BUILD_RESOURCES_DIR}\\generated\\extractAppPackage.nsh"');
  const cacheCopy = '      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  files = replace(files, cacheCopy, `      ${stage('6 / 9  准备自动更新', '缓存本次安装包，供后续差分更新使用。')}\n${cacheCopy}`);
  files = replace(files, '  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"', '  !insertmacro PiHaloDetail "写入卸载程序。"\n  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"');

  let extract = read('include/extractAppPackage.nsh');
  extract = replace(extract, '  !insertmacro compute_files_for_current_arch', `  ${stage('3 / 9  读取安装数据', '从安装包释放应用压缩数据到临时目录。')}\n  !insertmacro compute_files_for_current_arch`);
  extract = replace(extract, '  !insertmacro decompress', `  ${stage('4 / 9  解压应用文件', '正在解压运行环境、界面资源和应用依赖。')}\n  !insertmacro decompress`);
  extract = replace(extract, '  # Retry counter', `  ${stage('5 / 9  写入程序文件', '将已解压的应用写入所选安装目录。')}\n\n  # Retry counter`);
  const fastMove = [
    '  ; Per-user, empty, same-volume targets can take ownership of the already',
    '  ; extracted directory instead of copying every dependency a second time.',
    '  ; Keep copy semantics for per-machine installs so destination ACLs inherit',
    '  ; from Program Files instead of the private user temporary directory.',
    '  ${If} $installMode == "CurrentUser"',
    '    Push $R2',
    '    StrCpy $R2 $OUTDIR',
    '    SetOutPath "$PLUGINSDIR"',
    '    ClearErrors',
    '    RMDir "$R2" ; deliberately non-recursive: never remove existing files',
    '    ${IfNot} ${Errors}',
    '      ClearErrors',
    '      Rename "$PLUGINSDIR\\7z-out" "$R2"',
    '      ${IfNot} ${Errors}',
    '        SetOutPath "$R2"',
    '        Pop $R2',
    '        !insertmacro PiHaloDetail "同磁盘快速写入完成：直接移动已解压目录，省去逐项复制。"',
    '        Goto DoneExtract7za',
    '      ${EndIf}',
    '    ${EndIf}',
    '    ; Recreate the empty target if a cross-volume move failed, then fall',
    '    ; back to the unchanged stock copying, retry and cancellation behavior.',
    '    SetOutPath "$R2"',
    '    Pop $R2',
    '    ClearErrors',
    '  ${EndIf}',
    '  !insertmacro PiHaloDetail "正在逐项复制文件到安装目录。"',
    '',
  ].join('\n');
  extract = replace(extract, '  # Retry counter', `${fastMove}\n  # Retry counter`);
  extract = replace(extract, '  RetryExtract7za:\n    Sleep 1000', '  RetryExtract7za:\n    !insertmacro PiHaloDetail "文件暂被占用，正在重试写入（第 $R1 次）。"\n    Sleep 1000');
  // Stock retry/cancel silently quits with success on cancel. Preserve retry
  // behavior but make failed unattended installs observable to electron-updater.
  extract = replace(extract, '  AbortExtract7za:\n    Quit', '  AbortExtract7za:\n    SetErrorLevel 2\n    Quit');

  fs.mkdirSync(generated, { recursive: true });
  const generatedFiles = { 'installSection.nsh': section, 'installer-files.nsh': files, 'extractAppPackage.nsh': extract };
  // On Windows, the bundled NSIS Include/MultiUser.nsh and builder's
  // templates/multiUser.nsh differ only in case. Keep every stock sibling in
  // the active include directory so NSIS's built-in search paths cannot take
  // precedence over the builder's own installer-mode implementation.
  for (const name of fs.readdirSync(templates)) {
    if (name.endsWith('.nsh') && name !== 'installSection.nsh') generatedFiles[name] = read(name);
  }
  for (const [name, source] of Object.entries(generatedFiles)) {
    fs.writeFileSync(path.join(generated, name), `; Generated by build/prepare-installer.cjs from app-builder-lib ${version}.\n${source}`, 'utf8');
  }
  fs.writeFileSync(path.join(generated, 'manifest.json'), `${JSON.stringify({ builderVersion: version, project, templates, originals }, null, 2)}\n`);
  console.log(`Prepared observable NSIS installer from app-builder-lib ${version}.`);
  return true;
}

module.exports = prepareInstaller;
if (require.main === module) prepareInstaller();
