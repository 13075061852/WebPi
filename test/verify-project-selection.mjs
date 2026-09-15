import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-project-selection-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const [a, b, c] = ['a', 'b', 'c'].map(name => path.join(fixture.dir, name));
for (const dir of [a, b, c]) fs.mkdirSync(dir);
const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')), {}, { sessionDir: path.join(fixture.dir, 'sessions') });
const releases = [];
let aborts = 0;
function runTask(session) {
  session.prompt = () => {
    session.isStreaming = true;
    return new Promise(resolve => releases.push(() => { session.isStreaming = false; resolve(); }));
  };
  const abort = session.abort.bind(session);
  session.abort = async () => { aborts++; await abort(); };
  return bridge.prompt('Keep working');
}

try {
  await bridge.start(a);
  const sa = bridge.session, pa = runTask(sa);
  await bridge.switchProject(c);
  const sc = bridge.session, pc = runTask(sc);

  const source = fs.readFileSync('src/main/main.mjs', 'utf8');
  const handlers = new Map();
  let selection = { canceled: false, filePaths: [b] };
  const context = vm.createContext({
    bridge, store: bridge.store, fs, path, mainWin: {},
    normP: PiBridge.normPath,
    dialog: { showOpenDialog: async () => selection },
    handle: (name, handler) => handlers.set(name, handler),
  });
  const queueStart = source.indexOf('  let sessionSwitchQueue = ');
  vm.runInContext(source.slice(queueStart, source.indexOf('  handle("halo:preview-touch"', queueStart)), context);
  const pickerStart = source.indexOf('  handle("halo:pick-project"');
  vm.runInContext(source.slice(pickerStart, source.indexOf('  /* ---------------- 插件与技能', pickerStart)), context);
  vm.runInContext(source.split('\n').find(line => line.includes('handle("halo:project-add"')), context);

  assert.equal(await handlers.get('halo:pick-project')(c), b);
  assert.equal(bridge.session, sc, 'Selecting a folder must not switch or reset the runtime');
  assert.equal(bridge.cwd, c.replaceAll('\\', '/'));
  assert.equal(aborts, 0);
  await handlers.get('halo:project-add')({ dir: b });
  assert.equal(bridge.cwd, b.replaceAll('\\', '/'));
  assert.ok(sa.isStreaming && sc.isStreaming, 'Adding a project must preserve both background tasks');
  assert.equal(aborts, 0);
  await bridge.openSession(sa.sessionFile);
  assert.equal(bridge.session, sa, 'The original running runtime remains available');

  selection = { canceled: true, filePaths: [] };
  assert.equal(await handlers.get('halo:pick-project')(a), null);
  assert.equal(bridge.session, sa);

  // Restoring a workspace must wait for startup, then share ordering with add-project.
  let finishStartup;
  bridge.startingPromise = new Promise(resolve => { finishStartup = resolve; });
  const adding = handlers.get('halo:project-add')({ dir: b });
  const restoring = handlers.get('halo:use-project')(c);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.session, sa, 'Project restoration cannot overtake startup');
  finishStartup();
  await Promise.all([adding, restoring]);
  bridge.startingPromise = null;
  assert.equal(bridge.session, sc, 'The last queued project selection wins');
  assert.ok(sa.isStreaming && sc.isStreaming);
  assert.equal(aborts, 0);

  await assert.rejects(handlers.get('halo:use-project')(path.join(fixture.dir, 'missing')), /不存在/);
  await handlers.get('halo:use-project')(a);
  assert.equal(bridge.session, sa, 'A rejected selection must not block later requests');
  releases.forEach(release => release());
  await Promise.all([pa, pc]);
  assert.equal(aborts, 0);
  const beforeRemoval = bridge.session;
  assert.equal((await bridge.removeProject(b)).switched, false);
  assert.equal(bridge.session, beforeRemoval);
  assert.equal((await bridge.removeProject(a)).switched, true);
  assert.equal(bridge.cwd, c.replaceAll('\\', '/'));
  assert.equal((await bridge.removeProject(c)).switched, true);
  assert.equal((await bridge.projectsList()).length, 0);
  assert.equal(bridge.cwd, path.join(fixture.dir, 'workspace').replaceAll('\\', '/'));
  for (const dir of [a, b, c]) assert.ok(fs.existsSync(dir), 'Removing a project must preserve its files');
  console.log('PASS folder selection, two background tasks, cancellation, startup ordering and workspace recovery');
} finally {
  releases.forEach(release => release());
  await bridge.dispose();
  fixture.cleanup();
}
