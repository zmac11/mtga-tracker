import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { CapturePipeline } from "../pipeline.js";
import { LibraryTracker } from "../domain/libraryTracker.js";
import { libraryFragmentHtml, type LibraryCardInfo } from "../libraryPanelHtml.js";
import { LiveStateTracker, type OverlaySnapshot } from "../domain/liveState.js";
import { TypedEventStore } from "../db/sqliteStore.js";
import { CardStore } from "../cards/cardStore.js";
import { locateCardDatabase } from "../cards/cardDbLocator.js";
import { locateLogFile } from "../log/logLocator.js";
import { extractArenaCards } from "../cards/extractArenaCards.js";
import { enrichCards } from "../cards/scryfallEnrich.js";
import { buildDeckViewerData } from "../deckViewerLoader.js";
import { generateDeckViewerHtml } from "../deckViewerHtml.js";
import { buildShareShellParts, generateDeckShareHtml, renderShareSectionHtml, type ShareDeckData } from "../deckShareHtml.js";
import { buildArenaImportText, type ArenaExportCardInfo } from "../domain/arenaExport.js";
import type { ViewerCard } from "../deckViewerHtml.js";
import { buildDraftProgressData } from "../draftProgressLoader.js";
import { draftBoardFragmentHtml, generateDraftProgressHtml, generateNoDraftInProgressHtml } from "../draftProgressHtml.js";
import { loadEventHistorySource } from "../eventHistoryLoader.js";
import { listEventRuns, buildEventRunHistory } from "../domain/eventHistory.js";
import { generatePastEventsHtml, type PastEventRow } from "../pastEventsHtml.js";
import { buildLimitedStatsRows, buildStatsCardCatalog, winRateOf } from "../domain/statsRollup.js";
import { generateStatsHtml } from "../statsHtml.js";
import { buildPickPriorityRows } from "../domain/draftPickPriority.js";
import { generateDraftPickStatsHtml, type DraftPickStatsRow } from "../draftPickStatsHtml.js";
import { computeMatchOutcomes, buildGameOutcomeIndex } from "../domain/rollups.js";
import { parseEventIdentity, resolveEventFormat } from "../domain/eventIdentity.js";
import { buildCardSituationalWinRateRows, type GameResultContext } from "../domain/cardSituationalWinRate.js";
import { generateCardSituationalWinRateHtml, type CardSituationalWinRateHtmlRow } from "../cardSituationalWinRateHtml.js";
import { compareTs } from "../domain/courseRuns.js";
import { computeRunStatuses, runStatusKey, describeRunStatus } from "../domain/runStatus.js";
import { buildOpponentMatchRows } from "../domain/opponentStats.js";
import { generateOpponentHtml } from "../opponentHtml.js";
import { buildEventRewardRows, summarizeOverallRewards } from "../domain/rewardHistory.js";
import { generateRewardHtml } from "../rewardHtml.js";
import { findPendingClosures } from "../domain/eventClosure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Milestone 19: an uncaught exception in the main process previously just
 * crashed the whole app - silently, with nothing to see unless you happened
 * to be watching a terminal. Confirmed as the real cause of a mid-event
 * crash (toggleInteractive() below, called via its global shortcut, after
 * mainWindow had already been destroyed - see that function's updated
 * isDestroyed() guard). This is a last-resort net, not a fix for any
 * specific bug: log it, tell the user via a notification instead of just
 * vanishing, and keep running - losing the overlay for one bad interaction
 * beats losing the rest of the event's tracking along with it.
 */
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (main process kept running):", err);
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "MTGA Tracker hit an error",
        body: "Something went wrong, but the tracker is still running. Check the tray menu if the overlay looks off.",
      }).show();
    }
  } catch {
    // Notifications are a nice-to-have - never let this handler itself throw.
  }
});

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

/**
 * 2026-10-02: overlay look. "default" is the original dark panel; "blue" is
 * the blue theme the menu button introduced, applied to the whole overlay.
 * Purely cosmetic - renderer-side CSS keyed off body[data-theme] (see
 * overlay.css); main.ts only persists the choice and pushes it.
 */
const OVERLAY_THEMES: Record<string, { label: string }> = {
  default: { label: "Default (dark)" },
  blue: { label: "Blue (matches the menu button)" },
};
const DEFAULT_OVERLAY_THEME = "default";

/**
 * Milestone 23: how much bigger the overlay window gets while a draft is
 * actively in progress, so the expanded draft-board panel (every pack seen
 * so far, picks made, colors taken) has real room to show instead of being
 * squeezed into the normal ~300x180 HUD - the user explicitly chose growing
 * the overlay itself over a separate page for this (see the milestone 23
 * design notes). Scaled by the user's chosen size preset the same way
 * BASE_WIDTH/BASE_HEIGHT are, so "Large"/"Extra Large" users get a
 * proportionally bigger draft board too, not a fixed add-on. Added on top
 * of (not instead of) the normal preset dimensions - the match/event-record
 * HUD content keeps its usual size and position, the draft board is extra
 * room alongside it.
 */
const DRAFT_BOARD_EXTRA_WIDTH = 280;
const DRAFT_BOARD_EXTRA_HEIGHT = 260;

/**
 * 2026-10-02: the in-game deck-list column (every card of your deck with
 * copies left in the library and the next-draw odds - see
 * domain/libraryTracker.ts). Like the draft board, the window grows to make
 * room for it while a game is being played, scaled by the size preset; the
 * extra height is what lets a whole limited/constructed decklist show
 * without scrolling.
 */
