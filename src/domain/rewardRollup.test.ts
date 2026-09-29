// Coverage for sumRewards/rollupRewardsByEvent/rollupRewardsByFormat
// (milestone 17) - the reward-aggregation counterpart to rollups.ts's
// win/loss rollups.

import assert from "node:assert/strict";
import { sumRewards, rollupRewardsByEvent, rollupRewardsByFormat } from "./rewardRollup.js";
import type { EventReward } from "./types.js";

function reward(overrides: Partial<EventReward> & Pick<EventReward, "eventId" | "courseId">): EventReward {
  return { kind: "EventReward", gems: 0, gold: 0, boosters: [], grantedCardCount: 0, ts: "t0", ...overrides };
}

function run() {
  const rewards: EventReward[] = [
    reward({ eventId: "QuickDraft_HOB_20260915", courseId: "c1", gems: 650, boosters: [{ setCode: "HOB", count: 2 }], ts: "t1" }),
    // A second claim of the SAME set - boosters should combine into one HOB entry, not two.
    reward({ eventId: "QuickDraft_HOB_20261020", courseId: "c2", gems: 100, gold: 50, boosters: [{ setCode: "HOB", count: 1 }], grantedCardCount: 1, ts: "t2" }),
    // A different format entirely (Constructed, per eventIdentity.ts's parsing of an unrecognized/non-dated name falls back to "Other" - use a plausible Constructed-looking one).
    reward({ eventId: "Ranked_Constructed_BO1", courseId: "c3", gems: 200, boosters: [{ setCode: "WOE", count: 1 }], ts: "t3" }),
  ];

  // --- sumRewards ---
  const total = sumRewards(rewards);
  assert.equal(total.gems, 950);
  assert.equal(total.gold, 50);
  assert.equal(total.grantedCardCount, 1);
  assert.equal(total.claimCount, 3);
  const hob = total.boosters.find((b) => b.setCode === "HOB")!;
  assert.equal(hob.count, 3); // 2 + 1, combined
  const woe = total.boosters.find((b) => b.setCode === "WOE")!;
  assert.equal(woe.count, 1);

  // --- rollupRewardsByEvent ---
  const byEvent = rollupRewardsByEvent(rewards);
  assert.equal(byEvent.size, 3);
  assert.equal(byEvent.get("QuickDraft_HOB_20260915")!.gems, 650);
  assert.equal(byEvent.get("QuickDraft_HOB_20261020")!.gold, 50);

  // --- rollupRewardsByFormat ---
  const byFormat = rollupRewardsByFormat(rewards);
  // Both QuickDraft runs are Draft-format and share a bucket; combined gems = 650 + 100.
  const draftTotal = byFormat.get("Draft")!;
  assert.ok(draftTotal, "Draft bucket should exist");
  assert.equal(draftTotal.gems, 750);
  assert.equal(draftTotal.claimCount, 2);

  console.log("OK: sumRewards/rollupRewardsByEvent/rollupRewardsByFormat total gems/gold/grantedCardCount and combine booster counts per set code, grouping correctly by exact event run and by event format.");
}

run();
