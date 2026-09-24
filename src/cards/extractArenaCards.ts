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
    c.RebalancedCardGrpId AS rebalancedCardGrpId
  FROM Cards c
  LEFT JOIN Localizations_enUS l ON l.LocId = c.TitleId AND l.Formatted = 1
`;

const TAG_RE = /<[^>]+>/g;

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
      });
    }
    return cards;
  } finally {
    db.close();
  }
}
