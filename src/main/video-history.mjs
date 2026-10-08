import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VideoHTTP } from './video-http.mjs';
import { videoResponse } from './video-preview.mjs';

const VIDEO_LIMIT = 512 * 1024 * 1024;
const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm' };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const cwdKey = value => {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export function videoHistoryURL(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Listing history never contacts a provider or a CDN.
export function videoHistoryLocation(job) {
  const result = { cwd: job.cwd || null, file: null, exists: false, available: false, localStatus: 'unknown', url: videoHistoryURL(job.url) };
  if (typeof job.file !== 'string' || !job.file) return result;
  if (!path.isAbsolute(job.file) && !cwdKey(job.cwd)) return { ...result, localStatus: 'unavailable' };
  result.file = path.resolve(job.cwd || '.', job.file);
  try {
    const stat = fs.statSync(result.file);
    result.exists = stat.isFile();
    result.localStatus = 'unavailable';
    if (result.exists && VIDEO_MIME[path.extname(result.file).toLowerCase()] && stat.size > 0 && stat.size <= VIDEO_LIMIT) {
      fs.accessSync(result.file, fs.constants.R_OK);
      result.available = true;
      result.localStatus = 'ready';
    }
  } catch (error) { result.localStatus = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'deleted' : 'unavailable'; }
  return result;
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch {}
}

function boundedVideoStream(body, maxBytes, signal) {
  if (!body) return null;
  const reader = body.getReader();
  let bytes = 0, stopped = false, output;
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const stop = async reason => {
    if (stopped) return;
    stopped = true;
    cleanup();
    try { await reader.cancel(reason); } catch {}
    reader.releaseLock();
  };
  const abort = () => {
    if (stopped) return;
    const error = signal.reason || Error('视频播放已取消');
    output.error(error);
    void stop(error);
  };
  return new ReadableStream({
    start(controller) {
      output = controller;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (stopped) return;
        if (chunk.done) {
          stopped = true;
          cleanup();
          reader.releaseLock();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw Error('视频超过 512 MB');
        controller.enqueue(chunk.value);
      } catch (error) {
        if (stopped) return;
        controller.error(error);
        await stop(error);
      }
    },
    cancel: reason => stop(reason),
  });
}

export class VideoHistory {
  constructor(jobs, { fetchImpl = fetch, tokenLimit = 128, maxBytes = VIDEO_LIMIT } = {}) {
    this.jobs = jobs;
    this.fetch = fetchImpl;
    this.tokenLimit = tokenLimit;
    this.maxBytes = maxBytes;
    this.tokens = new Map();
  }
  find(input) {
    if (!input || typeof input !== 'object' || !input.id || typeof input.provider !== 'string') return null;
    const cwd = cwdKey(input.cwd);
    if (!cwd) return null;
    return this.jobs().find(job => job && job.id === input.id && job.provider === input.provider && cwdKey(job.cwd) === cwd) || null;
  }
  token(job, source) {
    const key = JSON.stringify([job.id, job.provider, cwdKey(job.cwd), source]);
    for (const [token, item] of this.tokens) {
      if (item.key === key) {
        this.tokens.delete(token);
        this.tokens.set(token, item);
        return `halo-preview://video-history/${token}`;
      }
    }
    const token = randomUUID();
    this.tokens.set(token, { key, id: job.id, provider: job.provider, cwd: job.cwd, source });
    if (this.tokens.size > this.tokenLimit) this.tokens.delete(this.tokens.keys().next().value);
    return `halo-preview://video-history/${token}`;
  }
  async remote(job, method, { headers, signal, timeoutMs = 10000 } = {}) {
    let target = videoHistoryURL(job.url);
    if (!target) throw Error('视频地址无效');
    const http = new VideoHTTP({ fetchImpl: this.fetch, network: job.network || 'system' });
    const timeout = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    for (let hop = 0; hop <= 5; hop++) {
      // Deliberately omit provider keys and downloadHeaders, even on API origins.
      const response = await http.raw(target, { method, headers, signal: timeout, redirect: 'manual', timeoutMs });
      if (!REDIRECTS.has(response.status)) return response;
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location || hop === 5) throw Error('视频地址重定向无效');
      target = videoHistoryURL(new URL(location, target).href);
      if (!target) throw Error('视频地址重定向无效');
    }
    throw Error('视频地址重定向无效');
  }
  async probe(job) {
    if (!videoHistoryURL(job.url)) return job.url ? 'unavailable' : 'unknown';
    try {
      let response = await this.remote(job, 'HEAD');
      if ([405, 501].includes(response.status)) {
        await cancelBody(response);
        // Do not consume a body if the CDN ignores Range and returns a full 200.
        response = await this.remote(job, 'GET', { headers: { Range: 'bytes=0-0' } });
      }
      const status = [404, 410].includes(response.status) ? 'expired' : response.ok && Number(response.headers.get('content-length')) <= this.maxBytes ? 'ready' : 'unavailable';
      await cancelBody(response);
      return status;
    } catch { return 'unavailable'; }
  }
  async playback(input) {
    const source = input?.source;
    const job = ['local', 'remote'].includes(source) ? this.find(input) : null;
    if (!job) return { src: null, address: null, source, status: 'unknown' };
    const location = videoHistoryLocation(job);
    const address = source === 'local' ? location.file : location.url;
    const status = source === 'local' ? location.localStatus : await this.probe(job);
    return { src: status === 'ready' ? this.token(job, source) : null, address, source, status };
  }
  async response(request) {
    let item;
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'halo-preview:' || url.hostname !== 'video-history' || url.username || url.password || url.port || url.search || url.hash || !/^\/[\da-f-]{36}$/i.test(url.pathname)) return new Response(null, { status: 404 });
      item = this.tokens.get(url.pathname.slice(1));
    } catch { return new Response(null, { status: 404 }); }
    const job = item && this.find(item);
    if (!job) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    if (item.source === 'local') {
      const location = videoHistoryLocation(job);
      if (!location.available) return new Response(null, { status: location.localStatus === 'deleted' ? 404 : 403 });
      try {
        const stat = await fs.promises.stat(location.file);
        return videoResponse(request, location.file, stat.size, VIDEO_MIME[path.extname(location.file).toLowerCase()]);
      } catch { return new Response(null, { status: 404 }); }
    }
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });
    try {
      const response = await this.remote(job, request.method, { headers: range ? { Range: range } : undefined, signal: request.signal, timeoutMs: 5 * 60 * 1000 });
      const headers = new Headers({ 'cache-control': 'no-store' });
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (!response.ok || Number(headers.get('content-length')) > this.maxBytes) {
        await cancelBody(response);
        headers.delete('content-length');
        headers.delete('content-range');
        return new Response(null, { status: response.ok ? 413 : [403, 404, 410, 416].includes(response.status) ? response.status : 503, headers });
      }
      if (request.method === 'HEAD') {
        await cancelBody(response);
        return new Response(null, { status: response.status, headers });
      }
      return new Response(boundedVideoStream(response.body, this.maxBytes, request.signal), { status: response.status, headers });
    } catch { return new Response(null, { status: 503 }); }
  }
}
