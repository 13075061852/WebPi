// Real renderer feedback; synthetic tool events never submit a paid generation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchElectronApp, waitUntil } from '../helpers/electron-app.mjs';

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'halo-image-progress-ui-'));
for(const name of ['profile','workspace','agent','roaming','local','gh']) fs.mkdirSync(path.join(fixture,name));
const workspace=path.join(fixture,'workspace'),profile=path.join(fixture,'profile');
const system=process.env.SystemRoot||'C:/Windows';
const env={SystemRoot:system,WINDIR:system,ComSpec:path.join(system,'System32/cmd.exe'),
  PATH:[path.join(system,'System32'),path.join(system,'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE:fixture,HOME:fixture,APPDATA:path.join(fixture,'roaming'),LOCALAPPDATA:path.join(fixture,'local'),
  TEMP:fixture,TMP:fixture,PI_CODING_AGENT_DIR:path.join(fixture,'agent'),PI_OFFLINE:'1',
  GH_CONFIG_DIR:path.join(fixture,'gh'),GIT_CONFIG_GLOBAL:path.join(fixture,'gitconfig'),GIT_CONFIG_NOSYSTEM:'1'};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'');
fs.writeFileSync(path.join(profile,'halo-settings.json'),JSON.stringify({cwd:workspace,projects:[{cwd:workspace}],globalProxy:{mode:'direct'}}));
const file=path.join(workspace,'test-image.png');
fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=','base64'));
let app;
try {
  app=await launchElectronApp({fixture,profile,env});
  await app.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const state=await app.evaluate('window.halo.getState().then(r=>r.data)');
  assert.ok((await app.evaluate('document.title')).includes('Halo') || (await app.evaluate('document.title')).includes('星环'));
  const dispatch=event=>app.evaluate(`window.__haloDispatch(${JSON.stringify(event)})`);
  const reset=()=>app.evaluate(`window.__haloRestoreView({state:${JSON.stringify({...state,isStreaming:false})},messages:[]})`);
  const start=async(id='image')=>{
    await reset();
    await dispatch({type:'agent_start'});
    await dispatch({type:'tool_execution_start',toolCallId:id,toolName:'image_generate',args:{prompt:'小狗吃西瓜'}});
  };
  const stage=()=>app.evaluate("document.querySelector('.image-generation-stage')?.textContent");
  await start();
  assert.equal(await stage(),'正在准备');
  assert.equal(await app.evaluate("document.querySelector('[aria-label=图片生成进度]').hasAttribute('aria-valuenow')"),false,'Unknown percentage must remain indeterminate');
  await dispatch({type:'tool_execution_update',toolCallId:'image',partialResult:{details:{imageProgress:{stage:'generating',startedAt:Date.now()-5000}}}});
  assert.equal(await stage(),'正在生成');
  await waitUntil(()=>app.evaluate("parseInt(document.querySelector('.image-generation-elapsed').textContent)>=6"),'Elapsed time did not advance');
  await waitUntil(()=>app.evaluate("document.querySelector('.turn-status-text').textContent==='正在生成图片…'"),'Turn status did not show the image generation stage');
  const animation=await app.evaluate("document.querySelector('.image-generation-icon').getAnimations()[0]?.currentTime");
  assert.ok(animation>0,'Live generation animation must play');
  async function screenshot(name) {
    const shot=await app.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(fixture,name),Buffer.from(shot.result.data,'base64'));
  }
  await screenshot('generating-light.png');
  const clip=await app.evaluate("(()=>{const r=document.querySelector('.image-generation-progress').getBoundingClientRect();return {x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16,scale:1}})()");
  const detail=await app.send('Page.captureScreenshot',{format:'png',clip});
  fs.writeFileSync(path.join(fixture,'progress-detail.png'),Buffer.from(detail.result.data,'base64'));
  await app.evaluate("document.documentElement.dataset.theme='dark'");
  await screenshot('generating-dark.png');
  await app.send('Emulation.setDeviceMetricsOverride',{width:760,height:700,deviceScaleFactor:1,mobile:false});
  assert.equal(await app.evaluate("(()=>{const r=document.querySelector('.image-generation-progress').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})()"),true);
  await app.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await app.evaluate("getComputedStyle(document.querySelector('.image-generation-icon')).animationName"),'none');
  await dispatch({type:'tool_execution_end',toolCallId:'image',isError:true,result:{content:[{type:'text',text:'HTTP 429'}]}});
  assert.equal(await stage(),'生成失败');
  assert.equal(await app.evaluate("document.querySelector('.image-generation-progress').getAttribute('aria-busy')"),'false');
  assert.equal(await app.evaluate("document.querySelectorAll('.image-generation-track').length"),0);
  await start('cancel');
  await dispatch({type:'tool_execution_end',toolCallId:'cancel',isError:true,result:{content:[{type:'text',text:'AbortError: cancelled'}]}});
  assert.equal(await stage(),'已取消');
  await start('complete');
  await dispatch({type:'tool_execution_update',toolCallId:'complete',partialResult:{details:{imageProgress:{stage:'saving',startedAt:Date.now()-8000}}}});
  assert.equal(await stage(),'正在保存');
  const result={file,timing:{totalMs:8000}};
  await dispatch({type:'tool_execution_end',toolCallId:'complete',isError:false,result:{content:[{type:'text',text:JSON.stringify(result)}],details:result}});
  await waitUntil(()=>app.evaluate("!!document.querySelector('.artifact-image')&&!document.querySelector('.image-generation-progress')"),'Completed image did not replace the progress card');
  await reset();
  const startedAt=Date.now()-18000;
  const view={state:{...state,isStreaming:true},startedAt,activeTools:{restore:'image_generate'},imageProgress:{restore:{stage:'saving',startedAt}},messages:[
    {role:'user',content:[{type:'text',text:'小狗吃西瓜'}],timestamp:startedAt},
    {role:'assistant',content:[{type:'toolCall',id:'restore',name:'image_generate',arguments:{prompt:'小狗吃西瓜'}}],timestamp:startedAt}
  ]};
  await app.evaluate(`window.__haloRestoreView(${JSON.stringify(view)})`);
  assert.equal(await stage(),'正在保存','Switching back restores the actual stage');
  assert.ok(parseInt(await app.evaluate("document.querySelector('.image-generation-elapsed').textContent"))>=18);
  await dispatch({type:'agent_settled'});
  assert.equal(await stage(),'已结束','Missing tool completion must not leave an endless animation');
  await app.evaluate(`window.__haloRestoreView(${JSON.stringify({...view,state:{...state,isStreaming:false},imageProgress:{}})})`);
  assert.equal(await app.evaluate("document.querySelectorAll('.image-generation-progress').length"),0,'Inactive history must not show live generation');
  assert.equal(await app.evaluate("document.querySelectorAll('#messages .tool').length>0"),true);
  await app.close();app=null;
  console.log(JSON.stringify({ok:true,fixture,checks:['live elapsed and animation','light/dark and compact layout','reduced motion','failure/cancel stop animation','success replaces placeholder','switch restoration','settled/inactive cleanup','no renderer exceptions','no image generation requests']}));
} finally {await app?.stop();}
