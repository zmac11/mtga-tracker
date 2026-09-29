// Focused unit coverage for deriveDeckVersions (milestone 17) - the
// content-collapsing + match-attribution logic itself, separate from
// eventHistory.test.ts's integration-level coverage (which checks it's
// wired correctly into buildEventRunHistory).

import assert from "node:assert/strict";
import { deriveDeckVersions } from "./deckVersions.js";
import type { DeckSubmitted } from "./types.js";
import type { MatchOutcome } from "./rollups.js";

function deck(deckId: string, mainDeck: Array<{ cardId: number; quantity: number }>, ts: string): DeckSubmitted {
  return { kind: "DeckSubmitted", eventName: "e", deckId, deckName: "Draft Deck", mainDeck, ts };
}

function match(matchId: string, ts: string): MatchOutcome {
  return { matchId, eventId: "e", opponent: "Opp", outcome: "WIN", reason: "ResultReason_Game", ts };
}

function run() {
  // --- No submissions at all -> no versions, regardless of matches. ---
  assert.deepEqual(deriveDeckVersions([], [match("m1", "t1")]), []);

  // --- One submission, one match -> one version. ---
  const single = deriveDeckVersions([deck("d1", [{ cardId: 1, quantity: 23 }], "t1")], [match("m1", "t2")]);
  assert.equal(single.length, 1);
  assert.equal(single[0].versionNumber, 1);
  assert.equal(single[0].matches.length, 1);

  // --- A submission with ZERO matches is dropped entirely. ---
  const unplayed = deriveDeckVersions([deck("d1", [{ cardId: 1, quantity: 23 }], "t1")], []);
  assert.deepEqual(unplayed, []);

  // --- Identical content resubmitted (different ts) collapses to one version, not two. ---
  const sameContentTwice = deriveDeckVersions(
    [deck("d1", [{ cardId: 1, quantity: 23 }], "t1"), deck("d1", [{ cardId: 1, quantity: 23 }], "t2")],
    [match("m1", "t3")],
  );
  assert.equal(sameContentTwice.length, 1);

  // --- Content order doesn't matter for the "same version" content key. ---
  const reorderedSameContent = deriveDeckVersions(
    [
      deck("d1", [{ cardId: 1, quantity: 2 }, { cardId: 2, quantity: 1 }], "t1"),
      deck("d1", [{ cardId: 2, quantity: 1 }, { cardId: 1, quantity: 2 }], "t2"),
    ],
    [match("m1", "t3")],
  );
  assert.equal(reorderedSameContent.length, 1);

  // --- Two genuinely different versions, matches correctly attributed by ts window, unplayed later resubmission dropped. ---
  const submissions = [
    deck("d1", [{ cardId: 1, quantity: 23 }], "t1"), // version 1
    deck("d1", [{ cardId: 2, quantity: 23 }], "t5"), // version 2
    deck("d1", [{ cardId: 3, quantity: 23 }], "t9"), // never played
  ];
  const matches = [
    match("m1", "t2"), // before version 2's submission -> version 1
    match("m2", "t3"), // still before version 2 -> version 1
    match("m3", "t6"), // after version 2's submission -> version 2
  ];
  const versions = deriveDeckVersions(submissions, matches);
  assert.equal(versions.length, 2); // version 3 (t9) dropped - never played
  assert.equal(versions[0].versionNumber, 1);
  assert.deepEqual(versions[0].matches.map((m) => m.matchId).sort(), ["m1", "m2"]);
  assert.equal(versions[0].winRate.wins, 2);
  assert.equal(versions[1].versionNumber, 2);
  assert.deepEqual(versions[1].matches.map((m) => m.matchId), ["m3"]);
  assert.equal(versions[1].winRate.wins, 1);

  // --- A match with ts EARLIER than every submission falls back to the first version, rather than being dropped. ---
  const earlyMatch = deriveDeckVersions(
    [deck("d1", [{ cardId: 1, quantity: 23 }], "t5"), deck("d1", [{ cardId: 2, quantity: 23 }], "t9")],
    [match("m1", "t1")],
  );
  assert.equal(earlyMatch.length, 1);
  assert.equal(earlyMatch[0].versionNumber, 1);
  assert.equal(earlyMatch[0].matches.length, 1);

  // --- Submissions passed out of order are still processed in ts order (version numbering follows submission time, not array order). ---
  const outOfOrder = deriveDeckVersions(
    [deck("d1", [{ cardId: 2, quantity: 23 }], "t5"), deck("d1", [{ cardId: 1, quantity: 23 }], "t1")],
    [match("m1", "t2"), match("m2", "t6")],
  );
  assert.equal(outOfOrder.length, 2);
  assert.deepEqual(outOfOrder[0].mainDeck, [{ cardId: 1, quantity: 23 }]);
  assert.deepEqual(outOfOrder[1].mainDeck, [{ cardId: 2, quantity: 23 }]);

  console.log("OK: deriveDeckVersions collapses identical-content resubmissions (order-independent), drops any version with zero attributed matches, attributes matches by ts window (falling back to the first version for a match earlier than every submission), and numbers versions by submission time regardless of input array order.");
}

run();
