import type {
  CourseStanding,
  DeckSubmitted,
  DomainEvent,
  DraftCompleted,
  DraftPackSeen,
  DraftPickMade,
  GameStateSnapshot,
  MatchCompleted,
  MatchFound,
} from "./types.js";
import { computeMatchOutcomes, reconcileWinRate, rollupByEvent, winRate, type GameOutcome, type WinRate } from "./rollups.js";
import { buildCourseWindows, assignCourseId, compareTs, type CourseWindow } from "./courseRuns.js";

function dedupeLatestByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

export interface OverlayPlayer {
  name: string;
  seat: number;
  life: number | null;
  isMe: boolean;
}

export interface OverlayMatch {
  matchId: string;
  eventId: string | null;
  me: OverlayPlayer | null;
  opponent: OverlayPlayer | null;
  activeSeat: number | null;
  stage: string | null;
  outcome: "WIN" | "LOSS" | null; // null while the match is still in progress
  reason: string | null;
  /**
   * Milestone 18 (Bo3 readiness): which game of the match is currently
   * being played, straight from the latest GameStateSnapshot for this
   * match (gameNumber - already captured since that event type was added,
   * just not surfaced to the overlay until now). Null before any
   * GameStateSnapshot has arrived. Always 1 for a Bo1 match (every match
   * captured so far - see MatchOutcome.games' doc comment in rollups.ts);
   * expected to go 1 -> 2 -> (3) for a real Bo3, not yet observed live.
   */
  currentGameNumber: number | null;
  /** Milestone 18 (widened milestone 23 for Bo3's own per-game sequence): the completed match's own per-game score - see MatchOutcome.games in rollups.ts. Null until the match (and its MatchCompleted) is captured. */
  games: { wins: number; losses: number; sequence: GameOutcome[] } | null;
}

/**
 * Milestone 7 phase 5: bare-bones live draft state - grpIds only, no
 * name/color/image resolution (that needs CardStore, which this Electron-
 * free/DB-free layer deliberately doesn't have - see draftProgressLoader.ts
 * for where that join happens, same pattern as deckViewerLoader.ts).
 */
export interface DraftProgress {
  /** See DraftPackSeen.draftId's comment in types.ts for what this is per draft type. */
  draftId: string;
  /** 1-indexed, matching Arena's own UI (see classifier.ts). */
  pack: number;
  pick: number;
  /** The pack currently being offered (grpIds) - whatever the most recent DraftPackSeen for this draft said. */
  packCards: number[];
  /** Every pick made so far this draft, in (pack, pick) order, deduped to the latest per (pack, pick) - same convention as eventHistory.ts. `grpIds` is almost always one card, but see types.ts's comment on DraftPickMade.grpIds for "Pick Two" draft. */
  picks: Array<{ pack: number; pick: number; grpIds: number[] }>;
  /**
   * Milestone 23: every DraftPackSeen for this draft, one entry per
   * distinct (pack, pick) seen so far, in pack/pick order - the "last-seen
   * state" of each booster, deduped the same way `picks` already is
   * (latest DraftPackSeen wins for a given (pack, pick), so a wheeled-back
   * pack shows however many cards were left in it the LAST time it came
   * back around, not its original size). This is the full history
   * LiveStateTracker was already accumulating internally (draftPacksSeen)
   * but previously discarded down to just the latest pack before
   * returning - see this method's own packsForDraft/latestPack below. Used
   * to show every pack seen so far during a draft, not just the current
   * one (feature request: "clearly see other packs ... state in which I
   * saw them last time").
   */
  packsSeen: Array<{ pack: number; pick: number; packCards: number[] }>;
}

export interface OverlaySnapshot {
  myScreenName: string | null;
  /** The most recent match we've seen, whether or not it's finished. Null before any match is found. */
  match: OverlayMatch | null;
  /** Win/loss record for the current match's event (or the most recent event, if no match is active yet). */
  eventRecord:
    | (WinRate & {
        eventId: string;
        /**
         * Milestone 19: which course this record was scoped to, when the
         * eventId turned out to have more than one distinct course under
         * it (see courseRuns.ts) - null in the overwhelmingly common case
         * (a single course, or none disambiguated yet). electron/main.ts's
         * "view this event's deck" click passes this straight through to
         * writeDeckViewerPage/buildDeckViewerData so it opens the SAME
         * course this record describes, not just whichever the eventId
         * name happens to match.
         */
        courseId: string | null;
        deckName: string | null;
      })
    | null;
  /** Null when no draft is currently in progress (none seen yet, or the last one seen has already completed). */
  currentDraft: DraftProgress | null;
}