const LIBRARY_PANEL_EXTRA_WIDTH = 260;
const LIBRARY_PANEL_EXTRA_HEIGHT = 300;

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
  theme: string; // a key of OVERLAY_THEMES - 2026-10-02
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
    const theme = typeof parsed.theme === "string" && parsed.theme in OVERLAY_THEMES ? parsed.theme : DEFAULT_OVERLAY_THEME;
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
    return { sizePreset, theme, opacity, cardSizePreset, autoCheckForUpdates, customLogPath, customCardDbPath };
  } catch {
    // No settings saved yet, or the file's unreadable/corrupt - fall back to the original look.
    return {
      sizePreset: DEFAULT_SIZE_PRESET,
      theme: DEFAULT_OVERLAY_THEME,
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
  theme: DEFAULT_OVERLAY_THEME,
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
let runCardRefresh: ((skipEnrich: boolean, forceRefresh?: boolean) => void) | null = null;
// Milestone 19: same "module-level slot" pattern as runCardRefresh above -
// openPastEventsPage is defined inside app.whenReady() (it needs pipeline/
// overlaySettings, only available there), but rebuildTrayMenu() is a
// top-level function, so it reaches this via the slot rather than a direct
// reference.
let openPastEventsPage: (() => void) | null = null;
// 2026-10-02: the overlay's own menu button (see openOverlayMenu below) also
// offers the two things the overlay's rows already open (current event's
// deck, live draft progress) - assigned once the capture pipeline/live state
// they need exist, like the page openers above.
let openCurrentDeckViewer: (() => { ok: boolean; reason?: string }) | null = null;
let openDraftProgressPage: (() => void) | null = null;
// Milestone 20: same module-level slot pattern as openPastEventsPage above -
// openLimitedStatsPage is defined inside app.whenReady() (needs pipeline),
// but rebuildTrayMenu() is a top-level function.
let openLimitedStatsPage: (() => void) | null = null;
// Milestone 20: same module-level slot pattern as the two tray items above.
let openOpponentHistoryPage: (() => void) | null = null;
// Milestone 21: same module-level slot pattern as the tray items above.
let openRewardHistoryPage: (() => void) | null = null;
// Milestone 23 (feature d): same module-level slot pattern as the tray items above.
let openDraftPickStatsPage: (() => void) | null = null;
// Milestone 23 (features e/f): same module-level slot pattern as the tray items above.
let openCardSituationalWinRatePage: (() => void) | null = null;

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
    if (suppressPositionSave) return; // programmatic move (the menu opening near a screen edge) - not where the user put it
    const [wx, wy] = win.getPosition();
    // Dragged while grown (menu / draft board / deck-list column): that is
    // the user's new spot - remember it as the one to shrink back to.
    if (overlayMenuAnchor) overlayMenuAnchor = { x: wx, y: wy };
    savePosition(wx, wy);
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  win.loadFile(join(__dirname, "renderer", "overlay.html"));
  return win;
}

/**
 * Milestone 9+: applies a (possibly just-changed) size/opacity choice to the
 * already-running overlay - persists it and resizes the actual window (now
 * via applyWindowBounds() below, which also accounts for whether the draft
 * board is currently expanded - milestone 23). Also used once at startup
 * (from within the did-finish-load handler below) to push the settings
 * loaded from disk, since the window is already created at the right *size*
 * by createWindow() but the renderer still needs telling what
 * font-size/opacity that corresponds to.
 */

/**
 * Milestone 23: true while the overlay window is currently grown to show
 * the draft-board panel (see DRAFT_BOARD_EXTRA_WIDTH/HEIGHT above) - tracked
 * separately from overlaySettings itself since it's derived from whether a
 * draft is live right now, not a user preference that gets persisted.
 */
let overlayDraftExpanded = false;

/** 2026-10-02: true while the window is grown for the in-game deck-list column (see LIBRARY_PANEL_EXTRA_WIDTH). Derived from live game state, not a persisted setting. */
let overlayLibraryExpanded = false;

/**
 * Milestone 23: applies the current overlaySettings (size preset) AND the
 * current overlayDraftExpanded state to the already-running window in one
 * place - pulled out of applyOverlaySettings below so setOverlayDraftExpanded
 * can resize the window the same way a Settings-window size change does,
 * without duplicating the setBounds/font-size-push logic. Keeps the window's
 * current top-left corner fixed (same as the original behavior) so it
 * grows/shrinks in place rather than jumping to a different part of the
 * screen.
 */
function applyWindowBounds(): void {
  const preset = SIZE_PRESETS[overlaySettings.sizePreset] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
  let width = preset.width;
  let height = preset.height;
  if (overlayDraftExpanded) {
    width += Math.round(DRAFT_BOARD_EXTRA_WIDTH * preset.scale);
    height += Math.round(DRAFT_BOARD_EXTRA_HEIGHT * preset.scale);
  } else if (overlayLibraryExpanded) {
    width += Math.round(LIBRARY_PANEL_EXTRA_WIDTH * preset.scale);
    height += Math.round(LIBRARY_PANEL_EXTRA_HEIGHT * preset.scale);
  }
  if (overlayMenuOpen) {
    width = Math.max(width, Math.round(OVERLAY_MENU_WIDTH * preset.scale));
    height = Math.max(height, Math.round(OVERLAY_MENU_HEIGHT * preset.scale));
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    let [x, y] = mainWindow.getPosition();
    const grown = width > preset.width || height > preset.height;
    if (grown) {
      // Grow from the normal top-left, nudged back on-screen if the bigger
      // window would overflow the display (the overlay lives near the right
      // edge by default); shrinking back restores the original spot.
      if (!overlayMenuAnchor) overlayMenuAnchor = { x, y };
      const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
      x = Math.max(area.x, Math.min(overlayMenuAnchor.x, area.x + area.width - width));
      y = Math.max(area.y, Math.min(overlayMenuAnchor.y, area.y + area.height - height));
    } else if (overlayMenuAnchor) {
      x = overlayMenuAnchor.x;
      y = overlayMenuAnchor.y;
      overlayMenuAnchor = null;
    }
    suppressPositionSave = true;
    mainWindow.setBounds({ x, y, width, height });
    setTimeout(() => {
      suppressPositionSave = false;
    }, 400);
    mainWindow.webContents.send("settings", { fontSizePx: BASE_FONT_PX * preset.scale, opacity: overlaySettings.opacity, theme: overlaySettings.theme });
  }
}

/**
 * Milestone 23: grows/shrinks the overlay window when a draft starts/ends -
 * a no-op if the expanded state isn't actually changing (so this is safe to
 * call on every snapshot without resizing on every single domain event).
 */
function setOverlayDraftExpanded(expanded: boolean): void {
  if (expanded === overlayDraftExpanded) return;
  overlayDraftExpanded = expanded;
  applyWindowBounds();
}

/** 2026-10-02: grows/shrinks the overlay for the in-game deck-list column; a no-op when nothing changes (safe to call on every update). */
function setOverlayLibraryExpanded(expanded: boolean): void {
  if (expanded === overlayLibraryExpanded) return;
  overlayLibraryExpanded = expanded;
  applyWindowBounds();
}

function applyOverlaySettings(settings: OverlaySettings): void {
  overlaySettings = settings;
  saveOverlaySettings(settings);
  applyWindowBounds();
}

function toggleInteractive(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  interactive = !interactive;
  overlayHotspotClickable = false;
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
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
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

/**
 * The tray menu's contents, as a template - shared by the tray itself and by
 * the overlay's own menu button (openOverlayMenu below), so the two can never
 * drift apart.
 */
function buildMenuTemplate(): MenuItemConstructorOptions[] {
  return [
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
    { label: "Past Events...", click: () => openPastEventsPage?.() },
    { label: "Limited Stats...", click: () => openLimitedStatsPage?.() },
    { label: "Opponent History...", click: () => openOpponentHistoryPage?.() },
    { label: "Reward History...", click: () => openRewardHistoryPage?.() },
    { label: "Draft Pick Stats...", click: () => openDraftPickStatsPage?.() },
    { label: "Card Situational Win Rate...", click: () => openCardSituationalWinRatePage?.() },
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
    {
      /**
       * Milestone 23 (user-reported bug, 2026-10-01): "game does not load
       * scryfall card data from newest set" - root cause found while
       * investigating a real example (Campus Crier, set FRA/"Reality
       * Fracture", which released on Arena right around this same date -
       * see scryfallEnrich.ts's cache comment). "Refresh Card Database"
       * above (runCardRefresh(false)) always calls enrichCards with NO
       * forceRefresh, so it silently re-scans the existing local Scryfall
       * cache whenever that cache is under 20 hours old (isCacheFresh) -
       * exactly the case for anyone who had already refreshed recently
       * (including during a set's prerelease period) before the new set's
       * cards actually showed up in Scryfall's own default_cards snapshot.
       * There was previously no way to force a real re-download from the
       * tray at all - only refreshCards.ts's CLI script ever exposed
       * --force-refresh. This item is that same option, now reachable
       * without a terminal.
       */
      label: "Force Refresh from Scryfall (ignore cache)",
      enabled: !refreshingCards,
      click: () => runCardRefresh?.(false, true),
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
  ];
}

/**
 * 2026-10-02: "a menu icon directly on the overlay so I can open stuff easily
 * from MTG Arena." The overlay is click-through (so it never gets in the way of
 * the game), and its clickable spots - the menu button, plus the current-event
 * and draft rows - work in locked mode too:
 *
 * The renderer (overlay-renderer.js) reports where those spots are, and main
 * polls the real cursor position against them a few times a second, flipping
 * the window between click-through and clickable. (The first version relied on
 * the page receiving forwarded mouse-move events instead, which never worked
 * reliably - over the panel's window-drag region, and not at all on some
 * platforms.) Everything else on the overlay still lets clicks fall through to
 * Arena.
 */
let overlayHotspots: Array<{ x: number; y: number; width: number; height: number }> = [];
let overlayHotspotClickable = false;
let overlayHotspotTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The menu itself is drawn INSIDE the overlay window (the same entries as the
 * tray, as a list in overlay.html's #menu-panel), not as a native popup: a
 * native menu doesn't reliably show above Arena when it's fullscreen (found
 * 2026-10-02), while the overlay window already does. The window grows to make
 * room while the menu is open, like the draft board (applyWindowBounds), and
 * closes itself after the cursor has been away from it for a moment - clicks
 * outside the window go to Arena, which can't tell us to close it.
 */
const OVERLAY_MENU_WIDTH = 320;
const OVERLAY_MENU_HEIGHT = 470;
const OVERLAY_MENU_AWAY_CLOSE_MS = 1500;
let overlayMenuOpen = false;
let overlayMenuAnchor: { x: number; y: number } | null = null;
let overlayMenuAwaySince: number | null = null;
let overlayMenuActions = new Map<number, () => void>();
let suppressPositionSave = false;

interface OverlayMenuEntry {
  id: number;
  kind: "item" | "checkbox" | "separator";
  label: string;
  checked: boolean;
  enabled: boolean;
  hint: string;
}

function acceleratorHint(accelerator: unknown): string {
  return typeof accelerator === "string" ? accelerator.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl").replace(/\+/g, "+") : "";
}

/** The tray's menu plus two shortcuts, flattened for the renderer; clicks are looked up by id (overlayMenuActions). */
function buildOverlayMenuModel(): OverlayMenuEntry[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Current Event Deck",
      click: () => {
        const result = openCurrentDeckViewer?.();
        if (result && !result.ok && Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: result.reason ?? "Couldn't open the current deck." }).show();
        }
      },
    },
    { label: "Live Draft Progress", click: () => openDraftProgressPage?.() },
    { type: "separator" },
    ...buildMenuTemplate(),
  ];
  overlayMenuActions = new Map();
  let nextId = 0;
  return template.map((t): OverlayMenuEntry => {
    if (t.type === "separator") return { id: -1, kind: "separator", label: "", checked: false, enabled: false, hint: "" };
    const id = nextId++;
    const click = t.click as unknown as ((...args: unknown[]) => void) | undefined;
    const enabled = t.enabled !== false && typeof click === "function";
    if (enabled && click) overlayMenuActions.set(id, () => click(undefined, undefined, undefined));
    return {
      id,
      kind: t.type === "checkbox" ? "checkbox" : "item",
      label: String(t.label ?? ""),
      checked: t.checked === true,
      enabled,
      hint: acceleratorHint(t.accelerator),
    };
  });
}

