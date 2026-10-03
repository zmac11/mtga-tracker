import assert from "node:assert/strict";
import { compareTs, buildCourseWindows, assignCourseId, DECK_SUBMIT_LEAD_MS } from "./courseRuns.js";

function run() {
  // Real stored shape (found 2026-10-02): match/game-state rows carry the
  // trailing header text logParser.ts used to leave on the timestamp. They
  // must still order by their real time, not by raw string order - where
  // "10/1/..." sorts BEFORE "9/30/...".
  assert.ok(compareTs("10/1/2026 12:21:15 AM: Match", "9/30/2026 10:57:05 AM: Match") > 0);
  assert.ok(compareTs("9/30/2026 10:57:05 AM: Match t", "9/30/2026 10:20:07 AM") > 0, "a noisy ts compares correctly against a clean one");
  assert.ok(compareTs("2026-10-01T10:00:00Z", "9/30/2026 10:57:05 AM: Match") > 0, "and against an ISO ts");
  assert.equal(compareTs("9/30/2026 1:25:09 PM", "9/30/2026 1:25:09 PM: Match"), 0);

  // The user-visible consequence: a match found on 10/1 belongs to the run
  // whose window started 9/30 6:38 PM, not the earlier 9/30 1:46 PM one.
  const windows = buildCourseWindows([
    { courseId: "run-a", ts: "9/30/2026 1:46:06 PM" },
    { courseId: "run-b", ts: "9/30/2026 6:38:01 PM" },
  ]);
  assert.equal(assignCourseId("10/1/2026 12:21:15 AM: Match", windows), "run-b");
  assert.equal(assignCourseId("9/30/2026 2:45:44 PM: Match t", windows), "run-a");

  // A run's first DeckSubmitted lands ~1s BEFORE its first recorded signal (real data: every Sealed
  // run). With no lead it falls into the previous run; with DECK_SUBMIT_LEAD_MS it belongs to the new one.
  const sealed = buildCourseWindows([
    { courseId: "run-1", ts: "10/1/2026 7:19:10 PM" },
    { courseId: "run-2", ts: "10/2/2026 1:05:34 PM" },
  ]);
  assert.equal(assignCourseId("10/2/2026 1:05:33 PM", sealed), "run-1");
  assert.equal(assignCourseId("10/2/2026 1:05:33 PM", sealed, DECK_SUBMIT_LEAD_MS), "run-2");
  // ...but a submission hours before the next run (a late edit of the previous run) stays put.
  assert.equal(assignCourseId("10/1/2026 10:09:02 PM", sealed, DECK_SUBMIT_LEAD_MS), "run-1");

  console.log("OK: compareTs/assignCourseId order timestamps correctly even with the trailing header text older rows carry, including M/D/YYYY dates that string-sort wrongly.");
}

run();
