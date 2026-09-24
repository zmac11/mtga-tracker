// Coverage for buildEventRunHistory/listEventRuns (milestone 7 phase 2) -
// the per-event-run data layer the planned deck-viewer/draft-history UI will
// read from. Uses a fixture shaped like the real captured ContenderDraft run
// (see eventHistoryLoader.ts's real-data validation via report.ts --event=)
// plus a case with no draft data at all, to check the "no data" path.

import assert from "node:assert/strict";
import { buildEventRunHistory, listEventRuns, type EventHistorySource } from "./eventHistory.js";

function baseSource(): EventHistorySource {
  return { decks: [], completions: [], picks: [], packsSeen: [], matchFounds: [], matchCompletions: [], myScreenName: "Me" };
}

function run() {
  // --- Full run: draft completed, deck submitted, matches played ---
  const source: EventHistorySource = {
    ...baseSource(),
    completions: [
      { kind: "DraftCompleted", eventName: "ContenderDraft_HOB_20260824", courseId: "course-1", cardPool: [100, 100, 200, 300, 400], draftId: "draft-1", ts: "t0" },
    ],
    decks: [
      { kind: "DeckSubmitted", eventName: "ContenderDraft_HOB_20260824", deckId: "deck-1", deckName: "My Deck", mainDeck: [{ cardId: 100, quantity: 1 }, { cardId: 200, quantity: 1 }], ts: "t1" },
    ],
    picks: [
      // Out of order and with an unconfirmed/confirmed duplicate for the same (pack, pick) - dedup should keep the confirmed one and the final order should be sorted.
      { kind: "DraftPickMade", draftId: "draft-1", pack: 1, pick: 2, grpIds: [200], success: null, ts: "t2a" },
      { kind: "DraftPickMade", draftId: "draft-1", pack: 1, pick: 1, grpIds: [100], success: null, ts: "t2b" },
      { kind: "DraftPickMade", draftId: "draft-1", pack: 1, pick: 1, grpIds: [100], success: true, ts: "t2c" },
      { kind: "DraftPickMade", draftId: "draft-1", pack: 1, pick: 2, grpIds: [200], success: true, ts: "t2d" },
      // A pick under a DIFFERENT draftId - must not leak into this run's history.
      { kind: "DraftPickMade", draftId: "unrelated-draft", pack: 1, pick: 1, grpIds: [999], success: true, ts: "t2e" },
    ],
    packsSeen: [
      { kind: "DraftPackSeen", draftId: "draft-1", pack: 1, pick: 1, packCards: [100, 500, 600], ts: "t3" },
      { kind: "DraftPackSeen", draftId: "unrelated-draft", pack: 1, pick: 1, packCards: [999], ts: "t3b" },
    ],
    matchFounds: [
      {
        kind: "MatchFound",
        matchId: "m1",
        eventId: "ContenderDraft_HOB_20260824",
        players: [
          { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
          { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
        ],
        ts: "t4",
      },
      // A match under a different event - must not be included.
      {
        kind: "MatchFound",
        matchId: "m2",
        eventId: "SomeOtherEvent",
        players: [
          { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
          { userId: "u3", playerName: "Opp2", systemSeatId: 2, teamId: 2, courseId: null },
        ],
        ts: "t5",
      },
    ],
    matchCompletions: [
      { kind: "MatchCompleted", matchId: "m1", results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }], ts: "t6" },
      { kind: "MatchCompleted", matchId: "m2", results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 2, reason: "ResultReason_Game" }], ts: "t7" },
    ],
  };

  const history = buildEventRunHistory("ContenderDraft_HOB_20260824", source);
  assert.equal(history.identity.definitionKey, "ContenderDraft_HOB");
  assert.equal(history.cardPool?.length, 5);

  // Deck + derived sideboard: pool [100,100,200,300,400] minus mainDeck [100x1, 200x1] = [100x1, 300x1, 400x1].
  assert.ok(history.deck);
  assert.equal(history.deck!.deckName, "My Deck");
  const sideboard = history.deck!.sideboard!;
  assert.ok(sideboard);
  const sideboardMap = new Map(sideboard.map((c) => [c.cardId, c.quantity]));
  assert.equal(sideboardMap.get(100), 1);
  assert.equal(sideboardMap.get(300), 1);
  assert.equal(sideboardMap.get(400), 1);
  assert.equal(sideboardMap.has(200), false); // fully used in the maindeck, shouldn't appear at 0 qty

  // Picks: deduped to the confirmed entry per (pack, pick), sorted, and scoped to this run's draftId only.
  assert.equal(history.picks.length, 2);
  assert.equal(history.picks[0].pick, 1);
  assert.equal(history.picks[0].success, true);
  assert.equal(history.picks[1].pick, 2);
  assert.ok(history.picks.every((p) => p.draftId === "draft-1"));

  // Packs seen: scoped to this run's draftId only.
  assert.equal(history.packsSeen.length, 1);
  assert.equal(history.packsSeen[0].draftId, "draft-1");

  // Matches: scoped to this run's eventId only.
  assert.equal(history.matches.length, 1);
  assert.equal(history.matches[0].outcome, "WIN");
  assert.equal(history.winRate.wins, 1);
  assert.equal(history.winRate.losses, 0);

  // --- listEventRuns: should list every distinct eventId with data, from any of the three sources ---
  const sourceWithMoreRuns: EventHistorySource = {
    ...source,
    // A run with ONLY a match (no draft/deck at all) - still must be listed.
    matchFounds: [
      ...source.matchFounds,
      {
        kind: "MatchFound",
        matchId: "m3",
        eventId: "DualColorPrecons",
        players: [
          { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
          { userId: "u4", playerName: "Opp3", systemSeatId: 2, teamId: 2, courseId: null },
        ],
        ts: "t8",
      },
    ],
  };
  const runs = listEventRuns(sourceWithMoreRuns);
  const runIds = runs.map((r) => r.eventId).sort();
  assert.deepEqual(runIds, ["ContenderDraft_HOB_20260824", "DualColorPrecons", "SomeOtherEvent"]);

  // --- A run with no draft data at all (e.g. Bot Draft that never reached completion) - deck/cardPool null, empty picks/packs, but matches still work. ---
  const noDraftHistory = buildEventRunHistory("SomeOtherEvent", sourceWithMoreRuns);
  assert.equal(noDraftHistory.deck, null);
  assert.equal(noDraftHistory.cardPool, null);
  assert.equal(noDraftHistory.picks.length, 0);
  assert.equal(noDraftHistory.packsSeen.length, 0);
  assert.equal(noDraftHistory.matches.length, 1);
  assert.equal(noDraftHistory.matches[0].outcome, "LOSS");

  console.log("OK: buildEventRunHistory scopes deck/sideboard/picks/packs/matches correctly to one run, and listEventRuns finds every run across all three source event kinds.");
}

run();
