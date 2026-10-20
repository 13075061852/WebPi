import {app, BrowserWindow} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-terminal-links-'));
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:true, width:700, height:400});
  win.webContents.on('console-message', event => { if (event.level === 'error') console.log(event.message); });
  try {
    const uri = file => pathToFileURL(path.resolve(file)).href;
    const fixture = path.join(directory, 'fixture.html');
    fs.writeFileSync(fixture, `<link rel="stylesheet" href="${uri('src/renderer/vendor/xterm.css')}"><script src="${uri('src/renderer/vendor/xterm.js')}"></script><div id="terminal"></div>`);
    await win.loadFile(fixture);
    const point = await win.webContents.executeJavaScript(`(async()=>{
      const {createTerminalLinkProvider}=await import(${JSON.stringify(uri('src/renderer/js/terminal-links.mjs'))});
      const term=new Terminal({cols:70,rows:10});term.open(document.querySelector('#terminal'));
      const {createTerminalKeyHandler}=await import(${JSON.stringify(uri('src/renderer/js/terminal-keys.mjs'))});
      window.testTerminal=term;window.copied=[];window.terminalInput=[];window.pasteText='';window.pasteReads=0;
      term.onData(data=>window.terminalInput.push(data));
      term.attachCustomKeyEventHandler(createTerminalKeyHandler(term,()=>{}, {writeText:async text=>window.copied.push(text),readText:async()=>{window.pasteReads++;return window.pasteText}}));
      window.opened=[];
      const provider=createTerminalLinkProvider(term,(event,url)=>{event.preventDefault();window.opened.push(url)});
      term.registerLinkProvider(provider);
      await new Promise(resolve=>term.write('网址 http://127.0.0.1:5001/gjhoutai/\\r\\nhttps://example.com/a?x=1&y=2.\\r\\n'+'https://example.com/'+ 'a'.repeat(90),resolve));
      const links=y=>new Promise(resolve=>provider.provideLinks(y,resolve));
      const local=(await links(1))[0],remote=(await links(2))[0],wrapped=(await links(4))[0];
      if(local.text!=='http://127.0.0.1:5001/gjhoutai/'||local.range.start.x!==6||remote.text!=='https://example.com/a?x=1&y=2'||wrapped.text!=='https://example.com/'+'a'.repeat(90))throw Error('Incorrect terminal URL or cell range '+JSON.stringify({local,remote,wrapped}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const screen=document.querySelector('.xterm-screen').getBoundingClientRect();
      return {x:screen.left+(local.range.start.x-.5)*screen.width/term.cols,y:screen.top+screen.height/term.rows/2};
    })()`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await new Promise(resolve=>setTimeout(resolve,150));
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    assert.deepEqual(await win.webContents.executeJavaScript('window.opened'),['http://127.0.0.1:5001/gjhoutai/']);
    await win.webContents.executeJavaScript("window.testTerminal.select(5,0,32);window.selectedText=window.testTerminal.getSelection();window.testTerminal.focus()");
    const pressCopy = () => {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'C',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'C',modifiers:['control']});
    };
    pressCopy();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await win.webContents.executeJavaScript('window.copied[0] === window.selectedText && window.terminalInput.length === 0'),true,'Selected Ctrl+C copies without sending interrupt');
    await win.webContents.executeJavaScript('window.testTerminal.clearSelection();window.testTerminal.focus()');
    pressCopy();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(await win.webContents.executeJavaScript('window.terminalInput'),['\x03'],'Ctrl+C without selection still interrupts');
    console.log('PASS selected Ctrl+C copies without interrupt; unselected Ctrl+C preserves interrupt');
    const paste = async (modifiers, text, expected) => {
      await win.webContents.executeJavaScript(`window.terminalInput=[];window.pasteReads=0;window.pasteText=${JSON.stringify(text)};window.testTerminal.focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers});
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.deepEqual(await win.webContents.executeJavaScript('window.terminalInput'),expected,'Paste inserts clipboard text once without sending Ctrl+V (0x16)');
      assert.equal(await win.webContents.executeJavaScript('window.pasteReads'),1);
    };
    await paste(['control'],'echo 中文粘贴',['echo 中文粘贴']);
    await paste(['control','shift'],'one\ntwo',['one\rtwo']);
    await win.webContents.executeJavaScript("new Promise(resolve=>window.testTerminal.write('\\x1b[?2004h',resolve))");
    await paste(['control'],'first\nsecond',['\x1b[200~first\rsecond\x1b[201~']);
    await paste(['control'],'',[]);
    console.log('PASS real Ctrl+V / Ctrl+Shift+V: Chinese, multiline, bracketed paste and empty clipboard; no literal ^V or duplicate input');
    console.log('PASS actual terminal URL click, Chinese cell offsets, query strings, trailing punctuation and wrapped URLs');
  } finally { win.destroy(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1);});
