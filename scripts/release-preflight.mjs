import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseInputFingerprint } from './release-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function preflightChecks(platform = process.platform) {
  const checks = [['scripts/check-source.mjs'], ['scripts/test-regressions.mjs']];
  // Catch policy and runner-environment failures before paying the installer build cost.
  // GUI checks share a desktop and must never run concurrently.
  if (platform === 'win32') checks.push(
    ['test/e2e/e2e-packaged-proxy.mjs', '--electron'],
    ['test/e2e/e2e-packaged-proxy.mjs', '--electron', '--expect-direct'],
    ['test/e2e/e2e-ui-motion.mjs'],
  );
  return checks;
}

export function sourceCheckEnvironment(env = process.env) {
  // Source gates must exercise this checkout and its installed Electron. A
  // previous packaged smoke run or parent Node hook must not redirect them.
  const executionOverrides = new Set(['HALO_PACKAGED_EXE', 'HALO_TEST_EXECUTABLE',
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'PI_HALO_PI_PATH']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !executionOverrides.has(key.toUpperCase())));
}

export function runPreflightCheck(args, { env = process.env, spawnProcess = spawnSync } = {}) {
  const result = spawnProcess(process.execPath, args, { cwd: root, env: sourceCheckEnvironment(env), stdio: 'inherit', windowsHide: true });
  return { code: result.status, error: result.error?.message };
}

export async function runReleasePreflight({ platform = process.platform, fingerprint = releaseInputFingerprint,
  run = runPreflightCheck, reportPath = path.join(root, 'test/results/release-preflight.json') } = {}) {
  const started = Date.now();
  const report = { passed: false, startedAt: new Date(started).toISOString(), platform, node: process.version, results: [] };
  try {
    report.inputFingerprint = await fingerprint({ root });
    const checks = preflightChecks(platform);
    for (const args of checks) {
      const stepStarted = Date.now();
      const result = await run(args);
      report.results.push({ args, ...result, durationMs: Date.now() - stepStarted });
      if (result.error || result.code !== 0) break;
    }
    report.endInputFingerprint = await fingerprint({ root });
    report.passed = report.results.length === checks.length
      && report.results.every(result => result.code === 0 && !result.error)
      && report.inputFingerprint === report.endInputFingerprint;
    if (report.inputFingerprint !== report.endInputFingerprint) report.error = 'Release inputs changed during preflight; run it again after edits finish.';
  } catch (error) {
    report.error = error.message;
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runReleasePreflight();
  if (report.error) console.error(report.error);
  console.log(`PREFLIGHT ${report.passed ? 'PASS' : 'FAIL'} (${(report.durationMs / 1000).toFixed(1)}s)`);
  process.exitCode = report.passed ? 0 : 1;
}
