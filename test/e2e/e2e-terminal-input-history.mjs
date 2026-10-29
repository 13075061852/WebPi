import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchElectronApp, waitUntil } from '../helpers/electron-app.mjs';

if (process.platform !== 'win32') { console.log('SKIP CMD input history: Windows only'); process.exit(0); }
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-terminal-input-history-'));
for (const name of ['profile', 'project', 'agent', 'roaming', 'local', 'gh']) fs.mkdirSync(path.join(fixture, name));
const profile = path.join(fixture, 'profile'), cwd = path.join(fixture, 'project'), system = process.env.SystemRoot || 'C:/Windows';
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd, projects: [{ cwd }], globalProxy: { mode: 'direct' } }));
fs.writeFileSync(path.join(fixture, 'gitconfig'), '');
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.dirname(process.execPath), path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: path.join(fixture, 'agent'), PI_OFFLINE: '1',
  GH_CONFIG_DIR: path.join(fixture, 'gh'), GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
let app;
const key = async (name, code) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
};
const saved = () => app.evaluate('window.halo.ptyList().then(r=>r.data.terminals[0])');
const screen = () => app.evaluate("[...document.querySelectorAll('.xterm-rows > div')].map(n=>n.textContent).join('').trimEnd()");
const command = async text => {
  await app.send('Input.insertText', { text }); await key('Enter', 13);
  await waitUntil(async () => (await saved()).commands?.includes(text), 'Command was not remembered: ' + text);
};
try {
  app = await launchElectronApp({ fixture, profile, env });
  await app.evaluate("if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click();document.querySelector('#btnTerm').click()");
  await waitUntil(() => app.evaluate("!!document.querySelector('.terminal-panel')?.dataset.pid && document.querySelector('.xterm-rows').textContent.includes('>')"), 'Terminal prompt missing');
  await app.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await command('echo HISTORY_ONE'); await command('echo HISTORY_TWO');
  const id = (await saved()).id;
  await app.close(); app = null;
  app = await launchElectronApp({ fixture, profile, env });
  await app.evaluate("if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click()");
  await waitUntil(() => app.evaluate("!!document.querySelector('.terminal-panel')?.dataset.pid && document.querySelector('.xterm-rows').textContent.includes('>')"), 'Restored prompt missing');
  await app.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await app.send('Input.insertText', { text: 'unfinished draft' });
  await waitUntil(async () => (await screen()).endsWith('unfinished draft'), 'Draft was not echoed');
  await key('ArrowUp', 38);
  await waitUntil(async () => (await screen()).endsWith('echo HISTORY_TWO'), 'Up did not recall the last command after restart');
  await key('ArrowUp', 38);
  await waitUntil(async () => (await screen()).endsWith('echo HISTORY_ONE'), 'Up did not recall the previous command');
  await key('ArrowDown', 40);
  await waitUntil(async () => (await screen()).endsWith('echo HISTORY_TWO'), 'Down did not recall the newer command');
  await key('ArrowDown', 40);
  await waitUntil(async () => (await screen()).endsWith('unfinished draft'), 'Down did not restore the unfinished draft');
  assert.deepEqual((await saved()).commands, ['echo HISTORY_ONE', 'echo HISTORY_TWO'], 'Navigation must not execute commands');
  await key('ArrowUp', 38); await waitUntil(async () => (await screen()).endsWith('echo HISTORY_TWO'), 'Recall before Enter');
  await key('Enter', 13);
  await waitUntil(async () => (await screen()).endsWith('>'), 'Recalled command did not execute on Enter');
  await key('ArrowUp', 38); await key('ArrowUp', 38); await key('Enter', 13);
  await waitUntil(async () => (await saved()).commands.at(-1) === 'echo HISTORY_ONE' && (await screen()).endsWith('>'), 'Rapid Up/Up/Enter lost or executed the wrong input');
  await command('more');
  await waitUntil(async () => (await saved()).output.includes('cmd.exe - more'), 'Child program did not start');
  await key('ArrowUp', 38);
  await app.send('Input.insertText', { text: 'CHILD_PROGRAM_INPUT' }); await key('Enter', 13);
  await waitUntil(async () => (await saved()).output.includes('CHILD_PROGRAM_INPUT'), 'Child input was not processed');
  assert.equal((await saved()).commands.some(text => text.includes('CHILD_PROGRAM_INPUT')), false);
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await waitUntil(async () => (await screen()).endsWith('>'), 'Ctrl+C did not return from child program');
  assert.equal((await saved()).commands.some(text => text.includes('CHILD_PROGRAM_INPUT')), false, 'Child program input must not become shell history');
  await app.evaluate(`window.halo.ptyWrite(${JSON.stringify({ id, data: 'for /L %i in (1,1,120) do @echo SCROLL_%i\r' })})`);
  await waitUntil(async () => (await saved()).output.includes('SCROLL_120'), 'Scroll fixture incomplete');
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(`document.documentElement.dataset.theme='${theme}'`);
    const style = await app.evaluate(`(() => {
      const slider=document.querySelector('#termHost .scrollbar.vertical .slider'), s=getComputedStyle(slider);
      const probe=document.createElement('div');document.body.append(probe);
      const global=getComputedStyle(probe,'::-webkit-scrollbar-thumb');
      const result={width:slider.getBoundingClientRect().width,radius:s.borderRadius,color:s.backgroundColor,global:global.backgroundColor};probe.remove();return result;
    })()`);
    assert.equal(style.width, 8); assert.equal(style.radius, '8px'); assert.equal(style.color, style.global, JSON.stringify(style));
    const shot = await app.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(fixture, `terminal-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  await app.close(); app = null;
  const indexFile = path.join(profile, 'terminal-memory/index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete index.terminals[0].commands; fs.writeFileSync(indexFile, JSON.stringify(index));
  app = await launchElectronApp({ fixture, profile, env });
  await app.evaluate("if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click()");
  await waitUntil(async () => (await saved()).commands?.includes('echo HISTORY_TWO'), 'Old transcript did not migrate to recallable history');
  await waitUntil(async () => (await saved()).output.match(/Microsoft Windows \[/g)?.length >= 3 && (await screen()).endsWith('>'), 'Migrated terminal prompt missing');
  await app.send('Page.bringToFront');
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await app.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await app.send('Input.insertText', { text: 'migration draft' });
  await waitUntil(async () => (await screen()).endsWith('migration draft'), 'Migrated terminal did not accept keyboard input');
  const latest = (await saved()).commands.at(-1);
  await key('ArrowUp', 38);
  await waitUntil(async () => (await screen()).endsWith(latest), 'Migrated command could not be recalled');
  await app.close(); app = null;
  console.log(JSON.stringify({ ok: true, fixture, checks: ['actual keyboard input', 'restart Up/Down recall', 'unfinished draft', 'rapid Up/Up/Enter', 'child input isolation', 'old transcript migration', '8px rounded scrollbar', 'global light/dark colors'] }));
} finally { await app?.stop(); }
