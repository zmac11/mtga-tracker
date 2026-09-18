import Database from "better-sqlite3";
import type { DomainEvent } from "../domain/types.js";

/**
 * Event-sourced typed store: every classified DomainEvent is appended as a
 * row (kind, timestamp, full JSON). Deliberately not a fully normalized
 * relational schema yet - we've only seen one human draft + one match so
 * far, and locking in tables/foreign keys before seeing bot drafts, Bo3
 * matches, losses, etc. would mean guessing again. Querying is done by
 * reading the relevant kind(s) back out and reducing in JS (see report.ts)
 * rather than SQL joins - fine at this data volume, and easy to evolve.
 */
export class TypedEventStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    `);
    this.insertStmt = this.db.prepare("INSERT INTO events (kind, ts, data) VALUES (?, ?, ?)");
  }

  append(event: DomainEvent): void {
    this.insertStmt.run(event.kind, event.ts, JSON.stringify(event));
  }

  appendMany(events: DomainEvent[]): void {
    const tx = this.db.transaction((evs: DomainEvent[]) => {
      for (const e of evs) this.insertStmt.run(e.kind, e.ts, JSON.stringify(e));
    });
    tx(events);
  }

  all<K extends DomainEvent["kind"]>(kind: K): Array<Extract<DomainEvent, { kind: K }>> {
    const rows = this.db.prepare("SELECT data FROM events WHERE kind = ? ORDER BY id ASC").all(kind) as Array<{
      data: string;
    }>;
    return rows.map((r) => JSON.parse(r.data));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec("DELETE FROM events");
  }

  close(): void {
    this.db.close();
  }
}
