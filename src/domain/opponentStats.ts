import type { EventHistorySource } from "./eventHistory.js";
import { listEventRuns, buildEventRunHistory } from "./eventHistory.js";
import { computeMatchOutcomes, winRateFromCounts, type WinRate } from "./rollups.js";
import { buildMatchGameDetails } from "./matchDetails.js";

/**
 * Milestone 20 (2026-09-30): "I want to search which opponents I have
 * played against and winrate against them - option to filter them by
 * format and search games and deck which I played vs them" - the last of
 * six sub-requests from the user's 2026-09-30 message.
 *
 * One row per (match, the run it belongs to) - deliberately built by
 * iterating `listEventRuns`/`buildEventRunHistory` (the same courseId-
 * disambiguation-aware pair every other milestone-19/20 feature already
 * uses - see courseRuns.ts) rather than re-deriving "which course does
 * this match's ts belong to" a second time: `buildEventRunHistory` already
 * scopes its own `matches` to the specific run/course it was asked for
 * (see that function's own `matchesCourseWindow`), so reusing it here for
 * real means a match against an opponent that spans a courseId-collided
 * eventId (the confirmed real Sealed_FRA_20260929 case - two separate
 * courses, two separate decks, same eventId) is correctly attributed to
 * whichever specific run/deck was actually live for it, not blended.
 *
 * `myDeckName` is the run's own (single) deck, not a per-match deck - this
 * project doesn't track which exact deck VERSION (see deckVersions.ts) was
 * live for a given match at this granularity yet, so a run where the deck
 * was edited mid-event shows its most-recent submission's name against
 * every match in that run, same simplification `report.ts`'s existing
 * per-run deck display already makes.
 *
 * Falls back to a plain, unscoped row (identity/format "Unknown", no
 * courseId, no deck) for any match `listEventRuns` didn't cover - in
 * practice this should be everything (`listEventRuns` builds its eventId
 * set from every MatchFound that HAS an eventId, and no real captured
 * match has ever had a null one - see report.ts's own MatchOutcome.eventId
 * comment for why the type still allows it), but this keeps the opponent
 * list complete rather than silently dropping a match if that ever
 * changes, instead of just trusting it can't happen.
 */
export interface OpponentMatchRow {
  matchId: string;
  opponent: string;
  eventId: string | null;
  courseId: string | null;
  /** "Draft" | "Sealed" | "Constructed" | "Other" | "Unknown" - the last only for the no-eventId fallback case above. */
  format: string;
  subtype: string | null;
  setCode: string | null;
  definitionLabel: string | null;
  outcome: "WIN" | "LOSS" | null;
  reason: string | null;
  ts: string;
  myDeckName: string | null;
  /**
   * Milestone 24 (2026-10-01): "I want to have number of turns displayed
   * for each match" - one entry per game of this match, in gameNumber
   * order (matchDetails.ts's MatchGameSummary.turnCount), per the user's
   * own choice to track turns per GAME rather than summed per match. A
   * game whose turnCount was never resolved is simply omitted, same
   * "absent, not zero" convention the rest of this project already uses -
   * so this is empty (not [0] or [null]) for a match with no captured
   * turn data at all. Always length 1 for every real match captured so
   * far (every one is Bo1); would be length 2-3 for a real Bo3.
   */
  turnCounts: number[];
}

export function buildOpponentMatchRows(source: EventHistorySource): OpponentMatchRow[] {
  const rows: OpponentMatchRow[] = [];
  const seenMatchIds = new Set<string>();
  const gameDetails = buildMatchGameDetails(source.gameStateSnapshots, source.matchFounds, source.myScreenName);
  const turnCountsFor = (matchId: string): number[] =>
    (gameDetails.get(matchId) ?? []).map((g) => g.turnCount).filter((t): t is number => t !== null);

  for (const run of listEventRuns(source)) {
    const history = buildEventRunHistory(run.eventId, source, run.courseId);
    for (const m of history.matches) {
      seenMatchIds.add(m.matchId);
      rows.push({
        matchId: m.matchId,
        opponent: m.opponent,
        eventId: run.eventId,
        courseId: run.courseId,
        format: history.format,
        subtype: history.identity.subtype,
        setCode: history.identity.setCode,
        definitionLabel: history.identity.definitionLabel,
        outcome: m.outcome,
        reason: m.reason,
        ts: m.ts,
        myDeckName: history.deck?.deckName ?? null,
        turnCounts: turnCountsFor(m.matchId),
      });
    }
  }

  // Fallback for any match no run covered - see this file's header comment.
  const allOutcomes = computeMatchOutcomes(source.matchFounds, source.matchCompletions, source.myScreenName);
  for (const o of allOutcomes) {
    if (seenMatchIds.has(o.matchId)) continue;
    rows.push({
      matchId: o.matchId,
      opponent: o.opponent,
      eventId: o.eventId,
      courseId: null,
      format: "Unknown",
      subtype: null,
      setCode: null,
      definitionLabel: o.eventId ?? "(unknown event)",
      outcome: o.outcome,
      reason: o.reason,
      ts: o.ts,
      myDeckName: null,
      turnCounts: turnCountsFor(o.matchId),
    });
  }

  return rows;
}

export interface OpponentSummaryRow {
  opponent: string;
  wins: number;
  losses: number;
  matchCount: number;
}

/** Aggregates OpponentMatchRow[] into one WinRate-shaped summary per opponent - a thin convenience the HTML page's client-side JS re-derives itself per filter, kept here mainly so a non-browser consumer (a future CLI flag, say) doesn't have to reimplement the same grouping. */
export function summarizeByOpponent(rows: OpponentMatchRow[]): OpponentSummaryRow[] {
  const byOpponent = new Map<string, { wins: number; losses: number; matchCount: number }>();
  for (const r of rows) {
    const bucket = byOpponent.get(r.opponent) ?? { wins: 0, losses: 0, matchCount: 0 };
    bucket.matchCount += 1;
    if (r.outcome === "WIN") bucket.wins += 1;
    else if (r.outcome === "LOSS") bucket.losses += 1;
    byOpponent.set(r.opponent, bucket);
  }
  return [...byOpponent.entries()].map(([opponent, b]) => ({ opponent, ...b }));
}

/** Same wins/losses -> WinRate convention as statsRollup.ts's winRateOf - re-exported here via rollups.ts's own winRateFromCounts instead of a third reimplementation. */
export function winRateOfRows(rows: Array<{ outcome: "WIN" | "LOSS" | null }>): WinRate {
  const wins = rows.filter((r) => r.outcome === "WIN").length;
  const losses = rows.filter((r) => r.outcome === "LOSS").length;
  return winRateFromCounts(wins, losses);
}
