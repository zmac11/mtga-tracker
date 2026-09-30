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

  // Milestone 17: was `(d) => d.deckId` - deckId stays the SAME across a
  // deck edit (only ts changes), so keying by deckId alone collapsed every
  // version of a deck down to whichever one happened to win the Map's
  // last-write-wins pass, throwing away the resubmission history
  // deriveDeckVersions needs (see eventHistory.ts/deckVersions.ts).
  // deckId+ts is still a safe natural key for the actual purpose of
  // dedupeBy here - collapsing an identical raw event that appears twice
  // because the whole log was replayed (`--from-start`), not real distinct
  // submissions, which never share both deckId and ts.
  const decks = dedupeBy(store.all("DeckSubmitted"), (d) => `${d.deckId}|${d.ts}`);
  const completions = dedupeBy(store.all("DraftCompleted"), (c) => c.courseId);
  const picks: DraftPickMade[] = store.all("DraftPickMade"); // buildEventRunHistory dedupes these itself, per (pack, pick), after filtering to a specific draftId
  const packsSeen = store.all("DraftPackSeen");
  const matchFounds = dedupeBy(store.all("MatchFound"), (m) => m.matchId);
  const matchCompletions = dedupeBy(store.all("MatchCompleted"), (m) => m.matchId);
  // Milestone 12: no dedup needed here - buildEventRunHistory only ever
  // reads the LATEST entry for a given eventId (see its comment), so
  // repeated/stale snapshots from a replayed log are harmless either way.
  const courseStandings = store.all("CourseStanding");
  // Milestone 17: entry cost + reward sources - same "replayed log" dedup
  // concern as the rest of this function, keyed on fields that are unique
  // per real occurrence but repeat identically on a `--from-start` replay.
  const joins = dedupeBy(store.all("DraftJoined"), (j) => `${j.eventName}|${j.ts}`);
  const rewards = dedupeBy(store.all("EventReward"), (r) => `${r.courseId}|${r.ts}`);
  // Milestone 18: Sealed-pool (and any other non-draft) card pool capture -
  // see EventCardPool in types.ts. Same replayed-log dedup concern as
  // joins/rewards above.
  const cardPools = dedupeBy(store.all("EventCardPool"), (p) => `${p.courseId}|${p.ts}`);
  // Milestone 21: generic reward-grant ledger - same id+ts dedup
  // convention as every other source above. ts has to stay part of the
  // key here specifically (unlike source+sourceId alone) - see
  // RewardGrant.sourceId's doc comment in types.ts: EventGrantCardPool's
  // SourceId is the literal eventId (not per-course), so the same
  // eventId played more than once in a day produces multiple real,
  // distinct grants sharing one sourceId; only ts tells them apart.
  const rewardGrants = dedupeBy(store.all("RewardGrant"), (g) => `${g.source}|${g.sourceId}|${g.ts}`);

  return { decks, completions, picks, packsSeen, matchFounds, matchCompletions, courseStandings, joins, rewards, cardPools, rewardGrants, myScreenName };
}
