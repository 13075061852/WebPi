// One-time maintenance upload. The application only needs the returned public URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'assets/theme-images.json');
const key = process.env.STARIMG_API_KEY;
if (!key) throw new Error('Set STARIMG_API_KEY before uploading');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => '{}'));
for (const entry of await fs.readdir(path.join(root, 'assets/themes'), { recursive: true })) {
  if (!/\.(png|webp)$/i.test(entry)) continue;
  const relative = `themes/${entry.replaceAll('\\', '/')}`;
  const file = path.join(root, 'assets', relative);
  const data = await fs.readFile(file);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (manifest[relative]?.sha256 === sha256) continue;
  const result = JSON.parse(execFileSync('curl.exe', [
    '--silent', '--show-error', '--fail-with-body', '--max-time', '90',
    'https://starimg.vip/api/upload', '-H', `X-API-Key: ${key}`, '-F', `file=@${file}`,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  if (!result.success || !result.url?.startsWith('https://')) throw new Error(`Upload failed: ${relative}`);
  manifest[relative] = { url: result.url, sha256, bytes: data.length };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Uploaded ${relative}`);
}
