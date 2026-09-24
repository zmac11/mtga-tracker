import { EventEmitter } from "node:events";
import { createReadStream, statSync, existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import { watch, type FSWatcher } from "chokidar";

export interface LogTailerEvents {
  data: (chunk: string) => void;
  rotated: () => void;
  error: (err: Error) => void;
}

/**
 * Tails a growing text file (tail -f style).
 *
 * MTGA rewrites Player.log from scratch each time the client (re)starts -
 * discovered 2026-09-24 that this is NOT an in-place truncate, it's a real
 * rename-away-and-recreate (the old content becomes Player-prev.log and a
 * brand new Player.log appears). We watch the *containing directory*
 * rather than the exact file path because of that: a watcher on a single
 * file can miss the "a new file now exists at this path" step of a
 * rename-based rotation (confirmed happening in practice - the previous
 * single-file-watch version silently went stale across an Arena restart
 * and never recovered until the app was manually relaunched). Watching the
 * directory and filtering for our filename is the standard robust fix for
 * this class of bug: directory-level "add" events reliably fire when a
 * new file appears with a given name, which is exactly what a rename-based
 * rotation needs.
 *
 * We still also detect "the file got smaller than where we left off" as a
 * belt-and-suspenders check (readNewData()) - in case Arena's rotation
 * behavior itself ever changes back to an in-place truncate, or events
 * arrive in an unexpected order.
 *
 * Second belt-and-suspenders layer, added the same day: a low-frequency
 * poll (every POLL_INTERVAL_MS) that calls readNewData() regardless of
 * whether the watcher fired anything. Directory-watching fixed the
 * reproduced bug in principle, but native filesystem watchers (fsevents on
 * macOS, inotify elsewhere) are a known weak spot across renames,
 * networked/virtualized filesystems, and OS-specific edge cases - and this
 * exact class of bug already silently broke capture twice in one session
 * before being caught. readNewData() is cheap (a stat, and a read only if
 * the size actually changed) and idempotent, so polling every few seconds
 * costs effectively nothing but guarantees we can never get stuck
 * indefinitely the way the old single-file watcher did - worst case, a
 * missed event costs a few seconds of latency instead of silence until
 * the app is manually relaunched.
 */
export class LogTailer extends EventEmitter {
  private static readonly POLL_INTERVAL_MS = 3000;

  private readonly path: string;
  private readonly dir: string;
  private readonly filename: string;
  private position = 0;
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private pendingReread = false;

  constructor(path: string, opts: { fromStart?: boolean } = {}) {
    super();
    this.path = path;
    this.dir = dirname(path);
    this.filename = basename(path);
    if (opts.fromStart && existsSync(path)) {
      this.position = 0;
    } else if (existsSync(path)) {
      // Default: start at end-of-file so we only see *new* events from now on.
      this.position = statSync(path).size;
    }
  }

  start(): void {
    // Watch the directory, not the file itself - see the class comment for
    // why. ignoreInitial so chokidar's initial directory scan doesn't fire
    // a synthetic "add" for every file already there (harmless either way
    // since readNewData() is a no-op when position already equals the
    // current size, but there's no reason to do that extra stat/read).
    this.watcher = watch(this.dir, {
      persistent: true,
      usePolling: false,
      awaitWriteFinish: false,
      depth: 0,
      ignoreInitial: true,
    });

    const isOurFile = (changedPath: string) => basename(changedPath) === this.filename;

    this.watcher.on("add", (p) => {
      if (isOurFile(p)) this.readNewData();
    });
    this.watcher.on("change", (p) => {
      if (isOurFile(p)) this.readNewData();
    });
    this.watcher.on("unlink", (p) => {
      if (!isOurFile(p)) return;
      // File removed (e.g. mid-rewrite, or renamed away as part of
      // rotation). Reset position; the "add" handler above picks up the
      // new file once it appears - typically milliseconds later for a
      // rename-based rotation.
      this.position = 0;
    });
    this.watcher.on("error", (err) => this.emit("error", err));

    this.pollTimer = setInterval(() => this.readNewData(), LogTailer.POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
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
      // ENOENT is expected and benign here: it's the normal brief state
      // between the old file being renamed away and the new one being
      // created during rotation (whether we're reacting to that unlink
      // event or just polling at the wrong instant). Anything else (e.g. a
      // permissions problem) is worth surfacing.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.emit("error", err as Error);
      }
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
