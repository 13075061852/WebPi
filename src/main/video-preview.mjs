import fs from 'node:fs';
import { Readable } from 'node:stream';

// Byte ranges allow playback and seeking without buffering the complete video.
export function videoResponse(request, file, size, mime) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  if (!size || size > 512 * 1024 * 1024) return new Response(null, { status: 413 });
  const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  let start = 0, end = size - 1, status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = String(end - start + 1);
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const stream = fs.createReadStream(file, { start, end });
  const abort = () => stream.destroy();
  request.signal?.addEventListener('abort', abort, { once: true });
  stream.on('close', () => request.signal?.removeEventListener('abort', abort));
  if (request.signal?.aborted) abort();
  return new Response(Readable.toWeb(stream), { status, headers });
}