function openOverlayMenu(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  overlayMenuOpen = true;
  overlayMenuAwaySince = null;
  applyWindowBounds();
  mainWindow.setIgnoreMouseEvents(false);
  overlayHotspotClickable = true;
  mainWindow.webContents.send("overlay-menu", { open: true, entries: buildOverlayMenuModel() });
}

function closeOverlayMenu(): void {
  if (!overlayMenuOpen) return;
  overlayMenuOpen = false;
  overlayMenuAwaySince = null;
  overlayHotspotClickable = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay-menu", { open: false, entries: [] });
    applyWindowBounds(); // shrinks back and restores the pre-menu position
    if (!interactive) mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function updateOverlayHotspotState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = mainWindow.getContentBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;

  if (overlayMenuOpen) {
    const inWindow = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
    if (inWindow) {
      overlayMenuAwaySince = null;
    } else if (overlayMenuAwaySince === null) {
      overlayMenuAwaySince = Date.now();
    } else if (Date.now() - overlayMenuAwaySince > OVERLAY_MENU_AWAY_CLOSE_MS) {
      closeOverlayMenu();
    }
    return; // the whole window is clickable while the menu is up
  }
  if (interactive) return; // unlocked = clickable everywhere already

  const inside = overlayHotspots.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
  if (inside === overlayHotspotClickable) return;
  overlayHotspotClickable = inside;
  mainWindow.setIgnoreMouseEvents(!inside, { forward: true });
}

