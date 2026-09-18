import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

const norm = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const text = value => ({content:[{type:'text', text:JSON.stringify(value)}]});
export class ProjectRuns {
  constructor({analyze, emit = () => {}, readRecipe = () => null, saveRecipe = () => {}, fastWaitMs = 20000}) {
    Object.assign(this, {analyze, emit, readRecipe, saveRecipe, fastWaitMs});
    this.runs = new Map(); this.recipes = new Map();
  }
  view(run) {
    return {id:run.id, cwd:run.cwd, sessionId:run.sessionId, status:run.status, message:run.message, startedAt:run.startedAt,
      urls:[...run.urls], log:run.log.slice(-12000), services:run.children.map(c=>({id:c.id, label:c.label, running:!run.controller.signal.aborted && c.child.exitCode===null && c.child.signalCode===null}))};
  }
  list() { return [...this.runs.values()].map(run=>this.view(run)); }
  update(run, patch = {}) { Object.assign(run, patch); this.emit(this.view(run)); }
  start(owner) {
    if(this.closed)throw Error('应用正在关闭');
    const existing = [...this.runs.values()].find(r=>r.sessionId===owner.sessionId && norm(r.cwd)===norm(owner.cwd) && !['stopped','error'].includes(r.status));
    if (existing) return this.view(existing);
    const run = {...owner, id:crypto.randomUUID(), startedAt:Date.now(), status:'analyzing', message:'后台 AI 正在分析启动方式…', urls:[], log:'', children:[], controller:new AbortController()};
    let recipe = this.recipes.get(norm(owner.cwd));
    try { recipe ||= this.readRecipe(norm(owner.cwd)); } catch { /* Fall back to AI for invalid cache. */ }
    if (recipe?.version === 1 && recipe.platform === process.platform && recipe.services?.length) {
      run.recipe = recipe; run.status = 'starting'; run.message = '正在使用上次成功的方式快速启动…';
    }
    this.runs.set(run.id, run); this.update(run);
    const timer = setTimeout(()=>void this.fail(run, '分析或启动超时，请查看日志后重试'), 10*60*1000);
    timer.unref?.();
    run.work = Promise.resolve().then(async()=>{
      if (run.recipe) {
        try { await this.fastStart(run, run.recipe); return; }
        catch (error) {
          if (run.controller.signal.aborted) return;
          await this.killChildren(run);
          if (run.controller.signal.aborted) return;
          run.children = []; run.urls = []; run.fastError = error.message;
          run.log += '\n快速启动失败：' + error.message + '\n转交 AI 分析修复。\n';
          this.update(run, {status:'analyzing', message:'快速启动未成功，AI 正在分析修复…'});
        }
      }
      await this.analyze(run, this.tools(run));
    }).then(()=>{
      if (!run.controller.signal.aborted && !run.urls.length) throw Error('AI 未确认可访问的预览地址，请查看启动日志');
    }).catch(error=>{ if (!run.controller.signal.aborted) return this.fail(run, error.message); }).finally(()=>clearTimeout(timer));
    return this.view(run);
  }
  async fastStart(run, recipe) {
    if (!Array.isArray(recipe.services) || recipe.services.length > 6) throw Error('已保存的启动方案无效');
    const url = new URL(recipe.url);
    if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) throw Error('已保存的预览地址无效');
    let occupied = false;
    try {
      const response = await fetch(url, {redirect:'manual', signal:AbortSignal.any([run.controller.signal, AbortSignal.timeout(1500)])});
      occupied = true; await response.body?.cancel();
    } catch { /* A closed port is expected before launch. */ }
    if (run.controller.signal.aborted) throw Error('启动已取消');
    if (occupied) throw Error('原端口已有服务，需要确认是否属于当前项目');
    for (const service of recipe.services) await this.launch(run, service);
    this.update(run, {message:'快速启动中，正在等待页面就绪…'});
    const deadline = Date.now() + this.fastWaitMs;
    let lastError;
    do {
      if (run.controller.signal.aborted) throw Error('启动已取消');
      if (run.children.some(c => c.child.exitCode !== null || c.child.signalCode !== null)) throw Error('启动进程已退出');
      try { await this.ready(run, recipe.url); return; } catch (error) { lastError = error; }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw Error(lastError?.message || '快速启动等待页面超时');
  }
  tools(run) {
    return [
      {name:'project_service_start',label:'后台启动服务',description:'在当前项目内启动常驻开发服务。服务由应用管理，不会随本次 AI 分析结束而退出。不要使用其他工具后台启动服务。',
        parameters:{type:'object',properties:{command:{type:'string'},cwd:{type:'string',description:'相对项目目录，默认项目根目录'},label:{type:'string'}},required:['command']},
        execute:async(_id,args)=>text(await this.launch(run,args))},
      {name:'project_service_status',label:'读取启动日志',description:'等待一小段时间后读取所有托管服务的最近日志与进程状态，用于确认实际监听端口或诊断错误。',
        parameters:{type:'object',properties:{}},execute:async()=>{
          await new Promise(resolve=>setTimeout(resolve,1000));
          if(run.controller.signal.aborted)throw Error('启动已取消');
          return text(this.view(run));
        }},
      {name:'project_preview_ready',label:'确认项目预览',description:'提供已启动的本地前端完整 URL（包括 base 路径）。应用会实际验证 HTTP 响应，成功后显示可点击端口。不能以 API 健康检查代替前端页面。',
        parameters:{type:'object',properties:{url:{type:'string'}},required:['url']},execute:async(_id,args)=>text(await this.ready(run,args.url))},
    ];
  }
  async launch(run, {command, cwd = '.', label = '开发服务'}) {
    if(run.controller.signal.aborted)throw Error('启动已取消');
    if(typeof command!=='string'||!command.trim())throw Error('启动命令不能为空');
    if(run.children.filter(c=>c.child.exitCode===null&&c.child.signalCode===null).length>=6)throw Error('每个项目最多启动 6 个服务');
    const directory=path.resolve(run.cwd,cwd), relative=path.relative(path.resolve(run.cwd),directory);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('服务目录必须位于当前项目内');
    const windows=process.platform==='win32';
    const shell=windows?path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'):'/bin/sh';
    const args=windows?['-NoLogo','-NoProfile','-NoExit','-Command',command]:['-c',command];
    // ConPTY retains and owns Windows descendants even when a launcher returns early.
    const terminal=windows?(await import('node-pty')).default.spawn(shell,args,{cwd:directory,env:{...process.env,FORCE_COLOR:'0'},cols:120,rows:30,useConpty:true}):null;
    if(run.controller.signal.aborted){terminal?.kill();throw Error('启动已取消');}
    const child=terminal?{pid:terminal.pid,exitCode:null,signalCode:null}:spawn(shell,args,{cwd:directory,env:{...process.env,FORCE_COLOR:'0'},windowsHide:true,detached:true,stdio:['ignore','pipe','pipe']});
    const rec={id:crypto.randomUUID(),label:String(label).slice(0,80),child,terminal, recipe:{command,cwd:relative||'.',label:String(label).slice(0,80)}}; run.children.push(rec);
    this.update(run,{status:'starting',message:'正在启动 '+rec.label});
    const append=data=>{run.log=(run.log+'\n['+rec.label+'] '+stripVTControlCharacters(data.toString())).slice(-24000);};
    const exited=code=>{
      if(terminal)child.exitCode=code;
      append('进程退出：'+code);
      if(run.status==='running'&&!run.controller.signal.aborted&&!rec.retired)void this.fail(run,rec.label+' 已退出，请重新启动');
    };
    if(terminal){terminal.onData(append);terminal.onExit(({exitCode})=>exited(exitCode));}
    else {
      child.stdout.on('data',append);child.stderr.on('data',append);
      child.on('error',error=>append(error.message));child.on('exit',exited);
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    }
    return {id:rec.id,pid:child.pid,label:rec.label};
  }
  async ready(run, value) {
    if(run.controller.signal.aborted)throw Error('启动已取消');
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('预览地址必须为本机 HTTP/HTTPS 服务');
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.any([run.controller.signal,AbortSignal.timeout(5000)])});
    const html=(response.headers.get('content-type')||'').includes('text/html');
    await response.body?.cancel();
    if(!response.ok||!html)throw Error('前端页面尚未就绪：HTTP '+response.status+'，请检查页面路径和日志');
    if(run.controller.signal.aborted)throw Error('启动已取消');
    if(!run.urls.includes(url.href))run.urls.push(url.href);
    const services = run.children.filter(c => c.recipe && c.child.exitCode === null && c.child.signalCode === null).map(c => c.recipe);
    if (services.length) {
      const recipe = {version:1, platform:process.platform, services, url:url.href, savedAt:Date.now()};
      this.recipes.set(norm(run.cwd), recipe);
      try { this.saveRecipe(norm(run.cwd), recipe); } catch { /* Keep a working service alive even when persistence fails. */ }
    }
    this.update(run,{status:'running',message:'项目已启动'});
    if(!run.monitor) {
      let failures=0, checking=false;
      run.monitor=setInterval(async()=>{
        if(checking||run.controller.signal.aborted)return;
        checking=true;
        try {
          const response=await fetch(run.urls[0],{redirect:'manual',signal:AbortSignal.any([run.controller.signal,AbortSignal.timeout(3000)])});
          await response.body?.cancel();
          failures=response.status>=500?failures+1:0;
        }catch{failures++;}finally{checking=false;}
        if(failures>=3&&!run.controller.signal.aborted)void this.fail(run,'项目服务已失去响应，请查看日志后重试');
      },5000);
      run.monitor.unref?.();
    }
    return {url:url.href,status:response.status};
  }
  async killChildren(run) {
    for (const rec of run.children) rec.retired = true;
    await Promise.all(run.children.map(({child,terminal})=>new Promise(resolve=>{
      if(!child.pid||child.exitCode!==null||child.signalCode!==null)return resolve();
      if(process.platform==='win32')execFile(path.join(process.env.SystemRoot||'C:/Windows','System32/taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>{
        // taskkill owns the tree; dispose ConPTY only while its root is still alive.
        try{process.kill(child.pid,0);terminal?.kill();}catch{}resolve();
      });
      else {try{process.kill(-child.pid,'SIGTERM');}catch{}resolve();}
    })));
  }
  async fail(run, message) {
    if(run.controller.signal.aborted)return;
    run.controller.abort();
    clearInterval(run.monitor);
    this.update(run,{status:'error',message,urls:[]});await this.killChildren(run);
  }
  async stop(id) {
    const run=this.runs.get(id);if(!run)return;
    run.controller.abort();clearInterval(run.monitor);this.update(run,{status:'stopped',message:'项目服务已停止',urls:[]});
    await this.killChildren(run);
  }
  async stopSession(file) { await Promise.all([...this.runs.values()].filter(r=>norm(r.sessionFile)===norm(file)).map(r=>this.stop(r.id))); }
  async stopProject(cwd) { await Promise.all([...this.runs.values()].filter(r=>norm(r.cwd)===norm(cwd)).map(r=>this.stop(r.id))); }
  async dispose() { this.closed=true; await Promise.all([...this.runs.keys()].map(id=>this.stop(id))); }
}
