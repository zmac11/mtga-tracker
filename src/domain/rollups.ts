import type { CourseStanding, MatchCompleted, MatchFound } from "./types.js";
import { parseEventIdentity, type EventIdentity } from "./eventIdentity.js";

/**
 * Shared win/loss computation, used by both the headless report (report.ts)
 * and the live overlay (electron/main.ts via liveState.ts). Pulled out of
 * report.ts so the two never drift apart - there's exactly one place that
 * decides what "WIN" vs "LOSS" means.
 */
export interface MatchOutcome {
  matchId: string;
  eventId: string | null;
  opponent: string;
  outcome: "WIN" | "LOSS" | null; // null = in progress / result not captured
  reason: string | null;
  /**
   * Milestone 17: MatchFound.ts, carried through unchanged - lets a
   * consumer sort/attribute outcomes chronologically (e.g. deckVersions.ts
   * deciding which deck version was live for a given match) without going
   * back to the raw MatchFound array. Same "string, sortable via
   * localeCompare" convention every other domain event's ts already
   * follows in this codebase (see liveState.ts's activity sort) - not a
   * new assumption introduced here.
   */
  ts: string;
  /**
   * Milestone 18 (Bo3 readiness): the individual GAME results within this
   * match, not just the match's own final outcome - null when no
   * MatchScope_Game entries were captured (match still in progress, or no
   * MatchCompleted at all yet). For a Bo1 match this is always {wins:1,
   * losses:0} or {wins:0,losses:1} (one game IS the whole match) - the
   * data to compute this has been captured since MatchCompleted was first
   * added (Arena's own finalMatchResult.resultList already includes one
   * MatchScope_Game entry per game alongside the MatchScope_Match entry -
   * confirmed real, see classifier.ts), it just wasn't being counted
   * separately until now. A real Bo3 match has never been captured yet
   * (every match on record so far is Bo1 - matchWinCondition has only ever
   * been observed as MatchWinCondition_SingleElimination), so this is
   * validated against the always-1-game Bo1 shape only; the counting logic
   * itself needs no format-specific assumption (it just tallies whichever
   * MatchScope_Game entries exist), so it should generalize correctly to a
   * real 2-1/2-0 Bo3 result once one is captured.
   */
  games: { wins: number; losses: number } | null;
}

export function computeMatchOutcomes(
  matchFounds: MatchFound[],
  matchCompletions: MatchCompleted[],
  myScreenName: string | null,
): MatchOutcome[] {
  return matchFounds.map((found) => {
    const me = found.players.find((p) => p.playerName === myScreenName);
    const opponent = found.players.find((p) => p.playerName !== myScreenName);
    const completion = matchCompletions.find((m) => m.matchId === found.matchId);
    const matchResult = completion?.results.find((r) => r.scope === "MatchScope_Match");

    let outcome: "WIN" | "LOSS" | null = null;
    let reason: string | null = null;
    if (me && matchResult) {
      outcome = matchResult.winningTeamId === me.teamId ? "WIN" : "LOSS";
      reason = matchResult.reason.replace("ResultReason_", "");
    }

    let games: { wins: number; losses: number } | null = null;
    if (me && completion) {
      const gameResults = completion.results.filter((r) => r.scope === "MatchScope_Game");
      if (gameResults.length > 0) {
        const wins = gameResults.filter((r) => r.winningTeamId === me.teamId).length;
        games = { wins, losses: gameResults.length - wins };
      }
    }

    return { matchId: found.matchId, eventId: found.eventId, opponent: opponent?.playerName ?? "?", outcome, reason, ts: found.ts, games };
  });
}

export interface WinRate {
  wins: number;
  losses: number;
  total: number; // decided matches only
  pct: string; // e.g. "67%", or "-" if total is 0
}

export function winRate(outcomes: MatchOutcome[]): WinRate {
  const decided = outcomes.filter((o) => o.outcome !== null);
  const wins = decided.filter((o) => o.outcome === "WIN").length;
  const losses = decided.length - wins;
  const pct = decided.length > 0 ? `${Math.round((wins / decided.length) * 100)}%` : "-";
  return { wins, losses, total: decided.length, pct };
}

/**
 * Same shape as winRate(), but built directly from a wins/losses count
 * rather than derived from locally-observed MatchOutcomes. Used for
 * CourseStanding (Arena's own authoritative per-event record, from
 * EventGetCoursesV2 - see classifier.ts) - that source doesn't need
 * counting from raw outcomes since Arena already did it, but the result
 * should look and format identically either way.
 */
export function winRateFromCounts(wins: number, losses: number): WinRate {
  const total = wins + losses;
  const pct = total > 0 ? `${Math.round((wins / total) * 100)}%` : "-";
  return { wins, losses, total, pct };
}

