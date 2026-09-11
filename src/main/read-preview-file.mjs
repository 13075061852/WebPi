import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export async function readPreviewFile(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('只能预览普通文件');
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const truncated = stat.size > limit;
    const decoder = new StringDecoder('utf8');
    const content = decoder.write(buffer.subarray(0, offset)) + (truncated ? '' : decoder.end());
    if (content.includes('\0')) throw Error('二进制文件');
    return { content, truncated, size: stat.size };
  } finally { await handle.close(); }
}
