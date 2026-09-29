import type { DraftPackSeen, DraftPickMade, DeckSubmitted, DraftCompleted, MatchFound, MatchCompleted, CourseStanding, DraftJoined, EventReward } from "./types.js";
import { computeMatchOutcomes, latestStandingByEvent, reconcileWinRate, winRate, type MatchOutcome, type WinRate } from "./rollups.js";
import { parseEventIdentity, type EventIdentity } from "./eventIdentity.js";
import { deriveDeckVersions, type DeckVersion } from "./deckVersions.js";

/**
 * Per-event-run history layer (milestone 7 phase 2): for one specific dated
 * event run (one exact eventId, e.g. "ContenderDraft_HOB_20260824"), pulls
 * together its deck, its draft pick sequence, and its matches into one
 * place - the data layer the planned deck-viewer/draft-history UI (phases
 * 4-5) will read from. No UI here, just the query - and deliberately plain
 * functions over arrays (like rollups.ts/classifier.ts), not a TypedEventStore
 * dependency, so this stays unit-testable without a real database. See
 * eventHistoryLoader.ts for the thin layer that actually reads from
 * tracker.db and feeds these.
 */

export interface EventRunDeck {
  deckId: string;
  deckName: string;
  mainDeck: Array<{ cardId: number; quantity: number }>;
  /**
   * Derived, not something Arena sends directly: the drafted pool
   * (DraftCompleted.cardPool) minus whatever's in mainDeck, by grpId count.
   * Null when there's no DraftCompleted for this run to derive it from
   * (deck submission alone doesn't tell us the rest of the pool).
   */
  sideboard: Array<{ cardId: number; quantity: number }> | null;
}

export interface EventRunHistory {
  identity: EventIdentity;
  eventId: string;
  deck: EventRunDeck | null;
  /** Full drafted card pool (grpIds, duplicates included e.g. for basics), from DraftCompleted - null if not captured for this run. */
  cardPool: number[] | null;
  /**
   * Draft pick sequence in (pack, pick) order, deduped to the latest/most-
   * confirmed entry per (pack, pick) - same convention report.ts already
   * uses. Empty if this run has no linked draft data (e.g. it never reached
   * DraftCompleted and no matching draftId was found - see the draftId
   * join note in buildEventRunHistory below).
   */
  picks: DraftPickMade[];
  /** The packs as first seen, in (pack, pick) order, same dedup approach. */
  packsSeen: DraftPackSeen[];
  matches: MatchOutcome[];
  /**
   * This run's OVERALL win rate - reconciled against CourseStanding the
   * same as always (see below). Milestone 17 adds per-version breakdowns
   * (deckVersions) alongside this, but this total is deliberately left
   * computed exactly as before: it is NOT the sum of the per-version
   * records (those are unreconciled local counts - see deckVersions.ts's
   * file header for why).
   */
  winRate: WinRate;
  /**
   * Milestone 17: every played deck configuration for this run, in
   * submission order, each with its own local win/loss record - only
   * populated with versions that were actually played (see
   * deriveDeckVersions). Most runs will have exactly one entry here (the
   * deck never changed) or zero (no deck submission captured at all) -
   * more than one means the player changed their deck mid-event and
   * played at least one game with more than one configuration.
   */
  deckVersions: DeckVersion[];
  /** Milestone 17: what it cost to join this run, from DraftJoined - null if no join was captured (currency type is format-agnostic despite the field name, see classifier.ts). */
  entry: { currencyType: string; amountPaid: number } | null;
  /** Milestone 17: this run's prize claim, if any was captured - see EventReward in types.ts for which fields are confirmed vs. best-effort. */
  reward: EventReward | null;
}

export interface EventHistorySource {
  decks: DeckSubmitted[];
  completions: DraftCompleted[];
  picks: DraftPickMade[];
  packsSeen: DraftPackSeen[];
  matchFounds: MatchFound[];
  matchCompletions: MatchCompleted[];
  /** Milestone 17: entry-cost source (DraftJoined - format-agnostic despite the name, see classifier.ts). Not pre-filtered/deduped; buildEventRunHistory picks the relevant one(s) itself. */
  joins: DraftJoined[];
  /** Milestone 17: prize-claim source (EventClaimPrize - see classifier.ts/types.ts). Not pre-filtered/deduped. */
  rewards: EventReward[];
  /**
   * Arena's own authoritative win/loss snapshots (milestone 6's backstop -
   * see CourseStanding in types.ts), added in milestone 12 so a per-run
   * winRate computed here can be reconciled the same way the overlay's
   * live eventRecord already is - see buildEventRunHistory below. Order
   * doesn't need to be pre-filtered/deduped by the caller; only the LATEST
   * entry for a given eventId is ever used (any earlier duplicates or
   * stale snapshots for that event are simply ignored).
   */
  courseStandings: CourseStanding[];
  myScreenName: string | null;
}

function dedupeLatestByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

/**
 * Builds the full history for one specific event run. `eventId` is the raw
 * dated eventId/eventName (e.g. "ContenderDraft_HOB_20260824") - the "run"
 * granularity, not the coarser "event type" grouping from eventIdentity.ts.
 */
