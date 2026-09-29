import type { TypedEventStore } from "./db/sqliteStore.js";
import type { CardStore } from "./cards/cardStore.js";
import type { EnrichedCard } from "./cards/types.js";
import { buildEventRunHistory, listEventRuns } from "./domain/eventHistory.js";
import { loadEventHistorySource } from "./eventHistoryLoader.js";
import { deriveDeckColors } from "./domain/deckColors.js";
import { attributeDraftWheel } from "./domain/draftWheel.js";
import { averageManaValue, type CardCurveInfo } from "./domain/manaCurve.js";
import type { DeckViewerData, DeckViewerVersion, DraftViewerPick, DraftViewerPickCard, ViewerCard } from "./deckViewerHtml.js";

/**
 * Thin loader between tracker.db/the cards table and the pure
 * deckViewerHtml.ts renderer - milestone 7 phase 4, same convention as
 * eventHistoryLoader.ts. Joins one event run's history (phase 2) against the
 * card catalog (milestone 4/phase 3) to build the exact data shape the
 * deck-viewer page needs. Returns null if this eventId has no data captured
 * at all (see listEventRuns) rather than rendering an empty/misleading page.
 *
 * Milestone 13: `cardImageWidthPx` is the user's chosen "Card size" setting
 * (see electron/main.ts's CARD_SIZE_PRESETS/get-overlay-settings) for the
 * deck viewer's "Visual" tab - passed straight through into DeckViewerData
 * so generateDeckViewerHtml can bake it into the page as a CSS variable.
 * Optional (defaults to deckViewerHtml.ts's own DEFAULT_CARD_IMAGE_WIDTH_PX)
 * so callers that don't care about card size - e.g. this file's own tests,
 * if any are added later - don't need to pass it.
 *
 * Milestone 15 (2026-09-29): calls deriveDeckColors once and threads both
 * fields it returns that this page cares about - comboKey (unchanged,
 * still colorCombo) and the new splashColors - through to DeckViewerData,
 * instead of calling it just for .comboKey and dropping the rest.
 */
export function buildDeckViewerData(eventId: string, store: TypedEventStore, cardStore: CardStore, cardImageWidthPx?: number): DeckViewerData | null {
  const source = loadEventHistorySource(store);
  const knownRuns = listEventRuns(source);
  if (!knownRuns.some((r) => r.eventId === eventId)) return null;

  const history = buildEventRunHistory(eventId, source);

  const cardColors = new Map<number, string[]>();
  const cardsById = new Map<number, EnrichedCard>();
  for (const c of cardStore.all()) {
    cardColors.set(c.grpId, c.colors);
    cardsById.set(c.grpId, c);
  }

  const toViewerCards = (entries: Array<{ cardId: number; quantity: number }> | null): ViewerCard[] | null => {
    if (entries === null) return null;
    return entries.map((entry) => {
      const c = cardsById.get(entry.cardId);
      return {
        cardId: entry.cardId,
        quantity: entry.quantity,
        name: c?.name ?? `Unknown card #${entry.cardId} (run npm run refresh-cards)`,
        colors: c?.colors ?? [],
        types: c?.types ?? [],
        manaCost: c?.manaCost ?? null,
        oracleText: c?.oracleText ?? null,
        imageNormal: c?.imageNormal ?? null,
      };
    });
  };

  const mainDeck = toViewerCards(history.deck?.mainDeck ?? []) ?? [];
  const sideboard = toViewerCards(history.deck?.sideboard ?? null);
  const deckColorProfile = history.deck ? deriveDeckColors(history.deck.mainDeck, cardColors) : null;
  const colorCombo = deckColorProfile?.comboKey ?? "(no deck captured)";
  const splashColors = deckColorProfile?.splashColors ?? [];

  // Milestone 17: average mana value - same cardInfo shape curveHtml/
  // groupByManaCurve already build from ViewerCards, built here straight
  // from the raw mainDeck entries (cardsById, not the mapped ViewerCards)
  // since averageManaValue only needs types/manaCost, not the full card.
  const cardCurveInfo = new Map<number, CardCurveInfo>();
  for (const c of cardStore.all()) cardCurveInfo.set(c.grpId, { types: c.types, manaCost: c.manaCost });
  const avgManaValue = history.deck ? averageManaValue(history.deck.mainDeck, cardCurveInfo) : undefined;

  // Milestone 17: every played deck version, resolved to full ViewerCards
  // via the same toViewerCards helper the current deck uses above - so a
  // version in the "Versions" tab renders identically to the "Deck list"
  // tab, just scoped to that version's own mainDeck/win-loss record.
  const versions: DeckViewerVersion[] = history.deckVersions.map((v) => ({
    versionNumber: v.versionNumber,
    submittedAt: v.submittedAt,
    winRate: v.winRate,
    mainDeck: toViewerCards(v.mainDeck) ?? [],
  }));

  const entry = history.entry ?? null;
  const reward = history.reward
    ? { gems: history.reward.gems, gold: history.reward.gold, boosters: history.reward.boosters, grantedCardCount: history.reward.grantedCardCount }
    : null;

  const toDraftCard = (cardId: number): DraftViewerPickCard => {
    const c = cardsById.get(cardId);
    return {
      cardId,
      name: c?.name ?? `Unknown card #${cardId} (run npm run refresh-cards)`,
      colors: c?.colors ?? [],
      oracleText: c?.oracleText ?? null,
      imageNormal: c?.imageNormal ?? null,
    };
  };
  const draft: DraftViewerPick[] = attributeDraftWheel(history.picks, history.packsSeen).map((a) => ({
    pack: a.pack,
    pick: a.pick,
    packCards: a.packCards.map(toDraftCard),
    pickedCardIds: a.grpIds,
    wheeledAt: a.wheel.wheeledAt,
    takenByOthers: a.wheel.takenByOthers.map(toDraftCard),
  }));

  return {
    eventId: history.eventId,
    format: history.identity.format,
    definitionLabel: history.identity.definitionLabel,
    deckName: history.deck?.deckName ?? null,
    colorCombo,
    splashColors,
    winRate: history.winRate,
    mainDeck,
    sideboard,
    draft,
    ...(cardImageWidthPx !== undefined ? { cardImageWidthPx } : {}),
    ...(avgManaValue !== undefined ? { avgManaValue } : {}),
    versions,
    entry,
    reward,
  };
}
