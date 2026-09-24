// Card data pulled from MTG Arena's own local card database, then enriched
// with Scryfall data. Kept separate from domain/types.ts's DomainEvents -
// this is reference/catalog data (what a grpId *is*), not something that
// happened during a game.

/** Raw shape extracted from Arena's own Raw_CardDatabase_*.mtga (see cardDbLocator.ts). */
export interface ArenaCard {
  grpId: number;
  name: string;
  /** e.g. "HOB", "MSH" - matches the set codes seen in draft/deck event data. */
  setCode: string;
  collectorNumber: string;
  /**
   * Arena's own internal rarity int - meaning not confirmed (no "Rarity" enum
   * found in Arena's own Enums table, and testing a small sample against
   * known real-world rarities didn't cleanly fit a simple 1=common..5=mythic
   * scale - e.g. a card believed to be a real-world common came back with
   * the same value as a card believed to be mythic). Kept as opaque/raw
   * rather than guessed-and-possibly-wrong; Scryfall's `rarity` string
   * (fetched during enrichment) is the trustworthy source for actual rarity.
   */
  rarityRaw: number;
  isToken: boolean;
  isDigitalOnly: boolean;
  isRebalanced: boolean;
  /** If this card is the "base" version of a rebalanced Alchemy card, the rebalanced (A-) card's grpId. 0/absent otherwise. */
  rebalancedCardGrpId: number | null;
}

/** ArenaCard enriched with Scryfall data, joined on Scryfall's arena_id == Arena's grpId. */
export interface EnrichedCard extends ArenaCard {
  scryfallId: string | null;
  oracleText: string | null;
  manaCost: string | null;
  colors: string[] | null;
  /** Scryfall's own rarity string ("common", "uncommon", "rare", "mythic", "special", "bonus") - the trustworthy one, unlike rarityRaw above. */
  scryfallRarity: string | null;
  imageSmall: string | null;
  imageNormal: string | null;
  imageLarge: string | null;
  imagePng: string | null;
  /** ISO timestamp of when this row was last enriched from Scryfall (null if never matched). */
  enrichedAt: string | null;
}
