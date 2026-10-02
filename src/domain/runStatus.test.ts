import assert from "node:assert/strict";
import { computeRunStatuses, runStatusKey, learnEndRules, evaluateEndRule, describeRunStatus } from "./runStatus.js";
import { findPendingClosures } from "./eventClosure.js";
import type { EventHistorySource, EventRunRef } from "./eventHistory.js";
import { parseEventIdentity } from "./eventIdentity.js";
import type { CourseStanding, DraftJoined, EventReward } from "./types.js";

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

function standing(eventId: string, courseId: string, wins: number, losses: number, currentModule: string | null, ts: string): CourseStanding {
  return { kind: "CourseStanding", eventId, courseId, wins, losses, currentModule, deckName: null, ts };
}
function join(eventName: string, ts: string): DraftJoined {
  return { kind: "DraftJoined", eventName, entryCurrencyType: "Gem", entryCurrencyPaid: 2000, ts };
}
function status(source: EventHistorySource, eventId: string) {
  // One ref per eventId with a standing (listEventRuns only discovers runs
  // from decks/matches/completions, which these standing-only fixtures omit).
  const ids = [...new Set(source.courseStandings.map((st) => st.eventId))];
  const refs: EventRunRef[] = ids.map((id) => ({ eventId: id, courseId: null, identity: parseEventIdentity(id) }));
  return computeRunStatuses(source, refs).get(runStatusKey(eventId, null))!;
}

