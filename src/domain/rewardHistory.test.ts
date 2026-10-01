// Coverage for milestone 21's rewardHistory.ts - both halves of "layout of
// event rewards... filter by format/set" (buildEventRewardRows, a thin
// join reusing eventHistory.ts's own .entry/.reward - see that function's
// header) and "track overall rewards from quests etc." (summarizeOverallRewards,
// reading the generic RewardGrant ledger - see RewardGrant's doc comment
// in types.ts for the real Source values this categorizes).

import assert from "node:assert/strict";
import { buildEventRewardRows, summarizeOverallRewards } from "./rewardHistory.js";
import type { EventHistorySource } from "./eventHistory.js";
import type { RewardGrant } from "./types.js";

function baseSource(): EventHistorySource {
  return { decks: [], completions: [], picks: [], packsSeen: [], matchFounds: [], matchCompletions: [], courseStandings: [], joins: [], rewards: [], cardPools: [], rewardGrants: [], handEvents: [], playedEvents: [], myScreenName: "Me" };
}

function run() {
  // --- buildEventRewardRows: one run with entry+reward, one with neither ---
  const source: EventHistorySource = {
    ...baseSource(),
    completions: [
      { kind: "DraftCompleted", eventName: "QuickDraft_HOB_20260915", courseId: "course-1", cardPool: [100, 200], draftId: "draft-1", ts: "t0" },
      { kind: "DraftCompleted", eventName: "QuickDraft_FRA_20260929", courseId: "course-2", cardPool: [300, 400], draftId: "draft-2", ts: "t1" },
    ],
    joins: [
      { kind: "DraftJoined", eventName: "QuickDraft_HOB_20260915", entryCurrencyType: "Gem_Pack_5000", entryCurrencyPaid: 1500, ts: "t0" },
    ],
    rewards: [
      {
        kind: "EventReward",
        eventId: "QuickDraft_HOB_20260915",
        courseId: "course-1",
        gems: 650,
        gold: 0,
        boosters: [{ setCode: "HOB", count: 2 }],
        grantedCardCount: 0,
        ts: "t0",
      },
    ],
  };

  const rows = buildEventRewardRows(source);
  assert.equal(rows.length, 2);
  const withReward = rows.find((r) => r.eventId === "QuickDraft_HOB_20260915")!;
  assert.equal(withReward.entry?.amountPaid, 1500);
  assert.equal(withReward.reward?.gems, 650);
  assert.deepEqual(withReward.reward?.boosters, [{ setCode: "HOB", count: 2 }]);
  const withoutReward = rows.find((r) => r.eventId === "QuickDraft_FRA_20260929")!;
  assert.equal(withoutReward.entry, null);
  assert.equal(withoutReward.reward, null);

  // --- summarizeOverallRewards: real confirmed sources + one unknown one ---
  const grants: RewardGrant[] = [
    // Two EventReward grants (from two different claims) - must combine into one eventPrizes total, boosters merged by set code.
    { kind: "RewardGrant", source: "EventReward", sourceId: "course-1", gems: 650, gold: 0, boosters: [{ setCode: "HOB", count: 2 }], grantedCardCount: 0, ts: "t0" },
    { kind: "RewardGrant", source: "EventReward", sourceId: "course-2", gems: 100, gold: 0, boosters: [{ setCode: "HOB", count: 1 }, { setCode: "FRA", count: 1 }], grantedCardCount: 0, ts: "t1" },
    // A Mastery Pass tier reward - real shape from BattlePass_FRA.LevelTrack_Level_1_Reward.
    { kind: "RewardGrant", source: "CampaignGraphTieredRewardNode", sourceId: "BattlePass_FRA.LevelTrack_Level_1_Reward", gems: 0, gold: 0, boosters: [{ setCode: "FRA", count: 1 }], grantedCardCount: 0, ts: "t2" },
    // Real EventJoin pair: a Sealed pool grant (bought) + the entry fee itself (a cost) - neither should count as "earned".
    { kind: "RewardGrant", source: "EventGrantCardPool", sourceId: "Sealed_FRA_20260929", gems: 0, gold: 0, boosters: [], grantedCardCount: 82, ts: "t3" },
    { kind: "RewardGrant", source: "EventPayEntry", sourceId: "b468aa16-15e5-4553-b1d9-83f9360afc80", gems: -3000, gold: 0, boosters: [], grantedCardCount: 0, ts: "t3" },
    // An unconfirmed/future source - must still be counted (bucketed as "other"), not dropped.
    { kind: "RewardGrant", source: "SomeFutureSource", sourceId: null, gems: 50, gold: 0, boosters: [], grantedCardCount: 0, ts: "t4" },
  ];

  const summary = summarizeOverallRewards(grants);
  assert.equal(summary.eventPrizes.gems, 750);
  assert.equal(summary.eventPrizes.grantCount, 2);
  assert.deepEqual(summary.eventPrizes.boosters.sort((a, b) => a.setCode.localeCompare(b.setCode)), [
    { setCode: "FRA", count: 1 },
    { setCode: "HOB", count: 3 },
  ]);
  assert.equal(summary.masteryPass.grantCount, 1);
  assert.deepEqual(summary.masteryPass.boosters, [{ setCode: "FRA", count: 1 }]);
  assert.equal(summary.other.gems, 50);
  assert.equal(summary.other.grantCount, 1);
  assert.equal(summary.entryFeesPaid.gems, -3000); // a cost, not earned
  assert.equal(summary.sealedPoolsReceived.grantedCardCount, 82); // a purchase, not earned

  // earnedTotal = eventPrizes + masteryPass + other only - excludes the cost and the purchase.
  assert.equal(summary.earnedTotal.gems, 800); // 750 + 0 + 50
  assert.equal(summary.earnedTotal.grantCount, 4); // 2 + 1 + 1
  assert.deepEqual(summary.earnedTotal.boosters.sort((a, b) => a.setCode.localeCompare(b.setCode)), [
    { setCode: "FRA", count: 2 },
    { setCode: "HOB", count: 3 },
  ]);

  console.log("OK: rewardHistory.ts handled per-run reward rows (with and without a captured reward) and the overall-rewards summary's real source categorization (event prizes + Mastery Pass combined into earnedTotal, entry-fee cost and Sealed-pool purchase kept separate, and an unrecognized source bucketed as 'other' rather than dropped).");
}

run();
