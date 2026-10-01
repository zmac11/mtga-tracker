import { CapturePipeline } from "./pipeline.js";

/**
 * Manual CLI entry point for CapturePipeline.catchUpFromLog() - milestone
 * 25 wired the same method into Electron app startup so this now happens
 * automatically every launch, but this script is kept for running it by
 * hand (e.g. --dry-run to preview, or pointing at a non-default log/data
 * location) without starting the whole app.
 */
function parseArgs(argv: string[]) {
  const args: { logPath?: string; dataDir?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-path") args.logPath = argv[++i];
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const { logPath, dataDir, dryRun } = parseArgs(process.argv.slice(2));
  const pipeline = new CapturePipeline({ logPath, dataDir });

  if (!pipeline.located.found) {
    console.error(`Could not find Player.log. Checked:\n  ${pipeline.located.checked.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Reading full log from: ${pipeline.located.path}`);
  const result = pipeline.catchUpFromLog({ dryRun });

  if (result.newMatchIds.length === 0) {
    console.log("No new matches found in the current log - everything here is already in tracker.db.");
  } else {
    console.log(`Found ${result.newMatchIds.length} match(es) not yet in tracker.db:`);
    for (const id of result.newMatchIds) console.log(`  ${id}`);

    console.log(`\n${dryRun ? "[dry run] Would append" : "Appended"} ${result.appendedEvents} event(s):`);
    for (const [kind, count] of Object.entries(result.kindCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4, " ")}  ${kind}`);
    }
  }

  await pipeline.stop();
}

main();
