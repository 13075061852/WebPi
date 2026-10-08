// Real Electron imports, media decoding and local draft persistence. The
// isolated fixture has no personal accounts and blocks every external fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
assert.ok(fs.existsSync(executable), 'Install source Electron before running the digital human regression');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-digital-human-'));
const profile = path.join(fixture, 'profile');
const workspace = path.join(fixture, 'workspace');
const originals = path.join(fixture, 'originals');
const agentDir = path.join(fixture, '.pi', 'agent');
const dialogQueue = path.join(fixture, 'dialog-queue.json');
const dialogLog = path.join(fixture, 'dialog.ndjson');
const networkLog = path.join(fixture, 'network.ndjson');
const photo = path.join(originals, 'portrait.png');
const voice = path.join(originals, 'voice-15-seconds.wav');
const shortVoice = path.join(originals, 'voice-5-seconds.wav');
const longVoice = path.join(originals, 'voice-301-seconds.wav');
const silentVoice = path.join(originals, 'silent-15-seconds.wav');
const clippedVoice = path.join(originals, 'clipped-15-seconds.wav');
const reportDir = path.join(root, 'test', 'results');
for (const directory of [profile, workspace, originals, agentDir, reportDir]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
fs.writeFileSync(dialogQueue, '[]');

function writeWave(file, duration, mode = 'tone') {
  const rate = 16000, count = duration * rate, data = Buffer.alloc(44 + count * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) {
    const seconds = index / rate;
    // This signal checks real decoding and duration. It does not pretend to
    // establish speech intelligibility without a speech service.
    const value = mode === 'silent' ? 0 : mode === 'clipped' ? (Math.sin(seconds * Math.PI * 2 * 220) >= 0 ? 32767 : -32768)
      : Math.round(Math.sin(seconds * Math.PI * 2 * 220) * (0.22 + 0.08 * Math.sin(seconds * Math.PI * 4)) * 32767);
    data.writeInt16LE(value, 44 + index * 2);
  }
  fs.writeFileSync(file, data);
}
writeWave(voice, 15); writeWave(shortVoice, 5); writeWave(longVoice, 301);
writeWave(silentVoice, 15, 'silent'); writeWave(clippedVoice, 15, 'clipped');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHashes = new Map([voice, shortVoice, longVoice, silentVoice, clippedVoice].map(file => [file, hash(file)]));

const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs = require('node:fs');
const { dialog, nativeImage } = require('electron');
const width=600,height=800,bitmap=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let color=[238,233,228];
  const head=((x-300)/115)**2+((y-290)/145)**2<1;
  const body=((x-300)/230)**2+((y-740)/330)**2<1;
  if(body)color=[105,83,66];
  if(head)color=[184,204,225];
  if(head&&y<200)color=[54,48,43];
  if((Math.abs(x-255)<10||Math.abs(x-345)<10)&&Math.abs(y-278)<7)color=[44,44,44];
  if(Math.abs(x-300)<30&&Math.abs(y-348)<5)color=[84,98,142];
  const offset=(y*width+x)*4;bitmap[offset]=color[0];bitmap[offset+1]=color[1];bitmap[offset+2]=color[2];bitmap[offset+3]=255;
}
fs.writeFileSync(${JSON.stringify(photo)},nativeImage.createFromBitmap(bitmap,{width,height}).toPNG());
dialog.showOpenDialog = async (...args) => {
  const queue=JSON.parse(fs.readFileSync(${JSON.stringify(dialogQueue)},'utf8'));
  const file=queue.shift();fs.writeFileSync(${JSON.stringify(dialogQueue)},JSON.stringify(queue));
  fs.appendFileSync(${JSON.stringify(dialogLog)},JSON.stringify({file:file||null,options:args.at(-1)})+'\\n');
  return file ? {canceled:false,filePaths:Array.isArray(file)?file:[file]} : {canceled:true,filePaths:[]};
};
const offlineFetch = async (input, options={}) => {
  const url=typeof input==='string'?input:input.url;
  fs.appendFileSync(${JSON.stringify(networkLog)},JSON.stringify({url,method:options.method||'GET'})+'\\n');
  throw Error('External request blocked by isolated digital human fixture: '+url);
};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>offlineFetch,set:()=>{}});
import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'main', 'main.mjs')).href)}).catch(error=>{console.error(error);process.exitCode=1;});
`);
const system = process.env.SystemRoot || 'C:/Windows';
const env = {
  SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32', 'cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agentDir,
  PI_HALO_PI_PATH: path.join(root, 'test', 'fixtures', 'pi-sdk.js'), PI_OFFLINE: '1',
};
const started = Date.now();
let child, ws, output = '', exited, sequence = 0;
const pending = new Map();
const browserRequests = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(fn, message, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    if (exited !== undefined) throw Error(`App exited before ${message} (${exited}): ${output}`);
    await sleep(60);
  }
  throw Error(`${message}: ${output}`);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Digital human CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response)); return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response?.exceptionDetails, undefined, JSON.stringify(response?.exceptionDetails)); return response?.result?.value;
}
async function pointerClick(selector) {
  const point = await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('Missing control: '+${JSON.stringify(selector)});
    element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await command('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  }
}
async function setInput(selector, value) {
  await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('Missing input: '+${JSON.stringify(selector)});
    element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true;
  })()`);
}
async function choose(selector, file) {
  fs.writeFileSync(dialogQueue, JSON.stringify([file])); await pointerClick(selector);
  await waitFor(() => JSON.parse(fs.readFileSync(dialogQueue, 'utf8')).length === 0, 'Import must invoke the native chooser');
}
async function screenshot(name) {
  await sleep(350);
  const result = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, name), Buffer.from(result.data, 'base64'));
}
const requests = () => fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function state() {
  const result = await evaluate('window.halo.digitalHumanState()');
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
}
const assetFile = asset => path.join(profile, 'digital-human', 'assets', `${asset.id}${asset.kind === 'photo' ? '.png' : '.wav'}`);
async function selectAsset(selector, id) {
  await setInput(selector, id);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), id);
}
async function profileReady() {
  await waitFor(() => evaluate(`!document.querySelector('#settingsModal').hidden&&document.querySelector('#setPane-digital-human').classList.contains('active')&&!document.querySelector('#digitalHumanProfileFields').hidden&&!document.querySelector('#digitalHumanProfileSave').disabled`), 'Digital human configuration must finish loading in settings');
  await waitFor(() => evaluate('document.querySelector("#digitalHumanModal").hidden'), 'Generation form must finish closing before configuration actions');
}
async function openProfileSettings() {
  await pointerClick('#btnSettings');
  await pointerClick('.set-nav[data-pane="digital-human"]');
  await profileReady();
}
async function closeSettings() {
  await pointerClick('#settingsModal [data-close]');
  await waitFor(() => evaluate('document.querySelector("#settingsModal").hidden'), 'Settings must close');
}
async function closeGeneration() {
  await pointerClick('#digitalHumanModal [data-close]');
  await waitFor(() => evaluate('document.querySelector("#digitalHumanModal").hidden'), 'Digital human generation form must close');
}
async function openGeneration() {
  await pointerClick('#btnDigitalHuman');
  await waitFor(() => evaluate('!document.querySelector("#digitalHumanFields").hidden&&!document.querySelector("#digitalHumanModal").hidden&&!document.querySelector("#digitalHumanSave").disabled'), 'Digital human generation form must finish loading');
}

