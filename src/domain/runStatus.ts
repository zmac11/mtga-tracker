import type { EventHistorySource, EventRunRef } from "./eventHistory.js";
import { buildEventRunHistory, courseWindowsForEvent } from "./eventHistory.js";
import { compareTs } from "./courseRuns.js";
import type { EventFormat } from "./eventIdentity.js";

/**
 * "After finishing an event's matches, automatically complete the event"
 * (2026-10-02 request). A limited event ends the moment its player reaches
 * a win cap or a loss cap (e.g. Sealed: 7 wins or 3 losses), but nothing the
 * tracker captured used to say so by itself: it waited for Arena's own
 * "Complete" standing or a prize claim, neither of which reliably shows up
 * (Arena first moves a finished run to CurrentModule "ClaimPrize", which
 * wasn't recognised at all, and only refreshes standings when the player
 * returns to the event screen). This module derives a run's status at read
 * time from everything known - no new stored event - so it's retroactive
 * for runs already captured and can never disagree with itself.
 *
 * Signals, strongest first: a claimed prize; Arena's own standing reporting
 * "Complete" or "ClaimPrize"; a manually entered score; and finally the
 * run's reconciled record having reached its event type's win/loss cap.
 */
export interface EndRule {
  /** The run ends the moment this many wins are reached. Null = no known win cap. */
  maxWins: number | null;
  /** The run ends the moment this many losses are reached. Null = no known loss cap. */
  maxLosses: number | null;
}

export type RunStatusReason =
  | "prize-claimed"
  | "arena-complete"
  | "arena-claim-prize"
  | "manual-score"
  | "reached-win-limit"
  | "reached-loss-limit";

export interface RunStatus {
  finished: boolean;
  /** Why the run counts as finished; null while it's still in progress. */
  reason: RunStatusReason | null;
  /** The reconciled record this decision was based on (local matches vs Arena's standing vs any manual score). */
  wins: number;
  losses: number;
  /** The cap that applies to this event type, if one is known - shown even while in progress so "x of 3 losses" style hints are possible. */
  rule: EndRule | null;
  ruleSource: "builtin" | "learned" | null;
}

/**
 * Caps confirmed or standard for Arena's limited events, keyed by
 * EventIdentity.subtype. Sealed's 3-loss cap is confirmed against this
 * project's own real data (every completed Sealed run on record ended on
 * exactly 3 losses, with wins ranging 2-4); QuickDraft ended on 3 losses
 * the same way. The 7-win caps are Arena's published format rule and are
 * not yet observed (no run here has won 7). Anything NOT listed (Pick Two,
 * Traditional/Bo3 drafts, ContenderDraft, Constructed events...) has no
 * built-in rule - those only ever finish via Arena's own signals, or via a
 * cap learned from this player's own finished runs (see learnEndRules).
 */
const BUILTIN_END_RULES: Record<string, EndRule> = {
  Sealed: { maxWins: 7, maxLosses: 3 },
  QuickDraft: { maxWins: 7, maxLosses: 3 },
  PremierDraft: { maxWins: 7, maxLosses: 3 },
};

export interface FinishedRunSample {
  subtype: string;
  format: EventFormat;
  wins: number;
  losses: number;
}

/**
 * Learns a cap for an event type from runs Arena itself marked finished:
 * if at least two finished runs of the same subtype all ended on exactly
 * the same loss (or win) count, that count is that event's cap. Only for
 * Draft/Sealed formats - open-ended modes (Ladder, Play, ...) "complete"
 * after every single match, which would wrongly look like a cap of 1.
 * Never overrides a built-in rule.
 */
export function learnEndRules(samples: FinishedRunSample[]): Map<string, EndRule> {
  const bySubtype = new Map<string, FinishedRunSample[]>();
  for (const s of samples) {
    if (s.format !== "Draft" && s.format !== "Sealed") continue;
    if (BUILTIN_END_RULES[s.subtype]) continue;
    const list = bySubtype.get(s.subtype) ?? [];
    list.push(s);
    bySubtype.set(s.subtype, list);
  }
  const learned = new Map<string, EndRule>();
  for (const [subtype, list] of bySubtype) {
    if (list.length < 2) continue;
    const losses = new Set(list.map((s) => s.losses));
    const wins = new Set(list.map((s) => s.wins));
    const maxLosses = losses.size === 1 && [...losses][0] >= 1 ? [...losses][0] : null;
    const maxWins = wins.size === 1 && [...wins][0] >= 1 ? [...wins][0] : null;
    if (maxLosses !== null || maxWins !== null) learned.set(subtype, { maxWins, maxLosses });
  }
  return learned;
}

