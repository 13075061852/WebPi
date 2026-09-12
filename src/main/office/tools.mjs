import { convertOffice } from './convert.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const officeSkillsRoot=path.resolve(here,'../../../assets/skills');
function runOfficeWorker(args,cwd,signal) {
  if(args.action==='convert_pdf') return convertOffice(args,cwd,signal);
  if(signal?.aborted)return Promise.reject(Error('已取消'));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(here,'worker.cjs')],{cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{child.kill();finish(Error('文档任务已取消'));};
    const timer=setTimeout(()=>{child.kill();finish(Error('文档处理超过 120 秒，已结束'));},120000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2000000){child.kill();finish(Error('文档脚本输出过多'));}});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-12000);});
    child.on('error',error=>finish(error));child.stdin.on('error',()=>{});
    child.on('close',code=>{
      const marker='HALO_OFFICE_RESULT=',index=stdout.lastIndexOf(marker);
      if(code!==0||index<0)return finish(Error(stderr||stdout||'文档进程未返回结果'));
      try{finish(null,{...JSON.parse(stdout.slice(index+marker.length).trim()),log:stdout.slice(0,index).trim().slice(-10000),warnings:stderr});}catch(error){finish(error);}
    });
    child.stdin.end(JSON.stringify(args));
  });
}
// Bound worker memory and CPU even when multiple conversations request documents.
let activeWorkers = 0;
const waitingWorkers = [];
export async function runOffice(args,cwd,signal) {
  if (signal?.aborted) throw Error('已取消');
  if (activeWorkers >= 2) await new Promise((resolve,reject) => {
    const entry = {resolve:()=>{signal?.removeEventListener('abort',abort);resolve();}};
    const abort = () => { const i=waitingWorkers.indexOf(entry);if(i>=0)waitingWorkers.splice(i,1);reject(Error('已取消')); };
    waitingWorkers.push(entry);signal?.addEventListener('abort',abort,{once:true});
  });
  else activeWorkers++;
  try { return await runOfficeWorker(args,cwd,signal); }
  finally { const next=waitingWorkers.shift();if(next)next.resolve();else activeWorkers--; }
}
export function summarizeOfficeResult(result) {
  const trim = value => {
    if (Array.isArray(value)) return value.slice(0,50).map(trim);
    if (!value || typeof value !== 'object') return typeof value==='string' && value.length>2400 ? value.slice(0,2400)+'…[摘要截断]' : value;
    const out={};
    for(const [key,item] of Object.entries(value)) {
      if(key==='text'||key==='texts') continue;
      if(key==='log' && !item) continue;
      out[key]=trim(item);
    }
    return out;
  };
  return trim(result);
}
export function officeTool(cwd) {
  return {name:'office_document',label:'办公文档',description:'内置 PDF、Word DOCX、Excel XLSX、PowerPoint PPTX 文档工具。convert_pdf 将 docx/xlsx/pptx 通过本机 Office 转为 PDF，60 秒超时，失败后不要原样重试；status 查看环境和模板路径；run 执行本机项目中的 CommonJS 编写脚本；inspect 检查结构并提取摘要；render_pdf 将 PDF 渲染为 PNG 供 read 工具视觉检查。运行脚本具有与本地 bash 相同的文件权限，不是沙箱。先读取对应 halo-* 内置技能。',parameters:{type:'object',properties:{action:{type:'string',enum:['status','run','inspect','render_pdf','convert_pdf']},script:{type:'string'},file:{type:'string'},outputDir:{type:'string'},maxPages:{type:'integer',minimum:1,maximum:50},startPage:{type:'integer',minimum:1},verbose:{type:'boolean',description:'仅在需要提取文本或诊断时启用完整输出，默认返回精简检查结果'}},required:['action']},execute:async(_id,args,signal)=>{
    if(args.action==='run'&&(!args.script||!fs.existsSync(path.resolve(cwd,args.script))))throw Error('先在当前项目写入文档脚本，再指定 script 路径');
    if(['inspect','render_pdf'].includes(args.action)&&!args.file)throw Error('必须指定 file');
    const result=await runOffice(args,cwd,signal);
    if(args.action==='status')result.examples=path.resolve(here,'../../../assets/office-examples');
    return {content:[{type:'text',text:JSON.stringify(args.verbose ? result : summarizeOfficeResult(result))}],details:result};
  }};
}
