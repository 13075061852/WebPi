import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local regressions: bundled/offline Pi only; no saved accounts, GUI or Office installation required.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'verify-release-workflow',
  'verify-app-updates', 'verify-image-generation', 'verify-image-card-timing',
  'verify-turn-cost',
  'verify-context-rate', 'verify-compaction-feedback',
  'verify-package-search',
  'verify-icon-library',
  'verify-project-fast-start',
  'verify-env-proxy', 'verify-pi-command', 'verify-bundled-pi', 'verify-environment-detection', 'verify-environment-manager', 'verify-video-generation',
  'verify-video-domestic', 'verify-video-international', 'verify-video-platforms', 'verify-video-apimart', 'verify-video-pricing', 'verify-video-workflow', 'verify-video-billing', 'verify-video-confirmations',
  'verify-session-integrity', 'verify-conversation-meta', 'verify-conversation-switch', 'verify-project-runs', 'verify-startup', 'verify-startup-runtime', 'verify-project-selection', 'verify-account-integrity', 'verify-server-delete',
  'verify-composer-events', 'verify-office-protocol', 'verify-ipc-sender',
  'verify-session-queue', 'verify-preview-races', 'verify-preview-refresh', 'verify-preview-motion',
  'verify-preview-file', 'verify-preview-inspection', 'verify-workspace-path',
  'verify-trusted-ui-url', 'verify-thinking-batch', 'verify-user-message',
  'verify-office', 'verify-office-failures', 'verify-office-efficiency',
].map(name => `test/${name}.mjs`);
tests.push('test/check-touch-script.mjs', 'test/e2e/verify-stream-render.mjs');
const results = [];
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'halo-regressions-'));
// No inherited account, API key or user plugin can make a local test pass
// when the same test would fail on a clean CI runner.
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key)));
Object.assign(testEnv, { HOME:sandbox, USERPROFILE:sandbox, APPDATA:path.join(sandbox,'roaming'),
  LOCALAPPDATA:path.join(sandbox,'local'), PI_CODING_AGENT_DIR:path.join(sandbox,'agent'), PI_OFFLINE:'1' });
for(const dir of [testEnv.APPDATA,testEnv.LOCALAPPDATA,testEnv.PI_CODING_AGENT_DIR]) mkdirSync(dir,{recursive:true});
try {
for (const file of tests) {
  const started = Date.now();
  console.log(`RUN ${file}`);
  const result = spawnSync(process.execPath, [file], { cwd: root, env:testEnv, stdio: 'inherit', windowsHide: true, timeout: 150000 });
  if (result.error) console.error(result.error.message);
  results.push({ file, code: result.status, error: result.error?.message, durationMs: Date.now() - started });
  if (result.status !== 0 || result.error) break;
}
} finally {
  if(path.dirname(path.resolve(sandbox))!==path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('halo-regressions-')) throw Error('Unsafe test cleanup');
  rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
const passed = results.filter(result => result.code === 0 && !result.error).length;
mkdirSync(path.join(root, 'test/results'), { recursive: true });
writeFileSync(path.join(root, 'test/results/regressions.json'), JSON.stringify({ at: new Date().toISOString(), isolated:true, skipped:tests.length-results.length, results }, null, 2));
console.log(`REGRESSIONS ${passed}/${tests.length} passed`);
process.exitCode = passed === tests.length ? 0 : 1;
