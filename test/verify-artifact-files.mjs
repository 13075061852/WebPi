import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactFileInspector } from '../src/main/artifact-files.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-artifact-files-'));
const video = Buffer.from('fixture-video-content-A');
const digest = value => createHash('sha256').update(value).digest('hex');
try {
  const files = ['original.mp4', 'final.webm', 'different.mp4', 'image.png', 'audio.mp3'];
  for (const name of files) fs.writeFileSync(path.join(root, name), name === 'different.mp4' ? Buffer.from('fixture-video-content-B') : video);
  let reads = 0;
  const inspect = createArtifactFileInspector({ readStream: file => { reads++; return fs.createReadStream(file); } });
  const call = (name, options) => inspect(name, path.join(root, name), options);
  assert.equal(await call('original.mp4'), 'original.mp4');
  assert.deepEqual(await call('audio.mp3', { mediaMetadata: true }), { file: 'audio.mp3', bytes: video.length });
  assert.deepEqual(await call('original.mp4', { mediaMetadata: true }), { file: 'original.mp4', bytes: video.length });
  assert.equal(reads, 0, 'Metadata-only calls must not read media content');
  const original = await call('original.mp4', { videoHashes: true });
  assert.deepEqual(original, { file: 'original.mp4', bytes: video.length, sha256: digest(video) });
  const final = await call('final.webm', { videoHashes: true, mediaMetadata: true });
  assert.equal(final.sha256, original.sha256, 'Byte-identical copies must have the same identity across filenames');
  const different = await call('different.mp4', { videoHashes: true });
  assert.equal(different.bytes, original.bytes);
  assert.notEqual(different.sha256, original.sha256, 'Equal size must not imply the same video');
  const before = reads;
  assert.deepEqual(await call('original.mp4', { videoHashes: true }), original);
  assert.equal(reads, before, 'An unchanged file must reuse its hash');
  assert.deepEqual(await call('image.png', { imageHashes: true, mediaMetadata: true }), { file: 'image.png', sha256: digest(video) });
  assert.equal(await call('missing.mp4', { videoHashes: true }), null);
  assert.equal(await inspect('directory', root, { videoHashes: true }), null);

  const originalFile = path.join(root, 'original.mp4');
  fs.writeFileSync(originalFile, Buffer.from('fixture-video-content-C'));
  const future = new Date(Date.now() + 10000); fs.utimesSync(originalFile, future, future);
  assert.equal((await call('original.mp4', { videoHashes: true })).sha256, digest(Buffer.from('fixture-video-content-C')), 'Same-size overwrite must invalidate the cache');

  // Inject timestamp snapshots to exercise ctime and mtime independently on
  // every host, without relying on the filesystem's timestamp precision.
  let snapshot = { dev: 1, ino: 2, size: video.length, mtimeMs: 10, ctimeMs: 10, isFile: () => true };
  let fakeReads = 0;
  const inspectSnapshots = createArtifactFileInspector({ statFile: async () => ({ ...snapshot }),
    readStream: async function* () { fakeReads++; yield video; } });
  await inspectSnapshots('snapshot.mp4', 'snapshot.mp4', { videoHashes: true });
  await inspectSnapshots('snapshot.mp4', 'snapshot.mp4', { videoHashes: true });
  assert.equal(fakeReads, 1);
  snapshot = { ...snapshot, ctimeMs: 11 };
  await inspectSnapshots('snapshot.mp4', 'snapshot.mp4', { videoHashes: true });
  assert.equal(fakeReads, 2, 'ctime-only changes must invalidate the hash');
  snapshot = { ...snapshot, mtimeMs: 11 };
  await inspectSnapshots('snapshot.mp4', 'snapshot.mp4', { videoHashes: true });
  assert.equal(fakeReads, 3, 'mtime-only changes must invalidate the hash');
  snapshot = { ...snapshot, size: video.length + 1 };
  assert.equal((await inspectSnapshots('snapshot.mp4', 'snapshot.mp4', { videoHashes: true })).sha256, undefined, 'A partial/changing read must not identify a complete file');

  let boundedReads = 0;
  const bounded = createArtifactFileInspector({ maxCacheEntries: 2,
    readStream: file => { boundedReads++; return fs.createReadStream(file); } });
  for (const name of ['original.mp4', 'final.webm', 'different.mp4', 'original.mp4']) await bounded(name, path.join(root, name), { videoHashes: true });
  assert.equal(boundedReads, 4, 'The oldest entry must be evicted when the cache reaches its limit');
  let failedReads = 0;
  const failed = createArtifactFileInspector({ readStream: () => { failedReads++; throw Error('fixture read failure'); } });
  for (let i = 0; i < 2; i++) assert.deepEqual(await failed('final.webm', path.join(root, 'final.webm'), { videoHashes: true }), { file: 'final.webm', bytes: video.length });
  assert.equal(failedReads, 2, 'A failed read must leave the file visible and allow a later retry');

  const oversized = createArtifactFileInspector({ statFile: async () => ({ ...snapshot, size: 512 * 1024 * 1024 + 1 }),
    readStream: () => { throw Error('Must not read oversized videos'); } });
  assert.deepEqual(await oversized('large.mp4', 'large.mp4', { videoHashes: true }), { file: 'large.mp4', bytes: 512 * 1024 * 1024 + 1 });
  let changingStat = 0;
  const changing = createArtifactFileInspector({ statFile: async () => ({ ...snapshot, size: video.length, ctimeMs: changingStat++ }),
    readStream: async function* () { yield video; } });
  assert.equal((await changing('changing.mp4', 'changing.mp4', { videoHashes: true })).sha256, undefined, 'Do not cache a file that changes during streaming');
  console.log('PASS artifact file fingerprints, copied and distinct videos, metadata compatibility, cache invalidation/eviction and safe read failures');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-artifact-files-'));
  fs.rmSync(root, { recursive: true, force: true });
}
