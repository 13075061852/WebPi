import assert from 'node:assert/strict';
import { fixturePortabilityMessages } from '../scripts/check-fixture-portability.mjs';
import { officialInstallAvailable } from '../src/main/environment-fallback.mjs';

const prefix = "import assert from 'node:assert/strict';\n";
const invalid = [
  "assert.equal(available({platform:'win32'}), process.platform === 'win32');",
  "assert.strictEqual(available({platform: 'linux', arch:'x64'}), process['platform'] !== 'win32');",
  "import os from 'node:os'; assert.deepEqual(read({platform:'darwin'}), os.platform() === 'darwin' ? [] : ['x']);",
  "import {platform as host} from 'node:os'; assert.equal(read({['platform']:'win32'}), host() === 'win32');",
  "import {equal as same} from 'node:assert/strict'; same(read({'platform':'win32'}), process.platform);",
];
for (const source of invalid) {
  const messages = fixturePortabilityMessages(prefix + source);
  assert.equal(messages.length, 1, source);
  assert.equal(messages[0].ruleId, 'fixture/portability');
}

const valid = [
  "assert.equal(available({platform:'win32'}), true);",
  "assert.equal(available({platform:'linux'}), false);",
  "if (process.platform === 'win32') assert.equal(read({platform:'win32'}), true);",
  "assert.equal(available(), process.platform === 'win32');",
  "assert.equal(available({platform:process.platform}), process.platform === 'win32');",
  "assert.equal({platform:'win32'}.platform, 'win32', 'process.platform is only a message');",
  "const source = `assert.equal(available({platform:'win32'}), process.platform === 'win32')`;",
  "assert.equal(available({platform:'win32'}), fixture.platform === 'win32');",
  "other.equal(available({platform:'win32'}), process.platform === 'win32');",
];
for (const source of valid) assert.deepEqual(fixturePortabilityMessages(prefix + source), [], source);

// No subprocesses, files, downloads or registry writes. This pure API must obey
// the fixture's injected OS even on Windows before the code reaches Linux CI.
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  for (const host of ['win32', 'linux', 'darwin']) {
    Object.defineProperty(process, 'platform', { ...descriptor, value: host });
    for (const platform of ['win32', 'linux', 'darwin']) for (const arch of ['x64', 'arm64', 'ia32']) {
      const result = officialInstallAvailable({ platform, arch, env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' } });
      assert.equal(result, platform === 'win32' && arch !== 'ia32', `${host} host / ${platform} fixture / ${arch}`);
    }
    assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'relative' } }), false);
    assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'C:\\Tools;untrusted' } }), false);
  }
} finally {
  Object.defineProperty(process, 'platform', descriptor);
}
assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'platform'), descriptor);
console.log('PASS fixture portability: 14 AST cases, 33 injected host/platform/architecture cases, host descriptor restored');
