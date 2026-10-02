/**
 * Which colors the opponent appears to be playing, inferred from what they
 * have shown this match: the basic lands they have played (the strongest
 * early signal) and the colors of the spells they have cast. Feeds the
 * overlay's set-card search so it can hide cards from colors they are not in.
 *
 * Pure: the caller supplies a lookup for card name/colors, since this layer
 * has no card catalog.
 */

export type ColorLetter = "W" | "U" | "B" | "R" | "G";

const WUBRG: ColorLetter[] = ["W", "U", "B", "R", "G"];

const BASIC_LAND_COLOR: Record<string, ColorLetter> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

export interface OpponentColorCard {
  name: string;
  colors?: string[];
  types?: string[];
}

export function basicLandColor(name: string): ColorLetter | null {
  return BASIC_LAND_COLOR[name.replace(/^Snow-Covered /, "")] ?? null;
}

/** The opponent's colors in WUBRG order; empty when nothing identifying has been shown yet. */
export function inferOpponentColors(grpIds: number[], lookup: (grpId: number) => OpponentColorCard | undefined): ColorLetter[] {
  const found = new Set<ColorLetter>();
  for (const grpId of grpIds) {
    const card = lookup(grpId);
    if (!card) continue;
    const land = basicLandColor(card.name);
    if (land) {
      found.add(land);
      continue;
    }
    if (card.types?.includes("Land")) continue; // non-basic lands carry no color info in the catalog
    for (const c of card.colors ?? []) if ((WUBRG as string[]).includes(c)) found.add(c as ColorLetter);
  }
  return WUBRG.filter((c) => found.has(c));
}
