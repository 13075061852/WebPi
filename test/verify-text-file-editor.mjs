import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEditableFile, saveEditableFile, TEXT_EDIT_LIMIT } from '../src/main/text-file-editor.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-editor-'));
const root = path.join(temporary, 'project'); fs.mkdirSync(root);
try {
  for (const name of ['current-scope.ts', 'app.tsx', 'styles.css', 'README.md', 'package.json', '.env', 'Dockerfile', 'icon.svg', 'script.py']) {
    const file = path.join(root, name), before = '原文\r\nconst value = 1;\r\n';
    fs.writeFileSync(file, before);
    const draft = readEditableFile(root, file);
    assert.equal(draft.content, before);
    const after = '修改\r\n';
    const saved = saveEditableFile(root, { path: file, content: after, revision: draft.revision });
    assert.equal(fs.readFileSync(file, 'utf8'), after, 'Shorter save truncates old bytes');
    assert.equal(readEditableFile(root, file).revision, saved.revision);
    assert.throws(() => saveEditableFile(root, { path: file, content: 'stale', revision: draft.revision }), /外部修改/);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
  }
  for (const encoding of ['utf8-bom', 'utf16le', 'utf16be']) {
    const file = path.join(root, encoding), original = '中文\r\n';
    let bytes = Buffer.from(original, encoding === 'utf8-bom' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    const bom = Buffer.from(encoding === 'utf8-bom' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    fs.writeFileSync(file, Buffer.concat([bom, bytes]));
    const draft = readEditableFile(root, file); assert.equal(draft.content, original);
    saveEditableFile(root, { ...draft, content: '更改\r\n' });
    assert.equal(readEditableFile(root, file).content, '更改\r\n');
    assert.deepEqual(fs.readFileSync(file).subarray(0, bom.length), bom);
  }
  const outside = path.join(temporary, 'outside.txt'); fs.writeFileSync(outside, 'untouched');
  assert.throws(() => readEditableFile(root, outside), /超出/);
  assert.throws(() => saveEditableFile(root, { path: outside, content: 'bad', revision: 'bad' }), /超出/);
  const binary = path.join(root, 'binary'); fs.writeFileSync(binary, Buffer.from([0, 1, 2]));
  assert.throws(() => readEditableFile(root, binary), /二进制/);
  fs.writeFileSync(binary, Buffer.from([0xc3, 0x28])); assert.throws(() => readEditableFile(root, binary), /有效/);
  fs.writeFileSync(binary, Buffer.alloc(TEXT_EDIT_LIMIT + 1, 65)); assert.throws(() => readEditableFile(root, binary), /2 MB/);
  assert.throws(() => readEditableFile(root, root), /普通文件/);
  const link = path.join(root, 'outside-link');
  try { fs.symlinkSync(temporary, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (fs.existsSync(link)) assert.throws(() => readEditableFile(root, path.join(link, 'outside.txt')), /超出/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  console.log('PASS text editor: code/text, conflict protection, truncation, UTF-8/UTF-16 BOM, bounds, binary/encoding/size and symlink guards');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
