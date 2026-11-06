import fs from 'node:fs/promises';
import path from 'node:path';
import { splitMessageFiles } from '../shared/message-files.mjs';
import { previewDocument } from './document-preview.mjs';
import { readPreviewFile } from './read-preview-file.mjs';

const media = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp',
  mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac', mp4:'video/mp4', webm:'video/webm' };
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

// Separate read-only capability: only standalone file references in this chat's
// user messages are accepted. Workspace editing and protocol access stay scoped.
function attachmentPaths(messages) {
  return new Set((messages || []).flatMap(message => {
    if (message.role !== 'user') return [];
    const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(c => c?.type === 'text').map(c => c.text || '').join('\n');
    return splitMessageFiles(text).files.map(item => key(item.path));
  }));
}

export async function attachmentFileMetadata(files, messages) {
  if (!Array.isArray(files) || files.length > 100) throw Error('附件列表无效');
  const allowed = attachmentPaths(messages);
  return (await Promise.all(files.map(async file => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !allowed.has(key(file))) return null;
    const stat = await fs.stat(file).catch(() => null);
    return stat?.isFile() ? { file, bytes: stat.size } : { file, missing: true };
  }))).filter(Boolean);
}

export async function previewAttachment(file, page, messages) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('附件路径无效');
  if (!attachmentPaths(messages).has(key(file))) throw Error('该文件不属于当前对话附件');
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw Error('附件已移动或删除');
  if (stat.size > 64 * 1024 * 1024) throw Error('预览支持 64 MB 以内的文件');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) return previewDocument(file, page);
  if (media[ext]) return { ext, mediaType: media[ext], url: `data:${media[ext]};base64,${(await fs.readFile(file)).toString('base64')}` };
  if (/^(txt|md|markdown|csv|json|jsonc|xml|yaml|yml|toml|ini|log|js|mjs|cjs|ts|tsx|jsx|py|css|html|htm|svg|sql|sh|ps1|bat|srt|vtt)$/.test(ext)) {
    return { ext, ...await readPreviewFile(file, 512 * 1024) };
  }
  throw Error('该文件类型暂不支持内置预览');
}
