// Run with Electron; uses the real sidebar markup and styles, isolated storage.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const dir = path.resolve('tmp/sidebar-height');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 820, show: false, webPreferences: { backgroundThrottling: false } });
  win.setMenu(null);
  const evaluate = script => win.webContents.executeJavaScript(script);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    const source = fs.readFileSync('src/renderer/index.html', 'utf8');
    const sidebar = source.match(/<aside id="sidebar"[\s\S]*?<\/aside>/)[0];
    const html = path.join(dir, 'fixture.html');
    fs.writeFileSync(html, `<html data-theme="light"><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/css/app.css'))}"><style>body{display:block}#sidebar{height:100vh;width:248px}.side-section.active{animation:none}</style><body>${sidebar}</body></html>`);
    await win.loadFile(html);
    const moduleURL = pathToFileURL(path.resolve('src/renderer/js/sidebar-height.mjs')).href;
    await evaluate(`localStorage.clear();window.init=async()=>{const m=await import(${JSON.stringify(moduleURL)});m.initSidebarHeight()};init()`);
    await pause();
    const geometry = () => evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,height:r.height,bottom:r.bottom}};return {top:rect('.side-section.active'),handle:rect('#sideHeightHandle'),files:rect('.side-files'),footer:rect('#modelCard'),viewport:innerHeight}})()`);
    const before = await geometry();
    const y = Math.round(before.handle.top + 4);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 120, y, button: 'left', clickCount: 1 });
    await pause();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 120, y: y + 110, button: 'left' });
    await pause();
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 120, y: y + 110, button: 'left', clickCount: 1 });
    await pause();
    const after = await geometry();
    assert.ok(Math.abs(after.top.height - before.top.height - 110) < 2);
    assert.ok(Math.abs(before.files.height - after.files.height - 110) < 2);
    assert.equal(after.footer.bottom, before.footer.bottom);
    const saved = await evaluate(`localStorage.getItem('halo-sidebar-height-ratio')`);
    assert.ok(Number(saved) > .5);
    await win.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await evaluate(`(async()=>{const m=await import(${JSON.stringify(moduleURL)});m.initSidebarHeight()})()`); await pause();
    assert.ok(Math.abs((await geometry()).top.height - after.top.height) < 2);
    await evaluate(`document.querySelector('#sideHeightHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
    assert.ok((await geometry()).files.height >= 95);
    await evaluate(`document.querySelector('#sideHeightHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
    assert.ok((await geometry()).top.height >= 95);
    await evaluate(`document.querySelector('#sideHeightHandle').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    assert.equal(await evaluate(`localStorage.getItem('halo-sidebar-height-ratio')`), '0.5');
    win.setSize(500,420); await pause();
    const small = await geometry();
    assert.ok(small.top.height >= 95 && small.files.height >= 95);
    assert.ok(small.footer.bottom <= small.viewport);
    await evaluate(`document.querySelector('.side-section.active').classList.remove('active');document.querySelector('[data-pane=skills]').classList.add('active')`);
    assert.ok(Math.abs((await geometry()).top.height - small.top.height) < 2);
    win.setSize(500,820); await pause();
    fs.writeFileSync(path.join(dir,'sidebar.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS sidebar height: drag, storage restore, keyboard limits, reset, small window, server tab, fixed footer');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
