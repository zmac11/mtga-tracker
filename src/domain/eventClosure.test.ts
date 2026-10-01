import assert from "node:assert/strict";
import { findPendingClosures } from "./eventClosure.js";
import type { EventHistorySource } from "./eventHistory.js";
import type { DraftJoined, MatchFound, CourseStanding, EventReward, ManualCourseResult } from "./types.js";

function emptySource(overrides: Partial<EventHistorySource> = {}): EventHistorySource {
  return {
    decks: [],
    completions: [],
    picks: [],
    packsSeen: [],
    matchFounds: [],
    matchCompletions: [],
    courseStandings: [],
    joins: [],
    rewards: [],
    cardPools: [],
    rewardGrants: [],
    handEvents: [],
    playedEvents: [],
    gameStateSnapshots: [],
    manualResults: [],
    myScreenName: "Me",
    ...overrides,
  };
}

function join(eventName: string, ts: string): DraftJoined {
  return { kind: "DraftJoined", eventName, entryCurrencyType: "Gold", entryCurrencyPaid: 1000, ts };
}

function matchFound(eventId: string, matchId: string, ts: string): MatchFound {
  return {
    kind: "MatchFound",
    matchId,
    eventId,
    players: [{ userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null }],
    ts,
  };
}

function standing(eventId: string, courseId: string, wins: number, losses: number, currentModule: string | null, ts: string): CourseStanding {
  return { kind: "CourseStanding", eventId, courseId, wins, losses, currentModule, deckName: null, ts };
}

function reward(eventId: string, courseId: string, ts: string): EventReward {
  return { kind: "EventReward", eventId, courseId, gems: 500, gold: 0, boosters: [], grantedCardCount: 0, ts };
}

function manual(eventId: string, courseId: string | null, wins: number, losses: number, ts: string): ManualCourseResult {
  return { kind: "ManualCourseResult", eventId, courseId, wins, losses, ts };
}

function run() {
  // A first Sealed run that never reached "Complete", then a second Sealed
  // run starts later - the first should be flagged pending, carrying its
  // last-known (non-final) standing as a starting point.
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM")],
    matchFounds: [matchFound("Sealed_FRA_20260929", "m1", "9/29/2026 10:05:00 AM")],
    courseStandings: [standing("Sealed_FRA_20260929", "c1", 2, 1, "CreateMatch", "9/29/2026 11:00:00 AM")],
  });
  const pending = findPendingClosures(source);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, "Sealed_FRA_20260929");
  assert.equal(pending[0].lastKnownWins, 2);
  assert.equal(pending[0].lastKnownLosses, 1);
  console.log("OK: findPendingClosures flags an earlier same-format run once a later one has started, carrying its last-known (non-final) standing.");
}

function runDifferentFormatsNotCrossFlagged() {
  // A Draft that's still the only Draft run ever seen, alongside the same
  // Sealed situation as above - the Draft must never be flagged just
  // because a Sealed run started; formats are independent.
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM"), join("QuickDraft_HOB_20260915", "9/15/2026 1:00:00 PM")],
    matchFounds: [matchFound("QuickDraft_HOB_20260915", "m2", "9/15/2026 1:05:00 PM")],
  });
  const pending = findPendingClosures(source);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, "Sealed_FRA_20260929");
  console.log("OK: findPendingClosures never flags a run just because a DIFFERENT format's run started - each format is tracked independently.");
}

function runFinishedNotFlagged() {
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM")],
    courseStandings: [standing("Sealed_FRA_20260929", "c1", 4, 3, "Complete", "9/29/2026 11:00:00 AM")],
  });
  assert.equal(findPendingClosures(source).length, 0);
  console.log("OK: findPendingClosures never flags a run that actually reached Arena's own 'Complete' standing.");
}

function runRewardClaimedNotFlagged() {
  // No "Complete" standing captured at all, but a prize WAS claimed - that
  // alone is enough evidence the run finished.
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM")],
    rewards: [reward("Sealed_FRA_20260929", "c1", "9/29/2026 11:30:00 AM")],
  });
  assert.equal(findPendingClosures(source).length, 0);
  console.log("OK: findPendingClosures treats a claimed prize as finished even with no 'Complete' standing ever captured.");
}

function runAlreadyManuallyClosedNotFlagged() {
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM")],
    manualResults: [manual("Sealed_FRA_20260929", null, 2, 2, "9/30/2026 5:00:00 PM")],
  });
  assert.equal(findPendingClosures(source).length, 0);
  console.log("OK: findPendingClosures doesn't re-flag a run the user already entered a manual score for.");
}

function runOnlyOneRunEverSeenNotFlagged() {
  // Still unfinished, but nothing has superseded it yet - it's presumably
  // just still in progress.
  const source = emptySource({
    joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM")],
    courseStandings: [standing("Sealed_FRA_20260929", "c1", 2, 1, "CreateMatch", "9/29/2026 11:00:00 AM")],
  });
  assert.equal(findPendingClosures(source).length, 0);
  console.log("OK: findPendingClosures leaves the only run of a format alone, however unfinished, until a later one actually starts.");
}

run();
runDifferentFormatsNotCrossFlagged();
runFinishedNotFlagged();
runRewardClaimedNotFlagged();
runAlreadyManuallyClosedNotFlagged();
runOnlyOneRunEverSeenNotFlagged();
