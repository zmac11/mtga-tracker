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
import { computeMatchOutcomes, reconcileWinRate, rollupByEvent, winRate, type WinRate } from "./rollups.js";

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
  /** Milestone 18: the completed match's own per-game score - see MatchOutcome.games in rollups.ts. Null until the match (and its MatchCompleted) is captured. */
  games: { wins: number; losses: number } | null;
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
}

export interface OverlaySnapshot {
  myScreenName: string | null;
  /** The most recent match we've seen, whether or not it's finished. Null before any match is found. */
  match: OverlayMatch | null;
  /** Win/loss record for the current match's event (or the most recent event, if no match is active yet). */
  eventRecord: (WinRate & { eventId: string; deckName: string | null }) | null;
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
   * in types.ts) - keyed by eventId. Preferred over the locally-computed
   * rollup in snapshot() below, since it doesn't depend on us having
   * personally captured every match (found 2026-09-24: the log-rotation bug
   * cost us a whole match's worth of capture, and the overlay kept showing
   * a stale local count even after the fix, because it had no way to know
   * it was behind Arena's own bookkeeping).
   */
  private courseStandings = new Map<string, CourseStanding>();
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
          this.latestGameStateByMatch.set(event.matchId, event);
          this.currentMatchId = event.matchId;
        }
        break;
      case "CourseStanding":
        // Always overwrite - each EventGetCoursesV2 response is a full
        // current snapshot, not a delta, so the latest one for an event is
        // simply correct, whatever we had cached before.
        this.courseStandings.set(event.eventId, event);
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
   * CourseStanding backstop added in milestone 6 - the standing map is only
   * ever populated by *live* events too), so a correct record already known
   * from earlier in the session would silently regress to whatever the next
   * live event happened to say - observed 2026-09-24 as "the record only
   * corrects itself after finishing another match, not right away" after a
   * relaunch: the previously-seen correct CourseStanding was sitting in
   * tracker.db the whole time, just never read back in.
   */
  seedHistory(events: DomainEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
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
          this.courseStandings.set(event.eventId, event);
          break;
        case "DraftPackSeen":
          this.draftPacksSeen.push(event);
          break;
        case "DraftPickMade":
          this.draftPicksMade.push(event);
          break;
        case "DraftCompleted":
          if (event.draftId) this.completedDraftIds.add(event.draftId);
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
      a.ts.localeCompare(b.ts),
    );
    const lastActivity = activity.at(-1);
    if (lastActivity) this.lastActiveDraftId = lastActivity.draftId;
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
      const forEvent = rollupByEvent(outcomes).get(eventId) ?? [];
      const localRate = winRate(forEvent);
      const standing = this.courseStandings.get(eventId);
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
      const deck = [...this.deckSubmissions].reverse().find((d) => d.eventName === eventId) ?? null;
      eventRecord = {
        ...reconciled,
        eventId,
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

      if (latestPack) {
        currentDraft = { draftId, pack: latestPack.pack, pick: latestPack.pick, packCards: latestPack.packCards, picks };
      }
    }

    return { myScreenName: this.myScreenName, match, eventRecord, currentDraft };
  }
}
