import fs from 'node:fs';
import path from 'node:path';

const projectKey = value => path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
// Keep the complete transcript on disk; restore a bounded tail into xterm.
const restoreBytes = 4 * 1024 * 1024;
export class TerminalMemory {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'index.json');
    this.pending = new Map(); this.timer = null;
    fs.mkdirSync(directory, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    if (!Array.isArray(this.data.terminals)) this.data.terminals = [];
    this.data.terminals = this.data.terminals.filter(r => validId(r.id) && typeof r.project === 'string' && typeof r.cwd === 'string');
    if (!this.data.views || typeof this.data.views !== 'object') this.data.views = {};
  }
  save() {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.data));
    fs.renameSync(temporary, this.file);
  }
  list(project) {
    const key = projectKey(project);
    this.flush();
    return { terminals: this.data.terminals.filter(r => r.project === key).map(record => {
      let output = '';
      const file = path.join(this.directory, record.id + '.log');
      if (fs.existsSync(file)) {
        const fd = fs.openSync(file, 'r');
        try {
          const size = fs.fstatSync(fd).size, start = Math.max(0, size - restoreBytes);
          const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start);
          output = buffer.toString('utf8');
          // A tail can start inside a UTF-8 character or terminal control sequence.
          if (start) output = output.slice(output.indexOf('\n') + 1);
        } finally { fs.closeSync(fd); }
      }
      return { ...record, output };
    }), ...this.data.views[key] };
  }
  open({ id, project, cwd, name, cols, rows }) {
    if (!validId(id)) throw Error('无效的终端标识');
    const key = projectKey(project), saved = this.data.terminals.find(r => r.id === id);
    if (saved && saved.project !== key) throw Error('终端属于其它项目');
    const record = saved || { id, project: key, cwd, name, cols, rows, commands: [] };
    if (!saved) { this.data.terminals.push(record); this.save(); }
    return record;
  }
  append(id, data) {
    if (!this.data.terminals.some(r => r.id === id)) return;
    this.pending.set(id, (this.pending.get(id) || '') + data);
    this.schedule();
  }
  update(id, values) {
    const record = this.data.terminals.find(r => r.id === id);
    if (record) { Object.assign(record, values); this.schedule(); }
  }
  command({ id, command }) {
    const record = this.data.terminals.find(r => r.id === id);
    if (!record || typeof command !== 'string' || !command.trim() || command.length > 32768 || /[\r\n\x00-\x1f]/.test(command)) return;
    record.commands ||= [];
    if (record.commands.at(-1) !== command) { record.commands.push(command); this.schedule(); }
  }
  view({ project, activeId, open, tiled }) {
    const key = projectKey(project);
    this.data.views[key] = { activeId, open: !!open, tiled: !!tiled };
    this.save();
  }
  remove(id) {
    this.pending.delete(id);
    this.data.terminals = this.data.terminals.filter(r => r.id !== id);
    this.save();
    if (validId(id)) fs.rmSync(path.join(this.directory, id + '.log'), { force: true });
  }
  schedule() { this.timer ||= setTimeout(() => this.flush(), 250); }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    for (const [id, output] of this.pending) fs.appendFileSync(path.join(this.directory, id + '.log'), output);
    this.pending.clear(); this.save();
  }
}
