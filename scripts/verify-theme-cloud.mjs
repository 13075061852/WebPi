import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadImage } from '@napi-rs/canvas';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'assets/theme-images.json'), 'utf8'));
const refs = new Set();
for (const file of ['app.css', 'theme-collection.css']) {
  const css = await fs.readFile(path.join(root, 'src/renderer/css', file), 'utf8');
  assert.ok(!css.includes('../../../assets/themes/'));
  for (const match of css.matchAll(/halo-theme:\/\/images\/([^'"\s)]+)/g)) refs.add(match[1]);
}
for (const ref of refs) assert.ok(manifest[ref]?.url.startsWith('https://'), `Missing image: ${ref}`);
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.ok(pkg.build.files.includes('!assets/themes/**/*'));
if (process.argv.includes('--remote')) {
  const queue = [...refs];
  let checked = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const ref = queue.shift();
      const { stdout } = await run('curl.exe', ['-fsSL', '--retry', '1', '--max-time', '30', manifest[ref].url], { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024 });
      const image = await loadImage(stdout);
      assert.ok(image.width > 0 && image.height > 0, `Invalid cloud image: ${ref}`);
      checked++;
    }
  }));
  console.log(`PASS ${checked} public cloud images downloaded and decoded`);
}
console.log(`PASS ${refs.size} theme references and installer exclusion`);
