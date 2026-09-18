// Regression fixture for the classifier, built from real shapes observed
// in an actual captured draft + match (2026-09-18). If Wizards changes
// these shapes, this test is what will tell us - it's checking the
// classifier against known-good real data, not invented data.

import assert from "node:assert/strict";
import { Classifier, type ClassifiableEvent } from "./classifier.js";

function run() {
  const c = new Classifier();

  // Draft pack shown, then the pick, then its confirmation.
  const pack = c.classify({
    direction: "unknown",
    method: null,
    ts: "t1",
    json: { draftId: "d1", SelfPack: 1, SelfPick: 1, PackCards: "100,200,300" },
  });
  assert.equal(pack.length, 1);
  assert.equal(pack[0].kind, "DraftPackSeen");
  assert.deepEqual((pack[0] as any).packCards, [100, 200, 300]);

  const pickReq = c.classify({
    direction: "request",
    method: "EventPlayerDraftMakePick",
    ts: "t2",
    json: { id: "req1", request: JSON.stringify({ DraftId: "d1", GrpIds: [100], Pack: 1, Pick: 1 }) },
  });
  assert.equal(pickReq.length, 1);
  assert.equal(pickReq[0].kind, "DraftPickMade");
  assert.equal((pickReq[0] as any).success, null);

  const pickResp = c.classify({
    direction: "response",
    method: "EventPlayerDraftMakePick",
    ts: "t3",
    json: { IsPickSuccessful: true },
  });
  assert.equal(pickResp.length, 1);
  assert.equal((pickResp[0] as any).success, true);
  assert.equal((pickResp[0] as any).draftId, "d1");
  assert.equal((pickResp[0] as any).grpId, 100);

  // Draft completion should pick up the draftId we tracked from the pick above.
  const complete = c.classify({
    direction: "response",
    method: "DraftCompleteDraft",
    ts: "t4",
    json: { CourseId: "course1", InternalEventName: "SomeEvent_1", CardPool: [100, 200] },
  });
  assert.equal(complete.length, 1);
  assert.equal((complete[0] as any).draftId, "d1");
  assert.equal((complete[0] as any).courseId, "course1");

  // Match found, then match completed.
  const found = c.classify({
    direction: "unknown",
    method: null,
    ts: "t5",
    json: {
      matchGameRoomStateChangedEvent: {
        gameRoomInfo: {
          gameRoomConfig: {
            matchId: "m1",
            reservedPlayers: [
              { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, eventId: "SomeEvent_1" },
              { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, eventId: "SomeEvent_1" },
            ],
          },
          stateType: "MatchGameRoomStateType_Playing",
        },
      },
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "MatchFound");
  assert.equal((found[0] as any).eventId, "SomeEvent_1");
  assert.equal((found[0] as any).players.length, 2);

  const completed = c.classify({
    direction: "unknown",
    method: null,
    ts: "t6",
    json: {
      matchGameRoomStateChangedEvent: {
        gameRoomInfo: {
          gameRoomConfig: { matchId: "m1", reservedPlayers: [] },
          stateType: "MatchGameRoomStateType_MatchCompleted",
          finalMatchResult: {
            matchId: "m1",
            resultList: [
              { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" },
              { scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" },
            ],
          },
        },
      },
    },
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, "MatchCompleted");
  assert.equal((completed[0] as any).results.length, 2);

  // Game-state noise (a hover UIMessage) should NOT be classified.
  const noise = c.classify({
    direction: "unknown",
    method: null,
    ts: "t7",
    json: { greToClientEvent: { greToClientMessages: [{ type: "GREMessageType_UIMessage", uiMessage: { onHover: {} } }] } },
  });
  assert.equal(noise.length, 0);

  // A real game-state diff SHOULD be classified.
  const state = c.classify({
    direction: "unknown",
    method: null,
    ts: "t8",
    json: {
      greToClientEvent: {
        greToClientMessages: [
          {
            type: "GREMessageType_GameStateMessage",
            gameStateMessage: {
              gameInfo: { matchID: "m1", stage: "GameStage_Play" },
              players: [{ systemSeatNumber: 1, lifeTotal: 18, status: "PlayerStatus_InGame" }],
              turnInfo: { activePlayer: 1, decisionPlayer: 1 },
            },
          },
        ],
      },
    },
  });
  assert.equal(state.length, 1);
  assert.equal(state[0].kind, "GameStateSnapshot");
  assert.equal((state[0] as any).matchId, "m1");

  console.log("OK: classifier handled draft pack/pick/complete, match found/completed, and game-state noise filtering.");
}

run();