function run() {
  // Sealed: 3 losses ends it even though Arena still says CreateMatch (the
  // standing hasn't refreshed / was missed) - auto-completed from the cap.
  let s = status(emptySource({ courseStandings: [standing("Sealed_FRA_20260929", "c1", 4, 3, "CreateMatch", "9/30/2026 1:00:00 PM")] }), "Sealed_FRA_20260929");
  assert.equal(s.finished, true);
  assert.equal(s.reason, "reached-loss-limit");
  assert.equal(s.ruleSource, "builtin");
  assert.match(describeRunStatus(s), /Completed 4-3 - eliminated at 3 losses/);

  s = status(emptySource({ courseStandings: [standing("Sealed_FRA_20260929", "c1", 7, 1, "CreateMatch", "9/30/2026 1:00:00 PM")] }), "Sealed_FRA_20260929");
  assert.equal(s.reason, "reached-win-limit");
  assert.match(describeRunStatus(s), /reached 7 wins/);

  // 2-2 is mid-event, with the cap still known so callers can show progress.
  s = status(emptySource({ courseStandings: [standing("Sealed_FRA_20260929", "c1", 2, 2, "CreateMatch", "9/30/2026 1:00:00 PM")] }), "Sealed_FRA_20260929");
  assert.equal(s.finished, false);
  assert.equal(s.reason, null);
  assert.equal(describeRunStatus(s), "In progress");
  assert.deepEqual(s.rule, { maxWins: 7, maxLosses: 3 });

  // Arena's own "ClaimPrize" (event over, prize unclaimed) counts as finished
  // for an event type with no known cap - this is the signal that was
  // previously not recognised at all.
  s = status(emptySource({ courseStandings: [standing("PickTwoDraft_FRA_20260929", "p1", 4, 1, "ClaimPrize", "9/30/2026 1:00:00 PM")] }), "PickTwoDraft_FRA_20260929");
  assert.equal(s.finished, true);
  assert.equal(s.reason, "arena-claim-prize");

  // A claimed prize and a manual score each finish a run regardless of record.
  const claimed: EventReward = { kind: "EventReward", eventId: "Sealed_FRA_20260929", courseId: "c1", gems: 1, gold: 0, boosters: [], grantedCardCount: 0, ts: "9/30/2026 2:00:00 PM" };
  s = status(emptySource({ courseStandings: [standing("Sealed_FRA_20260929", "c1", 1, 0, "CreateMatch", "9/30/2026 1:00:00 PM")], rewards: [claimed] }), "Sealed_FRA_20260929");
  assert.equal(s.reason, "prize-claimed");
  s = status(
    emptySource({
      courseStandings: [standing("Sealed_FRA_20260929", "c1", 1, 0, "CreateMatch", "9/30/2026 1:00:00 PM")],
      manualResults: [{ kind: "ManualCourseResult", eventId: "Sealed_FRA_20260929", courseId: "c1", wins: 5, losses: 3, ts: "10/1/2026 9:00:00 AM" }],
    }),
    "Sealed_FRA_20260929",
  );
  assert.equal(s.finished, true);
  assert.equal(s.wins, 5);

  // Learned caps: two finished runs of an unknown subtype both ending on
  // exactly 2 losses (wins varying) teach a 2-loss cap, which then finishes
  // a third, still-"CreateMatch" run at 1-2 but not one at 3-1.
  const learned = learnEndRules([
    { subtype: "FooDraft", format: "Draft", wins: 3, losses: 2 },
    { subtype: "FooDraft", format: "Draft", wins: 1, losses: 2 },
  ]);
  assert.deepEqual(learned.get("FooDraft"), { maxWins: null, maxLosses: 2 });
  const learnedSource = emptySource({
    courseStandings: [
      standing("FooDraft_ABC_20260901", "f1", 3, 2, "ClaimPrize", "9/1/2026 1:00:00 PM"),
      standing("FooDraft_ABC_20260908", "f2", 1, 2, "ClaimPrize", "9/8/2026 1:00:00 PM"),
      standing("FooDraft_ABC_20260915", "f3", 1, 2, "CreateMatch", "9/15/2026 1:00:00 PM"),
      standing("FooDraft_ABC_20260922", "f4", 3, 1, "CreateMatch", "9/22/2026 1:00:00 PM"),
    ],
  });
  assert.equal(status(learnedSource, "FooDraft_ABC_20260915").reason, "reached-loss-limit");
  assert.equal(status(learnedSource, "FooDraft_ABC_20260915").ruleSource, "learned");
  assert.equal(status(learnedSource, "FooDraft_ABC_20260922").finished, false);

  // Never learn from one sample, from a built-in subtype, or from open-ended
  // modes that "complete" after every match (Ladder/Play would look like a cap of 1).
  assert.equal(learnEndRules([{ subtype: "FooDraft", format: "Draft", wins: 3, losses: 2 }]).size, 0);
  assert.equal(learnEndRules([{ subtype: "Sealed", format: "Sealed", wins: 4, losses: 3 }, { subtype: "Sealed", format: "Sealed", wins: 4, losses: 3 }]).size, 0);
  assert.equal(
    learnEndRules([
      { subtype: "Ladder", format: "Constructed", wins: 1, losses: 0 },
      { subtype: "Ladder", format: "Constructed", wins: 1, losses: 0 },
    ]).size,
    0,
  );
  assert.equal(evaluateEndRule(0, 0, null), null);

  // eventClosure shares the definition: an earlier Sealed run that visibly
  // ended (3 losses) is never flagged for a manual score when a new run starts...
  const withLaterRun = (firstStanding: CourseStanding) =>
    emptySource({
      joins: [join("Sealed_FRA_20260929", "9/29/2026 10:00:00 AM"), join("Sealed_FRA_20261006", "10/6/2026 9:00:00 AM")],
      courseStandings: [firstStanding],
    });
  assert.equal(findPendingClosures(withLaterRun(standing("Sealed_FRA_20260929", "c1", 4, 3, "CreateMatch", "9/29/2026 11:00:00 AM"))).length, 0);
  // ...but one genuinely mid-event still is.
  assert.equal(findPendingClosures(withLaterRun(standing("Sealed_FRA_20260929", "c1", 2, 2, "CreateMatch", "9/29/2026 11:00:00 AM"))).length, 1);
  // ...and so is Arena's own ClaimPrize, now recognised as finished.
  assert.equal(findPendingClosures(withLaterRun(standing("Sealed_FRA_20260929", "c1", 2, 1, "ClaimPrize", "9/29/2026 11:00:00 AM"))).length, 0);

  console.log("OK: runStatus finishes a run from a claimed prize, Arena's Complete/ClaimPrize, a manual score, or a reached win/loss cap (built-in Sealed/Quick/Premier, plus caps learned from this player's own finished runs - never from one sample, built-ins, or open-ended modes), and eventClosure shares that definition.");
}

run();
