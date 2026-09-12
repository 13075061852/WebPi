import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOffice } from './office/tools.mjs';
async function renderDocument(file, page = 1) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('预览支持 64 MB 以内的文件');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!['pdf', 'docx', 'xlsx', 'pptx'].includes(ext)) throw Error('旧版 Office 文件请先另存为 DOCX、XLSX 或 PPTX');
  if (ext !== 'pdf') {
    await runOffice({ action: 'inspect', file }, path.dirname(file));
    return { ext, bytes: new Uint8Array(await fs.readFile(file)) };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-doc-preview-'));
  try {
    const result = await runOffice({ action: 'render_pdf', file, outputDir: dir, maxPages: 1, startPage: Math.max(1, Math.floor(Number(page) || 1)) }, path.dirname(file));
    if (!result.images[0]) throw Error('页码超出范围');
    return { ext, pages: result.pages, image: 'data:image/png;base64,' + (await fs.readFile(result.images[0])).toString('base64') };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const previewCache=new Map(),pending=new Map();
let cacheBytes=0;
export async function previewDocument(file,page=1) {
  const stat=await fs.stat(file);
  const key=path.resolve(file)+':'+stat.mtimeMs+':'+stat.ctimeMs+':'+stat.size+':'+Math.max(1,Math.floor(Number(page)||1));
  const cached=previewCache.get(key);
  if(cached && Date.now()-cached.time<300000) {previewCache.delete(key);previewCache.set(key,cached);return cached.value;}
  if(pending.has(key))return pending.get(key);
  const task=renderDocument(file,page).then(value=>{
    // Only cache rendered PDF pages, never keep Office workbooks resident.
    if(value.image) {
      const size=value.image.length*2;
      if(size<=24*1024*1024) {
        if(previewCache.has(key)) {cacheBytes-=previewCache.get(key).size;previewCache.delete(key);}
        while(previewCache.size && cacheBytes+size>24*1024*1024) {const first=previewCache.keys().next().value;cacheBytes-=previewCache.get(first).size;previewCache.delete(first);}
        previewCache.set(key,{value,size,time:Date.now()});cacheBytes+=size;
      }
    }
    return value;
  }).finally(()=>pending.delete(key));
  pending.set(key,task);return task;
}
