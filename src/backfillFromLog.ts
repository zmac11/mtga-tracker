import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateLogFile } from "./log/logLocator.js";
import { LogParser, type RawBlock } from "./log/logParser.js";
import { Classifier, type ClassifiableEvent } from "./domain/classifier.js";
import { RawEventStore } from "./db/store.js";
import { TypedEventStore } from "./db/sqliteStore.js";
import type { DomainEvent } from "./domain/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Backfills matches that happened while the tracker wasn't running, by
 * replaying MTG Arena's own current Player.log (not raw-events.jsonl -
 * see backfill.ts for that, a different job) through a fresh classifier
 * and keeping only the events for matches not already in tracker.db.
 *
 * Why replay the WHOLE current log instead of just the new tail: the
 * classifier is stateful (mulligan/hand tracking, turn counters) and
 * expects to see a match's events in order from its own start - splicing
 * in only "new" bytes risks misclassifying the first event(s) of a match
 * that spans the gap. Replaying everything and filtering by matchId
 * afterwards is safe either way because it's filtered, not appended,
 * against what's already stored: already-known matchIds are skipped
 * entirely, so nothing already captured gets duplicated.
 *
 * Only events carrying a matchId are considered (MatchFound,
 * MatchCompleted, GameStateSnapshot, GameHandResolved, CardPlayedInGame) -
 * this is deliberately scoped to "recover missed matches", not a general
 * re-sync tool.
 */
function hasMatchId(e: DomainEvent): e is DomainEvent & { matchId: string } {
  return typeof (e as unknown as { matchId?: unknown }).matchId === "string";
}

function parseArgs(argv: string[]) {
  const args: { logPath?: string; dataDir?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-path") args.logPath = argv[++i];
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

function main() {
  const { logPath, dataDir: dataDirArg, dryRun } = parseArgs(process.argv.slice(2));
  const dataDir = dataDirArg ?? join(__dirname, "..", "data");
  const located = locateLogFile(logPath);

  if (!located.found) {
    console.error(`Could not find Player.log. Checked:\n  ${located.checked.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Reading full log from: ${located.path}`);
  const fullText = readFileSync(located.path, "utf8");

  const parser = new LogParser();
  const classifier = new Classifier();
  const blocks: Array<{ block: RawBlock; events: DomainEvent[] }> = [];

  parser.on("block", (block: RawBlock) => {
    const ev: ClassifiableEvent = {
      direction: block.direction,
      method: block.methodGuess,
      json: block.json,
      ts: block.timestampGuess ?? new Date().toISOString(),
    };
    const events = classifier.classify(ev);
    blocks.push({ block, events });
  });
  parser.feed(fullText);

  console.log(`Parsed ${blocks.length} raw blocks from the log.`);

  const typedStore = new TypedEventStore(join(dataDir, "tracker.db"));
  const existingMatchIds = new Set(typedStore.all("MatchFound").map((e) => e.matchId));

  const freshMatchIds = new Set<string>();
  for (const { events } of blocks) {
    for (const e of events) {
      if (hasMatchId(e) && !existingMatchIds.has(e.matchId)) freshMatchIds.add(e.matchId);
    }
  }

  if (freshMatchIds.size === 0) {
    console.log("No new matches found in the current log - everything here is already in tracker.db.");
    typedStore.close();
    return;
  }

  console.log(`Found ${freshMatchIds.size} match(es) not yet in tracker.db:`);
  for (const id of freshMatchIds) console.log(`  ${id}`);

  const rawStore = dryRun ? null : new RawEventStore(dataDir);
  let appendedEvents = 0;
  const kindCounts = new Map<string, number>();

  for (const { block, events } of blocks) {
    const keep = events.some((e) => hasMatchId(e) && freshMatchIds.has(e.matchId));
    if (!keep) continue;
    if (!dryRun) {
      rawStore!.append(block, new Date());
      typedStore.appendMany(events);
    }
    for (const e of events) kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
    appendedEvents += events.length;
  }

  console.log(`\n${dryRun ? "[dry run] Would append" : "Appended"} ${appendedEvents} event(s):`);
  for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4, " ")}  ${kind}`);
  }

  typedStore.close();
}

main();
