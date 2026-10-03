import type { DraftPackSeen, DraftPickMade, DeckSubmitted, DraftCompleted, MatchFound, MatchCompleted, CourseStanding, DraftJoined, EventReward, EventCardPool, RewardGrant, GameHandResolved, CardPlayedInGame, GameStateSnapshot, ManualCourseResult } from "./types.js";
import { computeMatchOutcomes, latestStandingByEvent, reconcileWinRate, winRate, winRateFromCounts, type MatchOutcome, type WinRate } from "./rollups.js";
import { parseEventIdentity, resolveEventFormat, type EventIdentity, type EventFormat } from "./eventIdentity.js";
import { deriveDeckVersions, type DeckVersion } from "./deckVersions.js";
import { buildCourseWindows, assignCourseId, compareTs, DECK_SUBMIT_LEAD_MS, type CourseWindow } from "./courseRuns.js";

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
   * Milestone 18: prefers the REAL sideboard Arena returned with the deck
   * submission itself (DeckSubmitted.sideboard - see its doc comment in
   * types.ts) when one was captured - which is now the normal case for any
   * submission captured after this milestone, and the ONLY possible source
   * for a Constructed deck (there's no pool to derive one from). Falls
   * back to the older derivation (drafted/opened pool minus mainDeck, by
   * grpId count - using DraftCompleted.cardPool or, since milestone 18,
   * EventCardPool for a non-draft pool source like Sealed) only for a
   * submission captured before the real sideboard field existed. Null when
   * neither a real sideboard nor a pool to derive one from is available.
   */
  sideboard: Array<{ cardId: number; quantity: number }> | null;
}

export interface EventRunHistory {
  identity: EventIdentity;
  /**
   * Milestone 18: this run's format, resolved via resolveEventFormat -
   * prefers the deck's own real Format attribute over identity.format's
   * name-based guess when a deck was captured. Distinct from
   * identity.format on purpose: identity.format is also what the coarser
   * cross-run rollups (rollupByFormat/rollupByEventDefinition in
   * rollups.ts) group by, and changing THEIR bucketing to be deck-aware
   * would need deck data threaded through those too - out of scope for
   * this milestone (see the project doc). This field is for a single run's
   * own display (report.ts's --event= detail, the deck viewer) only.
   */
  format: EventFormat;
  eventId: string;
  /**
   * Milestone 19: the specific courseId this history was scoped to, when
   * the caller disambiguated one (see buildEventRunHistory's `courseId`
   * param and courseRuns.ts) - null when either no disambiguation was
   * requested, or only one courseId (or none at all) was ever seen for
   * this eventId, meaning there was nothing to disambiguate. Most runs
   * will have this null forever.
   */
  courseId: string | null;
  /** Milestone 19: when courseId above is non-null, the ts this specific course's window started at (its earliest CourseStanding/DraftCompleted/EventCardPool/EventReward) - for a human-readable "which run is this" label (see deckViewerLoader.ts). Null whenever courseId is null. */
  runStartedAt: string | null;
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
  /** Milestone 18: Sealed (and any other non-draft) card-pool source - see EventCardPool in types.ts. Not pre-filtered/deduped; buildEventRunHistory picks the latest for a given eventId itself, same convention as courseStandings below. */
  cardPools: EventCardPool[];
  /**
   * Arena's own authoritative win/loss snapshots (milestone 6's backstop -
   * see CourseStanding in types.ts), added in milestone 12 so a per-run
   * winRate computed here can be reconciled the same way the overlay's
   * live eventRecord already is - see buildEventRunHistory below. Order
   * doesn't need to be pre-filtered/deduped by the caller; only the LATEST
   * entry for a given eventId (or eventId+courseId - see milestone 19) is
   * ever used (any earlier duplicates or stale snapshots are ignored).
   */
  courseStandings: CourseStanding[];
  /**
   * Milestone 21: the generic "everything the account was ever granted"
   * ledger (see RewardGrant's doc comment in types.ts) - NOT pre-filtered
   * by event, and NOT restricted to genuinely-earned sources (it also
   * includes EventGrantCardPool/EventPayEntry, which are a purchase and a
   * cost respectively, not a reward). Used only by rewardHistory.ts's
   * account-wide "overall rewards earned" rollup, which is what applies
   * the earned-vs-not categorization - this field is deliberately raw.
   */
  rewardGrants: RewardGrant[];
  /**
   * Milestone 23 (features e/f): "was this card in my opening hand" / "...
   * played during the match" sources - see classifier.ts's
   * classifyHandAndPlayedCards. Dataset-wide and NOT pre-filtered by
   * match/event, same convention as picks/packsSeen above; consumers
   * (cardSituationalWinRate.ts's buildCardSituationalWinRateRows, via its
   * own matchId|gameNumber|seat keying) do their own joining.
   */
  handEvents: GameHandResolved[];
  playedEvents: CardPlayedInGame[];
  /**
   * Milestone 24 (2026-10-01): "number of turns displayed for each match"
   * plus average-turns breakdowns - the raw source matchDetails.ts's
   * buildMatchGameDetails needs (it already computed per-game turnCount
   * since milestone 20, just never threaded through this loader - every
   * caller that wants per-game turn detail alongside a match/run needs
   * both this AND matchFounds/myScreenName, already present below).
   * Dataset-wide and NOT pre-filtered, same convention as every other
   * source here.
   */
  gameStateSnapshots: GameStateSnapshot[];
  /**
   * Milestone 25: user-entered corrections for runs the tracker's own
   * detection never saw reach a final state - see ManualCourseResult's
   * doc comment in types.ts and domain/eventClosure.ts. NOT pre-filtered;
   * buildEventRunHistory looks up the one (if any) for its own
   * (eventId, courseId) itself, same convention as courseStandings.
   */
  manualResults: ManualCourseResult[];
  myScreenName: string | null;
}

function dedupeLatestByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

/**
 * Milestone 19: gathers every {courseId, ts} signal for one eventId, from
 * the four event kinds that actually carry a real courseId (see
 * courseRuns.ts's header comment for why MatchFound/DeckSubmitted/
 * DraftJoined can't contribute here), and turns them into ordered time
 * windows. `windows.length <= 1` is the "nothing to disambiguate" signal
 * every filter below checks before applying any courseId-based filtering,
 * so a normal event (one courseId, or literally zero signal at all) is
 * completely unaffected by any of this.
 */
export function courseWindowsForEvent(eventId: string, source: EventHistorySource): CourseWindow[] {
  const signals: Array<{ courseId: string; ts: string }> = [
    ...source.courseStandings.filter((s) => s.eventId === eventId).map((s) => ({ courseId: s.courseId, ts: s.ts })),
    ...source.completions.filter((c) => c.eventName === eventId).map((c) => ({ courseId: c.courseId, ts: c.ts })),
    ...source.cardPools.filter((p) => p.eventId === eventId).map((p) => ({ courseId: p.courseId, ts: p.ts })),
    ...source.rewards.filter((r) => r.eventId === eventId).map((r) => ({ courseId: r.courseId, ts: r.ts })),
  ];
  return buildCourseWindows(signals);
}

/**
 * Builds the full history for one specific event run. `eventId` is the raw
 * dated eventId/eventName (e.g. "ContenderDraft_HOB_20260824") - the "run"
 * granularity, not the coarser "event type" grouping from eventIdentity.ts.
 *
 * Milestone 19: `courseId`, when passed, scopes this to just that one
 * course's data - for the (rare) case where Arena reused this eventId
 * across more than one genuinely separate course (see courseRuns.ts).
 * Left `undefined` (the default - every call site from before this
 * milestone), behavior is EXACTLY what it always was: every match/deck/
 * join/etc. for this eventId, regardless of course, blended together (the
 * pre-existing behavior for a collided eventId, still what report.ts's
 * `--event=` gets since it hasn't been updated to pass a courseId - see
 * its own comment). Passing `courseId` (a real one from listEventRuns, or
 * explicitly `null` for "the sole/undisambiguated run") only changes
 * anything when courseWindowsForEvent finds more than one window; a
 * normal single-course event behaves identically either way.
 */
