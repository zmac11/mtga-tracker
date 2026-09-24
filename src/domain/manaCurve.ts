// Groups a deck's cards into mana-curve buckets for the milestone 7 phase 4
// deck viewer's "curve mode" (grouped by mana cost and creature/non-creature
// type). Mana value comes from Scryfall's `manaCost` string (Arena's own
// card database has no mana-cost/value field at all - confirmed 2026-09-24
// while investigating the real Raw_CardDatabase_*.mtga schema, see
// architecture-and-status.md), so this degrades to an "Unknown cost" bucket
// for any card without Scryfall enrichment - creature/non-creature
// classification still works regardless, since that comes from Arena's own
// decoded `types` (see extractArenaCards.ts's decodeArenaTypes).

export interface CardCurveInfo {
  types: string[];
  /** Scryfall's mana_cost string (e.g. "{2}{U}{U}"), or null if this card has no Scryfall enrichment. */
  manaCost: string | null;
}

export interface CurveBucket {
  /** "0".."6", "7+", "Land", or "Unknown cost". */
  label: string;
  creatureCount: number;
  nonCreatureCount: number;
  cardIds: Array<{ cardId: number; quantity: number }>;
}

const PIP_RE = /\{([^}]+)\}/g;

/**
 * Parses a Scryfall-style mana cost string into its converted mana cost
 * (mana value). X/Y/Z count as 0 (standard curve convention - an X spell's
 * "cost" for curve purposes is whatever's paid for the fixed part only).
 * Hybrid/Phyrexian pips (e.g. "W/U", "B/P") count as 1, same as a single
 * colored pip - the common simplification, since either half alone would
 * pay it.
 */
export function manaValue(manaCost: string): number {
  let total = 0;
  let match: RegExpExecArray | null;
  PIP_RE.lastIndex = 0;
  while ((match = PIP_RE.exec(manaCost))) {
    const symbol = match[1];
    if (symbol === "X" || symbol === "Y" || symbol === "Z") continue;
    if (/^\d+$/.test(symbol)) {
      total += parseInt(symbol, 10);
      continue;
    }
    total += 1; // single colored/colorless pip, or a hybrid/Phyrexian pip
  }
  return total;
}

function bucketLabelFor(info: CardCurveInfo | undefined): string {
  if (!info) return "Unknown cost";
  if (info.types.includes("Land")) return "Land";
  if (info.manaCost === null) return "Unknown cost";
  const cmc = manaValue(info.manaCost);
  return cmc >= 7 ? "7+" : String(cmc);
}

/** Display order for groupByManaCurve's output - low-to-high cost, then Land, then Unknown cost. */
export const CURVE_BUCKET_ORDER = ["0", "1", "2", "3", "4", "5", "6", "7+", "Land", "Unknown cost"];

export function groupByManaCurve(mainDeck: Array<{ cardId: number; quantity: number }>, cardInfo: Map<number, CardCurveInfo>): CurveBucket[] {
  const buckets = new Map<string, CurveBucket>();
  for (const entry of mainDeck) {
    const info = cardInfo.get(entry.cardId);
    const label = bucketLabelFor(info);
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = { label, creatureCount: 0, nonCreatureCount: 0, cardIds: [] };
      buckets.set(label, bucket);
    }
    bucket.cardIds.push(entry);
    const isCreature = info?.types.includes("Creature") ?? false;
    if (isCreature) bucket.creatureCount += entry.quantity;
    else bucket.nonCreatureCount += entry.quantity;
  }
  return CURVE_BUCKET_ORDER.filter((label) => buckets.has(label)).map((label) => buckets.get(label)!);
}
