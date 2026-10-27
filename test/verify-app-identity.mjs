import assert from 'node:assert/strict';
import fs from 'node:fs';
import { windowsAppUserModelId } from '../src/main/app-identity.mjs';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const platform of ['win32', 'linux', 'darwin']) {
  for (const testBuild of [false, true]) {
    assert.equal(windowsAppUserModelId({ platform, isPackaged:false, testBuild }), null,
      `${platform} development must never claim an installed identity`);
  }
}
assert.equal(windowsAppUserModelId({ platform:'win32', isPackaged:true, testBuild:false }), manifest.build.appId);
assert.equal(windowsAppUserModelId({ platform:'win32', isPackaged:true, testBuild:true }), 'com.pihalo.test');
assert.equal(windowsAppUserModelId({ platform:'linux', isPackaged:true, testBuild:false }), null);
assert.equal(windowsAppUserModelId({ platform:'darwin', isPackaged:true, testBuild:true }), null);
const qa = fs.readFileSync('build/build-installer-qa.cjs', 'utf8');
assert.match(qa, /config\.appId = 'com\.pihalo\.test'/, 'test installer identity must match its shortcut');
assert.match(qa, /haloTestBuild: true/, 'test installer must select its own identity');
console.log('PASS installed, test and development Windows identities remain isolated');
