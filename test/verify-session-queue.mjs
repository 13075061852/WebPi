import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import os from 'node:os';
import path from 'node:path';
const source = fs.readFileSync('src/main/main.mjs', 'utf8');
const start = source.indexOf('  let sessionSwitchQueue = ');
const end = source.indexOf('  handle("halo:preview-touch"', start);
const handlers = new Map(), order = [];
let release;
const gate = new Promise(resolve => { release = resolve; });
const context = vm.createContext({
  handle: (name, fn) => handlers.set(name, fn),
  bridge: {
    openSession: async () => { order.push('open-start'); await gate; order.push('open-end'); },
    deleteSession: async () => { order.push('delete'); throw Error('busy'); },
    newSession: async () => { order.push('new'); },
    switchProject: async () => { order.push('project'); },
  },
});
vm.runInContext(source.slice(start, end), context);
vm.runInContext(source.split('\n').find(line => line.includes('handle("halo:project-switch"')), context);
const opening = handlers.get('halo:open-session')('a');
const deleting = assert.rejects(handlers.get('halo:delete-session')('a'), /busy/);
const project = handlers.get('halo:project-switch')({ cwd: 'b' });
await Promise.resolve(); assert.deepEqual(order, ['open-start']);
release(); await Promise.all([opening, deleting, project]);
assert.deepEqual(order, ['open-start', 'open-end', 'delete', 'project']);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-project-validation-'));
const bridge = new PiBridge(new HaloStore(path.join(dir, 'settings.json')));
const before = JSON.stringify(bridge.store.data);
await assert.rejects(bridge.switchProject(path.join(dir, 'missing')), /不存在/);
assert.equal(JSON.stringify(bridge.store.data), before);
fs.unlinkSync(path.join(dir, 'settings.json'));
fs.rmdirSync(dir);
console.log('PASS session mutations serialize, rejected deletion does not block later switch, invalid project does not alter settings');
