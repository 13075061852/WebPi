import fs from 'node:fs';
import path from 'node:path';
import { isInsideWorkspace } from './workspace-path.mjs';

const identity = file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const real = file => { try { return identity(fs.realpathSync.native(file)); } catch { return null; } };
function unlinked(file) {
  // Legacy indexes authorize one exact file, never a directory redirected by
  // a new symlink/junction. Configured roots handle intentional aliases above.
  for (let current = file; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return false; } catch { return false; }
    if (path.dirname(current) === current) return true;
  }
}
export function resolveSessionFile(file, { roots, knownFiles = [], liveFiles = [] }) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file) || !/\.jsonl$/i.test(file)) throw Error('不是有效的会话记录文件');
  const absolute = path.resolve(file), key = identity(absolute);
  const live = liveFiles.find(candidate => typeof candidate === 'string' && identity(candidate) === key);
  const target = real(absolute);
  if (!target) {
    let missing = false;
    try { fs.lstatSync(absolute); } catch (error) { missing = error.code === 'ENOENT'; }
    if (live && missing) return live; // SDK draft not persisted yet.
    throw Error('会话记录不存在');
  }
  const stat = fs.statSync(absolute, { bigint: true });
  if (!stat.isFile()) throw Error('不是会话记录文件');
  const inside = roots.some(root => isInsideWorkspace(root, absolute));
  const registered = [...liveFiles, ...knownFiles].some(candidate => typeof candidate === 'string' && identity(candidate) === key);
  if (!inside && !(registered && unlinked(absolute))) throw Error('不允许访问会话目录之外的文件');
  // Junctions and hardlinks must consult the same busy context. An unregistered
  // hardlink may also refer to a file outside the managed tree.
  const liveTarget = liveFiles.find(candidate => {
    if (typeof candidate !== 'string') return false;
    try {
      const other = fs.statSync(candidate, { bigint: true });
      return real(candidate) === target || (other.dev === stat.dev && other.ino === stat.ino);
    } catch { return false; }
  });
  if (stat.nlink > 1n && !registered && !liveTarget) throw Error('不允许打开未登记的硬链接会话');
  return liveTarget || absolute;
}
