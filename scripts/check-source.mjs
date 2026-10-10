import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const eslint = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');

// These read-only gates can overlap. Functional and GUI tests remain separate.
export const sourceChecks = [
  ['scripts/check-syntax.mjs'],
  [eslint, 'src', 'scripts', 'test', '--max-warnings', '0'],
  ['scripts/check-fixture-portability.mjs'],
];

export function runSourceCheck(args) {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', error => resolve({ args, code: -1, error: error.message, durationMs: Date.now() - started }));
    child.once('close', code => resolve({ args, code, durationMs: Date.now() - started }));
  });
}

export async function checkSource(run = runSourceCheck) {
  const results = await Promise.all(sourceChecks.map(args => run(args)));
  return { passed: results.every(result => result.code === 0 && !result.error), results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkSource();
  for (const result of report.results) console.log(`SOURCE ${result.code === 0 && !result.error ? 'PASS' : 'FAIL'} ${path.basename(result.args[0])} (${(result.durationMs / 1000).toFixed(1)}s)${result.error ? ': ' + result.error : ''}`);
  process.exitCode = report.passed ? 0 : 1;
}
