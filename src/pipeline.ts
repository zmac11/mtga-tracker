import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { locateLogFile, type LocateResult } from "./log/logLocator.js";
import { LogTailer } from "./log/logTailer.js";
import { LogParser, type RawBlock } from "./log/logParser.js";
import { RawEventStore } from "./db/store.js";
import { TypedEventStore } from "./db/sqliteStore.js";
import { Classifier } from "./domain/classifier.js";
import { selectNewMatchEvents, type ClassifiedBlock } from "./domain/catchUp.js";
import { loadEventHistorySource } from "./eventHistoryLoader.js";
import type { EventHistorySource } from "./domain/eventHistory.js";
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

export interface CatchUpResult {
  /** matchIds recovered that weren't already in tracker.db - empty if nothing was missed. */
  newMatchIds: string[];
  appendedEvents: number;
  kindCounts: Record<string, number>;
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

  /**
   * Milestone 25: "tracker was off for a bit, recover whatever matches
   * happened while it was" - replays the WHOLE current Player.log (not
   * just whatever the live tailer would see from here on) through a
   * one-shot parser+classifier, then keeps only the matches that aren't
   * already in tracker.db (see domain/catchUp.ts/selectNewMatchEvents for
   * the actual selection logic - this method is just the I/O around it).
   *
   * Call this before start() (and before seeding any live state from
   * historyForSeeding(), if the caller does that) so a relaunch's very
   * first render already reflects whatever got recovered. Safe to call on
   * every single startup, found-or-not: a no-op if Player.log wasn't
   * found, and already-known matches are always skipped rather than
   * re-appended, so there's no harm (beyond the one-time cost of
   * reclassifying the log) in doing this unconditionally rather than only
   * when the caller suspects something was missed. Only recovers whole
   * matches (anything carrying a matchId) - see that module's comment for
   * why this is deliberately narrower than a general re-sync.
   *
   * Also reads Player-prev.log (the previous session's log, which Arena
   * keeps exactly one generation of - see LogTailer's own comment) when
   * present, so matches that finished before the tracker's last Arena
   * relaunch are still recovered. Still bounded by Arena's own retention:
   * anything from two or more relaunches back is gone from disk entirely
   * and simply won't be found here.
   */
  catchUpFromLog(opts: { dryRun?: boolean } = {}): CatchUpResult {
    if (!this.located.found) return { newMatchIds: [], appendedEvents: 0, kindCounts: {} };

    // Arena rewrites Player.log from scratch on every client (re)launch -
    // the content from before that launch is renamed to Player-prev.log
    // (see logTailer.ts's doc comment). If the tracker was off across an
    // Arena restart, matches that finished before the restart only exist
    // in Player-prev.log, never in the current Player.log. Reading both
    // (prev first, since it's the older session) and feeding them through
    // the same parser/classifier as one continuous stream recovers those
    // too - the existing matchId-based dedup below is file-agnostic, so
    // this is safe to do unconditionally on every catch-up run.
    const prevLogPath = join(dirname(this.located.path), "Player-prev.log");
    let fullText = "";
    if (existsSync(prevLogPath)) {
      try {
        fullText += readFileSync(prevLogPath, "utf8");
      } catch {
        // best-effort: if Player-prev.log can't be read, just skip it
      }
    }
    fullText += readFileSync(this.located.path, "utf8");

    const parser = new LogParser();
    const classifier = new Classifier();
    const blocks: ClassifiedBlock[] = [];
    parser.on("block", (block: RawBlock) => {
      const events = classifier.classify({
        direction: block.direction,
        method: block.methodGuess,
        json: block.json,
        ts: block.timestampGuess ?? new Date().toISOString(),
      });
      blocks.push({ block, events });
    });
    parser.feed(fullText);

    const existingMatchIds = new Set(this.typedStore.all("MatchFound").map((e) => e.matchId));
    const { newMatchIds, toAppend } = selectNewMatchEvents(blocks, existingMatchIds);

    const kindCounts: Record<string, number> = {};
    let appendedEvents = 0;
    for (const { block, events } of toAppend) {
      if (!opts.dryRun) {
        this.rawStore.append(block, new Date());
        this.typedStore.appendMany(events);
        for (const e of events) this.emit("domainEvent", e);
      }
      for (const e of events) kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
      appendedEvents += events.length;
    }

    return { newMatchIds, appendedEvents, kindCounts };
  }

  /**
   * Milestone 25: a read-only snapshot of everything captured so far, for
   * the event-closure check (domain/eventClosure.ts's findPendingClosures)
   * and the Settings window's "Unfinished Events" section - see
   * electron/main.ts. Same data eventHistoryLoader.ts's loadEventHistorySource
   * always reads report.ts/the deck viewer from; this just wraps it so
   * callers outside pipeline.ts never need direct store access.
   */
  loadHistorySource(): EventHistorySource {
    return loadEventHistorySource(this.typedStore);
  }

  /**
   * Milestone 25: records a user-entered final score for a run the
   * automatic detection never saw finish (see types.ts's
   * ManualCourseResult and domain/eventClosure.ts) - written directly,
   * never classified from the log. Emits "domainEvent" like any other
   * append, so a live listener (the overlay, if it cares) sees it too.
   */
  recordManualCourseResult(eventId: string, courseId: string | null, wins: number, losses: number): void {
    const event: DomainEvent = { kind: "ManualCourseResult", eventId, courseId, wins, losses, ts: new Date().toISOString() };
    this.typedStore.append(event);
    this.emit("domainEvent", event);
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