/**
 * Incremental counterpart to what report.ts computes in one shot from
 * tracker.db - fed DomainEvents live as the classifier produces them (see
 * pipeline.ts / electron/main.ts's use of it) instead of read back from
 * storage after the fact. Deliberately Electron-free/plain so it's
 * unit-testable the same way as classifier.ts, with no window/IPC code
 * mixed in - electron/main.ts just calls .record() and .snapshot() and pipes
 * the result to the renderer.
 *
 * Known simplification: a stray game-state snapshot tagged with a stale
 * matchId (the classifier carries the last-known matchId forward across
 * some GRE diffs that omit it - see classifier.ts) could in principle nudge
 * `currentMatchId` back to a just-finished match right as a new one starts.
 * Not seen in practice yet; flagging it here rather than pretending it
 * can't happen.
 */
export class LiveStateTracker {
  private myScreenName: string | null = null;
  private matchFounds: MatchFound[] = [];
  private matchCompletions: MatchCompleted[] = [];
  private deckSubmissions: DeckSubmitted[] = [];
  private latestGameStateByMatch = new Map<string, GameStateSnapshot>();
  private currentMatchId: string | null = null;
  /**
   * Arena's own authoritative win/loss record per event (see CourseStanding
   * in types.ts). Preferred over the locally-computed rollup in snapshot()
   * below, since it doesn't depend on us having personally captured every
   * match (found 2026-09-24: the log-rotation bug cost us a whole match's
   * worth of capture, and the overlay kept showing a stale local count even
   * after the fix, because it had no way to know it was behind Arena's own
   * bookkeeping).
   *
   * Milestone 19: kept as the FULL history now (every CourseStanding ever
   * seen, in arrival order), not a last-write-wins Map keyed by eventId -
   * found (from a real "Sealed Deck 0-0" report) that a plain per-eventId
   * Map lets a brand new course silently overwrite an older, completed
   * one's standing whenever Arena reuses an eventId across two genuinely
   * separate courses (see courseRuns.ts). snapshot() below now resolves
   * the CURRENT course first (via courseRuns.ts's window logic) and only
   * then looks up that specific course's own latest standing.
   */
  private courseStandingHistory: CourseStanding[] = [];
  /**
   * Milestone 7 phase 5 - live draft progress. Kept as plain unbounded
   * arrays across every draft ever seen this run, same convention as
   * matchFounds/matchCompletions/deckSubmissions above (fine at this data
   * volume - see sqliteStore.ts's own comment on the same tradeoff).
   * `lastActiveDraftId` is whichever draft most recently had pack/pick
   * activity; `completedDraftIds` marks ones that have finished, so
   * snapshot() below can tell "a draft happened and ended" apart from "a
   * draft is happening right now".
   */
  private draftPacksSeen: DraftPackSeen[] = [];
  private draftPicksMade: DraftPickMade[] = [];
  private completedDraftIds = new Set<string>();
  private lastActiveDraftId: string | null = null;
  /**
   * Milestone 19: full DraftCompleted history (not just completedDraftIds
   * above) - DraftCompleted carries a real courseId+ts, so it's one of the
   * signals courseRuns.ts's window-building uses to detect/resolve an
   * eventId Arena reused across more than one course. A draft-format event
   * getting the same disambiguation CourseStanding already gave Sealed is
   * the point of tracking this alongside completedDraftIds, not instead of
   * it (completedDraftIds still answers a different question - "has this
   * SPECIFIC draft session finished" - snapshot() needs both).
   */
  private draftCompletions: DraftCompleted[] = [];

