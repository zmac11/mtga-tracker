import type { MatchCompleted, MatchFound } from "./types.js";
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

    return { matchId: found.matchId, eventId: found.eventId, opponent: opponent?.playerName ?? "?", outcome, reason };
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
}

/**
 * Groups outcomes by *event type* (see eventIdentity.ts) rather than by
 * exact eventId/run - so "how have I done at HOB QuickDraft overall" adds up
 * across every time that event's been live, not just the current dated run.
 * Added 2026-09-24 per the user's request not to treat a repeated event
 * (same format/set, later date) as a brand new unrelated event.
 */
export function rollupByEventDefinition(outcomes: MatchOutcome[]): Map<string, EventDefinitionRollup> {
  const byDefinition = new Map<string, EventDefinitionRollup>();
  for (const o of outcomes) {
    const eventId = o.eventId ?? "(unknown event)";
    const identity = parseEventIdentity(eventId);
    const key = identity.definitionKey;
    let bucket = byDefinition.get(key);
    if (!bucket) {
      bucket = { identity, outcomes: [], runIds: [] };
      byDefinition.set(key, bucket);
    }
    bucket.outcomes.push(o);
    if (!bucket.runIds.includes(eventId)) bucket.runIds.push(eventId);
  }
  return byDefinition;
}
