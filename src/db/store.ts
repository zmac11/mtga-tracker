import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawBlock } from "../log/logParser.js";

/**
 * Milestone-1 storage: append-only JSONL of every captured event, plus a
 * "samples" folder with one pretty-printed example per distinct event key
 * (first occurrence only). No database dependency (deliberately - see
 * README) so this runs anywhere Node runs with zero native build steps.
 *
 * The JSONL file is what we'll eventually replay to build/backfill typed
 * tables once milestone 2 defines real event schemas from observed data.
 */
export class RawEventStore {
  private readonly eventsPath: string;
  private readonly samplesDir: string;
  private readonly seenKeys = new Set<string>();
  private readonly counts = new Map<string, number>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.eventsPath = join(dataDir, "raw-events.jsonl");
    this.samplesDir = join(dataDir, "..", "samples");
    mkdirSync(this.samplesDir, { recursive: true });
  }

  private keyFor(block: RawBlock): string {
    if (block.methodGuess) return block.methodGuess;
    // No method name recovered - fall back to the shape of the JSON so we
    // still get useful grouping (e.g. distinct top-level key sets).
    if (block.json && typeof block.json === "object" && !Array.isArray(block.json)) {
      const keys = Object.keys(block.json as Record<string, unknown>).sort().join(",");
      return `(unnamed:${keys.slice(0, 80)})`;
    }
    return "(unnamed:non-object)";
  }

  append(block: RawBlock, receivedAt: Date): string {
    const key = this.keyFor(block);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    const record = {
      receivedAt: receivedAt.toISOString(),
      direction: block.direction,
      method: block.methodGuess,
      timestampGuess: block.timestampGuess,
      key,
      json: block.json,
    };
    appendFileSync(this.eventsPath, JSON.stringify(record) + "\n", "utf8");

    if (!this.seenKeys.has(key)) {
      this.seenKeys.add(key);
      const safeName = key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 100);
      const samplePath = join(this.samplesDir, `${safeName}.json`);
      if (!existsSync(samplePath)) {
        writeFileSync(
          samplePath,
          JSON.stringify(
            { direction: block.direction, method: block.methodGuess, header: block.header, json: block.json },
            null,
            2,
          ),
          "utf8",
        );
      }
    }

    return key;
  }

  summary(): Array<{ key: string; count: number }> {
    return [...this.counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }
}
