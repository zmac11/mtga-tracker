// Milestone 24 (2026-10-01): first dedicated test coverage for
// matchDetails.ts - buildMatchGameDetails existed since milestone 20
// (used directly by report.ts) but had no tests of its own yet;
// averageTurnCount is new this milestone.

import assert from "node:assert/strict";
import { buildMatchGameDetails, averageTurnCount } from "./matchDetails.js";
import type { GameStateSnapshot, MatchFound } from "./types.js";

function snapshot(matchId: string, gameNumber: number | null, turnActivePlayer: number | null, players: GameStateSnapshot["players"], ts: string): GameStateSnapshot {
  return { kind: "GameStateSnapshot", matchId, gameNumber, stage: "GameStage_Play", turnActivePlayer, turnDecisionPlayer: turnActivePlayer, players, ts };
}

function run() {
  const found: MatchFound = {
    kind: "MatchFound",
    matchId: "m1",
    eventId: "QuickDraft_HOB_20260915",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "f1",
  };

  // Game 1: I'm on the play (turnActivePlayer resolves to my seat first),
  // I mulligan once, opponent doesn't, game reaches turn 8.
  const snapshots: GameStateSnapshot[] = [
    snapshot("m1", 1, 1, [
      { systemSeatNumber: 1, lifeTotal: 20, status: "PlayerStatus_Mulligan", turnNumber: undefined, mulliganCount: 1 },
      { systemSeatNumber: 2, lifeTotal: 20, status: "PlayerStatus_InGame", turnNumber: undefined, mulliganCount: undefined },
    ], "s1"),
    snapshot("m1", 1, 1, [
      { systemSeatNumber: 1, lifeTotal: 20, status: "PlayerStatus_InGame", turnNumber: 1, mulliganCount: 1 },
    ], "s2"),
    snapshot("m1", 1, 2, [
      { systemSeatNumber: 2, lifeTotal: 17, status: "PlayerStatus_InGame", turnNumber: 8, mulliganCount: undefined },
    ], "s3"),
  ];

  const details = buildMatchGameDetails(snapshots, [found], "Me");
  const game1 = details.get("m1")!;
  assert.equal(game1.length, 1);
  assert.equal(game1[0].gameNumber, 1);
  assert.equal(game1[0].iPlayedFirst, true); // first resolved turnActivePlayer (1) is my own systemSeatId
  assert.equal(game1[0].turnCount, 8); // highest turnNumber seen across either player
  assert.equal(game1[0].myMulligans, 1);
  assert.equal(game1[0].opponentMulligans, 0);

  // A second, synthetic game (gameNumber 2) of the SAME match - exercises
  // multiple games per match (the shape a real Bo3 would have, even
  // though no real Bo3 has been captured yet) and confirms games are
  // correctly separated by gameNumber rather than blended together.
  const game2Snapshots: GameStateSnapshot[] = [
    snapshot("m1", 2, 2, [
      { systemSeatNumber: 2, lifeTotal: 20, status: "PlayerStatus_InGame", turnNumber: 1, mulliganCount: undefined },
    ], "s4"),
    snapshot("m1", 2, 1, [
      { systemSeatNumber: 1, lifeTotal: 10, status: "PlayerStatus_InGame", turnNumber: 5, mulliganCount: undefined },
    ], "s5"),
  ];
  const detailsWithGame2 = buildMatchGameDetails([...snapshots, ...game2Snapshots], [found], "Me");
  const bothGames = detailsWithGame2.get("m1")!;
  assert.equal(bothGames.length, 2);
  const g2 = bothGames.find((g) => g.gameNumber === 2)!;
  assert.equal(g2.iPlayedFirst, false); // opponent (seat 2) was the first resolved active player in game 2
  assert.equal(g2.turnCount, 5);
  assert.equal(g2.myMulligans, 0);

  // A match whose snapshots never resolved a gameNumber at all is simply
  // absent from the map - not a fabricated zero-turn game.
  const noGameNumber = buildMatchGameDetails([snapshot("m2", null, 1, [{ systemSeatNumber: 1, lifeTotal: 20, status: "x", turnNumber: 3, mulliganCount: undefined }], "s6")], [found], "Me");
  assert.equal(noGameNumber.has("m2"), false);

  // No myScreenName at all -> empty map, not a crash.
  assert.equal(buildMatchGameDetails(snapshots, [found], null).size, 0);

  console.log("OK: buildMatchGameDetails resolves who-played-first/turn-count/mulligans per game, keeps multiple games of the same match separate, and omits a match/game with no resolvable data rather than fabricating one.");
}

function runAverageTurnCount() {
  const found: MatchFound = {
    kind: "MatchFound",
    matchId: "m1",
    eventId: "e1",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "f1",
  };
  const found2: MatchFound = { ...found, matchId: "m2" };

  // m1: a synthetic 2-game match - turn counts 10 and 20.
  // m2: a single game - turn count 6.
  const snapshots: GameStateSnapshot[] = [
    snapshot("m1", 1, 1, [{ systemSeatNumber: 1, lifeTotal: 20, status: "x", turnNumber: 10, mulliganCount: undefined }], "s1"),
    snapshot("m1", 2, 1, [{ systemSeatNumber: 1, lifeTotal: 20, status: "x", turnNumber: 20, mulliganCount: undefined }], "s2"),
    snapshot("m2", 1, 1, [{ systemSeatNumber: 1, lifeTotal: 20, status: "x", turnNumber: 6, mulliganCount: undefined }], "s3"),
  ];
  const gameDetails = buildMatchGameDetails(snapshots, [found, found2], "Me");

  // Per-GAME average across both matches: (10 + 20 + 6) / 3 = 12, NOT
  // (15 + 6) / 2 = 10.5 - confirms m1's two games each count as their own
  // data point rather than being pre-averaged into one per-match number.
  const both = averageTurnCount(gameDetails, ["m1", "m2"]);
  assert.equal(both.gameCount, 3);
  assert.equal(both.avgTurns, 12);

  // A single matchId still averages correctly across its own games.
  const m1Only = averageTurnCount(gameDetails, ["m1"]);
  assert.equal(m1Only.gameCount, 2);
  assert.equal(m1Only.avgTurns, 15);

  // A matchId with no captured game data at all contributes nothing -
  // null average, not a fabricated zero, when that's the only id given.
  const unknown = averageTurnCount(gameDetails, ["does-not-exist"]);
  assert.equal(unknown.gameCount, 0);
  assert.equal(unknown.avgTurns, null);

  console.log("OK: averageTurnCount averages per GAME (not per match) across whichever matchIds it's given, and returns null/0 for a matchId with no captured turn data rather than fabricating a zero.");
}

run();
runAverageTurnCount();
