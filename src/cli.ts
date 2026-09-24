import { join } from "node:path";
import { CapturePipeline, type ProcessedBlock } from "./pipeline.js";

function parseArgs(argv: string[]) {
  const args = { logPath: undefined as string | undefined, fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-path") args.logPath = argv[++i];
    else if (argv[i] === "--from-start") args.fromStart = true;
  }
  return args;
}

function main() {
  const { logPath, fromStart } = parseArgs(process.argv.slice(2));

  console.log("MTGA Tracker - headless log capture");
  console.log("------------------------------------");

  const pipeline = new CapturePipeline({ logPath, fromStart });

  if (!pipeline.located.found) {
    console.error(`Could not find Player.log. Checked:\n  ${pipeline.located.checked.join("\n  ")}`);
    console.error("");
    console.error("Make sure MTG Arena is installed and that you've enabled:");
    console.error("  Options > Account > Detailed Logs (Plugin Support)");
    console.error("Then relaunch Arena once so it writes a fresh log, and re-run this.");
    process.exitCode = 1;
    return;
  }

  console.log(`Watching: ${pipeline.located.path}`);
  console.log(fromStart ? "Reading from the beginning of the file." : "Reading only new events from now on.");
  console.log("Press Ctrl+C to stop.\n");

  pipeline.on("processed", (p: ProcessedBlock) => {
    const dirTag = p.block.direction === "request" ? "->" : p.block.direction === "response" ? "<-" : "  ";
    const idx = String(p.index).padStart(5, "0");
    if (p.domainEvents.length > 0) {
      for (const e of p.domainEvents) console.log(`[${idx}] ${dirTag} ${p.key}  =>  ${e.kind}`);
    } else {
      console.log(`[${idx}] ${dirTag} ${p.key}`);
    }
  });
  pipeline.on("rotated", () => console.log(">> Log file rotated (Arena (re)started) - continuing from the top."));
  pipeline.on("error", (err) => console.error("Tailer error:", err));

  pipeline.start();

  const printSummary = () => {
    const summary = pipeline.summary();
    const { events, typed } = pipeline.counts;
    if (summary.length === 0) {
      console.log("\n(no events captured yet)");
      return;
    }
    console.log(`\n--- Event types seen so far (${events} total, ${typed} classified) ---`);
    for (const { key, count } of summary.slice(0, 25)) {
      console.log(`  ${String(count).padStart(6, " ")}  ${key}`);
    }
    if (summary.length > 25) console.log(`  ... and ${summary.length - 25} more distinct types`);
    console.log(`Samples written to: ${join(pipeline.dataDir, "..", "samples")}`);
    console.log(`Full raw log at:    ${join(pipeline.dataDir, "raw-events.jsonl")}`);
    console.log(`Typed events at:    ${join(pipeline.dataDir, "tracker.db")} (run "npm run report" to see a summary)`);
  };

  const summaryInterval = setInterval(printSummary, 60_000);

  const shutdown = async () => {
    clearInterval(summaryInterval);
    console.log("\nStopping...");
    await pipeline.stop();
    printSummary();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
