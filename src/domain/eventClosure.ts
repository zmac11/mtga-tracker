import type { EventHistorySource, EventRunRef } from "./eventHistory.js";
import { listEventRuns, courseWindowsForEvent } from "./eventHistory.js";
import { assignCourseId, compareTs } from "./courseRuns.js";
import { parseEventIdentity, type EventFormat, type EventIdentity } from "./eventIdentity.js";
import { computeRunStatuses, runStatusKey } from "./runStatus.js";

/**
 * Milestone 25: "the tracker missed an event's end - when I start a new
 * one, close out the previous one and let me type in the correct score."
 * A run can be left looking permanently unfinished for two different
 * reasons: Arena's own "Complete" CourseStanding (or prize claim) was
 * itself missed by the tracker (see catchUp.ts - though that only
 * recovers matches, not these event-level signals, since they carry no
 * matchId), or the run was genuinely never resolved in Arena at all
 * (conceded, abandoned mid-event). Either way there's no further log
 * event to wait for, so the only fix is letting the user type in the
 * correct final score by hand.
 *
 * Scoped by format (Draft/Sealed/Constructed/Other - see eventIdentity.ts)
 * deliberately, NOT globally: the user can have one run of each format
 * genuinely in progress at the same time (a Draft they're mid-match on
 * alongside a Sealed pool they haven't touched yet), so starting a new
 * Sealed run must never flag an unrelated still-open Draft. Within one
 * format, a run only ever counts as "superseded" once a LATER run of
 * that same format has actually started - the most-recently-started run
 * in each format bucket is always left alone (it's presumably the one
 * currently being played), however unfinished it looks.
 */
export interface PendingClosure {
  eventId: string;
  courseId: string | null;
  identity: EventIdentity;
  format: EventFormat;
  /** Whatever Arena's own CourseStanding last reported for this run, if any was ever captured - 0/0 if none was. A reasonable starting point for the manual input form, not a claim that it's accurate (if it were, this run wouldn't be pending). */
  lastKnownWins: number;
  lastKnownLosses: number;
  /** Earliest activity ts found for this run - when it started, for display ("your Sealed run from Sep 29"). */
  startedAt: string;
}

interface RunSignals {
  isFinished: boolean;
  lastKnownWins: number;
  lastKnownLosses: number;
  startedAt: string | null;
}

function minTs(values: string[]): string | null {
  return values.length === 0 ? null : values.reduce((min, ts) => (compareTs(ts, min) < 0 ? ts : min));
}

function resolveRunSignals(ref: EventRunRef, source: EventHistorySource, isFinished: boolean): RunSignals {
  const { eventId, courseId } = ref;
  const windows = courseWindowsForEvent(eventId, source);
  const disambiguating = windows.length > 1;
  const matchesCourseId = <T extends { courseId: string }>(item: T): boolean => !disambiguating || item.courseId === courseId;
  const matchesCourseWindow = (ts: string): boolean => !disambiguating || assignCourseId(ts, windows) === courseId;

  const joinsForRun = source.joins.filter((j) => j.eventName === eventId && matchesCourseWindow(j.ts));
  const decksForRun = source.decks.filter((d) => d.eventName === eventId && matchesCourseWindow(d.ts));
  const matchesForRun = source.matchFounds.filter((m) => m.eventId === eventId && matchesCourseWindow(m.ts));
  const standingsForRun = source.courseStandings.filter((s) => s.eventId === eventId && matchesCourseId(s));
  const rewardsForRun = source.rewards.filter((r) => r.eventId === eventId && matchesCourseId(r));
  const completionsForRun = source.completions.filter((c) => c.eventName === eventId && matchesCourseId(c));

  const latestStanding = standingsForRun.length > 0 ? [...standingsForRun].sort((a, b) => compareTs(a.ts, b.ts)).at(-1)! : null;

  const startedAt = minTs([
    ...joinsForRun.map((j) => j.ts),
    ...decksForRun.map((d) => d.ts),
    ...matchesForRun.map((m) => m.ts),
    ...standingsForRun.map((s) => s.ts),
    ...rewardsForRun.map((r) => r.ts),
    ...completionsForRun.map((c) => c.ts),
  ]);

  return { isFinished, lastKnownWins: latestStanding?.wins ?? 0, lastKnownLosses: latestStanding?.losses ?? 0, startedAt };
}

/**
 * Every run that's unfinished AND has since been superseded by a later
 * run of the same format - the set that needs a manual score. Call this
 * both at app startup (to surface anything already stale from before)
 * and whenever a live DraftJoined event arrives (to catch one the moment
 * it becomes superseded) - see electron/main.ts.
 */
/**
 * listEventRuns only ever learns about a run from a draft completion, a
 * deck submission, or a match - a run that's JUST been joined (the exact
 * moment this module cares about most: "I started a new one") has none of
 * those yet, so it'd otherwise be invisible here until its first match.
 * Adds one `{courseId: null}` ref per eventId seen in a join that
 * listEventRuns didn't already surface.
 */
function listEventRunsIncludingBareJoins(source: EventHistorySource): EventRunRef[] {
  const refs = listEventRuns(source);
  const known = new Set(refs.map((r) => r.eventId));
  for (const j of source.joins) {
    if (known.has(j.eventName)) continue;
    known.add(j.eventName);
    refs.push({ eventId: j.eventName, courseId: null, identity: parseEventIdentity(j.eventName) });
  }
  return refs;
}

export function findPendingClosures(source: EventHistorySource): PendingClosure[] {
  const refs = listEventRunsIncludingBareJoins(source);
  // "Finished" is decided by runStatus.ts (prize claimed, Arena's "Complete"
  // or "ClaimPrize" standing, a manual score, or the run having reached its
  // event type's win/loss cap) - the single definition shared with the Past
  // Events page, so a run that visibly ended is never flagged as unfinished.
  const statuses = computeRunStatuses(source, refs);

  const withSignals = refs
    .map((ref) => ({ ref, signals: resolveRunSignals(ref, source, statuses.get(runStatusKey(ref.eventId, ref.courseId))?.finished ?? false) }))
    .filter((r) => r.signals.startedAt !== null);

  const byFormat = new Map<EventFormat, typeof withSignals>();
  for (const row of withSignals) {
    const list = byFormat.get(row.ref.identity.format) ?? [];
    list.push(row);
    byFormat.set(row.ref.identity.format, list);
  }

  const pending: PendingClosure[] = [];
  for (const list of byFormat.values()) {
    if (list.length < 2) continue; // only one run ever seen for this format - nothing has superseded it yet, however unfinished it looks
    const sorted = [...list].sort((a, b) => compareTs(a.signals.startedAt!, b.signals.startedAt!));
    const superseded = sorted.slice(0, -1); // every run except the most-recently-STARTED one
    for (const { ref, signals } of superseded) {
      if (signals.isFinished) continue;
      pending.push({
        eventId: ref.eventId,
        courseId: ref.courseId,
        identity: ref.identity,
        format: ref.identity.format,
        lastKnownWins: signals.lastKnownWins,
        lastKnownLosses: signals.lastKnownLosses,
        startedAt: signals.startedAt!,
      });
    }
  }
  return pending;
}