  record(event: DomainEvent): void {
    switch (event.kind) {
      case "PlayerIdentified":
        this.myScreenName = event.screenName;
        break;
      case "MatchFound":
        this.matchFounds.push(event);
        this.currentMatchId = event.matchId;
        break;
      case "MatchCompleted":
        this.matchCompletions.push(event);
        break;
      case "DeckSubmitted":
        this.deckSubmissions.push(event);
        break;
      case "GameStateSnapshot":
        if (event.matchId) {
          // Real live play (2026-09-30, first real Sealed match): the overlay's
          // HP/turn display went blank mid-match. Root cause - this used to be
          // a blind `.set(matchId, event)`, replacing the whole cached
          // snapshot on every single GameStateSnapshot, even ones that are a
          // GRE UI-only/partial diff carrying no player data at all (confirmed
          // real: plenty of captured snapshots have `players: []` because
          // they only touched stage/turn, not life totals). A later
          // players-empty diff would wipe out the last *good* life totals the
          // overlay had just shown, blanking HP until the next diff happened
          // to include player data again. Fixed by merging into whatever was
          // last known for this match, keeping each field's last non-empty
          // value instead of trusting every diff to be a full snapshot - the
          // same "don't discard real data for a partial update" principle
          // already applied elsewhere in this project (CourseStanding
          // history, DeckSubmitted's real-sideboard precedence, etc.).
          const previous = this.latestGameStateByMatch.get(event.matchId);
          const merged: GameStateSnapshot = previous
            ? {
                ...event,
                players: event.players.length > 0 ? event.players : previous.players,
                stage: event.stage ?? previous.stage,
                turnActivePlayer: event.turnActivePlayer ?? previous.turnActivePlayer,
                turnDecisionPlayer: event.turnDecisionPlayer ?? previous.turnDecisionPlayer,
                gameNumber: event.gameNumber ?? previous.gameNumber,
              }
            : event;
          this.latestGameStateByMatch.set(event.matchId, merged);
          this.currentMatchId = event.matchId;
        }
        break;
      case "CourseStanding":
        // Milestone 19: append, don't overwrite - see courseStandingHistory's
        // doc comment above for why a last-write-wins Map was wrong.
        this.courseStandingHistory.push(event);
        break;
      case "DraftPackSeen":
        this.draftPacksSeen.push(event);
        this.lastActiveDraftId = event.draftId;
        break;
      case "DraftPickMade":
        this.draftPicksMade.push(event);
        this.lastActiveDraftId = event.draftId;
        break;
      case "DraftCompleted":
        // draftId is only ever null if a DraftCompleteDraft response arrives
        // with no pack/pick activity captured earlier in this same process
        // (see classifier.ts's comment on currentDraftId) - an edge case
        // that just means there was nothing live to mark as finished anyway.
        if (event.draftId) this.completedDraftIds.add(event.draftId);
        this.draftCompletions.push(event);
        break;
      // DraftJoined isn't needed for anything shown yet - the join itself
      // carries no pack/pick/progress info, just entry-fee bookkeeping.
      default:
        break;
    }
  }

