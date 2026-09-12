/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9399;
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'halo-render-'))}`],
  { stdio: ["ignore", "pipe", "pipe"] }
);
electron.stderr.on("data", () => {});
electron.on("exit", (c) => console.log("electron exited", c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const main = list.find((t) => t.type === "page" && t.url.endsWith("index.html"));
      if (main) return main;
    } catch {}
    await sleep(500);
  }
  throw new Error("main window not found");
}

const main = await findMainPage();
console.log("connected:", main.title);
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleLogs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
function send(method, params = {}, sessionId) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function screenshot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("saved", file);
}

await send("Runtime.enable");
await send("Page.enable");

// wait for the app + debug hook
let ready = false;
for (let i = 0; i < 30; i++) {
  try { ready = await evalJS("!!window.__haloDispatch"); } catch {}
  if (ready) break;
  await sleep(500);
}
if (!ready) throw new Error("__haloDispatch not available");
console.log("app ready, injecting scenarios...");

// make the layout deterministic for the shot
await evalJS(`
  document.body.classList.add('enter');
`);


try {
 await sleep(1200);
 await evalJS(`document.querySelector('#btnSettings').click();document.querySelector('[data-pane="appearance"]').click()`);
 const result=await evalJS(`(async()=>{
  const tabs=[...document.querySelectorAll('[data-theme-tab]')];
  if(tabs.length!==5)throw Error('Expected five categories');
  let count=0;
  for(const tab of tabs){
   tab.click();
   const panels=[...document.querySelectorAll('[data-theme-panel]')].filter(x=>!x.hidden);
   if(panels.length!==1||panels[0].dataset.themePanel!==tab.dataset.themeTab)throw Error('Wrong visible panel');
   const cards=[...panels[0].querySelectorAll('[data-theme-choice]')];
   if(cards.length!==6)throw Error('Expected six wallpapers per category');
   for(const card of cards){
    card.click();const id=card.dataset.themeChoice;
    if(document.documentElement.dataset.wallpaper!==id||localStorage.getItem('halo-theme')!==id)throw Error('Selection failed '+id);
    if(document.documentElement.dataset.theme!==window.HALO_THEME_PALETTES[id])throw Error('Palette failed '+id);
    const styles=getComputedStyle(document.documentElement);
    if(!styles.getPropertyValue('--wallpaper').includes(id+'.webp'))throw Error('Wrong wallpaper URL '+id);
    const sample=card.querySelector('.theme-sample');
    if(!getComputedStyle(sample).backgroundImage.includes(id+'-thumb.webp'))throw Error('Missing thumbnail style');
    for(const suffix of ['.webp','-thumb.webp']){
     const image=new Image();image.src='../../assets/themes/collection/'+id+suffix;await image.decode();
     if(image.naturalWidth<(suffix==='.webp'?1600:480))throw Error('Invalid image dimensions '+id);
    }
    if(sample.getBoundingClientRect().width<100)throw Error('Hidden card');
    count++;
   }
  }
  tabs[0].click();tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  if(document.activeElement!==tabs[1]||tabs[1].getAttribute('aria-selected')!=='true')throw Error('Keyboard tab failed');
  for(const mode of ['light','dark']){document.querySelector('[data-theme-choice='+mode+']').click();if(document.documentElement.dataset.theme!==mode||document.documentElement.dataset.wallpaper)throw Error('Base mode failed');}
  document.querySelector('[data-theme-tab=oriental]').click();document.querySelector('[data-theme-choice=scene-moon]').click();
  const slider=document.querySelector('#wallpaperTransparency');slider.value=35;slider.dispatchEvent(new Event('input'));
  return {categories:tabs.length,wallpapers:count,decoded:count*2};
 })()`);
 for(const category of ['nature','water','city','cosmos','oriental']){
  await evalJS(`document.querySelector('[data-theme-tab=${category}]').click()`);
  await sleep(150);
  await screenshot(`tmp/theme-${category}.png`);
 }
 await evalJS('location.reload()');await sleep(1500);
 if(await evalJS('document.documentElement.dataset.wallpaper')!=='scene-moon')throw Error('Theme persistence failed');
 if(await evalJS('document.documentElement.dataset.theme')!=='dark')throw Error('Palette persistence failed');
 console.log('PASS',JSON.stringify(result),'keyboard, base modes and persisted theme');
} finally {ws.close();electron.kill();}
