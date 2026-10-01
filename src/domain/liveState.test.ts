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
  assert.equal(snap.currentDraft, null);

  t.record({ kind: "PlayerIdentified", screenName: "Me", clientId: "c1", ts: "t0" });
  t.record({ kind: "DeckSubmitted", eventName: "Event1", deckId: "d1", deckName: "My Deck", mainDeck: [], sideboard: [], format: "Draft", ts: "t1" });

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
  assert.equal(snap.match?.currentGameNumber, 1); // milestone 18 (Bo3 readiness): from the GameStateSnapshot just recorded

  // Real live play (2026-09-30, first real Sealed match): a later
  // GameStateSnapshot can be a partial GRE diff carrying no player data at
  // all (confirmed real - plenty of captured snapshots have `players: []`
  // because they only touched turn/stage, not life totals) - this used to
  // blank the overlay's HP display outright by wholesale-replacing the last
  // known good snapshot. It should instead keep the last known life totals
  // while still picking up whatever *did* change (turnActivePlayer here).
  t.record({
    kind: "GameStateSnapshot",
    matchId: "m1",
    gameNumber: 1,
    stage: null,
    turnActivePlayer: 1,
    turnDecisionPlayer: 1,
    players: [],
    ts: "t3b",
  });
  snap = t.snapshot();
  assert.equal(snap.match?.me?.life, 15); // preserved, not blanked
  assert.equal(snap.match?.opponent?.life, 18); // preserved, not blanked
  assert.equal(snap.match?.activeSeat, 1); // still picks up the real change
  assert.equal(snap.match?.currentGameNumber, 1); // preserved (event.gameNumber was also set here, but stage/turn null-fallback is the point)

  t.record({
    kind: "MatchCompleted",
    matchId: "m1",
    results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Concede" }],
    ts: "t4",
  });

  snap = t.snapshot();
  assert.equal(snap.match?.outcome, "WIN");
  assert.equal(snap.match?.reason, "Concede");
  assert.equal(snap.match?.games, null); // milestone 18: this fixture's MatchCompleted has no MatchScope_Game entry, only MatchScope_Match
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

  // CourseStanding (Arena's own authoritative EventGetCoursesV2 record)
  // reporting MORE wins/losses than we've personally observed for a fresh
  // event with zero local matches - the actual bug this exists for:
  // capture missed some matches, but the overlay should still show the
  // correct total rather than undercounting.
  t.record({
    kind: "CourseStanding",
    eventId: "Event3",
    courseId: "course-3",
    wins: 3,
    losses: 2,
    currentModule: "CreateMatch",
    deckName: "Arena's Deck Name",
    ts: "t8",
  });
  t.record({
    kind: "MatchFound",
    matchId: "m4",
    eventId: "Event3",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u5", playerName: "Opp4", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "t9",
  });
  snap = t.snapshot();
  assert.equal(snap.eventRecord?.wins, 3); // we'd observed 0 decided matches locally for Event3
  assert.equal(snap.eventRecord?.losses, 2);
  assert.equal(snap.eventRecord?.pct, "60%");
  assert.equal(snap.eventRecord?.deckName, "Arena's Deck Name"); // no local DeckSubmitted for Event3, falls back to the standing's name

  // The reverse case: local capture has observed MORE than a stale
  // CourseStanding (Arena hasn't refreshed it since - it seems to lag until
  // the player returns to the home screen). The displayed record must not
  // regress backward to the lower authoritative count.
  t.record({ kind: "CourseStanding", eventId: "Event4", courseId: "course-4", wins: 1, losses: 0, currentModule: "CreateMatch", deckName: null, ts: "t10" });
  for (const [matchId, winningTeamId] of [["m5", 1], ["m6", 1], ["m7", 2]] as const) {
    t.record({
      kind: "MatchFound",
      matchId,
      eventId: "Event4",
      players: [
        { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
        { userId: "u6", playerName: "Opp5", systemSeatId: 2, teamId: 2, courseId: null },
      ],
      ts: "t11",
    });
    t.record({
      kind: "MatchCompleted",
      matchId,
      results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId, reason: "ResultReason_Game" }],
      ts: "t12",
    });
  }
  // Locally: 2 wins (m5, m6), 1 loss (m7) - exceeds the stale 1-0 standing on both counts.
  snap = t.snapshot();
  assert.equal(snap.eventRecord?.wins, 2);
  assert.equal(snap.eventRecord?.losses, 1);

  // seedHistory() - rebuilding a *fresh* tracker (simulating an overlay
  // relaunch) from events persisted by a previous run. The event record
  // should be immediately correct, with no need for a new live match or
  // CourseStanding to arrive first - this is the actual bug report:
  // "it only corrects itself after finishing another match, not right away".
  const fresh = new LiveStateTracker();
  fresh.record({ kind: "PlayerIdentified", screenName: "Me", clientId: "c1", ts: "h0" });
  fresh.seedHistory([
    { kind: "DeckSubmitted", eventName: "Event5", deckId: "d5", deckName: "Seeded Deck", mainDeck: [], sideboard: [], format: "Draft", ts: "h0" },
    {
      kind: "MatchFound",
      matchId: "m8",
      eventId: "Event5",
      players: [
        { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
        { userId: "u9", playerName: "OppOld", systemSeatId: 2, teamId: 2, courseId: null },
      ],
      ts: "h1",
    },
    {
      kind: "MatchCompleted",
      matchId: "m8",
      results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }],
      ts: "h2",
    },
    { kind: "CourseStanding", eventId: "Event5", courseId: "course-5", wins: 2, losses: 1, currentModule: "CreateMatch", deckName: "Seeded Deck", ts: "h3" },
  ]);
  // No live match yet this run - seedHistory must not make it look like one is in progress.
  let freshSnap = fresh.snapshot();
  assert.equal(freshSnap.match, null);
  // But the event record is already correct: local rollup says 1-0 for
  // Event5, the seeded CourseStanding says 2-1 - max() per side gives 2-1,
  // immediately, before this fresh tracker has recorded a single live event.
  assert.equal(freshSnap.eventRecord?.eventId, "Event5");
  assert.equal(freshSnap.eventRecord?.wins, 2);
  assert.equal(freshSnap.eventRecord?.losses, 1);
  assert.equal(freshSnap.eventRecord?.deckName, "Seeded Deck");

  // A live match starting this run should surface normally on top of the seeded history.
  fresh.record({
    kind: "MatchFound",
    matchId: "m9",
    eventId: "Event5",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u10", playerName: "OppNew", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "h4",
  });
  freshSnap = fresh.snapshot();
  assert.equal(freshSnap.match?.matchId, "m9");
  assert.equal(freshSnap.match?.opponent?.name, "OppNew");

  // Milestone 7 phase 5: live draft progress. A pack is seen, then picked
  // from, then the next pack (the wheel isn't tested here - that's phase 6 -
  // just that "current pack/pick" tracks the latest of each independently).
  t.record({ kind: "DraftPackSeen", draftId: "draftA", pack: 1, pick: 1, packCards: [101, 102, 103], ts: "d0" });
  snap = t.snapshot();
  assert.ok(snap.currentDraft);
  assert.equal(snap.currentDraft?.draftId, "draftA");
  assert.equal(snap.currentDraft?.pack, 1);
  assert.equal(snap.currentDraft?.pick, 1);
  assert.deepEqual(snap.currentDraft?.packCards, [101, 102, 103]);
  assert.deepEqual(snap.currentDraft?.picks, []);

  t.record({ kind: "DraftPickMade", draftId: "draftA", pack: 1, pick: 1, grpIds: [101], success: true, ts: "d1" });
  snap = t.snapshot();
  assert.deepEqual(snap.currentDraft?.picks, [{ pack: 1, pick: 1, grpIds: [101] }]);
  assert.equal(snap.currentDraft?.pick, 1); // next pack hasn't arrived yet - pack/pick number still reflects the last-seen pack

  t.record({ kind: "DraftPackSeen", draftId: "draftA", pack: 1, pick: 2, packCards: [104, 105], ts: "d2" });
  snap = t.snapshot();
  assert.equal(snap.currentDraft?.pick, 2);
  assert.deepEqual(snap.currentDraft?.packCards, [104, 105]);

  // Milestone 23: packsSeen carries the full pack-seen history (both packs
  // so far), not just the current one.
  assert.deepEqual(snap.currentDraft?.packsSeen, [
    { pack: 1, pick: 1, packCards: [101, 102, 103] },
    { pack: 1, pick: 2, packCards: [104, 105] },
  ]);

  // A wheeled-back pack 1/pick 1 (fewer cards left this time around) should
  // UPDATE that packsSeen entry in place to its latest-seen state, not
  // duplicate it - same "last-seen state" convention as `picks`.
  t.record({ kind: "DraftPackSeen", draftId: "draftA", pack: 1, pick: 1, packCards: [103], ts: "d2b" });
  snap = t.snapshot();
  assert.deepEqual(snap.currentDraft?.packsSeen, [
    { pack: 1, pick: 1, packCards: [103] },
    { pack: 1, pick: 2, packCards: [104, 105] },
  ]);

  // Draft finishes - no longer "current", whatever else happens to the state above.
  t.record({ kind: "DraftCompleted", eventName: "Event6", courseId: "course-6", cardPool: [101, 104], draftId: "draftA", ts: "d3" });
  snap = t.snapshot();
  assert.equal(snap.currentDraft, null);

  // A later, different draft starting up shouldn't be confused with the
  // just-completed one - it becomes the new "current" draft normally.
  t.record({ kind: "DraftPackSeen", draftId: "draftB", pack: 1, pick: 1, packCards: [201, 202], ts: "d4" });
  snap = t.snapshot();
  assert.equal(snap.currentDraft?.draftId, "draftB");
  assert.deepEqual(snap.currentDraft?.packsSeen, [{ pack: 1, pick: 1, packCards: [201, 202] }]);

  // seedHistory resuming a genuinely still-in-progress draft: unlike a
  // finished match's HUD (deliberately not resumed - see seedHistory's own
  // comment), a draft with no DraftCompleted seen yet really might still be
  // running, so this should come back live. Mixes in an OLDER, already-
  // completed draft too, to prove "most recent by real timestamp" wins over
  // array-push order (draftOld's events are seeded first).
  const freshDraft = new LiveStateTracker();
  freshDraft.seedHistory([
    { kind: "DraftPackSeen", draftId: "draftOld", pack: 1, pick: 1, packCards: [1, 2], ts: "s0" },
    { kind: "DraftPickMade", draftId: "draftOld", pack: 1, pick: 1, grpIds: [1], success: true, ts: "s1" },
    { kind: "DraftCompleted", eventName: "EventOld", courseId: "c-old", cardPool: [1], draftId: "draftOld", ts: "s2" },
    { kind: "DraftPackSeen", draftId: "draftNew", pack: 1, pick: 1, packCards: [10, 11], ts: "s3" },
    { kind: "DraftPickMade", draftId: "draftNew", pack: 1, pick: 1, grpIds: [10], success: true, ts: "s4" },
    { kind: "DraftPackSeen", draftId: "draftNew", pack: 1, pick: 2, packCards: [12, 13], ts: "s5" },
  ]);
  const draftSnap = freshDraft.snapshot();
  assert.equal(draftSnap.currentDraft?.draftId, "draftNew");
  assert.equal(draftSnap.currentDraft?.pack, 1);
  assert.equal(draftSnap.currentDraft?.pick, 2);
  assert.deepEqual(draftSnap.currentDraft?.picks, [{ pack: 1, pick: 1, grpIds: [10] }]);
  assert.deepEqual(draftSnap.currentDraft?.packsSeen, [
    { pack: 1, pick: 1, packCards: [10, 11] },
    { pack: 1, pick: 2, packCards: [12, 13] },
  ]);

  // seedHistory with ONLY a completed draft (no later activity at all) - must not resume as live.
  const freshCompletedDraft = new LiveStateTracker();
  freshCompletedDraft.seedHistory([
    { kind: "DraftPackSeen", draftId: "draftX", pack: 1, pick: 1, packCards: [1], ts: "x0" },
    { kind: "DraftCompleted", eventName: "EventX", courseId: "c-x", cardPool: [1], draftId: "draftX", ts: "x1" },
  ]);
  assert.equal(freshCompletedDraft.snapshot().currentDraft, null);

  // "Pick Two" draft (2 cards per pick action - see types.ts's
  // DraftPickMade.grpIds comment) - the picks array should carry every
  // card taken at a pick, not just the first.
  const pickTwoDraft = new LiveStateTracker();
  pickTwoDraft.record({ kind: "DraftPackSeen", draftId: "draftP2", pack: 1, pick: 1, packCards: [1, 2, 3, 4], ts: "p0" });
  pickTwoDraft.record({ kind: "DraftPickMade", draftId: "draftP2", pack: 1, pick: 1, grpIds: [1, 2], success: true, ts: "p1" });
  const pickTwoSnap = pickTwoDraft.snapshot();
  assert.deepEqual(pickTwoSnap.currentDraft?.picks, [{ pack: 1, pick: 1, grpIds: [1, 2] }]);
  assert.deepEqual(pickTwoSnap.currentDraft?.packsSeen, [{ pack: 1, pick: 1, packCards: [1, 2, 3, 4] }]);

  // Milestone 18 (Bo3 readiness): a synthetic Bo3-shaped match - three
  // MatchScope_Game entries plus one MatchScope_Match entry (same real
  // resultList structure classifier.ts already captures - see
  // rollups.test.ts's computeMatchOutcomes coverage for the same shape at
  // the pure-function level; this checks it actually reaches the overlay
  // snapshot). currentGameNumber should also track the live game-state's
  // own gameNumber as it advances.
  const bo3 = new LiveStateTracker();
  bo3.record({ kind: "PlayerIdentified", screenName: "Me", clientId: "c-bo3", ts: "b0" });
  bo3.record({
    kind: "MatchFound",
    matchId: "bo3-m1",
    eventId: "Ladder_Standard_20260101",
    players: [
      { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
      { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
    ],
    ts: "b1",
  });
  bo3.record({ kind: "GameStateSnapshot", matchId: "bo3-m1", gameNumber: 2, stage: "GameStage_Play", turnActivePlayer: 1, turnDecisionPlayer: 1, players: [], ts: "b2" });
  assert.equal(bo3.snapshot().match?.currentGameNumber, 2);

  bo3.record({
    kind: "MatchCompleted",
    matchId: "bo3-m1",
    results: [
      { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 2, reason: "ResultReason_Game" },
      { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
      { scope: "MatchScope_Game", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
      { scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" },
    ],
    ts: "b3",
  });
  const bo3Snap = bo3.snapshot();
  assert.equal(bo3Snap.match?.outcome, "WIN");
  assert.deepEqual(bo3Snap.match?.games, {
    wins: 2,
    losses: 1,
    sequence: [
      { gameNumber: 1, outcome: "LOSS" },
      { gameNumber: 2, outcome: "WIN" },
      { gameNumber: 3, outcome: "WIN" },
    ],
  });

  console.log(
    "OK: LiveStateTracker handled match found/game-state/completed, accumulating win rate per event without cross-contamination, reconciled with Arena's own CourseStanding in both directions, seeded correct history at startup without faking a live match, tracked/resumed live draft progress correctly, carries every card from a multi-card 'Pick Two' pick, and (milestone 18) surfaces the live game number and a completed match's own per-game Bo3 score.",
  );
}

run();
