import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Classifier, type ClassifiableEvent } from "./domain/classifier.js";
import { TypedEventStore } from "./db/sqliteStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Rebuilds data/tracker.db from data/raw-events.jsonl (the generic capture
 * from milestone 1). Safe to re-run any time - it clears and replays the
 * whole typed-event table from the raw log, so it always reflects the
 * latest classifier logic without needing to re-play Arena's actual log.
 */
async function main() {
  const dataDir = join(__dirname, "..", "data");
  const rawPath = join(dataDir, "raw-events.jsonl");
  const dbPath = join(dataDir, "tracker.db");

  const classifier = new Classifier();
  const store = new TypedEventStore(dbPath);
  store.clear();

  const rl = createInterface({ input: createReadStream(rawPath, "utf8") });

  let linesRead = 0;
  let classified = 0;
  const kindCounts = new Map<string, number>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    linesRead++;
    let record: { direction: string; method: string | null; json: unknown; receivedAt: string; timestampGuess?: string | null };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const ev: ClassifiableEvent = {
      direction: (record.direction as ClassifiableEvent["direction"]) ?? "unknown",
      method: record.method ?? null,
      json: record.json,
      ts: record.timestampGuess ?? record.receivedAt,
    };

    const events = classifier.classify(ev);
    if (events.length > 0) {
      store.appendMany(events);
      classified += events.length;
      for (const e of events) kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
    }
  }

  console.log(`Read ${linesRead} raw events, classified into ${classified} typed events:`);
  for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4, " ")}  ${kind}`);
  }
  console.log(`\nWrote ${dbPath}`);
  store.close();
}

main();
