const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (cb) => {
  const wrapped = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("halo", {
  // state / session
  getState: () => ipcRenderer.invoke("halo:get-state"),
  init: (cwd) => ipcRenderer.invoke("halo:init", cwd),
  prompt: (text, opts) => ipcRenderer.invoke("halo:prompt", text, opts),
  steer: (text) => ipcRenderer.invoke("halo:steer", text),
  followUp: (text) => ipcRenderer.invoke("halo:followUp", text),
  abort: () => ipcRenderer.invoke("halo:abort"),
  compact: (instructions) => ipcRenderer.invoke("halo:compact", instructions),
  listModels: () => ipcRenderer.invoke("halo:list-models"),
  setModel: (provider, id) => ipcRenderer.invoke("halo:set-model", provider, id),
  setThinking: (level) => ipcRenderer.invoke("halo:set-thinking", level),
  listSessions: () => ipcRenderer.invoke("halo:list-sessions"),
  openSession: (file) => ipcRenderer.invoke("halo:open-session", file),
  newSession: () => ipcRenderer.invoke("halo:new-session"),
  snapshotMessages: () => ipcRenderer.invoke("halo:snapshot-messages"),
  listResources: () => ipcRenderer.invoke("halo:list-resources"),

  // dialogs
  pickProject: (current) => ipcRenderer.invoke("halo:pick-project", current),
  pickImages: () => ipcRenderer.invoke("halo:pick-images"),

  // workspace / preview
  readTree: () => ipcRenderer.invoke("halo:read-tree"),
  readFile: (p) => ipcRenderer.invoke("halo:read-file", p),
  openPath: (p) => ipcRenderer.invoke("halo:open-path", p),

  // window
  minimize: () => ipcRenderer.send("win:minimize"),
  maximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),

  // events from main
  onState: listen("halo:state"),
  onPiEvent: listen("pi:event"),
  onError: listen("halo:error"),
  onWinState: listen("halo:winstate"),
  onWindowShown: listen("halo:window-shown"),

  // splash -> main
  splashDone: () => ipcRenderer.invoke("halo:splash-done"),
});
