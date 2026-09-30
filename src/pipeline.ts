import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { locateLogFile, type LocateResult } from "./log/logLocator.js";
import { LogTailer } from "./log/logTailer.js";
import { LogParser, type RawBlock } from "./log/logParser.js";
import { RawEventStore } from "./db/store.js";
import { TypedEventStore } from "./db/sqliteStore.js";
import { Classifier } from "./domain/classifier.js";
import type { DomainEvent } from "./domain/types.js";

export interface ProcessedBlock {
  block: RawBlock;
  /** Raw-store grouping key (method name, or a shape fingerprint) - same as RawEventStore.append's return value. */
  key: string;
  /** Zero or more typed events the classifier recognized in this block. */
  domainEvents: DomainEvent[];
  /** 1-based count of blocks processed so far, for progress logging. */
  index: number;
}

export interface CapturePipelineEvents {
  /** Fired once per raw JSON block extracted from the log, classified or not - what cli.ts prints per-line. */
  processed: (p: ProcessedBlock) => void;
  /** Fired once per classified typed event - what the overlay wants to update its live state. */
  domainEvent: (event: DomainEvent) => void;
  rotated: () => void;
  error: (err: Error) => void;
}

export interface CapturePipelineOptions {
  logPath?: string;
  fromStart?: boolean;
  /** Defaults to <project root>/data. */
  dataDir?: string;
}

/**
 * The shared capture -> classify -> store loop, used by both the headless
 * CLI (cli.ts) and the Electron overlay (electron/main.ts). This is the
 * same logic cli.ts had inline through milestone 2; factored out so the
 * overlay doesn't reimplement (and risk diverging from) log location,
 * tailing/rotation handling, parsing, classification, or storage - it just
 * listens for "domainEvent" and feeds a LiveStateTracker (see
 * domain/liveState.ts).
 */
export class CapturePipeline extends EventEmitter {
  readonly dataDir: string;
  readonly located: LocateResult;
  private readonly rawStore: RawEventStore;
  private readonly typedStore: TypedEventStore;
  private readonly classifier: Classifier;
  private readonly parser: LogParser;
  private readonly tailer: LogTailer;
  private eventCount = 0;
  private typedCount = 0;

  constructor(opts: CapturePipelineOptions = {}) {
    super();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.dataDir = opts.dataDir ?? join(__dirname, "..", "data");
    this.located = locateLogFile(opts.logPath);

    this.rawStore = new RawEventStore(this.dataDir);
    this.typedStore = new TypedEventStore(join(this.dataDir, "tracker.db"));
    this.classifier = new Classifier();
    this.parser = new LogParser();
    this.tailer = new LogTailer(this.located.path, { fromStart: opts.fromStart });

    this.parser.on("block", (block: RawBlock) => this.handleBlock(block));
    this.tailer.on("data", (chunk) => this.parser.feed(chunk));
    this.tailer.on("rotated", () => this.emit("rotated"));
    this.tailer.on("error", (err) => this.emit("error", err));
  }

  private handleBlock(block: RawBlock): void {
    this.eventCount++;
    const receivedAt = new Date();
    const key = this.rawStore.append(block, receivedAt);

    const domainEvents = this.classifier.classify({
      direction: block.direction,
      method: block.methodGuess,
      json: block.json,
      ts: block.timestampGuess ?? receivedAt.toISOString(),
    });
    if (domainEvents.length > 0) {
      this.typedStore.appendMany(domainEvents);
      this.typedCount += domainEvents.length;
      for (const e of domainEvents) this.emit("domainEvent", e);
    }

    this.emit("processed", { block, key, domainEvents, index: this.eventCount });
  }

  /**
   * Past events already persisted in tracker.db from a previous run,
   * for seeding a fresh LiveStateTracker's rollup history at startup (see
   * LiveStateTracker.seedHistory) - so a relaunch doesn't lose track of an
   * event's already-known record until something new happens to re-report
   * it. Deliberately excludes GameStateSnapshot (not needed for rollups)
   * and doesn't attempt overall chronological ordering across kinds -
   * seedHistory doesn't need it (see its own comment). As of milestone 7
   * phase 5, also includes the draft pack/pick/completion kinds so a
   * still-in-progress draft resumes showing live progress after a relaunch
   * too, not just match/event win-rate history.
   *
   * Found 2026-09-30: PlayerIdentified WAS excluded here too (this
   * function's comment used to say so), on the reasoning that it's "not
   * needed for rollups" - true when this was written, false since
   * computeMatchOutcomes (rollups.ts) started matching each MatchFound
   * player against LiveStateTracker.myScreenName. Since seedHistory never
   * saw a PlayerIdentified event, myScreenName stayed null after every
   * relaunch until a fresh live one arrived (which may not happen again
   * for the rest of an Arena client session) - and with it null, every
   * local win/loss rollup read as 0-0 for every event, not just whichever
   * one was actually affected by something else. Including it here and
   * handling it in seedHistory fixes that: the store's rows are already in
   * insertion/chronological order (sqliteStore.ts's `ORDER BY id ASC`), so
   * replaying all of them just leaves the most recent screen name in
   * place, exactly like the live case.
   */
  historyForSeeding(): DomainEvent[] {
    return [
      ...this.typedStore.all("PlayerIdentified"),
      ...this.typedStore.all("MatchFound"),
      ...this.typedStore.all("MatchCompleted"),
      ...this.typedStore.all("DeckSubmitted"),
      ...this.typedStore.all("CourseStanding"),
      ...this.typedStore.all("DraftPackSeen"),
      ...this.typedStore.all("DraftPickMade"),
      ...this.typedStore.all("DraftCompleted"),
    ];
  }

  /** Only meaningful once `located.found` is true. */
  start(): void {
    this.tailer.start();
  }

  get counts(): { events: number; typed: number } {
    return { events: this.eventCount, typed: this.typedCount };
  }

  /** Raw-block counts by key, most-common first - same shape as RawEventStore.summary(). */
  summary(): Array<{ key: string; count: number }> {
    return this.rawStore.summary();
  }

  async stop(): Promise<void> {
    await this.tailer.stop();
    this.typedStore.close();
  }
}

export interface CapturePipeline {
  on<E extends keyof CapturePipelineEvents>(event: E, listener: CapturePipelineEvents[E]): this;
  emit<E extends keyof CapturePipelineEvents>(event: E, ...args: Parameters<CapturePipelineEvents[E]>): boolean;
}
