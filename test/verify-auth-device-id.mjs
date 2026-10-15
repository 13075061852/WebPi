import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-auth-device-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
// Exercise the installed provider's exact pre-network device-ID validation.
const providerSource = fs.readFileSync('node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js','utf8');
const validation = vm.createContext({});
vm.runInContext(providerSource.match(/const UUID_PATTERN = [^;]+;/)[0] + '\n' +
  providerSource.slice(providerSource.indexOf('function agentHostId('),providerSource.indexOf('async function loginOpenAIChatGPT(')), validation);
assert.throws(() => validation.agentHostId(), /requires a device ID/, 'Reproduce the original pre-network error');
const file = path.join(fixture.dir,'settings.json');
fs.writeFileSync(path.join(fixture.dir,'.pi','agent','auth.json'),'{}');
const store = new HaloStore(file);
store.set('cwd','preserved-project');
const bridge = new PiBridge(store);
const ids = [];
bridge.modelRuntime = {
  login: async (_provider, type, _interaction, options) => {
    assert.equal(type,'oauth');
    const id = options.getDeviceId();
    assert.equal(validation.agentHostId(id),`urn:uuid:${id.toLowerCase()}`);
    ids.push(id);
    return {type:'oauth',access:'offline-fixture',refresh:'offline-fixture',expires:Date.now()+3600000};
  },
  credentials: {get: () => null},
};
bridge.pushState = () => {};
try {
  assert.equal(store.data.deviceId,undefined,'Do not create an ID until a provider needs it');
  await bridge.authLogin('openai','oauth');
  await bridge.authLogin('openai','oauth');
  assert.equal(ids[0],ids[1],'Repeated sign-ins reuse the ID');
  assert.equal(new HaloStore(file).getDeviceId(),ids[0],'A new app instance reuses the saved ID');
  assert.equal(new HaloStore(file).data.cwd,'preserved-project');
  const other = new HaloStore(path.join(fixture.dir,'other-installation.json'));
  assert.notEqual(other.getDeviceId(),ids[0],'Separate installations have separate IDs');
  const invalid = new HaloStore(path.join(fixture.dir,'invalid.json'));
  invalid.set('deviceId','invalid-legacy-value');
  assert.match(invalid.getDeviceId(),/^[0-9a-f-]{36}$/i);
  const blocked = new HaloStore(path.join(fixture.dir,'blocked.json'));
  blocked.save = () => false;
  assert.throws(() => blocked.getDeviceId(),/无法保存登录设备标识/);
  assert.equal(blocked.data.deviceId,undefined,'A failed save cannot leave an unpersisted ID in memory');
  console.log('PASS real OpenAI UUID validation, login option forwarding, repeat/restart persistence, installation isolation and write failure');
} finally {
  await bridge.dispose();
  fixture.cleanup();
}
