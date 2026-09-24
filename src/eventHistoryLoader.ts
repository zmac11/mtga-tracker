import type { TypedEventStore } from "./db/sqliteStore.js";
import type { EventHistorySource } from "./domain/eventHistory.js";
import type { DraftPickMade } from "./domain/types.js";

/**
 * Thin loader between tracker.db and the pure domain/eventHistory.ts
 * functions - deliberately kept separate from domain/ (which stays
 * DB-free/plain-array so it's unit-testable) and separate from report.ts
 * (a script, not a reusable module). report.ts and any future consumer
 * (the planned deck-viewer/draft-history UI) both build an
 * EventHistorySource by calling this once and reuse it for as many event
 * runs as they need.
 *
 * Same natural-key de-dup as report.ts's own reads: re-running
 * `npm start -- --from-start` re-appends the whole replayed log each time
 * (milestone-1's raw store has no de-dup), so the same real draft/match can
 * appear more than once in the raw data.
 */
export function loadEventHistorySource(store: TypedEventStore): EventHistorySource {
  const dedupeBy = <T>(items: T[], keyFn: (item: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const item of items) map.set(keyFn(item), item);
    return [...map.values()];
  };

  const identified = store.all("PlayerIdentified");
  const myScreenName = identified.at(-1)?.screenName ?? null;

  const decks = dedupeBy(store.all("DeckSubmitted"), (d) => d.deckId);
  const completions = dedupeBy(store.all("DraftCompleted"), (c) => c.courseId);
  const picks: DraftPickMade[] = store.all("DraftPickMade"); // buildEventRunHistory dedupes these itself, per (pack, pick), after filtering to a specific draftId
  const packsSeen = store.all("DraftPackSeen");
  const matchFounds = dedupeBy(store.all("MatchFound"), (m) => m.matchId);
  const matchCompletions = dedupeBy(store.all("MatchCompleted"), (m) => m.matchId);

  return { decks, completions, picks, packsSeen, matchFounds, matchCompletions, myScreenName };
}
