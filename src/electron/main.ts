import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { CapturePipeline } from "../pipeline.js";
import { LiveStateTracker } from "../domain/liveState.js";
import { TypedEventStore } from "../db/sqliteStore.js";
import { CardStore } from "../cards/cardStore.js";
import { locateCardDatabase } from "../cards/cardDbLocator.js";
import { locateLogFile } from "../log/logLocator.js";
import { extractArenaCards } from "../cards/extractArenaCards.js";
import { enrichCards } from "../cards/scryfallEnrich.js";
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
 * the tray is the only UI chrome this app has, apart from the small
 * Settings window described below).
 *
 * Window is click-through by default (so it never blocks clicks on Arena
 * underneath it); Cmd/Ctrl+Shift+O (or the tray menu) toggles that off
 * temporarily so you can drag it to a better spot from anywhere on it (see
 * overlay.css's drag-region comment). Position is remembered across runs in
 * a small JSON file under Electron's userData directory.
 *
 * Milestone 8+ (2026-09-24): the tray menu also exposes "Refresh Card
 * Database" - a button version of `npm run refresh-cards` (see
 * refreshCards.ts), so the card catalog (names/images/oracle text the
 * deck viewer and draft-progress pages resolve grpIds against) can be kept
 * current after an Arena patch/new set without needing a terminal at all.
 * Runs the exact same pipeline (locate Arena's Raw_CardDatabase_*.mtga ->
 * extract -> enrich from Scryfall -> upsert into tracker.db) inline in the
 * main process rather than shelling out to the CLI script, so it works the
 * same whether or not the user has Node/npm set up separately from the
 * packaged app.
 *
 * Milestone 9+ (2026-09-24): the user asked for a few overlay-size options
 * plus a transparency slider "so anyone can set optimal settings for
 * them". A continuous slider isn't something a native Tray context menu
 * can host on any platform, so this is the one setting that finally
 * justified a real (small, plain) Settings window - opened from the tray's
 * "Overlay Settings..." item - rather than more tray-menu items. Size and
 * opacity both persist to overlay-settings.json (same "small JSON file
 * under userData" pattern as the remembered window position) and apply
 * live to the running overlay the instant they change - see
 * applyOverlaySettings() below.
 *
 * Milestone 11 (2026-09-25): a "Hide Overlay" tray item + Cmd/Ctrl+Shift+H
 * shortcut that shows/hides the whole overlay window outright - separate
 * from (and independent of) the click-through/drag "Unlock Overlay"
 * toggle above, which only ever affects whether the window *receives mouse
 * events*, not whether it's visible at all. Deliberately session-scoped,
 * not persisted to disk - like the click-through toggle, it resets to
 * "visible" on every relaunch, so the overlay never silently fails to
 * appear because of a hide from a previous session the user forgot about.
 * See toggleOverlayHidden() below.
 */

/**
 * Milestone 15: "check & notify" version checking against the repo's public
 * GitHub Releases - see checkForUpdates() below for the full rationale
 * (short version: no code-signing/notarization setup exists for this
 * project yet, so a real silent auto-updater isn't safe to ship - this only
 * ever tells the user a newer release exists and links to it).
 */
const GITHUB_RELEASES_API = "https://api.github.com/repos/zmac11/mtga-tracker/releases/latest";
const GITHUB_RELEASES_PAGE = "https://github.com/zmac11/mtga-tracker/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours while running
const ARENA_POLL_INTERVAL_MS = 20 * 1000; // best-effort "did Arena just launch" poll - see checkArenaProcess()

function parseArgs(argv: string[]) {
  const args = { logPath: undefined as string | undefined, fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-path") args.logPath = argv[++i];
    else if (argv[i] === "--from-start") args.fromStart = true;
  }
  return args;
}

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

/**
 * Milestone 9+: the overlay's selectable sizes. `scale` is applied as the
 * renderer's root font-size (BASE_FONT_PX * scale) - overlay.css expresses
 * every dimension in rem off that root size, so the whole UI (text, life
 * totals, padding, everything) scales uniformly with it. `width`/`height`
 * are the actual BrowserWindow size at that scale, always exactly
 * BASE_WIDTH/BASE_HEIGHT * scale so the window frame matches the scaled
 * content pixel-for-pixel with no clipping or extra empty space. "Medium"
 * is the original (and still default) size from before this feature
 * existed, so nobody sees any change unless they open Settings.
 */
const BASE_FONT_PX = 10;
const BASE_WIDTH = 300;
const BASE_HEIGHT = 180;

const SIZE_PRESETS: Record<string, { label: string; scale: number; width: number; height: number }> = {
  small: { label: "Small", scale: 0.8, width: Math.round(BASE_WIDTH * 0.8), height: Math.round(BASE_HEIGHT * 0.8) },
  medium: { label: "Medium (default)", scale: 1, width: BASE_WIDTH, height: BASE_HEIGHT },
  large: { label: "Large", scale: 1.25, width: Math.round(BASE_WIDTH * 1.25), height: Math.round(BASE_HEIGHT * 1.25) },
  xlarge: { label: "Extra Large", scale: 1.5, width: Math.round(BASE_WIDTH * 1.5), height: Math.round(BASE_HEIGHT * 1.5) },
};
const DEFAULT_SIZE_PRESET = "medium";
const DEFAULT_OPACITY = 0.72; // matches the panel's original hardcoded background alpha
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;

/**
 * Milestone 13: card-thumbnail size for the deck viewer's "Visual" tab
 * (see deckViewerHtml.ts's DEFAULT_CARD_IMAGE_WIDTH_PX, which "medium"
 * matches exactly, so nobody sees any change unless they open Settings -
 * same "existing default stays default" convention as SIZE_PRESETS above).
 * Unlike the overlay's own size/opacity, this has nothing to "apply live" to
 * - the deck viewer is a static page regenerated fresh every time it's
 * opened (see open-deck-viewer below), so changing this just changes what
 * the *next* generated page uses.
 */
const CARD_SIZE_PRESETS: Record<string, { label: string; widthPx: number }> = {
  small: { label: "Small", widthPx: 90 },
  medium: { label: "Medium (default)", widthPx: 130 },
  large: { label: "Large", widthPx: 170 },
  xlarge: { label: "Extra Large", widthPx: 210 },
};
const DEFAULT_CARD_SIZE_PRESET = "medium";

interface OverlaySettings {
  sizePreset: string; // a key of SIZE_PRESETS
  opacity: number; // MIN_OPACITY..MAX_OPACITY
  cardSizePreset: string; // a key of CARD_SIZE_PRESETS - milestone 13
  autoCheckForUpdates: boolean; // milestone 15 - defaults to true; see the Settings window's "Updates" section
  // Milestone 18: manual overrides for a player whose Player.log/card
  // database isn't where auto-detection guesses (logLocator.ts/
  // cardDbLocator.ts's Windows paths are explicitly documented as
  // unconfirmed guesses - a friend on Windows is likely the first real
  // test of them). null means "keep auto-detecting" - the common case,
  // and what every existing settings file implicitly has. Changing
  // customLogPath requires a relaunch to take effect (the capture pipeline
  // only resolves its path once, at startup - see main() below);
  // customCardDbPath is re-read fresh on every "Refresh Card Database"
  // click, so it needs no relaunch.
  customLogPath: string | null;
  customCardDbPath: string | null;
}

function overlaySettingsPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "overlay-settings.json");
}

