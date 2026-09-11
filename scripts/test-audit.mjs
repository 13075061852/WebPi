import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const tests = [
  'scripts/check-syntax.mjs',
  ...readdirSync('test').filter(name => /^verify-.*\.mjs$/.test(name)).sort().map(name => 'test/' + name),
  'test/check-touch-script.mjs', 'test/e2e/verify-stream-render.mjs',
  ...['e2e-message-input', 'e2e-session-restore', 'e2e-render', 'e2e-terminals', 'e2e-themes', 'e2e-device-touch', 'e2e-history-performance'].map(name => 'test/e2e/' + name + '.mjs'),
];
const results = [];
mkdirSync('test/results', { recursive: true });
for (const file of tests) {
  const started = Date.now();
  console.log('\nRUN ' + file);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const collect = data => { output += data.toString(); process.stdout.write(data); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, output: output + error.message, timedOut }); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
  writeFileSync(path.join('test/results', path.basename(file) + '.log'), result.output);
  results.push({ file, code: result.code, timedOut: result.timedOut, durationMs: Date.now() - started });
  writeFileSync('test/results/audit.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (result.code !== 0 || result.timedOut) { process.exitCode = 1; break; }
}
console.log('\nAUDIT', results.filter(r => r.code === 0).length + '/' + tests.length, 'passed');
