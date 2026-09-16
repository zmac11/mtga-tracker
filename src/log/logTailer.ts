import { EventEmitter } from "node:events";
import { createReadStream, statSync, existsSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";

export interface LogTailerEvents {
  data: (chunk: string) => void;
  rotated: () => void;
  error: (err: Error) => void;
}

/**
 * Tails a growing text file (tail -f style).
 *
 * MTGA rewrites Player.log from scratch each time the client (re)starts, so
 * we have to detect "the file got smaller than where we left off" and treat
 * that as a rotation: reset our read position to 0 instead of trying to
 * read from an offset that no longer exists.
 */
export class LogTailer extends EventEmitter {
  private readonly path: string;
  private position = 0;
  private watcher: FSWatcher | undefined;
  private reading = false;
  private pendingReread = false;

  constructor(path: string, opts: { fromStart?: boolean } = {}) {
    super();
    this.path = path;
    if (opts.fromStart && existsSync(path)) {
      this.position = 0;
    } else if (existsSync(path)) {
      // Default: start at end-of-file so we only see *new* events from now on.
      this.position = statSync(path).size;
    }
  }

  start(): void {
    this.watcher = watch(this.path, {
      persistent: true,
      usePolling: false,
      awaitWriteFinish: false,
    });

    this.watcher.on("add", () => this.readNewData());
    this.watcher.on("change", () => this.readNewData());
    this.watcher.on("unlink", () => {
      // File removed (e.g. mid-rewrite). Wait for it to reappear via "add".
      this.position = 0;
    });
    this.watcher.on("error", (err) => this.emit("error", err));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private readNewData(): void {
    if (this.reading) {
      // A change event fired while we were already reading; make sure we
      // come back for another pass once the current read finishes.
      this.pendingReread = true;
      return;
    }
    this.reading = true;

    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (err) {
      this.reading = false;
      this.emit("error", err as Error);
      return;
    }

    if (size < this.position) {
      // File shrank: MTGA (re)started and truncated/replaced the log.
      this.position = 0;
      this.emit("rotated");
    }

    if (size === this.position) {
      this.reading = false;
      return;
    }

    const start = this.position;
    const stream = createReadStream(this.path, { start, end: size - 1, encoding: "utf8" });
    let chunk = "";
    stream.on("data", (d) => {
      chunk += d;
    });
    stream.on("end", () => {
      this.position = size;
      if (chunk.length > 0) {
        this.emit("data", chunk);
      }
      this.reading = false;
      if (this.pendingReread) {
        this.pendingReread = false;
        this.readNewData();
      }
    });
    stream.on("error", (err) => {
      this.reading = false;
      this.emit("error", err);
    });
  }
}

export interface LogTailer {
  on<E extends keyof LogTailerEvents>(event: E, listener: LogTailerEvents[E]): this;
  emit<E extends keyof LogTailerEvents>(event: E, ...args: Parameters<LogTailerEvents[E]>): boolean;
}
