// Real Electron renderer + artifactFiles IPC. All videos and account state are
// temporary; no model, video provider, or external network is used.
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
const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
assert.ok(fs.existsSync(executable), 'Install source Electron before running the video artifact regression');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-artifacts-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), agent = path.join(fixture, 'agent');
const reports = path.join(root, 'test', 'results');
for (const directory of [profile, workspace, agent, reports]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
fs.writeFileSync(path.join(fixture, 'gitconfig'), '');
fs.writeFileSync(path.join(fixture, 'npmrc'), '');
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => async () => { throw Error('External network disabled by video artifact regression'); }, set: () => {} });
const { app, session } = require('electron');
app.once('ready', () => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'main', 'main.mjs')).href)}).catch(error => { console.error(error); process.exitCode = 1; });
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE|PROXY|^GIT_|^GH_|^GCM_|^SSH_|^NODE_OPTIONS$)/i.test(key)));
Object.assign(env, {
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_CACHE_HOME: path.join(fixture, 'cache'), GH_CONFIG_DIR: path.join(fixture, 'gh'),
  GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(fixture, 'empty-gcm-store'), GCM_INTERACTIVE: 'never',
  NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc'), TEMP: fixture, TMP: fixture, NO_PROXY: '*',
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_HALO_PI_PATH: path.join(root, 'test', 'fixtures', 'pi-sdk.js'),
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, ws, output = '', exited, sequence = 0;
const pending = new Map();
async function waitFor(fn, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    if (exited !== undefined) throw Error(`App exited before ${message} (${exited}): ${output}`);
    await sleep(60);
  }
  const state = ws ? await evaluate(`(async()=>({cwd:document.documentElement.dataset.projectCwd,cards:[...document.querySelectorAll('.turn-artifacts')].map(box=>box.textContent),errors:window.__artifactErrors,turns:await Promise.all([...document.querySelectorAll('.turn')].map(async turn=>({texts:turn.__texts,files:turn.__artifactFiles,results:[...(turn.__videoResults?.values()||[])],request:turn.__artifactRequest,complete:turn.classList.contains('complete'),checked:await window.halo.artifactFiles([...(await import('./js/artifacts.mjs')).replyArtifacts(turn.__texts?.at(-1)||'',document.documentElement.dataset.projectCwd),...(turn.__artifactFiles||[])],{videoHashes:true,mediaMetadata:true})}))) }))()`).catch(() => null) : null;
  throw Error(`${message}: ${JSON.stringify(state)}\n${output}`);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Video artifact CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(result?.exceptionDetails, undefined, JSON.stringify(result?.exceptionDetails));
  return result?.result?.value;
}
const normalized = file => file.replaceAll('\\', '/').toLowerCase();
const cardState = () => evaluate(`Array.from(document.querySelectorAll('.turn-artifacts .artifact-video-row'), row => ({
  file:row.dataset.artifactPath, name:row.querySelector('.artifact-name')?.textContent,
  model:row.querySelector('.artifact-video-model')?.textContent,
  metrics:row.querySelector('.artifact-video-metrics')?.textContent,
  title:row.querySelector('.artifact-card').title
}))`);
async function singleDelivery(file, label) {
  await waitFor(async () => {
    const cards = await cardState();
    return cards.length === 1 && cards[0].file === normalized(file) && cards[0].model === 'APIMart · MiniMax-H3';
  }, label);
  const [card] = await cardState();
  assert.equal(card.metrics, '生成用时 2分钟 47秒 · 实际消耗 1.144 积分', `${label}: inherit original generation timing and usage`);
  assert.match(card.title, /任务 ID：copied-video/);
  assert.equal(normalized(card.title.split('\n')[0]), normalized(file), `${label}: card must target the final delivery path`);
}
async function restore(messages, id) {
  // Keep the bridge's normalized cwd; a synthetic Windows backslash path would
  // be replaced by getState during completion and invalidate in-flight rendering.
  const state = (await evaluate('window.halo.getState()')).data;
  await evaluate(`window.__haloRestoreView(${JSON.stringify({ state: { ...state, ready: true, isStreaming: false, sessionId: id }, seq: 0, messages })})`);
}
function history(result, finalText) {
  return [
    { role: 'user', content: [{ type: 'text', text: '制作一段产品短片，并以清晰的名称交付' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'generation', name: 'video_generate', arguments: { action: 'generate', prompt: 'offline fixture' } }] },
    { role: 'toolResult', toolCallId: 'generation', toolName: 'video_generate', content: [{ type: 'text', text: JSON.stringify(result) }], details: result },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'status', name: 'video_generate', arguments: { action: 'status', task_id: result.task_id } }] },
    { role: 'toolResult', toolCallId: 'status', toolName: 'video_generate', content: [{ type: 'text', text: JSON.stringify(result) }], details: result },
    { role: 'assistant', content: [{ type: 'text', text: finalText }], stopReason: 'stop' },
  ];
}

