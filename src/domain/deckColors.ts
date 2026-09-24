// Derives a deck's color identity/combination from its maindeck's cards'
// Arena-decoded colors (see cards/extractArenaCards.ts's decodeArenaColors) -
// milestone 7 phase 3. Deliberately plain functions over a cardId->colors
// map, not a CardStore dependency, so this stays unit-testable without a
// real database (same convention as rollups.ts/eventHistory.ts).

export type ColorLetter = "W" | "U" | "B" | "R" | "G";
const WUBRG_ORDER: ColorLetter[] = ["W", "U", "B", "R", "G"];

export interface DeckColorProfile {
  /** This deck's "real" colors, sorted WUBRG - see MIN_CARDS_FOR_COLOR below for what counts. */
  colors: ColorLetter[];
  /** A stable grouping key: "Colorless", "Mono-W", "UR", "WUBRG", etc. */
  comboKey: string;
  /** Maindeck card count (by quantity) contributing each color - lets a caller see what got filtered out as a splash. */
  cardCounts: Partial<Record<ColorLetter, number>>;
}

/**
 * A color only counts as one of the deck's "real" colors if at least this
 * many maindeck cards (by quantity) contribute it - filters out a single
 * fixing land, hybrid card, or true one-card splash from skewing e.g. a
 * mono-white deck into looking like "WU". Not a perfect heuristic (a
 * genuine 2-card splash won't count either, and this has no way to see mana
 * costs/pips - only which colors a card's identity includes, from Arena's
 * own per-card Colors field), but a simple, documented starting point.
 */
export const MIN_CARDS_FOR_COLOR = 3;

/**
 * `cardColors` maps a card's Arena grpId to its decoded colors (see
 * ArenaCard.colors) - typically built once from CardStore.all() and reused
 * across many decks. Cards missing from the map (e.g. the `cards` table
 * hasn't been refreshed yet) are treated as colorless/unknown rather than
 * throwing, so a stale or partial card catalog degrades gracefully instead
 * of blocking the whole report.
 */
export function deriveDeckColors(
  mainDeck: Array<{ cardId: number; quantity: number }>,
  cardColors: Map<number, string[]>,
  minCardsForColor: number = MIN_CARDS_FOR_COLOR,
): DeckColorProfile {
  const counts = new Map<ColorLetter, number>();
  for (const entry of mainDeck) {
    const colors = cardColors.get(entry.cardId);
    if (!colors) continue;
    for (const c of colors) {
      if (!(WUBRG_ORDER as string[]).includes(c)) continue;
      const letter = c as ColorLetter;
      counts.set(letter, (counts.get(letter) ?? 0) + entry.quantity);
    }
  }

  const colors = WUBRG_ORDER.filter((letter) => (counts.get(letter) ?? 0) >= minCardsForColor);
  const comboKey = colors.length === 0 ? "Colorless" : colors.length === 1 ? `Mono-${colors[0]}` : colors.join("");
  const cardCounts: Partial<Record<ColorLetter, number>> = {};
  for (const [letter, n] of counts) cardCounts[letter] = n;

  return { colors, comboKey, cardCounts };
}
