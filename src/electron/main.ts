import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CapturePipeline } from "../pipeline.js";
import { LiveStateTracker } from "../domain/liveState.js";
import { TypedEventStore } from "../db/sqliteStore.js";
import { CardStore } from "../cards/cardStore.js";
import { buildDeckViewerData } from "../deckViewerLoader.js";
import { generateDeckViewerHtml } from "../deckViewerHtml.js";
import { buildDraftProgressData } from "../draftProgressLoader.js";
import { generateDraftProgressHtml, generateNoDraftInProgressHtml } from "../draftProgressHtml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Milestone 3: the overlay. Reuses the exact same capture pipeline as the
 * headless CLI (pipeline.ts) so there's only one implementation of "find
 * Player.log, tail it, parse it, classify it, store it" - this file's job
 * is just to turn the classified events into a small always-on-top window,
 * plus a menu-bar tray icon for settings (no dock icon, no menu bar window -
 * the tray is the only UI chrome this app has).
 *
 * Window is click-through by default (so it never blocks clicks on Arena
 * underneath it); Cmd/Ctrl+Shift+O (or the tray menu) toggles that off
 * temporarily so you can drag it to a better spot by its top handle.
 * Position is remembered across runs in a small JSON file under Electron's
 * userData directory.
 */

function parseArgs(argv: string[]) {
  const args = { logPath: undefined as string | undefined, fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-path") args.logPath = argv[++i];
    else if (argv[i] === "--from-start") args.fromStart = true;
  }
  return args;
}

const WINDOW_WIDTH = 300;
const WINDOW_HEIGHT = 180;

function positionConfigPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "overlay-position.json");
}

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = readFileSync(positionConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return parsed;
  } catch {
    // No saved position yet, or the file's unreadable/corrupt - fall back to the default corner.
  }
  return null;
}

function savePosition(x: number, y: number): void {
  try {
    writeFileSync(positionConfigPath(), JSON.stringify({ x, y }), "utf8");
  } catch {
    // Best-effort - losing the remembered position isn't worth crashing over.
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let interactive = false; // false = click-through (default)
let watchingStatus = "Starting...";

function createWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const saved = loadSavedPosition();
  const x = saved?.x ?? display.workArea.x + display.workArea.width - WINDOW_WIDTH - 24;
  const y = saved?.y ?? display.workArea.y + 24;

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' level + visibleOnFullScreen is what actually gets an
  // Electron window to float above a fullscreen game on macOS - plain
  // alwaysOnTop alone does not.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on("moved", () => {
    const [wx, wy] = win.getPosition();
    savePosition(wx, wy);
  });

  win.loadFile(join(__dirname, "renderer", "overlay.html"));
  return win;
}

function toggleInteractive(): void {
  if (!mainWindow) return;
  interactive = !interactive;
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  mainWindow.webContents.send("interactive-changed", interactive);
  rebuildTrayMenu();
}

function toggleStartAtLogin(): void {
  // openAtLogin is read back from macOS itself (via Electron) rather than
  // stored in our own settings file - it's the OS's own state (also visible
  // in System Settings > General > Login Items), so this can't drift from
  // what's actually configured the way a separately-cached copy could.
  const current = app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: !current });
  rebuildTrayMenu();
}

/**
 * Rebuilt (rather than mutated in place) every time something it reflects
 * changes - watching status, interactive/click-through state, or the login
 * item setting - since Electron's Menu items don't update reactively once
 * built. This is also, for now, the entire "settings menu": there's only
 * one real toggle (start at login) plus the drag-unlock convenience, so a
 * separate settings window would be more chrome than substance. Revisit if
 * more settings accumulate.
 */
function rebuildTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: watchingStatus, enabled: false },
    { type: "separator" },
    {
      label: "Start MTGA Tracker at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: toggleStartAtLogin,
    },
    {
      label: "Unlock Overlay (drag to move)",
      type: "checkbox",
      checked: interactive,
      accelerator: "CommandOrControl+Shift+O",
      click: toggleInteractive,
    },
    { type: "separator" },
    { label: "Quit MTGA Tracker", accelerator: "CommandOrControl+Shift+Q", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray(): Tray {
  const iconPath = join(__dirname, "assets", "iconTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true); // lets macOS recolor it correctly for light/dark menu bars
  const t = new Tray(icon);
  t.setToolTip("MTGA Tracker");
  return t;
}

app.whenReady().then(() => {
  // Tray-only app - no dock icon, no window menu. All settings/quit live in
  // the tray's context menu (built below) instead.
  app.dock?.hide();

  mainWindow = createWindow();
  tray = createTray();

  const { logPath, fromStart } = parseArgs(process.argv.slice(2));
  const pipeline = new CapturePipeline({ logPath, fromStart });
  const liveState = new LiveStateTracker();
  // Rebuild win-rate/event-record history from previous runs before we ever
  // show anything - otherwise a relaunch shows every event's record as blank
  // (or wrong) until something new happens to re-report it, even though the
  // correct data was already sitting in tracker.db. See
  // LiveStateTracker.seedHistory's comment for the bug this fixes.
  liveState.seedHistory(pipeline.historyForSeeding());

  // Milestone 7 phase 4: "click the current event to view its deck" - opens
  // a generated static HTML page (data/deck-viewer/<eventId>.html) in the
  // user's default browser, per the UI-surface decision in
  // feature-roadmap-milestone7.md. Deliberately opens fresh, short-lived
  // TypedEventStore/CardStore connections rather than sharing the pipeline's
  // - this is a one-shot read-then-close on click, not something that needs
  // to stay open, and keeping it separate avoids any risk of interfering
  // with the pipeline's own long-lived connection.
  ipcMain.handle("open-deck-viewer", () => {
    const currentEventId = liveState.snapshot().eventRecord?.eventId;
    if (!currentEventId) return { ok: false, reason: "No current event to show yet." };

    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const data = buildDeckViewerData(currentEventId, store, cardStore);
      if (!data) return { ok: false, reason: `No deck/draft data captured yet for ${currentEventId}.` };

      const html = generateDeckViewerHtml(data);
      const outDir = join(pipeline.dataDir, "deck-viewer");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${currentEventId.replace(/[^A-Za-z0-9_-]/g, "_")}.html`);
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
      return { ok: true };
    } catch (err) {
      console.error("Failed to generate/open deck viewer:", err);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      store?.close();
      cardStore?.close();
    }
  });

  // Milestone 7 phase 5: "live draft progress" page. See draftProgressHtml.ts's
  // top comment for why this is a static file that gets rewritten on every
  // relevant event rather than served live - short version: this project
  // deliberately has no local HTTP server (see phase 4's notes), so the page
  // auto-refreshes itself and this is what keeps its content fresh for it to
  // pick up. Always writes something (a real snapshot, or the "no draft in
  // progress" placeholder) so a tab left open never shows stale, already-
  // finished pack contents as if they were still current.
  const draftProgressPath = join(pipeline.dataDir, "draft-progress", "live.html");
  const regenerateDraftProgressPage = () => {
    try {
      mkdirSync(join(pipeline.dataDir, "draft-progress"), { recursive: true });
      const currentDraft = liveState.snapshot().currentDraft;
      if (!currentDraft) {
        writeFileSync(draftProgressPath, generateNoDraftInProgressHtml(), "utf8");
        return;
      }
      const cardStore = new CardStore(join(pipeline.dataDir, "tracker.db"));
      try {
        const data = buildDraftProgressData(currentDraft, cardStore);
        writeFileSync(draftProgressPath, generateDraftProgressHtml(data), "utf8");
      } finally {
        cardStore.close();
      }
    } catch (err) {
      console.error("Failed to regenerate draft-progress page:", err);
    }
  };

  ipcMain.handle("open-draft-progress", () => {
    regenerateDraftProgressPage();
    shell.openPath(draftProgressPath);
    return { ok: true };
  });

  const sendSnapshot = () => {
    mainWindow?.webContents.send("state", {
      foundLog: pipeline.located.found,
      watchingPath: pipeline.located.path,
      snapshot: liveState.snapshot(),
    });
  };

  mainWindow.webContents.once("did-finish-load", sendSnapshot);

  if (pipeline.located.found) {
    watchingStatus = `Watching: ${pipeline.located.path}`;
    pipeline.on("domainEvent", (event) => {
      liveState.record(event);
      sendSnapshot();
      // Only these three kinds can change what the draft-progress page
      // should show (see LiveStateTracker.record) - no point re-reading the
      // ~27k-row card catalog on every unrelated match/game-state event.
      if (event.kind === "DraftPackSeen" || event.kind === "DraftPickMade" || event.kind === "DraftCompleted") {
        regenerateDraftProgressPage();
      }
    });
    pipeline.on("error", (err) => console.error("Tailer error:", err));
    pipeline.start();
  } else {
    watchingStatus = "Player.log not found - see console";
    console.error(`Could not find Player.log. Checked:\n  ${pipeline.located.checked.join("\n  ")}`);
    console.error("Make sure Options > Account > Detailed Logs (Plugin Support) is on, then relaunch Arena once.");
  }
  rebuildTrayMenu();

  globalShortcut.register("CommandOrControl+Shift+O", toggleInteractive);
  // Quit shortcut since this app deliberately has no dock icon/menu bar to quit from otherwise
  // (also available from the tray menu).
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  console.log(watchingStatus);
  console.log("Cmd/Ctrl+Shift+O: unlock to drag the overlay.  Cmd/Ctrl+Shift+Q: quit.  Or use the tray icon's menu for both, plus Start at Login.");

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await pipeline.stop();
  };
  app.on("before-quit", (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      shutdown().then(() => app.quit());
    }
  });
});

app.on("window-all-closed", () => {
  // Deliberately NOT quitting here: this is a tray app, and the overlay is
  // its only BrowserWindow - closing it (which we never do ourselves, but
  // just in case) shouldn't kill the tray icon/capture pipeline with it.
});
