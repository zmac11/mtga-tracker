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
        colors TEXT,
        types TEXT,
        scryfallId TEXT,
        oracleText TEXT,
        manaCost TEXT,
        scryfallColors TEXT,
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
    this.migrateLegacyColorsColumn();
    this.upsertStmt = this.db.prepare(`
      INSERT INTO cards (
        grpId, name, setCode, collectorNumber, rarityRaw, isToken, isDigitalOnly, isRebalanced, rebalancedCardGrpId, colors, types,
        scryfallId, oracleText, manaCost, scryfallColors, scryfallRarity, imageSmall, imageNormal, imageLarge, imagePng, enrichedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grpId) DO UPDATE SET
        name = excluded.name,
        setCode = excluded.setCode,
        collectorNumber = excluded.collectorNumber,
        rarityRaw = excluded.rarityRaw,
        isToken = excluded.isToken,
        isDigitalOnly = excluded.isDigitalOnly,
        isRebalanced = excluded.isRebalanced,
        rebalancedCardGrpId = excluded.rebalancedCardGrpId,
        colors = excluded.colors,
        types = excluded.types,
        scryfallId = excluded.scryfallId,
        oracleText = excluded.oracleText,
        manaCost = excluded.manaCost,
        scryfallColors = excluded.scryfallColors,
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
    // columns since there's nothing to enrich with yet. `colors` (Arena's
    // own, unlike the scryfall* columns) IS updated here - it comes from the
    // same Arena-side extraction this statement is for.
    this.syncArenaStmt = this.db.prepare(`
      INSERT INTO cards (
        grpId, name, setCode, collectorNumber, rarityRaw, isToken, isDigitalOnly, isRebalanced, rebalancedCardGrpId, colors, types,
        scryfallId, oracleText, manaCost, scryfallColors, scryfallRarity, imageSmall, imageNormal, imageLarge, imagePng, enrichedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      ON CONFLICT(grpId) DO UPDATE SET
        name = excluded.name,
        setCode = excluded.setCode,
        collectorNumber = excluded.collectorNumber,
        rarityRaw = excluded.rarityRaw,
        isToken = excluded.isToken,
        isDigitalOnly = excluded.isDigitalOnly,
        isRebalanced = excluded.isRebalanced,
        rebalancedCardGrpId = excluded.rebalancedCardGrpId,
        colors = excluded.colors,
        types = excluded.types
    `);
  }

  /**
   * Migrates a pre-2026-09-24 `cards` table: back then `colors` held
   * Scryfall's colors (there was no Arena-derived color source yet). Rename
   * it out of the way to `scryfallColors`, then add a fresh `colors` column
   * for Arena's own decoded WUBRG colors (see extractArenaCards.ts) - filled
   * in on the next syncArenaData()/upsert() run, not backfilled here. A
   * brand-new table (created just above, in this same connection) already
   * has both columns with their new meanings, so this is a no-op for it.
   */
  private migrateLegacyColorsColumn(): void {
    const columns = (this.db.prepare("PRAGMA table_info(cards)").all() as Array<{ name: string }>).map((r) => r.name);
    if (!columns.includes("scryfallColors")) {
      this.db.exec("ALTER TABLE cards RENAME COLUMN colors TO scryfallColors;");
      this.db.exec("ALTER TABLE cards ADD COLUMN colors TEXT;");
    }
    // Added alongside `colors` above but as a plain new column (no prior
    // column to rename out of the way) - milestone 7 phase 4's deck viewer
    // needs Arena's own decoded card types for its creature/non-creature
    // curve mode.
    if (!columns.includes("types")) {
      this.db.exec("ALTER TABLE cards ADD COLUMN types TEXT;");
    }
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
      JSON.stringify(card.colors),
      JSON.stringify(card.types),
      card.scryfallId,
      card.oracleText,
      card.manaCost,
      card.scryfallColors ? JSON.stringify(card.scryfallColors) : null,
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
          JSON.stringify(c.colors),
          JSON.stringify(c.types),
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
  colors: string | null;
  types: string | null;
  scryfallId: string | null;
  oracleText: string | null;
  manaCost: string | null;
  scryfallColors: string | null;
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
    colors: row.colors ? JSON.parse(row.colors) : [],
    types: row.types ? JSON.parse(row.types) : [],
    scryfallId: row.scryfallId,
    oracleText: row.oracleText,
    manaCost: row.manaCost,
    scryfallColors: row.scryfallColors ? JSON.parse(row.scryfallColors) : null,
    scryfallRarity: row.scryfallRarity,
    imageSmall: row.imageSmall,
    imageNormal: row.imageNormal,
    imageLarge: row.imageLarge,
    imagePng: row.imagePng,
    enrichedAt: row.enrichedAt,
  };
}
