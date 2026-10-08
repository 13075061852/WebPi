// Real Electron IPC, file grants and HTML video decoding with isolated local
// records. The remote fixture is served in memory: no accounts or paid APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
assert.ok(fs.existsSync(executable), 'Install source Electron before running the video history regression');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-history-'));
const profile = path.join(fixture, 'profile');
const workspace = path.join(fixture, 'workspace');
const otherProject = path.join(fixture, 'unregistered-project');
const agentDir = path.join(fixture, '.pi', 'agent');
const jobsFile = path.join(agentDir, 'halo-video-jobs.json');
const clipFile = path.join(fixture, 'remote-clip.bin');
const mimeFile = path.join(fixture, 'remote-mime.txt');
const networkLog = path.join(fixture, 'network.ndjson');
const reportDir = path.join(root, 'test', 'results');
for (const directory of [profile, workspace, otherProject, agentDir, reportDir]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
fs.writeFileSync(jobsFile, '[]');

// Main's GlobalProxy installs undici during bootstrap. Keep this test's fetch
// fixed across that install, before VideoGeneration captures it. Every other
// URL fails locally rather than reaching a network or real model provider.
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs = require('node:fs');
const fixtureFetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  fs.appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({ url:url.href, method, headers:Object.fromEntries(headers) }) + '\\n');
  if (url.origin !== 'https://video-history.invalid' || !['HEAD','GET'].includes(method)) throw Error('Unexpected network request blocked by video history fixture: ' + url.href);
  if (url.pathname.startsWith('/expired')) return new Response(method === 'HEAD' ? null : 'expired', { status:410 });
  if (url.pathname.startsWith('/unavailable')) return new Response(method === 'HEAD' ? null : 'forbidden', { status:403 });
  const data = fs.readFileSync(${JSON.stringify(clipFile)});
  const resultHeaders = { 'content-type':fs.readFileSync(${JSON.stringify(mimeFile)},'utf8'), 'accept-ranges':'bytes', 'cache-control':'no-store' };
  let start = 0, end = data.length - 1, status = 200;
  const range = headers.get('range');
  if (range) {
    const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null,{status:416});
    if (!match[1]) start = Math.max(0,data.length-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(start > end || start >= data.length) return new Response(null,{status:416});
    status=206;resultHeaders['content-range']='bytes '+start+'-'+end+'/'+data.length;
  }
  resultHeaders['content-length']=String(end-start+1);
  return new Response(method === 'HEAD' ? null : data.subarray(start,end+1),{status,headers:resultHeaders});
};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>fixtureFetch,set:()=>{}});
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
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Video history CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response?.exceptionDetails, undefined, JSON.stringify(response?.exceptionDetails));
  return response?.result?.value;
}
async function pointerClick(selector) {
  const point = await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element)throw Error('Missing control: '+${JSON.stringify(selector)});
    element.scrollIntoView({block:'center'});
    const rect=element.getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await command('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  }
}
const row = id => `.video-history-record[data-job-id="${id}"]`;
const source = (id, name) => `${row(id)} .video-history-source[data-source="${name}"]`;
async function decoded(id) {
  return waitFor(() => evaluate(`(() => {
    const video=document.querySelector(${JSON.stringify(row(id))})?.querySelector('video.video-history-player,.video-history-player video');
    return video&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0 ? {readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,src:video.getAttribute('src')} : null;
  })()`), `${id} must decode a real video`, 15000);
}
const requests = () => fs.existsSync(networkLog) ? fs.readFileSync(networkLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

try {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(executable, [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-7000); });
  child.on('error', error => { output = error.message; });
  child.on('exit', code => { exited = code; });
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
  });
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(result=>result.data)'))?.ready, 'Fixture startup did not finish');
  assert.equal(await evaluate('typeof window.halo.videoHistoryPlayback'), 'function', 'Expose the production playback IPC through preload');
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const clip = await evaluate(`(async () => {
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const context=canvas.getContext('2d'),stream=canvas.captureStream(15);
    const mime=MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E')?'video/mp4;codecs=avc1.42001E':'video/webm';
    const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);
    const finished=new Promise(resolve=>{recorder.onstop=resolve;});recorder.start();
    for(let frame=0;frame<12;frame++) {context.fillStyle='#213b65';context.fillRect(0,0,320,180);context.fillStyle='#fff';context.font='20px sans-serif';context.fillText('VIDEO HISTORY '+frame,40,95);await new Promise(resolve=>setTimeout(resolve,70));}
    recorder.stop();await finished;stream.getTracks().forEach(track=>track.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
    return {data:btoa(String.fromCharCode(...bytes)),mime:mime.split(';')[0],ext:mime.includes('mp4')?'mp4':'webm'};
  })()`);
  const bytes = Buffer.from(clip.data, 'base64');
  assert.ok(bytes.length > 100, 'Fixture must contain actual encoded video frames');
  fs.writeFileSync(clipFile, bytes); fs.writeFileSync(mimeFile, clip.mime);
  const localFile = path.join(workspace, 'output', `current.${clip.ext}`);
  const otherFile = path.join(otherProject, 'output', `other.${clip.ext}`);
  const deleteLaterFile = path.join(workspace, 'output', `delete-later.${clip.ext}`);
  const missingFile = path.join(workspace, 'output', `deleted.${clip.ext}`);
  const outsideFile = path.join(fixture, `private-outside.${clip.ext}`);
  for (const file of [localFile, otherFile, deleteLaterFile, outsideFile]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const job = (id, amount, extra = {}) => ({ id, provider: 'apimart', model: 'MiniMax-H3', status: 'delivered',
    cwd: workspace, createdAt: '2026-10-05T00:00:00Z', duration: 5, resolution: '720p',
    billing: { actual: { amount, unit: 'Credits' }, estimate: { total: amount + 0.5, currency: 'Credits' } }, ...extra });
  const readyURL = `https://video-history.invalid/ready.${clip.ext}?signature=fixture-only`;
  const jobs = [
    job('current-local', 1.144, { file: localFile, url: readyURL }),
    job('other-project', 2, { cwd: otherProject, file: otherFile }),
    job('delete-later', 3, { file: deleteLaterFile }),
    job('already-deleted', 4, { file: missingFile }),
    job('legacy-no-address', 0, { billing: { actual: null, estimate: { total: 4.5, currency: 'USD' } } }),
    job('remote-ready', 5, { url: readyURL }),
    job('remote-expired', 6, { url: `https://video-history.invalid/expired.${clip.ext}` }),
    job('remote-unavailable', 7, { url: `https://video-history.invalid/unavailable.${clip.ext}` }),
  ];
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const history = await evaluate('window.halo.videoHistory()');
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.equal(history.data.length, jobs.length);
  const byId = new Map(history.data.map(item => [item.id, item]));
  assert.equal(byId.get('current-local').actual.amount, 1.144);
  assert.equal(byId.get('current-local').estimate.total, 1.644);
  assert.equal(byId.get('legacy-no-address').estimate.total, 4.5);
  assert.equal(byId.get('current-local').file, localFile);
  assert.equal(byId.get('current-local').url, readyURL);
  assert.equal(byId.get('current-local').localStatus, 'ready');
  assert.equal(byId.get('other-project').localStatus, 'ready', 'Completed videos from an unregistered project must remain available');
  assert.equal(byId.get('already-deleted').localStatus, 'deleted');
  assert.equal(requests().length, 0, 'Listing history must not probe remote addresses or query a paid provider');

  await pointerClick('#ctxVideoQuota');
  await waitFor(() => evaluate(`!document.querySelector('#videoUsageModal').hidden&&document.querySelectorAll('#videoUsageBody .video-history-record').length===${jobs.length}`), 'Video history records did not render');
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(row('current-local'))}).textContent`)).includes('1.144 积分'));
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(row('legacy-no-address'))}).textContent`)).includes('预估 4.5 USD'));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(source('current-local', 'local') + ' .video-history-address')}).textContent`), localFile);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(source('current-local', 'remote') + ' .video-history-address')}).textContent`), readyURL);
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(source('already-deleted', 'local') + ' .video-history-source-status')}).textContent`), /删除/);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(source('already-deleted', 'local') + ' .video-history-play')}).disabled`), true);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('legacy-no-address'))}).querySelectorAll('.video-history-play').length`), 0, 'An old record must not invent a playable address');
  assert.equal(requests().length, 0, 'Opening the history panel must remain a local read');
  await sleep(350); // Capture the settled modal rather than its opening fade.
  const listImage = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, 'video-history-list.png'), Buffer.from(listImage.data, 'base64'));

  await pointerClick(source('current-local', 'local') + ' .video-history-address');
  const localDecoded = await decoded('current-local');
  assert.match(localDecoded.src, /^halo-preview:\/\/video-history\/[A-Za-z0-9_-]+$/);
  assert.ok(!localDecoded.src.includes(encodeURIComponent(workspace)), 'Playback src must not expose a filesystem path');
  await pointerClick(source('other-project', 'local') + ' .video-history-play');
  const otherDecoded = await decoded('other-project');
  assert.match(otherDecoded.src, /^halo-preview:\/\/video-history\/[A-Za-z0-9_-]+$/);
  const projects = await evaluate('window.halo.projectsList()');
  assert.ok(!projects.data.some(item => path.resolve(item.cwd).toLowerCase() === otherProject.toLowerCase()), 'Playing old history must not register another project');

  await pointerClick(source('remote-ready', 'remote') + ' .video-history-play');
  const remoteDecoded = await decoded('remote-ready');
  assert.match(remoteDecoded.src, /^halo-preview:\/\/video-history\/[A-Za-z0-9_-]+$/);
  assert.ok(requests().some(item => item.method === 'HEAD'), 'An explicit remote click should probe the recorded address');
  assert.ok(requests().some(item => item.method === 'GET'), 'The remote player should stream real video bytes');
  const playbackImage = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, 'video-history-playback.png'), Buffer.from(playbackImage.data, 'base64'));
  await pointerClick(source('remote-expired', 'remote') + ' .video-history-address');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(row('remote-expired'))}).querySelector('.video-history-notice')?.textContent.match(/失效|过期/)`), 'Expired cloud address must show a concise notice');
  await pointerClick(source('remote-unavailable', 'remote') + ' .video-history-play');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(row('remote-unavailable'))}).querySelector('.video-history-notice')?.textContent.match(/不可用|访问|播放/)`), 'Inaccessible cloud address must show a concise notice');

  await pointerClick(source('delete-later', 'local') + ' .video-history-play');
  await decoded('delete-later');
  await fs.promises.unlink(deleteLaterFile);
  // A completely decoded tiny clip can stay in Chromium's media cache after
  // unlink. Replay through the actual control must recheck the file anyway.
  await pointerClick(source('delete-later', 'local') + ' .video-history-play');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(row('delete-later'))}).querySelector('.video-history-notice')?.textContent.match(/删除/)`), 'Replaying a file deleted after opening must report its current status');
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(row('delete-later'))}).textContent`)).includes('3 积分'), 'File deletion must preserve cost history');
  const image = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, 'video-history.png'), Buffer.from(image.data, 'base64'));

  const key = { provider: 'apimart', id: 'current-local', cwd: workspace, source: 'local' };
  const keyed = await evaluate(`window.halo.videoHistoryPlayback(${JSON.stringify({ ...key, file: outsideFile })})`);
  assert.equal(keyed.ok, true, JSON.stringify(keyed));
  assert.equal(keyed.data.address, localFile, 'Extra input paths cannot replace the recorded video');
  const forged = await evaluate(`window.halo.videoHistoryPlayback(${JSON.stringify({ ...key, id: 'does-not-exist' })})`);
  assert.ok(!forged.ok || forged.data.status !== 'ready', 'A forged job ID must not receive a playback grant');
  const traversal = await evaluate(`fetch('halo-preview://video-history/not-a-token').then(response=>response.status).catch(()=>'blocked')`);
  assert.ok([403, 404, 'blocked'].includes(traversal), 'Unknown video tokens must be rejected by the protocol or renderer policy');
  const outside = await evaluate(`fetch(${JSON.stringify(`halo-preview://local/${outsideFile.replaceAll('\\', '/')}`)}).then(response=>response.status).catch(()=>'blocked')`);
  assert.ok([403, 'blocked'].includes(outside), 'Video-history grants must not widen normal workspace file access');

  await pointerClick(source('current-local', 'local') + ' .video-history-play');
  await decoded('current-local');
  await evaluate(`window.__videoHistoryRefreshPlayer=document.querySelector(${JSON.stringify(row('current-local'))}).querySelector('video');true`);
  await pointerClick('#refreshVideoUsage');
  await waitFor(() => evaluate(`document.querySelectorAll('#videoUsageBody .video-history-record').length===${jobs.length}&&document.querySelectorAll('#videoUsageBody .video-history-player').length===0`), 'Refreshing history must remove existing players');
  assert.equal(await evaluate('window.__videoHistoryRefreshPlayer.paused&&!window.__videoHistoryRefreshPlayer.getAttribute("src")'), true, 'Refresh must stop and release the previous video source');
  await pointerClick(source('current-local', 'local') + ' .video-history-play');
  await decoded('current-local');
  await evaluate(`window.__videoHistoryClosePlayer=document.querySelector(${JSON.stringify(row('current-local'))}).querySelector('video');true`);
  await pointerClick('#videoUsageModal [data-close]');
  await waitFor(() => evaluate('document.querySelector("#videoUsageModal").hidden'), 'History modal must close');
  assert.equal(await evaluate('document.querySelectorAll("#videoUsageBody .video-history-player").length'), 0, 'Closing history must remove players');
  assert.equal(await evaluate('window.__videoHistoryClosePlayer.paused&&!window.__videoHistoryClosePlayer.getAttribute("src")'), true, 'Close must stop and release the previous video source');
  const network = requests();
  assert.ok(network.every(item => new URL(item.url).origin === 'https://video-history.invalid' && ['HEAD', 'GET'].includes(item.method)), 'Only in-memory media probes and streaming are permitted');
  assert.ok(network.every(item => !item.headers.authorization && !item.headers.cookie), 'History playback must not attach API credentials');
  assert.equal(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'), '{}');
  await evaluate('setTimeout(()=>window.halo.close(),30);true');
  await waitFor(() => exited !== undefined, 'Isolated app did not close', 15000); assert.equal(exited, 0);
  const result = { passed: true, isolated: true, realDecodedVideo: clip.mime, records: jobs.length,
    localDecoded, otherDecoded, remoteDecoded, localDeleted: true, remoteExpired: true, costsPreserved: true,
    closeAndRefreshReleasePlayers: true, pathGrantsRestricted: true, requests: network.length, paidRequests: 0,
    exitCode: exited, elapsedMs: Date.now() - started };
  fs.writeFileSync(path.join(reportDir, 'video-history.json'), JSON.stringify(result, null, 2) + '\n');
  fs.rmSync(path.join(reportDir, 'video-history-failure.log'), { force: true });
  console.log(`PASS video history: ${jobs.length} cost records, local/unregistered-project/cloud decoding, deleted/expired notices, safe grants and released players (${result.elapsedMs}ms)`);
} catch (error) {
  fs.writeFileSync(path.join(reportDir, 'video-history-failure.log'), error.message + '\n' + output);
  throw error;
} finally {
  ws?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await Promise.race([closed, sleep(5000)]); }
  const target = path.resolve(fixture);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-video-history-'));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
