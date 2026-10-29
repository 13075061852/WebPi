import pty from "node-pty";
import crypto from "node:crypto";
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import fs from 'node:fs';

export class TerminalPool {
  constructor(send, memory = null) { this.send = send; this.memory = memory; this.sessions = new Map(); this.closing = new Set(); }
  start({ id = crypto.randomUUID(), cwd, project = cwd, name = '终端', cols = 100, rows = 30 }) {
    if (this.sessions.has(id)) throw new Error("终端已存在");
    if (this.sessions.size >= 24) throw new Error("最多同时开启 24 个终端");
    const saved = this.memory?.open({ id, project, cwd, name, cols, rows });
    // Preserve a shell boundary in the transcript, so a later ConPTY clear-screen
    // repaint cannot overwrite earlier sessions when the combined log is replayed.
    this.memory?.append(id, '\x1bc');
    if (saved && fs.existsSync(saved.cwd) && fs.statSync(saved.cwd).isDirectory()) cwd = saved.cwd;
    const child = pty.spawn(process.env.ComSpec || "cmd.exe", ["/Q", "/D"], {
      name: "xterm-256color", cols, rows, cwd,
      env: { ...process.env, PROMPT: (process.env.PROMPT || '$P$G') + '$E]9;9;$P$E\\' }, useConpty: true,
    });
    const rec = { id, cwd, child, cols, rows, queue: "", pending: 0, timer: null, cwdControl: '' };
    rec.exited = new Promise(resolve => { rec.resolveExit = resolve; });
    this.sessions.set(id, rec);
    const flush = () => {
      clearTimeout(rec.timer); rec.timer = null;
      if (!rec.queue) return;
      const data = rec.queue; rec.queue = "";
      this.send("halo:pty-out", { id, data });
    };
    child.onData(data => {
      this.memory?.append(id, data);
      // CMD emits its current directory with each prompt, including after cd /d.
      rec.cwdControl = (rec.cwdControl + data).slice(-16384);
      const markers = [...rec.cwdControl.matchAll(/\x1b\]9;9;([^\x1b\x07]+)(?:\x07|\x1b\\)/g)];
      if (markers.length) {
        rec.cwd = markers.at(-1)[1]; this.memory?.update(id, { cwd: rec.cwd });
        rec.cwdControl = rec.cwdControl.slice(markers.at(-1).index + markers.at(-1)[0].length);
      }
      rec.queue += data; rec.pending += data.length;
      if (rec.pending >= 262144) child.pause();
      if (rec.queue.length >= 32768) flush();
      else if (!rec.timer) rec.timer = setTimeout(flush, 16);
    });
    child.onExit(({ exitCode }) => {
      if (!rec.preserveExit) this.memory?.update(id, { exited: true });
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
      this.memory?.update(id, { cols, rows });
    }
  }
  ack({ id, size }) {
    const rec = this.sessions.get(id);
    if (!rec || !Number.isFinite(size) || size < 0) return;
    rec.pending = Math.max(0, rec.pending - size);
    if (rec.pending < 65536) rec.child.resume();
  }
  kill(id, { forget = true } = {}) {
    if (forget) this.memory?.remove(id);
    const rec = this.sessions.get(id);
    if (!rec) return Promise.resolve();
    rec.preserveExit = !forget;
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
    this.memory?.flush();
    const current = [...this.sessions.keys()].map(id => this.kill(id, { forget: false }));
    return Promise.all([...current,...this.closing]);
  }
}

