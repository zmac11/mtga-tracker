import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateLogFile } from "./log/logLocator.js";
import { LogTailer } from "./log/logTailer.js";
import { LogParser, type RawBlock } from "./log/logParser.js";
import { RawEventStore } from "./db/store.js";
import { TypedEventStore } from "./db/sqliteStore.js";
import { Classifier } from "./domain/classifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const located = locateLogFile(logPath);

  console.log("MTGA Tracker - headless log capture (milestone 1)");
  console.log("--------------------------------------------------");

  if (!located.found) {
    console.error(`Could not find Player.log. Checked:\n  ${located.checked.join("\n  ")}`);
    console.error("");
    console.error("Make sure MTG Arena is installed and that you've enabled:");
    console.error("  Options > Account > Detailed Logs (Plugin Support)");
    console.error("Then relaunch Arena once so it writes a fresh log, and re-run this.");
    process.exitCode = 1;
    return;
  }

  console.log(`Watching: ${located.path}`);
  console.log(fromStart ? "Reading from the beginning of the file." : "Reading only new events from now on.");
  console.log("Press Ctrl+C to stop.\n");

  const dataDir = join(__dirname, "..", "data");
  const store = new RawEventStore(dataDir);
  const typedStore = new TypedEventStore(join(dataDir, "tracker.db"));
  const classifier = new Classifier();
  const parser = new LogParser();
  const tailer = new LogTailer(located.path, { fromStart });

  let eventCount = 0;
  let typedCount = 0;

  parser.on("block", (block: RawBlock) => {
    eventCount++;
    const receivedAt = new Date();
    const key = store.append(block, receivedAt);
    const dirTag = block.direction === "request" ? "->" : block.direction === "response" ? "<-" : "  ";

    const domainEvents = classifier.classify({
      direction: block.direction,
      method: block.methodGuess,
      json: block.json,
      ts: block.timestampGuess ?? receivedAt.toISOString(),
    });
    if (domainEvents.length > 0) {
      typedStore.appendMany(domainEvents);
      typedCount += domainEvents.length;
      for (const e of domainEvents) console.log(`[${String(eventCount).padStart(5, "0")}] ${dirTag} ${key}  =>  ${e.kind}`);
    } else {
      console.log(`[${String(eventCount).padStart(5, "0")}] ${dirTag} ${key}`);
    }
  });

  tailer.on("data", (chunk) => parser.feed(chunk));
  tailer.on("rotated", () => console.log(">> Log file rotated (Arena (re)started) - continuing from the top."));
  tailer.on("error", (err) => console.error("Tailer error:", err));

  tailer.start();

  const printSummary = () => {
    const summary = store.summary();
    if (summary.length === 0) {
      console.log("\n(no events captured yet)");
      return;
    }
    console.log(`\n--- Event types seen so far (${eventCount} total, ${typedCount} classified) ---`);
    for (const { key, count } of summary.slice(0, 25)) {
      console.log(`  ${String(count).padStart(6, " ")}  ${key}`);
    }
    if (summary.length > 25) console.log(`  ... and ${summary.length - 25} more distinct types`);
    console.log(`Samples written to: ${join(dataDir, "..", "samples")}`);
    console.log(`Full raw log at:    ${join(dataDir, "raw-events.jsonl")}`);
    console.log(`Typed events at:    ${join(dataDir, "tracker.db")} (run "npm run report" to see a summary)`);
  };

  const summaryInterval = setInterval(printSummary, 60_000);

  const shutdown = async () => {
    clearInterval(summaryInterval);
    console.log("\nStopping...");
    await tailer.stop();
    printSummary();
    typedStore.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