function startOverlayHotspotWatcher(): void {
  if (overlayHotspotTimer) return;
  overlayHotspotTimer = setInterval(updateOverlayHotspotState, 60);
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

/**
 * Milestone 19: Electron does not prevent a second copy of the app from
 * launching on its own - nothing here ever asked it to. Confirmed as a
 * real, already-happened problem: two running copies both tail the same
 * Player.log and both independently receive Arena's EventGetCoursesV2
 * responses, so both append their own copy of the same CourseStanding to
 * the shared tracker.db - visible directly in the data as near-identical
 * rows a few seconds apart. Two copies also fight over the same global
 * shortcuts and tray icon. requestSingleInstanceLock() is Electron's
 * standard fix: the second launch gets refused the lock and exits
 * immediately (before creating any window, tray icon, or shortcut - see
 * app.exit() below, which unlike app.quit() stops execution right here
 * rather than continuing through the rest of this file first), and the
 * *first* instance is told about the attempt via "second-instance" so it
 * can bring its own window forward instead of the user wondering why
 * nothing happened.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "MTGA Tracker", body: "MTGA Tracker is already running." }).show();
    }
  } catch {
    // Notifications are a nice-to-have.
  }
});

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

  // Milestone 25: "I missed a few matches because the tracker was off -
  // can it check for that on startup?" Runs on every launch, found-or-not:
  // a no-op if Player.log isn't there, and matches already in tracker.db
  // are always skipped rather than re-appended (see
  // CapturePipeline.catchUpFromLog's own comment), so there's no harm in
  // doing this unconditionally rather than guessing whether something was
  // missed. Deliberately happens before seedHistory() below, so a relaunch
  // right after a gap shows the recovered match(es) from its very first
  // render instead of needing a second relaunch.
  try {
    const caughtUp = pipeline.catchUpFromLog();
    if (caughtUp.newMatchIds.length > 0) {
      console.log(`Recovered ${caughtUp.newMatchIds.length} match(es) missed while the tracker was off: ${caughtUp.newMatchIds.join(", ")}`);
      if (Notification.isSupported()) {
        new Notification({
          title: "MTGA Tracker",
          body:
            caughtUp.newMatchIds.length === 1
              ? "Recovered 1 match from the log that was missed while the tracker was off."
              : `Recovered ${caughtUp.newMatchIds.length} matches from the log that were missed while the tracker was off.`,
        }).show();
      }
    }
  } catch (err) {
    // Best-effort recovery feature - never let it block the app from
    // starting its normal live capture below.
    console.error("Catch-up from log failed:", err);
  }

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
  runCardRefresh = async (skipEnrich: boolean, forceRefresh = false) => {
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
        // forceRefresh bypasses isCacheFresh's 20-hour window entirely -
        // see the "Force Refresh from Scryfall" tray item's own comment
        // for why this needed its own button rather than relying on the
        // normal refresh ever reaching Scryfall again on its own.
        const { matchedCount, cards, downloaded } = await enrichCards(arenaCards, { dataDir: pipeline.dataDir, forceRefresh });
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
      theme: overlaySettings.theme,
      themes: Object.entries(OVERLAY_THEMES).map(([key, t]) => ({ key, label: t.label })),
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

  // Milestone 25: the Settings window's "Unfinished Events" section - see
  // domain/eventClosure.ts for what counts as pending and why. Recomputed
  // fresh on every call (cheap - the same read loadEventHistorySource
  // already does for every report page) rather than cached, so a run that
  // gets superseded or resolved while Settings happens to be open shows up
  // correctly without needing to reopen the window.
  ipcMain.handle("get-pending-event-closures", () => {
    return findPendingClosures(pipeline.loadHistorySource());
  });

  ipcMain.handle("submit-manual-event-result", (_event, payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return { ok: false, reason: "Invalid request." };
    const { eventId, courseId, wins, losses } = payload as Record<string, unknown>;
    if (typeof eventId !== "string" || eventId.length === 0) return { ok: false, reason: "Invalid event." };
    if (typeof wins !== "number" || typeof losses !== "number" || !Number.isFinite(wins) || !Number.isFinite(losses) || wins < 0 || losses < 0) {
      return { ok: false, reason: "Enter a valid win/loss count." };
    }
    pipeline.recordManualCourseResult(eventId, typeof courseId === "string" ? courseId : null, Math.round(wins), Math.round(losses));
    return { ok: true };
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

  ipcMain.handle("set-overlay-theme", (_event, themeKey: unknown) => {
    if (typeof themeKey !== "string" || !(themeKey in OVERLAY_THEMES)) {
      return { ok: false, reason: "Unknown overlay theme." };
    }
    applyOverlaySettings({ ...overlaySettings, theme: themeKey });
    return { ok: true, theme: overlaySettings.theme };
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
  // feature-roadmap-milestone7.md.
  //
  // Milestone 19: pulled the generate-and-write part out into its own
  // helper (writeDeckViewerPage below) so openPastEventsPage can reuse it
  // for every past run, not just the current one - "I want to be able to
  // open even previous events and decks I played" (2026-09-30). Each call
  // still opens fresh, short-lived TypedEventStore/CardStore connections
  // rather than sharing the pipeline's - this is a one-shot read-then-close
  // on click, not something that needs to stay open, and keeping it
  // separate avoids any risk of interfering with the pipeline's own
  // long-lived connection.
  function writeDeckViewerPage(eventId: string, store: TypedEventStore, cardStore: CardStore, courseId?: string | null): { ok: true; outPath: string; fileName: string; shareFileName: string } | { ok: false; reason: string } {
    const cardImageWidthPx = (CARD_SIZE_PRESETS[overlaySettings.cardSizePreset] ?? CARD_SIZE_PRESETS[DEFAULT_CARD_SIZE_PRESET]).widthPx;
    const data = buildDeckViewerData(eventId, store, cardStore, cardImageWidthPx, courseId);
    if (!data) return { ok: false, reason: `No deck/draft data captured yet for ${eventId}.` };

    const outDir = join(pipeline.dataDir, "deck-viewer");
    mkdirSync(outDir, { recursive: true });
    // Milestone 19: courseId-suffixed filename only when one was actually
    // passed (a real, disambiguated run - see buildDeckViewerData's own
    // comment) - the ordinary single-course case keeps its original,
    // stable filename exactly as before.
    const baseName = courseId ? `${eventId.replace(/[^A-Za-z0-9_-]/g, "_")}__${courseId.replace(/[^A-Za-z0-9_-]/g, "_")}` : `${eventId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const fileName = `${baseName}.html`;
    const outPath = join(outDir, fileName);

    // Milestone 22: alongside the normal (tracker-only) deck-viewer page,
    // also write a "share" sibling - a single self-contained page anyone
    // can open (tracker installed or not), linked from the normal page's
    // own header. Built from a setCode/collectorNumber lookup over the
    // whole card catalog (ViewerCard itself doesn't carry those fields -
    // see domain/arenaExport.ts's header comment for why).
    const cardInfo = new Map<number, ArenaExportCardInfo>();
    for (const c of cardStore.all()) cardInfo.set(c.grpId, { setCode: c.setCode, collectorNumber: c.collectorNumber });
    const arenaImportText = buildArenaImportText(data.mainDeck, data.sideboard, cardInfo);
    const shareData: ShareDeckData = {
      eventId: data.eventId,
      format: data.format,
      definitionLabel: data.definitionLabel,
      deckName: data.deckName,
      colorCombo: data.colorCombo,
      splashColors: data.splashColors,
      winRate: data.winRate,
      mainDeck: data.mainDeck,
      sideboard: data.sideboard,
      cardImageWidthPx: data.cardImageWidthPx,
      avgManaValue: data.avgManaValue,
      entry: data.entry,
      reward: data.reward,
      runLabel: data.runLabel,
      arenaImportText,
      appVersion: app.getVersion(),
    };
    const shareFileName = `${baseName}.share.html`;
    writeFileSync(join(outDir, shareFileName), generateDeckShareHtml(shareData), "utf8");

    const html = generateDeckViewerHtml({ ...data, appVersion: app.getVersion(), shareFileName });
    writeFileSync(outPath, html, "utf8");
    return { ok: true, outPath, fileName, shareFileName };
  }

  openCurrentDeckViewer = () => {
    const currentEventRecord = liveState.snapshot().eventRecord;
    const currentEventId = currentEventRecord?.eventId;
    if (!currentEventId) return { ok: false, reason: "No current event to show yet." };

    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      // Milestone 19: pass the live snapshot's own resolved courseId
      // through (null in the ordinary case) so this opens the SAME course
      // the overlay's tile currently describes, not just whichever course
      // happens to share this eventId - see liveState.ts/courseRuns.ts.
      const result = writeDeckViewerPage(currentEventId, store, cardStore, currentEventRecord?.courseId ?? null);
      if (!result.ok) return result;
      shell.openPath(result.outPath);
      return { ok: true };
    } catch (err) {
      console.error("Failed to generate/open deck viewer:", err);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      store?.close();
      cardStore?.close();
    }
  };
  ipcMain.handle("open-deck-viewer", () => openCurrentDeckViewer!());

  /**
   * Milestone 19: "I want to be able to open even previous events and decks
   * I played" (2026-09-30) - the tray's "Past Events..." item. Generates
   * (or refreshes) every known run's own deck-viewer page via
   * writeDeckViewerPage above, then a plain index page (pastEventsHtml.ts)
   * linking to each one, and opens the index. Same one-shot fresh-
   * connection approach as open-deck-viewer.
   *
   * Milestone 19 follow-up (2026-09-30): listEventRuns now yields one
   * entry per courseId whenever Arena reused an eventId across more than
   * one genuinely separate course (confirmed in this user's own data - a
   * completed 4-3 Sealed run and a later, separate 0-0 run both under
   * "Sealed_FRA_20260929", different courseId each time - see
   * domain/courseRuns.ts). Passing each entry's courseId through to
   * writeDeckViewerPage/buildEventRunHistory below gets that course's own
   * data, and its own distinctly-named page, instead of the old blend.
   */
  openPastEventsPage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);
      const knownRuns = listEventRuns(source);
      const runStatuses = computeRunStatuses(source, knownRuns);

      const rows: PastEventRow[] = [];
      for (const run of knownRuns) {
        const written = writeDeckViewerPage(run.eventId, store, cardStore, run.courseId);
        if (!written.ok) continue; // shouldn't happen for a listed run, but never let one bad run break the whole index
        const history = buildEventRunHistory(run.eventId, source, run.courseId);
        const status = runStatuses.get(runStatusKey(run.eventId, run.courseId));
        rows.push({
          finished: status?.finished ?? false,
          statusLabel: status ? describeRunStatus(status) : "In progress",
          eventId: run.eventId,
          identity: run.identity,
          format: history.format,
          deckName: history.deck?.deckName ?? null,
          winRate: history.winRate,
          fileName: written.fileName,
          courseId: run.courseId,
          runLabel: history.courseId
            ? `run started ${history.runStartedAt ? new Date(history.runStartedAt).toLocaleString() : "an unknown time"}`
            : null,
        });
      }

      const html = generatePastEventsHtml(rows);
      const outDir = join(pipeline.dataDir, "deck-viewer");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "index.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open past events page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Past Events - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  /**
   * Milestone 20 (2026-09-30): "search which opponents I have played
   * against and winrate against them - option to filter them by format
   * and search games and deck which I played vs them" - the tray's
   * "Opponent History..." item. Builds one OpponentMatchRow per match
   * (across every format, not just limited - see domain/opponentStats.ts)
   * and renders it as a static page whose search/filter/opponent-detail
   * view is entirely client-side JS (see opponentHtml.ts), same
   * self-contained-page convention as Limited Stats above.
   */
  openOpponentHistoryPage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);
      const rows = buildOpponentMatchRows(source);

      const html = generateOpponentHtml(rows);
      const outDir = join(pipeline.dataDir, "opponents");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "opponent-history.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open opponent history page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Opponent History - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  /**
   * Milestone 21 (2026-10-01): "layout of event rewards - button in
   * settings -> layout where I can filter for events by format, set and
   * see rewards earned. Also I want to track overall rewards from quests
   * etc." - the tray's "Reward History..." item (see rewardHtml.ts's own
   * header for why this is a tray item rather than literally inside the
   * Settings window). Builds one EventRewardRow per event run (entry cost
   * + prize claim, reusing eventHistory.ts's own .entry/.reward - no new
   * capture needed for that half) plus the account-wide
   * OverallRewardSummary (the new generic RewardGrant ledger - see
   * domain/rewardHistory.ts and RewardGrant's doc comment in types.ts for
   * the "quests etc." = Mastery Pass mapping), same self-contained-page
   * convention as Opponent History above.
   */
  openRewardHistoryPage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);
      const rows = buildEventRewardRows(source);
      const overall = summarizeOverallRewards(source.rewardGrants);

      const html = generateRewardHtml(rows, overall);
      const outDir = join(pipeline.dataDir, "rewards");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "reward-history.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open reward history page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Reward History - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  /**
   * Milestone 20 (2026-09-30): "Add some kind of filter for event types and
   * set for limited formats. Also add deck color filter. Show winrates for
   * such specific filter." - the tray's "Limited Stats..." item. Builds
   * one LimitedStatsRow per limited (Draft/Sealed) event run (see
   * domain/statsRollup.ts - reuses the same listEventRuns/
   * buildEventRunHistory this file's openPastEventsPage already calls, so
   * a courseId-collided eventId is already split into its own row here
   * too) and renders them into one static page whose filter UI is entirely
   * client-side JS (see statsHtml.ts) - no new IPC surface, no
   * re-generation needed to try a different filter.
   */
  openLimitedStatsPage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);
      const cardColors = new Map<number, string[]>();
      const cardsById = new Map<number, { name: string; colors: string[] }>();
      // Milestone 22: also keyed for two more things the per-row "export
      // filtered decks" share fragment below needs that the trimmed
      // name/colors map above doesn't carry - the full ViewerCard shape
      // (types/manaCost/oracleText/imageNormal, for the Visual tab's card
      // grid) and the setCode/collectorNumber lookup domain/arenaExport.ts
      // needs for the Arena-import text. One pass over the catalog builds
      // all three maps at once rather than three separate passes.
      const cardInfoById = new Map<number, { name: string; colors: string[]; types: string[]; manaCost: string | null; oracleText: string | null; imageNormal: string | null }>();
      const arenaLookup = new Map<number, ArenaExportCardInfo>();
      for (const c of cardStore.all()) {
        cardColors.set(c.grpId, c.colors);
        cardsById.set(c.grpId, { name: c.name, colors: c.colors });
        cardInfoById.set(c.grpId, { name: c.name, colors: c.colors, types: c.types, manaCost: c.manaCost, oracleText: c.oracleText, imageNormal: c.imageNormal });
        arenaLookup.set(c.grpId, { setCode: c.setCode, collectorNumber: c.collectorNumber });
      }
      const toViewerCards = (entries: Array<{ cardId: number; quantity: number }>): ViewerCard[] =>
        entries.map((e) => {
          const info = cardInfoById.get(e.cardId);
          return {
            cardId: e.cardId,
            quantity: e.quantity,
            name: info?.name ?? `Unknown card #${e.cardId}`,
            colors: info?.colors ?? [],
            types: info?.types ?? [],
            manaCost: info?.manaCost ?? null,
            oracleText: info?.oracleText ?? null,
            imageNormal: info?.imageNormal ?? null,
          };
        });

      const rows = buildLimitedStatsRows(source, cardColors);
      // Milestone 20 follow-up: "I want to be able to open decks from
      // limited filter" - write (or refresh) each row's own deck-viewer
      // page via the same shared writeDeckViewerPage helper
      // openPastEventsPage already uses, and attach its filename so
      // statsHtml.ts can link straight to it. A row whose write fails
      // (shouldn't happen for a listed run, but never let one bad run
      // break the whole page) just keeps its default null - statsHtml.ts
      // already renders the deck name as plain text in that case.
      //
      // Milestone 22: also pre-render each row's own "export filtered
      // decks" share fragment (same visual layout as the single-deck
      // share page, just the inner section - see deckShareHtml.ts's
      // header comment) here, server-side, once - a row with no deck
      // captured at all (empty mainDeck) gets null, same "just omit it"
      // convention as deckViewerFileName right above it.
      const linkedRows = rows.map((row) => {
        const written = writeDeckViewerPage(row.eventId, store!, cardStore!, row.courseId);
        const mainDeckViewerCards = toViewerCards(row.mainDeck);
        const shareFragmentHtml =
          mainDeckViewerCards.length > 0
            ? renderShareSectionHtml({
                eventId: row.eventId,
                format: row.format,
                definitionLabel: row.definitionLabel,
                deckName: row.deckName,
                colorCombo: row.colorCombo,
                splashColors: row.splashColors,
                winRate: winRateOf([{ wins: row.wins, losses: row.losses }]),
                mainDeck: mainDeckViewerCards,
                sideboard: null,
                arenaImportText: buildArenaImportText(mainDeckViewerCards, null, arenaLookup),
              })
            : null;
        return { ...row, deckViewerFileName: written.ok ? written.fileName : null, shareFragmentHtml };
      });
      const cardCatalog = buildStatsCardCatalog(linkedRows, cardsById);
      const shareShell = buildShareShellParts("Shared decks - MTGA Tracker");

      const html = generateStatsHtml(linkedRows, cardCatalog, shareShell);
      const outDir = join(pipeline.dataDir, "stats");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "limited-stats.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open limited stats page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Limited Stats - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  /**
   * Milestone 23 (feature d): "in settings there should be a draft filter
   * button to view such draft data" - the tray's "Draft Pick Stats..."
   * item. Dataset-wide (every draft ever captured, not just one run) -
   * reuses the same loadEventHistorySource this file's openLimitedStatsPage
   * already calls for its picks/packsSeen fields, feeds them through
   * domain/draftPickPriority.ts's buildPickPriorityRows, and joins in
   * name/colors from the card catalog before rendering the static,
   * client-side-filtered page (draftPickStatsHtml.ts) - same
   * self-contained-page/no-new-IPC-surface convention as Limited Stats.
   */
  openDraftPickStatsPage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);
      const priorityRows = buildPickPriorityRows(source.picks, source.packsSeen);
      const cardsById = new Map<number, { name: string; colors: string[] }>();
      for (const c of cardStore.all()) cardsById.set(c.grpId, { name: c.name, colors: c.colors });
      const rows: DraftPickStatsRow[] = priorityRows.map((r) => {
        const info = cardsById.get(r.grpId);
        return {
          cardId: r.grpId,
          name: info?.name ?? `Unknown card #${r.grpId} (run npm run refresh-cards)`,
          colors: info?.colors ?? [],
          timesPicked: r.timesPicked,
          avgOthersInPack: r.avgOthersInPack,
          minOthersInPack: r.minOthersInPack,
          maxOthersInPack: r.maxOthersInPack,
        };
      });

      const html = generateDraftPickStatsHtml(rows);
      const outDir = join(pipeline.dataDir, "stats");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "draft-pick-stats.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open draft pick stats page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Draft Pick Stats - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  /**
   * Milestone 23 (features e/f, 2026-09-30 request): "win rate on cards
   * based on whether they were in the opening hand" / "...played during
   * the match", per format - the tray's "Card Situational Win Rate..."
   * item. Dataset-wide, same convention as Draft Pick Stats above.
   *
   * This is the "Electron layer joins" half of
   * domain/cardSituationalWinRate.ts's deliberately pure
   * buildCardSituationalWinRateRows (see that module's own header comment
   * for why the split exists) - for every game of every match with a
   * captured outcome, it resolves:
   *  - this match's own seat (MatchFound.players[].systemSeatId, matched
   *    to myScreenName - same join every other per-seat lookup in this
   *    project uses, e.g. matchDetails.ts),
   *  - the deck that was actually live for this match (the latest
   *    DeckSubmitted for the same eventName with submittedAt <= the
   *    match's own ts, falling back to the EARLIEST submission overall if
   *    none precedes it - same "never silently drop a match" fallback
   *    deckVersions.ts's deriveDeckVersions already uses for exactly this
   *    situation),
   *  - that run's resolved format (eventIdentity.ts's resolveEventFormat,
   *    preferring the deck's own real Format attribute over the
   *    name-based guess),
   *  - and this specific game's own outcome (rollups.ts's
   *    buildGameOutcomeIndex, not just the match's final result - the
   *    whole point of milestone 23's Bo3 work, so a Bo3 game 1 loss
   *    doesn't get blamed on cards that only showed up in game 2's win).
   *
   * A match with no resolvable deck at all (no DeckSubmitted ever
   * captured for its eventName) is skipped entirely - there's no card
   * universe to attribute its games to.
   */
  openCardSituationalWinRatePage = (): void => {
    const dbPath = join(pipeline.dataDir, "tracker.db");
    let store: TypedEventStore | null = null;
    let cardStore: CardStore | null = null;
    try {
      store = new TypedEventStore(dbPath);
      cardStore = new CardStore(dbPath);
      const source = loadEventHistorySource(store);

      const outcomes = computeMatchOutcomes(source.matchFounds, source.matchCompletions, source.myScreenName);
      const gameOutcomeIndex = buildGameOutcomeIndex(outcomes);

      // Latest-submission-at-or-before-ts, falling back to the earliest
      // overall - same resolution deriveDeckVersions.ts's own match
      // attribution uses, just inlined here since this needs the deck
      // ITSELF (for its card ids/format), not a version's attributed
      // match list.
      const decksByEvent = new Map<string, (typeof source.decks)>();
      for (const d of source.decks) {
        const list = decksByEvent.get(d.eventName) ?? [];
        list.push(d);
        decksByEvent.set(d.eventName, list);
      }
      for (const list of decksByEvent.values()) list.sort((a, b) => compareTs(a.ts, b.ts));

      const games: GameResultContext[] = [];
      for (const found of source.matchFounds) {
        const me = found.players.find((p) => p.playerName === source.myScreenName);
        if (!me || !found.eventId) continue;

        const deckList = decksByEvent.get(found.eventId);
        if (!deckList || deckList.length === 0) continue; // no deck ever captured for this run - nothing to attribute these games to
        let deck = deckList[0];
        for (const d of deckList) {
          if (compareTs(d.ts, found.ts) <= 0) deck = d;
          else break;
        }

        const identity = parseEventIdentity(found.eventId);
        const format = resolveEventFormat(identity, deck.format);
        const deckCardIds = [...deck.mainDeck, ...deck.sideboard].map((e) => e.cardId);
        if (deckCardIds.length === 0) continue;

        const outcome = outcomes.find((o) => o.matchId === found.matchId);
        const gameCount = outcome?.games?.sequence.length ?? 0;
        for (let gameNumber = 1; gameNumber <= gameCount; gameNumber++) {
          const gameOutcome = gameOutcomeIndex.get(`${found.matchId}|${gameNumber}`);
          if (!gameOutcome) continue;
          games.push({ matchId: found.matchId, gameNumber, mySeat: me.systemSeatId, format, deckCardIds, outcome: gameOutcome });
        }
      }

      const situationalRows = buildCardSituationalWinRateRows(games, source.handEvents, source.playedEvents);

      const cardsById = new Map<number, { name: string; colors: string[] }>();
      for (const c of cardStore.all()) cardsById.set(c.grpId, { name: c.name, colors: c.colors });
      const rows: CardSituationalWinRateHtmlRow[] = situationalRows.map((r) => {
        const info = cardsById.get(r.cardId);
        return {
          cardId: r.cardId,
          name: info?.name ?? `Unknown card #${r.cardId} (run npm run refresh-cards)`,
          colors: info?.colors ?? [],
          format: r.format,
          inHand: r.inHand,
          notInHand: r.notInHand,
          played: r.played,
          notPlayed: r.notPlayed,
        };
      });

      const html = generateCardSituationalWinRateHtml(rows);
      const outDir = join(pipeline.dataDir, "stats");
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, "card-situational-winrate.html");
      writeFileSync(outPath, html, "utf8");
      shell.openPath(outPath);
    } catch (err) {
      console.error("Failed to generate/open card situational win rate page:", err);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: "MTGA Tracker", body: "Couldn't open Card Situational Win Rate - check the logs." }).show();
        }
      } catch {
        // Notifications are a nice-to-have.
      }
    } finally {
      store?.close();
      cardStore?.close();
    }
  };

  // Milestone 7 phase 5: "live draft progress" page. See draftProgressHtml.ts's
  // top comment for why this is a static file that gets rewritten on every
  // relevant event rather than served live - short version: this project
  // deliberately has no local HTTP server (see phase 4's notes), so the page
  // auto-refreshes itself and this is what keeps its content fresh for it to
  // pick up. Always writes something (a real snapshot, or the "no draft in
  // progress" placeholder) so a tab left open never shows stale, already-
  // finished pack contents as if they were still current.
  const draftProgressPath = join(pipeline.dataDir, "draft-progress", "live.html");
  const regenerateDraftProgressPage = (snap: OverlaySnapshot = liveState.snapshot()) => {
    try {
      mkdirSync(join(pipeline.dataDir, "draft-progress"), { recursive: true });
      const currentDraft = snap.currentDraft;
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

  openDraftProgressPage = () => {
    regenerateDraftProgressPage();
    shell.openPath(draftProgressPath);
  };
  ipcMain.handle("open-draft-progress", () => {
    openDraftProgressPage!();
    return { ok: true };
  });

  // The overlay's clickable spots (menu button, current-event row, draft
  // row): the renderer reports where they are; see updateOverlayHotspotState.
  ipcMain.on("overlay-set-hotspots", (_event, rects: unknown) => {
    if (!Array.isArray(rects)) return;
    overlayHotspots = rects
      .filter((r): r is { x: number; y: number; width: number; height: number } => {
        return !!r && typeof r === "object" && ["x", "y", "width", "height"].every((k) => Number.isFinite((r as Record<string, unknown>)[k]));
      })
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  });
  // The ☰ button: opens the in-overlay menu, or closes it if already open.
  ipcMain.handle("open-overlay-menu", () => {
    if (overlayMenuOpen) closeOverlayMenu();
    else openOverlayMenu();
    return { ok: true };
  });
  ipcMain.handle("close-overlay-menu", () => {
    closeOverlayMenu();
    return { ok: true };
  });
  ipcMain.handle("overlay-menu-action", (_event, id: unknown) => {
    const action = typeof id === "number" ? overlayMenuActions.get(id) : undefined;
    closeOverlayMenu(); // close first - some actions (hide overlay, quit) change the window itself
    try {
      action?.();
    } catch (err) {
      console.error("Overlay menu action failed:", err);
    }
    return { ok: true };
  });

  /**
   * Milestone 23: the overlay's own draft-board panel content (every pack
   * seen so far, picks made, colors taken), as a pre-rendered HTML fragment
   * the overlay renderer drops straight into the DOM - same resolved data
   * (buildDraftProgressData) and the same "only re-read the card catalog on
   * a draft-relevant event" gating as regenerateDraftProgressPage above,
   * just rendered as a compact fragment (draftBoardFragmentHtml) instead of
   * a full page. Cached here rather than rebuilt on every sendSnapshot call
   * (which fires on every domain event, including plain match/game-state
   * ones that can't possibly change this) - null means "no draft board to
   * show", which is also what clears the panel once a draft completes.
   */
  let draftBoardHtml: string | null = null;
  const refreshDraftBoardHtml = (snap: OverlaySnapshot = liveState.snapshot()) => {
    const currentDraft = snap.currentDraft;
    if (!currentDraft) {
      draftBoardHtml = null;
      return;
    }
    const cardStore = new CardStore(join(pipeline.dataDir, "tracker.db"));
    try {
      draftBoardHtml = draftBoardFragmentHtml(buildDraftProgressData(currentDraft, cardStore));
    } catch (err) {
      console.error("Failed to refresh overlay draft board:", err);
      draftBoardHtml = null;
    } finally {
      cardStore.close();
    }
  };

  const sendSnapshot = (snap: OverlaySnapshot = liveState.snapshot()) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("state", {
      foundLog: pipeline.located.found,
      watchingPath: pipeline.located.path,
      snapshot: snap,
      draftBoardHtml,
    });
  };

  mainWindow.webContents.once("did-finish-load", () => {
    // Milestone 23: if a draft was already in progress before this launch
    // (seedHistory resumed it as "current" - see LiveStateTracker.seedHistory's
    // comment), size the window and populate the draft board for it right
    // away, rather than waiting for the next live pack/pick event to notice.
    const initialSnap = liveState.snapshot();
    refreshDraftBoardHtml(initialSnap);
    setOverlayDraftExpanded(initialSnap.currentDraft !== null);
    sendSnapshot(initialSnap);
    // Milestone 9+: the window was already created at the right *size* for
    // overlaySettings (createWindow used it directly), but the renderer
    // still needs telling what font-size/opacity that corresponds to -
    // this is that one-time initial push, mirroring what applyOverlaySettings
    // sends on every later change. setOverlayDraftExpanded above already
    // pushed this if the window just got resized for a resumed draft; this
    // still runs unconditionally since it's a no-op in that case (same
    // values) and is the only push at all in the (overwhelmingly common)
    // no-resumed-draft case.
    const preset = SIZE_PRESETS[overlaySettings.sizePreset] ?? SIZE_PRESETS[DEFAULT_SIZE_PRESET];
    mainWindow?.webContents.send("settings", { fontSizePx: BASE_FONT_PX * preset.scale, opacity: overlaySettings.opacity, theme: overlaySettings.theme });
  });

  // Milestone 25: "when I start a new one, close out the previous one and
  // let me type in the correct score" - see domain/eventClosure.ts for
  // what counts as pending. notifiedPendingKeys is only this process's own
  // memory (a relaunch re-notifies for anything still unresolved, same as
  // the "couldn't find Player.log" notification elsewhere in this file) -
  // its only job is not re-notifying twice for the same still-pending run
  // within one session if more than one DraftJoined comes in.
  const notifiedPendingKeys = new Set<string>();
  function checkPendingClosures(): void {
    try {
      const pending = findPendingClosures(pipeline.loadHistorySource());
      const fresh = pending.filter((p) => !notifiedPendingKeys.has(`${p.eventId}|${p.courseId ?? ""}`));
      for (const p of pending) notifiedPendingKeys.add(`${p.eventId}|${p.courseId ?? ""}`);
      if (fresh.length > 0 && Notification.isSupported()) {
        const body =
          fresh.length === 1
            ? `Your ${fresh[0].identity.definitionLabel} run never showed a final result. Open Overlay Settings to enter the correct score.`
            : `${fresh.length} past runs never showed a final result. Open Overlay Settings to enter their correct scores.`;
        new Notification({ title: "MTGA Tracker", body }).show();
      }
    } catch (err) {
      // Best-effort - never let this block the rest of startup/capture.
      console.error("Pending-closure check failed:", err);
    }
  }
  checkPendingClosures();

  if (pipeline.located.found) {
    watchingStatus = `Watching: ${pipeline.located.path}`;
    pipeline.on("domainEvent", (event) => {
      liveState.record(event);
      const snap = liveState.snapshot();
      // Only these three kinds can change what the draft-progress page/
      // draft board should show (see LiveStateTracker.record) - no point
      // re-reading the ~27k-row card catalog on every unrelated
      // match/game-state event.
      if (event.kind === "DraftPackSeen" || event.kind === "DraftPickMade" || event.kind === "DraftCompleted") {
        regenerateDraftProgressPage(snap);
        refreshDraftBoardHtml(snap);
      }
      // Milestone 23: grows/shrinks the overlay the instant a draft
      // starts/ends - cheap no-op check (setOverlayDraftExpanded bails
      // immediately if nothing's actually changing) so this is safe to call
      // on every event, not just the three draft-relevant kinds above.
      setOverlayDraftExpanded(snap.currentDraft !== null);
      // Milestone 25: a new event being joined is exactly the moment an
      // earlier same-format run (if any) becomes "superseded" - see
      // domain/eventClosure.ts. Cheap enough to run on every join (joins
      // are rare - once per event entered, nothing like per-match volume).
      if (event.kind === "DraftJoined") checkPendingClosures();
      sendSnapshot(snap);
    });
    // 2026-10-02: in-game library tracking (domain/libraryTracker.ts). It reads
    // the raw GRE messages itself (the classifier only emits persisted domain
    // events, and the library is live-only state), so it hangs off every
    // processed block rather than off domainEvent.
    const libraryTracker = new LibraryTracker();
    const libraryCardInfo = new Map<number, LibraryCardInfo>();
    let libraryGameOver = false;
    let lastLibraryConnects = 0;
    let lastLibraryHtml: string | null | undefined;
    const resolveLibraryCards = (grpIds: number[]) => {
      const missing = grpIds.filter((g) => !libraryCardInfo.has(g));
      if (missing.length === 0) return;
      let cardStore: CardStore | null = null;
      try {
        cardStore = new CardStore(join(pipeline.dataDir, "tracker.db"));
        for (const g of missing) {
          const c = cardStore.get(g);
          if (c) libraryCardInfo.set(g, { name: c.name, manaCost: c.manaCost, types: c.types });
        }
      } catch (err) {
        console.error("Library panel: card lookup failed:", err);
      } finally {
        cardStore?.close();
      }
    };
    const refreshLibraryPanel = () => {
      const snap = libraryTracker.snapshot();
      const opp = libraryTracker.opponentSnapshot();
      const visible = (snap !== null || opp !== null) && !libraryGameOver;
      let html: string | null = null;
      if (visible) {
        resolveLibraryCards([...(snap?.entries.map((e) => e.grpId) ?? []), ...(opp?.entries.map((e) => e.grpId) ?? [])]);
        html = libraryFragmentHtml(snap, libraryCardInfo, opp) || null;
      }
      setOverlayLibraryExpanded(html !== null);
      if (html === lastLibraryHtml) return;
      lastLibraryHtml = html;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("library", { html });
    };
    pipeline.on("processed", ({ block }: { block: { json: unknown } }) => {
      try {
        if (!libraryTracker.feed(block.json)) return;
        if (libraryTracker.connectCount !== lastLibraryConnects) {
          lastLibraryConnects = libraryTracker.connectCount;
          libraryGameOver = false; // a new game's connect message
        }
        refreshLibraryPanel();
      } catch (err) {
        console.error("Library tracking failed:", err);
      }
    });
    // The game ending hides the column (the library is meaningless after it);
    // the next game's connect message brings it back.
    pipeline.on("domainEvent", (event) => {
      if (event.kind === "GameStateSnapshot" && event.stage === "GameStage_GameOver") {
        libraryGameOver = true;
        refreshLibraryPanel();
      } else if (event.kind === "MatchCompleted") {
        libraryGameOver = true;
        refreshLibraryPanel();
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
  startOverlayHotspotWatcher();
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
