// Focused coverage for rollupByEventDefinition (computeMatchOutcomes/winRate/
// rollupByEvent/winRateFromCounts are already exercised via liveState.test.ts
// and classifier.test.ts) - this is the new grouping added 2026-09-24 so a
// repeated event (same format/set, later date) aggregates with its earlier
// runs instead of starting a fresh record.

import assert from "node:assert/strict";
import { rollupByEventDefinition, type MatchOutcome } from "./rollups.js";

function outcome(eventId: string | null, outcome: "WIN" | "LOSS" | null): MatchOutcome {
  return { matchId: `m-${Math.random()}`, eventId, opponent: "Opp", outcome, reason: outcome ? "Game" : null };
}

function run() {
  const outcomes: MatchOutcome[] = [
    // Two separate runs of the same event type (HOB QuickDraft), months apart.
    outcome("QuickDraft_HOB_20260915", "WIN"),
    outcome("QuickDraft_HOB_20260915", "WIN"),
    outcome("QuickDraft_HOB_20260915", "LOSS"),
    outcome("QuickDraft_HOB_20261020", "WIN"),
    outcome("QuickDraft_HOB_20261020", "LOSS"),
    // A different event type entirely - must not get pulled into the same bucket.
    outcome("ContenderDraft_HOB_20260824", "WIN"),
    // An in-progress match (no decided outcome yet) - shouldn't be dropped from runIds/outcomes, just from the win/loss count.
    outcome("QuickDraft_HOB_20261020", null),
  ];

  const byDefinition = rollupByEventDefinition(outcomes);
  assert.equal(byDefinition.size, 2);

  const quickDraft = byDefinition.get("QuickDraft_HOB")!;
  assert.ok(quickDraft, "QuickDraft_HOB bucket should exist");
  assert.equal(quickDraft.identity.format, "Draft");
  assert.equal(quickDraft.identity.definitionLabel, "QuickDraft - HOB");
  assert.equal(quickDraft.runIds.length, 2);
  assert.deepEqual(quickDraft.runIds.sort(), ["QuickDraft_HOB_20260915", "QuickDraft_HOB_20261020"]);
  assert.equal(quickDraft.outcomes.length, 6); // 3 + 2 + the undecided one, all still present

  const contenderDraft = byDefinition.get("ContenderDraft_HOB")!;
  assert.ok(contenderDraft, "ContenderDraft_HOB bucket should exist, separate from QuickDraft_HOB");
  assert.equal(contenderDraft.runIds.length, 1);
  assert.equal(contenderDraft.outcomes.length, 1);

  console.log("OK: rollupByEventDefinition combines separate dated runs of the same event type while keeping different event types apart.");
}

run();