function loadOverlaySettings(): OverlaySettings {
  try {
    const raw = readFileSync(overlaySettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    const sizePreset = typeof parsed.sizePreset === "string" && parsed.sizePreset in SIZE_PRESETS ? parsed.sizePreset : DEFAULT_SIZE_PRESET;
    const opacity =
      typeof parsed.opacity === "number" && parsed.opacity >= MIN_OPACITY && parsed.opacity <= MAX_OPACITY ? parsed.opacity : DEFAULT_OPACITY;
    const cardSizePreset =
      typeof parsed.cardSizePreset === "string" && parsed.cardSizePreset in CARD_SIZE_PRESETS ? parsed.cardSizePreset : DEFAULT_CARD_SIZE_PRESET;
    // Milestone 15: tolerant-default like every other field here - an
    // older settings file from before this field existed (or a future one
    // this build doesn't understand) just falls back to "on" rather than
    // failing the whole parse, same convention as the rest of this loader.
    const autoCheckForUpdates = typeof parsed.autoCheckForUpdates === "boolean" ? parsed.autoCheckForUpdates : true;
    // Milestone 18: same tolerant-default convention as every field above -
    // an older settings file simply doesn't have these keys, which is
    // exactly "keep auto-detecting", not an error.
    const customLogPath = typeof parsed.customLogPath === "string" && parsed.customLogPath.length > 0 ? parsed.customLogPath : null;
    const customCardDbPath = typeof parsed.customCardDbPath === "string" && parsed.customCardDbPath.length > 0 ? parsed.customCardDbPath : null;
    return { sizePreset, opacity, cardSizePreset, autoCheckForUpdates, customLogPath, customCardDbPath };
  } catch {
    // No settings saved yet, or the file's unreadable/corrupt - fall back to the original look.
    return {
      sizePreset: DEFAULT_SIZE_PRESET,
      opacity: DEFAULT_OPACITY,
      cardSizePreset: DEFAULT_CARD_SIZE_PRESET,
      autoCheckForUpdates: true,
      customLogPath: null,
      customCardDbPath: null,
    };
  }
}

function saveOverlaySettings(settings: OverlaySettings): void {
  try {
    writeFileSync(overlaySettingsPath(), JSON.stringify(settings), "utf8");
  } catch {
    // Best-effort - losing the remembered settings isn't worth crashing over.
  }
}

/**
 * Milestone 8+: remembers the outcome of the last card-database refresh
 * (whichever session ran it) across relaunches, the same "small JSON file
 * under userData" pattern as the overlay position above - so the tray menu
 * can show "Cards refreshed <when>: <summary>" immediately on startup
 * rather than going blank until the user clicks refresh again.
 */
interface CardRefreshStatus {
  at: string; // ISO timestamp
  summary: string;
}

function cardRefreshStatusPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "card-refresh-status.json");
}

