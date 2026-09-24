import { DatabaseSync } from "node:sqlite";
import type { ArenaCard, EnrichedCard } from "./types.js";

/**
 * Stores the card catalog (Arena's own data + Scryfall enrichment) in a
 * `cards` table inside the same tracker.db used for captured match/draft
 * events (see db/sqliteStore.ts) - one file, one PRAGMA setup, simpler than
 * managing a second database. Kept as its own class/connection rather than
 * folded into TypedEventStore since this isn't event-sourced data: it's a
 * catalog that gets *replaced* wholesale on each refresh (see
 * refreshCards.ts), not appended to.
 */
export class CardStore {
  private db: DatabaseSync;
  private upsertStmt: ReturnType<DatabaseSync["prepare"]>;
  private syncArenaStmt: ReturnType<DatabaseSync["prepare"]>;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        grpId INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        setCode TEXT NOT NULL,
        collectorNumber TEXT NOT NULL,
        rarityRaw INTEGER NOT NULL,
        isToken INTEGER NOT NULL,
        isDigitalOnly INTEGER NOT NULL,
        isRebalanced INTEGER NOT NULL,
        rebalancedCardGrpId INTEGER,
        scryfallId TEXT,
        oracleText TEXT,
        manaCost TEXT,
        colors TEXT,
        scryfallRarity TEXT,
        imageSmall TEXT,
        imageNormal TEXT,
        imageLarge TEXT,
        imagePng TEXT,
        enrichedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cards_setCode ON cards(setCode);
      CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT INTO cards (
        grpId, name, setCode, collectorNumber, rarityRaw, isToken, isDigitalOnly, isRebalanced, rebalancedCardGrpId,
        scryfallId, oracleText, manaCost, colors, scryfallRarity, imageSmall, imageNormal, imageLarge, imagePng, enrichedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grpId) DO UPDATE SET
        name = excluded.name,
        setCode = excluded.setCode,
        collectorNumber = excluded.collectorNumber,
        rarityRaw = excluded.rarityRaw,
        isToken = excluded.isToken,
        isDigitalOnly = excluded.isDigitalOnly,
        isRebalanced = excluded.isRebalanced,
        rebalancedCardGrpId = excluded.rebalancedCardGrpId,
        scryfallId = excluded.scryfallId,
        oracleText = excluded.oracleText,
        manaCost = excluded.manaCost,
        colors = excluded.colors,
        scryfallRarity = excluded.scryfallRarity,
        imageSmall = excluded.imageSmall,
        imageNormal = excluded.imageNormal,
        imageLarge = excluded.imageLarge,
        imagePng = excluded.imagePng,
        enrichedAt = excluded.enrichedAt
    `);
    // Used by syncArenaData() below: deliberately does NOT touch the
    // scryfall*/image*/enrichedAt columns on conflict, so re-running the
    // Arena-side extraction (e.g. after a new set drops, or via
    // `refresh-cards --skip-enrich`) never wipes out enrichment data from a
    // previous full run. New rows still get explicit NULLs for those
    // columns since there's nothing to enrich with yet.
    this.syncArenaStmt = this.db.prepare(`
      INSERT INTO cards (
        grpId, name, setCode, collectorNumber, rarityRaw, isToken, isDigitalOnly, isRebalanced, rebalancedCardGrpId,
        scryfallId, oracleText, manaCost, colors, scryfallRarity, imageSmall, imageNormal, imageLarge, imagePng, enrichedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      ON CONFLICT(grpId) DO UPDATE SET
        name = excluded.name,
        setCode = excluded.setCode,
        collectorNumber = excluded.collectorNumber,
        rarityRaw = excluded.rarityRaw,
        isToken = excluded.isToken,
        isDigitalOnly = excluded.isDigitalOnly,
        isRebalanced = excluded.isRebalanced,
        rebalancedCardGrpId = excluded.rebalancedCardGrpId
    `);
  }

  upsert(card: EnrichedCard): void {
    this.upsertStmt.run(
      card.grpId,
      card.name,
      card.setCode,
      card.collectorNumber,
      card.rarityRaw,
      card.isToken ? 1 : 0,
      card.isDigitalOnly ? 1 : 0,
      card.isRebalanced ? 1 : 0,
      card.rebalancedCardGrpId,
      card.scryfallId,
      card.oracleText,
      card.manaCost,
      card.colors ? JSON.stringify(card.colors) : null,
      card.scryfallRarity,
      card.imageSmall,
      card.imageNormal,
      card.imageLarge,
      card.imagePng,
      card.enrichedAt,
    );
  }

  upsertMany(cards: EnrichedCard[]): void {
    this.db.exec("BEGIN");
    try {
      for (const c of cards) this.upsert(c);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Inserts/updates only the Arena-derived fields (name, set, collector
   * number, rarityRaw, token/digital/rebalance flags) for every card given,
   * leaving any existing Scryfall enrichment on those rows untouched. Runs
   * as a single transaction - important for performance: one autocommit
   * transaction per row (which a naive per-card upsert() loop would do) can
   * take tens of seconds for the ~27,000-card catalog, since every insert
   * would otherwise force its own fsync.
   */
  syncArenaData(cards: ArenaCard[]): void {
    this.db.exec("BEGIN");
    try {
      for (const c of cards) {
        this.syncArenaStmt.run(
          c.grpId,
          c.name,
          c.setCode,
          c.collectorNumber,
          c.rarityRaw,
          c.isToken ? 1 : 0,
          c.isDigitalOnly ? 1 : 0,
          c.isRebalanced ? 1 : 0,
          c.rebalancedCardGrpId,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get(grpId: number): EnrichedCard | null {
    const row = this.db.prepare("SELECT * FROM cards WHERE grpId = ?").get(grpId);
    return row ? rowToCard(row as unknown as RawCardRow) : null;
  }

  all(): EnrichedCard[] {
    const rows = this.db.prepare("SELECT * FROM cards ORDER BY setCode, CAST(collectorNumber AS INTEGER)").all();
    return (rows as unknown as RawCardRow[]).map(rowToCard);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM cards").get() as { n: number }).n;
  }

  enrichedCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM cards WHERE enrichedAt IS NOT NULL").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

interface RawCardRow {
  grpId: number;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarityRaw: number;
  isToken: number;
  isDigitalOnly: number;
  isRebalanced: number;
  rebalancedCardGrpId: number | null;
  scryfallId: string | null;
  oracleText: string | null;
  manaCost: string | null;
  colors: string | null;
  scryfallRarity: string | null;
  imageSmall: string | null;
  imageNormal: string | null;
  imageLarge: string | null;
  imagePng: string | null;
  enrichedAt: string | null;
}

function rowToCard(row: RawCardRow): EnrichedCard {
  return {
    grpId: row.grpId,
    name: row.name,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    rarityRaw: row.rarityRaw,
    isToken: Boolean(row.isToken),
    isDigitalOnly: Boolean(row.isDigitalOnly),
    isRebalanced: Boolean(row.isRebalanced),
    rebalancedCardGrpId: row.rebalancedCardGrpId,
    scryfallId: row.scryfallId,
    oracleText: row.oracleText,
    manaCost: row.manaCost,
    colors: row.colors ? JSON.parse(row.colors) : null,
    scryfallRarity: row.scryfallRarity,
    imageSmall: row.imageSmall,
    imageNormal: row.imageNormal,
    imageLarge: row.imageLarge,
    imagePng: row.imagePng,
    enrichedAt: row.enrichedAt,
  };
}
