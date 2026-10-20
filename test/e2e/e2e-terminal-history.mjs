// Run with Electron. Isolated local ConPTY + shipped renderer/xterm; no app
// profile, accounts, network requests or inference are involved.
import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { TerminalPool } from '../../src/main/terminal-pool.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-terminal-history-'));
app.setPath('userData', path.join(directory, 'profile'));
const uri = file => pathToFileURL(path.resolve(file)).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  if (process.platform !== 'win32') { console.log('SKIP native ConPTY history regression: Windows only'); app.quit(); return; }
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('halo',{
      ...Object.fromEntries(['ptyStart','ptyWrite','ptyAck','ptyResize','ptyKill'].map(n=>[n,d=>ipcRenderer.invoke(n,d)])),
      onPtyOut:f=>ipcRenderer.on('halo:pty-out',(_,d)=>f(d)),onPtyExit:f=>ipcRenderer.on('halo:pty-exit',(_,d)=>f(d))
    });`);
  const win = new BrowserWindow({ show: true, width: 760, height: 600,
    webPreferences: { preload, sandbox: false } });
  const exceptions = [], raw = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') { exceptions.push(event.message); console.error(event.message); } });
  const pool = new TerminalPool((channel, data) => { if (data.data) raw.push(data.data); if (!win.isDestroyed()) win.webContents.send(channel, data); });
  for (const [name, action] of Object.entries({
    ptyStart: data => pool.start({ ...data, cwd: directory }), ptyWrite: data => pool.write(data),
    ptyAck: data => pool.ack(data), ptyResize: data => pool.resize(data), ptyKill: id => pool.kill(id),
  })) ipcMain.handle(name, async (_event, data) => ({ ok: true, data: await action(data) }));
  const evaluate = expression => win.webContents.executeJavaScript(expression, true);
  async function until(expression, label) {
    for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw Error(`Timed out: ${label}\n${JSON.stringify(raw.join('').slice(-3000))}`);
  }
  try {
    const fixture = path.join(directory, 'index.html');
    fs.writeFileSync(fixture, `<meta charset="utf-8"><title>Terminal history regression</title>
      <link rel="stylesheet" href="${uri('src/renderer/vendor/xterm.css')}">
      <style>:root{--txt:#161616;--txt-dim:#555}body{margin:12px;background:#eee}#termHost{height:430px}.terminal-mount{height:400px}.terminal-panel-label{display:none}.xterm-viewport{background:transparent!important}[hidden]{display:none!important}</style>
      <div id="cpane-preview"><button id="btnTerm">终端</button><button id="termAdd">+</button><button id="termSplit">平铺</button><div id="termTabs"></div><div id="termHost"></div></div>
      <script src="${uri('src/renderer/vendor/xterm.js')}"></script>
      <script src="${uri('src/renderer/vendor/addon-fit.js')}"></script>
      <script src="${uri('src/renderer/js/terminals.js')}"></script>`);
    await win.loadFile(fixture);
    await evaluate(String.raw`window.terms=[];const Base=window.Terminal;window.Terminal=class extends Base{constructor(o){super(o);terms.push(this)}};
      initTerminals(()=>${JSON.stringify(directory)},message=>console.error(message),()=>{});
      window.lines=t=>Array.from({length:t.buffer.normal.length},(_,i)=>t.buffer.normal.getLine(i).translateToString(true)).join('\n');
      document.querySelector('#btnTerm').click()`);
    await until(`!!document.querySelector('.terminal-panel')?.dataset.pid`, 'native terminal');
    const id = await evaluate(`document.querySelector('.terminal-panel').dataset.terminalId`);
    assert.equal(await evaluate('terms[0].options.scrollback'), 50000);
    // Use the bundled Node runtime under Electron, with real node --watch resets.
    const script = path.join(directory, 'watch.cjs');
    fs.writeFileSync(script, `console.log('HISTORY_BEFORE_RESTART');setInterval(()=>{},1000);`);
    pool.write({ id, data: `set "ELECTRON_RUN_AS_NODE=1" & set "FORCE_COLOR=1"\r` });
    await sleep(100);
    pool.write({ id, data: `"${process.execPath}" --watch "${script}"\r` });
    await until(`lines(terms[0]).includes('HISTORY_BEFORE_RESTART')`, 'watch initial output');
    // Wait for watcher installation, then restart using an actual file change.
    await sleep(600);
    fs.writeFileSync(script, `console.log('HISTORY_AFTER_RESTART');setInterval(()=>{},1000);`);
    await until(`lines(terms[0]).includes('HISTORY_AFTER_RESTART')`, 'watch restarted');
    fs.writeFileSync(path.join(directory, 'native-output.json'), JSON.stringify(raw));
    assert.ok(await evaluate(`lines(terms[0]).includes('HISTORY_BEFORE_RESTART')`), 'Watch restart must retain earlier output');
    const baselineLost = await evaluate(`(async()=>{
      const t=new Base({cols:terms[0].cols,rows:terms[0].rows,scrollback:50000,windowsPty:terms[0].options.windowsPty});
      await new Promise(resolve=>t.write(${JSON.stringify(raw.join(''))},resolve));
      const lost=!lines(t).includes('HISTORY_BEFORE_RESTART');t.dispose();return lost;
    })()`);
    assert.equal(baselineLost, true, 'Same native output must reproduce history loss without the fix');
    console.log('PASS native node --watch restart retains earlier output');
    // Parser handles controls split across IPC writes and leaves alternate-screen
    // drawing/clearing alone. Use the actual renderer terminal and vendor parser.
    const parser = await evaluate(String.raw`(async()=>{
      const {preserveTerminalHistory}=await import(${JSON.stringify(uri('src/renderer/js/terminal-history.mjs'))});
      const t=terms[0],history=preserveTerminalHistory(t),write=s=>new Promise(r=>history.write(s,r));
      await write('\r\nSPLIT_RESET_BEFORE\r\n');await write('\x1b');await write('c');
      await write('\x1b[3');await write('JAFTER_SPLIT_RESET\r\n');
      const kept=lines(t).includes('SPLIT_RESET_BEFORE')&&lines(t).includes('AFTER_SPLIT_RESET');
      await write('\x1b[?1049hALT_CONTENT\x1b[2J\x1b[H');
      const alternate=t.buffer.active.type==='alternate'&&!t.buffer.active.getLine(0).translateToString(true).includes('ALT_CONTENT');
      await write('\x1b[?1049l');
      const restored=lines(t).includes('SPLIT_RESET_BEFORE');
      await write(Array.from({length:6000},(_,i)=>'RETAINED_LINE_'+i+'\r\n').join(''));
      const volume=lines(t).includes('RETAINED_LINE_0\n')&&lines(t).includes('RETAINED_LINE_5999');
      return {kept,alternate,restored,volume};
    })()`);
    assert.deepEqual(parser, { kept: true, alternate: true, restored: true, volume: true });
    await evaluate(`document.querySelector('#btnTerm').click();document.querySelector('#btnTerm').click()`);
    assert.equal(await evaluate(String.raw`terms.length===1&&lines(terms[0]).includes('RETAINED_LINE_0\n')`), true);
    assert.deepEqual(exceptions, []);
    await evaluate(`terms[0].scrollToTop();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const shot = path.join(directory, 'history.png');
    fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    console.log(`PASS split reset/scrollback erase, alternate screen, 6000 lines, hide/reopen; ${shot}`);
  } finally {
    await pool.dispose(); win.destroy(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
