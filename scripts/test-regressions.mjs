import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local regressions: bundled/offline Pi only; no saved accounts, GUI or Office installation required.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'verify-env-proxy', 'verify-pi-command', 'verify-bundled-pi', 'verify-environment-detection', 'verify-environment-manager', 'verify-video-generation',
  'verify-video-domestic', 'verify-video-international', 'verify-video-platforms', 'verify-video-apimart', 'verify-video-pricing', 'verify-video-workflow', 'verify-video-billing',
  'verify-session-integrity', 'verify-startup', 'verify-startup-runtime', 'verify-project-selection', 'verify-account-integrity', 'verify-server-delete',
  'verify-composer-events', 'verify-office-protocol', 'verify-ipc-sender',
  'verify-session-queue', 'verify-preview-races', 'verify-preview-refresh', 'verify-preview-motion',
  'verify-preview-file', 'verify-preview-inspection', 'verify-workspace-path',
  'verify-trusted-ui-url', 'verify-thinking-batch', 'verify-user-message',
  'verify-office', 'verify-office-failures', 'verify-office-efficiency',
].map(name => `test/${name}.mjs`);
tests.push('test/check-touch-script.mjs', 'test/e2e/verify-stream-render.mjs');
const results = [];
for (const file of tests) {
  const started = Date.now();
  console.log(`RUN ${file}`);
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 150000 });
  if (result.error) console.error(result.error.message);
  results.push({ file, code: result.status, error: result.error?.message, durationMs: Date.now() - started });
}
const passed = results.filter(result => result.code === 0 && !result.error).length;
mkdirSync(path.join(root, 'test/results'), { recursive: true });
writeFileSync(path.join(root, 'test/results/regressions.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`REGRESSIONS ${passed}/${tests.length} passed`);
process.exitCode = passed === tests.length ? 0 : 1;
