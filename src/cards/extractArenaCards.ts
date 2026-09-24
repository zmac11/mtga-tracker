import { DatabaseSync } from "node:sqlite";
import type { ArenaCard } from "./types.js";

/**
 * Pulls every real card out of Arena's own Raw_CardDatabase_*.mtga (located
 * by cardDbLocator.ts) and returns it as ArenaCard[].
 *
 * Schema notes (from inspecting a real 2026-09 database directly - there's
 * no public schema doc for this file, so these are empirical findings, not
 * documented behavior):
 *
 * - Cards.TitleId points into a per-locale Localizations_<locale> table
 *   (we only ever read Localizations_enUS - Arena ships one per supported
 *   language, but this project has no use for the others).
 * - Localizations_enUS's primary key is actually (LocId, Formatted), NOT
 *   just LocId - a single LocId can have up to three rows, one per
 *   "Formatted" value (0, 1, 2). This bit us: joining on LocId alone
 *   produces duplicate rows for a small number of cards. Formatted=1 is the
 *   one present for effectively every card (27067 of 27071 in the sample
 *   database, vs. 1269 for Formatted=0/2, which only exist for a handful of
 *   cards needing extra disambiguation) - so that's the one we join on.
 * - Formatted=1 text can contain lightweight markup tags (<nobr>, <i>, <b>,
 *   <s>, <sup>, <indent=...>, <cspace>, and their closing tags) used by
 *   Arena's own UI for things like keeping "+1/+1" from wrapping mid-token.
 *   We strip all of it with a blunt <[^>]+> regex - plain text is all we
 *   want, and nothing in real card names legitimately contains a `<...>`
 *   run (verified against the sample: zero false positives).
 * - A handful of GrpIds (4 in the sample, all ExpansionCode "WC" - looks
 *   like internal/debug placeholder objects, not anything a player would
 *   see) have no Localizations_enUS row at all for their TitleId. These are
 *   filtered out rather than stored with a null/empty name.
 * - Cards.Rarity is intentionally left undecoded (rariRaw) - see types.ts's
 *   comment on ArenaCard.rarityRaw for why.
 * - Cards.Colors is a comma-separated list of small integers (e.g. "1",
 *   "4,5", or "" for colorless) - decoded below via the confirmed mapping
 *   from the Enums table (Type='Color'): 1=White, 2=Blue, 3=Black, 4=Red,
 *   5=Green, the standard WUBRG convention. Verified 2026-09-24 against the
 *   real sample database, including that basic lands (Forest/Plains/
 *   Island/Swamp) correctly come back with an empty Colors string.
 */

const NAME_QUERY = `
  SELECT
    c.GrpId            AS grpId,
    l.Loc              AS name,
    c.ExpansionCode    AS setCode,
    c.CollectorNumber  AS collectorNumber,
    c.Rarity           AS rarityRaw,
    c.IsToken          AS isToken,
    c.IsDigitalOnly    AS isDigitalOnly,
    c.IsRebalanced     AS isRebalanced,
    c.RebalancedCardGrpId AS rebalancedCardGrpId,
    c.Colors           AS colorsRaw
  FROM Cards c
  LEFT JOIN Localizations_enUS l ON l.LocId = c.TitleId AND l.Formatted = 1
`;

const TAG_RE = /<[^>]+>/g;

/** Arena's own Color enum ids, confirmed against the Enums table (Type='Color'). */
const ARENA_COLOR_MAP: Record<string, string> = { "1": "W", "2": "U", "3": "B", "4": "R", "5": "G" };
const WUBRG_ORDER = ["W", "U", "B", "R", "G"];

/** Decodes Arena's comma-separated `Colors` string into sorted WUBRG letters. Empty/null -> colorless ([]). */
export function decodeArenaColors(raw: string | null): string[] {
  if (!raw) return [];
  const letters = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((id) => ARENA_COLOR_MAP[id])
    .filter((letter): letter is string => Boolean(letter));
  return WUBRG_ORDER.filter((letter) => letters.includes(letter));
}

interface RawRow {
  grpId: number;
  name: string | null;
  setCode: string | null;
  collectorNumber: string;
  rarityRaw: number;
  isToken: number;
  isDigitalOnly: number;
  isRebalanced: number;
  rebalancedCardGrpId: number;
  colorsRaw: string | null;
}

/**
 * `dbPath` should come from cardDbLocator.locateCardDatabase(). Opened
 * read-only - we only ever read Arena's database, never write to it (it's
 * not ours, and Arena itself may have it open at the same time).
 */
export function extractArenaCards(dbPath: string): ArenaCard[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(NAME_QUERY).all() as unknown as RawRow[];
    const cards: ArenaCard[] = [];
    for (const row of rows) {
      if (row.name === null) continue; // no localization row - see comment above
      cards.push({
        grpId: row.grpId,
        name: row.name.replace(TAG_RE, ""),
        setCode: row.setCode ?? "",
        collectorNumber: row.collectorNumber,
        rarityRaw: row.rarityRaw,
        isToken: Boolean(row.isToken),
        isDigitalOnly: Boolean(row.isDigitalOnly),
        isRebalanced: Boolean(row.isRebalanced),
        rebalancedCardGrpId: row.rebalancedCardGrpId ? row.rebalancedCardGrpId : null,
        colors: decodeArenaColors(row.colorsRaw),
      });
    }
    return cards;
  } finally {
    db.close();
  }
}
