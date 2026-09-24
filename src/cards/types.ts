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
  /**
   * Decoded from Arena's own `Cards.Colors` column (a comma-separated list of
   * small integers, joined against the `Enums` table's "Color" type to
   * confirm the standard WUBRG mapping: 1=White, 2=Blue, 3=Black, 4=Red,
   * 5=Green - verified 2026-09-24 against the real sample card database,
   * including that basic lands correctly come back colorless). Always an
   * array (empty for colorless cards/lands), sorted in WUBRG order, and
   * available without any Scryfall enrichment - the primary/reliable color
   * source for this project (see EnrichedCard.scryfallColors below for the
   * Scryfall-sourced equivalent, kept only for reference/cross-checking).
   */
  colors: string[];
  /**
   * Decoded from Arena's own `Cards.Types` column (comma-separated small
   * integers, joined against the `Enums` table's "CardType" type - confirmed
   * 2026-09-24 against the real sample database: 1=Artifact, 2=Creature,
   * 3=Enchantment, 4=Instant, 5=Land, 6=Phenomenon, 7=Plane, 8=Planeswalker,
   * 9=Scheme, 10=Sorcery, 11=Kindred, 12=Vanguard, 13=Dungeon, 14=Battle,
   * 15=Conspiracy). Always an array (rarely empty in practice). Like
   * `colors`, available without any Scryfall enrichment - used for the
   * milestone 7 phase 4 deck viewer's creature/non-creature curve mode.
   */
  types: string[];
}

/** ArenaCard enriched with Scryfall data, joined on Scryfall's arena_id == Arena's grpId. */
export interface EnrichedCard extends ArenaCard {
  scryfallId: string | null;
  oracleText: string | null;
  manaCost: string | null;
  /**
   * Scryfall's own `colors` field - kept separate from ArenaCard.colors
   * (renamed here to avoid the two colliding) since Scryfall enrichment is
   * unconfirmed to actually run end-to-end on the user's machine (see the
   * doc comment atop scryfallEnrich.ts), while Arena's own decoded colors
   * are always available. Null whenever this card has no Scryfall match, or
   * enrichment hasn't been run at all.
   */
  scryfallColors: string[] | null;
  /** Scryfall's own rarity string ("common", "uncommon", "rare", "mythic", "special", "bonus") - the trustworthy one, unlike rarityRaw above. */
  scryfallRarity: string | null;
  imageSmall: string | null;
  imageNormal: string | null;
  imageLarge: string | null;
  imagePng: string | null;
  /** ISO timestamp of when this row was last enriched from Scryfall (null if never matched). */
  enrichedAt: string | null;
}
