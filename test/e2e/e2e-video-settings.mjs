// Actual Electron settings/DPAPI and video playback; offline SDK events, no paid API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const packaged = false;
const exe = path.resolve(packaged ? 'dist/win-unpacked/Pi Halo.exe' : 'node_modules/electron/dist/electron.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-ui-'));
const userData = path.join(dir, 'profile'), workspace = path.join(dir, 'workspace'), agent = path.join(dir, 'agent');
for (const folder of [userData, workspace, agent]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(userData, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.mkdirSync('test/results', { recursive: true });
let child, ws, output = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function prepareFixture() {
  const extra = `
const originalCreate = exports.createAgentSessionRuntime;
exports.createAgentSessionRuntime = async (...args) => {
  const runtime = await originalCreate(...args), s = runtime.session;
  s.prompt = async () => {
    const waitFor = async name => {
      const until = Date.now() + 30000;
      while (!fs.existsSync(${JSON.stringify(dir)} + '/' + name)) {
        if (Date.now() > until) throw Error('Video fixture gate timed out: ' + name);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const result = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'video-result.json'))}, 'utf8'));
    s.isStreaming = true;
    s.emit({ type: 'agent_start' });
    const user = { role: 'user', content: [{ type: 'text', text: '生成测试视频' }], timestamp: Date.now() };
    s.agent.state.messages.push(user); s.emit({ type: 'message_start', message: user }); s.emit({ type: 'message_end', message: user });
    const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'video-fixture', name: 'video_generate', arguments: { action: 'generate', prompt: 'fixture' } }], timestamp: Date.now() };
    s.agent.state.messages.push(call);
    s.emit({ type: 'message_start', message: call }); s.emit({ type: 'message_end', message: call });
    s.emit({ type: 'tool_execution_start', toolCallId: 'video-fixture', toolName: 'video_generate', args: { action: 'generate' } });
    s.emit({ type: 'tool_execution_update', toolCallId: 'video-fixture', partialResult: { content: [], details: { ...result, status: 'running' } } });
    await new Promise(resolve => setTimeout(resolve, 1600));
    s.agent.state.messages.push({ role: 'toolResult', toolCallId: 'video-fixture', toolName: 'video_generate', content: [{ type: 'text', text: JSON.stringify(result) }], details: result, timestamp: Date.now() });
    s.emit({ type: 'tool_execution_end', toolCallId: 'video-fixture', toolName: 'video_generate', result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }, isError: false });
    await waitFor('continue-video-fixture');
    s.emit({ type: 'tool_execution_start', toolCallId: 'after-video-fixture', toolName: 'bash', args: { command: 'fixture post-generation work' } });
    await waitFor('finish-video-fixture');
    s.emit({ type: 'tool_execution_end', toolCallId: 'after-video-fixture', toolName: 'bash', result: { content: [{ type: 'text', text: 'fixture completed' }] }, isError: false });
    // A status result and final reply may arrive together for the already
    // displayed task. They must reuse its player instead of rebuilding it.
    s.emit({ type: 'tool_execution_start', toolCallId: 'video-status-fixture', toolName: 'video_generate', args: { action: 'status', task_id: result.task_id } });
    s.emit({ type: 'tool_execution_end', toolCallId: 'video-status-fixture', toolName: 'video_generate', result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }, isError: false });
    const message = { role: 'assistant', content: [{ type: 'text', text: '[视频](<' + result.file + '>)' }], timestamp: Date.now(), stopReason: 'stop' };
    s.agent.state.messages.push(message); s.emit({ type: 'message_start', message }); s.emit({ type: 'message_end', message });
    s.isStreaming = false; s.emit({ type: 'agent_end', messages: [message] }); s.emit({ type: 'agent_settled' });
  };
  return runtime;
};`;
  fs.writeFileSync(path.join(dir, 'pi-sdk.cjs'), fs.readFileSync('test/fixtures/pi-sdk.js', 'utf8') + extra);
}
try {
  prepareFixture();
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'),
    PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(dir, 'pi-sdk.cjs'), PI_OFFLINE: '1' };
  // Video fixtures never use real account data.
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', text => { output = (output + text).slice(-6000); });
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch {}
    if (!page) await sleep(250);
  }
  assert.ok(page, `App did not start: ${output}`);
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let id = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data), request = pending.get(data.id);
    if (request) { pending.delete(data.id); request(data); }
  });
  async function command(method, params = {}) {
    const response = await new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 25000);
      pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response));
    return response.result?.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    assert.fail(`UI did not settle: ${expression}`);
  }
  async function screenshot(name) {
    await sleep(400); // Let the existing theme/color transitions settle.
    const result = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`test/results/video-${name}${packaged ? '-packaged' : ''}.png`, Buffer.from(result.data, 'base64'));
  }
  async function pointerClick(selector) {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node.tagName !== 'OPTION') node.scrollIntoView({ block:'nearest' });
      const rect = node.getBoundingClientRect(); return { x:rect.x + rect.width / 2, y:rect.y + rect.height / 2 };
    })()`);
    await command('Input.dispatchMouseEvent', { type:'mouseMoved', ...point });
    await command('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...point });
    await command('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...point });
  }
  async function pressKey(key) {
    const keyCode = { ArrowDown:40, ArrowUp:38, Home:36, End:35, Enter:13, Escape:27 }[key];
    for (const type of ['keyDown', 'keyUp']) {
      await command('Input.dispatchKeyEvent', { type, key, code:key, windowsVirtualKeyCode:keyCode, nativeVirtualKeyCode:keyCode });
    }
  }
  async function pickerState(selector) {
    return evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)}), style = getComputedStyle(select, '::picker(select)');
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
      return { open:select.matches(':open'), value:select.value, select:rect(select), appearance:getComputedStyle(select).appearance,
        pickerAppearance:style.appearance, height:parseFloat(style.height), maxHeight:parseFloat(style.maxBlockSize), overflowY:style.overflowY,
        background:style.backgroundColor, options:[...select.options].map(option => ({ value:option.value, ...rect(option) })),
        form:rect(select.closest('form')), viewportHeight:innerHeight };
    })()`);
  }
  async function checkVideoPicker() {
    assert.equal(await evaluate("CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))')"), true);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#videoSettingsForm select')].map(select => getComputedStyle(select).appearance)"), Array(5).fill('base-select'));
    await pointerClick('#videoDuration');
    await until("document.querySelector('#videoDuration').matches(':open')");
    const light = await pickerState('#videoDuration');
    assert.equal(light.pickerAppearance, 'base-select');
    assert.equal(light.overflowY, 'auto');
    assert.ok(light.height > 0 && light.height <= 288 && light.maxHeight <= 288, `Long duration picker must have a bounded height: ${JSON.stringify(light)}`);
    assert.ok(light.options.length > 20, 'Duration fixture must exercise a scrolling list');
    await screenshot('settings-picker-light');
    await evaluate('document.documentElement.dataset.theme = "dark"');
    await screenshot('settings-picker-dark');
    assert.notEqual((await pickerState('#videoDuration')).background, light.background, 'Open picker must follow the active theme');
    await evaluate('document.documentElement.dataset.theme = "light"');
    await pressKey('End');
    const scrolled = await pickerState('#videoDuration');
    assert.ok(scrolled.options[0].y < light.options[0].y, 'Keyboard navigation must scroll the long native picker');
    assert.ok(scrolled.options.at(-1).bottom <= scrolled.viewportHeight, 'Final option must remain inside the viewport');
    await pressKey('ArrowUp'); await pressKey('ArrowDown'); await pressKey('ArrowUp'); await pressKey('Enter');
    await until("!document.querySelector('#videoDuration').matches(':open')");
    assert.equal(await evaluate("document.querySelector('#videoDuration').value"), light.options.at(-2).value);
    assert.equal(await evaluate("document.querySelector('#settingsModal').hidden"), false, 'Choosing a native option must not close settings');
    await pointerClick('#videoDuration');
    await pressKey('ArrowUp'); await pressKey('Escape');
    assert.equal(await evaluate("document.querySelector('#videoDuration').matches(':open')"), false);
    assert.equal(await evaluate("document.querySelector('#videoDuration').value"), light.options.at(-2).value, 'Escape must cancel the highlighted choice');
    assert.equal(await evaluate("document.querySelector('#settingsModal').hidden"), false, 'First Escape must only dismiss the picker');
    await pointerClick('#videoDuration');
    await pressKey('End');
    await pointerClick('#videoDuration option:last-child');
    assert.equal(await evaluate("document.querySelector('#videoDuration').value"), light.options.at(-1).value, 'Pointer selection must update the native value');
    assert.equal(await evaluate("document.querySelector('#settingsModal').hidden"), false);
    // A smaller renderer viewport forces this real picker above its anchor and outside the scrolling form.
    await command('Emulation.setDeviceMetricsOverride', { width:1440, height:440, deviceScaleFactor:1, mobile:false });
    await pointerClick('#videoDuration');
    await pressKey('Home');
    const edge = await pickerState('#videoDuration');
    assert.ok(edge.options[0].y >= 0 && edge.options[0].y < edge.select.y, `Picker must flip above the select near the viewport bottom: ${JSON.stringify(edge)}`);
    assert.ok(edge.options[0].y < edge.form.y, `Short viewport fixture must exercise the form clipping boundary: ${JSON.stringify(edge)}`);
    assert.equal(await evaluate(`document.elementFromPoint(${edge.options[0].x + 20}, ${edge.options[0].y + 17})?.closest('select')?.id`), 'videoDuration', 'Top-layer picker must remain interactive outside the scrolling form');
    await screenshot('settings-picker-short-viewport');
    await pressKey('Escape');
    await command('Emulation.clearDeviceMetricsOverride');
    await evaluate("document.querySelector('#videoDuration').disabled = true");
    await pointerClick('#videoDuration');
    assert.equal(await evaluate("document.querySelector('#videoDuration').matches(':open')"), false, 'Disabled select must not open');
    await evaluate("document.querySelector('#videoDuration').disabled = false");
    await pressKey('Escape');
    await until("document.querySelector('#settingsModal').hidden");
    await evaluate('document.querySelector("#btnSettings").click(); document.querySelector(".set-nav[data-pane=video]").click()');
    await until('document.querySelector("#videoModel").options.length > 0');
  }
  async function chooseVideoProvider(provider) {
    await evaluate(`(() => {
      const button = document.querySelector('#videoProviders button.model-provider[data-provider="${provider}"]');
      button.scrollIntoView({ block:'nearest' }); button.click();
    })()`);
    await until(`document.querySelector('#videoProviders button.on')?.dataset.provider === ${JSON.stringify(provider)}`);
    await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
    const navigation = await evaluate(`({
      selected:[...document.querySelectorAll('#videoProviders button.on')].map(button => button.dataset.provider),
      pressed:[...document.querySelectorAll('#videoProviders button[aria-pressed="true"]')].map(button => button.dataset.provider),
      heading:document.querySelector('#videoProviderName').textContent.trim()
    })`);
    assert.deepEqual(navigation.selected, [provider]);
    assert.deepEqual(navigation.pressed, [provider]);
    const settings = (await evaluate('window.halo.videoSettings()')).data;
    assert.equal(navigation.heading, settings.providers.find(spec => spec.id === provider).name);
  }
  async function checkVideoSettingsLayout(label) {
    const layout = await evaluate(`(() => {
      const pane = document.querySelector('#setPane-video'), nav = document.querySelector('#videoProviders'), form = document.querySelector('#videoSettingsForm');
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
      return { pane:rect(pane), nav:rect(nav), form:rect(form), selected:rect(nav.querySelector('button.on')),
        heading:rect(document.querySelector('#videoProviderName')), firstLabel:rect(nav.querySelector('button span')),
        formScrollWidth:form.scrollWidth, formClientWidth:form.clientWidth, paneScrollWidth:pane.scrollWidth, paneClientWidth:pane.clientWidth,
        fields:[...form.querySelectorAll('input:not([type=checkbox]),select,button')].filter(node => !node.hidden && node.getBoundingClientRect().width).map(rect) };
    })()`);
    assert.ok(layout.nav.width > 0 && layout.form.width > 0, `${label}: provider navigation or detail form has no width`);
    assert.ok(layout.nav.right <= layout.form.x + 1, `${label}: provider navigation overlaps the detail form ${JSON.stringify(layout)}`);
    assert.ok(layout.nav.x >= layout.pane.x - 1 && layout.form.right <= layout.pane.right + 1, `${label}: settings columns escape the pane`);
    assert.ok(layout.formScrollWidth <= layout.formClientWidth + 1 && layout.paneScrollWidth <= layout.paneClientWidth + 1, `${label}: settings have horizontal overflow`);
    assert.ok(layout.fields.every(field => field.x >= layout.form.x - 1 && field.right <= layout.form.right + 1), `${label}: a detail field escapes the form`);
    assert.ok(layout.selected.y >= layout.nav.y - 1 && layout.selected.bottom <= layout.nav.bottom + 1, `${label}: selected provider is not visible in the navigation`);
    if (label === 'initial' || label === 'dark settings') {
      assert.ok(Math.abs(layout.heading.y + layout.heading.height / 2 - layout.firstLabel.y - layout.firstLabel.height / 2) <= 3, `${label}: provider title is not aligned with the first navigation row`);
    }
  }
  async function device(name) {
    await evaluate(`document.querySelector('.pvdev[data-dev="${name}"]').click()`);
    await sleep(650); // Allow the embedded page/media to paint its final viewport.
  }
  async function openFromTree(name) {
    await evaluate('document.querySelector("#treeRefresh").click()');
    await until(`[...document.querySelectorAll('.trow.file .fname')].some(node => node.textContent === ${JSON.stringify(name)})`);
    await evaluate(`[...document.querySelectorAll('.trow.file .fname')].find(node => node.textContent === ${JSON.stringify(name)}).closest('.trow').click()`);
  }
  async function checkMediaFrame(selector, name) {
    const layout = await evaluate(`(() => {
      const body = document.querySelector('#pvBody'), shell = body.querySelector('.dev-shell.dev-media-shell');
      const screen = shell?.querySelector(':scope > .dev-screen'), media = screen?.querySelector(${JSON.stringify(selector)});
      if (!shell || !screen || !media) return { missing: true };
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
      const statusbar = shell.querySelector(':scope > .dev-statusbar');
      const bounds = rect(media), isVideo = media.tagName === 'VIDEO';
      return { body:rect(body), shell:rect(shell), screen:rect(screen), media:bounds, statusbar:statusbar && rect(statusbar),
        objectFit:getComputedStyle(media).objectFit, topRadius:getComputedStyle(screen).borderTopLeftRadius,
        bottomRadius:getComputedStyle(screen).borderBottomLeftRadius,
        controls:isVideo ? media.controls : null,
        controlHit:isVideo ? document.elementFromPoint(bounds.x + 36, bounds.bottom - 22) === media : null,
        chat:document.querySelector('#chat').getBoundingClientRect().width };
    })()`);
    assert.equal(layout.missing, undefined, `${name}: media shell hierarchy missing`);
    const inside = (inner, outer) => inner.width > 0 && inner.height > 0 && inner.x >= outer.x - 1 && inner.y >= outer.y - 1
      && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    assert.ok(inside(layout.shell, layout.body), `${name}: shell overflows preview ${JSON.stringify(layout)}`);
    assert.ok(inside(layout.screen, layout.shell), `${name}: screen overflows shell ${JSON.stringify(layout)}`);
    assert.ok(inside(layout.media, layout.screen), `${name}: media overflows screen ${JSON.stringify(layout)}`);
    assert.equal(layout.objectFit, 'contain', `${name}: media aspect ratio must be preserved`);
    assert.ok(layout.chat >= 479, `${name}: device shell squeezed the chat below its minimum`);
    assert.ok(layout.statusbar, `${name}: shared status bar missing`);
    if (name.endsWith('mobile')) {
      assert.ok(layout.statusbar.height > 0 && layout.statusbar.bottom <= layout.screen.y + 1, `${name}: status bar overlaps media`);
      assert.equal(parseFloat(layout.topRadius), 0, `${name}: screen must join the phone status bar without a second top corner`);
      assert.ok(parseFloat(layout.bottomRadius) > 0, `${name}: phone bottom corners missing`);
    } else assert.equal(layout.statusbar.height, 0, `${name}: status bar must be phone-only`);
    if (selector === 'video.pv-video') {
      assert.equal(layout.controls, true, `${name}: playback controls missing`);
      assert.equal(layout.controlHit, true, `${name}: shell intercepts playback controls`);
    }
    return layout;
  }

  await until('window.halo && document.querySelectorAll(".environment-tool").length === 3');
  await evaluate('document.querySelector("#btnSettings").click(); document.querySelector(".set-nav[data-pane=video]").click()');
  await until('document.querySelector("#videoModel").value === "MiniMax-H3"');
  assert.equal(await evaluate('document.querySelector("#videoTest").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#videoProvider")'), null, 'The old provider dropdown must be removed');
  assert.equal(await evaluate('document.querySelectorAll("#videoProviders button.model-provider[data-provider]").length'), 10);
  await chooseVideoProvider('minimax');
  await checkVideoSettingsLayout('initial');
  await evaluate('document.documentElement.dataset.theme = "light"');
  await screenshot('settings-light');
  const beforeNavigation = (await evaluate('window.halo.videoSettings()')).data;
  const lastProvider = await evaluate('[...document.querySelectorAll("#videoProviders button.model-provider")].at(-1).dataset.provider');
  await chooseVideoProvider(lastProvider);
  await checkVideoSettingsLayout('last provider');
  await chooseVideoProvider('volcengine');
  await checkVideoSettingsLayout('long model name');
  await screenshot('settings-long-model-light');
  await checkVideoPicker();
  await chooseVideoProvider('apimart');
  await checkVideoSettingsLayout('apimart');
  assert.equal(await evaluate('document.querySelector("#videoKeyLink").href'), 'https://apimart.ai/keys');
  assert.equal(await evaluate('document.querySelector("#videoModel").options.length'), 18);
  const pricingUI = await evaluate(`(async () => {
    const { initVideoSettings } = await import('./js/video-settings.mjs');
    const root = document.querySelector('#setPane-video').cloneNode(true);
    const data = (await window.halo.videoSettings()).data;
    data.provider = 'apimart'; data.defaultModel = 'MiniMax-H3';
    const pending = [];
    const ui = initVideoSettings({ root, api: { videoSettings: async () => ({ ok:true, data }),
      videoEstimate: input => new Promise(resolve => pending.push({input,resolve})) } });
    const pause = () => new Promise(resolve => setTimeout(resolve, 240));
    await ui.refresh(); await pause();
    root.querySelector('#videoDuration').value = '10';
    root.querySelector('#videoDuration').dispatchEvent(new Event('change')); await pause();
    pending[1].resolve({ok:true,data:{available:true,currency:'Credits',total:5.712,rate:.5712,unit:'second',basis:'文生视频公开报价'}}); await pause();
    const current = root.querySelector('#videoEstimateValue').textContent;
    pending[0].resolve({ok:true,data:{available:true,currency:'Credits',total:2.856,rate:.5712,unit:'second',basis:'文生视频公开报价'}}); await pause();
    const afterOld = root.querySelector('#videoEstimateValue').textContent;
    return { current, afterOld, detail:root.querySelector('#videoEstimateDetail').textContent, count:pending.length,
      secretSent:pending.some(item => 'apiKey' in item.input) };
  })()`);
  assert.match(pricingUI.current, /5\.712 积分/);
  assert.equal(pricingUI.afterOld, pricingUI.current, 'Stale pricing must not overwrite a newer parameter estimate');
  assert.match(pricingUI.detail, /0\.5712 积分 \/ 秒 × 10 秒/);
  assert.equal(pricingUI.secretSent, false);
  const balanceUI = await evaluate(`(async () => {
    const { initVideoSettings } = await import('./js/video-settings.mjs');
    const root = document.querySelector('#setPane-video').cloneNode(true);
    const data = (await window.halo.videoSettings()).data;
    data.provider = 'apimart';
    const pending = [];
    const ui = initVideoSettings({root, api:{videoSettings:async()=>({ok:true,data}),
      videoBalance:input=>new Promise(resolve=>pending.push({input,resolve})),
      videoEstimate:async()=>({ok:true,data:{available:false}})}});
    await ui.refresh();
    root.querySelector('[data-provider="minimax"]').click();
    pending[1].resolve({ok:true,data:{available:true,amount:0,unit:'Credits'}});
    await new Promise(resolve=>setTimeout(resolve,0));
    const zero=root.querySelector('#videoBalance').textContent;
    pending[0].resolve({ok:true,data:{available:true,amount:999,unit:'Credits'}});
    await new Promise(resolve=>setTimeout(resolve,0));
    return {zero,afterOld:root.querySelector('#videoBalance').textContent,
      inputs:pending.map(x=>x.input), footer:document.querySelector('.composer-balances').textContent};
  })()`);
  assert.match(balanceUI.zero, /账户余额0 积分/);
  assert.equal(balanceUI.afterOld, balanceUI.zero, 'Previous provider balance must not overwrite selected provider');
  assert.deepEqual(balanceUI.inputs, [{provider:'apimart'},{provider:'minimax'}]);
  assert.match(balanceUI.footer, /大模型/); assert.match(balanceUI.footer, /视频/);
  // Live pricing is optional; its asynchronous behavior is covered by the
  // mocked responses above so offline UI runs need no external price service.
  assert.equal(await evaluate('document.querySelector("#videoModel").value'), 'MiniMax-H3');
  await pointerClick('#videoModel');
  await screenshot('apimart-model-prices');
  await pressKey('Escape');
  await screenshot('apimart-light');
  await chooseVideoProvider('minimax');
  assert.deepEqual((await evaluate('window.halo.videoSettings()')).data, beforeNavigation, 'Provider navigation must not save or change the default provider');
  const fixtureKey = 'fixture-video-key-not-a-real-key';
  await evaluate(`document.querySelector('#videoApiKey').value = ${JSON.stringify(fixtureKey)}; document.querySelector('#videoSave').click()`);
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  const saved = await evaluate('window.halo.videoSettings()');
  assert.equal(saved.data.hasApiKey, true);
  assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  assert.equal(await evaluate('document.querySelector("#videoApiKey").value'), '');
  const persisted = fs.readFileSync(path.join(dir, '.pi/agent/halo-video.json'), 'utf8');
  assert.ok(!persisted.includes(fixtureKey), 'DPAPI must protect the stored key');
  await evaluate('document.querySelector("#videoDuration").value = 8; document.querySelector("#videoSave").click()');
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  assert.equal((await evaluate('window.halo.videoSettings()')).data.duration, 8);
  assert.equal((await evaluate('window.halo.videoSettings()')).data.hasApiKey, true);
  async function select(id, value) {
    await evaluate(`document.querySelector('#${id}').value = ${JSON.stringify(value)}; document.querySelector('#${id}').dispatchEvent(new Event('change'))`);
  }
  await chooseVideoProvider('google');
  assert.equal(await evaluate('document.querySelector("#videoApiKey").value'), '');
  assert.equal(await evaluate('document.querySelector("#videoKeyStatus").textContent'), '未配置');
  assert.equal(await evaluate('document.querySelector("#videoKeyLink").href'), 'https://aistudio.google.com/apikey');
  await select('videoResolution', '1080P');
  assert.deepEqual(await evaluate('[...document.querySelector("#videoDuration").options].map(x => x.value)'), ['8']);
  await select('videoModel', 'veo-3.1-fast-generate-preview');
  assert.deepEqual(await evaluate('["videoResolution", "videoDuration"].map(id => document.getElementById(id).value)'), ['1080P', '8'], 'Valid choices must survive dynamic model option replacement');
  await evaluate('document.querySelector("#videoApiKey").value = "fixture-google-key"; document.querySelector("#videoApiKey").dispatchEvent(new Event("input"))');
  await select('videoNetwork', 'direct');
  await chooseVideoProvider('minimax');
  assert.equal(await evaluate('document.querySelector("#videoApiKey").value'), '');
  assert.equal(await evaluate('document.querySelector("#videoDuration").value'), '8');
  await chooseVideoProvider('google');
  assert.equal(await evaluate('document.querySelector("#videoKeyStatus").textContent'), '已配置');
  assert.equal(await evaluate('document.querySelector("#videoNetwork").value'), 'direct');
  await evaluate('document.querySelector("#videoSave").click()');
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  assert.equal((await evaluate('window.halo.videoSettings()')).data.provider, 'google', 'Saving config selects its default model');
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  assert.equal((await evaluate('window.halo.videoSettings()')).data.provider, 'google');
  assert.equal((await evaluate('window.halo.videoSettings()')).data.defaultModel, 'veo-3.1-fast-generate-preview');
  await select('videoModel', 'veo-3.1-generate-preview');
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  assert.equal((await evaluate('window.halo.videoSettings()')).data.defaultModel, 'veo-3.1-generate-preview', 'Selecting a model automatically saves it as default');
  await evaluate('document.querySelector("#videoSave").click()');
  await until('document.querySelector("#videoSettingsForm").getAttribute("aria-busy") === "false"');
  const changedDefault = (await evaluate('window.halo.videoSettings()')).data;
  assert.equal(changedDefault.provider, 'google');
  assert.equal(changedDefault.defaultModel, 'veo-3.1-generate-preview', 'Saving a model in the default provider must update the default model');
  assert.equal(changedDefault.configs.google.model, changedDefault.defaultModel, 'The default model and provider configuration must agree');

  await chooseVideoProvider('dashscope');
  await select('videoModel', 'wan2.7-i2v');
  assert.equal(await evaluate('document.querySelector("#videoRatio").value'), 'adaptive');
  await chooseVideoProvider('minimax');
  await evaluate('document.documentElement.dataset.theme = "dark"');
  await checkVideoSettingsLayout('dark settings');
  await screenshot('settings-dark');
  await evaluate('document.querySelector("#videoClearKey").click()');
  await until('document.querySelector("#videoKeyStatus").textContent === "未配置"');
  const afterClear = (await evaluate('window.halo.videoSettings()')).data;
  assert.equal(afterClear.provider, 'minimax');
  assert.equal(afterClear.hasApiKey, false);
  assert.equal(afterClear.configs.minimax.hasApiKey, false);

  // Open the real server form without submitting or contacting a server.
  await pressKey('Escape');
  await until("document.querySelector('#settingsModal').hidden");
  await evaluate("document.querySelector('.nav-item[data-tab=skills]').click(); document.querySelector('#serverAdd').click()");
  await until("document.querySelector('#serverModal').classList.contains('show')");
  await pointerClick('#serverForm select[name=auth]');
  await until("document.querySelector('#serverForm select[name=auth]').matches(':open')");
  const serverPicker = await pickerState('#serverForm select[name=auth]');
  assert.equal(serverPicker.appearance, 'base-select');
  assert.equal(serverPicker.pickerAppearance, 'base-select');
  assert.equal(serverPicker.overflowY, 'auto');
  await screenshot('server-auth-picker');
  await pointerClick('#serverForm select[name=auth] option[value=key]');
  assert.equal(await evaluate("document.querySelector('#serverSecretLabel').textContent"), '私钥文件完整路径');
  assert.equal(await evaluate("document.querySelector('#serverModal').hidden"), false);
  await pressKey('Escape');
  await until("document.querySelector('#serverModal').hidden");
  await evaluate('document.querySelector(".nav-item[data-tab=chat]").click(); document.querySelector("#btnSettings").click(); document.querySelector(".set-nav[data-pane=video]").click()');
  await until('document.querySelector("#videoModel").options.length > 0');

  if (process.env.HALO_VIDEO_SETTINGS_ONLY === '1') {
    console.log('PASS video settings navigation, themed native pickers, keyboard/pointer selection, independent drafts and encrypted save/clear');
  } else {
  // Record a small, valid local video so the test checks decoding/playback, not just a <video> tag.
  const clip = await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(15);
    const mime = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E') ? 'video/mp4;codecs=avc1.42001E' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (let n = 0; n < 15; n++) { ctx.fillStyle = '#213b65'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#ffffff'; ctx.font = '22px sans-serif'; ctx.fillText('HALO VIDEO ' + n, 40, 95); await new Promise(resolve => setTimeout(resolve, 70)); }
    recorder.stop(); await finished; stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    return { data: btoa(String.fromCharCode(...bytes)), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
  })()`);
  const file = path.join(workspace, `fixture.${clip.ext}`);
  fs.writeFileSync(file, Buffer.from(clip.data, 'base64'));
  const pictures = await evaluate(`[['landscape', 1200, 675], ['portrait', 675, 1200]].map(([name, width, height]) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#0f5d7c'); gradient.addColorStop(1, '#e3a45d');
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    context.strokeStyle = '#fff'; context.lineWidth = 8; context.strokeRect(16, 16, width - 32, height - 32);
    context.fillStyle = '#fff'; context.font = '42px sans-serif'; context.fillText(name.toUpperCase(), 48, 86);
    context.beginPath(); context.arc(width / 2, height / 2, Math.min(width, height) / 4, 0, Math.PI * 2); context.stroke();
    return { name, width, height, data: canvas.toDataURL('image/png').split(',')[1] };
  })`);
  for (const picture of pictures) fs.writeFileSync(path.join(workspace, `${picture.name}.png`), Buffer.from(picture.data, 'base64'));
  fs.writeFileSync(path.join(workspace, 'device-layout.html'), `<!doctype html><meta charset="utf-8"><title>HTML DEVICE FIXTURE</title><style>body{margin:0;background:#edf5ff;color:#18365c;font:20px sans-serif}header{padding:24px}main{height:1800px;background:linear-gradient(#edf5ff,#7cacd8)}</style><header>HTML DEVICE FIXTURE <button id="probe">操作按钮</button></header><main>响应式页面</main><script>
    const marker = Math.random().toString(36).slice(2);
    function measure() { parent.postMessage({ type:'html-device-layout', width:innerWidth, button:!!document.querySelector('#probe'), marker }, '*'); }
    addEventListener('resize', measure);
    addEventListener('message', event => { if (event.source === parent && event.data === 'html-device-measure') measure(); });
    measure();
  </script>`);
  fs.writeFileSync(path.join(dir, 'video-result.json'), JSON.stringify({ file, status: 'succeeded', task_id: 'fixture', provider:'apimart', provider_name:'APIMart', model:'MiniMax-H3',
    usage:{amount:1.1440000000000001,unit:'Credits'}, timing:{totalMs:167300,submissionMs:1300,generationMs:160000,platformMs:157000,downloadMs:6000},
    billing:{estimate:{available:true,total:1.43,currency:'Credits'},actual:{amount:1.1440000000000001,unit:'Credits'},delta:-.286,platform:{source:'credits_cost',credits_cost:1.1440000000000001}} }));
  await evaluate('document.querySelector("#settingsModal .set-close").click()');
  await until('window.halo.getState().then(result => result.data.ready)');
  await evaluate('window.__videoPrompt = window.halo.prompt("生成测试视频"); void 0');
  await until('document.querySelector(".turn-status")?.textContent.includes("MiniMax-H3")');
  await screenshot('generation-status');
  await until('document.querySelector(".artifact-video .artifact-art .artifact-video-thumbnail")?.readyState >= 2 && !document.querySelector(".artifact-video-thumbnail").seeking');
  assert.match(await evaluate('document.querySelector(".artifact-video .artifact-video-model").textContent'), /APIMart · MiniMax-H3/);
  assert.equal(await evaluate('document.querySelector(".artifact-video .artifact-video-metrics").textContent'), '生成用时 2分钟 47秒 · 实际消耗 1.144 积分');
  assert.match(await evaluate('document.querySelector(".artifact-video").title'), /任务 ID：fixture.*\n平台耗时 2分钟 37秒.*生成及查询 2分钟 40秒.*\n计费来源：平台结算积分\n预估 1\.43 积分 · 实际 1\.144 积分 · 差额 -0\.286 积分/);
  assert.equal(await evaluate('document.querySelector(".artifact-video").textContent.includes("差额")'), false, 'Billing comparison belongs in the tooltip only');
  assert.equal(await evaluate('document.querySelector(".video-generation-result")'), null, 'Video metadata belongs inside the file card, not a separate result box');
  async function checkVideoThumbnail() {
    const thumb = await evaluate(`(() => {
      const video = document.querySelector('.artifact-video .artifact-art .artifact-video-thumbnail');
      const art = video.closest('.artifact-art'), card = video.closest('.artifact-card');
      const frame = art.getBoundingClientRect(), preview = video.getBoundingClientRect(), box = card.getBoundingClientRect();
      return { error:video.error, width:frame.width, height:frame.height,
        contained:preview.x >= frame.x && preview.y >= frame.y && preview.right <= frame.right && preview.bottom <= frame.bottom,
        atLeft:frame.x < card.querySelector('.artifact-copy').getBoundingClientRect().x && frame.x >= box.x,
        paused:video.paused, autoplay:video.autoplay, controls:video.controls, muted:video.muted,
        inline:video.playsInline, tabIndex:video.tabIndex, videoWidth:video.videoWidth,
        rightVideos:document.querySelectorAll('#messages video').length,
        standalone:document.querySelectorAll('.artifact-video-row > video').length };
    })()`);
    assert.equal(thumb.error, null);
    assert.ok(Math.abs(thumb.width - 88) <= 1 && Math.abs(thumb.height - 68) <= 1, `Video thumbnail must use the same 88x68 frame as image cards: ${JSON.stringify(thumb)}`);
    assert.equal(thumb.contained && thumb.atLeft, true, 'Thumbnail must stay inside the card on the left of its text');
    assert.equal(thumb.paused && thumb.muted && thumb.inline, true, 'Thumbnail must remain a muted, static preview');
    assert.equal(thumb.controls || thumb.autoplay, false, 'The conversation thumbnail must not have playback controls or autoplay');
    assert.ok(thumb.tabIndex < 0 && thumb.videoWidth > 0, 'Thumbnail must contain a decoded frame without adding a keyboard tab stop');
    assert.equal(thumb.rightVideos, 1);
    assert.equal(thumb.standalone, 0, 'The old large player above the video card must be removed');
  }
  await checkVideoThumbnail();
  assert.equal(await evaluate('window.halo.getState().then(result => result.data.isStreaming)'), true, 'Video must be delivered while the assistant is still streaming');
  assert.equal(await evaluate('document.querySelector(".artifact-video-row").closest(".turn").classList.contains("complete")'), false, 'Video delivery must not wait for finalizeTurn');
  await evaluate('window.__earlyVideo = document.querySelector(".artifact-video .artifact-video-thumbnail"); window.__earlyVideoTime = window.__earlyVideo.currentTime; window.__earlyVideoReloads = 0; window.__earlyVideo.addEventListener("loadstart", () => window.__earlyVideoReloads++)');
  fs.writeFileSync(path.join(dir, 'continue-video-fixture'), 'continue');
  await until('document.querySelector(".turn-status")?.textContent.includes("bash")');
  assert.equal(await evaluate('document.querySelector(".artifact-video .artifact-video-thumbnail") === window.__earlyVideo && window.__earlyVideo.paused && window.__earlyVideo.currentTime === window.__earlyVideoTime'), true, 'Later tool work must retain the same static thumbnail');
  await screenshot('delivered-while-running');
  await screenshot('delivery-thumbnail-dark');
  await evaluate('document.documentElement.dataset.theme = "light"');
  await screenshot('delivery-thumbnail-light');
  assert.equal(await evaluate('(() => { const card = document.querySelector(".artifact-video"), meta = card.querySelector(".artifact-video-details"); const box = card.getBoundingClientRect(), detail = meta.getBoundingClientRect(); return detail.right <= box.right && detail.bottom <= box.bottom && meta.scrollWidth <= meta.clientWidth; })()'), true, 'Compact model/time/usage details must remain inside the video file card');
  await evaluate('document.documentElement.dataset.theme = "dark"');
  fs.writeFileSync(path.join(dir, 'finish-video-fixture'), 'finish');
  const prompted = await evaluate('window.__videoPrompt');
  assert.equal(prompted.ok, true, JSON.stringify(prompted));
  await until('document.querySelector(".artifact-video-row").closest(".turn").classList.contains("complete")');
  await sleep(400); // Allow the concurrent status/final artifact checks to resolve.
  assert.equal(await evaluate('document.querySelectorAll(".turn-artifacts .artifact-video-row").length'), 1, 'Status and final reply must not duplicate the video card');
  assert.equal(await evaluate('document.querySelectorAll(".artifact-video-details").length'), 1, 'Repeated task results must not duplicate the model/time/usage details');
  assert.equal(await evaluate('document.querySelectorAll(".video-generation-result").length'), 0, 'Standalone result boxes must not return after final rendering');
  assert.equal(await evaluate('document.querySelector(".artifact-video .artifact-video-thumbnail") === window.__earlyVideo && window.__earlyVideo.paused && window.__earlyVideo.currentTime === window.__earlyVideoTime'), true, 'Final rendering must preserve the original static thumbnail');
  assert.equal(await evaluate('window.__earlyVideoReloads'), 0, 'Final rendering must not reload the thumbnail');
  await checkVideoThumbnail();
  await pointerClick('.artifact-video-row .artifact-card .artifact-art');
  await until('document.querySelector(".pv-video")?.readyState >= 1');
  assert.equal(await evaluate('document.querySelector(".pv-video").controls'), true, 'Clicking the thumbnail must open a real player with controls in the center preview');
  await evaluate('document.querySelector(".pv-video").muted = true; document.querySelector(".pv-video").play()');
  await until('document.querySelector(".pv-video").currentTime > 0.3');
  await evaluate('document.querySelector(".pv-video").pause(); document.querySelector(".pv-video").currentTime = 0.7');
  await until('!document.querySelector(".pv-video").seeking && document.querySelector(".pv-video").readyState >= 2');
  await screenshot('playback');
  await evaluate('window.__mediaDeviceVideo = document.querySelector(".pv-video"); window.__mediaDeviceVideoReloads = 0; window.__mediaDeviceVideo.addEventListener("loadstart", () => window.__mediaDeviceVideoReloads++)');
  for (const mode of ['desktop', 'tablet', 'mobile']) {
    await device(mode);
    assert.equal(await evaluate('document.querySelector(".pv-video") === window.__mediaDeviceVideo'), true, `${mode}: device switch replaced the player`);
    assert.ok(Math.abs((await evaluate('document.querySelector(".pv-video").currentTime')) - 0.7) < 0.04, `${mode}: device switch reset video progress`);
    assert.equal(await evaluate('document.querySelector(".pv-video").paused'), true, `${mode}: device switch changed paused state`);
    await checkMediaFrame('video.pv-video', `video-${mode}`);
    await screenshot(`device-video-${mode}`);
  }
  await evaluate('window.__mediaDeviceVideo.loop = true; window.__mediaDeviceVideo.currentTime = 0.1; window.__mediaDeviceVideo.play()');
  await device('tablet');
  assert.equal(await evaluate('document.querySelector(".pv-video") === window.__mediaDeviceVideo && !window.__mediaDeviceVideo.paused'), true, 'Device switching interrupted active playback');
  await until('window.__mediaDeviceVideo.currentTime > 0.25');
  assert.equal(await evaluate('window.__mediaDeviceVideoReloads'), 0, 'Device switching reloaded video data');
  await evaluate('window.__mediaDeviceVideo.pause()');
  for (const picture of pictures) {
    await openFromTree(`${picture.name}.png`);
    await until('document.querySelector(".dev-media-shell .pv-img")?.complete && document.querySelector(".dev-media-shell .pv-img").naturalWidth > 0');
    assert.deepEqual(await evaluate('({width:document.querySelector(".pv-img").naturalWidth,height:document.querySelector(".pv-img").naturalHeight})'), { width:picture.width, height:picture.height });
    for (const mode of ['desktop', 'tablet', 'mobile']) {
      await device(mode);
      await checkMediaFrame('img.pv-img', `${picture.name}-${mode}`);
      await screenshot(`device-${picture.name}-${mode}`);
      if (picture.name === 'landscape' && mode === 'desktop') {
        await evaluate('document.documentElement.dataset.theme = "light"');
        await screenshot('device-landscape-desktop-light');
        await evaluate('document.documentElement.dataset.theme = "dark"');
      }
    }
  }
  // The same controls must still resize a real HTML iframe and preserve its page.
  await evaluate(`window.__htmlDeviceState = null; window.addEventListener('message', event => {
    if (event.source === document.querySelector('#pvBody iframe')?.contentWindow && event.data?.type === 'html-device-layout') window.__htmlDeviceState = event.data;
  })`);
  await openFromTree('device-layout.html');
  await until('document.querySelector("#pvBody .dev-shell iframe")?.src.includes("device-layout.html")');
  await until('window.__htmlDeviceState?.button === true');
  const htmlMarker = await evaluate('window.__htmlDeviceState.marker');
  for (const mode of ['desktop', 'tablet', 'mobile']) {
    await device(mode);
    await evaluate('document.querySelector("#pvBody iframe").contentWindow.postMessage("html-device-measure", "*")');
    await until('Math.abs(document.querySelector("#pvBody iframe").getBoundingClientRect().width - window.__htmlDeviceState.width) <= 2');
    const frame = await evaluate('(() => {const r=document.querySelector("#pvBody iframe").getBoundingClientRect();return {width:r.width,height:r.height,mediaShell:!!document.querySelector("#pvBody .dev-media-shell")};})()');
    const html = await evaluate('window.__htmlDeviceState');
    assert.equal(html.button, true, `${mode}: HTML controls disappeared`);
    assert.equal(html.marker, htmlMarker, `${mode}: HTML device switching reloaded the page`);
    assert.ok(frame.width > 0 && frame.height > 0 && Math.abs(frame.width - html.width) <= 2, `${mode}: HTML viewport no longer follows device width`);
    assert.equal(frame.mediaShell, false, 'Media-specific styling leaked into HTML preview');
  }
  await evaluate('document.querySelector("#pvMode").click()');
  await until('document.querySelector("#pvBody .file-view")?.textContent.includes("HTML DEVICE FIXTURE")');
  await evaluate('document.querySelector("#pvMode").click()');
  await until('document.querySelector("#pvBody .dev-shell iframe")?.src.includes("device-layout.html")');
  await command('Page.reload');
  await until('document.querySelector(".artifact-video .artifact-video-metrics")?.textContent.includes("实际消耗 1.144 积分")');
  await until('document.querySelector(".artifact-video .artifact-video-thumbnail")?.readyState >= 2 && !document.querySelector(".artifact-video-thumbnail").seeking');
  await checkVideoThumbnail();
  assert.equal(await evaluate('document.querySelectorAll(".artifact-video-details").length'), 1, 'History restore must rebuild a single metadata block inside the video card');
  assert.equal(await evaluate('document.querySelector(".artifact-video .artifact-video-metrics").textContent'), '生成用时 2分钟 47秒 · 实际消耗 1.144 积分');
  assert.equal(await evaluate('document.querySelectorAll(".video-generation-result").length'), 0, 'History restore must not recreate a standalone result container');
  console.log('PASS video settings, immediate thumbnail-card delivery, model/time/usage metadata, static thumbnail preservation/history restore, center playback/device shells, portrait/landscape contain and HTML preview regression');
  }
} finally {
  ws?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, sleep(5000)]);
  }
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-video-ui-'));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
