import {app, BrowserWindow} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const directory = path.resolve('tmp/tool-details');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory,'profile'));
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
  try {
    const file = path.join(directory,'fixture.html');
    fs.writeFileSync(file, `<link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/css/app.css'))}"><div class="tool running"><div class="tool-line">image_generate</div><div class="tool-out" hidden></div></div>`);
    await win.loadFile(file);
    const module = pathToFileURL(path.resolve('src/renderer/js/tool-details.mjs')).href;
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const {wireToolDetails}=await import(${JSON.stringify(module)});
      const card=document.querySelector('.tool'), line=card.querySelector('.tool-line'), out=card.querySelector('.tool-out');
      wireToolDetails(card,{prompt:'full prompt <img src=x onerror=alert(1)>'});
      line.click();
      const running=!out.hidden && out.textContent.includes('正在执行') && getComputedStyle(card.querySelector('.tool-input')).display==='block';
      const safe=card.querySelector('.tool-input').querySelector('img')===null;
      out.textContent='final result'; card.classList.replace('running','done');
      const staysOpen=!out.hidden;
      line.click(); const closed=out.hidden && line.getAttribute('aria-expanded')==='false';
      line.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      return {running,safe,staysOpen,closed,reopened:!out.hidden&&out.textContent==='final result'};
    })()`);
    assert.deepEqual(result,{running:true,safe:true,staysOpen:true,closed:true,reopened:true});
    console.log('PASS running tool expands before result, full safe arguments, completion preserves expansion, click and keyboard toggle');
  } finally {win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