export function buildEventRunHistory(eventId: string, source: EventHistorySource, courseId?: string | null): EventRunHistory {
  const identity = parseEventIdentity(eventId);

  const windows = courseId !== undefined ? courseWindowsForEvent(eventId, source) : [];
  const disambiguating = windows.length > 1;
  // For the 4 kinds that carry a real courseId, filter by direct equality -
  // more precise than the ts heuristic below, since these don't need one.
  const matchesCourseId = <T extends { courseId: string }>(item: T): boolean => !disambiguating || item.courseId === courseId;
  // For everything else (no real courseId field to check - see this file's
  // and courseRuns.ts's header comments), fall back to the ts window.
  const matchesCourseWindow = (ts: string): boolean => !disambiguating || assignCourseId(ts, windows) === courseId;

  const runStartedAt = disambiguating ? (windows.find((w) => w.courseId === courseId)?.startTs ?? null) : null;

  const completion = source.completions.find((c) => c.eventName === eventId && matchesCourseId(c)) ?? null;

  // Milestone 17: was `source.decks.find(...)` - the FIRST DeckSubmitted
  // for this run, i.e. the ORIGINAL deck, not the current one, whenever a
  // player edited their deck mid-event (find() returns array order, which
  // is chronological - see sqliteStore.ts's `ORDER BY id ASC`). Every
  // submission for this run is now kept (decksForRun) so deriveDeckVersions
  // can see the full history; "the current deck" is still just the latest
  // one, by ts, for every other field below that expects a single deck.
  const matchesDeckWindow = (ts: string): boolean => !disambiguating || assignCourseId(ts, windows, DECK_SUBMIT_LEAD_MS) === courseId;
  const decksForRun = source.decks.filter((d) => d.eventName === eventId && matchesDeckWindow(d.ts));
  const deckSubmission = decksForRun.length > 0 ? [...decksForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;

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

  // Milestone 18: Sealed (and anything else with no DraftCompleted) falls
  // back to the generic EventCardPool capture - see its doc comment in
  // types.ts. Latest-by-ts wins, same "keep only the latest snapshot"
  // convention as courseStandings/latestStandingByEvent (a pool shouldn't
  // actually change once granted, but this is the safe choice either way).
  const cardPoolsForRun = source.cardPools.filter((p) => p.eventId === eventId && matchesCourseId(p));
  const latestCardPool = cardPoolsForRun.length > 0 ? [...cardPoolsForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;
  const poolForSideboard = completion?.cardPool ?? latestCardPool?.cardPool ?? null;

  let deck: EventRunDeck | null = null;
  if (deckSubmission) {
    let sideboard: Array<{ cardId: number; quantity: number }> | null = null;
    if (Array.isArray(deckSubmission.sideboard)) {
      // Milestone 18: the real thing, straight from the submission itself -
      // see EventRunDeck's doc comment for why this is preferred over the
      // derived fallback below.
      sideboard = deckSubmission.sideboard;
    } else if (poolForSideboard) {
      // Legacy fallback, for a submission captured before the real
      // sideboard field existed: derive it from whichever pool we have
      // (drafted, via DraftCompleted, or opened, via EventCardPool) minus
      // whatever's in mainDeck, by grpId count.
      const poolCounts = new Map<number, number>();
      for (const grpId of poolForSideboard) poolCounts.set(grpId, (poolCounts.get(grpId) ?? 0) + 1);
      for (const entry of deckSubmission.mainDeck) {
        poolCounts.set(entry.cardId, (poolCounts.get(entry.cardId) ?? 0) - entry.quantity);
      }
      sideboard = [...poolCounts.entries()].filter(([, qty]) => qty > 0).map(([cardId, quantity]) => ({ cardId, quantity }));
    }
    deck = { deckId: deckSubmission.deckId, deckName: deckSubmission.deckName, mainDeck: deckSubmission.mainDeck, sideboard };
  }

  const allOutcomes = computeMatchOutcomes(source.matchFounds, source.matchCompletions, source.myScreenName);
  const matches = allOutcomes.filter((o) => o.eventId === eventId && matchesCourseWindow(o.ts));

  // Reconciled against Arena's own EventGetCoursesV2 record the same way
  // the overlay's live eventRecord already is (milestone 6) - see
  // reconcileWinRate's comment for why this exists: without it, this
  // per-run record could (and did, for a real event affected by the
  // log-rotation bug) show a different, lower number than the overlay for
  // the exact same event, purely because local capture missed a match
  // Arena's own bookkeeping still had. Milestone 19: when disambiguating,
  // picks the latest standing for THIS courseId specifically, rather than
  // latestStandingByEvent's plain per-eventId lookup (which would still
  // hand back whichever course's standing happened to be reported latest,
  // regardless of which course this call is scoped to).
  const standingsForRun = source.courseStandings.filter((s) => s.eventId === eventId && matchesCourseId(s));
  const standing = standingsForRun.length > 0 ? [...standingsForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : (latestStandingByEvent(source.courseStandings).get(eventId) ?? null);

  // Milestone 25: a user-entered manual correction (see types.ts's
  // ManualCourseResult) always wins outright - it exists specifically
  // because the automatic record (local capture AND Arena's own
  // CourseStanding alike) was wrong or missing for this run, so this is
  // NOT reconciled by taking a max like the local-vs-Arena case below;
  // the user's entered score simply replaces whatever would otherwise be
  // computed, the same way Arena's own "Complete" standing normally would
  // have been the final word if capture hadn't missed it.
  const manualResult = source.manualResults.find((m) => m.eventId === eventId && (courseId == null || m.courseId === courseId)) ?? null;

  // Milestone 17: per-version breakdown, built from the FULL submission
  // history for this run (not just the latest) plus this run's matches -
  // see deckVersions.ts. Deliberately independent of the `deck`/`winRate`
  // computed above; the total win rate above stays the authoritative,
  // reconciled figure regardless of how many versions this expands to.
  const deckVersions = deriveDeckVersions(decksForRun, matches);

  // Entry cost: a run can in principle have more than one DraftJoined (e.g.
  // if a player left and rejoined) - the latest one is what actually paid
  // for the run currently in progress/completed.
  const joinsForRun = source.joins.filter((j) => j.eventName === eventId && matchesCourseWindow(j.ts));
  const latestJoin = joinsForRun.length > 0 ? [...joinsForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;
  const entry = latestJoin ? { currencyType: latestJoin.entryCurrencyType, amountPaid: latestJoin.entryCurrencyPaid } : null;

  // Reward: normally at most one claim per run, but take the latest if
  // more than one was somehow captured, same convention as entry above.
  const rewardsForRun = source.rewards.filter((r) => r.eventId === eventId && matchesCourseId(r));
  const reward = rewardsForRun.length > 0 ? [...rewardsForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;

  return {
    identity,
    format: resolveEventFormat(identity, deckSubmission?.format),
    eventId,
    courseId: disambiguating ? (courseId ?? null) : null,
    runStartedAt,
    deck,
    cardPool: poolForSideboard,
    picks,
    packsSeen,
    matches,
    winRate: manualResult ? winRateFromCounts(manualResult.wins, manualResult.losses) : reconcileWinRate(winRate(matches), standing),
    deckVersions,
    entry,
    reward,
  };
}

export interface EventRunRef {
  eventId: string;
  /**
   * Milestone 19: null when only one (or zero) distinct courseId was ever
   * observed for this eventId - the common case, meaning there's nothing
   * to disambiguate. Non-null only when courseWindowsForEvent found more
   * than one courseId sharing this eventId (see courseRuns.ts) - pass this
   * straight through to buildEventRunHistory/buildDeckViewerData to get
   * that specific course's own data instead of the old blended view.
   */
  courseId: string | null;
  identity: EventIdentity;
}

/**
 * Every distinct event run we have any data for at all (a draft completion,
 * a deck submission, or a match), each with its parsed identity - the index
 * a future "pick an event run to view" UI would list from (built into one,
 * tonight - see electron/main.ts's "Past Events..." tray item).
 *
 * Milestone 19: an eventId that Arena reused across more than one real
 * course (see courseRuns.ts) now yields one entry PER courseId instead of
 * one blended entry - callers that iterate this list and pass each row's
 * courseId through to buildEventRunHistory/buildDeckViewerData get each
 * course's own correct data. An eventId with only one courseId (or none at
 * all, e.g. a match-only run with no CourseStanding ever captured) still
 * yields exactly one entry with `courseId: null`, identical to this
 * function's behavior before this milestone.
 */
export function listEventRuns(source: EventHistorySource): EventRunRef[] {
  const ids = new Set<string>();
  for (const c of source.completions) ids.add(c.eventName);
  for (const d of source.decks) ids.add(d.eventName);
  for (const m of source.matchFounds) if (m.eventId) ids.add(m.eventId);

  const result: EventRunRef[] = [];
  for (const eventId of ids) {
    const identity = parseEventIdentity(eventId);
    const windows = courseWindowsForEvent(eventId, source);
    if (windows.length <= 1) {
      result.push({ eventId, courseId: null, identity });
    } else {
      for (const w of windows) result.push({ eventId, courseId: w.courseId, identity });
    }
  }
  return result;
}