/**
 * Reconciles a locally-computed WinRate for one event run against Arena's
 * own CourseStanding for that same run (see CourseStanding's comment in
 * types.ts) - takes the max of each side independently, exactly the "our
 * own capture might have missed something, Arena's own count is the
 * backstop" logic LiveStateTracker.snapshot() already applies to the
 * overlay's live display (milestone 6). Pulled out into one shared
 * function (milestone 12) after the deck-viewer page and report.ts's
 * per-run win-rate table were found to show a different, raw record than
 * the overlay for the exact same event - both computed winRate() straight
 * from locally captured matches with no backstop at all, so a local
 * capture gap (the log-rotation bug is the known real-world example)
 * showed up as three different numbers for the same event depending on
 * which screen you looked at. `standing` is null/undefined when no
 * CourseStanding was ever captured for this event - nothing to reconcile
 * against, so the local count is returned unchanged.
 */
export function reconcileWinRate(local: WinRate, standing: { wins: number; losses: number } | null | undefined): WinRate {
  if (!standing) return local;
  return winRateFromCounts(Math.max(local.wins, standing.wins), Math.max(local.losses, standing.losses));
}

/**
 * Builds "the LATEST CourseStanding captured for each event" as a lookup
 * Map, keyed by eventId - the one place that decides what "latest" means
 * (a plain last-write-wins pass over the array, relying on
 * TypedEventStore.all()'s `ORDER BY id ASC`, i.e. chronological order -
 * confirmed via sqliteStore.ts). Added in milestone 12's follow-up pass
 * after the same `[...standings].reverse().find(...)` snippet had been
 * copy-pasted into eventHistory.ts and report.ts separately - see the
 * "one backstop, every call site" gotcha this project already learned the
 * hard way once this milestone.
 */
export function latestStandingByEvent(standings: CourseStanding[]): Map<string, CourseStanding> {
  const result = new Map<string, CourseStanding>();
  for (const s of standings) result.set(s.eventId, s);
  return result;
}

/**
 * Per-run building block every coarser rollup below sums from, instead of
 * summing raw MatchOutcomes and only reconciling the total afterward - the
 * latter isn't meaningful, since any "extra" wins/losses a CourseStanding
 * contributes over local capture don't have individual MatchOutcome rows
 * to sum in the first place. Only covers runs that appear in `outcomes`
 * (i.e. we captured at least one MatchFound for them) - a run with a
 * CourseStanding but literally zero locally captured matches wouldn't be
 * visible to rollupByEvent()/the callers below either way, since they're
 * driven by the same `outcomes` list; that's a known, narrower gap than
 * this fix closes; see the gotcha above.
 */
export function reconciledWinRateByRun(outcomes: MatchOutcome[], standingsByEvent: Map<string, { wins: number; losses: number }>): Map<string, WinRate> {
  const byRun = rollupByEvent(outcomes);
  const result = new Map<string, WinRate>();
  for (const [eventId, runOutcomes] of byRun) {
    result.set(eventId, reconcileWinRate(winRate(runOutcomes), standingsByEvent.get(eventId)));
  }
  return result;
}

/** Sums a set of (already reconciled) per-run WinRates into one combined WinRate. */
export function sumWinRates(rates: WinRate[]): WinRate {
  let wins = 0;
  let losses = 0;
  for (const r of rates) {
    wins += r.wins;
    losses += r.losses;
  }
  return winRateFromCounts(wins, losses);
}

/**
 * Groups outcomes by event (eventId/eventName) - i.e. by *run*: every match
 * from one specific dated live-window of an event (e.g. one specific
 * "QuickDraft_HOB_20260915"). This is currently the only reliable join back
 * to "which draft run/deck was this match for" - see the courseId note on
 * MatchFound in types.ts for why we don't group by a more specific
 * draft-run id yet. See rollupByEventDefinition below for the coarser
 * grouping that combines separate runs of the *same event type* together
 * (e.g. every HOB QuickDraft, across however many times it's been live).
 */
export function rollupByEvent(outcomes: MatchOutcome[]): Map<string, MatchOutcome[]> {
  const byEvent = new Map<string, MatchOutcome[]>();
  for (const o of outcomes) {
    const key = o.eventId ?? "(unknown event)";
    const list = byEvent.get(key) ?? [];
    list.push(o);
    byEvent.set(key, list);
  }
  return byEvent;
}

export interface EventDefinitionRollup {
  /** Representative identity for this bucket (definitionKey/format/subtype/setCode are what matter here - raw/dateStamp just reflect whichever run happened to be parsed first, not meaningful at this grouping level). */
  identity: EventIdentity;
  outcomes: MatchOutcome[];
  /** Distinct eventIds (dated runs) contributing to this bucket, in first-seen order. */
  runIds: string[];
  /**
   * The bucket's win/loss, summed from each contributing run's OWN
   * reconciled record (milestone 12 - see reconcileWinRate/
   * reconciledWinRateByRun) rather than computed via winRate(outcomes).
   * Falls back to the plain local winRate(outcomes) when no
   * standingsByEvent is passed to rollupByEventDefinition (the default),
   * so this is backward compatible with every existing caller/test.
   */
  winRate: WinRate;
}

