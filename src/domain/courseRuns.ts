/**
 * Milestone 19 (2026-09-30): resolves Arena's own eventId-reuse problem -
 * confirmed real in this user's own data, Arena minted a brand new course
 * ("courseId": "5ddf743e-...", fresh 0-0 CreateMatch) under the EXACT SAME
 * eventId ("Sealed_FRA_20260929") an earlier, already-completed course
 * ("courseId": "cd163542-...", finished 4-3/ClaimPrize) had used. Every
 * lookup keyed by eventId alone (LiveStateTracker.courseStandings,
 * eventHistory.ts's listEventRuns/buildEventRunHistory) silently blended
 * the two together - the newer course's data overwrote or diluted the
 * older one's, rather than either being shown correctly on its own.
 *
 * The real fix needs a courseId, but most of the events that make up a
 * "run" don't carry one at all - see types.ts's comment on MatchFound's
 * per-player courseId (confirmed NOT the same id space, unusable) and
 * DeckSubmitted (no courseId field whatsoever). Only CourseStanding,
 * DraftCompleted, EventCardPool, and EventReward carry a real courseId.
 * So instead of a direct field, this attributes everything else (a match,
 * a deck submission, a join) to a courseId by TIME: build one time window
 * per distinct courseId seen for an eventId (from the four kinds that do
 * carry one), each window starting at the earliest ts that courseId was
 * ever seen at, and assign anything else to whichever window's start it
 * falls at or after - "the most recent course that had already started by
 * this point in time." This is sound because a new course reusing an old
 * eventId can only ever start AFTER the previous one's own activity, never
 * interleaved with it (confirmed by the real data: the new course's
 * earliest CourseStanding ts is well after the old one's ClaimPrize).
 *
 * The common case - one courseId ever seen for a given eventId, which is
 * every event this project has captured except the one collision above -
 * yields exactly one window, and assignCourseId always returns that single
 * courseId for anything at or after it. Callers use `windows.length <= 1`
 * as their signal for "nothing to disambiguate, keep today's behavior
 * exactly as it was" - see eventHistory.ts and liveState.ts.
 */

export interface CourseWindow {
  courseId: string;
  /** Earliest ts this courseId was observed at, across every signal that carries it (see this file's header comment for which kinds those are). */
  startTs: string;
}

/**
 * Found 2026-09-30 while validating this file against the real capture:
 * every ts field in this project is NOT reliably lexicographically
 * sortable, despite several existing comments elsewhere (eventHistory.ts,
 * liveState.ts, deckVersions.ts) saying it is. logParser.ts's
 * TIMESTAMP_RE lifts the timestamp straight out of Arena's own Player.log
 * header text verbatim (e.g. "9/30/2026 2:45:02 PM" - confirmed real,
 * un-zero-padded M/D/YYYY h:mm:ss AM/PM) and pipeline.ts only falls back
 * to a real ISO string (`receivedAt.toISOString()`) when that regex finds
 * nothing - so most rows are this Arena-native format, not ISO, and
 * `"9/9/2026...".localeCompare("9/10/2026...")` is wrong (single-digit
 * "9" sorts after "1"). This is a pre-existing, wider bug (every other
 * `.localeCompare()` ts-sort already in this codebase shares it) - out of
 * scope to fix everywhere tonight, but THIS file's whole job is deciding
 * which of two real courses is more recent, so it can't tolerate it:
 * `Date.parse` handles both formats correctly (verified: both
 * "9/30/2026 1:25:09 PM" and an ISO string parse to the right, comparable
 * epoch ms), so windows/assignment compare by that instead of raw string
 * order, with a same-string fallback only if parsing ever produces NaN
 * (should not happen for a real captured ts, but never silently
 * mis-order on a fluke bad string either).
 */
function tsMillis(ts: string): number {
  const direct = Date.parse(ts);
  if (!Number.isNaN(direct)) return direct;
  // Rows captured before logParser.ts's TIMESTAMP_RE was tightened
  // (2026-10-02) carry trailing header text after the real timestamp -
  // e.g. "9/30/2026 10:57:05 AM: Match" for every match/game-state row -
  // which Date.parse rejects. Event-sourced storage never rewrites old
  // rows, so recover the leading timestamp here instead of letting those
  // rows fall back to (wrong) string ordering.
  const leading = ts.match(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2}(?: ?[AP]M)?/);
  return leading ? Date.parse(leading[0]) : Number.NaN;
}

export function compareTs(a: string, b: string): number {
  const ma = tsMillis(a);
  const mb = tsMillis(b);
  if (!Number.isNaN(ma) && !Number.isNaN(mb)) return ma - mb;
  return a.localeCompare(b);
}

/**
 * Builds ordered time windows for each distinct courseId in `signals`,
 * sorted ascending by startTs (see compareTs above for how "ascending"
 * is decided). Dedupes to the earliest ts per courseId - a courseId can
 * appear more than once (e.g. more than one CourseStanding for the same
 * run) and only the first real sighting matters for deciding when that
 * course's window begins.
 */
export function buildCourseWindows(signals: Array<{ courseId: string; ts: string }>): CourseWindow[] {
  const earliestByCourseId = new Map<string, string>();
  for (const s of signals) {
    const existing = earliestByCourseId.get(s.courseId);
    if (existing === undefined || compareTs(s.ts, existing) < 0) earliestByCourseId.set(s.courseId, s.ts);
  }
  return [...earliestByCourseId.entries()].map(([courseId, startTs]) => ({ courseId, startTs })).sort((a, b) => compareTs(a.startTs, b.startTs));
}

/**
 * Attributes a timestamp to whichever courseId window it falls in: the
 * LAST window (windows is sorted ascending) whose startTs is <= ts, i.e.
 * "whichever course had most recently started by this point." Returns
 * null only if `windows` is empty (no courseId signal at all for this
 * eventId - callers should treat that as "can't disambiguate, don't
 * split") or `ts` is somehow before every window's start (not expected in
 * practice - a match/deck submission always follows the run it belongs to
 * actually starting - but this returns null rather than guessing wrong).
 */
export function assignCourseId(ts: string, windows: CourseWindow[]): string | null {
  let result: string | null = null;
  for (const w of windows) {
    if (compareTs(w.startTs, ts) <= 0) result = w.courseId;
    else break;
  }
  return result;
}
