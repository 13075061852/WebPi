import ssh2 from 'ssh2';
const { Client } = ssh2;
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

export class ServerManager {
  previews = new Map();
  previewRequests = new Map();
  async preview(id, item) {
    if (!/^TCP6?$/i.test(item?.protocol || '')) throw Error('只有 TCP 网页服务支持预览');
    let address = String(item?.address || '').replace(/^\[|\]$/g, '');
    if (['*', '0.0.0.0', '::', ''].includes(address)) address = address === '::' ? '::1' : '127.0.0.1';
    const key = JSON.stringify([id, address, Number(item?.port)]);
    if (this.previewRequests.has(key)) return this.previewRequests.get(key);
    const pending = this.openPreview(id, item).finally(() => this.previewRequests.delete(key));
    this.previewRequests.set(key, pending); return pending;
  }
  async openPreview(id, item) {
    const port = Number(item?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^TCP6?$/i.test(item?.protocol || '')) throw Error('只有 TCP 网页服务支持预览');
    let host = String(item.address || '').replace(/^\[|\]$/g, '');
    if (['*', '0.0.0.0', '::', ''].includes(host)) host = host === '::' ? '::1' : '127.0.0.1';
    if (!net.isIP(host)) throw Error('无效的监听地址');
    const key = JSON.stringify([id, host, port]);
    if (this.previews.has(key)) return this.previews.get(key).url;
    await this.connect(id);
    const client = this.clients.get(id), sockets = new Set();
    if (!client) throw Error('服务器已断开连接');
    const listener = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      client.forwardOut('127.0.0.1', socket.remotePort || 0, host, port, (error, stream) => {
        if (error || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
        stream.on('error', () => socket.destroy()); socket.on('close', () => stream.destroy());
        stream.pipe(socket).pipe(stream);
      });
    });
    let closed = false;
    const pendingProbes = new Set();
    const ensureOpen = () => { if (closed || this.clients.get(id) !== client) throw Error('服务器预览连接已关闭'); };
    const close = () => {
      if (closed) return;
      closed = true;
      listener.close();
      for (const cancel of pendingProbes) cancel();
      pendingProbes.clear();
      for (const socket of sockets) socket.destroy();
      client.removeListener('close', close);
      if (this.previews.get(key)?.close === close) this.previews.delete(key);
    };
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    client.once('close', close);
    try {
    ensureOpen();
    this.previews.set(key, { id, close, url: null });
    const base = '127.0.0.1:' + listener.address().port;
    const probe = (scheme, destination = base) => new Promise(resolve => {
      ensureOpen();
      const request = (scheme === 'https' ? https : http).request(scheme + '://' + destination, { method: 'GET' }, response => { response.resume(); resolve(true); });
      const cancel = () => { request.destroy(); resolve(false); };
      pendingProbes.add(cancel);
      request.once('close', () => pendingProbes.delete(cancel));
      request.setTimeout(4000, cancel); request.on('error', () => resolve(false)); request.end();
    });
    let scheme = await probe('https') ? 'https' : null;
    ensureOpen();
    if (!scheme) {
      // Certificate identity comes from the authenticated SSH tunnel, never the public network.
      const fingerprint = await new Promise(resolve => {
        const socket = tls.connect({host:'127.0.0.1', port:listener.address().port, rejectUnauthorized:false}, () => {
          const value = socket.getPeerCertificate().fingerprint256;
          socket.destroy(); resolve(value || null);
        });
        const cancel = () => { socket.destroy(); resolve(null); };
        pendingProbes.add(cancel);
        socket.once('close', () => pendingProbes.delete(cancel));
        socket.setTimeout(4000, cancel);
        socket.on('error', () => resolve(null));
      });
      ensureOpen();
      if (fingerprint) {
        const url = 'https://' + base + '/';
        this.previews.set(key, {id, url, fingerprint, close}); return url;
      }
    }
    if (!scheme) {
      const row = this.list().find(s => s.id === id);
      const publicHost = row?.host.includes(':') ? '[' + row.host + ']' : row?.host;
      // Inspect only the certificate here; no HTTP data or credentials are sent.
      // Any discovered hostname must resolve to this server and pass normal TLS validation.
      const names = !row ? [] : await new Promise(resolve => {
        const socket = tls.connect({host: row.host, port, rejectUnauthorized: false}, () => {
          const alt = socket.getPeerCertificate().subjectaltname || '';
          socket.destroy(); resolve(alt.split(', ').filter(n => n.startsWith('DNS:')).map(n => n.slice(4)).filter(n => /^[a-z0-9.-]+$/i.test(n)).slice(0, 5));
        });
        const cancel = () => { socket.destroy(); resolve([]); };
        pendingProbes.add(cancel);
        socket.once('close', () => pendingProbes.delete(cancel));
        socket.setTimeout(4000, cancel); socket.on('error', () => resolve([]));
      });
      ensureOpen();
      for (const name of names) {
        try {
          const [target, candidate] = await Promise.all([lookup(row.host, {all:true}), lookup(name, {all:true})]);
          if (!candidate.some(a => target.some(b => a.address === b.address))) continue;
          ensureOpen();
          if (await probe('https', name + ':' + port)) {
            ensureOpen();
            const url = 'https://' + name + ':' + port + '/';
            this.previews.set(key, {id, url, close}); return url;
          }
        } catch { /* Try the next verified address. */ }
      }
      ensureOpen();
      if (publicHost && await probe('https', publicHost + ':' + port)) {
        ensureOpen();
        const url = 'https://' + publicHost + ':' + port + '/';
        this.previews.set(key, {id, url, close}); return url;
      }
    }
    ensureOpen();
    if (!scheme && await probe('http')) scheme = 'http';
    ensureOpen();
    if (!scheme) { close(); client.removeListener('close', close); throw Error('该端口不是可访问的网页服务，或 HTTPS 证书无法验证'); }
    const url = scheme + '://' + base + '/';
    this.previews.set(key, {id, url, close}); return url;
    } catch (error) { close(); throw error; }
  }
  latencyCache = new Map();
  latencyRequests = new Map();
  async latency(id, force = false) {
    const row = (this.store.data.servers || []).find(s => s.id === id);
    if (!row) throw Error('服务器不存在');
    const key = JSON.stringify([id, row.host, row.port]);
    const cached = this.latencyCache.get(key);
    if (!force && cached && Date.now() - cached.checkedAt < 60000) return cached;
    if (this.latencyRequests.has(key)) return this.latencyRequests.get(key);
    const pending = new Promise(resolve => {
      const started = performance.now();
      const socket = new net.Socket();
      let done = false;
      const finish = status => {
        if (done) return; done = true;
        clearTimeout(timer); socket.destroy();
        const result = { id, status, ms: status === 'ok' ? Math.max(1, Math.round(performance.now()-started)) : null, checkedAt: Date.now() };
        this.latencyCache.set(key, result); resolve(result);
      };
      const timer = setTimeout(() => finish('timeout'), 4000);
      socket.once('connect', () => finish('ok'));
      socket.once('error', () => finish('unreachable'));
      try { socket.connect(row.port, row.host); } catch { finish('unreachable'); }
    }).finally(() => this.latencyRequests.delete(key));
    this.latencyRequests.set(key, pending);
    return pending;
  }
  async latencies(force = false) {
    const ids = this.list().map(s => s.id), results = [];
    await Promise.all(Array.from({length: Math.min(4, ids.length)}, async () => {
      while (ids.length) { const id = ids.shift(); try { results.push(await this.latency(id, force)); } catch {} }
    }));
    return results;
  }

  constructor(store, seal, unseal) { this.store = store; this.seal = seal; this.unseal = unseal; this.clients = new Map(); }
  list() { return (this.store.data.servers || []).map(({ secret: _secret, ...s }) => ({ ...s, connected: this.clients.has(s.id) })); }
  save(input) {
    const name = String(input.name || '').trim(), host = String(input.host || '').trim(), username = String(input.username || '').trim();
    const port = Number(input.port || 22);
    if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('请填写名称、地址、用户名和有效端口');
    const rows = this.store.data.servers || [];
    const previous = input.id ? rows.find(s => s.id === input.id) : null;
    if (input.id && !previous) throw Error('服务器不存在');
    const auth = input.auth === 'key' ? 'key' : 'password';
    if (!input.secret && (!previous || auth !== previous.auth)) throw Error('请填写密码或私钥文件路径');
    const secret = input.secret ? this.seal(String(input.secret)) : previous.secret;
    if (!secret) throw Error('系统凭据加密不可用，无法保存服务器');
    const row = { id: previous?.id || crypto.randomUUID(), name, host, username, port, auth, secret };
    if (previous && previous.host === host && previous.port === port) row.fingerprint = previous.fingerprint;
    const changed = previous && (previous.host !== host || previous.port !== port || previous.username !== username || previous.auth !== auth || !!input.secret);
    if (changed) this.disconnect(previous.id);
    this.store.set('servers', previous ? rows.map(s => s.id === row.id ? row : s) : [...rows, row]);
    return this.list();
  }
  reorder(ids) {
    const rows = this.store.data.servers || [];
    if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== rows.length || ids.some(id => !rows.some(s => s.id === id))) throw Error('服务器列表已变化，请刷新后重试');
    this.store.set('servers', ids.map(id => rows.find(s => s.id === id)));
    return this.list();
  }
  disconnect(id) { this.connectionRequests.get(id)?.cancel(); this.connectionRequests.delete(id); for (const preview of this.previews.values()) if (preview.id === id) preview.close(); this.clients.get(id)?.end(); this.clients.delete(id); }
  remove(id) { this.disconnect(id); this.store.set('servers', (this.store.data.servers || []).filter(s => s.id !== id)); return this.list(); }
  connectionRequests = new Map();
  async connect(id) {
    if (this.clients.has(id)) return;
    if (this.connectionRequests.has(id)) return this.connectionRequests.get(id).promise;
    const row = (this.store.data.servers || []).find(s => s.id === id);
    if (!row) throw Error('服务器不存在');
    const secret = this.unseal(row.secret);
    if (!secret) throw Error('无法解密凭据，请重新添加服务器');
    const client = new Client();
    const request = { client, cancel: null, promise: null };
    this.connectionRequests.set(id, request);
    request.promise = new Promise((resolve, reject) => {
      let fingerprint = '', settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
        client.destroy();
      };
      request.cancel = () => fail(Error('服务器连接已取消'));
      client.on('error', fail);
      client.on('close', () => {
        if (this.clients.get(id) === client) this.clients.delete(id);
        fail(Error('服务器在连接完成前关闭了连接'));
      });
      client.once('ready', () => {
        if (settled) { client.destroy(); return; }
        const current = (this.store.data.servers || []).find(s => s.id === id);
        if (!current || this.connectionRequests.get(id) !== request) { request.cancel(); return; }
        try {
          if (!current.fingerprint) { current.fingerprint = fingerprint; this.store.set('servers', this.store.data.servers); }
          this.clients.set(id, client);
          settled = true;
          resolve();
        } catch (error) { fail(error); }
      });
      try {
        client.connect({ host: row.host, port: row.port, username: row.username, readyTimeout: 15000, keepaliveInterval: 15000,
          ...(row.auth === 'key' ? { privateKey: fs.readFileSync(secret) } : { password: secret }),
          hostHash: 'sha256', hostVerifier: hash => { fingerprint = hash; return !row.fingerprint || row.fingerprint === hash; },
        });
      } catch (error) { fail(error); }
    }).finally(() => {
      if (this.connectionRequests.get(id) === request) this.connectionRequests.delete(id);
    });
    return request.promise;
  }

  async exec(id, command, signal) {
    if (signal?.aborted) throw Error('已取消');
    await this.connect(id);
    if (signal?.aborted) throw Error('已取消');
    const client = this.clients.get(id);
    if (!client) throw Error('服务器已断开连接');
    return new Promise((resolve, reject) => {
      let stream, settled = false, output = '', truncated = false;
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      const append = text => {
        const remaining = 200000 - output.length;
        if (text.length > remaining) truncated = true;
        output += text.slice(0, remaining);
      };
      const onData = data => append(stdout.write(data));
      const onStderr = data => append(stderr.write(data));
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        stream?.removeListener('data', onData);
        stream?.stderr.removeListener('data', onStderr);
        if (error) reject(error);
        else {
          append(stdout.end()); append(stderr.end());
          resolve({ code, output: output + (truncated ? '\n[输出已截断]' : '') });
        }
      };
      const abort = () => {
        finish(Error('远程命令已取消；已启动的远程后台进程可能继续运行'));
        stream?.close();
      };
      const timer = setTimeout(abort, 120000);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        client.exec(command, (error, channel) => {
          if (error) { finish(error); return; }
          stream = channel;
          stream.on('error', error => { finish(error); stream.close(); });
          if (settled) { stream.close(); return; }
          stream.on('data', onData); stream.stderr.on('data', onStderr);
          stream.once('close', code => finish(null, code));
          if (signal?.aborted) abort();
        });
      } catch (error) { finish(error); }
    });
  }
  dispose() { for (const id of new Set([...this.clients.keys(), ...this.connectionRequests.keys()])) this.disconnect(id); }
}

export function parseListeningPorts(output) {
  return String(output).split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (!/^(tcp|udp)(6)?$/.test(fields[0])) return [];
    // ss: protocol state recv-q send-q local peer process
    // netstat: protocol recv-q send-q local peer [state] pid/program
    const local = fields[/^\d+$/.test(fields[1]) ? 3 : 4];
    const match = local?.match(/^(.*):([0-9]+)$/);
    if (!match) return [];
    const process = line.match(/users:\(\("([^"\n]+)",pid=(\d+)/);
    const fallback = fields.at(-1)?.match(/^(\d+)\/(.+)$/);
    return [{ protocol: fields[0].toUpperCase(), port: Number(match[2]), address: match[1], process: process?.[1] || fallback?.[2] || "未知进程", pid: process?.[2] || fallback?.[1] || "" }];
  }).sort((a,b) => a.port-b.port || a.protocol.localeCompare(b.protocol));
}
