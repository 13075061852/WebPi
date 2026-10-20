import pty from "node-pty";
import crypto from "node:crypto";
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';

export class TerminalPool {
  constructor(send) { this.send = send; this.sessions = new Map(); this.closing = new Set(); }
  start({ id = crypto.randomUUID(), cwd, cols = 100, rows = 30 }) {
    if (this.sessions.has(id)) throw new Error("终端已存在");
    if (this.sessions.size >= 24) throw new Error("最多同时开启 24 个终端");
    const child = pty.spawn(process.env.ComSpec || "cmd.exe", ["/Q", "/D"], {
      name: "xterm-256color", cols, rows, cwd, env: { ...process.env }, useConpty: true,
    });
    const rec = { id, cwd, child, cols, rows, queue: "", pending: 0, timer: null };
    rec.exited = new Promise(resolve => { rec.resolveExit = resolve; });
    this.sessions.set(id, rec);
    const flush = () => {
      clearTimeout(rec.timer); rec.timer = null;
      if (!rec.queue) return;
      const data = rec.queue; rec.queue = "";
      this.send("halo:pty-out", { id, data });
    };
    child.onData(data => {
      rec.queue += data; rec.pending += data.length;
      if (rec.pending >= 262144) child.pause();
      if (rec.queue.length >= 32768) flush();
      else if (!rec.timer) rec.timer = setTimeout(flush, 16);
    });
    child.onExit(({ exitCode }) => {
      rec.resolveExit();
      flush();
      if (this.sessions.get(id) === rec) this.sessions.delete(id);
      this.send("halo:pty-exit", { id, exitCode });
    });
    return { id, cwd, pid: child.pid, ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: Number(os.release().split('.')[2]) } } : {}) };
  }
  write({ id, data }) { this.sessions.get(id)?.child.write(String(data)); }
  resize({ id, cols, rows }) {
    const rec = this.sessions.get(id);
    if (rec && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 1 && cols <= 1000 && rows <= 1000 && (rec.cols !== cols || rec.rows !== rows)) {
      rec.child.resize(cols, rows); rec.cols = cols; rec.rows = rows;
    }
  }
  ack({ id, size }) {
    const rec = this.sessions.get(id);
    if (!rec || !Number.isFinite(size) || size < 0) return;
    rec.pending = Math.max(0, rec.pending - size);
    if (rec.pending < 65536) rec.child.resume();
  }
  kill(id) {
    const rec = this.sessions.get(id);
    if (!rec) return Promise.resolve();
    this.sessions.delete(id); clearTimeout(rec.timer);
    if (process.platform === 'win32') {
      execFile(path.join(process.env.SystemRoot || 'C:/Windows','System32/taskkill.exe'),
        ['/pid',String(rec.child.pid),'/T','/F'],{windowsHide:true,timeout:7000},() => {
          // Avoid node-pty's asynchronous console-list helper after the console
          // has already exited. Native exit events release the handles normally.
          try { process.kill(rec.child.pid,0); rec.child.kill(); } catch { rec.resolveExit(); }
        });
    } else {
      try { rec.child.kill(); } catch { rec.resolveExit(); }
    }
    const completion = new Promise(resolve => {
      const timer = setTimeout(resolve, 8000);
      rec.exited.then(() => { clearTimeout(timer); resolve(); });
    });
    this.closing.add(completion);
    void completion.finally(() => this.closing.delete(completion));
    return completion;
  }
  dispose() {
    const current = [...this.sessions.keys()].map(id => this.kill(id));
    return Promise.all([...current,...this.closing]);
  }
}