export function buildEventRunHistory(eventId: string, source: EventHistorySource): EventRunHistory {
  const identity = parseEventIdentity(eventId);

  const completion = source.completions.find((c) => c.eventName === eventId) ?? null;

  // Milestone 17: was `source.decks.find(...)` - the FIRST DeckSubmitted
  // for this run, i.e. the ORIGINAL deck, not the current one, whenever a
  // player edited their deck mid-event (find() returns array order, which
  // is chronological - see sqliteStore.ts's `ORDER BY id ASC`). Every
  // submission for this run is now kept (decksForRun) so deriveDeckVersions
  // can see the full history; "the current deck" is still just the latest
  // one, by ts, for every other field below that expects a single deck.
  const decksForRun = source.decks.filter((d) => d.eventName === eventId);
  const deckSubmission = decksForRun.length > 0 ? [...decksForRun].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)! : null;

  // DraftPickMade/DraftPackSeen are linked by draftId, not eventId directly
  // (see types.ts's comment on DraftPackSeen.draftId). DraftCompleted.draftId
  // is the confirmed link when we have it (verified 2026-09-24 against the
  // real captured ContenderDraft run - its DraftCompleted.draftId correctly
  // matched every one of its DraftPickMade/DraftPackSeen rows). When there's
  // no DraftCompleted (e.g. the draft never finished, or wasn't captured),
  // fall back to the eventId itself - the real, confirmed draftId value for
  // Bot Draft specifically (its DraftPickMade.draftId IS the eventName), and
  // a safe no-op guess for anything else (a non-matching fallback just
  // yields zero picks rather than attributing the wrong ones).
  const draftId = completion?.draftId ?? eventId;

  const picksForRun = source.picks.filter((p) => p.draftId === draftId);
  const picks = dedupeLatestByKey(picksForRun, (p) => `${p.pack}|${p.pick}`).sort((a, b) => a.pack - b.pack || a.pick - b.pick);

  const packsForRun = source.packsSeen.filter((p) => p.draftId === draftId);
  const packsSeen = dedupeLatestByKey(packsForRun, (p) => `${p.pack}|${p.pick}`).sort((a, b) => a.pack - b.pack || a.pick - b.pick);

  let deck: EventRunDeck | null = null;
  if (deckSubmission) {
    let sideboard: Array<{ cardId: number; quantity: number }> | null = null;
    if (completion) {
      const poolCounts = new Map<number, number>();
      for (const grpId of completion.cardPool) poolCounts.set(grpId, (poolCounts.get(grpId) ?? 0) + 1);
      for (const entry of deckSubmission.mainDeck) {
        poolCounts.set(entry.cardId, (poolCounts.get(entry.cardId) ?? 0) - entry.quantity);
      }
      sideboard = [...poolCounts.entries()].filter(([, qty]) => qty > 0).map(([cardId, quantity]) => ({ cardId, quantity }));
    }
    deck = { deckId: deckSubmission.deckId, deckName: deckSubmission.deckName, mainDeck: deckSubmission.mainDeck, sideboard };
  }

  const allOutcomes = computeMatchOutcomes(source.matchFounds, source.matchCompletions, source.myScreenName);
  const matches = allOutcomes.filter((o) => o.eventId === eventId);

  // Reconciled against Arena's own EventGetCoursesV2 record the same way
  // the overlay's live eventRecord already is (milestone 6) - see
  // reconcileWinRate's comment for why this exists: without it, this
  // per-run record could (and did, for a real event affected by the
  // log-rotation bug) show a different, lower number than the overlay for
  // the exact same event, purely because local capture missed a match
  // Arena's own bookkeeping still had. latestStandingByEvent picks the
  // LATEST CourseStanding captured for this eventId, since
  // source.courseStandings isn't pre-filtered to one entry per event.
  const standing = latestStandingByEvent(source.courseStandings).get(eventId) ?? null;

  // Milestone 17: per-version breakdown, built from the FULL submission
  // history for this run (not just the latest) plus this run's matches -
  // see deckVersions.ts. Deliberately independent of the `deck`/`winRate`
  // computed above; the total win rate above stays the authoritative,
  // reconciled figure regardless of how many versions this expands to.
  const deckVersions = deriveDeckVersions(decksForRun, matches);

  // Entry cost: a run can in principle have more than one DraftJoined (e.g.
  // if a player left and rejoined) - the latest one is what actually paid
  // for the run currently in progress/completed.
  const joinsForRun = source.joins.filter((j) => j.eventName === eventId);
  const latestJoin = joinsForRun.length > 0 ? [...joinsForRun].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)! : null;
  const entry = latestJoin ? { currencyType: latestJoin.entryCurrencyType, amountPaid: latestJoin.entryCurrencyPaid } : null;

  // Reward: normally at most one claim per run, but take the latest if
  // more than one was somehow captured, same convention as entry above.
  const rewardsForRun = source.rewards.filter((r) => r.eventId === eventId);
  const reward = rewardsForRun.length > 0 ? [...rewardsForRun].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)! : null;

  return {
    identity,
    eventId,
    deck,
    cardPool: completion?.cardPool ?? null,
    picks,
    packsSeen,
    matches,
    winRate: reconcileWinRate(winRate(matches), standing),
    deckVersions,
    entry,
    reward,
  };
}

/**
 * Every distinct event run we have any data for at all (a draft completion,
 * a deck submission, or a match), each with its parsed identity - the index
 * a future "pick an event run to view" UI would list from.
 */
export function listEventRuns(source: EventHistorySource): Array<{ eventId: string; identity: EventIdentity }> {
  const ids = new Set<string>();
  for (const c of source.completions) ids.add(c.eventName);
  for (const d of source.decks) ids.add(d.eventName);
  for (const m of source.matchFounds) if (m.eventId) ids.add(m.eventId);
  return [...ids].map((eventId) => ({ eventId, identity: parseEventIdentity(eventId) }));
}
