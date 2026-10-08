import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThemeImages } from '../src/main/theme-images.mjs';

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-themes-'));
try {
  const png = await fs.readFile(new URL('../assets/icon-rounded.png', import.meta.url));
  const manifest = { 'themes/test.png': { url: 'https://example.test/image.png' } };
  let calls = 0;
  const handler = createThemeImages({ manifest, cacheDir, fetcher: async () => {
    calls++;
    return new Response(png);
  } });
  const request = { url: 'halo-theme://images/themes/test.png' };
  const responses = await Promise.all([handler(request), handler(request)]);
  assert.equal(calls, 1, 'Concurrent requests share a download');
  assert.equal(responses[0].headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await responses[1].arrayBuffer()), png);
  const offline = createThemeImages({ manifest, cacheDir, fetcher: () => { throw Error('offline'); } });
  assert.equal((await offline(request)).status, 200, 'Cache survives a new app session offline');
  assert.equal((await offline({ url: 'halo-theme://images/unknown' })).status, 404);
  await fs.rm(cacheDir, { recursive: true, force: true });
  assert.equal((await offline(request)).status, 503, 'First offline load falls back without crashing');
  const invalid = createThemeImages({ manifest, cacheDir, fetcher: async () => new Response('<html>blocked</html>') });
  assert.equal((await invalid(request)).status, 503, 'Reject non-image responses');
  console.log('PASS theme image download, deduplication, persistent offline cache, allowlist and failure handling');
} finally {
  await fs.rm(cacheDir, { recursive: true, force: true });
}