  /**
   * Rebuilds win-rate/event-record history from events persisted in a
   * *previous* run (see CapturePipeline.historyForSeeding()) - deliberately
   * separate from record(), and deliberately skips MatchFound's
   * currentMatchId/GameStateSnapshot's currentMatchId side effects, so a
   * fresh overlay launch doesn't show a stale match HUD for a match that
   * isn't happening anymore.
   *
   * Exists because without this, every overlay relaunch started every
   * event's record from a blank slate (both the local rollup AND the
   * CourseStanding backstop added in milestone 6 - the standing history is
   * only ever populated by *live* events too), so a correct record already
   * known from earlier in the session would silently regress to whatever
   * the next live event happened to say - observed 2026-09-24 as "the
   * record only corrects itself after finishing another match, not right
   * away" after a relaunch: the previously-seen correct CourseStanding was
   * sitting in tracker.db the whole time, just never read back in.
   *
   * Milestone 19: also replays PlayerIdentified (see historyForSeeding's
   * own comment in pipeline.ts for why - myScreenName being null after a
   * relaunch was independently found to blank out every local win/loss
   * rollup, not just whichever event this method was originally about).
   */
  seedHistory(events: DomainEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "PlayerIdentified":
          this.myScreenName = event.screenName;
          break;
        case "MatchFound":
          this.matchFounds.push(event);
          break;
        case "MatchCompleted":
          this.matchCompletions.push(event);
          break;
        case "DeckSubmitted":
          this.deckSubmissions.push(event);
          break;
        case "CourseStanding":
          this.courseStandingHistory.push(event);
          break;
        case "DraftPackSeen":
          this.draftPacksSeen.push(event);
          break;
        case "DraftPickMade":
          this.draftPicksMade.push(event);
          break;
        case "DraftCompleted":
          if (event.draftId) this.completedDraftIds.add(event.draftId);
          this.draftCompletions.push(event);
          break;
        default:
          break;
      }
    }
    // Unlike currentMatchId above (deliberately NOT set from seeded history,
    // so a relaunch doesn't show a long-finished match's HUD as if it were
    // live right now), resuming a genuinely still-in-progress draft on
    // relaunch IS the correct behavior here, not "faking" anything - if the
    // last draft we have any record of hasn't completed, it may well still
    // be running. historyForSeeding() hands back each event kind as its own
    // array (not merged chronologically - see its own comment), so finding
    // "whichever draft most recently had activity" needs an actual sort by
    // real timestamp across both pack and pick events, not just the last
    // element of one array.
    const activity: Array<DraftPackSeen | DraftPickMade> = [...this.draftPacksSeen, ...this.draftPicksMade].sort((a, b) =>
      compareTs(a.ts, b.ts),
    );
    const lastActivity = activity.at(-1);
    if (lastActivity) this.lastActiveDraftId = lastActivity.draftId;
  }

  /**
   * Milestone 19: builds this eventId's course windows from whatever we've
   * accumulated so far (CourseStanding + DraftCompleted - the two courseId-
   * bearing signals this live tracker keeps; see courseRuns.ts for why
   * those two and not others). Returns an empty array for the ordinary
   * one-course-or-none case just as readily as for a genuine collision -
   * callers check `windows.length > 1`, not this array's mere presence.
   */
  private courseWindowsFor(eventId: string): CourseWindow[] {
    const signals: Array<{ courseId: string; ts: string }> = [
      ...this.courseStandingHistory.filter((s) => s.eventId === eventId).map((s) => ({ courseId: s.courseId, ts: s.ts })),
      ...this.draftCompletions.filter((c) => c.eventName === eventId).map((c) => ({ courseId: c.courseId, ts: c.ts })),
    ];
    return buildCourseWindows(signals);
  }

  snapshot(): OverlaySnapshot {
    const outcomes = computeMatchOutcomes(this.matchFounds, this.matchCompletions, this.myScreenName);

    let match: OverlayMatch | null = null;
    if (this.currentMatchId) {
      const found = this.matchFounds.find((m) => m.matchId === this.currentMatchId) ?? null;
      if (found) {
        const outcome = outcomes.find((o) => o.matchId === this.currentMatchId) ?? null;
        const gameState = this.latestGameStateByMatch.get(this.currentMatchId) ?? null;

        const toPlayer = (p: MatchFound["players"][number]): OverlayPlayer => {
          const gs = gameState?.players.find((gp) => gp.systemSeatNumber === p.systemSeatId);
          return {
            name: p.playerName,
            seat: p.systemSeatId,
            life: gs?.lifeTotal ?? null,
            isMe: p.playerName === this.myScreenName,
          };
        };

        const me = found.players.find((p) => p.playerName === this.myScreenName);
        const opponent = found.players.find((p) => p.playerName !== this.myScreenName);

        match = {
          matchId: found.matchId,
          eventId: found.eventId,
          me: me ? toPlayer(me) : null,
          opponent: opponent ? toPlayer(opponent) : null,
          activeSeat: gameState?.turnActivePlayer ?? null,
          stage: gameState?.stage ?? null,
          outcome: outcome?.outcome ?? null,
          reason: outcome?.reason ?? null,
          currentGameNumber: gameState?.gameNumber ?? null,
          games: outcome?.games ?? null,
        };
      }
    }

    let eventRecord: OverlaySnapshot["eventRecord"] = null;
    const eventId = match?.eventId ?? outcomes.at(-1)?.eventId ?? null;
    if (eventId) {
      // Milestone 19: resolve which course is CURRENT for this eventId
      // before computing anything else - see courseRuns.ts and this
      // class's courseStandingHistory doc comment. `windows` is empty (not
      // just length <= 1) for the ordinary case, so `disambiguating` below
      // is false and every filter is a no-op, exactly today's behavior.
      const windows = this.courseWindowsFor(eventId);
      const disambiguating = windows.length > 1;
      const currentCourseId = windows.length > 0 ? windows[windows.length - 1].courseId : null;

      const forEvent = rollupByEvent(outcomes).get(eventId) ?? [];
      const scopedToCourse = disambiguating ? forEvent.filter((o) => assignCourseId(o.ts, windows) === currentCourseId) : forEvent;
      const localRate = winRate(scopedToCourse);

      const standingsForEvent = this.courseStandingHistory.filter((s) => s.eventId === eventId && (!disambiguating || s.courseId === currentCourseId));
      const standing = standingsForEvent.length > 0 ? standingsForEvent[standingsForEvent.length - 1] : undefined;

      // Take the max of what we personally observed and what Arena's own
      // EventGetCoursesV2 last reported, per side. Neither source alone is
      // always current: our own count can undercount if capture ever missed
      // matches (the reason this exists at all - see CourseStanding's
      // comment), while Arena's snapshot can be a beat behind ours right
      // after a match we just finished but haven't backed out of yet (Arena
      // seems to refresh this mainly when returning to the home/deck
      // screen, not the instant a match ends). Taking the max of each side
      // means the displayed record only ever moves forward, from whichever
      // source currently knows more.
      const reconciled = reconcileWinRate(localRate, standing);
      const deck =
        [...this.deckSubmissions].reverse().find((d) => d.eventName === eventId && (!disambiguating || assignCourseId(d.ts, windows) === currentCourseId)) ?? null;
      eventRecord = {
        ...reconciled,
        eventId,
        courseId: disambiguating ? currentCourseId : null,
        deckName: deck?.deckName ?? standing?.deckName ?? null,
      };
    }

    let currentDraft: DraftProgress | null = null;
    if (this.lastActiveDraftId && !this.completedDraftIds.has(this.lastActiveDraftId)) {
      const draftId = this.lastActiveDraftId;
      // "Current pack" is whichever DraftPackSeen for this draft arrived
      // most recently (arrival order, not (pack,pick)-sorted - it's
      // genuinely the last one the client showed us, including a wheeled-
      // back pack with fewer cards than when we first saw it at this same
      // pick). Packs/picks arriving together (Bot Draft - see classifier.ts)
      // or a beat apart (human draft) both work fine here since we only
      // ever look at the most recent of each independently.
      const packsForDraft = this.draftPacksSeen.filter((p) => p.draftId === draftId);
      const latestPack = packsForDraft.at(-1) ?? null;

      const picksForDraft = this.draftPicksMade.filter((p) => p.draftId === draftId);
      const picks = dedupeLatestByKey(picksForDraft, (p) => `${p.pack}|${p.pick}`)
        .sort((a, b) => a.pack - b.pack || a.pick - b.pick)
        .map((p) => ({ pack: p.pack, pick: p.pick, grpIds: p.grpIds }));

      // Milestone 23: the full pack-seen history, not just latestPack - see
      // DraftProgress.packsSeen's doc comment above.
      const packsSeen = dedupeLatestByKey(packsForDraft, (p) => `${p.pack}|${p.pick}`)
        .sort((a, b) => a.pack - b.pack || a.pick - b.pick)
        .map((p) => ({ pack: p.pack, pick: p.pick, packCards: p.packCards }));

      if (latestPack) {
        currentDraft = { draftId, pack: latestPack.pack, pick: latestPack.pick, packCards: latestPack.packCards, picks, packsSeen };
      }
    }

    return { myScreenName: this.myScreenName, match, eventRecord, currentDraft };
  }
}
