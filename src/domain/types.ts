// Typed domain events, derived from real MTGA log data captured on
// 2026-09-18 (a human draft + one match, ContenderDraft_HOB_20260824).
// These field names are what we actually observed, not guesses - see
// project notes for the raw shapes they came from.

export interface DraftJoined {
  kind: "DraftJoined";
  eventName: string;
  entryCurrencyType: string;
  entryCurrencyPaid: number;
  ts: string;
}

export interface DraftPackSeen {
  kind: "DraftPackSeen";
  /**
   * For a human/Traditional-style draft this is the real per-session
   * draftId. Bot Draft (QuickDraft against bots - confirmed 2026-09-24)
   * has no separate draft-session id in its own event payload at all, only
   * an EventName (e.g. "QuickDraft_HOB_20260915") - so for those, this
   * field holds the eventName instead. Treat it as "whatever id ties this
   * draft run's picks together", not necessarily a GUID.
   */
  draftId: string;
  pack: number;
  pick: number;
  packCards: number[];
  ts: string;
}

export interface DraftPickMade {
  kind: "DraftPickMade";
  /** See DraftPackSeen.draftId's comment - same caveat applies here for Bot Draft. */
  draftId: string;
  pack: number;
  pick: number;
  /**
   * Every card taken at this one pick action - almost always a single
   * element, but an array because Arena's own request/response shapes
   * (`GrpIds`/`CardIds`, both confirmed real fields) are arrays even for a
   * normal 1-card pick, and "Pick Two" draft (a real Arena format: a
   * smaller pod, e.g. 4 players, where each pick takes 2 cards instead of
   * 1) is expected to reuse the same shape with more entries - see
   * classifier.ts's comment on classifyDraftPick/classifyBotDraftPick.
   * **Not yet confirmed against a real captured Pick Two Draft log** (no
   * such session has been captured as of this writing) - if a real one
   * ever shows a different shape than "the same field, more entries",
   * correct this the same way Bot Draft's real shape corrected an earlier
   * guess (milestone 5).
   */
  grpIds: number[];
  success: boolean | null; // null if we only saw the request, not the response
  ts: string;
}

export interface DraftCompleted {
  kind: "DraftCompleted";
  eventName: string;
  courseId: string;
  cardPool: number[];
  /** Best-effort link back to DraftPackSeen/DraftPickMade's draftId (see classifier). */
  draftId: string | null;
  ts: string;
}

/**
 * Arena's own authoritative win/loss record for one of the player's active
 * or recently-completed event runs ("courses"), from EventGetCoursesV2 -
 * confirmed 2026-09-24 (see classifier.ts's classifyCourseStandings
 * comment for the real captured shape). This exists specifically so the
 * overlay's event win-loss display doesn't depend entirely on us having
 * personally observed every MatchFound/MatchCompleted for that event -
 * Arena tracks this itself regardless of whether our own capture had any
 * gaps (e.g. the 2026-09-24 log-rotation bug), so it's the more trustworthy
 * source when available. See LiveStateTracker.snapshot().
 */
export interface CourseStanding {
  kind: "CourseStanding";
  /** InternalEventName - same string used as eventId/eventName everywhere else in this project. */
  eventId: string;
  courseId: string;
  wins: number;
  losses: number;
  /** Arena's own status for this run, e.g. "CreateMatch", "Complete" - not decoded further, just passed through. */
  currentModule: string | null;
  deckName: string | null;
  ts: string;
}

export interface DeckSubmitted {
  kind: "DeckSubmitted";
  eventName: string;
  deckId: string;
  deckName: string;
  mainDeck: Array<{ cardId: number; quantity: number }>;
  ts: string;
}

export interface MatchFound {
  kind: "MatchFound";
  matchId: string;
  eventId: string | null;
  players: Array<{
    userId: string;
    playerName: string;
    systemSeatId: number;
    teamId: number;
    /**
     * Raw field name from the log is genuinely "courseId", but verified
     * (2026-09-18) that it is NOT the same ID space as DraftCompleted's
     * courseId (that one's a GUID like "b468aa16-..."; this one looks like
     * "Avatar_Basic_Gollum_HOB" - plausibly a cosmetic avatar/pet id, not a
     * draft-run link). Do not use this to join a match back to a specific
     * draft run/deck - there is currently no field that does that. The only
     * confirmed reliable join across MatchFound/DraftCompleted/DeckSubmitted
     * is the eventName/eventId string (e.g. "ContenderDraft_HOB_20260824").
     */
    courseId: string | null;
  }>;
  ts: string;
}

export interface GameStateSnapshot {
  kind: "GameStateSnapshot";
  matchId: string | null;
  gameNumber: number | null;
  stage: string | null; // e.g. GameStage_Play, GameStage_GameOver
  turnActivePlayer: number | null;
  turnDecisionPlayer: number | null;
  players: Array<{ systemSeatNumber: number; lifeTotal: number; status: string; turnNumber?: number }>;
  ts: string;
}

export interface MatchCompleted {
  kind: "MatchCompleted";
  matchId: string;
  results: Array<{ scope: string; result: string; winningTeamId: number; reason: string }>;
  ts: string;
}

export interface PlayerIdentified {
  kind: "PlayerIdentified";
  screenName: string;
  clientId: string;
  ts: string;
}

export type DomainEvent =
  | DraftJoined
  | DraftPackSeen
  | DraftPickMade
  | DraftCompleted
  | DeckSubmitted
  | MatchFound
  | GameStateSnapshot
  | MatchCompleted
  | PlayerIdentified
  | CourseStanding;
