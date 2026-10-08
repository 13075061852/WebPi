import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Invalid theme image');
}

export function createThemeImages({ manifest, cacheDir, fetcher }) {
  const pending = new Map();
  async function load(entry) {
    const file = path.join(cacheDir, createHash('sha256').update(entry.url).digest('hex'));
    try {
      const bytes = await fs.readFile(file);
      return { bytes, type: imageType(bytes) };
    } catch { /* Missing or invalid cache: retry the public image. */ }
    const response = await fetcher(entry.url, { credentials: 'omit', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Theme download failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new Error('Theme image too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks), type = imageType(bytes);
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file + '.tmp', bytes);
      await fs.rename(file + '.tmp', file);
    } catch { /* A full/read-only cache must not prevent displaying the downloaded image. */ }
    return { bytes, type };
  }
  return async request => {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    if (url.hostname !== 'images' || !Object.hasOwn(manifest, key)) return new Response(null, { status: 404 });
    try {
      if (!pending.has(key)) pending.set(key, load(manifest[key]).finally(() => pending.delete(key)));
      const { bytes, type } = await pending.get(key);
      return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      // CSS keeps the selected theme's base colour when the first download is offline.
      return new Response(null, { status: 503 });
    }
  };
}
