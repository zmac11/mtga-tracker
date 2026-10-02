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
  // Clickable spots (menu button, current-event / draft rows) as
  // window-relative rects: main polls the cursor against them and makes the
  // click-through overlay clickable only over those - main.ts's
  // updateOverlayHotspotState.
  setHotspots: (rects) => ipcRenderer.send("overlay-set-hotspots", rects),
  // The in-overlay menu (main.ts's openOverlayMenu): the button toggles it,
  // main pushes its entries, and an entry click is reported back by id.
  openMenu: () => ipcRenderer.invoke("open-overlay-menu"),
  closeMenu: () => ipcRenderer.invoke("close-overlay-menu"),
  menuAction: (id) => ipcRenderer.invoke("overlay-menu-action", id),
  // 2026-10-02: the in-game deck-list column (library tracking) - main pushes
  // a pre-rendered, trusted HTML fragment (libraryPanelHtml.ts), or null to hide it.
  onLibrary: (callback) => {
    ipcRenderer.on("library", (_event, payload) => callback(payload));
  },
  onMenu: (callback) => {
    ipcRenderer.on("overlay-menu", (_event, payload) => callback(payload));
  },
});

// Milestone 9+: the Settings window (opened from the tray menu) reads and
// writes the same overlay-settings.json main.ts also applies live to the
// overlay window - see settings-renderer.js.
contextBridge.exposeInMainWorld("settingsApi", {
  getSettings: () => ipcRenderer.invoke("get-overlay-settings"),
  setSizePreset: (presetKey) => ipcRenderer.invoke("set-size-preset", presetKey),
  setOpacity: (opacity) => ipcRenderer.invoke("set-opacity", opacity),
  // 2026-10-02: overlay look - "default" (dark) or "blue" (matches the overlay's menu button).
  setOverlayTheme: (themeKey) => ipcRenderer.invoke("set-overlay-theme", themeKey),
  // Milestone 13: deck viewer "Visual" tab card-thumbnail size.
  setCardSizePreset: (presetKey) => ipcRenderer.invoke("set-card-size-preset", presetKey),
  // Milestone 15: the "Updates" section - toggling automatic checks, and an explicit "Check Now" button.
  setAutoCheckForUpdates: (enabled) => ipcRenderer.invoke("set-auto-check-updates", enabled),
  checkForUpdatesNow: () => ipcRenderer.invoke("check-for-updates-now"),
  // Milestone 18: the "Locations" section - manual overrides for a player
  // whose Player.log/card database auto-detection guessed wrong. The two
  // choose* calls open a native file/folder picker in the main process
  // (nodeIntegration is off here, so this window can't use Node's fs/
  // dialog itself) and return once the user picks something or cancels.
  chooseLogPath: () => ipcRenderer.invoke("choose-log-path"),
  resetLogPath: () => ipcRenderer.invoke("reset-log-path"),
  chooseCardDbPath: () => ipcRenderer.invoke("choose-card-db-path"),
  resetCardDbPath: () => ipcRenderer.invoke("reset-card-db-path"),
  // Milestone 25: the "Unfinished Events" section - runs the tracker's own
  // detection never saw reach a final state, so the user can type in the
  // correct score by hand.
  getPendingEventClosures: () => ipcRenderer.invoke("get-pending-event-closures"),
  submitManualEventResult: (eventId, courseId, wins, losses) => ipcRenderer.invoke("submit-manual-event-result", { eventId, courseId, wins, losses }),
});
