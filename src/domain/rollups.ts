import type { MatchCompleted, MatchFound } from "./types.js";

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
 * Groups outcomes by event (eventId/eventName). This is currently the only
 * reliable join back to "which draft run/deck was this match for" - see the
 * courseId note on MatchFound in types.ts for why we don't group by a more
 * specific draft-run id yet.
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
