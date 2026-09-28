import type { MatchOutcome, WinRate } from "./rollups.js";
import { reconcileWinRate, sumWinRates, winRate } from "./rollups.js";

/**
 * One event run's worth of input for rollupByColorCombo below: which color
 * combination its submitted deck played, and that run's own match outcomes.
 * The caller decides which runs to pass in together (e.g. every run of one
 * event type, so "how do I do on UR vs WB in HOB QuickDraft" is visible) -
 * this function itself is agnostic to event identity, same convention as
 * rollups.ts's groupBy().
 */
export interface RunColorInfo {
  eventId: string;
  /** From deckColors.ts's deriveDeckColors().comboKey - or a placeholder like "(no deck captured)" when this run has no deck data to derive from. */
  comboKey: string;
  outcomes: MatchOutcome[];
}

export interface ColorComboRollup {
  comboKey: string;
  /** Distinct eventIds (dated runs) contributing to this bucket, in first-seen order. */
  runIds: string[];
  outcomes: MatchOutcome[];
  winRate: WinRate;
}

/**
 * Groups a set of event runs by the color combination their deck played,
 * combining every run that shares a combo (e.g. two separate HOB QuickDraft
 * runs both played as "UR") into one win-rate bucket - milestone 7 phase 3.
 *
 * `standingsByEvent` (milestone 12, optional - defaults to none) reconciles
 * each contributing run against Arena's own CourseStanding for it before
 * summing into the combo's winRate, same rationale as
 * rollups.ts's reconciledWinRateByRun (a color-combo breakdown is just
 * another way of grouping runs together, so it has exactly the same
 * "summing raw outcomes and reconciling after the fact isn't meaningful"
 * problem the coarser format/subtype/definition rollups had). Omitting it
 * keeps the previous behavior (plain local winRate(outcomes)) unchanged.
 */
export function rollupByColorCombo(
  runs: RunColorInfo[],
  standingsByEvent: Map<string, { wins: number; losses: number }> = new Map(),
): Map<string, ColorComboRollup> {
  const byCombo = new Map<string, ColorComboRollup>();
  for (const run of runs) {
    let bucket = byCombo.get(run.comboKey);
    if (!bucket) {
      bucket = { comboKey: run.comboKey, runIds: [], outcomes: [], winRate: winRate([]) };
      byCombo.set(run.comboKey, bucket);
    }
    if (!bucket.runIds.includes(run.eventId)) bucket.runIds.push(run.eventId);
    bucket.outcomes.push(...run.outcomes);
  }
  const runsById = new Map(runs.map((r) => [r.eventId, r]));
  for (const bucket of byCombo.values()) {
    bucket.winRate = sumWinRates(
      bucket.runIds.map((runId) => reconcileWinRate(winRate(runsById.get(runId)?.outcomes ?? []), standingsByEvent.get(runId))),
    );
  }
  return byCombo;
}
