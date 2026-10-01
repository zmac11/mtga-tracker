// Coverage for buildPickPriorityRows (milestone 23, feature b) - "how many
// other cards were still in the pack when this card was picked", averaged
// across every capture of that card in any draft.

import assert from "node:assert/strict";
import { buildPickPriorityRows } from "./draftPickPriority.js";
import type { DraftPackSeen, DraftPickMade } from "./types.js";

function packSeen(overrides: Partial<DraftPackSeen> & Pick<DraftPackSeen, "draftId" | "pack" | "pick" | "packCards">): DraftPackSeen {
  return { kind: "DraftPackSeen", ts: "t", ...overrides };
}

function pickMade(overrides: Partial<DraftPickMade> & Pick<DraftPickMade, "draftId" | "pack" | "pick" | "grpIds">): DraftPickMade {
  return { kind: "DraftPickMade", success: true, ts: "t", ...overrides };
}

function run() {
  // Basic case: card 101 picked from a 3-card pack (2 others left), card
  // 104 picked from a 2-card pack (1 other left).
  const packsSeen: DraftPackSeen[] = [
    packSeen({ draftId: "d1", pack: 1, pick: 1, packCards: [101, 102, 103] }),
    packSeen({ draftId: "d1", pack: 1, pick: 2, packCards: [104, 105] }),
  ];
  const picks: DraftPickMade[] = [
    pickMade({ draftId: "d1", pack: 1, pick: 1, grpIds: [101] }),
    pickMade({ draftId: "d1", pack: 1, pick: 2, grpIds: [104] }),
  ];
  let rows = buildPickPriorityRows(picks, packsSeen);
  assert.deepEqual(
    rows.map((r) => [r.grpId, r.timesPicked, r.avgOthersInPack]),
    [
      [101, 1, 2],
      [104, 1, 1],
    ],
  );
  assert.equal(rows[0].minOthersInPack, 2);
  assert.equal(rows[0].maxOthersInPack, 2);

  // Same card (101) picked again in a SECOND, unrelated draft from a
  // bigger pack (7 others this time) - aggregates across drafts into one
  // row: 2 picks, avg (2+7)/2 = 4.5, min 2, max 7.
  const packsSeen2: DraftPackSeen[] = [
    ...packsSeen,
    packSeen({ draftId: "d2", pack: 1, pick: 1, packCards: [101, 1, 2, 3, 4, 5, 6, 7] }),
  ];
  const picks2: DraftPickMade[] = [...picks, pickMade({ draftId: "d2", pack: 1, pick: 1, grpIds: [101] })];
  rows = buildPickPriorityRows(picks2, packsSeen2);
  const row101 = rows.find((r) => r.grpId === 101);
  assert.equal(row101?.timesPicked, 2);
  assert.equal(row101?.avgOthersInPack, 4.5);
  assert.equal(row101?.minOthersInPack, 2);
  assert.equal(row101?.maxOthersInPack, 7);

  // Two DIFFERENT drafts reusing the same "pack 1, pick 1" label must not
  // cross-contaminate - d1's pick 1 pack has 3 cards, d2's has 8; a bug
  // that dropped draftId from the key would wrongly give 101 (from d1) the
  // d2 pack's size instead.
  assert.notEqual(row101?.minOthersInPack, 7); // would be this if d1's own capture got clobbered by d2's

  // "Pick Two" draft (2 cards taken per pick action): both cards get the
  // same "others in pack" value - the pack minus BOTH cards taken, not the
  // pack minus just one.
  const pickTwoPacksSeen: DraftPackSeen[] = [packSeen({ draftId: "p2", pack: 1, pick: 1, packCards: [1, 2, 3, 4] })];
  const pickTwoPicks: DraftPickMade[] = [pickMade({ draftId: "p2", pack: 1, pick: 1, grpIds: [1, 2] })];
  const pickTwoRows = buildPickPriorityRows(pickTwoPicks, pickTwoPacksSeen);
  assert.deepEqual(
    pickTwoRows.map((r) => [r.grpId, r.avgOthersInPack]).sort((a, b) => a[0] - b[0]),
    [
      [1, 2],
      [2, 2],
    ],
  );

  // Capture gap: a DraftPickMade with no matching DraftPackSeen at all
  // (the app wasn't running when that pack was offered) is skipped, not
  // guessed at or thrown on.
  const gapRows = buildPickPriorityRows([pickMade({ draftId: "gap", pack: 1, pick: 1, grpIds: [999] })], []);
  assert.deepEqual(gapRows, []);

  // Replayed log (--from-start) re-appending the same real pick is
  // deduped to one sample, not double-counted.
  const replayedPicks: DraftPickMade[] = [
    pickMade({ draftId: "d1", pack: 1, pick: 1, grpIds: [101], ts: "a" }),
    pickMade({ draftId: "d1", pack: 1, pick: 1, grpIds: [101], ts: "b" }), // same real pick, replayed
  ];
  const replayedRows = buildPickPriorityRows(replayedPicks, packsSeen);
  assert.equal(replayedRows.find((r) => r.grpId === 101)?.timesPicked, 1);

  // Sorted most-picked first, ties broken by grpId ascending.
  const sortRows = buildPickPriorityRows(
    [
      pickMade({ draftId: "s1", pack: 1, pick: 1, grpIds: [20] }),
      pickMade({ draftId: "s1", pack: 1, pick: 2, grpIds: [10] }),
      pickMade({ draftId: "s2", pack: 1, pick: 1, grpIds: [10] }),
    ],
    [
      packSeen({ draftId: "s1", pack: 1, pick: 1, packCards: [20] }),
      packSeen({ draftId: "s1", pack: 1, pick: 2, packCards: [10] }),
      packSeen({ draftId: "s2", pack: 1, pick: 1, packCards: [10] }),
    ],
  );
  assert.deepEqual(
    sortRows.map((r) => r.grpId),
    [10, 20], // grpId 10 picked twice (most-picked first), grpId 20 once
  );

  console.log(
    "OK: buildPickPriorityRows averages 'how many other cards were still in the pack' per card across every captured draft, scopes (pack, pick) labels by draftId so different drafts never cross-contaminate, counts both cards of a 'Pick Two' pick at the full pack size, skips a pick with no matching captured pack instead of guessing, dedupes a replayed log's repeated pick, and sorts most-picked first.",
  );
}

run();