function loadCardRefreshStatus(): CardRefreshStatus | null {
  try {
    const raw = readFileSync(cardRefreshStatusPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.at === "string" && typeof parsed.summary === "string") return parsed;
  } catch {
    // No refresh recorded yet, or the file's unreadable/corrupt.
  }
  return null;
}

function saveCardRefreshStatus(status: CardRefreshStatus): void {
  try {
    writeFileSync(cardRefreshStatusPath(), JSON.stringify(status), "utf8");
  } catch {
    // Best-effort - losing the remembered status isn't worth crashing over.
  }
}

function notifyCardRefresh(summary: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title: "MTGA Tracker", body: summary }).show();
  } catch {
    // Notifications are a nice-to-have - the tray label and status file already carry this info either way.
  }
}

function formatLastCardRefreshLabel(status: CardRefreshStatus | null): string {
  if (!status) return "Cards: not refreshed yet";
  return `Cards refreshed ${new Date(status.at).toLocaleString()}: ${status.summary}`;
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let interactive = false; // false = click-through (default)
let overlayHidden = false; // milestone 11: whole-window show/hide, independent of click-through
let watchingStatus = "Starting...";
let refreshingCards = false;
let cardRefreshStatus: CardRefreshStatus | null = null;
let overlaySettings: OverlaySettings = {
  sizePreset: DEFAULT_SIZE_PRESET,
  opacity: DEFAULT_OPACITY,
  cardSizePreset: DEFAULT_CARD_SIZE_PRESET,
  autoCheckForUpdates: true,
  customLogPath: null,
  customCardDbPath: null,
};
// Set once the pipeline (and therefore its dataDir) exists, inside
// app.whenReady() below - kept as a module-level slot (rather than a
// closure captured directly by the tray's click handlers) so
// rebuildTrayMenu() can stay a plain top-level function like the rest of
// this file's UI wiring.
let runCardRefresh: ((skipEnrich: boolean) => void) | null = null;

/**
 * Milestone 15: remembers the outcome of the last version check across
 * relaunches - same "small JSON file under userData" pattern as
 * CardRefreshStatus above - so the tray can show "Update available" (or
 * just the current version) immediately on startup, before the first check
 * of this run has had a chance to run.
 */
interface UpdateCheckStatus {
  lastCheckedAt: string; // ISO timestamp
  latestVersion: string | null; // e.g. "0.2.0" - the tag of the repo's latest GitHub Release, or null if the last check failed/found none
  updateAvailable: boolean;
}

function updateCheckStatusPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "update-check-status.json");
}

function loadUpdateCheckStatus(): UpdateCheckStatus | null {
  try {
    const raw = readFileSync(updateCheckStatusPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.lastCheckedAt === "string" && typeof parsed.updateAvailable === "boolean") {
      const latestVersion = typeof parsed.latestVersion === "string" ? parsed.latestVersion : null;
      return { lastCheckedAt: parsed.lastCheckedAt, latestVersion, updateAvailable: parsed.updateAvailable };
    }
  } catch {
    // No check recorded yet, or the file's unreadable/corrupt.
  }
  return null;
}

function saveUpdateCheckStatus(status: UpdateCheckStatus): void {
  try {
    writeFileSync(updateCheckStatusPath(), JSON.stringify(status), "utf8");
  } catch {
    // Best-effort - losing the remembered status isn't worth crashing over.
  }
}

let updateCheckStatus: UpdateCheckStatus | null = null;
let checkingForUpdates = false;
// Milestone 15: edge-triggered state for checkArenaProcess() below - only
// fires a check on the not-running -> running transition, not on every poll.
let arenaWasRunning = false;

/**
 * Milestone 15: plain major.minor.patch comparison (ignoring any
 * pre-release/build suffix like "-beta") - good enough for "is the tag on
 * GitHub newer than the version I'm running", without pulling in a real
 * semver dependency for one comparison. A missing/non-numeric segment on
 * either side is treated as 0, so "v0.2" compares fine against "0.2.0".
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [c1, c2, c3] = parse(candidate);
  const [r1, r2, r3] = parse(current);
  if (c1 !== r1) return c1 > r1;
  if (c2 !== r2) return c2 > r2;
  return c3 > r3;
}

function notifyUpdateAvailable(latestVersion: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: "MTGA Tracker update available",
      body: `${latestVersion} is out (you have v${app.getVersion()}) - click to view it on GitHub.`,
    });
    n.on("click", () => {
      shell.openExternal(GITHUB_RELEASES_PAGE);
    });
    n.show();
  } catch {
    // The tray's "Update available" item (see rebuildTrayMenu) covers this either way.
  }
}

/**
 * Milestone 15: "check & notify", not a real auto-updater. This project has
 * no code-signing certificate or (on macOS) notarization set up, so an
 * unsigned auto-updater silently downloading and replacing its own binary
 * isn't something that can ship safely yet - Gatekeeper/SmartScreen exist
 * specifically to distrust that, and working around it would either fail
 * outright or train users to click through a real security warning, which
 * is worse than not having the feature. So this only ever compares
 * app.getVersion() (package.json's "version", baked in at build time)
 * against the tag of the repo's latest public GitHub Release
 * (GITHUB_RELEASES_API - no auth needed for a public repo's releases) and,
 * if newer, shows a native notification plus a tray item linking to the
 * releases page - actually updating is still a manual `git pull`/re-download
 * by the user. Fails silently on any network error (offline, rate limited,
 * or - very likely early on - no GitHub Release has been published yet at
 * all) since a background version check is a nice-to-have, never worth an
 * error dialog popping up mid-match. `showUpToDateNotification` is true only
 * for an explicit "Check for Updates Now" click (tray item or Settings
 * button) - the silent startup/periodic/Arena-launch triggers never notify
 * when there's nothing new, only when there is.
 */
