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
  assert.deepEqual((pickResp[0] as any).grpIds, [100]);

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

  // Bot Draft (QuickDraft against bots) - a genuinely different single
  // request/response pair for pack+pick, discovered 2026-09-24 from a real
  // live QuickDraft_HOB_20260915 draft. Shapes below are copied verbatim
  // from that real log (see classifier.ts's classifyBotDraftPick comment).
  const c2 = new Classifier();
  const botPickReq = c2.classify({
    direction: "request",
    method: "BotDraftDraftPick",
    ts: "b1",
    json: {
      id: "71e91350-e0d7-4e63-8299-ae3c63d59b3e",
      request: JSON.stringify({
        EventName: "QuickDraft_HOB_20260915",
        PickInfo: { EventName: "QuickDraft_HOB_20260915", CardIds: ["103509"], PackNumber: 0, PickNumber: 0 },
      }),
    },
  });
  assert.equal(botPickReq.length, 1);
  assert.equal(botPickReq[0].kind, "DraftPickMade");
  assert.equal((botPickReq[0] as any).draftId, "QuickDraft_HOB_20260915");
  assert.equal((botPickReq[0] as any).pack, 1); // 0-indexed PackNumber normalized to match Arena's own "Pack 1, Pick 1" UI
  assert.equal((botPickReq[0] as any).pick, 1);
  assert.deepEqual((botPickReq[0] as any).grpIds, [103509]);
  assert.equal((botPickReq[0] as any).success, null);

  const botPickResp = c2.classify({
    direction: "response",
    method: "BotDraftDraftPick",
    ts: "b2",
    json: {
      CurrentModule: "BotDraft",
      Payload: JSON.stringify({
        Result: "Success",
        EventName: "QuickDraft_HOB_20260915",
        DraftStatus: "PickNext",
        PackNumber: 0,
        PickNumber: 1,
        NumCardsToPick: 1,
        DraftPack: ["103479", "103388", "103494", "103507", "103415"],
        PackStyles: [],
        PickedCards: ["103509"],
        PickedStyles: [],
      }),
      DTO_InventoryInfo: {},
    },
  });
  // One event confirming the pick that was made, one for the next pack it revealed.
  assert.equal(botPickResp.length, 2);
  const confirmedPick = botPickResp.find((e) => e.kind === "DraftPickMade") as any;
  assert.deepEqual(confirmedPick.grpIds, [103509]);
  assert.equal(confirmedPick.success, true);
  const nextPack = botPickResp.find((e) => e.kind === "DraftPackSeen") as any;
  assert.equal(nextPack.draftId, "QuickDraft_HOB_20260915");
  assert.equal(nextPack.pack, 1);
  assert.equal(nextPack.pick, 2); // response's PickNumber (1) already points at the next pick
  assert.deepEqual(nextPack.packCards, [103479, 103388, 103494, 103507, 103415]);

  // EventSetDeckV3 response - deck submission. Milestone 18: also captures
  // the real Sideboard array and the deck's own Format attribute (both
  // confirmed real 2026-09-29), alongside the already-covered
  // mainDeck/deckId/deckName. Shape trimmed to the fields that matter from
  // the real 2026-09-18 capture.
  const cDeck = new Classifier();
  const deckSubmitted = cDeck.classify({
    direction: "response",
    method: "EventSetDeckV3",
    ts: "d1",
    json: {
      InternalEventName: "ContenderDraft_HOB_20260824",
      CourseDeckSummary: {
        DeckId: "d3a913d9-9b13-42df-ad52-8ba886a15117",
        Name: "Draft Deck",
        Attributes: [
          { name: "Version", value: "11" },
          { name: "Format", value: "Draft" },
        ],
      },
      CourseDeck: {
        MainDeck: [{ cardId: 100, quantity: 23 }],
        Sideboard: [{ cardId: 200, quantity: 1 }],
      },
    },
  });
  assert.equal(deckSubmitted.length, 1);
  const deckEvent = deckSubmitted[0] as any;
  assert.equal(deckEvent.deckId, "d3a913d9-9b13-42df-ad52-8ba886a15117");
  assert.deepEqual(deckEvent.mainDeck, [{ cardId: 100, quantity: 23 }]);
  assert.deepEqual(deckEvent.sideboard, [{ cardId: 200, quantity: 1 }]);
  assert.equal(deckEvent.format, "Draft");

  // No Attributes entry named "Format", and no Sideboard array at all - both
  // handled defensively (null / empty array), the submission isn't rejected.
  const cDeckBare = new Classifier();
  const deckBare = cDeckBare.classify({
    direction: "response",
    method: "EventSetDeckV3",
    ts: "d2",
    json: {
      InternalEventName: "Event2",
      CourseDeckSummary: { DeckId: "d2", Name: "Some Deck" },
      CourseDeck: { MainDeck: [{ cardId: 100, quantity: 1 }] },
    },
  });
  assert.equal((deckBare[0] as any).format, null);
  assert.deepEqual((deckBare[0] as any).sideboard, []);

  // EventGetCoursesV2 - Arena's own authoritative per-event win/loss record.
  // Shape copied from a real live log (2026-09-24), trimmed to the fields
  // that matter; a course with 0 losses (the QuickDraft one, mid-run)
  // genuinely omits "CurrentLosses" entirely rather than sending 0.
  //
  // Milestone 18: the QuickDraft course also carries a CardPool - the same
  // generic field DraftCompleted.cardPool has always come from (confirmed
  // real; see EventCardPool's doc comment in types.ts) - and must produce a
  // SEPARATE EventCardPool event alongside its CourseStanding. The Historic
  // course has no CardPool at all (the normal case for anything non-limited)
  // and must NOT produce one.
  const c3 = new Classifier();
  const standings = c3.classify({
    direction: "response",
    method: "EventGetCoursesV2",
    ts: "s1",
    json: {
      Courses: [
        {
          CourseId: "53a6566f-543e-4eff-8ee0-b7dbd5b81deb",
          InternalEventName: "Historic_Play",
          CurrentModule: "Complete",
          CourseDeckSummary: { DeckId: "d1", Name: "Some Deck" },
          CourseDeck: { MainDeck: [] },
          CurrentWins: 4,
          CurrentLosses: 3,
        },
        {
          CourseId: "50782680-58e3-44cb-9cba-11aef1e51b24",
          InternalEventName: "QuickDraft_HOB_20260915",
          CurrentModule: "CreateMatch",
          CourseDeckSummary: { DeckId: "d2", Name: "Draft Deck" },
          CourseDeck: { MainDeck: [] },
          CurrentWins: 2,
          // CurrentLosses omitted - real logs omit it entirely at 0, not send 0.
          CardPool: [100, 100, 200],
        },
      ],
    },
  });
  const courseStandingsOnly = standings.filter((e) => e.kind === "CourseStanding");
  assert.equal(courseStandingsOnly.length, 2);
  const historic = courseStandingsOnly.find((e: any) => e.eventId === "Historic_Play") as any;
  assert.equal(historic.wins, 4);
  assert.equal(historic.losses, 3);
  assert.equal(historic.deckName, "Some Deck");
  const quickDraft = courseStandingsOnly.find((e: any) => e.eventId === "QuickDraft_HOB_20260915") as any;
  assert.equal(quickDraft.wins, 2);
  assert.equal(quickDraft.losses, 0); // defaulted from the omitted key, not left undefined

  const cardPoolsFromStandings = standings.filter((e) => e.kind === "EventCardPool");
  assert.equal(cardPoolsFromStandings.length, 1, "only the course that actually had a CardPool produces one");
  assert.equal((cardPoolsFromStandings[0] as any).eventId, "QuickDraft_HOB_20260915");
  assert.deepEqual((cardPoolsFromStandings[0] as any).cardPool, [100, 100, 200]);

  // "Pick Two" draft (a real Arena format - a smaller pod, e.g. 4 players,
  // where each pick takes 2 cards instead of 1) - NOT yet confirmed against
  // a real captured log (no such session has been captured as of this
  // writing), but GrpIds/CardIds are already confirmed-real arrays even for
  // a normal 1-card pick above, so this extends that same confirmed field
  // to more entries rather than guessing an unconfirmed new shape. Covers
  // both draft paths so a real Pick Two log (whichever type it turns out to
  // be) is already handled; revisit if a real one ever shows a different
  // shape (e.g. two separate single-card requests instead of one 2-element
  // one) the same way Bot Draft's real shape corrected an earlier guess.
  const c4 = new Classifier();
  const pickTwoReq = c4.classify({
    direction: "request",
    method: "EventPlayerDraftMakePick",
    ts: "p1",
    json: { id: "req2", request: JSON.stringify({ DraftId: "d2", GrpIds: [100, 200], Pack: 1, Pick: 1 }) },
  });
  assert.equal(pickTwoReq.length, 1);
  assert.deepEqual((pickTwoReq[0] as any).grpIds, [100, 200]);

  const pickTwoResp = c4.classify({
    direction: "response",
    method: "EventPlayerDraftMakePick",
    ts: "p2",
    json: { IsPickSuccessful: true },
  });
  assert.deepEqual((pickTwoResp[0] as any).grpIds, [100, 200]);
  assert.equal((pickTwoResp[0] as any).success, true);

  const c5 = new Classifier();
  const botPickTwoReq = c5.classify({
    direction: "request",
    method: "BotDraftDraftPick",
    ts: "p3",
    json: {
      id: "req3",
      request: JSON.stringify({
        EventName: "PickTwoDraft_HOB_20260924",
        PickInfo: { EventName: "PickTwoDraft_HOB_20260924", CardIds: ["100", "200"], PackNumber: 0, PickNumber: 0 },
      }),
    },
  });
  assert.deepEqual((botPickTwoReq[0] as any).grpIds, [100, 200]);

  // EventClaimPrize response - real shape captured 2026-09-25
  // (QuickDraft_HOB_20260915), trimmed to the fields classifyEventClaimPrize
  // actually reads (see its own comment in classifier.ts for the full real
  // payload). Confirms the reward delta is read from Changes[] (matched on
  // Source === "EventReward" + SourceId === courseId), NOT from
  // InventoryInfo's own top-level Gems/Gold (those are account-wide running
  // totals, deliberately different from this fixture's per-claim numbers,
  // to catch a regression that reads the wrong field).
  const c6 = new Classifier();
  const claim = c6.classify({
    direction: "response",
    method: "EventClaimPrize",
    ts: "p4",
    json: {
      Course: {
        CourseId: "50782680-58e3-44cb-9cba-11aef1e51b24",
        InternalEventName: "QuickDraft_HOB_20260915",
        CurrentModule: "Complete",
        // Milestone 18: same generic CardPool field the EventGetCoursesV2
        // course above carries - must also produce an EventCardPool here.
        CardPool: [100, 100, 200],
      },
      InventoryInfo: {
        // Account-wide totals after the claim - must NOT be read as this claim's reward.
        Gems: 6130,
        Gold: 2175,
        Changes: [
          {
            Source: "EventReward",
            SourceId: "50782680-58e3-44cb-9cba-11aef1e51b24",
            InventoryGems: 650,
            // InventoryGold intentionally absent - see EventReward's doc comment on why gold defaults to 0.
            Boosters: [{ CollationId: 100062, SetCode: "HOB", Count: 2 }],
            GrantedCards: [],
          },
        ],
      },
    },
  });
  assert.equal(claim.length, 2);
  const rewardEvent = claim.find((e) => e.kind === "EventReward") as any;
  assert.equal(rewardEvent.eventId, "QuickDraft_HOB_20260915");
  assert.equal(rewardEvent.courseId, "50782680-58e3-44cb-9cba-11aef1e51b24");
  assert.equal(rewardEvent.gems, 650); // the claim's own delta, not InventoryInfo.Gems's running total
  assert.equal(rewardEvent.gold, 0); // key absent in the real payload - defaults to 0
  assert.deepEqual(rewardEvent.boosters, [{ setCode: "HOB", count: 2 }]);
  assert.equal(rewardEvent.grantedCardCount, 0);
  const claimCardPool = claim.find((e) => e.kind === "EventCardPool") as any;
  assert.deepEqual(claimCardPool.cardPool, [100, 100, 200]);

  // A Changes entry from a DIFFERENT course (e.g. a stale/unrelated delta in
  // the same response) must not be picked up - SourceId has to match this
  // course's own CourseId.
  const c7 = new Classifier();
  const noMatch = c7.classify({
    direction: "response",
    method: "EventClaimPrize",
    ts: "p5",
    json: {
      Course: { CourseId: "aaa", InternalEventName: "Other_Event" },
      InventoryInfo: { Changes: [{ Source: "EventReward", SourceId: "not-aaa", InventoryGems: 100 }] },
    },
  });
  assert.equal(noMatch.length, 0);

  console.log("OK: classifier handled draft pack/pick/complete, match found/completed, game-state noise filtering, Bot Draft's combined pick+next-pack response, deck submission's real sideboard/format capture, EventGetCoursesV2 standings plus the generic EventCardPool capture from a course's CardPool, a synthetic 'Pick Two' (2 cards per pick) extension of both draft paths, and EventClaimPrize's real captured reward shape (including its own CardPool capture and rejecting a SourceId that doesn't match the course).");
}

run();
