// Run with Electron. Isolated renderer fixture; no network or personal credentials.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { VIDEO_PROVIDERS } from '../../src/main/video-providers.mjs';

const directory = path.resolve('tmp/video-confirmation');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
const win = new BrowserWindow({ width: 600, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
try {
  const html = path.join(directory, 'fixture.html');
  fs.writeFileSync(html, `<html data-theme="light"><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/css/app.css'))}"><body style="display:block;padding:24px;background:var(--bg1)"><div class="tool" id="fixture"><div class="tool-line">video_generate · 等待确认</div></div></body></html>`);
  await win.loadFile(html);
  const request = { id: 'fixture', provider: 'apimart', providerName: 'APIMart', ...VIDEO_PROVIDERS.apimart.defaults,
    modelOptions: VIDEO_PROVIDERS.apimart.modelOptions, prompt: '生成一个机械在运行过程中多视角拍摄的视频', estimate: { available: true, total: 1.2, currency: 'Credits' } };
  const moduleURL = pathToFileURL(path.resolve('src/renderer/js/video-confirmation.mjs')).href;
  await win.webContents.executeJavaScript(`(async()=>{
    const {mountVideoConfirmation}=await import(${JSON.stringify(moduleURL)});
    window.responses=[]; window.estimates=[];
    const api={videoConfirm:async value=>{responses.push(value);return {ok:true};},videoEstimate:async value=>{estimates.push(value);return {ok:true,data:{available:true,total:2,currency:'Credits'}};}};
    mountVideoConfirmation(document.querySelector('#fixture'),${JSON.stringify(request)},api);
    window.mountAgain=()=>mountVideoConfirmation(document.querySelector('#fixture'),{...${JSON.stringify(request)},id:'second'},api);
  })()`);
  await win.webContents.executeJavaScript(`const model=document.querySelector('[name=model]');model.value='sora-2';model.dispatchEvent(new Event('change',{bubbles:true}));`);
  const durations = await win.webContents.executeJavaScript(`Array.from(document.querySelector('[name=duration]').options,o=>Number(o.value))`);
  assert.deepEqual(durations, [4,8,12,16,20]);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await win.webContents.executeJavaScript('estimates.at(-1).model'), 'sora-2');
  await win.webContents.executeJavaScript(`document.querySelector('[name=duration]').value='8';`);
  fs.writeFileSync(path.join(directory,'light.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(360,600);
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='dark';document.querySelectorAll('select').forEach(s=>s.style.transition='none')`);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'), true);
  fs.writeFileSync(path.join(directory,'dark-narrow.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('.video-confirm-submit').click();document.querySelector('.video-confirm-submit').click();`);
  const replies = await win.webContents.executeJavaScript('responses');
  assert.equal(replies.length, 1); assert.equal(replies[0].options.model, 'sora-2'); assert.equal(replies[0].options.duration, 8);
  await win.webContents.executeJavaScript(`mountAgain();document.querySelector('.video-confirm-cancel').click()`);
  assert.equal(await win.webContents.executeJavaScript('responses.at(-1).approved'), false);
  console.log('PASS inline video UI: model-dependent fields, pricing, submission, duplicate click, cancel, narrow layout');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { win.destroy(); app.quit(); }

});