try {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(executable, [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${voice}`],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-7000); });
  child.on('error', error => { output = error.message; }); child.on('exit', code => { exited = code; });
  const page = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json();
      return pages.find(item => item.type === 'page' && item.url.endsWith('index.html'));
    } catch { return null; }
  }, 'Main renderer did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
    if (response.method === 'Network.requestWillBeSent' && /^https?:/.test(response.params.request.url)) browserRequests.push(response.params.request.url);
  });
  await command('Network.enable');
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(result=>result.data)'))?.ready, 'Fixture startup did not finish');
  originalHashes.set(photo, hash(photo));
  await command('Page.bringToFront'); await command('Emulation.setFocusEmulationEnabled', { enabled: true });

  assert.equal(await evaluate('typeof window.halo.digitalHumanState'), 'function', 'Expose the real local draft IPC');
  assert.deepEqual((await state()).photos, []); assert.deepEqual((await state()).voices, []);
  const initial = await state();
  assert.equal(initial.connected, false);
  assert.deepEqual(initial.profile, { photoId: null, photoIds: [], voiceId: null }, 'Person and voice configuration must have a separate profile');
  assert.equal(Object.hasOwn(initial.draft, 'photoId'), false);
  assert.equal(Object.hasOwn(initial.draft, 'voiceId'), false);
  assert.match(await evaluate('document.querySelector("#btnDigitalHuman").textContent'), /数字人/);
  await openGeneration();
  assert.equal(await evaluate(`document.querySelectorAll('#digitalHumanModal #digitalHumanPhotoImport,#digitalHumanModal #digitalHumanVoiceImport,#digitalHumanModal #digitalHumanVoicePreview,#digitalHumanModal #digitalHumanProfileForm').length`), 0, 'The chat generation form must not contain asset or recording configuration');
  assert.equal(await evaluate('document.querySelector("#digitalHumanGenerate").disabled'), true);
  assert.match(await evaluate('document.querySelector("#digitalHumanGenerate").textContent'), /未接通|未接入/);
  const bounds = await evaluate(`(() => {
    const panel=document.querySelector('#digitalHumanModal .digital-human-panel').getBoundingClientRect();
    return {width:panel.width,height:panel.height,left:panel.left,top:panel.top,viewportWidth:innerWidth,viewportHeight:innerHeight};
  })()`);
  assert.ok(bounds.width <= 602 && bounds.width > 550, JSON.stringify(bounds));
  assert.ok(bounds.top >= 0 && bounds.left >= 0 && bounds.height <= Math.min(700, bounds.viewportHeight * 0.9) + 2, JSON.stringify(bounds));
  await screenshot('digital-human-empty.png');

  await pointerClick('#digitalHumanConfigure');
  await profileReady();
  assert.equal(await evaluate('document.querySelector("#digitalHumanModal").hidden'), true, 'Configure must leave the generation form and open settings');
  assert.equal(await evaluate(`document.querySelectorAll('#setPane-digital-human #digitalHumanScript,#setPane-digital-human #digitalHumanScene,#setPane-digital-human #digitalHumanAction,#setPane-digital-human #digitalHumanGenerate').length`), 0, 'Settings must contain reusable configuration without per-video dialogue, scene or actions');
  for (const id of ['digitalHumanPhotoImport', 'digitalHumanPhotoGallery', 'digitalHumanVoiceImport', 'digitalHumanVoice', 'digitalHumanVoicePreview', 'digitalHumanProfileSave']) {
    assert.equal(await evaluate(`!!document.querySelector('#setPane-digital-human #${id}')`), true, `${id} must belong to settings`);
  }

  await choose('#digitalHumanPhotoImport', photo);
  const importedPhoto = await waitFor(async () => (await state()).photos[0], 'Photo import did not create a local copy');
  assert.equal(importedPhoto.width, 600); assert.equal(importedPhoto.height, 800);
  assert.ok(fs.existsSync(assetFile(importedPhoto))); assert.equal(hash(assetFile(importedPhoto)), hash(photo));
  await waitFor(() => evaluate(`(() => {const image=document.querySelector('#digitalHumanPhotoGallery img');return !image.hidden&&image.complete&&image.naturalWidth===600&&image.naturalHeight===800;})()`), 'Photo preview must decode the copied PNG');
  assert.match(await evaluate('document.querySelector("#digitalHumanPhotoGallery img").src'), /^halo-preview:\/\/digital-human\/[0-9a-f-]+$/);

  await choose('#digitalHumanVoiceImport', voice);
  const importedVoice = await waitFor(async () => (await state()).voices.find(item => item.quality === 'ready'), 'Imported WAV must pass real client decoding');
  assert.ok(Math.abs(importedVoice.duration - 15) < 0.03, JSON.stringify(importedVoice));
  assert.ok(fs.existsSync(assetFile(importedVoice))); assert.equal(hash(assetFile(importedVoice)), hash(voice));
  await waitFor(() => evaluate(`!!document.querySelector('#digitalHumanVoice option[value="${importedVoice.id}"]')&&!document.querySelector('#digitalHumanVoiceImport').disabled`), 'Validated recording must finish rendering');
  await selectAsset('#digitalHumanVoice', importedVoice.id);
  const audioDecoded = await waitFor(() => evaluate(`(() => {
    const audio=document.querySelector('#digitalHumanVoicePreview');
    return !audio.hidden&&audio.readyState>=2&&Math.abs(audio.duration-15)<0.03 ? {duration:audio.duration,readyState:audio.readyState,src:audio.src}:null;
  })()`), 'Voice preview must decode the actual WAV');
  assert.match(audioDecoded.src, /^halo-preview:\/\/digital-human\/[0-9a-f-]+$/);
  await evaluate(`(async()=>{const {decorateArtifactCard,replyArtifacts}=await import('./js/artifacts.mjs');const card=document.createElement('button');card.id='audioCardFixture';decorateArtifactCard(card,'voice.wav',${JSON.stringify(audioDecoded.src)},{bytes:480044});document.body.append(card);return replyArtifacts('[录音](voice.wav)','C:/fixture');})()`);
  await waitFor(() => evaluate(`document.querySelector('#audioCardFixture .artifact-media-info').textContent==='468.8 KB · 0:15'`), 'Audio card must show decoded duration and file size');
  await evaluate(`document.querySelector('#audioCardFixture').remove()`);
  const clip = await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d'),stream=canvas.captureStream(10),chunks=[];const recorder=new MediaRecorder(stream,{mimeType:'video/mp4;codecs=avc1.42001E'});const done=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();for(let i=0;i<10;i++){ctx.fillStyle=i%2?'red':'blue';ctx.fillRect(0,0,160,90);await new Promise(r=>setTimeout(r,100));}recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());return btoa(String.fromCharCode(...new Uint8Array(await new Blob(chunks).arrayBuffer())));})()`);
  const clipFile=path.join(workspace,'card-video.mp4');fs.writeFileSync(clipFile,Buffer.from(clip,'base64'));
  const info=await evaluate(`window.halo.artifactFiles([${JSON.stringify(clipFile)}],{mediaMetadata:true})`);
  assert.equal(info.data[0].bytes,fs.statSync(clipFile).size);
  await evaluate(`(async()=>{const {decorateArtifactCard}=await import('./js/artifacts.mjs');const card=document.createElement('button');card.id='videoCardFixture';decorateArtifactCard(card,'card-video.mp4',${JSON.stringify('halo-preview://local/'+clipFile.replaceAll('\\','/'))},{bytes:${info.data[0].bytes}});document.body.append(card);})()`);
  await waitFor(()=>evaluate(`!!document.querySelector('#videoCardFixture .artifact-media-info').textContent.match(/[0-9.]+ (B|KB|MB) · 0:01/)`),'Video card must show actual file size and decoded duration');
  await evaluate(`document.querySelector('#videoCardFixture').remove()`);


  await evaluate(`(async () => {const audio=document.querySelector('#digitalHumanVoicePreview');audio.muted=true;await audio.play();return true;})()`);
  await waitFor(() => evaluate('!document.querySelector("#digitalHumanVoicePreview").paused&&document.querySelector("#digitalHumanVoicePreview").currentTime>0.05'), 'Voice sample must support actual playback');
  await evaluate('document.querySelector("#digitalHumanVoicePreview").pause();true');

  for (const [file, message] of [[shortVoice, /至少.*10.*秒/], [longVoice, /超过.*5.*分钟/], [silentVoice, /没有.*声音/]]) {
    await choose('#digitalHumanVoiceImport', file);
    await waitFor(async () => {
      const status = await evaluate('document.querySelector("#digitalHumanStatus").textContent');
      return message.test(status) && await evaluate('!document.querySelector("#digitalHumanVoiceImport").disabled');
    }, `${path.basename(file)} must show its local validation error`);
    assert.equal((await state()).voices.length, 1, 'Rejected recording copies must be removed');
    assert.equal(await evaluate('document.querySelector("#digitalHumanVoice").value'), importedVoice.id, 'Invalid imports must preserve the previous valid selection');
  }
  await choose('#digitalHumanVoiceImport', clippedVoice);
  const clipped = await waitFor(async () => (await state()).voices.find(item => item.name === path.basename(clippedVoice) && item.quality === 'ready'), 'A decoded loud sample should remain auditionable');
  await waitFor(() => evaluate('document.querySelector("#digitalHumanVoiceQuality").textContent.match(/破音|调低/)'), 'Clipped audio must show its measured quality warning');
  assert.equal(await evaluate('document.querySelector("#digitalHumanVoice").value'), clipped.id);
  await pointerClick('#digitalHumanVoiceDelete');
  await waitFor(async () => !(await state()).voices.some(item => item.id === clipped.id), 'Warning sample must support copy removal');
  assert.equal(fs.existsSync(assetFile(clipped)), false); assert.equal(hash(clippedVoice), originalHashes.get(clippedVoice));
  await selectAsset('#digitalHumanVoice', importedVoice.id);
  await pointerClick('#digitalHumanProfileSave');
  const configured = await waitFor(async () => {
    const current = await state();
    return current.profile.photoId === importedPhoto.id && current.profile.voiceId === importedVoice.id ? current : null;
  }, 'Save configuration must persist the selected person and voice');
  await waitFor(() => evaluate('!document.querySelector("#digitalHumanProfileSave").disabled'), 'Profile save must finish before closing');
  assert.deepEqual(configured.draft, initial.draft, 'Saving reusable configuration must not alter the video draft');
  const storedProfile = JSON.parse(fs.readFileSync(path.join(profile, 'digital-human', 'draft.json'), 'utf8'));
  assert.deepEqual(storedProfile.profile, configured.profile, 'Profile must persist independently in local storage');
  await screenshot('digital-human-settings.png');
  await evaluate(`(async () => {const audio=document.querySelector('#digitalHumanVoicePreview');audio.muted=true;await audio.play();return true;})()`);
  await closeSettings();
  assert.equal(await evaluate('document.querySelector("#digitalHumanVoicePreview").paused'), true, 'Closing settings must stop sample playback');
  // Clear hidden nodes without changing dirty state, so the following open
  // proves restoration from persisted configuration instead of old controls.
  await evaluate(`(() => {for(const id of ['digitalHumanVoice'])document.getElementById(id).value='';return true;})()`);
  await openProfileSettings();
  assert.equal(await evaluate(`document.querySelector('#digitalHumanPhotoGallery [aria-pressed="true"]').dataset.photoId`), importedPhoto.id);
  assert.equal(await evaluate('document.querySelector("#digitalHumanVoice").value'), importedVoice.id);
  await closeSettings();
  await openGeneration();
  await waitFor(() => evaluate(`(() => {const image=document.querySelector('#digitalHumanConfiguredPhoto');return !image.hidden&&image.complete&&image.naturalWidth===600&&image.naturalHeight===800;})()`), 'Generation must display the configured photo summary');
  assert.ok((await evaluate('document.querySelector("#digitalHumanConfiguredVoice").textContent')).includes(importedVoice.name), 'Generation must display the configured voice summary');
  const script = '你好，我是这个工作室的讲解员。今天和大家分享一个小技巧：先准备自己的照片，再录制清晰自然的声音样本。这里暂时只保存创作草稿，不会调用收费接口。'.repeat(3);
  const scene = '明亮的工作室，站在产品展示台旁，背景简洁。';
  const action = '看向镜头，微笑讲解，抬手展示产品。';
  await setInput('#digitalHumanScript', script); await setInput('#digitalHumanScene', scene); await setInput('#digitalHumanAction', action);
  await setInput('#digitalHumanRatio', '9:16');
  assert.equal(await evaluate('document.querySelector("#digitalHumanSegments").hidden'), false, 'Long dialogue must expose the local segment plan');
  assert.equal(await evaluate('[...document.querySelectorAll("#digitalHumanSegmentList li")].map(item=>item.textContent).join("")'), script, 'Planning must preserve all user dialogue');
  await pointerClick('#digitalHumanSave');
  const saved = await waitFor(async () => {
    const current = await state();
    return current.draft.script === script && current.draft.scene === scene && current.draft.action === action && current.draft.ratio === '9:16' ? current : null;
  }, 'The production save button must persist all draft fields');
  await waitFor(() => evaluate('!document.querySelector("#digitalHumanSave").disabled'), 'Video draft save must finish before closing');
  assert.deepEqual(saved.profile, configured.profile, 'Saving video dialogue must preserve reusable person and voice configuration');
  assert.equal(Object.hasOwn(saved.draft, 'photoId'), false); assert.equal(Object.hasOwn(saved.draft, 'voiceId'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'digital-human', 'draft.json'), 'utf8')).draft.script, script, 'Draft must persist to local storage');
  assert.equal(saved.connected, false); assert.equal(await evaluate('document.querySelector("#digitalHumanGenerate").disabled'), true);
  await screenshot('digital-human.png');
  const populatedBounds = await evaluate(`(() => {
    const panel=document.querySelector('#digitalHumanModal .digital-human-panel').getBoundingClientRect();
    const footer=document.querySelector('#digitalHumanModal .digital-human-footer').getBoundingClientRect();
    return {width:panel.width,height:panel.height,top:panel.top,bottom:panel.bottom,footerBottom:footer.bottom,viewportHeight:innerHeight};
  })()`);
  assert.ok(populatedBounds.width >= 599 && populatedBounds.width <= 602, JSON.stringify(populatedBounds));
  assert.ok(populatedBounds.top >= 0 && populatedBounds.height <= Math.min(700, populatedBounds.viewportHeight * 0.9) + 2, JSON.stringify(populatedBounds));
  assert.ok(populatedBounds.footerBottom <= populatedBounds.bottom + 1, 'Draft actions must remain inside the populated modal');
  await closeGeneration();
  // Clear the hidden DOM without input events: reopening must restore the
  // saved draft through the production loader, not merely retain old nodes.
  await evaluate(`(() => {for(const id of ['digitalHumanScript','digitalHumanScene','digitalHumanAction'])document.getElementById(id).value='';return true;})()`);
  await openGeneration();
  for (const [selector, value] of [['#digitalHumanScript', script], ['#digitalHumanScene', scene], ['#digitalHumanAction', action], ['#digitalHumanRatio', '9:16']]) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value, `${selector} must restore its saved value`);
  }
  await closeGeneration();
  await openProfileSettings();
  await pointerClick(`[data-photo-id="${importedPhoto.id}"]`);
  await pointerClick('#digitalHumanProfileSave');
  await waitFor(async () => (await state()).profile.photoId === null, 'Reusable photo configuration must support independent changes');
  await waitFor(() => evaluate('!document.querySelector("#digitalHumanProfileSave").disabled'), 'Changed profile save must finish before closing');
  assert.deepEqual((await state()).draft, saved.draft, 'Adjusting person configuration must not modify the saved dialogue, scene or actions');
  assert.equal((await state()).profile.voiceId, importedVoice.id, 'Changing the photo must preserve the voice configuration');
  await closeSettings();
  await openGeneration();
  assert.equal(await evaluate('document.querySelector("#digitalHumanConfiguredPhoto").hidden'), true, 'Generation summary must reflect the changed saved profile');
  assert.equal(await evaluate('document.querySelector("#digitalHumanScript").value'), script, 'Configuration changes must preserve the independent video draft');
  await pointerClick('#digitalHumanConfigure');
  await profileReady();
  await pointerClick(`[data-photo-id="${importedPhoto.id}"]`);
  await pointerClick(`[data-photo-remove="${importedPhoto.id}"]`);
  await waitFor(async () => (await state()).photos.length === 0, 'Photo removal must delete the copied asset');
  assert.equal(fs.existsSync(assetFile(importedPhoto)), false);
  assert.equal(hash(photo), originalHashes.get(photo), 'Removing a photo must preserve the original file');
  await pointerClick('#digitalHumanVoiceDelete');
  await waitFor(async () => !(await state()).voices.some(item => item.id === importedVoice.id), 'Voice removal must delete the copied asset');
  assert.equal(fs.existsSync(assetFile(importedVoice)), false);
  assert.equal(hash(voice), originalHashes.get(voice), 'Removing a voice must preserve the original file');
  assert.equal((await state()).profile.photoId, null); assert.equal((await state()).profile.voiceId, null);
  assert.deepEqual((await state()).draft, saved.draft, 'Removing reusable assets must preserve the independent written video draft');
  await choose('#digitalHumanPhotoImport', [photo, photo]);
  await waitFor(() => evaluate(`document.querySelectorAll('#digitalHumanPhotoGallery [aria-pressed="true"]').length===2`), 'Batch photos must both be selected');
  await pointerClick('#digitalHumanProfileSave');
  await waitFor(async () => (await state()).profile.photoIds.length === 2, 'Multiple selected photos must persist');
  await evaluate(`(() => {const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.captureOriginal=original;navigator.mediaDevices.getUserMedia=async options=>{window.captureStream=await original(options);return window.captureStream;};return true;})()`);
  await pointerClick('#digitalHumanRecordStart');
  await waitFor(() => evaluate(`document.querySelector('#digitalHumanRecorder').dataset.state==='recording'`), 'Fake microphone must start via trusted audio permissions');
  await sleep(11000);
  await pointerClick('#digitalHumanRecordStop');
  const recorded = await waitFor(async () => (await state()).voices.find(asset => asset.name.startsWith('录音-')&&asset.quality==='ready'), 'Recording must become a validated local WAV');
  assert.ok(recorded.duration>=10&&recorded.duration<15);
  assert.equal(await evaluate(`window.captureStream.getTracks().every(track=>track.readyState==='ended')`), true);
  await waitFor(() => evaluate(`!document.querySelector('#digitalHumanRecordStart').disabled`), 'Recording processing must complete');
  await pointerClick('#digitalHumanProfileSave');
  await waitFor(async () => (await state()).profile.voiceId===recorded.id, 'Recorded voice must save to profile');
  await screenshot('digital-human-settings.png');
  await pointerClick('#digitalHumanRecordStart');
  await waitFor(() => evaluate(`document.querySelector('#digitalHumanRecorder').dataset.state==='recording'`), 'Second capture must start');
  await closeSettings();
  assert.equal(await evaluate(`window.captureStream.getTracks().every(track=>track.readyState==='ended')`), true, 'Closing settings must release microphone');
  assert.equal((await state()).voices.length,1,'Cancelled recording must not create a voice asset');
  await openGeneration();
  await pointerClick('#digitalHumanGenerate');
  assert.equal((await state()).connected, false, 'Disabled generation must not invent a connected provider');
  assert.equal(requests().length, 0); assert.equal(browserRequests.length, 0);
  assert.equal(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'), '{}');
  for (const [file, digest] of originalHashes) assert.equal(hash(file), digest);
  await evaluate('setTimeout(()=>window.halo.close(),30);true');
  await waitFor(() => exited !== undefined, 'Isolated app did not close', 15000); assert.equal(exited, 0);
  const result = { passed: true, isolated: true, batchPhotos: true, microphoneRecorded: true, microphoneReleasedOnClose: true, photo: { width: importedPhoto.width, height: importedPhoto.height }, audioDecoded,
    shortAndLongAudioRejected: true, silentAudioRejected: true, clippedAudioWarning: true, segmentTextPreserved: true,
    reusableProfileSaved: true, profileAndDraftIndependent: true, configurationInSettings: true, generationFormContainsNoImportControls: true,
    draftSaved: true, reopened: true, copiedAssetsRemoved: true, originalsPreserved: true, populatedBounds, connected: false, externalRequests: requests().length + browserRequests.length,
    exitCode: exited, elapsedMs: Date.now() - started };
  fs.writeFileSync(path.join(reportDir, 'digital-human.json'), JSON.stringify(result, null, 2) + '\n');
  fs.rmSync(path.join(reportDir, 'digital-human-failure.log'), { force: true });
  console.log(`PASS digital human: real photo/WAV configuration in settings, independent saved/reopened video draft, safe asset removal and no paid requests (${result.elapsedMs}ms)`);
} catch (error) {
  fs.writeFileSync(path.join(reportDir, 'digital-human-failure.log'), error.message + '\n' + output);
  throw error;
} finally {
  ws?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await Promise.race([closed, sleep(5000)]); }
  const target = path.resolve(fixture); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-digital-human-'));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
