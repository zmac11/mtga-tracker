// Regression test for attributeDraftWheel (milestone 7 phase 6), using the
// EXACT real captured pack/pick data from the 2026-09-18 ContenderDraft run
// (pack 1, all 14 picks - an 8-person human/Traditional-draft pod) - not
// synthetic data. This is the same real draft that confirmed the wheel
// mechanism in the first place (see draftWheel.ts's file comment and
// feature-roadmap-milestone7.md's phase 6 notes): pod size 8, so pick K's
// pack wheels back around at pick K+8 whenever that pick exists in the same
// pack-number group.

import assert from "node:assert/strict";
import { attributeDraftWheel } from "./draftWheel.js";
import type { DraftPackSeen, DraftPickMade } from "./types.js";

const PACK1_CARDS: Record<number, number[]> = {
  1: [103564, 103519, 103445, 103421, 103381, 103484, 103436, 103407, 103409, 103439, 103505, 103465, 103385, 103566],
  2: [103487, 103377, 103537, 103415, 103497, 103369, 103456, 103396, 103513, 103525, 103539, 103435, 103572],
  3: [103520, 103515, 103436, 103485, 103555, 103386, 103389, 103405, 103518, 103376, 103483, 103567],
  4: [103540, 103368, 103391, 103519, 103418, 103455, 103568, 103386, 103449, 103545, 103579],
  5: [103401, 103368, 103508, 103413, 103486, 103513, 103410, 103447, 103517, 103569],
  6: [103513, 103542, 103448, 103564, 103396, 103460, 103425, 103558, 103580],
  7: [103369, 103540, 103568, 103399, 103464, 103429, 103511, 103567],
  8: [103519, 103501, 103413, 103401, 103441, 103541, 103569],
  9: [103564, 103519, 103421, 103381, 103484, 103409],
  10: [103377, 103415, 103369, 103396, 103513],
  11: [103555, 103386, 103389, 103376],
  12: [103568, 103386, 103579],
  13: [103401, 103569],
  14: [103580],
};

const PACK1_PICKS: Record<number, number> = {
  1: 103465,
  2: 103539,
  3: 103483,
  4: 103449,
  5: 103447,
  6: 103460,
  7: 103369,
  8: 103441,
  9: 103484,
  10: 103369,
  11: 103555,
  12: 103568,
  13: 103569,
  14: 103580,
};

function buildFixture(): { picks: DraftPickMade[]; packsSeen: DraftPackSeen[] } {
  const draftId = "2710b648-b120-4d70-93a9-8a6ba03a6a4f";
  const packsSeen: DraftPackSeen[] = Object.entries(PACK1_CARDS).map(([pick, packCards]) => ({
    kind: "DraftPackSeen",
    draftId,
    pack: 1,
    pick: Number(pick),
    packCards,
    ts: "t",
  }));
  const picks: DraftPickMade[] = Object.entries(PACK1_PICKS).map(([pick, grpId]) => ({
    kind: "DraftPickMade",
    draftId,
    pack: 1,
    pick: Number(pick),
    grpId,
    success: true,
    ts: "t",
  }));
  return { picks, packsSeen };
}

function run() {
  const { picks, packsSeen } = buildFixture();
  const attributed = attributeDraftWheel(picks, packsSeen);

  assert.equal(attributed.length, 14);
  assert.equal(attributed[0].pack, 1);
  assert.equal(attributed[0].pick, 1);

  // Pick 1's pack wheels back at pick 9 (pod size 8, confirmed against real
  // data) - takenByOthers is pick 1's pack minus pick 9's pack minus this
  // player's own pick-1 card (103465).
  const pick1 = attributed.find((a) => a.pick === 1)!;
  assert.deepEqual(pick1.wheel.wheeledAt, { pack: 1, pick: 9 });
  assert.deepEqual(
    [...pick1.wheel.takenByOthers].sort((a, b) => a - b),
    [103385, 103407, 103436, 103439, 103445, 103505, 103566].sort((a, b) => a - b),
  );
  assert.ok(!pick1.wheel.takenByOthers.includes(103465)); // this player's own pick never counted as "taken by someone else"

  // Pick 2 wheels to pick 10, same offset.
  const pick2 = attributed.find((a) => a.pick === 2)!;
  assert.deepEqual(pick2.wheel.wheeledAt, { pack: 1, pick: 10 });
  assert.equal(pick2.wheel.takenByOthers.length, 7); // 13 cards -> 5 cards = 8 gone, minus this player's own pick-2 card

  // Pick 9 (the wheeled-back pack itself) has no further wheel within this
  // pack's remaining picks - correct: a third pass would need 8 more picks
  // than pick 9, and pack 1 only has 14 total.
  const pick9 = attributed.find((a) => a.pick === 9)!;
  assert.equal(pick9.wheel.wheeledAt, null);
  assert.deepEqual(pick9.wheel.takenByOthers, []);

  // Picks 7 and 8 are too close to the end of the round for their pack to
  // ever wheel back (would need pick 15/16, which don't exist here) -
  // correctly report no wheel rather than a false match.
  for (const pickNum of [7, 8]) {
    const p = attributed.find((a) => a.pick === pickNum)!;
    assert.equal(p.wheel.wheeledAt, null, `pick ${pickNum} should have no wheel`);
  }

  // The very last pick (only 1 card, nothing later to compare against) - no crash, no wheel.
  const pick14 = attributed.find((a) => a.pick === 14)!;
  assert.equal(pick14.wheel.wheeledAt, null);
  assert.equal(pick14.grpId, 103580);

  // A capture gap - a pack was seen but no matching pick was ever captured
  // (e.g. the log-rotation bug) - is skipped rather than guessing what was taken.
  const withGap = attributeDraftWheel(
    picks.filter((p) => p.pick !== 5),
    packsSeen,
  );
  assert.equal(withGap.length, 13);
  assert.equal(withGap.some((a) => a.pick === 5), false);

  console.log("OK: attributeDraftWheel correctly attributes the real 2026-09-18 ContenderDraft pack 1 wheel pattern (pod size 8, pick K wheels to pick K+8), including no-wheel cases near the end of the round and graceful handling of a capture gap.");
}

run();
