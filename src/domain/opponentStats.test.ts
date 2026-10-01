// Milestone 24 (2026-10-01): first dedicated test coverage for
// opponentStats.ts, added while wiring in turnCounts (previously this
// file had none - buildEventRunHistory/listEventRuns already have their
// own coverage, but the per-match row-building here never did).

import assert from "node:assert/strict";
import { buildOpponentMatchRows } from "./opponentStats.js";
import type { EventHistorySource } from "./eventHistory.js";
import type { MatchFound, MatchCompleted, GameStateSnapshot } from "./types.js";

function emptySource(overrides: Partial<EventHistorySource>): EventHistorySource {
  return {
    decks: [], completions: [], picks: [], packsSeen: [], matchFounds: [], matchCompletions: [],
    courseStandings: [], joins: [], rewards: [], cardPools: [], rewardGrants: [], handEvents: [],
    playedEvents: [], gameStateSnapshots: [], manualResults: [], myScreenName: "Me",
    ...overrides,
  };
}

function snapshot(matchId: string, gameNumber: number, turnActivePlayer: number, turnNumber: number, ts: string): GameStateSnapshot {
  return { kind: "GameStateSnapshot", matchId, gameNumber, stage: "GameStage_Play", turnActivePlayer, turnDecisionPlayer: turnActivePlayer, players: [{ systemSeatNumber: turnActivePlayer, lifeTotal: 20, status: "x", turnNumber }], ts };
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
    ts: "t1",
  };
  const completion: MatchCompleted = {
    kind: "MatchCompleted",
    matchId: "m1",
    results: [
      { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
      { scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
    ],
    ts: "t2",
  };

  // A match covered by a real run (listEventRuns finds it via its eventId)
  // with real turn data captured for it.
  const source = emptySource({
    matchFounds: [found],
    matchCompletions: [completion],
    gameStateSnapshots: [snapshot("m1", 1, 1, 9, "s1")],
  });
  const rows = buildOpponentMatchRows(source);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].turnCounts, [9]);

  // A match with NO captured snapshot data at all -> empty array, not a
  // fabricated [0].
  const noSnapshots = buildOpponentMatchRows(emptySource({ matchFounds: [found], matchCompletions: [completion] }));
  assert.deepEqual(noSnapshots[0].turnCounts, []);

  // The no-run fallback path (a match with no eventId at all, so
  // listEventRuns/buildEventRunHistory never cover it) still resolves
  // turnCounts the same way.
  const noEventId: MatchFound = { ...found, matchId: "m2", eventId: null };
  const completion2: MatchCompleted = { ...completion, matchId: "m2" };
  const fallback = buildOpponentMatchRows(
    emptySource({ matchFounds: [noEventId], matchCompletions: [completion2], gameStateSnapshots: [snapshot("m2", 1, 1, 4, "s2")] }),
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].format, "Unknown");
  assert.deepEqual(fallback[0].turnCounts, [4]);

  console.log("OK: buildOpponentMatchRows attaches each match's per-game turnCounts (both via a real event run and the no-eventId fallback path), leaving it empty rather than fabricated when no turn data was captured.");
}

run();
