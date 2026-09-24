import type { TypedEventStore } from "./db/sqliteStore.js";
import type { CardStore } from "./cards/cardStore.js";
import type { EnrichedCard } from "./cards/types.js";
import { buildEventRunHistory, listEventRuns } from "./domain/eventHistory.js";
import { loadEventHistorySource } from "./eventHistoryLoader.js";
import { deriveDeckColors } from "./domain/deckColors.js";
import type { DeckViewerData, ViewerCard } from "./deckViewerHtml.js";

/**
 * Thin loader between tracker.db/the cards table and the pure
 * deckViewerHtml.ts renderer - milestone 7 phase 4, same convention as
 * eventHistoryLoader.ts. Joins one event run's history (phase 2) against the
 * card catalog (milestone 4/phase 3) to build the exact data shape the
 * deck-viewer page needs. Returns null if this eventId has no data captured
 * at all (see listEventRuns) rather than rendering an empty/misleading page.
 */
export function buildDeckViewerData(eventId: string, store: TypedEventStore, cardStore: CardStore): DeckViewerData | null {
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
  const colorCombo = history.deck ? deriveDeckColors(history.deck.mainDeck, cardColors).comboKey : "(no deck captured)";

  return {
    eventId: history.eventId,
    format: history.identity.format,
    definitionLabel: history.identity.definitionLabel,
    deckName: history.deck?.deckName ?? null,
    colorCombo,
    winRate: history.winRate,
    mainDeck,
    sideboard,
  };
}
