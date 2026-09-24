// Plain CommonJS on purpose: Electron preload scripts are the one place in
// this project that's simplest kept out of the "type": "module" world the
// rest of the app uses (see README/project notes on why). It has no
// dependency on any of our own TS modules - just contextBridge/ipcRenderer -
// so there's nothing to compile here; this file ships as-is.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (callback) => {
    ipcRenderer.on("state", (_event, payload) => callback(payload));
  },
  onInteractiveChanged: (callback) => {
    ipcRenderer.on("interactive-changed", (_event, interactive) => callback(interactive));
  },
});
