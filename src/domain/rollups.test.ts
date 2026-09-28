// Focused coverage for rollupByEventDefinition/rollupBySubtype/rollupByFormat
// (computeMatchOutcomes/winRate/rollupByEvent/winRateFromCounts are already
// exercised via liveState.test.ts and classifier.test.ts) - these are the
// "compaction level" groupings added 2026-09-24 so the user can view their
// history compacted at whichever granularity they want: one exact event
// type across all its runs (rollupByEventDefinition), one subtype across
// every set (rollupBySubtype), or a whole format combined (rollupByFormat).

import assert from "node:assert/strict";
import { rollupByEventDefinition, rollupBySubtype, rollupByFormat, type MatchOutcome } from "./rollups.js";
import type { CourseStanding } from "./types.js";

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
  // No standingsByEvent passed (the default) -> winRate falls back to the plain local total, same as the old winRate(outcomes) behavior.
  assert.equal(quickDraft.winRate.wins, 3);
  assert.equal(quickDraft.winRate.losses, 2);
  assert.equal(quickDraft.winRate.total, 5);

  const contenderDraft = byDefinition.get("ContenderDraft_HOB")!;
  assert.ok(contenderDraft, "ContenderDraft_HOB bucket should exist, separate from QuickDraft_HOB");
  assert.equal(contenderDraft.runIds.length, 1);
  assert.equal(contenderDraft.outcomes.length, 1);

  // Add a Sealed-format match and an unparseable one, so subtype/format
  // grouping has more than one bucket to prove it separates correctly.
  const outcomesWithMoreFormats: MatchOutcome[] = [
    ...outcomes,
    outcome("Sealed_HOB_20260915", "WIN"),
    outcome("DualColorPrecons", "LOSS"), // real observed shape (see report.ts's real-data validation) - no date suffix, format "Other"
  ];

  // rollupBySubtype: QuickDraft's two dated runs (different dates, same
  // subtype+set) must combine into ONE subtype bucket alongside
  // ContenderDraft's - i.e. this is coarser than rollupByEventDefinition
  // would be for the same subtype+set pair, but the real test here is that a
  // *different set under the same subtype* would also combine (none in this
  // fixture since both QuickDraft runs share set HOB - the definitionKeys
  // list is how a caller can tell how many distinct sets contributed).
  const bySubtype = rollupBySubtype(outcomesWithMoreFormats);
  assert.equal(bySubtype.size, 4); // QuickDraft, ContenderDraft, Sealed, DualColorPrecons (its own subtype since it's unparseable)

  const quickDraftSubtype = bySubtype.get("QuickDraft")!;
  assert.ok(quickDraftSubtype, "QuickDraft subtype bucket should exist");
  assert.equal(quickDraftSubtype.runIds.length, 2); // both dated runs
  assert.deepEqual(quickDraftSubtype.definitionKeys, ["QuickDraft_HOB"]); // only one set seen, but tracked as a list for when there's more than one
  assert.equal(quickDraftSubtype.outcomes.length, 6);

  // rollupByFormat: QuickDraft + ContenderDraft (both Draft-format) must
  // combine into ONE format bucket - this is the "all events in draft
  // history" compaction level the user asked for.
  const byFormat = rollupByFormat(outcomesWithMoreFormats);
  assert.equal(byFormat.size, 3); // Draft, Sealed, Other

  const draftFormat = byFormat.get("Draft")!;
  assert.ok(draftFormat, "Draft format bucket should exist");
  assert.deepEqual(draftFormat.definitionKeys.sort(), ["ContenderDraft_HOB", "QuickDraft_HOB"]);
  assert.equal(draftFormat.runIds.length, 3); // 2 QuickDraft runs + 1 ContenderDraft run
  assert.equal(draftFormat.outcomes.length, 7); // all 6 QuickDraft outcomes (incl. the undecided one) + 1 ContenderDraft outcome

  const sealedFormat = byFormat.get("Sealed")!;
  assert.equal(sealedFormat.outcomes.length, 1);

  const otherFormat = byFormat.get("Other")!;
  assert.equal(otherFormat.definitionKeys[0], "DualColorPrecons");

  console.log("OK: rollupByEventDefinition/rollupBySubtype/rollupByFormat each combine the right things at their own compaction level, without over- or under-merging.");

  // --- Reconciliation across runs within a bucket (milestone 12 follow-up) ---
  // Two runs of the same event type: run A's local capture only saw 1 win
  // (0 losses), but its CourseStanding says 3-3 (a real match went
  // uncaptured, same shape as the actual bug this was built to fix); run B
  // has no CourseStanding at all, so its local 2-1 stands unchanged. The
  // correct combined record is (3+2)-(3+1) = 5-4 - each run reconciled
  // BEFORE summing. Summing the raw local outcomes first (1+2 wins, 0+1
  // losses = 3-1) and only reconciling the total afterward would be wrong
  // (and wasn't even possible before this fix, since there's no single
  // combined CourseStanding for a whole event type to reconcile against).
  function standing(eventId: string, wins: number, losses: number): CourseStanding {
    return { kind: "CourseStanding", eventId, courseId: "c", wins, losses, currentModule: null, deckName: null, ts: "t" };
  }

  const reconciliationOutcomes: MatchOutcome[] = [
    outcome("QuickDraft_HOB_20260915", "WIN"), // run A: local 1-0
    outcome("QuickDraft_HOB_20261020", "WIN"), // run B: local 2-1
    outcome("QuickDraft_HOB_20261020", "WIN"),
    outcome("QuickDraft_HOB_20261020", "LOSS"),
  ];
  const standingsByEvent = new Map([
    ["QuickDraft_HOB_20260915", standing("QuickDraft_HOB_20260915", 3, 3)],
    // A standing for an unrelated event - must not leak into this bucket's total.
    ["SomeOtherEvent", standing("SomeOtherEvent", 9, 9)],
  ]);

  const reconciledByDefinition = rollupByEventDefinition(reconciliationOutcomes, standingsByEvent);
  const reconciledQuickDraft = reconciledByDefinition.get("QuickDraft_HOB")!;
  assert.equal(reconciledQuickDraft.winRate.wins, 5, "run A's reconciled 3 + run B's local 2");
  assert.equal(reconciledQuickDraft.winRate.losses, 4, "run A's reconciled 3 + run B's local 1");
  assert.equal(reconciledQuickDraft.winRate.total, 9);

  // The same reconciliation must flow through the coarser subtype/format groupings too, since they're built on the same shared per-run reconciliation.
  const reconciledBySubtype = rollupBySubtype(reconciliationOutcomes, standingsByEvent);
  assert.equal(reconciledBySubtype.get("QuickDraft")!.winRate.wins, 5);
  assert.equal(reconciledBySubtype.get("QuickDraft")!.winRate.losses, 4);

  const reconciledByFormat = rollupByFormat(reconciliationOutcomes, standingsByEvent);
  assert.equal(reconciledByFormat.get("Draft")!.winRate.wins, 5);
  assert.equal(reconciledByFormat.get("Draft")!.winRate.losses, 4);

  console.log("OK: rollupByEventDefinition/rollupBySubtype/rollupByFormat reconcile each contributing run against its own CourseStanding before summing, not the other way around.");
}

run();
