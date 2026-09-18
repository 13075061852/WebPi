const norm = value => String(value || '').replace(/\\/g,'/').toLowerCase();
export function initProjectRuns({api, context, switchProject, openPreview, showLogs, toast}) {
  const runs = new Map();
  const busy=run=>run && ['analyzing','starting'].includes(run.status);
  const projectRun=cwd=>{
    const matching=[...runs.values()].filter(run=>norm(run.cwd)===norm(cwd)&&run.status!=='stopped');
    return matching.find(run=>run.status==='running')||matching.find(busy)||matching.at(-1);
  };
  const icons={idle:'<path d="m8 5 11 7-11 7Z"/>',busy:'<path d="M20 12a8 8 0 1 1-8-8"/>',running:'<circle cx="12" cy="12" r="8"/><path d="m8 12 3 3 5-6"/>',error:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>'};
  function clocks(){
    for(const el of document.querySelectorAll('.project-run-elapsed')){
      const seconds=Math.max(0,Math.floor((Date.now()-Number(el.dataset.started))/1000));
      el.textContent='已用 '+(seconds>=60?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':seconds+' 秒');
    }
  }
  const timer=setInterval(clocks,1000);
  window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});
  function render() {
    for(const button of document.querySelectorAll('.project-start')){
      const run=projectRun(button.dataset.cwd), state=busy(run)?'busy':run?.status==='running'?'running':run?.status==='error'?'error':'idle';
      button.dataset.state=state;button.disabled=state==='busy';button.setAttribute('aria-busy',String(state==='busy'));
      const label={idle:'启动',busy:'启动中',running:'运行中',error:'重试'}[state];
      button.innerHTML='<svg viewBox="0 0 24 24" class="ic" aria-hidden="true">'+icons[state]+'</svg><span>'+label+'</span>';
      button.title=state==='running'?'项目已运行，点击打开预览':state==='busy'?run.message+' · 可在下方查看日志或停止':'让后台 AI 分析并启动项目';
    }
    for(const box of document.querySelectorAll('.project-runs')) {
      box.replaceChildren();
      const latest=new Map();
      for(const run of runs.values())if(norm(run.cwd)===norm(box.dataset.cwd))latest.set(run.sessionId,run);
      for(const run of latest.values()) {
        if(run.status==='stopped')continue;
        const row=document.createElement('div');row.className='project-run server-conversation-row';row.dataset.status=run.status;
        const inspect=async()=>{
          const result=await api.projectRunList();
          const fresh=result?.data?.find(item=>item.id===run.id)||run;
          showLogs(fresh.message, fresh.log || '正在分析项目，暂时没有输出。');
        };
        const status=document.createElement('button');status.className='server-conversation project-run-status';
        const firstURL=run.urls?.[0];
        const port=firstURL?(new URL(firstURL).port||(new URL(firstURL).protocol==='https:'?'443':'80')):null;
        status.textContent='项目服务 · '+(port||({analyzing:'分析中',starting:'启动中',error:'启动失败'}[run.status]||'启动中'));
        status.title=run.message+(firstURL?' · 点击预览 '+firstURL:' · 点击查看日志');
        status.onclick=firstURL?()=>openPreview(firstURL, run):inspect;
        if(firstURL)status.classList.add('project-run-port');
        row.append(status);
        const actions=document.createElement('div');actions.className='project-run-actions';
        for(const url of (run.urls||[]).slice(1)) {
          const link=document.createElement('button');link.className='project-run-port';
          const address=new URL(url);link.textContent='↗ '+(address.port||(address.protocol==='https:'?'443':'80'));link.title='预览 '+url;
          link.onclick=()=>openPreview(url, run);actions.append(link);
        }
        const log=document.createElement('button');log.className='server-conversation-delete project-run-log';log.title='查看启动日志';log.setAttribute('aria-label','查看启动日志');
        log.innerHTML='<svg viewBox="0 0 24 24" class="ic"><path d="M5 4h14v16H5ZM8 8h8M8 12h8M8 16h5"/></svg>';log.onclick=inspect;
        actions.append(log);
        if(!['error','stopped'].includes(run.status)) {
          const stop=document.createElement('button');stop.className='server-conversation-delete';stop.title='停止项目服务';stop.setAttribute('aria-label','停止项目服务');
          stop.innerHTML='<svg viewBox="0 0 24 24" class="ic"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
          stop.onclick=async()=>{stop.disabled=true;try{const result=await api.projectRunStop(run.id);if(!result?.ok)throw Error(result?.error||'停止失败');}catch(error){toast(error.message,'err');stop.disabled=false;}};
          actions.append(stop);
        }
        row.append(actions);box.append(row);
        if(busy(run)){
          const progress=document.createElement('div');progress.className='project-run-progress';
          const stage=document.createElement('div');stage.className='project-run-stage';stage.textContent=run.message;stage.title=run.message;stage.setAttribute('role','status');
          const elapsed=document.createElement('span');elapsed.className='project-run-elapsed';elapsed.dataset.started=String(run.startedAt||Date.now());
          progress.append(stage,elapsed);box.append(progress);
        }
      }
    }
    clocks();
  }
  api.onProjectRun(run=>{
    const previous=runs.get(run.id);runs.set(run.id,run);render();
    if(run.status==='running'&&previous?.status!=='running'&&context()?.sessionId===run.sessionId&&norm(context()?.cwd)===norm(run.cwd))openPreview(run.urls[0], run);
  });
  void api.projectRunList().then(result=>{for(const run of result?.data||[])if(!runs.has(run.id))runs.set(run.id,run);render();});
  return {mount(group, project) {
    const start=document.createElement('button');start.className='project-start';start.textContent='▷ 启动';start.title='让后台 AI 分析并启动项目';
    start.dataset.cwd=project.cwd;
    start.onclick=async()=>{
      const existing=projectRun(project.cwd);
      if(existing?.status==='running'){openPreview(existing.urls[0], existing);return;}
      if(busy(existing))return;
      start.disabled=true;
      start.dataset.state='busy';start.innerHTML='<svg viewBox="0 0 24 24" class="ic" aria-hidden="true">'+icons.busy+'</svg><span>启动中</span>';
      try {
        if(norm(context()?.cwd)!==norm(project.cwd))await switchProject(project.cwd);
        if(norm(context()?.cwd)!==norm(project.cwd))return;
        const result=await api.projectRunStart();if(!result?.ok)throw Error(result?.error||'启动失败');
        runs.set(result.data.id,result.data);render();
        if(result.data.status==='running')openPreview(result.data.urls[0], result.data);
      }catch(error){toast(error.message,'err');}finally{render();}
    };
    group.querySelector('.project-new').before(start);
    const box=document.createElement('div');box.className='project-runs server-conversations';box.dataset.cwd=project.cwd;
    group.querySelector('.project-group-head').after(box);
    // loadProjects appends the group immediately after mounting.
    queueMicrotask(render);
  }};
}
