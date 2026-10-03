// Focused unit coverage for deriveDeckVersions (milestone 17) - the
// content-collapsing + match-attribution logic itself, separate from
// eventHistory.test.ts's integration-level coverage (which checks it's
// wired correctly into buildEventRunHistory).

import assert from "node:assert/strict";
import { deriveDeckVersions } from "./deckVersions.js";
import type { DeckSubmitted } from "./types.js";
import type { MatchOutcome } from "./rollups.js";

function deck(
  deckId: string,
  mainDeck: Array<{ cardId: number; quantity: number }>,
  ts: string,
  sideboard: Array<{ cardId: number; quantity: number }> = [],
): DeckSubmitted {
  return { kind: "DeckSubmitted", eventName: "e", deckId, deckName: "Draft Deck", mainDeck, sideboard, format: "Draft", ts };
}

function match(matchId: string, ts: string): MatchOutcome {
  return { matchId, eventId: "e", opponent: "Opp", outcome: "WIN", reason: "ResultReason_Game", ts, games: null };
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

  // --- Milestone 18: same mainDeck, different sideboard -> a genuinely
  // different version (a Constructed postboard change), not collapsed
  // just because the maindeck matches. ---
  const sideboardChange = deriveDeckVersions(
    [
      deck("d1", [{ cardId: 1, quantity: 23 }], "t1", [{ cardId: 9, quantity: 2 }]),
      deck("d1", [{ cardId: 1, quantity: 23 }], "t5", [{ cardId: 10, quantity: 2 }]),
    ],
    [match("m1", "t2"), match("m2", "t6")],
  );
  assert.equal(sideboardChange.length, 2);
  assert.deepEqual(sideboardChange[0].sideboard, [{ cardId: 9, quantity: 2 }]);
  assert.deepEqual(sideboardChange[1].sideboard, [{ cardId: 10, quantity: 2 }]);

  // --- Milestone 18: same mainDeck AND same sideboard (order-independent) -> still one version. ---
  const sameSideboardToo = deriveDeckVersions(
    [
      deck("d1", [{ cardId: 1, quantity: 23 }], "t1", [{ cardId: 9, quantity: 1 }, { cardId: 10, quantity: 1 }]),
      deck("d1", [{ cardId: 1, quantity: 23 }], "t2", [{ cardId: 10, quantity: 1 }, { cardId: 9, quantity: 1 }]),
    ],
    [match("m1", "t3")],
  );
  assert.equal(sameSideboardToo.length, 1);

  // --- Real timestamp shape (M/D/YYYY h:mm:ss AM/PM, plus the ": Match t" suffix older match rows carry): ---
  // raw string order puts "10:..." before "1:..." and "10/..." before "9/...", so attribution must
  // go through compareTs. Edit at 1:29 PM sits between match 1 (1:11 PM) and match 2 (1:30 PM).
  const real = deriveDeckVersions(
    [deck("d1", [{ cardId: 1, quantity: 23 }], "10/2/2026 1:05:33 PM"), deck("d1", [{ cardId: 2, quantity: 23 }], "10/2/2026 1:29:52 PM")],
    [match("m1", "10/2/2026 1:11:26 PM: Match t"), match("m2", "10/2/2026 1:30:16 PM: Match t"), match("m3", "10/2/2026 10:12:00 PM: Match t")],
  );
  assert.equal(real.length, 2);
  assert.deepEqual(real.map((v) => v.matches.map((m) => m.matchId)), [["m1"], ["m2", "m3"]]);

  console.log("OK: deriveDeckVersions collapses identical-content resubmissions (order-independent across both mainDeck and, since milestone 18, sideboard), drops any version with zero attributed matches, attributes matches by ts window (falling back to the first version for a match earlier than every submission), numbers versions by submission time regardless of input array order, and treats a sideboard-only change as its own version.");
}

run();
