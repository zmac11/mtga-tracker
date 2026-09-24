import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { CardStore } from "./cards/cardStore.js";
import { CapturePipeline } from "./pipeline.js";
import { LiveStateTracker } from "./domain/liveState.js";
import { buildDraftProgressData } from "./draftProgressLoader.js";
import { generateDraftProgressHtml } from "./draftProgressHtml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CLI entry point for milestone 7 phase 5's live draft-progress page (`npm
 * run draft-progress -- [--open]`). Unlike generateDeckViewer.ts (which
 * reads one specific *finished* event run by id), this reads whatever
 * tracker.db's persisted history currently says the most recent NOT-YET-
 * completed draft is - the same seedHistory() reconstruction
 * electron/main.ts does at overlay startup - so this can be validated
 * against real data (a real capture mid-draft, or the tail end of one)
 * independent of Electron, the same way `deck-viewer`/`report.ts --event=`
 * validated earlier phases. Doesn't tail the log or watch for new events -
 * it's a one-shot snapshot of persisted history, not a live process; the
 * overlay itself is what stays live.
 */
function parseArgs(argv: string[]): { open: boolean } {
  return { open: argv.includes("--open") };
}

async function main() {
  const { open } = parseArgs(process.argv.slice(2));
  const dataDir = join(__dirname, "..", "data");
  const dbPath = join(dataDir, "tracker.db");

  // CapturePipeline's constructor also locates/opens the log tailer, which
  // this CLI doesn't need (it never calls .start()) - reused anyway since it
  // already knows dataDir/tracker.db wiring and historyForSeeding(), the
  // same convention deck-viewer's electron/main.ts handler follows for its
  // own short-lived reads. .stop() below closes its TypedEventStore
  // connection cleanly even though .start() was never called - LogTailer's
  // own stop() is a safe no-op when nothing was started (see logTailer.ts).
  const pipeline = new CapturePipeline({ dataDir });
  const liveState = new LiveStateTracker();
  liveState.seedHistory(pipeline.historyForSeeding());
  const currentDraft = liveState.snapshot().currentDraft;
  await pipeline.stop();

  if (!currentDraft) {
    console.error("No draft currently in progress (per tracker.db's persisted history - the last draft seen either finished or nothing's been captured yet).");
    process.exitCode = 1;
    return;
  }

  const cardStore = new CardStore(dbPath);
  const data = buildDraftProgressData(currentDraft, cardStore);
  cardStore.close();

  const html = generateDraftProgressHtml(data);
  const outDir = join(dataDir, "draft-progress");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "live.html");
  writeFileSync(outPath, html, "utf8");
  console.log(`Wrote ${outPath} (draft ${data.draftId}, Pack ${data.pack} Pick ${data.pick}, ${data.picks.length} picks so far)`);
  console.log("Note: this is a one-shot snapshot, not a live process - run again (or use the overlay, which regenerates this automatically) to refresh it.");

  if (open) {
    // macOS-only convenience (this project targets macOS first - see architecture-and-status.md).
    try {
      spawn("open", [outPath], { stdio: "ignore", detached: true }).unref();
    } catch (err) {
      console.error("Could not auto-open the page (not on macOS?) - open the file manually:", err instanceof Error ? err.message : err);
    }
  }
}

main();
