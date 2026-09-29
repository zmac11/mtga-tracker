// Coverage for buildEventRunHistory/listEventRuns (milestone 7 phase 2) -
// the per-event-run data layer the planned deck-viewer/draft-history UI will
// read from. Uses a fixture shaped like the real captured ContenderDraft run
// (see eventHistoryLoader.ts's real-data validation via report.ts --event=)
// plus a case with no draft data at all, to check the "no data" path.

import assert from "node:assert/strict";
import { buildEventRunHistory, listEventRuns, type EventHistorySource } from "./eventHistory.js";

function baseSource(): EventHistorySource {
  return { decks: [], completions: [], picks: [], packsSeen: [], matchFounds: [], matchCompletions: [], courseStandings: [], joins: [], rewards: [], myScreenName: "Me" };
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

  // --- winRate reconciliation against CourseStanding (milestone 12) ---
  // Real-world motivating case: local capture only has 1 decided match
  // (1-0) for this run - e.g. a match went uncaptured, the log-rotation
  // bug being the confirmed real example - but Arena's own EventGetCoursesV2
  // last reported 3-3 for the same event. The per-run winRate here must
  // show the reconciled 3-3 (max of each side), matching what the overlay's
  // live eventRecord would already show for the same event (milestone 6) -
  // otherwise the deck-viewer/report --event= pages show a different,
  // stale number than the overlay for the exact same run.
  const reconciliationSource: EventHistorySource = {
    ...baseSource(),
    matchFounds: [
      {
        kind: "MatchFound",
        matchId: "m10",
        eventId: "QuickDraft_HOB_20260915",
        players: [
          { userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null },
          { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null },
        ],
        ts: "t20",
      },
    ],
    matchCompletions: [
      { kind: "MatchCompleted", matchId: "m10", results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }], ts: "t21" },
    ],
    courseStandings: [
      // An earlier, stale snapshot - must NOT win over the later one below.
      { kind: "CourseStanding", eventId: "QuickDraft_HOB_20260915", courseId: "course-9", wins: 2, losses: 2, currentModule: "PlayMatch", deckName: "Bot Draft Deck", ts: "t19a" },
      { kind: "CourseStanding", eventId: "QuickDraft_HOB_20260915", courseId: "course-9", wins: 3, losses: 3, currentModule: "PlayMatch", deckName: "Bot Draft Deck", ts: "t19b" },
      // A standing for a different event entirely - must not leak in.
      { kind: "CourseStanding", eventId: "SomeOtherEvent", courseId: "course-other", wins: 9, losses: 9, currentModule: "PlayMatch", deckName: null, ts: "t19c" },
    ],
  };
  const reconciledHistory = buildEventRunHistory("QuickDraft_HOB_20260915", reconciliationSource);
  assert.equal(reconciledHistory.matches.length, 1, "local capture only has one decided match");
  assert.equal(reconciledHistory.winRate.wins, 3, "reconciled record should take Arena's higher win count, not the local 1");
  assert.equal(reconciledHistory.winRate.losses, 3, "reconciled record should take Arena's higher loss count, not the local 0");
  assert.equal(reconciledHistory.winRate.total, 6);
  assert.equal(reconciledHistory.winRate.pct, "50%");

  // No CourseStanding captured at all for this event -> falls back to the
  // local count unchanged, same as before this feature existed.
  const noStandingHistory = buildEventRunHistory("SomeOtherEvent", { ...reconciliationSource, matchFounds: [], matchCompletions: [], courseStandings: [] });
  assert.equal(noStandingHistory.winRate.wins, 0);
  assert.equal(noStandingHistory.winRate.losses, 0);
  assert.equal(noStandingHistory.winRate.total, 0);

  console.log("OK: buildEventRunHistory's winRate is reconciled against the latest matching CourseStanding (taking the max per side, ignoring stale/unrelated entries), and falls back to the local count when none is captured.");

  // --- Milestone 17: deck versions, entry cost, reward ---
  // Two deck submissions for the same run (a mid-event edit) - version 1
  // (deckId "v1") gets one match, version 2 (deckId "v2", content changed)
  // gets one match after the edit. `deck` (the "current" one) must resolve
  // to the LATEST submission by ts, not the first .find() match.
  const versioningSource: EventHistorySource = {
    ...baseSource(),
    decks: [
      { kind: "DeckSubmitted", eventName: "QuickDraft_HOB_20260920", deckId: "v1", deckName: "Draft Deck", mainDeck: [{ cardId: 100, quantity: 23 }], ts: "t1" },
      // Identical resubmission of the same content, later ts - must NOT count as a third version.
      { kind: "DeckSubmitted", eventName: "QuickDraft_HOB_20260920", deckId: "v1", deckName: "Draft Deck", mainDeck: [{ cardId: 100, quantity: 23 }], ts: "t1b" },
      { kind: "DeckSubmitted", eventName: "QuickDraft_HOB_20260920", deckId: "v1", deckName: "Draft Deck", mainDeck: [{ cardId: 200, quantity: 23 }], ts: "t3" },
      // A version submitted but never played - must not appear in deckVersions.
      { kind: "DeckSubmitted", eventName: "QuickDraft_HOB_20260920", deckId: "v1", deckName: "Draft Deck", mainDeck: [{ cardId: 300, quantity: 23 }], ts: "t9" },
    ],
    matchFounds: [
      { kind: "MatchFound", matchId: "vm1", eventId: "QuickDraft_HOB_20260920", players: [{ userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null }, { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null }], ts: "t2" },
      { kind: "MatchFound", matchId: "vm2", eventId: "QuickDraft_HOB_20260920", players: [{ userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null }, { userId: "u2", playerName: "Opp", systemSeatId: 2, teamId: 2, courseId: null }], ts: "t4" },
    ],
    matchCompletions: [
      { kind: "MatchCompleted", matchId: "vm1", results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 1, reason: "ResultReason_Game" }], ts: "t2b" },
      { kind: "MatchCompleted", matchId: "vm2", results: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 2, reason: "ResultReason_Game" }], ts: "t4b" },
    ],
    joins: [{ kind: "DraftJoined", eventName: "QuickDraft_HOB_20260920", entryCurrencyType: "Gems", entryCurrencyPaid: 1500, ts: "t0" }],
    rewards: [
      { kind: "EventReward", eventId: "QuickDraft_HOB_20260920", courseId: "course-v", gems: 650, gold: 0, boosters: [{ setCode: "HOB", count: 2 }], grantedCardCount: 0, ts: "t5" },
    ],
  };

  const versioningHistory = buildEventRunHistory("QuickDraft_HOB_20260920", versioningSource);

  // "Current" deck resolves to the LATEST submission (t9, cardId 300), not the first (t1).
  assert.ok(versioningHistory.deck);
  assert.deepEqual(versioningHistory.deck!.mainDeck, [{ cardId: 300, quantity: 23 }]);

  // Only the two PLAYED versions appear - the t9 resubmission (never played) is excluded.
  assert.equal(versioningHistory.deckVersions.length, 2);
  assert.equal(versioningHistory.deckVersions[0].versionNumber, 1);
  assert.deepEqual(versioningHistory.deckVersions[0].mainDeck, [{ cardId: 100, quantity: 23 }]);
  assert.equal(versioningHistory.deckVersions[0].matches.length, 1);
  assert.equal(versioningHistory.deckVersions[0].winRate.wins, 1);
  assert.equal(versioningHistory.deckVersions[0].winRate.losses, 0);

  assert.equal(versioningHistory.deckVersions[1].versionNumber, 2);
  assert.deepEqual(versioningHistory.deckVersions[1].mainDeck, [{ cardId: 200, quantity: 23 }]);
  assert.equal(versioningHistory.deckVersions[1].matches.length, 1);
  assert.equal(versioningHistory.deckVersions[1].winRate.wins, 0);
  assert.equal(versioningHistory.deckVersions[1].winRate.losses, 1);

  // The run's OVERALL winRate must be unaffected by the version split - still the total across both matches (1-1), not per-version.
  assert.equal(versioningHistory.winRate.wins, 1);
  assert.equal(versioningHistory.winRate.losses, 1);

  assert.deepEqual(versioningHistory.entry, { currencyType: "Gems", amountPaid: 1500 });
  assert.ok(versioningHistory.reward);
  assert.equal(versioningHistory.reward!.gems, 650);
  assert.deepEqual(versioningHistory.reward!.boosters, [{ setCode: "HOB", count: 2 }]);

  // No join/reward captured for a different run -> both null, not thrown.
  const noExtras = buildEventRunHistory("SomeOtherEvent", versioningSource);
  assert.equal(noExtras.entry, null);
  assert.equal(noExtras.reward, null);
  assert.equal(noExtras.deckVersions.length, 0);

  console.log("OK: buildEventRunHistory resolves the CURRENT deck to the latest submission by ts (not the first), derives deckVersions scoped to only the played/distinct-content versions with their own local win/loss records while leaving the run's overall winRate untouched, and surfaces entry cost + reward when captured.");
}

run();
