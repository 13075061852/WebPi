import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewAttachment, attachmentFileMetadata } from '../src/main/attachment-preview.mjs';
import { formatFileSize } from '../src/renderer/js/file-size.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-attachment-preview-'));
const file = path.join(dir, '外部附件.txt');
const message = file => [{ role: 'user', content: [{ type: 'text', text: `资料\n@"${file.replaceAll('\\', '/')}"` }] }];
try {
  await fs.writeFile(file, '中文附件\n<script>literal</script>');
  const result = await previewAttachment(file, undefined, message(file));
  assert.equal(result.content, '中文附件\n<script>literal</script>');
  assert.equal(result.ext, 'txt');
  assert.deepEqual(await attachmentFileMetadata([file], message(file)), [{ file, bytes: Buffer.byteLength(result.content) }]);
  assert.deepEqual(await attachmentFileMetadata([file], []), [], 'Metadata cannot inspect another chat or arbitrary local files');
  const empty = path.join(dir, '空文件.txt'); await fs.writeFile(empty, '');
  assert.deepEqual(await attachmentFileMetadata([empty], message(empty)), [{ file: empty, bytes: 0 }]);
  for (const [bytes, label] of [[0,'0 B'],[1023,'1023 B'],[1024,'1.0 KB'],[1048576,'1.0 MB'],[1073741824,'1.0 GB'],[undefined,'大小未知'],[-1,'大小未知']]) assert.equal(formatFileSize(bytes), label);
  assert.equal((await previewAttachment(file, 1, [{ role: 'user', content: `@"${file}"` }])).content, result.content);
  for (const messages of [[], [{ ...message(file)[0], role: 'assistant' }], [{ role: 'user', content: `正文 @"${file}"` }], [{role:'user',content:'```\n@"'+file+'"\n```'}]]) {
    await assert.rejects(previewAttachment(file, 1, messages), /不属于当前对话/);
  }
  await assert.rejects(previewAttachment(path.join(dir, 'other.txt'), 1, message(file)), /不属于当前对话/);
  await assert.rejects(previewAttachment('relative.txt', 1, message(file)), /路径无效/);
  await assert.rejects(previewAttachment(file, 1, []), /不属于当前对话/, 'Switching chats revokes previous attachment access');
  const zip = path.join(dir, 'archive.zip'); await fs.writeFile(zip, 'not rendered');
  await assert.rejects(previewAttachment(zip, 1, message(zip)), /暂不支持/);
  await fs.unlink(file);
  assert.deepEqual(await attachmentFileMetadata([file], message(file)), [{ file, missing: true }]);
  await assert.rejects(previewAttachment(file, 1, message(file)), /已移动或删除/);
  console.log('PASS read-only external attachment, current-user-history scope, code/inline/assistant rejection, unsupported and missing file errors');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