try {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(executable, [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-7000); });
  child.on('error', error => { output = error.message; });
  child.on('exit', code => { exited = code; });
  let page;
  await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json();
      page = pages.find(item => item.type === 'page' && item.url.endsWith('index.html'));
      return !!page;
    } catch { return false; }
  }, 'Main renderer did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  await waitFor(() => evaluate('!!window.__haloDispatch && !!window.__haloRestoreView && window.halo.startupState().then(result=>result.data.ready)'), 'Fixture startup did not finish');
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate("window.__artifactErrors=[];addEventListener('unhandledrejection',e=>window.__artifactErrors.push(String(e.reason?.stack||e.reason)));addEventListener('error',e=>window.__artifactErrors.push(e.message))");

  // Two genuinely different recordings, not corrupt byte edits. Trailing zero
  // padding gives both files the same size so size-only deduplication fails.
  const clips = await evaluate(`(async () => {
    const output=[];
    for (const [color,label] of [['#213b65','CINEMATIC PRODUCT'],['#755027','DIFFERENT SCENE']]) {
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const context=canvas.getContext('2d'),stream=canvas.captureStream(15);
      const mime=MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E')?'video/mp4;codecs=avc1.42001E':'video/webm';
      const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
      recorder.ondataavailable=event=>chunks.push(event.data);
      const finished=new Promise(resolve=>{recorder.onstop=resolve;});recorder.start();
      for(let frame=0;frame<12;frame++) {
        context.fillStyle=color;context.fillRect(0,0,320,180);
        context.fillStyle='#fff';context.font='18px sans-serif';context.fillText(label,36,82);
        context.fillRect(36+frame*12,106,26,5);await new Promise(resolve=>setTimeout(resolve,70));
      }
      recorder.stop();await finished;stream.getTracks().forEach(track=>track.stop());
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
      output.push({data:btoa(String.fromCharCode(...bytes)),ext:mime.includes('mp4')?'mp4':'webm'});
    }
    return output;
  })()`);
  const recordings = clips.map(clip => Buffer.from(clip.data, 'base64'));
  const size = Math.max(...recordings.map(bytes => bytes.length));
  const bytes = recordings.map(recording => Buffer.concat([recording, Buffer.alloc(size - recording.length)]));
  const digest = bytes.map(value => createHash('sha256').update(value).digest('hex'));
  assert.notEqual(digest[0], digest[1], 'Same-size fixture recordings must contain different content');
  const original = path.join(workspace, `video-original.${clips[0].ext}`);
  const delivery = path.join(workspace, `cinematic-product-final.${clips[0].ext}`);
  const alternative = path.join(workspace, `different-scene.${clips[1].ext}`);
  fs.writeFileSync(original, bytes[0]); fs.copyFileSync(original, delivery); fs.writeFileSync(alternative, bytes[1]);
  const checked = await evaluate(`window.halo.artifactFiles(${JSON.stringify([original, delivery, alternative])}, {videoHashes:true,mediaMetadata:true})`);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.data.map(item => item.sha256), [digest[0], digest[0], digest[1]], 'Use real main-process hashes for both copied and distinct videos');
  assert.deepEqual(checked.data.map(item => item.bytes), [size, size, size], 'Different videos deliberately share the same byte size');
  const result = {
    file: original, status: 'succeeded', task_id: 'copied-video', provider: 'apimart', provider_name: 'APIMart', model: 'MiniMax-H3',
    usage: { amount: 1.144, unit: 'Credits' }, timing: { totalMs: 167300, generationMs: 160000, platformMs: 157000 },
  };
  const mediaLink = file => 'halo-preview://local/' + file.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  const finalText = `短片制作完成。\n▶ [播放 ${path.basename(delivery)}](${mediaLink(delivery)})\n\n- 规格：15 秒，16:9。\n- 镜头说明：盾牌格挡后推进反击。`;

  // Exercise the real Markdown DOM: hide only redundant action rows, keeping
  // prose, other addresses, code/examples and the exact original reply intact.
  const filtering = await evaluate(`(async () => {
    const {filterArtifactPlayback}=await import('./js/artifacts.mjs');
    const cwd=${JSON.stringify(workspace.replaceAll('\\', '/'))},file=${JSON.stringify(delivery.replaceAll('\\', '/'))};
    const link=${JSON.stringify(mediaLink(delivery))},name=${JSON.stringify(path.basename(delivery))};
    const tests=[
      ['single-line','已完成。\\n▶ [播放 '+name+']('+link+')\\n参数说明。'],
      ['paragraph','已完成。\\n\\n**[预览视频]('+link+')**\\n\\n参数说明。'],
      ['list','- [播放视频]('+link+')\\n- 参数说明。'],
      ['empty-list','- [播放视频]('+link+')\\n- [观看成片]('+link+')'],
      ['filename','['+name+']('+link+')'],
      ['multiple-lines','开始。\\n▶ [播放]('+link+')\\n[预览成片]('+link+')\\n结束。'],
      ['useful-link','[观看成片，留意盾牌受击后的退步]('+link+')'],
      ['inline','请[播放视频]('+link+')检查第 3 秒的火花。'],
      ['external','[播放视频](https://example.com/movie.mp4)'],
      ['missing','[播放视频](missing.mp4)'],
      ['same-basename','[播放视频](other/'+name+')'],
      ['quote','> [播放视频]('+link+')'],
      ['code','\u0060\u0060\u0060md\\n[播放视频]('+link+')\\n\u0060\u0060\u0060'],
      ['inline-code','\u0060[播放视频]('+link+')\u0060'],
      ['table','| 操作 | 说明 |\\n| --- | --- |\\n| [播放视频]('+link+') | 参数 |'],
      ['nested-list','- [播放视频]('+link+')\\n  - 参数说明。'],
      ['audio','▶ [试听录音](voice.wav)']
    ];
    const results=[];
    for(const [id,text] of tests) {
      const md=document.createElement('div');md.className='md';md.innerHTML=mdRender(text,cwd+'/__chat__.md');document.body.append(md);
      const original=md.innerHTML;
      filterArtifactPlayback(md,cwd,[file,cwd+'/voice.wav']);
      const first={text:md.innerText,links:[...md.querySelectorAll('a')].filter(node=>node.getClientRects().length).length,
        breaks:[...md.querySelectorAll('br')].filter(node=>!node.hidden).length,lists:[...md.querySelectorAll('ul')].filter(node=>!node.hidden).length};
      filterArtifactPlayback(md,cwd,[file,cwd+'/voice.wav']);
      const repeated=md.innerText;
      filterArtifactPlayback(md,cwd,[]);
      results.push({id,...first,repeated,restored:md.innerHTML===original});md.remove();
    }
    return results;
  })()`);
  const cases = Object.fromEntries(filtering.map(result => [result.id, result]));
  for (const id of ['single-line', 'paragraph', 'list', 'empty-list', 'filename', 'multiple-lines', 'audio']) {
    assert.equal(cases[id].links, 0, `${id}: the card owns the playback action`);
  }
  assert.equal(cases['single-line'].text, '已完成。\n参数说明。', 'A shared paragraph must retain both neighboring lines');
  assert.equal(cases['single-line'].breaks, 1, 'Hide the extra line break without joining useful prose');
  assert.equal(cases['multiple-lines'].text, '开始。\n结束。', 'Consecutive redundant actions leave one break');
  assert.equal(cases['empty-list'].lists, 0, 'All-hidden playback lists must not leave an empty container');
  assert.match(cases.list.text, /参数说明/);
  for (const id of ['useful-link', 'inline', 'external', 'missing', 'same-basename', 'quote', 'table', 'nested-list']) {
    assert.equal(cases[id].links, 1, `${id}: retain useful or unverified links`);
  }
  assert.match(cases.code.text, /播放视频/);
  assert.match(cases['inline-code'].text, /播放视频/);
  for (const result of filtering) {
    assert.equal(result.repeated, result.text, `${result.id}: filtering is idempotent`);
    assert.equal(result.restored, true, `${result.id}: no card restores the original Markdown DOM`);
  }

  // Live delivery starts with the provider filename. Final assistant text
  // selects the copied, descriptive filename, without losing its metadata.
  await restore([], 'live-video-copy');
  await evaluate(`(() => {
    const d=window.__haloDispatch,result=${JSON.stringify(result)};
    d({type:'agent_start'});
    d({type:'tool_execution_start',toolCallId:'generation',toolName:'video_generate',args:{action:'generate'}});
    d({type:'tool_execution_end',toolCallId:'generation',toolName:'video_generate',isError:false,result:{content:[{type:'text',text:JSON.stringify(result)}],details:result}});
  })()`);
  await singleDelivery(original, 'Immediate live delivery');
  const streamedText = `短片制作完成。\n▶ [播放 ${path.basename(original)}](${mediaLink(original)})\n\n规格说明。`;
  await evaluate(`(() => {
    const d=window.__haloDispatch,message={role:'assistant',content:[]};
    d({type:'message_start',message});
    d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:${JSON.stringify(streamedText)}}});
  })()`);
  await waitFor(() => evaluate('document.querySelector(".turn > .md")?.innerText.includes("规格说明")'), 'Live reply must render');
  assert.equal(await evaluate('[...document.querySelectorAll(".turn > .md a")].filter(link=>link.getClientRects().length).length'), 0, 'An already delivered file suppresses the redundant playback action during streaming');
  await evaluate(`window.__haloDispatch({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(streamedText)}}],stopReason:'stop'}})`);
  assert.equal(await evaluate('[...document.querySelectorAll(".turn > .md a")].filter(link=>link.getClientRects().length).length'), 0, 'Message final rendering must not restore the action');
  await evaluate("window.__originalVideoCard = document.querySelector('.artifact-video-row')");
  fs.writeFileSync(original, bytes[1]);
  await evaluate(`(() => {
    const d=window.__haloDispatch,result=${JSON.stringify({ ...result, sha256: digest[0] })};
    d({type:'tool_execution_start',toolCallId:'overwritten-status',toolName:'video_generate',args:{action:'status',task_id:result.task_id}});
    d({type:'tool_execution_end',toolCallId:'overwritten-status',toolName:'video_generate',isError:false,result:{content:[{type:'text',text:JSON.stringify(result)}],details:result}});
  })()`);
  await waitFor(() => evaluate("document.querySelector('.artifact-video-row') !== window.__originalVideoCard && !document.querySelector('.artifact-video-model')"), 'Overwriting the same path with different bytes must replace the thumbnail and drop stale generation metadata');
  fs.writeFileSync(original, bytes[0]);
  await evaluate(`(() => {
    const d=window.__haloDispatch,result=${JSON.stringify(result)},text=${JSON.stringify(finalText)};
    for (let i=0;i<3;i++) {
      d({type:'tool_execution_start',toolCallId:'status-'+i,toolName:'video_generate',args:{action:'status',task_id:result.task_id}});
      d({type:'tool_execution_end',toolCallId:'status-'+i,toolName:'video_generate',isError:false,result:{content:[{type:'text',text:JSON.stringify(result)}],details:result}});
    }
    const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop'};
    d({type:'message_start',message});d({type:'message_end',message});
    d({type:'agent_end',messages:[message],willRetry:false});d({type:'agent_settled'});
  })()`);
  await singleDelivery(delivery, 'Final filename replaces identical generated file');
  await sleep(300);
  assert.equal((await cardState()).length, 1, 'Concurrent status events and final answer must settle to a single card');
  assert.equal(await evaluate('[...document.querySelectorAll(".turn > .md a")].filter(link=>link.getClientRects().length).length'), 0, 'Final copied file suppresses its redundant playback link');
  assert.match(await evaluate('document.querySelector(".turn > .md").innerText'), /规格：15 秒，16:9。/);
  assert.equal(await evaluate('document.querySelector(".turn").__texts.at(-1)'), finalText, 'Display filtering must not alter the original reply');

  await restore(history(result, finalText), 'history-video-copy');
  await singleDelivery(delivery, 'Legacy history without recorded digest');
  assert.equal(await evaluate('[...document.querySelectorAll(".turn > .md a")].filter(link=>link.getClientRects().length).length'), 0, 'History restores the same clean delivery view');
  await restore(history(result, finalText + `\n\n▶ [播放 ${path.basename(original)}](${mediaLink(original)})`), 'history-alias-video');
  await singleDelivery(delivery, 'Original and renamed identical file share a card');
  assert.equal(await evaluate('[...document.querySelectorAll(".turn > .md a")].filter(link=>link.getClientRects().length).length'), 0, 'The verified identical original also suppresses its playback action');
  await restore(history(result, finalText + `\n\n[另一段视频](<${alternative}>)`), 'history-distinct-video');
  await waitFor(async () => (await cardState()).length === 2, 'Genuinely different same-size videos must both be delivered');
  const separate = await cardState();
  assert.deepEqual(separate.map(card => card.file), [normalized(delivery), normalized(alternative)]);
  assert.equal(separate[0].model, 'APIMart · MiniMax-H3');
  assert.equal(separate[1].model, undefined, 'Unrelated video must not inherit another generation task metadata');

  // New task results persist the content hash, so moving the temporary source
  // does not lose the metadata relationship to the final copied deliverable.
  fs.renameSync(original, path.join(fixture, `moved-original.${clips[0].ext}`));
  await restore(history({ ...result, sha256: digest[0] }, finalText), 'history-moved-video');
  await singleDelivery(delivery, 'History after moving the original source');
  await evaluate("document.querySelector('.artifact-video').click()");
  await waitFor(() => evaluate('document.querySelector(".pv-video")?.readyState >= 2 && document.querySelector(".pv-video").videoWidth === 320'), 'Final card must open a decodable video in the center preview');
  const preview = await evaluate('({src:document.querySelector(".pv-video").getAttribute("src"),controls:document.querySelector(".pv-video").controls})');
  assert.ok(decodeURIComponent(preview.src).includes(path.basename(delivery)), `Click must open the final file: ${JSON.stringify(preview)}`);
  assert.equal(preview.controls, true);
  await evaluate('document.documentElement.dataset.theme = "light"; document.documentElement.dataset.surface = "glass"; document.dispatchEvent(new CustomEvent("themechange"))');
  await sleep(400);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reports, 'video-artifacts.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('PASS video artifact deduplication, streaming/final/history playback filtering, useful prose and link preservation, reversible DOM, inherited metadata, distinct clips and final-file playback');
} finally {
  ws?.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit'); child.kill(); await Promise.race([stopped, sleep(5000)]);
  }
  const target = path.resolve(fixture);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-video-artifacts-'));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
