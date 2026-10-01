// Milestone 24 (2026-10-01): first dedicated test coverage for
// statsRollup.ts, added while wiring in totalTurns/turnGameCount.

import assert from "node:assert/strict";
import { buildLimitedStatsRows } from "./statsRollup.js";
import type { EventHistorySource } from "./eventHistory.js";
import type { MatchFound, MatchCompleted, GameStateSnapshot, DraftCompleted } from "./types.js";

function emptySource(overrides: Partial<EventHistorySource>): EventHistorySource {
  return {
    decks: [], completions: [], picks: [], packsSeen: [], matchFounds: [], matchCompletions: [],
    courseStandings: [], joins: [], rewards: [], cardPools: [], rewardGrants: [], handEvents: [],
    playedEvents: [], gameStateSnapshots: [], myScreenName: "Me",
    ...overrides,
  };
}

function snapshot(matchId: string, gameNumber: number, turnNumber: number, ts: string): GameStateSnapshot {
  return { kind: "GameStateSnapshot", matchId, gameNumber, stage: "GameStage_Play", turnActivePlayer: 1, turnDecisionPlayer: 1, players: [{ systemSeatNumber: 1, lifeTotal: 20, status: "x", turnNumber }], ts };
}

function run() {
  const found1: MatchFound = {
    kind: "MatchFound", matchId: "m1", eventId: "QuickDraft_HOB_20260915",
    players: [{ userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null }, { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null }],
    ts: "t1",
  };
  const found2: MatchFound = { ...found1, matchId: "m2", ts: "t2" };
  const completion1: MatchCompleted = { kind: "MatchCompleted", matchId: "m1", results: [{ scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }, { scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }], ts: "t1b" };
  const completion2: MatchCompleted = { ...completion1, matchId: "m2", ts: "t2b" };
  // listEventRuns needs at least one real signal to form a "Draft" run - a
  // DraftCompleted keeps this run's format resolved as Draft rather than
  // the name-based QuickDraft guess (which already happens to say Draft
  // too, but this is the real join every other limited-stats row uses).
  const completed: DraftCompleted = { kind: "DraftCompleted", eventName: "QuickDraft_HOB_20260915", draftId: "d1", courseId: "course1", cardPool: [], ts: "t0" };

  const source = emptySource({
    matchFounds: [found1, found2],
    matchCompletions: [completion1, completion2],
    completions: [completed],
    // m1: two games (10, 20 turns); m2: one game (6 turns).
    gameStateSnapshots: [snapshot("m1", 1, 10, "s1"), snapshot("m1", 2, 20, "s2"), snapshot("m2", 1, 6, "s3")],
  });

  const rows = buildLimitedStatsRows(source, new Map());
  assert.equal(rows.length, 1);
  // Per-GAME total: 10 + 20 + 6 = 36 across 3 games, not (15 + 6) averaged
  // per match - same "per game, not per match" convention as elsewhere.
  assert.equal(rows[0].totalTurns, 36);
  assert.equal(rows[0].turnGameCount, 3);

  // A run with zero captured turn data gets 0/0, not a crash or a
  // fabricated non-zero value.
  const noTurnData = buildLimitedStatsRows(emptySource({ matchFounds: [found1], matchCompletions: [completion1], completions: [completed] }), new Map());
  assert.equal(noTurnData[0].totalTurns, 0);
  assert.equal(noTurnData[0].turnGameCount, 0);

  console.log("OK: buildLimitedStatsRows sums turn counts per GAME (not per match) across a run's matches, via the new totalTurns/turnGameCount fields, staying 0/0 rather than crashing when no turn data was captured.");
}

run();
