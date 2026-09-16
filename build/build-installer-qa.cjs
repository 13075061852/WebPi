'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const prepareInstaller = require('./prepare-installer.cjs');

// Compile the same installer UI against an isolated installer identity. This
// does not install anything and must never be uploaded as a product release.
const project = path.resolve(__dirname, '..');
const qa = path.join(project, 'tmp', 'installer-qa');
const qaPayload = path.join(project, 'tmp', 'qa-payload');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
const config = structuredClone(manifest.build);
config.appId = 'com.pihalo.installerqa';
config.productName = 'Pi Halo Installer QA';
config.extraMetadata = { ...config.extraMetadata, name: 'pi-halo-installer-qa' };
config.directories = { ...config.directories, output: 'tmp/installer-qa/build' };
config.win = { ...config.win, executableName: 'Pi Halo' };
config.nsis = {
  ...config.nsis,
  artifactName: 'Pi-Halo-Installer-QA-${version}.${ext}',
  shortcutName: 'Pi Halo Installer QA',
  allowElevation: false,
  perMachine: false,
  include: path.join(qa, 'installer-qa.nsh'),
};
config.publish = null;
fs.mkdirSync(qa, { recursive: true });
const runtimeInclude = path.join(qa, 'installer-runtime-qa.nsh');
const installerSource = fs.readFileSync(path.join(__dirname, 'installer.nsh'), 'utf8');
const launchAnchor = '  ${If} ${UAC_IsInnerInstance}';
if (installerSource.split(launchAnchor).length !== 2) throw new Error('Cannot inject the QA-only user-data-dir: launch function changed.');
fs.writeFileSync(runtimeInclude, installerSource.replace(launchAnchor,
  '  StrCpy $1 \'$1 --user-data-dir="$TEMP\\Pi-Halo-QA-profile"\'\n' + launchAnchor));
fs.writeFileSync(config.nsis.include, [
  '; QA only: keep the test installer away from the normal Pi Halo folder.',
  '!undef APP_FILENAME',
  '!define APP_FILENAME "Pi Halo Installer QA"',
  '!include "${PROJECT_DIR}\\tmp\\installer-qa\\installer-runtime-qa.nsh"',
  '',
].join('\n'));
const configPath = path.join(qa, 'electron-builder.json');
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared QA-only installer configuration: ${configPath}`);
console.log('Before running it, isolate APPDATA and USERPROFILE for the launched app; do not run alongside the real Pi Halo.');

if (process.argv.includes('--copy-payload')) {
  if (fs.existsSync(qaPayload)) throw new Error(`QA payload already exists; preserve or clear this exact test directory before taking a fresh snapshot: ${qaPayload}`);
  fs.cpSync(path.join(project, 'dist', 'win-unpacked'), qaPayload, { recursive: true, preserveTimestamps: true });
  const updateConfigPath = path.join(qaPayload, 'resources', 'app-update.yml');
  const updateConfig = fs.readFileSync(updateConfigPath, 'utf8');
  if (!/^updaterCacheDirName: .+$/m.test(updateConfig)) throw new Error('Cannot isolate QA updater cache: updaterCacheDirName is missing.');
  fs.writeFileSync(updateConfigPath, updateConfig.replace(/^updaterCacheDirName: .+$/m, 'updaterCacheDirName: pi-halo-installer-qa-updater'));
  console.log(`Copied an isolated QA payload to ${qaPayload}`);
}

if (process.argv.includes('--build')) {
  if (!fs.existsSync(path.join(qaPayload, 'resources', 'app.asar'))) throw new Error('Take a QA payload snapshot first with --copy-payload after the product build finishes.');
  prepareInstaller();
  const child = spawnSync(process.execPath, [
    path.join(project, 'node_modules', 'electron-builder', 'cli.js'),
    '--config', configPath, '--win', '--prepackaged', qaPayload, '--publish', 'never',
  ], {
    cwd: project,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_BUILDER_CACHE: path.join(project, 'tmp', 'electron-builder-cache') },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
