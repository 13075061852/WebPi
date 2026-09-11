import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPreviewFile } from '../src/main/read-preview-file.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-read-'));
const file = path.join(dir, 'fixture');
try {
  await fs.writeFile(file, '中文🙂');
  assert.equal((await readPreviewFile(file, 4)).content, '中');
  assert.equal((await readPreviewFile(file, 100)).content, '中文🙂');
  await fs.writeFile(file, 'a'.repeat(1024 * 1024));
  const results = await Promise.all(Array.from({ length: 20 }, () => readPreviewFile(file, 512 * 1024)));
  assert.ok(results.every(r => r.content.length === 512 * 1024 && r.truncated));
  await fs.writeFile(file, 'a\0b');
  await assert.rejects(readPreviewFile(file, 100), /二进制/);
  await fs.writeFile(file, '');
  assert.deepEqual(await readPreviewFile(file, 100), { content: '', truncated: false, size: 0 });
  await assert.rejects(readPreviewFile(dir, 100));
  console.log('PASS async bounded reads, 20 concurrent large files, UTF-8 truncation, binary/empty/directory handling');
} finally { await fs.unlink(file); await fs.rmdir(dir); }
