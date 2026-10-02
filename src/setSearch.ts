import type { EnrichedCard } from "./cards/types.js";

/**
 * The compact per-set card list the overlay's search box filters in memory
 * while you type (a few hundred cards, ~50 KB). Short keys because it crosses
 * IPC as JSON: g = grpId, n = name, mc = mana cost ("{2}{R}"), c = colors
 * (WUBRG letters), t = types, r = rarity, o = oracle text.
 */
export interface SetSearchCard {
  g: number;
  n: string;
  mc: string | null;
  c: string[];
  t: string[];
  r: string | null;
  o: string | null;
}

const BASIC_LANDS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes", "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);

function collectorNumberValue(c: EnrichedCard): number {
  const n = parseInt(c.collectorNumber, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Real cards of one set: no tokens, no basic lands (searching for a Forest is
 * pointless), one entry per name (Arena stores art variants/reprints as
 * separate rows - the lowest collector number wins), sorted by name.
 */
export function buildSetSearchCards(allCards: EnrichedCard[], setCode: string): SetSearchCard[] {
  const wanted = setCode.toUpperCase();
  const byName = new Map<string, EnrichedCard>();
  for (const c of allCards) {
    if (c.setCode.toUpperCase() !== wanted || c.isToken || BASIC_LANDS.has(c.name)) continue;
    const existing = byName.get(c.name);
    if (!existing || collectorNumberValue(c) < collectorNumberValue(existing)) byName.set(c.name, c);
  }
  return [...byName.values()]
    .map((c) => ({
      g: c.grpId,
      n: c.name,
      mc: c.manaCost,
      c: c.colors.length > 0 ? c.colors : (c.scryfallColors ?? []),
      t: c.types,
      r: c.scryfallRarity,
      o: c.oracleText,
    }))
    .sort((a, b) => a.n.localeCompare(b.n));
}
