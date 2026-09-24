import type { CourseStanding, DeckSubmitted, DomainEvent, GameStateSnapshot, MatchCompleted, MatchFound } from "./types.js";
import { computeMatchOutcomes, rollupByEvent, winRate, winRateFromCounts, type WinRate } from "./rollups.js";

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
}

export interface OverlaySnapshot {
  myScreenName: string | null;
  /** The most recent match we've seen, whether or not it's finished. Null before any match is found. */
  match: OverlayMatch | null;
  /** Win/loss record for the current match's event (or the most recent event, if no match is active yet). */
  eventRecord: (WinRate & { eventId: string; deckName: string | null }) | null;
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
      // Draft events (DraftJoined/DraftPackSeen/DraftPickMade/DraftCompleted)
      // aren't needed for the match HUD or event win-rate panel yet - the
      // overlay's first version doesn't show draft-in-progress info.
      default:
        break;
    }
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
      const wins = Math.max(localRate.wins, standing?.wins ?? 0);
      const losses = Math.max(localRate.losses, standing?.losses ?? 0);
      const deck = [...this.deckSubmissions].reverse().find((d) => d.eventName === eventId) ?? null;
      eventRecord = {
        ...winRateFromCounts(wins, losses),
        eventId,
        deckName: deck?.deckName ?? standing?.deckName ?? null,
      };
    }

    return { myScreenName: this.myScreenName, match, eventRecord };
  }
}
