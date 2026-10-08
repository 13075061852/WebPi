// Isolated Electron protocol/CSP smoke: no personal profile or remote account.
const { app, protocol, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-theme-electron-'));
app.setPath('userData', fixture);
protocol.registerSchemesAsPrivileged([{ scheme: 'halo-theme', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
  try {
    const { createThemeImages } = await import('../../src/main/theme-images.mjs');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/theme-images.json')));
    const png = fs.readFileSync(path.join(root, 'assets/icon-rounded.png'));
    const handler = createThemeImages({ manifest, cacheDir: path.join(fixture, 'images'), fetcher: async () => new Response(png) });
    let previewAttempts = 0;
    protocol.handle('halo-theme', async request => {
      if (!request.url.includes('/retry-test')) return handler(request);
      await new Promise(resolve => setTimeout(resolve, 400));
      return ++previewAttempts === 1 ? new Response(null, { status: 503 }) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
    });
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    for (const page of ['index.html', 'splash.html']) {
      await win.loadFile(path.join(root, 'src/renderer', page));
      const size = await win.webContents.executeJavaScript(`new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = 'halo-theme://images/themes/collection/scene-pine.webp'; })`);
      assert.ok(size > 0, `${page} must allow and decode cloud theme protocol`);
      if (page === 'index.html') {
        const result = await win.webContents.executeJavaScript(`(async () => {
          const { initThemePreviews } = await import('./js/theme-previews.mjs');
          const button = document.createElement('button');
          button.dataset.themeChoice = 'test';
          button.style.cssText = 'position:fixed;inset:0;width:240px;height:180px;z-index:99999';
          button.innerHTML = '<span class="theme-sample wallpaper-sample" style="background-image:url(halo-theme://images/retry-test)"><i></i><i></i><i></i></span>';
          document.body.append(button);
          initThemePreviews(button);
          const sample = button.firstElementChild;
          const initial = sample.dataset.previewState;
          const height = sample.getBoundingClientRect().height;
          const wait = async state => { for(let i=0;i<100;i++){ if(sample.dataset.previewState === state)return; await new Promise(r=>setTimeout(r,50)); } throw Error('Timed out: '+state); };
          await wait('error');
          button.click();
          const retry = sample.dataset.previewState;
          await wait('ready');
          return { initial, retry, final:sample.dataset.previewState, stable:height===sample.getBoundingClientRect().height, decoded:sample.querySelector('img').naturalWidth>0 };
        })()`);
        assert.deepEqual(result, { initial: 'loading', retry: 'loading', final: 'ready', stable: true, decoded: true });
      }
    }
    win.destroy();
    console.log('PASS Electron theme protocol and main/splash CSP');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
