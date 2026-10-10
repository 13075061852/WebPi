import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { checkSource, sourceChecks } from '../scripts/check-source.mjs';
import { preflightChecks, runReleasePreflight, runPreflightCheck, sourceCheckEnvironment } from '../scripts/release-preflight.mjs';

// The source preflight cannot accidentally test yesterday's packaged EXE or
// load parent-injected Node hooks, even with Windows' case-insensitive env keys.
const inherited = {
  Path: 'C:\\FixtureTools', SystemRoot: 'C:\\Windows', HOME: 'fixture-home',
  HALO_DOCUMENT_FONT: 'fixture-font.ttf', HTTPS_PROXY: 'http://127.0.0.1:38471',
  HALO_PACKAGED_EXE: 'old-release.exe', halo_packaged_exe: 'other-old-release.exe',
  HALO_TEST_EXECUTABLE: 'other-electron.exe', Electron_Run_As_Node: '1',
  ELECTRON_OVERRIDE_DIST_PATH: 'other-electron', NODE_OPTIONS: '--import=parent-hook.mjs',
  node_path: 'global-modules', PI_HALO_PI_PATH: 'external-sdk.mjs',
};
const original = { ...inherited };
const expectedEnvironment = {
  Path: inherited.Path, SystemRoot: inherited.SystemRoot, HOME: inherited.HOME,
  HALO_DOCUMENT_FONT: inherited.HALO_DOCUMENT_FONT, HTTPS_PROXY: inherited.HTTPS_PROXY,
};
assert.deepEqual(sourceCheckEnvironment(inherited), expectedEnvironment);
assert.deepEqual(inherited, original, 'Do not mutate the parent environment');
let spawned = 0;
const checkArguments = ['test/e2e/e2e-ui-motion.mjs'];
const checked = runPreflightCheck(checkArguments, { env: inherited, spawnProcess: (exe, args, options) => {
  spawned++;
  assert.equal(exe, process.execPath);
  assert.deepEqual(args, checkArguments);
  assert.deepEqual(options.env, expectedEnvironment);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'inherit');
  return { status: 0 };
} });
assert.equal(spawned, 1);
assert.equal(checked.code, 0);
assert.deepEqual(inherited, original);
assert.deepEqual(runPreflightCheck([], { env: {}, spawnProcess: () => ({ status: null, error: Error('fixture spawn error') }) }),
  { code: null, error: 'fixture spawn error' });

// Start all independent read-only gates before waiting for any one to finish.
const pending = [], started = [];
const parallel = checkSource(args => new Promise(resolve => { started.push(args); pending.push(resolve); }));
assert.equal(started.length, 3);
assert.deepEqual(started, sourceChecks);
pending.forEach((resolve, index) => resolve({ args: sourceChecks[index], code: index === 1 ? 1 : 0 }));
assert.equal((await parallel).passed, false, 'A lint failure must block the combined gate');
assert.equal((await checkSource(async args => ({ args, code: 0 }))).passed, true);
assert.equal((await checkSource(async args => ({ args, code: 0, error: 'spawn failed' }))).passed, false);

const windows = preflightChecks('win32');
assert.equal(windows.length, 5);
assert.deepEqual(windows[2], ['test/e2e/e2e-packaged-proxy.mjs', '--electron']);
assert.deepEqual(windows[3], ['test/e2e/e2e-packaged-proxy.mjs', '--electron', '--expect-direct']);
assert.deepEqual(windows[4], ['test/e2e/e2e-ui-motion.mjs']);
assert.deepEqual(preflightChecks('linux'), windows.slice(0, 2));

const order = [], fingerprints = [];
const good = await runReleasePreflight({ platform: 'win32', reportPath: null,
  fingerprint: async () => { fingerprints.push(order.length); return 'same-input'; },
  run: async args => { order.push(args); return { code: 0 }; },
});
assert.equal(good.passed, true);
assert.deepEqual(order, windows);
assert.deepEqual(fingerprints, [0, 5], 'Fingerprint must bracket all checks, including GUI');
assert.equal(good.inputFingerprint, good.endInputFingerprint);
assert.ok(Number.isFinite(Date.parse(good.startedAt)) && Number.isFinite(Date.parse(good.finishedAt)));
assert.equal(good.results.length, 5);
assert.ok(good.results.every(result => result.durationMs >= 0));

let calls = 0;
const failed = await runReleasePreflight({ platform: 'win32', reportPath: null,
  fingerprint: async () => 'same-input', run: async () => ({ code: ++calls === 2 ? 1 : 0 }),
});
assert.equal(failed.passed, false);
assert.equal(calls, 2, 'No GUI checks after a failed source regression');
let revision = 0;
const changed = await runReleasePreflight({ platform: 'linux', reportPath: null,
  fingerprint: async () => String(++revision), run: async () => ({ code: 0 }),
});
assert.equal(changed.passed, false);
assert.match(changed.error, /inputs changed/);
const thrown = await runReleasePreflight({ reportPath: null, fingerprint: async () => { throw Error('unreadable input'); } });
assert.equal(thrown.passed, false);
assert.match(thrown.error, /unreadable input/);

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const steps = ci.jobs.check.steps;
assert.equal(steps.filter(step => step.run === 'node scripts/check-source.mjs').length, 1);
assert.equal(steps.filter(step => step.run === 'npm run test:regressions').length, 1);
assert.ok(!steps.some(step => step.run?.includes('node test/check-touch-script.mjs')), 'The regression runner already covers touch script syntax');
assert.ok(steps.some(step => step.uses === 'actions/cache@v4' && step.with?.key === 'ubuntu-24.04-document-font-gbsn00lp-v1'));
assert.ok(steps.some(step => step.run?.includes('sudo apt-get update') && step.if === "steps.font-cache.outputs.cache-hit != 'true'"));
assert.ok(steps.some(step => step.run?.includes('hasGlyphForCodePoint')));
assert.equal(ci.concurrency['cancel-in-progress'], true);
console.log('PASS release preflight: parallel static gates, serial functional/GUI gates, failure short-circuit, stable-input evidence, CI font cache and retained coverage');