async function checkForUpdates(
  showUpToDateNotification: boolean,
): Promise<{ ok: boolean; currentVersion: string; latestVersion: string | null; updateAvailable: boolean; error?: string }> {
  const currentVersion = app.getVersion();
  if (checkingForUpdates) {
    return {
      ok: false,
      currentVersion,
      latestVersion: updateCheckStatus?.latestVersion ?? null,
      updateAvailable: updateCheckStatus?.updateAvailable ?? false,
      error: "A check is already in progress.",
    };
  }
  checkingForUpdates = true;
  rebuildTrayMenu();
  try {
    const res = await fetch(GITHUB_RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) {
      throw new Error(res.status === 404 ? "No GitHub Release has been published for this repo yet." : `GitHub returned HTTP ${res.status}.`);
    }
    const json = (await res.json()) as { tag_name?: unknown };
    const tag = typeof json.tag_name === "string" ? json.tag_name : null;
    if (!tag) throw new Error("GitHub's response had no tag_name.");
    const updateAvailable = isNewerVersion(tag, currentVersion);
    updateCheckStatus = { lastCheckedAt: new Date().toISOString(), latestVersion: tag, updateAvailable };
    saveUpdateCheckStatus(updateCheckStatus);
    if (updateAvailable) {
      notifyUpdateAvailable(tag);
    } else if (showUpToDateNotification) {
      try {
        if (Notification.isSupported()) new Notification({ title: "MTGA Tracker", body: `You're up to date (v${currentVersion}).` }).show();
      } catch {
        // Notifications are a nice-to-have.
      }
    }
    return { ok: true, currentVersion, latestVersion: tag, updateAvailable };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("Update check failed:", reason);
    return {
      ok: false,
      currentVersion,
      latestVersion: updateCheckStatus?.latestVersion ?? null,
      updateAvailable: updateCheckStatus?.updateAvailable ?? false,
      error: reason,
    };
  } finally {
    checkingForUpdates = false;
    rebuildTrayMenu();
  }
}

/**
 * Milestone 15: best-effort "MTG Arena just launched" detection, for the
 * user's "checks for updates ... when MTG Arena is launched" ask - polls the
 * OS process list every ARENA_POLL_INTERVAL_MS for a process matching
 * Arena's usual executable name and fires exactly one update check on the
 * not-running -> running transition (never on every poll, and never again
 * while it's still running). The process name ("MTGA" on macOS/Linux,
 * "MTGA.exe" on Windows) is Arena's normal executable name, not something
 * this project has verified against a real running install on every
 * platform - worth double-checking in Activity Monitor/Task Manager while
 * Arena is open if this never seems to fire for you. Failing to detect
 * Arena at all is silently harmless either way - the startup and periodic
 * checks above still run regardless.
 */
function checkArenaProcess(): void {
  if (!overlaySettings.autoCheckForUpdates) return;
  const cmd = process.platform === "win32" ? `tasklist /FI "IMAGENAME eq MTGA.exe"` : `pgrep -f -i "MTGA"`;
  exec(cmd, { timeout: 5000 }, (err, stdout) => {
    const isRunning = process.platform === "win32" ? /MTGA\.exe/i.test(stdout) : !err && stdout.trim().length > 0;
    if (isRunning && !arenaWasRunning) {
      checkForUpdates(false).catch(() => {});
    }
    arenaWasRunning = isRunning;
  });
}

/**
 * Milestone 15: the simplest "feedback reaches my email" mechanism that
 * needs no backend, no new third-party account/service, and no secrets
 * shipped inside the app - opens the user's own default mail client with a
 * pre-filled mailto: link (subject plus app version/platform in the body,
 * so a report always carries the basics without the user having to
 * remember to add them). Nothing is transmitted by this app itself; the
 * user still has to hit send in their own mail app, same as clicking any
 * other mailto: link on a website.
 */
