import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CapturePipeline } from "../pipeline.js";
import { LiveStateTracker } from "../domain/liveState.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Milestone 3: the overlay. Reuses the exact same capture pipeline as the
 * headless CLI (pipeline.ts) so there's only one implementation of "find
 * Player.log, tail it, parse it, classify it, store it" - this file's job
 * is just to turn the classified events into a small always-on-top window.
 *
 * Window is click-through by default (so it never blocks clicks on Arena
 * underneath it); Cmd/Ctrl+Shift+O toggles that off temporarily so you can
 * drag it to a better spot by its top handle. Position is remembered across
 * runs in a small JSON file under Electron's userData directory.
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
let interactive = false; // false = click-through (default)

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
}

app.whenReady().then(() => {
  // Overlay-only app - no dock icon needed on macOS. Quit via the global
  // shortcut below (there's no other window/menu to close from).
  app.dock?.hide();

  mainWindow = createWindow();

  const { logPath, fromStart } = parseArgs(process.argv.slice(2));
  const pipeline = new CapturePipeline({ logPath, fromStart });
  const liveState = new LiveStateTracker();

  const sendSnapshot = () => {
    mainWindow?.webContents.send("state", {
      foundLog: pipeline.located.found,
      watchingPath: pipeline.located.path,
      snapshot: liveState.snapshot(),
    });
  };

  mainWindow.webContents.once("did-finish-load", sendSnapshot);

  if (pipeline.located.found) {
    pipeline.on("domainEvent", (event) => {
      liveState.record(event);
      sendSnapshot();
    });
    pipeline.on("error", (err) => console.error("Tailer error:", err));
    pipeline.start();
  } else {
    console.error(`Could not find Player.log. Checked:\n  ${pipeline.located.checked.join("\n  ")}`);
    console.error("Make sure Options > Account > Detailed Logs (Plugin Support) is on, then relaunch Arena once.");
  }

  globalShortcut.register("CommandOrControl+Shift+O", toggleInteractive);
  // Quit shortcut since this app deliberately has no dock icon/menu bar to quit from otherwise.
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  console.log(pipeline.located.found ? `Overlay running. Watching: ${pipeline.located.path}` : "Overlay running, but Player.log was not found (see error above).");
  console.log("Cmd/Ctrl+Shift+O: unlock to drag the overlay.  Cmd/Ctrl+Shift+Q: quit.");

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
  app.quit();
});
