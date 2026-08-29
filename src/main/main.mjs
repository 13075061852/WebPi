/**
 * Pi Halo — Electron main process
 * splash (launch animation) -> main window (three-panel celestial console)
 */

import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PiBridge, HaloStore } from "./pi-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "..");
const PRELOAD = path.join(DIST, "src", "preload", "preload.cjs");
const ICON = path.join(DIST, "assets", "icon.png");

// privileged scheme so the Preview pane can load workspace files in an iframe
protocol.registerSchemesAsPrivileged([
  { scheme: "halo-preview", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setName("Pi Halo");

let splashWin = null;
let mainWin = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const store = new HaloStore(path.join(app.getPath("userData"), "halo-settings.json"));
  const bridge = new PiBridge(store);

  const emit = (channel, payload) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
  };
  bridge.onEvent(emit);

  /* ---------------- splash ---------------- */

  function createSplash() {
    splashWin = new BrowserWindow({
      width: 640,
      height: 420,
      icon: ICON,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    splashWin.loadFile(path.join(DIST, "src", "renderer", "splash.html"));
    splashWin.once("ready-to-show", () => {
      splashWin.center();
      splashWin.show();
      splashWin.focus();
    });

    // start warming the agent core while the animation plays
    const startCwd = store.data.cwd || path.join(app.getPath("home"), "Desktop");
    bridge.start(startCwd).catch((e) => {
      console.error("[halo] bridge start failed:", e);
      emit("halo:error", { message: String(e?.message || e) });
    });

    // safety: never let splash block the app
    setTimeout(() => finishSplash(), 7000);
  }

  function finishSplash() {
    if (!splashWin || splashWin.isDestroyed()) return;
    createMainWindow();
    splashWin.close();
    splashWin = null;
  }

  /* ---------------- main window ---------------- */

  function createMainWindow() {
    mainWin = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1120,
      minHeight: 720,
      icon: ICON,
      frame: false,
      show: false,
      backgroundColor: "#06060b",
      titleBarStyle: "hidden",
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });

    mainWin.loadFile(path.join(DIST, "src", "renderer", "index.html"));
    mainWin.once("ready-to-show", () => {
      mainWin.show();
      mainWin.focus();
      emit("halo:window-shown", {});
    });
    mainWin.on("maximize", () => emit("halo:winstate", { maximized: true }));
    mainWin.on("unmaximize", () => emit("halo:winstate", { maximized: false }));
    mainWin.on("closed", () => (mainWin = null));
    mainWin.on("close", (e) => {
      if (!quitting) {
        quitting = true;
        bridge.dispose();
      }
    });
    // open external links in browser
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
  }

  /* ---------------- IPC ---------------- */

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });
  };

  handle("halo:splash-done", async () => {
    // give the main window a beat to paint before splash fades
    setTimeout(() => finishSplash(), 350);
    return true;
  });

  handle("halo:get-state", () => bridge.publicState());
  handle("halo:init", (cwd) => bridge.start(cwd));
  handle("halo:prompt", (text, opts) => bridge.prompt(text, opts));
  handle("halo:steer", (text) => bridge.steer(text));
  handle("halo:followUp", (text) => bridge.followUp(text));
  handle("halo:abort", () => bridge.abort());
  handle("halo:compact", (instructions) => bridge.compact(instructions));
  handle("halo:list-models", () => bridge.listModels());
  handle("halo:set-model", (provider, id) => bridge.setModel(provider, id));
  handle("halo:set-thinking", (level) => bridge.setThinkingLevel(level));
  handle("halo:list-sessions", () => bridge.listSessions());
  handle("halo:open-session", (file) => bridge.openSession(file));
  handle("halo:new-session", () => bridge.newSession());
  handle("halo:snapshot-messages", () => bridge.snapshotMessages());
  handle("halo:list-resources", () => bridge.listResources());

  /* ---------------- workspace & preview ---------------- */

  const isInsideProject = (p) => {
    const root = path.resolve(bridge.cwd || "");
    const abs = path.resolve(p);
    return abs === root || abs.startsWith(root + path.sep);
  };

  const IGNORE = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
    ".nuxt", ".cache", "coverage", "__pycache__", ".venv", "venv", "target", ".idea"]);

  handle("halo:read-tree", async () => {
    const root = path.resolve(bridge.cwd || ".");
    let count = 0;
    const CAP = 1200;
    const walk = (dir, depth) => {
      if (depth > 8 || count > CAP) return [];
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory())
        ? a.name.localeCompare(b.name)
        : (a.isDirectory() ? -1 : 1));
      const out = [];
      for (const e of entries) {
        if (count > CAP) break;
        if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          count++;
          out.push({ name: e.name, path: full, dir: true, children: walk(full, depth + 1) });
        } else {
          count++;
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          out.push({ name: e.name, path: full, dir: false, size });
        }
      }
      return out;
    };
    return { root, tree: walk(root, 0), truncated: count > CAP };
  });

  handle("halo:read-file", async (p) => {
    const abs = path.resolve(p);
    if (!isInsideProject(abs)) throw new Error("路径超出项目范围");
    const st = fs.statSync(abs);
    if (st.size > 512 * 1024) {
      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(512 * 1024);
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      if (text.includes("\0")) throw new Error("二进制文件");
      return { content: text, truncated: true, size: st.size };
    }
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes("\0")) throw new Error("二进制文件");
    return { content: text, truncated: false, size: st.size };
  });

  handle("halo:open-path", async (p) => {
    const abs = path.resolve(p);
    if (!isInsideProject(abs)) throw new Error("路径超出项目范围");
    return shell.openPath(abs);
  });

  handle("halo:pick-project", async (currentPath) => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: "选择项目目录",
      defaultPath: currentPath || store.data.cwd || undefined,
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = res.filePaths[0];
    if (dir !== bridge.cwd) {
      store.set("cwd", dir);
      bridge.cwd = dir;
      await bridge.start(dir);
    }
    return dir;
  });

  handle("halo:pick-images", async () => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: "附加图片",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (res.canceled) return [];
    return res.filePaths.map((p) => {
      const b = fs.readFileSync(p).toString("base64");
      const ext = path.extname(p).slice(1).toLowerCase();
      const mediaType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return { name: path.basename(p), mediaType, data: b };
    });
  });

  // window controls
  ipcMain.on("win:minimize", () => mainWin?.minimize());
  ipcMain.on("win:maximize", () => (mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin?.maximize()));
  ipcMain.on("win:close", () => mainWin?.close());

  /* ---------------- app lifecycle ---------------- */

  app.on("second-instance", () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    // preview protocol: serve workspace files to the Preview iframe safely
    const MIME = {
      ".html": "text/html", ".htm": "text/html", ".css": "text/css",
      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".md": "text/markdown", ".txt": "text/plain", ".mp4": "video/mp4",
      ".webm": "video/webm", ".pdf": "application/pdf",
    };
    protocol.handle("halo-preview", async (request) => {
      try {
        const u = new URL(request.url);
        let p = decodeURIComponent(u.pathname);
        if (process.platform === "win32") p = p.replace(/^\//, "");
        p = path.normalize(p);
        if (!isInsideProject(p)) return new Response("forbidden", { status: 403 });
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return new Response("too large", { status: 413 });
        const ext = path.extname(p).toLowerCase();
        const buf = fs.readFileSync(p);
        return new Response(buf, { headers: { "content-type": MIME[ext] || "application/octet-stream" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    createSplash();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
