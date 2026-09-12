import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const failed = new Map();
let busy = false;
export async function convertOffice(args, cwd, signal) {
  if (process.platform !== 'win32') throw Error('原生转换目前需要 Windows Microsoft Office');
  if (signal?.aborted) throw Error('已取消');
  const source = path.resolve(cwd, args.file || '');
  const ext = path.extname(source).toLowerCase();
  if (!['.docx','.xlsx','.pptx'].includes(ext)) throw Error('convert_pdf 支持 docx/xlsx/pptx');
  const stat = fs.statSync(source);
  if (stat.size > 64 * 1024 * 1024) throw Error('文档超过 64 MB');
  const key = source + ':' + stat.mtimeMs + ':' + stat.size;
  if (failed.has(key)) throw Error('此版本文件转换已失败，请先解决原因或修改文件，不要重复转换。上次错误：' + failed.get(key));
  if (busy) throw Error('已有 Office 转换正在执行，请等待完成');
  const destDir = path.resolve(cwd, args.outputDir || 'output');
  const dest = path.join(destDir, path.basename(source, ext) + '.pdf');
  if (fs.existsSync(dest)) throw Error('目标 PDF 已存在，请选择新的 outputDir，避免覆盖');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-convert-'));
  busy = true;
  try {
    fs.copyFileSync(source, path.join(temp, 'source' + ext));
    fs.copyFileSync(path.join(here,'convert.ps1'),path.join(temp,'convert.ps1'));
    const result = await new Promise((resolve,reject) => {
      const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(temp,'convert.ps1'),'-WorkDir',temp,'-Kind',ext.slice(1)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let logs = '', stage = '启动转换器', officePid = null, finished = false, pendingStop = null;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const stop = message => {
        if (finished) return;
        if (!officePid && !pendingStop) {
          pendingStop = message;
          clearTimeout(timer);
          timer = setTimeout(() => { pendingStop = null; terminate(message); },10000);
          return;
        }
        terminate(message);
      };
      const terminate = async message => {
        if (finished) return;
        finished = true; cleanup(); child.kill();
        // PID is obtained from the new Office window handle, never by image name.
        if (officePid) {
          try { process.kill(officePid); } catch {}
          for(let i=0;i<40;i++) { try { process.kill(officePid,0); } catch { break; } await new Promise(r=>setTimeout(r,25)); }
        }
        if (stage === 'close document' && !signal?.aborted) resolve(logs + '\nOffice cleanup timed out; dedicated process stopped.');
        else reject(Error(message + '；阶段：' + stage + '\n' + logs));
      };
      const abort = () => stop('转换已取消');
      let timer = setTimeout(() => stop('转换超过 60 秒，已停止。请检查文档或 Office 状态，不要原样重试'),60000);
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        logs = (logs + data).slice(-12000);
        const pid = logs.match(/HALO_PID=(\d+)/); if (pid) officePid = Number(pid[1]);
        if (pendingStop && officePid) { terminate(pendingStop); return; }
        const stages = [...logs.matchAll(/HALO_STAGE=([^\r\n]+)/g)]; if (stages.length) {
          const next = stages.at(-1)[1];
          if (next === 'close document' && stage !== next) { clearTimeout(timer); timer = setTimeout(() => stop('Office 清理超过 5 秒'),5000); }
          stage = next;
        }
      });
      child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
      child.on('error', e => stop(e.message));
      child.on('close', code => {
        if (finished) return;
        finished = true; cleanup();
        if (pendingStop) { reject(Error(pendingStop)); return; }
        if (code !== 0) reject(Error('转换失败；阶段：' + stage + '\n' + logs));
        else resolve(logs);
      });
    });
    const pdf = path.join(temp,'result.pdf');
    const bytes = fs.readFileSync(pdf);
    if (bytes.length < 100 || bytes.subarray(0,5).toString() !== '%PDF-') throw Error('转换器没有生成有效 PDF');
    fs.mkdirSync(destDir,{recursive:true});
    fs.copyFileSync(pdf,dest,fs.constants.COPYFILE_EXCL);
    return {file:dest,source,engine:'Microsoft Office',visualChecked:false,log:result};
  } catch(e) { if (e.message.includes("60 秒")) { if(failed.size>=128)failed.delete(failed.keys().next().value);failed.set(key,e.message); } throw e; }
  finally { busy=false; try { fs.rmSync(temp,{recursive:true,force:true}); } catch {} }
}
