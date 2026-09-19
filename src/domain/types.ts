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
  draftId: string;
  pack: number;
  pick: number;
  packCards: number[];
  ts: string;
}

export interface DraftPickMade {
  kind: "DraftPickMade";
  draftId: string;
  pack: number;
  pick: number;
  grpId: number;
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
  | PlayerIdentified;