function sendFeedback(): void {
  const subject = `MTGA Tracker feedback (v${app.getVersion()})`;
  const body = `\n\n---\nApp version: ${app.getVersion()}\nPlatform: ${process.platform} (${process.arch})`;
  const mailto = `mailto:zmaceska@seznam.cz?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  shell.openExternal(mailto).catch((err) => {
    console.error("Could not open the default mail client for feedback:", err);
  });
}

function createWindow(settings: OverlaySettings): BrowserWindow {
  const preset = SIZE_PRESETS[settings.sizePreset] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
  const display = screen.getPrimaryDisplay();
  const saved = loadSavedPosition();
  const x = saved?.x ?? display.workArea.x + display.workArea.width - preset.width - 24;
  const y = saved?.y ?? display.workArea.y + 24;

  const win = new BrowserWindow({
    width: preset.width,
    height: preset.height,
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

/**
 * Milestone 9+: applies a (possibly just-changed) size/opacity choice to the
 * already-running overlay - persists it, resizes the actual window to the
 * new preset's dimensions (keeping its current top-left corner fixed, so it
 * grows/shrinks in place rather than jumping to a different part of the
 * screen), and pushes the resulting font-size + opacity to the overlay's
 * renderer so it takes effect immediately with no reload/flicker. Also used
 * once at startup (from within the did-finish-load handler below) to push
 * the settings loaded from disk, since the window is already created at the
 * right *size* by createWindow() but the renderer still needs telling what
 * font-size/opacity that corresponds to.
 */
function applyOverlaySettings(settings: OverlaySettings): void {
  overlaySettings = settings;
  saveOverlaySettings(settings);
  const preset = SIZE_PRESETS[settings.sizePreset] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
  if (mainWindow) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setBounds({ x, y, width: preset.width, height: preset.height });
    mainWindow.webContents.send("settings", { fontSizePx: BASE_FONT_PX * preset.scale, opacity: settings.opacity });
  }
}

function toggleInteractive(): void {
  if (!mainWindow) return;
  interactive = !interactive;
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  mainWindow.webContents.send("interactive-changed", interactive);
  rebuildTrayMenu();
}

/**
 * Milestone 11: shows/hides the overlay window outright - unrelated to
 * toggleInteractive() above, which only ever changes whether the window
 * *receives mouse events*; a click-through overlay is still fully visible.
 * Hiding here uses BrowserWindow.hide()/show() rather than tearing the
 * window down, so the capture pipeline, remembered position, and current
 * size/opacity settings are all completely unaffected - showing it again
 * just makes the exact same window reappear where it was.
 */
function toggleOverlayHidden(): void {
  if (!mainWindow) return;
  overlayHidden = !overlayHidden;
  if (overlayHidden) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
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
 * Milestone 9+: the small Settings window (size presets + a transparency
 * slider - see the file header for why this exists instead of more tray
 * items). Reuses the overlay's own preload.cjs (it exposes a second,
 * unrelated `settingsApi` alongside `overlay` - see that file's comment),
 * loads a separate static page, and is a singleton: a second click while
 * one's already open just focuses it rather than opening another.
 */
function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 340,
    height: 660, // milestone 18: grew again to fit the new "Locations" section below Updates
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "MTGA Tracker Settings",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(join(__dirname, "renderer", "settings.html"));
}

/**
 * Rebuilt (rather than mutated in place) every time something it reflects
 * changes - watching status, interactive/click-through state, the login
 * item setting, or a card refresh starting/finishing - since Electron's
 * Menu items don't update reactively once built. Everything that's just a
 * toggle or an action still lives directly in this tray menu; "Overlay
 * Settings..." (milestone 9+) is the one exception, opening the small
 * window above, because a continuous transparency slider isn't something a
 * native Tray context menu can host at all, on any platform.
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
    {
      label: "Hide Overlay",
      type: "checkbox",
      checked: overlayHidden,
      accelerator: "CommandOrControl+Shift+H",
      click: toggleOverlayHidden,
    },
    { label: "Overlay Settings... (size, transparency, card size)", click: openSettingsWindow },
    { type: "separator" },
    { label: formatLastCardRefreshLabel(cardRefreshStatus), enabled: false },
    {
      label: refreshingCards ? "Refreshing Cards..." : "Refresh Card Database",
      enabled: !refreshingCards,
      click: () => runCardRefresh?.(false),
    },
    {
      label: "Refresh Cards (Arena data only, no internet)",
      enabled: !refreshingCards,
      click: () => runCardRefresh?.(true),
    },
    { type: "separator" },
    { label: `MTGA Tracker v${app.getVersion()}`, enabled: false },
    ...(updateCheckStatus?.updateAvailable && updateCheckStatus.latestVersion
      ? [
          {
            label: `Update available: ${updateCheckStatus.latestVersion} (click to view on GitHub)`,
            click: () => {
              shell.openExternal(GITHUB_RELEASES_PAGE);
            },
          },
        ]
      : [
          {
            label: checkingForUpdates ? "Checking for updates..." : "Check for Updates Now",
            enabled: !checkingForUpdates,
            click: () => {
              checkForUpdates(true).catch(() => {});
            },
          },
        ]),
    { label: "Send Feedback...", click: sendFeedback },
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

/**
 * Milestone 19: CapturePipeline defaults its dataDir to <project root>/data
 * (see pipeline.ts) - correct for the CLI and for `npm run overlay` in dev,
 * where "project root" is a real, writable folder on disk. For a packaged
 * build, though, __dirname resolves to somewhere inside app.asar, which is
 * a single read-only archive file, not a real directory - confirmed by
 * directly attempting a write there (ENOTDIR). Left unfixed, every
 * packaged install would silently fail to persist tracker.db, the
 * cards-cache, deck-viewer output, and draft-progress output - a real
 * install has never actually been exercised against real gameplay before
 * this was caught, only launched and clicked through.
 *
 * Fix: when packaged, explicitly point dataDir at a "data" subfolder under
 * Electron's own userData directory (a real, writable, per-user location
 * electron-builder never touches) instead of the CapturePipeline default.
 * Left undefined in dev so `npm run overlay` keeps using the existing
 * project-root data/ folder unchanged (no migration needed for data you
 * already have there).
 */
function resolvePipelineDataDir(): string | undefined {
  return app.isPackaged ? join(app.getPath("userData"), "data") : undefined;
}

app.whenReady().then(() => {
  // Tray-only app - no dock icon, no window menu. All settings/quit live in
  // the tray's context menu (built below), plus the small Settings window
  // it can open (milestone 9+), instead.
  app.dock?.hide();

  overlaySettings = loadOverlaySettings();
  mainWindow = createWindow(overlaySettings);
  tray = createTray();

  const { logPath: argvLogPath, fromStart } = parseArgs(process.argv.slice(2));
  const logPath = argvLogPath ?? overlaySettings.customLogPath ?? undefined;
  const pipeline = new CapturePipeline({ logPath, fromStart, dataDir: resolvePipelineDataDir() });
  const liveState = new LiveStateTracker();
  // Rebuild win-rate/event-record history from previous runs before we ever
  // show anything - otherwise a relaunch shows every event's record as blank
  // (or wrong) until something new happens to re-report it, even though the
  // correct data was already sitting in tracker.db. See
  // LiveStateTracker.seedHistory's comment for the bug this fixes.
  liveState.seedHistory(pipeline.historyForSeeding());

  // Milestone 8+: pick up whatever the last card refresh (from this run or
  // an earlier one) reported, so the tray shows real info immediately
  // rather than "not refreshed yet" until the user clicks the button once.
  cardRefreshStatus = loadCardRefreshStatus();

  // Milestone 8+: "Refresh Card Database" tray action - the exact same
  // steps as `npm run refresh-cards` (see refreshCards.ts's own comment for
  // the full rationale), just run inline here and reported via a native
  // notification plus the persisted status line above instead of console
  // output, since there's no terminal to read here. Only one refresh runs
  // at a time (a second click while one's in flight is a no-op, and the
  // menu item is disabled/relabeled while running so this is also visible,
  // not just silently ignored).
  runCardRefresh = async (skipEnrich: boolean) => {
    if (refreshingCards) return;
    refreshingCards = true;
    rebuildTrayMenu();

    let store: CardStore | null = null;
    try {
      const located = locateCardDatabase(overlaySettings.customCardDbPath ?? undefined);
      if (!located.found || !located.path) {
        throw new Error("Could not find Arena's card database - make sure MTG Arena is installed and has been run at least once.");
      }
      const arenaCards = extractArenaCards(located.path);
      store = new CardStore(join(pipeline.dataDir, "tracker.db"));

      if (skipEnrich) {
        store.syncArenaData(arenaCards);
        const summary = `Synced ${arenaCards.length} cards from Arena (Scryfall lookup skipped).`;
        cardRefreshStatus = { at: new Date().toISOString(), summary };
        saveCardRefreshStatus(cardRefreshStatus);
        notifyCardRefresh(summary);
        return;
      }

      try {
        const { matchedCount, cards, downloaded } = await enrichCards(arenaCards, { dataDir: pipeline.dataDir });
        store.upsertMany(cards);
        const summary = `Synced ${arenaCards.length} cards, ${matchedCount} enriched from Scryfall (${downloaded ? "fresh download" : "cached data"}).`;
        cardRefreshStatus = { at: new Date().toISOString(), summary };
        saveCardRefreshStatus(cardRefreshStatus);
        notifyCardRefresh(summary);
      } catch (err) {
        // Same fallback as the CLI: if Scryfall is unreachable or errors,
        // still sync the Arena-side data (new set/rebalance names, at
        // least) rather than leaving the whole refresh empty-handed.
        store.syncArenaData(arenaCards);
        const reason = err instanceof Error ? err.message : String(err);
        const summary = `Synced ${arenaCards.length} cards from Arena; Scryfall enrichment failed (${reason}).`;
        cardRefreshStatus = { at: new Date().toISOString(), summary };
        saveCardRefreshStatus(cardRefreshStatus);
        notifyCardRefresh(summary);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("Card refresh failed:", err);
      notifyCardRefresh(`Card refresh failed: ${reason}`);
    } finally {
      store?.close();
      refreshingCards = false;
      rebuildTrayMenu();
    }
  };

  // Milestone 9+: Settings window IPC - reads/writes overlaySettings and
  // applies the result live via applyOverlaySettings() above. The Settings
  // window never hardcodes the preset list itself; it always renders
  // whatever get-overlay-settings hands back, so adding/renaming a preset
  // here is the only place that needs to change.
  ipcMain.handle("get-overlay-settings", () => {
    // Milestone 18: re-resolved fresh on every call (a cheap directory
    // scan for the card database, already-known for the log since the
    // pipeline resolved it once at startup) rather than cached, so the
    // Settings window always shows live status - e.g. if Arena's card
    // database file got renamed by a client update since this app launched.
    const cardDbStatus = locateCardDatabase(overlaySettings.customCardDbPath ?? undefined);
    return {
      sizePreset: overlaySettings.sizePreset,
      opacity: overlaySettings.opacity,
      presets: Object.entries(SIZE_PRESETS).map(([key, preset]) => ({ key, label: preset.label })),
      cardSizePreset: overlaySettings.cardSizePreset,
      cardSizePresets: Object.entries(CARD_SIZE_PRESETS).map(([key, preset]) => ({ key, label: preset.label })),
      // Milestone 15: the Settings window's "Updates" section.
      autoCheckForUpdates: overlaySettings.autoCheckForUpdates,
      appVersion: app.getVersion(),
      // Milestone 18: the "Locations" section - lets a player override
      // auto-detection when it guesses wrong (expected to be more common on
      // Windows, where these paths were never confirmed against a real
      // machine - see logLocator.ts/cardDbLocator.ts).
      logPath: {
        custom: overlaySettings.customLogPath,
        resolved: pipeline.located.path,
        found: pipeline.located.found,
      },
      cardDbPath: {
        custom: overlaySettings.customCardDbPath,
        resolved: cardDbStatus.path,
        found: cardDbStatus.found,
      },
    };
  });

  // Milestone 18: the capture pipeline only resolves Player.log's path once,
  // at startup (see CapturePipeline's constructor) - there's no live
  // "re-point the tailer" support, and adding one would mean touching the
  // same rotation-sensitive tailer code the milestone 5 log-rotation fix
  // depends on. A full app relaunch is simpler and safer: save the new
  // path, tell the renderer a restart is coming (so it isn't left looking
  // like nothing happened when the window vanishes), then relaunch on a
  // short delay so that response actually reaches the renderer first.
  function relaunchShortly(): void {
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
  }

  ipcMain.handle("choose-log-path", async () => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select your Player.log file",
      properties: ["openFile"],
    };
    const result = settingsWindow ? await dialog.showOpenDialog(settingsWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const chosen = result.filePaths[0];
    const check = locateLogFile(chosen);
    overlaySettings = { ...overlaySettings, customLogPath: chosen };
    saveOverlaySettings(overlaySettings);
    relaunchShortly();
    return { ok: true, path: chosen, found: check.found, willRestart: true };
  });

  ipcMain.handle("reset-log-path", () => {
    overlaySettings = { ...overlaySettings, customLogPath: null };
    saveOverlaySettings(overlaySettings);
    relaunchShortly();
    return { ok: true, willRestart: true };
  });

  ipcMain.handle("choose-card-db-path", async () => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select the folder containing Arena's Raw_CardDatabase_*.mtga file",
      properties: ["openDirectory"],
    };
    const result = settingsWindow ? await dialog.showOpenDialog(settingsWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const chosen = result.filePaths[0];
    const check = locateCardDatabase(chosen);
    overlaySettings = { ...overlaySettings, customCardDbPath: chosen };
    saveOverlaySettings(overlaySettings);
    return { ok: true, path: chosen, found: check.found, resolved: check.path };
  });

  ipcMain.handle("reset-card-db-path", () => {
    overlaySettings = { ...overlaySettings, customCardDbPath: null };
    saveOverlaySettings(overlaySettings);
    const check = locateCardDatabase();
    return { ok: true, found: check.found, resolved: check.path };
  });

  // Milestone 13: persists the deck viewer's "Visual" tab card-thumbnail
  // size choice. Nothing to push live (see CARD_SIZE_PRESETS's comment) -
  // just updates overlaySettings/overlay-settings.json so the next
  // open-deck-viewer call picks it up.
  ipcMain.handle("set-card-size-preset", (_event, presetKey: unknown) => {
    if (typeof presetKey !== "string" || !(presetKey in CARD_SIZE_PRESETS)) {
      return { ok: false, reason: "Unknown card size preset." };
    }
    overlaySettings = { ...overlaySettings, cardSizePreset: presetKey };
    saveOverlaySettings(overlaySettings);
    return { ok: true, sizePreset: overlaySettings.sizePreset, opacity: overlaySettings.opacity, cardSizePreset: overlaySettings.cardSizePreset };
  });

  ipcMain.handle("set-size-preset", (_event, presetKey: unknown) => {
    if (typeof presetKey !== "string" || !(presetKey in SIZE_PRESETS)) {
      return { ok: false, reason: "Unknown size preset." };
    }
    applyOverlaySettings({ ...overlaySettings, sizePreset: presetKey });
    return { ok: true, sizePreset: overlaySettings.sizePreset, opacity: overlaySettings.opacity };
  });

  ipcMain.handle("set-opacity", (_event, opacity: unknown) => {
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
      return { ok: false, reason: "Invalid opacity value." };
    }
    const clamped = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, opacity));
    applyOverlaySettings({ ...overlaySettings, opacity: clamped });
    return { ok: true, sizePreset: overlaySettings.sizePreset, opacity: overlaySettings.opacity };
  });

  // Milestone 15: the Settings window's "Updates" section - a plain on/off
  // toggle (persisted like every other overlay setting) plus an explicit
  // "Check Now" button. Nothing here ever installs anything - see
  // checkForUpdates's comment for why.
  ipcMain.handle("set-auto-check-updates", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      return { ok: false, reason: "Invalid value." };
    }
    overlaySettings = { ...overlaySettings, autoCheckForUpdates: enabled };
    saveOverlaySettings(overlaySettings);
    return { ok: true, autoCheckForUpdates: overlaySettings.autoCheckForUpdates };
  });

  ipcMain.handle("check-for-updates-now", () => checkForUpdates(true));

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
      const cardImageWidthPx = (CARD_SIZE_PRESETS[overlaySettings.cardSizePreset] ?? CARD_SIZE_PRESETS[DEFAULT_CARD_SIZE_PRESET]).widthPx;
      const data = buildDeckViewerData(currentEventId, store, cardStore, cardImageWidthPx);
      if (!data) return { ok: false, reason: `No deck/draft data captured yet for ${currentEventId}.` };

      const html = generateDeckViewerHtml({ ...data, appVersion: app.getVersion() });
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

  mainWindow.webContents.once("did-finish-load", () => {
    sendSnapshot();
    // Milestone 9+: the window was already created at the right *size* for
    // overlaySettings (createWindow used it directly), but the renderer
    // still needs telling what font-size/opacity that corresponds to -
    // this is that one-time initial push, mirroring what applyOverlaySettings
    // sends on every later change.
    const preset = SIZE_PRESETS[overlaySettings.sizePreset] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
    mainWindow?.webContents.send("settings", { fontSizePx: BASE_FONT_PX * preset.scale, opacity: overlaySettings.opacity });
  });

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
    // Milestone 18: "see console" was never actionable for a packaged app -
    // there's no console to see. The full checked-paths list still goes to
    // it for anyone who does have one open, but the tray label and a native
    // notification now both point at the one place a packaged-app user can
    // actually fix this: Overlay Settings' new "Locations" section, where
    // they can browse to their real Player.log if auto-detection guessed
    // wrong (expected to be more common on Windows - see logLocator.ts's
    // comment on why those paths are unconfirmed).
    watchingStatus = "Player.log not found - open Overlay Settings";
    console.error(`Could not find Player.log. Checked:\n  ${pipeline.located.checked.join("\n  ")}`);
    console.error("Make sure Options > Account > Detailed Logs (Plugin Support) is on, then relaunch Arena once.");
    if (Notification.isSupported()) {
      new Notification({
        title: "MTGA Tracker",
        body: "Couldn't find Player.log automatically. Open the tray menu's Overlay Settings to set its location manually.",
      }).show();
    }
  }
  rebuildTrayMenu();

  // Milestone 15: version-check triggers - once shortly after startup (so it
  // never competes with the "find Player.log"/tray setup above), then on a
  // fixed interval, then best-effort whenever Arena's own process looks like
  // it just launched. All three are silent (no "up to date" notification,
  // only "update available") and all three respect the Settings window's
  // "Automatically check for updates" toggle - see checkForUpdates's comment
  // for the full rationale (short version: never auto-installs, only ever
  // notifies).
  updateCheckStatus = loadUpdateCheckStatus();
  setTimeout(() => {
    if (overlaySettings.autoCheckForUpdates) checkForUpdates(false).catch(() => {});
  }, 8000);
  setInterval(() => {
    if (overlaySettings.autoCheckForUpdates) checkForUpdates(false).catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
  setInterval(checkArenaProcess, ARENA_POLL_INTERVAL_MS);

  globalShortcut.register("CommandOrControl+Shift+O", toggleInteractive);
  // Milestone 11: show/hide the whole overlay window, independent of the unlock/drag toggle above.
  globalShortcut.register("CommandOrControl+Shift+H", toggleOverlayHidden);
  // Quit shortcut since this app deliberately has no dock icon/menu bar to quit from otherwise
  // (also available from the tray menu).
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  console.log(watchingStatus);
  console.log(
    "Cmd/Ctrl+Shift+O: unlock to drag the overlay.  Cmd/Ctrl+Shift+H: hide/show the overlay.  Cmd/Ctrl+Shift+Q: quit.  Or use the tray icon's menu for all of these, plus Start at Login, Overlay Settings (size/transparency), and Refresh Card Database.",
  );

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
  // its only always-open BrowserWindow - closing it (which we never do
  // ourselves, but just in case), or closing the Settings window (which the
  // user does all the time), shouldn't kill the tray icon/capture pipeline.
});
