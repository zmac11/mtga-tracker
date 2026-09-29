export type ColorLetter = "W" | "U" | "B" | "R" | "G";

const WUBRG_ORDER: ColorLetter[] = ["W", "U", "B", "R", "G"];

export interface DeckColorProfile {
  colors: ColorLetter[];
  comboKey: string;
  cardCounts: Partial<Record<ColorLetter, number>>;
  /**
   * Milestone 15: colors that show up in the maindeck but don't clear
   * minCardsForColor - a likely splash rather than a real deck color (see
   * the user's own framing: "if there are two or fewer cards of a color, do
   * not count it as color of deck ... you can display there color as splash
   * colors, not a main deck ones"). Always sorted WUBRG, and disjoint from
   * `colors` - a color is either a main color or a splash, never both.
   * `cardCounts` already tracked these counts before this field existed
   * (see deckColors.test.ts); this just names the subset worth calling out
   * separately for display.
   */
  splashColors: ColorLetter[];
}

/** Below this many maindeck cards of a color, it's treated as a splash rather than a deck color - see DeckColorProfile.splashColors. */
export const MIN_CARDS_FOR_COLOR = 3;

/**
 * Milestone 7 phase 3: derives a deck's color identity from its maindeck
 * card list - sums each WUBRG color's card count (a multicolor card
 * contributes to every color it has), then keeps only colors that clear
 * `minCardsForColor` as the deck's "real" colors (comboKey/colors);
 * anything below that bar is still tallied in cardCounts, and, as of
 * milestone 15, also called out by name in splashColors so callers that
 * want to show "WU (splash: R)" rather than just silently dropping the
 * one-off red card can do so.
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
  const splashColors = WUBRG_ORDER.filter((letter) => {
    const n = counts.get(letter) ?? 0;
    return n > 0 && n < minCardsForColor;
  });
  const comboKey = colors.length === 0 ? "Colorless" : colors.length === 1 ? `Mono-${colors[0]}` : colors.join("");
  const cardCounts: Partial<Record<ColorLetter, number>> = {};
  for (const [letter, n] of counts) cardCounts[letter] = n;
  return { colors, comboKey, cardCounts, splashColors };
}
