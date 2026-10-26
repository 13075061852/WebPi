import fs from 'node:fs';
import { createInterface } from 'node:readline';

const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
// Cache only compact usage records, never prompts, tool results or attachments.
// Each request still enumerates/stats files to detect additions and removals.
export class UsageSessionReader {
  constructor({ maxFiles = 256, maxRows = 50000 } = {}) {
    this.maxFiles = maxFiles; this.maxRows = maxRows;
    this.cache = new Map(); this.rows = 0; this.reads = 0;
  }
  prune(files) {
    for (const [file, entry] of this.cache) if (!files.has(file)) {
      this.cache.delete(file); this.rows -= entry.rows.length;
    }
  }
  async *read(file) {
    let before;
    try { before = stamp(await fs.promises.stat(file, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const hit = this.cache.get(file);
    if (hit?.stamp === before) {
      this.cache.delete(file); this.cache.set(file, hit);
      for (let index = 0; index < hit.rows.length; index++) {
        if (index && index % 256 === 0) await new Promise(resolve => setImmediate(resolve));
        yield hit.rows[index];
      }
      return;
    }
    if (hit) { this.cache.delete(file); this.rows -= hit.rows.length; }
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // readline does not forward input errors to its async iterator.
    const onError = () => lines.close();
    let readError;
    stream.on('error', error => { readError = error; onError(); });
    let rows = [], count = 0;
    this.reads++;
    try {
      for await (const line of lines) {
        if (++count % 256 === 0) await new Promise(resolve => setImmediate(resolve));
        if (!/"(?:usage|role|type)"\s*:/.test(line)) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        let record;
        const message = obj.message;
        if (obj.type === 'session') record = { type: 'session', cwd: obj.cwd };
        else if (obj.type === 'session_info' && obj.name) record = { type: 'title', title: obj.name };
        else if (message?.role === 'user') record = { type: 'user', title: (typeof message.content === 'string' ? message.content
          : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join(' ')).slice(0, 100) };
        else if (message?.role === 'assistant' && message.usage) {
          const u = message.usage;
          record = { type: 'usage', timestamp: obj.timestamp, provider: message.provider, model: message.model,
            usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: { total: u.cost?.total } } };
        }
        if (!record) continue;
        if (rows) { if (rows.length < this.maxRows) rows.push(record); else rows = null; }
        yield record;
      }
      if (readError) throw readError;
      if (rows && stamp(await fs.promises.stat(file, { bigint: true })) === before) {
        const previous = this.cache.get(file);
        if (previous) this.rows -= previous.rows.length;
        this.cache.set(file, { stamp: before, rows }); this.rows += rows.length;
        while (this.cache.size > this.maxFiles || this.rows > this.maxRows) {
          const oldest = this.cache.keys().next().value;
          this.rows -= this.cache.get(oldest).rows.length; this.cache.delete(oldest);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { lines.close(); stream.destroy(); }
  }
}
