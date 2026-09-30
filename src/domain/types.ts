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
  /**
   * Milestone 18: the real sideboard Arena itself returns alongside the
   * maindeck in EventSetDeckV3's own response (CourseDeck.Sideboard,
   * confirmed real 2026-09-29 from the same live log this project's other
   * shapes come from) - not derived from anything. For a Draft/Sealed run
   * this is normally "the rest of the drafted/opened pool" (the same cards
   * eventHistory.ts's older cardPool-minus-mainDeck derivation produces,
   * now cross-checked against a real value instead of only ever guessed),
   * but for a Constructed deck it's the ONLY source there is - a
   * constructed sideboard is whatever 15 cards the player chose from their
   * whole collection, not "the rest of a limited pool", so there's nothing
   * to derive it from. Always an array (possibly empty) going forward, not
   * optional/undefined - a row captured before this field existed will
   * come back `undefined` at runtime despite the type saying otherwise
   * (this project's event-sourced storage never migrates old rows - see
   * eventHistoryLoader.ts's comment on backfill.ts being how a shape
   * change actually reaches already-captured data); code reading this
   * field checks `Array.isArray()` rather than assuming it's always set.
   */
  sideboard: Array<{ cardId: number; quantity: number }>;
  /**
   * Milestone 18: Arena's own player-facing format label for this specific
   * deck, read from CourseDeckSummary.Attributes (an array of {name,value}
   * pairs - both the EventSetDeckV3 request's Summary.Attributes and its
   * response's CourseDeckSummary.Attributes carry the same list; the
   * response is what's actually classified) by taking the entry whose
   * `name` is "Format". Confirmed real value: "Draft" (2026-09-18 capture,
   * the only real submission on record so far). Null when no such
   * Attributes entry exists in the response at all - not expected in
   * practice, but treated as absent rather than assumed. This is a far
   * more reliable format signal than guessing from the event's own name
   * (see eventIdentity.ts's classifyFormat, kept as a fallback for runs
   * with no DeckSubmitted at all) - but only the MECHANISM is confirmed
   * (read Attributes[].value where name === "Format"); the actual string
   * values a real Constructed deck's Format would contain (expected to be
   * one of Arena's known format names - Standard, Historic, Explorer,
   * Alchemy, Timeless, Brawl, or similar) have never been observed, only
   * "Draft" has. See eventIdentity.ts's resolveEventFormat for how this is
   * turned into the project's own EventFormat categories.
   */
  format: string | null;
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
  /**
   * Milestone 20 (2026-09-30): "track ... number of mulgains (me and
   * opponent)" - `mulliganCount` sits in the exact same per-player object
   * this already partially parses (systemSeatNumber/lifeTotal/status/
   * turnNumber), confirmed real from a captured `mulliganReq` shape
   * (`{mulliganType: "MulliganType_London", mulliganCount: 1}`) - optional
   * and omitted (not 0) for a player who hasn't mulliganed, matching this
   * project's already-confirmed "Arena omits zero-valued fields" convention
   * (see the CurrentLosses/InventoryGold gotchas in architecture-and-
   * status.md) - defaulted to 0 by matchDetails.ts's consumer, not here.
   */
  players: Array<{ systemSeatNumber: number; lifeTotal: number; status: string; turnNumber?: number; mulliganCount?: number }>;
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

/**
 * What a player actually won by claiming an event's final prize -
 * EventClaimPrize, confirmed 2026-09-25 from one real captured example
 * (QuickDraft_HOB_20260915) - see classifyEventClaimPrize's comment for
 * the full real response shape this is built from. Distinct from
 * CourseStanding: that's Arena's running win/loss record for a course
 * while it's still active/recently finished; this is the one-time reward
 * payout, captured only when the player actually clicks "claim".
 *
 * `gold`/`grantedCardCount` are best-effort - see classifyEventClaimPrize
 * for exactly which parts of this shape are confirmed-from-real-data
 * versus still unverified.
 */
export interface EventReward {
  kind: "EventReward";
  /** InternalEventName - same eventId string used everywhere else (CourseStanding, DeckSubmitted, ...). */
  eventId: string;
  courseId: string;
  /** Confirmed real field: gems granted by this specific claim (not a running total - see classifier.ts). */
  gems: number;
  /**
   * Best-effort/unconfirmed: no real captured EventClaimPrize example has
   * included a nonzero gold reward yet, so the key Arena actually uses for
   * a gold delta (assumed "InventoryGold", by analogy with the confirmed
   * "InventoryGems") is unverified. Defaults to 0 - consistent with this
   * project's already-confirmed "Arena omits zero-valued delta fields"
   * convention (CurrentLosses, milestone 6) - but treat this specific
   * number as suspect until a real gold-reward example confirms the key.
   */
  gold: number;
  boosters: Array<{ setCode: string; count: number }>;
  /**
   * Best-effort: GrantedCards was present but empty ([]) in the one real
   * captured example, so its per-item shape (which field holds the card
   * id) is unconfirmed - this is just a count, not the actual card ids,
   * until a real example with a granted card is captured.
   */
  grantedCardCount: number;
  ts: string;
}

/**
 * Milestone 18: a card pool captured from the generic `CardPool` field
 * Arena already includes on a "Course" object - the same field
 * DraftCompleted.cardPool has always come from (confirmed real, used
 * since milestone 4), except read here from wherever else a Course shows
 * up (EventGetCoursesV2's per-course entries, EventClaimPrize's Course -
 * see classifier.ts) instead of only from DraftCompleteDraft's response.
 * This exists specifically for Sealed: a Sealed run never fires
 * DraftCompleteDraft (there's no draft), so DraftCompleted.cardPool is
 * never populated for one - but if Sealed's opened pool is delivered
 * through the same generic Course.CardPool field Draft's course entries
 * already carry (a reasonable bet, since EventGetCoursesV2/EventClaimPrize
 * are format-agnostic "list/claim my event runs" endpoints, not
 * draft-specific ones), this captures it the same way, no new RPC shape
 * needed.
 *
 * Flagged honestly: the FIELD itself (Course.CardPool) is confirmed real
 * data - draft's own course entries already carry it, redundant with
 * DraftCompleted.cardPool for that case. What's NOT yet confirmed is that
 * a real Sealed run's course entry actually populates this same field
 * with its opened pool - no Sealed event has been captured in this
 * project's log yet (see the open item in the project's architecture doc).
 * eventHistory.ts prefers DraftCompleted.cardPool when both exist (the
 * more specifically-confirmed source) and only falls back to this for a
 * run that has no DraftCompleted at all.
 */
export interface EventCardPool {
  kind: "EventCardPool";
  /** InternalEventName - same eventId string used everywhere else. */
  eventId: string;
  courseId: string;
  cardPool: number[];
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
  | CourseStanding
  | EventReward
  | EventCardPool;
