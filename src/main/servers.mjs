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
    let firstForwardReady;
    const initialForward = new Promise(resolve => { firstForwardReady = resolve; });
    const listener = net.createServer(socket => {
      socket.setNoDelay(true);
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      try {
        client.forwardOut('127.0.0.1', socket.remotePort || 0, host, port, (error, stream) => {
          firstForwardReady();
          if (error || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
          stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy());
          socket.on('close', () => stream.destroy());
          stream.pipe(socket).pipe(stream);
        });
      } catch { firstForwardReady(); socket.destroy(); }
    });
    let closed = false;
    const pendingProbes = new Set();
    const ensureOpen = () => { if (closed || this.clients.get(id) !== client) throw Error('服务器预览连接已关闭'); };
    const close = () => {
      if (closed) return;
      closed = true;
      firstForwardReady();
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
      const localPort = listener.address().port, base = '127.0.0.1:' + localPort;
      // A wall-clock deadline also covers stalled SSH forwarding, DNS and TLS handshakes.
      // Socket inactivity timers alone can restart during a handshake or a trickled response.
      const startProbe = (deadline, operation) => {
        let cancel;
        const promise = new Promise(resolve => {
          let settled = false, resource;
          const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); pendingProbes.delete(cancel); resource?.destroy(); resolve(result);
          };
          cancel = () => finish(null);
          const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
          pendingProbes.add(cancel);
          if (closed || deadline <= performance.now()) { cancel(); return; }
          try {
            resource = operation(finish);
            if (settled) resource?.destroy();
          } catch { finish(null); }
        });
        return { promise, cancel };
      };
      const headerProbe = (scheme, destination, deadline, { method = 'HEAD', direct = false } = {}) => startProbe(deadline, finish => {
        const request = (scheme === 'https' ? https : http).request(scheme + '://' + destination + '/', { method, ...(direct ? { agent: false } : {}) }, response => {
          const upgrade = String(response.headers.upgrade || '');
          const location = String(response.headers.location || '');
          const needsTls = scheme === 'http' && (response.statusCode === 426 || /\b(?:https|tls)\b/i.test(upgrade));
          // TLS listeners can answer plaintext with HTTP 400. Prefer a successful TLS
          // handshake before accepting it, but retain genuine HTTP error/redirect pages.
          const preferTls = scheme === 'http' && (response.statusCode === 400 || /^https:\/\//i.test(location));
          // HEAD avoids downloading the homepage twice. 405/501 still identify an HTTP
          // service. GET is only a fallback for servers that do not answer HEAD; stop
          // either method at headers instead of downloading the page in a probe.
          response.destroy(); finish(needsTls ? null : { scheme, ...(preferTls ? { preferTls: true } : {}) });
        });
        request.on('error', () => finish(null)); request.on('close', () => finish(null)); request.end(); return request;
      });
      const certificateProbe = (destination, destinationPort, deadline) => startProbe(deadline, finish => {
        const socket = tls.connect({ host: destination, port: destinationPort, rejectUnauthorized: false }, () => {
          finish(socket.getPeerCertificate());
        });
        socket.on('error', () => finish(null)); socket.on('close', () => finish(null)); return socket;
      });
      const compatibleHeaders = (scheme, destination, deadline) => {
        let cancelled = false, request = headerProbe(scheme, destination, deadline);
        return {
          cancel: () => { cancelled = true; request.cancel(); },
          promise: (async () => {
            const result = await request.promise;
            if (result || cancelled || closed || deadline <= performance.now()) return result;
            request = headerProbe(scheme, destination, deadline, { method: 'GET' });
            return request.promise;
          })(),
        };
      };
      const firstValid = async probes => {
        const selected = await new Promise(resolve => {
          let remaining = probes.length, deferred = null;
          if (!remaining) { resolve(null); return; }
          for (const probe of probes) probe.promise.then(result => {
            if (result?.preferTls) deferred = result;
            else if (result) resolve(result);
            if (--remaining === 0) resolve(deferred);
          });
        });
        for (const probe of probes) probe.cancel();
        ensureOpen(); return selected;
      };
      const started = performance.now(), deadline = started + this.previewTimeoutMs;
      let httpCancelled = false;
      let httpRequest = headerProbe('http', base, deadline, { direct: true });
      const httpProbe = {
        cancel: () => { httpCancelled = true; httpRequest.cancel(); },
        promise: (async () => {
          const result = await httpRequest.promise;
          if (result || httpCancelled || closed) return result;
          // Give a slow but valid HEAD its full budget. A failed HEAD may mean this
          // endpoint is TLS; finish that negotiation before issuing any fallback GET.
          // This also releases a silent TLS connection on single-threaded HTTP servers.
          if (await secureProbe.promise || httpCancelled || closed) return null;
          httpRequest = headerProbe('http', base, performance.now() + this.previewTimeoutMs, { method: 'GET', direct: true });
          return httpRequest.promise;
        })(),
      };
      // Open the HEAD channel first: a single-threaded HTTP server must not accept a
      // silent TLS ClientHello ahead of its real HTTP request. Once that remote TCP
      // connection exists, HTTP response discovery and TLS negotiation run in parallel.
      const forwardReady = startProbe(deadline, finish => { initialForward.then(() => finish(true)); });
      let tlsCancelled = false, tlsRequest;
      // Certificate identity comes from the authenticated SSH tunnel, never the public network.
      const secureProbe = {
        cancel: () => { tlsCancelled = true; forwardReady.cancel(); tlsRequest?.cancel(); },
        promise: (async () => {
          if (!await forwardReady.promise || tlsCancelled || closed || deadline <= performance.now()) return null;
          tlsRequest = certificateProbe('127.0.0.1', localPort, deadline);
          const certificate = await tlsRequest.promise;
          return certificate?.fingerprint256 ? { scheme: 'https', fingerprint: certificate.fingerprint256 } : null;
        })(),
      };
      const selected = await firstValid([httpProbe, secureProbe]);
      if (selected) {
        const url = selected.scheme + '://' + base + '/';
        this.previews.set(key, { id, url, ...(selected.fingerprint ? { fingerprint: selected.fingerprint } : {}), close });
        return url;
      }
      const row = this.list().find(s => s.id === id);
      if (row) {
        const fallbackDeadline = performance.now() + this.previewTimeoutMs;
        const publicHost = row.host.includes(':') ? '[' + row.host + ']' : row.host;
        // Public certificate discovery is a last resort. DNS candidates must still resolve
        // to this server and every public HTTP request uses normal TLS validation.
        const certificate = await certificateProbe(row.host, port, fallbackDeadline).promise;
        ensureOpen();
        const names = String(certificate?.subjectaltname || '').split(', ').filter(n => n.startsWith('DNS:')).map(n => n.slice(4)).filter(n => /^[a-z0-9.-]+$/i.test(n)).slice(0, 5);
        const probes = names.map(name => {
          let cancelled = false, header;
          const candidate = startProbe(fallbackDeadline, finish => {
            Promise.all([lookup(row.host, { all: true }), lookup(name, { all: true })]).then(([target, addresses]) => {
              finish(addresses.some(a => target.some(b => a.address === b.address)) ? name : null);
            }, () => finish(null));
          });
          return {
            cancel: () => { cancelled = true; candidate.cancel(); header?.cancel(); },
            promise: candidate.promise.then(async verified => {
              if (!verified || cancelled || closed || fallbackDeadline <= performance.now()) return null;
              header = compatibleHeaders('https', name + ':' + port, fallbackDeadline);
              const result = await header.promise;
              return result ? { url: 'https://' + name + ':' + port + '/' } : null;
            }),
          };
        });
        const direct = compatibleHeaders('https', publicHost + ':' + port, fallbackDeadline);
        probes.push({ ...direct, promise: direct.promise.then(result => result ? { url: 'https://' + publicHost + ':' + port + '/' } : null) });
        const fallback = await firstValid(probes);
        // DNS-to-HEAD candidates may have entered their second phase after the DNS probe
        // completed; stop every outstanding request once one validated URL wins.
        for (const cancel of [...pendingProbes]) cancel();
        if (fallback) { this.previews.set(key, { id, url: fallback.url, close }); return fallback.url; }
      }
      throw Error('该端口不是可访问的网页服务，或 HTTPS 证书无法验证');
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

  constructor(store, seal, unseal, { previewTimeoutMs = 4000 } = {}) {
    this.store = store; this.seal = seal; this.unseal = unseal; this.clients = new Map();
    this.previewTimeoutMs = Number.isFinite(previewTimeoutMs) && previewTimeoutMs > 0 ? previewTimeoutMs : 4000;
  }
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
