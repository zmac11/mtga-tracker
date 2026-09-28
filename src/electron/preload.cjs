// Plain CommonJS on purpose: Electron preload scripts are the one place in
// this project that's simplest kept out of the "type": "module" world the
// rest of the app uses (see README/project notes on why). It has no
// dependency on any of our own TS modules - just contextBridge/ipcRenderer -
// so there's nothing to compile here; this file ships as-is.
//
// This one preload file is assigned to BOTH the overlay window and the
// Settings window (main.ts's webPreferences.preload for each) - each window
// gets its own isolated JS context, so exposing both `overlay` and
// `settingsApi` here doesn't leak between them; it just keeps one file
// instead of two nearly-identical ones.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (callback) => {
    ipcRenderer.on("state", (_event, payload) => callback(payload));
  },
  onInteractiveChanged: (callback) => {
    ipcRenderer.on("interactive-changed", (_event, interactive) => callback(interactive));
  },
  // Milestone 9+: pushed whenever the user's chosen overlay size/opacity
  // (see the Settings window) changes, and once on load - see
  // overlay-renderer.js's applySettings.
  onSettings: (callback) => {
    ipcRenderer.on("settings", (_event, payload) => callback(payload));
  },
  openDeckViewer: () => ipcRenderer.invoke("open-deck-viewer"),
  openDraftProgress: () => ipcRenderer.invoke("open-draft-progress"),
});

// Milestone 9+: the Settings window (opened from the tray menu) reads and
// writes the same overlay-settings.json main.ts also applies live to the
// overlay window - see settings-renderer.js.
contextBridge.exposeInMainWorld("settingsApi", {
  getSettings: () => ipcRenderer.invoke("get-overlay-settings"),
  setSizePreset: (presetKey) => ipcRenderer.invoke("set-size-preset", presetKey),
  setOpacity: (opacity) => ipcRenderer.invoke("set-opacity", opacity),
  // Milestone 13: deck viewer "Visual" tab card-thumbnail size.
  setCardSizePreset: (presetKey) => ipcRenderer.invoke("set-card-size-preset", presetKey),
});
