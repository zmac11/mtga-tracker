import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { TypedEventStore } from "./db/sqliteStore.js";
import { CardStore } from "./cards/cardStore.js";
import { buildDeckViewerData } from "./deckViewerLoader.js";
import { generateDeckViewerHtml } from "./deckViewerHtml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CLI entry point for milestone 7 phase 4's deck viewer (`npm run
 * deck-viewer -- --event=<eventId> [--open]`). Generates a static HTML page
 * for one event run into `data/deck-viewer/<eventId>.html` and prints its
 * path - lets the deck viewer be validated against real data (and just
 * looked at) independent of the overlay/Electron, the same way report.ts's
 * `--event=` flag validated phase 2 before any UI used it. The overlay's own
 * "click the current event to view its deck" (electron/main.ts) generates
 * the same page via deckViewerLoader.ts/deckViewerHtml.ts directly rather
 * than shelling out to this script.
 */
function parseArgs(argv: string[]): { eventId: string | null; open: boolean } {
  let eventId: string | null = null;
  let open = false;
  for (const arg of argv) {
    if (arg.startsWith("--event=")) eventId = arg.slice("--event=".length);
    else if (arg === "--open") open = true;
  }
  return { eventId, open };
}

function main() {
  const { eventId, open } = parseArgs(process.argv.slice(2));
  if (!eventId) {
    console.error("Usage: npm run deck-viewer -- --event=<eventId> [--open]");
    console.error("(run `npm run report` with no --event to see a list of known event ids)");
    process.exitCode = 1;
    return;
  }

  const dataDir = join(__dirname, "..", "data");
  const dbPath = join(dataDir, "tracker.db");
  const store = new TypedEventStore(dbPath);
  const cardStore = new CardStore(dbPath);
  const data = buildDeckViewerData(eventId, store, cardStore);
  store.close();
  cardStore.close();

  if (!data) {
    console.error(`No data captured for event "${eventId}" - run \`npm run report\` (no flags) to see known event ids.`);
    process.exitCode = 1;
    return;
  }

  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
  const html = generateDeckViewerHtml({ ...data, appVersion: pkg.version });
  const outDir = join(dataDir, "deck-viewer");
  mkdirSync(outDir, { recursive: true });
  const safeName = eventId.replace(/[^A-Za-z0-9_-]/g, "_");
  const outPath = join(outDir, `${safeName}.html`);
  writeFileSync(outPath, html, "utf8");
  console.log(`Wrote ${outPath}`);

  if (open) {
    // macOS-only convenience (this project targets macOS first - see
    // architecture-and-status.md). Best-effort: if `open` isn't the right
    // command on whatever platform this runs on, the file's still on disk
    // and can be opened manually.
    try {
      spawn("open", [outPath], { stdio: "ignore", detached: true }).unref();
    } catch (err) {
      console.error("Could not auto-open the page (not on macOS?) - open the file manually:", err instanceof Error ? err.message : err);
    }
  }
}

main();
