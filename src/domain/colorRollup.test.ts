// Coverage for rollupByColorCombo (milestone 7 phase 3): combining multiple
// event runs' outcomes into per-color-combo win-rate buckets.

import assert from "node:assert/strict";
import { rollupByColorCombo, type RunColorInfo } from "./colorRollup.js";
import type { MatchOutcome } from "./rollups.js";

function outcome(eventId: string, result: "WIN" | "LOSS" | null): MatchOutcome {
  return { matchId: `m-${Math.random()}`, eventId, opponent: "Opp", outcome: result, reason: result ? "Game" : null };
}

function run() {
  const runs: RunColorInfo[] = [
    // Two separate runs both played UR.
    { eventId: "QuickDraft_HOB_20260915", comboKey: "UR", outcomes: [outcome("QuickDraft_HOB_20260915", "WIN"), outcome("QuickDraft_HOB_20260915", "WIN"), outcome("QuickDraft_HOB_20260915", "LOSS")] },
    { eventId: "QuickDraft_HOB_20261020", comboKey: "UR", outcomes: [outcome("QuickDraft_HOB_20261020", "LOSS")] },
    // A different run played WB.
    { eventId: "QuickDraft_HOB_20260801", comboKey: "WB", outcomes: [outcome("QuickDraft_HOB_20260801", "WIN")] },
    // A run with no deck captured - still bucketed, under its own placeholder key.
    { eventId: "QuickDraft_HOB_20260601", comboKey: "(no deck captured)", outcomes: [outcome("QuickDraft_HOB_20260601", "WIN")] },
  ];

  const byCombo = rollupByColorCombo(runs);
  assert.equal(byCombo.size, 3);

  const ur = byCombo.get("UR")!;
  assert.ok(ur);
  assert.deepEqual(ur.runIds.sort(), ["QuickDraft_HOB_20260915", "QuickDraft_HOB_20261020"]);
  assert.equal(ur.outcomes.length, 4);
  assert.equal(ur.winRate.wins, 2);
  assert.equal(ur.winRate.losses, 2);

  const wb = byCombo.get("WB")!;
  assert.equal(wb.winRate.wins, 1);
  assert.equal(wb.winRate.losses, 0);

  const noDeck = byCombo.get("(no deck captured)")!;
  assert.equal(noDeck.outcomes.length, 1);

  console.log("OK: rollupByColorCombo combines runs sharing a color combo into one win-rate bucket, keeping different combos (including 'no deck captured') separate.");

  // --- Reconciliation against CourseStanding (milestone 12 follow-up) ---
  // Both UR runs' local capture only shows 2-2 combined (see above); if one
  // of those runs actually had a higher CourseStanding record (a real
  // match went uncaptured), the combo's total must reflect the reconciled
  // per-run record, not the raw local sum.
  const standingsByEvent = new Map([["QuickDraft_HOB_20260915", { wins: 3, losses: 2 }]]); // was locally 2-1 for this run alone
  const reconciledByCombo = rollupByColorCombo(runs, standingsByEvent);
  const reconciledUr = reconciledByCombo.get("UR")!;
  // Run 20260915 reconciled: max(2,3)-max(1,2) = 3-2. Run 20261020 unchanged (no standing): 0-1.
  // Combined: (3+0)-(2+1) = 3-3, not the raw local 2-2.
  assert.equal(reconciledUr.winRate.wins, 3);
  assert.equal(reconciledUr.winRate.losses, 3);

  console.log("OK: rollupByColorCombo reconciles each contributing run against its own CourseStanding before summing into the combo's winRate.");
}

run();