export function runStatusKey(eventId: string, courseId: string | null): string {
  return `${eventId}|${courseId ?? ""}`;
}

/** Applies a cap to a record. Win cap is checked first; a record can't sensibly hit both. */
export function evaluateEndRule(wins: number, losses: number, rule: EndRule | null): "reached-win-limit" | "reached-loss-limit" | null {
  if (!rule) return null;
  if (rule.maxWins !== null && wins >= rule.maxWins) return "reached-win-limit";
  if (rule.maxLosses !== null && losses >= rule.maxLosses) return "reached-loss-limit";
  return null;
}

interface FirstPass {
  ref: EventRunRef;
  /** Set when something other than a cap already says this run is over. */
  signalReason: RunStatusReason | null;
  /** Arena's own final record for this run, when its standing marked it finished - what caps are learned from. */
  arenaFinalRecord: { wins: number; losses: number } | null;
  wins: number;
  losses: number;
}

function firstPass(ref: EventRunRef, source: EventHistorySource): FirstPass {
  const { eventId, courseId } = ref;
  const windows = courseWindowsForEvent(eventId, source);
  const disambiguating = windows.length > 1;
  const matchesCourseId = <T extends { courseId: string }>(item: T): boolean => !disambiguating || item.courseId === courseId;

  const standings = source.courseStandings.filter((s) => s.eventId === eventId && matchesCourseId(s));
  const latestStanding = standings.length > 0 ? [...standings].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;
  const rewards = source.rewards.filter((r) => r.eventId === eventId && matchesCourseId(r));
  const manual = source.manualResults.some((m) => m.eventId === eventId && (courseId == null || m.courseId === courseId));

  let signalReason: RunStatusReason | null = null;
  if (rewards.length > 0) signalReason = "prize-claimed";
  else if (latestStanding?.currentModule === "Complete") signalReason = "arena-complete";
  else if (latestStanding?.currentModule === "ClaimPrize") signalReason = "arena-claim-prize";
  else if (manual) signalReason = "manual-score";

  const arenaEnded = latestStanding !== null && (latestStanding.currentModule === "Complete" || latestStanding.currentModule === "ClaimPrize");
  const record = buildEventRunHistory(eventId, source, courseId).winRate;
  return {
    ref,
    signalReason,
    arenaFinalRecord: arenaEnded ? { wins: latestStanding!.wins, losses: latestStanding!.losses } : null,
    wins: record.wins,
    losses: record.losses,
  };
}

/** One status per run in `refs`, keyed by runStatusKey. */
export function computeRunStatuses(source: EventHistorySource, refs: EventRunRef[]): Map<string, RunStatus> {
  const passes = refs.map((ref) => firstPass(ref, source));

  const learned = learnEndRules(
    passes
      .filter((p) => p.arenaFinalRecord !== null)
      .map((p) => ({ subtype: p.ref.identity.subtype, format: p.ref.identity.format, wins: p.arenaFinalRecord!.wins, losses: p.arenaFinalRecord!.losses })),
  );

  const result = new Map<string, RunStatus>();
  for (const p of passes) {
    const subtype = p.ref.identity.subtype;
    const builtin = BUILTIN_END_RULES[subtype] ?? null;
    const learnedRule = learned.get(subtype) ?? null;
    const rule = builtin ?? learnedRule;
    const ruleSource = builtin ? "builtin" : learnedRule ? "learned" : null;

    const capReason = p.signalReason === null ? evaluateEndRule(p.wins, p.losses, rule) : null;
    const reason = p.signalReason ?? capReason;
    result.set(runStatusKey(p.ref.eventId, p.ref.courseId), {
      finished: reason !== null,
      reason,
      wins: p.wins,
      losses: p.losses,
      rule,
      ruleSource,
    });
  }
  return result;
}

/** Short human wording for the status badge / notifications. */
export function describeRunStatus(status: RunStatus): string {
  const record = `${status.wins}-${status.losses}`;
  switch (status.reason) {
    case "prize-claimed":
      return `Completed ${record} - prize claimed`;
    case "arena-complete":
    case "arena-claim-prize":
      return `Completed ${record} - finished in Arena`;
    case "manual-score":
      return `Completed ${record} - score entered manually`;
    case "reached-win-limit":
      return `Completed ${record} - reached ${status.rule?.maxWins} wins`;
    case "reached-loss-limit":
      return `Completed ${record} - eliminated at ${status.rule?.maxLosses} losses`;
    default:
      return "In progress";
  }
}
