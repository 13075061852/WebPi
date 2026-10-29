import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalMemory } from '../src/main/terminal-memory.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-terminal-memory-'));
const directory = path.join(fixture, 'memory'), project = path.join(fixture, 'project');
try {
  let memory = new TerminalMemory(directory);
  memory.open({ id: 'first', project, cwd: project, name: '终端 1', cols: 80, rows: 24 });
  memory.open({ id: 'second', project, cwd: project, name: '终端 2', cols: 80, rows: 24 });
  memory.open({ id: 'other', project: fixture, cwd: fixture, name: '终端 1', cols: 80, rows: 24 });
  memory.append('first', 'echo 中文命令\r\n中文输出\r\n');
  memory.command({ id: 'first', command: 'echo 中文命令' });
  memory.command({ id: 'first', command: 'echo 中文命令' });
  memory.command({ id: 'first', command: 'bad\rinput' });
  memory.append('second', 'other output');
  memory.view({ project, activeId: 'second', open: true, tiled: true });
  memory.update('first', { cwd: fixture, cols: 120, rows: 40 });
  memory.flush();
  memory = new TerminalMemory(directory);
  let saved = memory.list(project);
  assert.equal(saved.terminals.length, 2);
  assert.equal(saved.terminals[0].output, 'echo 中文命令\r\n中文输出\r\n');
  assert.equal(saved.terminals[0].cwd, fixture);
  assert.deepEqual(saved.terminals[0].commands, ['echo 中文命令']);
  assert.equal(saved.terminals[0].cols, 120);
  assert.equal(saved.activeId, 'second'); assert.equal(saved.tiled, true); assert.equal(saved.open, true);
  assert.equal(memory.list(fixture).terminals.length, 1);
  assert.throws(() => memory.open({ id: 'first', project: fixture, cwd: fixture }), /其它项目/);
  assert.throws(() => memory.open({ id: '../escape', project, cwd: project }), /无效/);
  memory.append('first', 'pending output'); memory.remove('first'); memory.flush();
  assert.equal(fs.existsSync(path.join(directory, 'first.log')), false);
  memory = new TerminalMemory(directory);
  saved = memory.list(project);
  assert.deepEqual(saved.terminals.map(r => r.id), ['second']);
  memory.append('second', 'long output\n'.repeat(500000)); memory.flush();
  assert.ok(fs.statSync(path.join(directory, 'second.log')).size > 4 * 1024 * 1024, 'Complete transcript stays on disk');
  assert.ok(memory.list(project).terminals[0].output.length <= 4 * 1024 * 1024, 'Restore payload stays bounded');
  memory.remove('second'); memory.flush();
  assert.equal(new TerminalMemory(directory).list(project).terminals.length, 0);
  console.log('PASS terminal transcripts, cwd, tab metadata, project isolation, close deletion, restart and bounded restore');
} finally {
  if (path.dirname(path.resolve(fixture)) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('halo-terminal-memory-')) throw Error('Unsafe fixture cleanup');
  fs.rmSync(fixture, { recursive: true, force: true });
}
