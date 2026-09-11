import pty from "node-pty";
import crypto from "node:crypto";

export class TerminalPool {
  constructor(send) { this.send = send; this.sessions = new Map(); }
  start({ id = crypto.randomUUID(), cwd, cols = 100, rows = 30 }) {
    if (this.sessions.has(id)) throw new Error("终端已存在");
    if (this.sessions.size >= 24) throw new Error("最多同时开启 24 个终端");
    const child = pty.spawn(process.env.ComSpec || "cmd.exe", ["/Q", "/D"], {
      name: "xterm-256color", cols, rows, cwd, env: { ...process.env }, useConpty: true,
    });
    const rec = { id, cwd, child, queue: "", pending: 0, timer: null };
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
      flush();
      if (this.sessions.get(id) === rec) this.sessions.delete(id);
      this.send("halo:pty-exit", { id, exitCode });
    });
    return { id, cwd, pid: child.pid };
  }
  write({ id, data }) { this.sessions.get(id)?.child.write(String(data)); }
  resize({ id, cols, rows }) {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 1 && cols <= 1000 && rows <= 1000)
      this.sessions.get(id)?.child.resize(cols, rows);
  }
  ack({ id, size }) {
    const rec = this.sessions.get(id);
    if (!rec || !Number.isFinite(size) || size < 0) return;
    rec.pending = Math.max(0, rec.pending - size);
    if (rec.pending < 65536) rec.child.resume();
  }
  kill(id) {
    const rec = this.sessions.get(id);
    if (!rec) return;
    this.sessions.delete(id); clearTimeout(rec.timer);
    try { rec.child.kill(); } catch { /* already exited */ }
  }
  dispose() { for (const id of this.sessions.keys()) this.kill(id); }
}

