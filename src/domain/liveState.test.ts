// Fixture test for LiveStateTracker, using the same real event shapes as
// classifier.test.ts (2026-09-18 draft + match). Checks that feeding events
// in the order the classifier actually emits them (identify -> deck ->
// match found -> game state -> match completed) produces a sane overlay
// snapshot at each stage, plus that a second event/match doesn't get its
// win rate mixed up with the first.

import assert from "node:assert/strict";
import { LiveStateTracker } from "./liveState.js";
import type { DomainEvent } from "./types.js";

function run() {
  const t = new LiveStateTracker();

  // No events yet - snapshot should be all-empty, not throw.
  let snap = t.snapshot();
  assert.equal(snap.myScreenName, null);
  assert.equal(snap.match, null);
  assert.equal(snap.eventRecord, null);

  t.record({ kind: "PlayerIdentified", screenName: "Me", clientId: "c1", ts: "t0" });
  t.record({ kind: "DeckSubmitted", eventName: "Event1", deckId: "d1", deckName: "My Deck", mainDeck: [], ts: "t1" });

  t.record({
    kind: "MatchFound",
    matchId: "m1",
    eventId: "Event1",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "t2",
  });

  snap = t.snapshot();
  assert.ok(snap.match);
  assert.equal(snap.match?.me?.name, "Me");
  assert.equal(snap.match?.opponent?.name, "Opp");
  assert.equal(snap.match?.me?.life, null); // no game state yet
  assert.equal(snap.match?.outcome, null);
  assert.equal(snap.eventRecord?.eventId, "Event1");
  assert.equal(snap.eventRecord?.deckName, "My Deck");
  assert.equal(snap.eventRecord?.total, 0); // no decided matches yet

  t.record({
    kind: "GameStateSnapshot",
    matchId: "m1",
    gameNumber: 1,
    stage: "GameStage_Play",
    turnActivePlayer: 2,
    turnDecisionPlayer: 2,
    players: [
      { systemSeatNumber: 1, lifeTotal: 15, status: "PlayerStatus_InGame" },
      { systemSeatNumber: 2, lifeTotal: 18, status: "PlayerStatus_InGame" },
    ],
    ts: "t3",
  });

  snap = t.snapshot();
  assert.equal(snap.match?.me?.life, 15);
  assert.equal(snap.match?.opponent?.life, 18);
  assert.equal(snap.match?.activeSeat, 2);

  t.record({
    kind: "MatchCompleted",
    matchId: "m1",
    results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" }],
    ts: "t4",
  });

  snap = t.snapshot();
  assert.equal(snap.match?.outcome, "WIN");
  assert.equal(snap.match?.reason, "Concede");
  assert.equal(snap.eventRecord?.wins, 1);
  assert.equal(snap.eventRecord?.losses, 0);
  assert.equal(snap.eventRecord?.pct, "100%");

  // A second match, same event: win rate should accumulate, not reset.
  t.record({
    kind: "MatchFound",
    matchId: "m2",
    eventId: "Event1",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u3", playerName: "Opp2", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "t5",
  });
  t.record({
    kind: "MatchCompleted",
    matchId: "m2",
    results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 2, reason: "ResultReason_Game" }],
    ts: "t6",
  });

  snap = t.snapshot();
  assert.equal(snap.match?.matchId, "m2");
  assert.equal(snap.match?.outcome, "LOSS");
  assert.equal(snap.eventRecord?.wins, 1);
  assert.equal(snap.eventRecord?.losses, 1);
  assert.equal(snap.eventRecord?.pct, "50%");

  // A match under a *different* event shouldn't pollute Event1's record.
  t.record({
    kind: "MatchFound",
    matchId: "m3",
    eventId: "Event2",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u4", playerName: "Opp3", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "t7",
  });
  snap = t.snapshot();
  assert.equal(snap.eventRecord?.eventId, "Event2");
  assert.equal(snap.eventRecord?.total, 0);

  console.log("OK: LiveStateTracker handled match found/game-state/completed, accumulating win rate per event without cross-contamination.");
}

run();
