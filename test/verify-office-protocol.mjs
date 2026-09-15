import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { runOffice } from '../src/main/office/tools.mjs';
import { previewDocument } from '../src/main/document-preview.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-office-protocol-'));
const script = path.join(dir, 'builder.cjs');
try {
  await fs.writeFile(script, `module.exports = async () => {
    process.stdout.write('日志\\nHALO_OFFICE_RESULT=日志里的标记\\n');
    process.stderr.write(Buffer.from([0xe4]));
    await new Promise(resolve => setTimeout(resolve, 30));
    process.stderr.write(Buffer.from([0xb8, 0xad]));
    return { text: '中'.repeat(400000), marker: '正文 HALO_OFFICE_RESULT= 值\\nHALO_OFFICE_RESULT=下一行' };
  };`);
  const result = await runOffice({ action: 'run', script }, dir);
  assert.equal(result.result.text, '中'.repeat(400000), 'Large Unicode results must survive pipe chunk boundaries');
  assert.equal(result.result.marker, '正文 HALO_OFFICE_RESULT= 值\nHALO_OFFICE_RESULT=下一行');
  assert.equal(result.log, '日志\nHALO_OFFICE_RESULT=日志里的标记');
  assert.equal(result.warnings, '中', 'A split UTF-8 warning must be decoded once');

  const file = path.join(dir, '协议说明.docx');
  const text = '文档内容含有 HALO_OFFICE_RESULT= 标记。';
  const document = new Document({ sections: [{ children: [new Paragraph(text)] }] });
  const bytes = await Packer.toBuffer(document);
  await fs.writeFile(file, bytes);
  const inspected = await runOffice({ action: 'inspect', file }, dir);
  assert.ok(inspected.text.includes(text), 'Document text must not be mistaken for a result frame');
  const preview = await previewDocument(file);
  assert.equal(preview.ext, 'docx');
  assert.deepEqual(Buffer.from(preview.bytes), bytes);
  assert.deepEqual(await fs.readFile(file), bytes, 'Preview must preserve the original document');

  await fs.writeFile(script, "module.exports = async () => ({ text: 'a'.repeat(2100000) });");
  await assert.rejects(runOffice({ action: 'run', script }, dir), /文档脚本输出过多/);
  assert.equal((await runOffice({ action: 'status' }, dir)).formats.length, 4, 'Output failures must release the worker slot');
  console.log('PASS Unicode result/warning streaming, result frame collisions, real DOCX preview and output limits');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