/**
 * Groups outcomes by *event type* (see eventIdentity.ts) rather than by
 * exact eventId/run - so "how have I done at HOB QuickDraft overall" adds up
 * across every time that event's been live, not just the current dated run.
 * Added 2026-09-24 per the user's request not to treat a repeated event
 * (same format/set, later date) as a brand new unrelated event.
 *
 * `standingsByEvent` (milestone 12, optional - defaults to none) lets the
 * bucket's `winRate` be reconciled against Arena's own per-run record
 * before summing across runs, the same way eventHistory.ts's
 * buildEventRunHistory already reconciles a single run - see
 * reconciledWinRateByRun's comment for why summing raw outcomes and only
 * reconciling the total afterward wouldn't be meaningful.
 */
export function rollupByEventDefinition(
  outcomes: MatchOutcome[],
  standingsByEvent: Map<string, { wins: number; losses: number }> = new Map(),
): Map<string, EventDefinitionRollup> {
  const perRun = reconciledWinRateByRun(outcomes, standingsByEvent);
  const byDefinition = new Map<string, EventDefinitionRollup>();
  for (const o of outcomes) {
    const eventId = o.eventId ?? "(unknown event)";
    const identity = parseEventIdentity(eventId);
    const key = identity.definitionKey;
    let bucket = byDefinition.get(key);
    if (!bucket) {
      bucket = { identity, outcomes: [], runIds: [], winRate: winRateFromCounts(0, 0) };
      byDefinition.set(key, bucket);
    }
    bucket.outcomes.push(o);
    if (!bucket.runIds.includes(eventId)) bucket.runIds.push(eventId);
  }
  for (const bucket of byDefinition.values()) {
    bucket.winRate = sumWinRates(bucket.runIds.map((runId) => perRun.get(runId) ?? winRateFromCounts(0, 0)));
  }
  return byDefinition;
}

export interface GroupedRollup {
  /** The grouping key itself - a subtype string (e.g. "QuickDraft") or a format string (e.g. "Draft"). */
  key: string;
  outcomes: MatchOutcome[];
  /** Distinct eventIds (dated runs) contributing to this bucket, in first-seen order. */
  runIds: string[];
  /** Distinct event-type definitionKeys contributing to this bucket (e.g. both "QuickDraft_HOB" and "QuickDraft_XYZ" can both roll up under subtype "QuickDraft"). */
  definitionKeys: string[];
  /** Summed from each contributing run's own reconciled record - see EventDefinitionRollup.winRate's comment (milestone 12); same backward-compatible default-to-local-only behavior. */
  winRate: WinRate;
}

function groupBy(
  outcomes: MatchOutcome[],
  keyOf: (identity: EventIdentity) => string,
  standingsByEvent: Map<string, { wins: number; losses: number }> = new Map(),
): Map<string, GroupedRollup> {
  const perRun = reconciledWinRateByRun(outcomes, standingsByEvent);
  const grouped = new Map<string, GroupedRollup>();
  for (const o of outcomes) {
    const eventId = o.eventId ?? "(unknown event)";
    const identity = parseEventIdentity(eventId);
    const key = keyOf(identity);
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { key, outcomes: [], runIds: [], definitionKeys: [], winRate: winRateFromCounts(0, 0) };
      grouped.set(key, bucket);
    }
    bucket.outcomes.push(o);
    if (!bucket.runIds.includes(eventId)) bucket.runIds.push(eventId);
    if (!bucket.definitionKeys.includes(identity.definitionKey)) bucket.definitionKeys.push(identity.definitionKey);
  }
  for (const bucket of grouped.values()) {
    bucket.winRate = sumWinRates(bucket.runIds.map((runId) => perRun.get(runId) ?? winRateFromCounts(0, 0)));
  }
  return grouped;
}

/**
 * Coarser than rollupByEventDefinition: groups by *subtype alone* (e.g.
 * "QuickDraft"), combining across every set that subtype's ever been played
 * on - so "how have I done at QuickDraft overall" isn't split up per set.
 * Added 2026-09-24 as one of three "compaction" levels the user asked to be
 * able to view event history at (this one, rollupByFormat below, and
 * rollupByEventDefinition above - from most to least compacted, on top of
 * the finest-grained rollupByEvent per exact run).
 */
export function rollupBySubtype(
  outcomes: MatchOutcome[],
  standingsByEvent: Map<string, { wins: number; losses: number }> = new Map(),
): Map<string, GroupedRollup> {
  return groupBy(outcomes, (identity) => identity.subtype, standingsByEvent);
}

/**
 * The most compacted grouping: by format alone (Draft / Sealed /
 * Constructed / Other), combining every event of that format regardless of
 * subtype or set - e.g. "how have I done across all limited drafts, ever."
 */
export function rollupByFormat(
  outcomes: MatchOutcome[],
  standingsByEvent: Map<string, { wins: number; losses: number }> = new Map(),
): Map<string, GroupedRollup> {
  return groupBy(outcomes, (identity) => identity.format, standingsByEvent);
}
