import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInsideWorkspace } from './workspace-path.mjs';

export const TEXT_EDIT_LIMIT = 2 * 1024 * 1024;
const revision = bytes => createHash('sha256').update(bytes).digest('hex');

function decode(bytes) {
  let encoding = 'utf-8', bom = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bom = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bom = 2; }
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = 3;
  let content;
  try { content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom)); }
  catch { throw Error('文件不是有效的 UTF-8 / UTF-16 文本，请使用外部编辑器'); }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) throw Error('二进制文件不支持文本编辑');
  return { content, encoding, bom };
}

function open(root, file, flags) {
  if (typeof file !== 'string' || !file) throw Error('无效的文件路径');
  const absolute = path.resolve(root, file);
  if (!isInsideWorkspace(root, absolute)) throw Error('路径超出当前项目范围');
  const fd = fs.openSync(absolute, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error('只能编辑普通文件');
    if (stat.size > TEXT_EDIT_LIMIT) throw Error('文件超过 2 MB，请使用外部编辑器');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > TEXT_EDIT_LIMIT) throw Error('文件超过 2 MB，请使用外部编辑器');
    return { fd, absolute, bytes, ...decode(bytes) };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function readEditableFile(root, file) {
  const data = open(root, file, 'r');
  try { return { path: data.absolute, content: data.content, revision: revision(data.bytes) }; }
  finally { fs.closeSync(data.fd); }
}

// Compare the complete original bytes, including encoding and BOM, before overwriting.
export function saveEditableFile(root, { path: file, content, revision: expected } = {}) {
  if (typeof content !== 'string' || typeof expected !== 'string') throw Error('无效的保存请求');
  if (Buffer.byteLength(content, 'utf8') > TEXT_EDIT_LIMIT) throw Error('文件超过 2 MB，请使用外部编辑器');
  const data = open(root, file, 'r+');
  try {
    if (revision(data.bytes) !== expected) throw Error('文件已被外部修改，未覆盖磁盘内容。请先复制草稿，再重新加载应用以读取最新文件');
    let bytes = Buffer.from(content, data.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (data.encoding === 'utf-16be') bytes.swap16();
    if (data.bom) bytes = Buffer.concat([data.bytes.subarray(0, data.bom), bytes]);
    if (bytes.length > TEXT_EDIT_LIMIT) throw Error('文件超过 2 MB，请使用外部编辑器');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(data.fd, bytes, offset, bytes.length - offset, offset);
    fs.ftruncateSync(data.fd, bytes.length);
    fs.fsyncSync(data.fd);
    return { path: data.absolute, revision: revision(bytes) };
  } finally { fs.closeSync(data.fd); }
}
