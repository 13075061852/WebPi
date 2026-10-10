import fs from 'node:fs';
import { createHash } from 'node:crypto';

const IMAGE_HASH_LIMIT = 32 * 1024 * 1024;
const VIDEO_HASH_LIMIT = 512 * 1024 * 1024;
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

// Cache only an unchanged file's identity. A failed or changing read leaves the
// file visible without a hash, so it cannot accidentally hide another delivery.
export function createArtifactFileInspector({ statFile = file => fs.promises.stat(file),
  readStream = file => fs.createReadStream(file), maxCacheEntries = 128 } = {}) {
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) throw Error('无效的文件指纹缓存上限');
  const hashes = new Map();
  const contentHash = async (file, stat, limit) => {
    const identity = fingerprint(stat);
    const cached = hashes.get(file);
    if (cached?.identity === identity) {
      hashes.delete(file); hashes.set(file, cached);
      return cached.promise;
    }
    const entry = { identity };
    entry.promise = (async () => {
      try {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of readStream(file)) {
          bytes += chunk.length;
          if (bytes > limit) return undefined;
          hash.update(chunk);
        }
        const after = await statFile(file);
        if (!after.isFile() || bytes !== stat.size || fingerprint(after) !== identity) return undefined;
        return hash.digest('hex');
      } catch { return undefined; }
    })();
    hashes.set(file, entry);
    while (hashes.size > maxCacheEntries) hashes.delete(hashes.keys().next().value);
    const hash = await entry.promise;
    if (!hash && hashes.get(file) === entry) hashes.delete(file);
    return hash;
  };

  return async (file, absolutePath, options) => {
    const stat = await statFile(absolutePath).catch(() => null);
    if (!stat?.isFile()) { hashes.delete(absolutePath); return null; }
    const video = /\.(mp4|webm)$/i.test(absolutePath);
    const media = /\.(mp4|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(absolutePath);
    const result = (options?.mediaMetadata && media) || (options?.videoHashes && video)
      ? { file, bytes: stat.size } : null;
    const limit = options?.videoHashes && video ? VIDEO_HASH_LIMIT
      : options?.imageHashes && /\.(png|jpe?g|webp)$/i.test(absolutePath) ? IMAGE_HASH_LIMIT : 0;
    if (limit && stat.size <= limit) {
      const sha256 = await contentHash(absolutePath, stat, limit);
      if (sha256) return { ...(result || { file }), sha256 };
    }
    return result || file;
  };
}
