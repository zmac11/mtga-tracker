import type {
  CardPlayedInGame,
  DomainEvent,
  DraftPickMade,
  GameHandResolved,
  RewardGrant,
} from "./types.js";

/**
 * Minimal shape a raw captured block needs to expose to be classified.
 * Both the live pipeline (LogParser's RawBlock) and the JSONL backfill
 * records satisfy this.
 */
export interface ClassifiableEvent {
  direction: "request" | "response" | "unknown";
  method: string | null;
  json: unknown;
  ts: string;
}

function tryParseJSON(value: unknown): any {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Milestone 23 (features e/f): one match's worth of zone-tracking state for
 * GameHandResolved/CardPlayedInGame - see classifyHandAndPlayedCards.
 */
interface ZoneGameState {
  /** Arena's own gameNumber for whatever game this state currently describes - updated whenever a gameInfo.gameNumber arrives; null until one does (see classifyGreGameState). */
  gameNumber: number | null;
  /** Every instanceId -> grpId this game has ever revealed to us (gameObjects entries accumulate; never removed, so a card's identity is still known after it leaves hand). */
  grpIdByInstanceId: Map<number, number>;
  /** Each seat's current Hand zone content (instanceIds), from the latest zones diff that touched it - a fresh deal/redraw during mulligan just replaces this wholesale, same as Arena's own diffs do. */
  lastHandByOwnerSeat: Map<number, Set<number>>;
  /** Which seats' opening (post-mulligan, post-bottom) hand has already been frozen and reported via GameHandResolved this game - also gates CardPlayedInGame (a card leaving hand before this fires is mulligan/redraw churn, not a real play). */
  openingHandResolvedSeats: Set<number>;
  /** instanceIds already reported via CardPlayedInGame this game - never report the same physical card leaving hand twice. */
  playedInstanceIdsEmitted: Set<number>;
}

function freshZoneGameState(): ZoneGameState {
  return {
    gameNumber: null,
    grpIdByInstanceId: new Map(),
    lastHandByOwnerSeat: new Map(),
    openingHandResolvedSeats: new Set(),
    playedInstanceIdsEmitted: new Set(),
  };
}

/**
 * Turns generic captured blocks into typed domain events.
 *
 * Field names/shapes here are taken from a real captured draft + match
 * (2026-09-18, event "ContenderDraft_HOB_20260824") - not guessed. Wizards
 * can and has changed these before, so if a shape stops matching, events
 * will just silently stop being classified (falling through to the
 * default `[]`) rather than throwing - check `data/raw-events.jsonl`
 * against the shapes below if that happens.
 *
 * Kept deliberately narrow: draft pack/pick, draft completion, deck
 * submission, match found/completed, and a light game-state snapshot
 * (life totals, turn, stage). Full turn-by-turn action parsing (spells
 * cast, mana spent, stack) is out of scope for now - see
 * `clientToMatchServiceMessageType` / most `greToClientEvent` messages,
 * which are intentionally left unclassified.
 */
export class Classifier {
  /** FIFO queue of picks awaiting their IsPickSuccessful confirmation. */
  private pendingPicks: DraftPickMade[] = [];
  /** GRE game-state diffs often omit matchID; carry the last one we saw. */
  private lastKnownMatchId: string | null = null;
  /**
   * Milestone 23 (features e/f): per-match zone-tracking state for
   * GameHandResolved/CardPlayedInGame - see classifyHandAndPlayedCards.
   * Keyed by matchId (not matchId+gameNumber - a fresh deal detected mid-
   * match resets the SAME entry for a new game, rather than partitioning
   * by gameNumber, since gameInfo.gameNumber arrives too sparsely/
   * unpredictably to safely key state-partitioning on it - see that
   * method's own comment).
   */
  private zoneStateByMatch = new Map<string, ZoneGameState>();
  /**
   * The log never puts a draftId on DraftCompleteDraft's response, only on
   * the pack/pick events that came before it - so we track "whichever
   * draftId we last saw picks for" and attach it when the draft completes.
   * Assumes one draft in flight at a time, which matches how the Arena
   * client actually works.
   */
  private currentDraftId: string | null = null;

  classify(ev: ClassifiableEvent): DomainEvent[] {
    const out: DomainEvent[] = [];
    const json = ev.json;
    if (!isObj(json)) return out;

    this.classifyDraftJoin(ev, json, out);
    this.classifyDraftPack(ev, json, out);
    this.classifyDraftPick(ev, json, out);
    this.classifyBotDraftPick(ev, json, out);
    this.classifyDraftComplete(ev, json, out);
    this.classifyDeckSubmitted(ev, json, out);
    this.classifyCourseStandings(ev, json, out);
    this.classifyEventJoinCourse(ev, json, out);
    this.classifyEventClaimPrize(ev, json, out);
    this.classifyRewardGrants(ev, json, out);
    this.classifyMatchRoomState(ev, json, out);
    this.classifyGreGameState(ev, json, out);
    this.classifyAuthenticate(ev, json, out);

    return out;
  }

  private classifyAuthenticate(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    const auth = json.authenticateResponse;
    if (isObj(auth) && typeof auth.screenName === "string" && typeof auth.clientId === "string") {
      out.push({ kind: "PlayerIdentified", screenName: auth.screenName, clientId: auth.clientId, ts: ev.ts });
    }
  }

  private classifyDraftJoin(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventJoin" || ev.direction !== "request") return;
    const req = tryParseJSON(json.request);
    if (!isObj(req) || typeof req.EventName !== "string") return;
    out.push({
      kind: "DraftJoined",
      eventName: req.EventName,
      entryCurrencyType: String(req.EntryCurrencyType ?? "Unknown"),
      entryCurrencyPaid: Number(req.EntryCurrencyPaid ?? 0),
      ts: ev.ts,
    });
  }

  private classifyDraftPack(_ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    // "Draft.Notify" - no ==>/<== marker, so method is usually null. Detect by shape.
    if (typeof json.draftId !== "string" || typeof json.PackCards !== "string") return;
    if (typeof json.SelfPack !== "number" || typeof json.SelfPick !== "number") return;
    const packCards = json.PackCards.split(",").map(Number).filter((n) => Number.isFinite(n));
    this.currentDraftId = json.draftId;
    out.push({
      kind: "DraftPackSeen",
      draftId: json.draftId,
      pack: json.SelfPack,
      pick: json.SelfPick,
      packCards,
      ts: _ev.ts,
    });
  }

  /**
   * `GrpIds` is a real confirmed field (2026-09-18 capture) and is already
   * an array in the request body even for a normal 1-card pick - it just
   * happens to have one element there. Kept as the full array (not
   * truncated to `[0]`) so a "Pick Two" draft pick (2 cards taken in one
   * pick action - see types.ts's comment on DraftPickMade.grpIds) is
   * captured correctly rather than silently dropping the second card. This
   * generalization hasn't been confirmed against a real Pick Two Draft log
   * yet - only the 1-element case is confirmed real data.
   */
  private classifyDraftPick(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventPlayerDraftMakePick") return;

    if (ev.direction === "request") {
      const req = tryParseJSON(json.request);
      if (!isObj(req) || typeof req.DraftId !== "string" || !Array.isArray(req.GrpIds) || req.GrpIds.length === 0) return;
      this.currentDraftId = req.DraftId;
      const pick: DraftPickMade = {
        kind: "DraftPickMade",
        draftId: req.DraftId,
        pack: Number(req.Pack),
        pick: Number(req.Pick),
        grpIds: req.GrpIds.map(Number),
        success: null,
        ts: ev.ts,
      };
      this.pendingPicks.push(pick);
      out.push(pick);
      return;
    }

    if (ev.direction === "response" && typeof json.IsPickSuccessful === "boolean") {
      // Responses don't carry the draft/pack/pick id in the body - correlate
      // by order (Arena confirms picks in the order they were submitted).
      const pending = this.pendingPicks.shift();
      if (pending) {
        out.push({ ...pending, success: json.IsPickSuccessful, ts: ev.ts });
      }
    }
  }

  /**
   * Bot Draft (QuickDraft against bots - confirmed 2026-09-24, event
   * "QuickDraft_HOB_20260915") uses a completely different single
   * method for both viewing a pack and making a pick, unlike the
   * Draft.Notify + EventPlayerDraftMakePick pair the human-draft path
   * above handles. Real observed shapes:
   *
   *   ==> BotDraftDraftPick {"id":"...","request":"{\"EventName\":\"...\",
   *     \"PickInfo\":{\"EventName\":\"...\",\"CardIds\":[\"103509\"],
   *     \"PackNumber\":0,\"PickNumber\":0}}"}
   *
   *   <== BotDraftDraftPick(<id>)
   *   {"CurrentModule":"BotDraft","Payload":"{\"Result\":\"Success\",
   *     \"EventName\":\"...\",\"DraftStatus\":\"PickNext\",\"PackNumber\":0,
   *     \"PickNumber\":1,\"NumCardsToPick\":1,
   *     \"DraftPack\":[\"103479\",\"103388\",...],\"PackStyles\":[],
   *     \"PickedCards\":[\"103509\"],\"PickedStyles\":[]}", ...}
   *
   * PackNumber/PickNumber are 0-indexed here (unlike the human-draft path's
   * 1-indexed SelfPack/SelfPick/Pack/Pick) - normalized to 1-indexed below
   * so reports read the same way regardless of draft type ("Pack 1, Pick 1"
   * matches what Arena's own UI shows).
   *
   * There's no separate draft-session id anywhere in this payload, only an
   * EventName - used as DraftPickMade/DraftPackSeen's draftId for these
   * (see the comment on DraftPackSeen.draftId in types.ts).
   *
   * The response conveniently already contains the *next* pack's full
   * contents (DraftPack) - unlike the human-draft path, which needs a
   * separate Draft.Notify push for that - so one response here produces
   * both the pick confirmation and the next DraftPackSeen.
   *
   * `CardIds` is already an array (confirmed real, one element for a
   * normal pick) and the response even carries a `NumCardsToPick` field
   * describing how many cards the *next* pick requires - both signs this
   * same request shape is meant to support taking more than one card in
   * one pick action (e.g. "Pick Two" draft's smaller pod, 2 cards per
   * pick - see types.ts's comment on DraftPickMade.grpIds). Captured as the
   * full array rather than truncated to `[0]`, same reasoning as the
   * human-draft path above - not yet confirmed against a real Pick Two
   * Draft log.
   */
  private classifyBotDraftPick(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "BotDraftDraftPick") return;

    if (ev.direction === "request") {
      const req = tryParseJSON(json.request);
      const pickInfo = isObj(req) ? req.PickInfo : undefined;
      if (!isObj(req) || typeof req.EventName !== "string" || !isObj(pickInfo) || !Array.isArray(pickInfo.CardIds) || pickInfo.CardIds.length === 0) return;
      this.currentDraftId = req.EventName;
      const pick: DraftPickMade = {
        kind: "DraftPickMade",
        draftId: req.EventName,
        pack: Number(pickInfo.PackNumber ?? 0) + 1,
        pick: Number(pickInfo.PickNumber ?? 0) + 1,
        grpIds: pickInfo.CardIds.map(Number),
        success: null,
        ts: ev.ts,
      };
      this.pendingPicks.push(pick);
      out.push(pick);
      return;
    }

    if (ev.direction === "response") {
      const payload = tryParseJSON(json.Payload);
      if (!isObj(payload) || typeof payload.EventName !== "string") return;

      const pending = this.pendingPicks.shift();
      if (pending) {
        out.push({ ...pending, success: payload.Result === "Success", ts: ev.ts });
      }

      if (Array.isArray(payload.DraftPack) && payload.DraftPack.length > 0) {
        out.push({
          kind: "DraftPackSeen",
          draftId: payload.EventName,
          pack: Number(payload.PackNumber ?? 0) + 1,
          pick: Number(payload.PickNumber ?? 0) + 1,
          packCards: payload.DraftPack.map(Number),
          ts: ev.ts,
        });
      }
    }
  }

  private classifyDraftComplete(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "DraftCompleteDraft" || ev.direction !== "response") return;
    if (typeof json.InternalEventName !== "string" || typeof json.CourseId !== "string") return;
    const cardPool = Array.isArray(json.CardPool) ? json.CardPool.map(Number) : [];
    out.push({
      kind: "DraftCompleted",
      eventName: json.InternalEventName,
      courseId: json.CourseId,
      cardPool,
      draftId: this.currentDraftId,
      ts: ev.ts,
    });
    this.currentDraftId = null;
  }

  /**
   * Milestone 18: also captures the real sideboard (deck.Sideboard,
   * confirmed real 2026-09-29 - see DeckSubmitted's doc comment in
   * types.ts) and the deck's own Format attribute (summary.Attributes,
   * entry named "Format" - confirmed real value "Draft"). Both are read
   * defensively (missing/malformed Attributes just yields format: null,
   * a non-array Sideboard yields an empty array) rather than rejecting
   * the whole submission, since neither is required for the rest of this
   * event to still be useful.
   */
  private classifyDeckSubmitted(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventSetDeckV3" || ev.direction !== "response") return;
    if (typeof json.InternalEventName !== "string") return;
    const summary = json.CourseDeckSummary;
    const deck = json.CourseDeck;
    if (!isObj(summary) || !isObj(deck) || !Array.isArray(deck.MainDeck)) return;

    const attributes = Array.isArray(summary.Attributes) ? summary.Attributes.filter(isObj) : [];
    const formatAttr = attributes.find((a) => a.name === "Format");
    const format = formatAttr && typeof formatAttr.value === "string" ? formatAttr.value : null;

    out.push({
      kind: "DeckSubmitted",
      eventName: json.InternalEventName,
      deckId: String(summary.DeckId ?? ""),
      deckName: String(summary.Name ?? ""),
      mainDeck: deck.MainDeck.map((c: any) => ({ cardId: Number(c.cardId), quantity: Number(c.quantity) })),
      sideboard: Array.isArray(deck.Sideboard) ? deck.Sideboard.map((c: any) => ({ cardId: Number(c.cardId), quantity: Number(c.quantity) })) : [],
      format,
      ts: ev.ts,
    });
  }

  /**
   * EventGetCoursesV2 response - Arena's own authoritative list of the
   * player's active/recently-completed event runs ("courses"), each with
   * its own CurrentWins/CurrentLosses. Confirmed 2026-09-24 from a real
   * live log:
   *
   *   <== EventGetCoursesV2(<id>)
   *   {"Courses":[{"CourseId":"...","InternalEventName":"QuickDraft_HOB_20260915",
   *     "CurrentModule":"CreateMatch","CourseDeckSummary":{"Name":"Draft Deck",...},
   *     "CourseDeck":{...},"CurrentWins":1,"CardPool":[...],...}, ...]}
   *
   * CurrentWins/CurrentLosses appear to be omitted entirely when 0 (observed
   * directly: a course with 0 losses had no "CurrentLosses" key at all, not
   * a 0 value) - defaulted to 0 here rather than treated as missing data.
   *
   * This exists specifically so the overlay's win/loss display doesn't
   * depend entirely on us having personally captured every match for an
   * event - see CourseStanding's comment in types.ts and
   * LiveStateTracker.snapshot() for how it's used to correct/backstop the
   * locally-observed count.
   */
  private classifyCourseStandings(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventGetCoursesV2" || ev.direction !== "response") return;
    if (!Array.isArray(json.Courses)) return;

    for (const course of json.Courses) this.emitCourse(course, ev.ts, out);
  }

  /**
   * EventJoin response - confirmed real (2026-10-02, Sealed_FRA_20260929):
   * carries the same Course object an EventGetCoursesV2 listing does,
   * including the whole freshly-granted Sealed pool (CardPool, 84 cards)
   * and CurrentModule "DeckSelect". Previously only the REQUEST was
   * classified (DraftJoined), so the pool and the course itself weren't
   * recorded until some later course listing happened to include them
   * (in practice: right after the deck was saved) - meaning anything that
   * went wrong between opening the boosters and saving the deck lost the
   * pool entirely, and the run didn't exist as a course until then. Same
   * shared emission as the course listing, so the output is identical.
   */
  private classifyEventJoinCourse(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventJoin" || ev.direction !== "response") return;
    this.emitCourse(json.Course, ev.ts, out);
  }

  private emitCourse(course: unknown, ts: string, out: DomainEvent[]) {
    if (!isObj(course)) return;
    if (typeof course.InternalEventName !== "string" || typeof course.CourseId !== "string") return;
    const deckSummary = course.CourseDeckSummary;
    out.push({
      kind: "CourseStanding",
      eventId: course.InternalEventName,
      courseId: course.CourseId,
      wins: Number(course.CurrentWins ?? 0),
      losses: Number(course.CurrentLosses ?? 0),
      currentModule: typeof course.CurrentModule === "string" ? course.CurrentModule : null,
      deckName: isObj(deckSummary) && typeof deckSummary.Name === "string" ? deckSummary.Name : null,
      ts,
    });

    // Milestone 18: same generic Course.CardPool field DraftCompleted
    // has always read (see EventCardPool's doc comment in types.ts) -
    // captured here too so a format that never fires DraftCompleteDraft
    // (chiefly Sealed) still gets its pool recorded, via whichever
    // course listing happens to include it. Skipped when empty/absent -
    // most courses (anything non-limited) won't have one at all.
    if (Array.isArray(course.CardPool) && course.CardPool.length > 0) {
      out.push({
        kind: "EventCardPool",
        eventId: course.InternalEventName,
        courseId: course.CourseId,
        cardPool: course.CardPool.map(Number),
        ts,
      });
    }
  }

  /**
   * EventClaimPrize response - fires when the player claims an event's
   * final prize. Confirmed 2026-09-25 from one real captured example
   * (QuickDraft_HOB_20260915, both request and response), the only claim
   * captured so far:
   *
   *   <== EventClaimPrize(<id>)
   *   {"Course":{"CourseId":"...","InternalEventName":"QuickDraft_HOB_20260915",
   *     "CurrentModule":"Complete", ...same per-course shape EventGetCoursesV2
   *     returns, notably CourseDeck.Sideboard as a real provided array...},
   *    "InventoryInfo":{"Changes":[{"Source":"EventReward",
   *      "SourceId":"<courseId>","InventoryGems":650,
   *      "Boosters":[{"CollationId":100062,"SetCode":"HOB","Count":2}],
   *      "GrantedCards":[]}], "Gems":6130,"Gold":2175,...}}
   *
   * `InventoryInfo`'s top-level Gems/Gold/WildCard* fields are the
   * player's ACCOUNT-WIDE running totals after the claim, not this
   * event's reward - the actual per-claim delta is the one entry in
   * `Changes` where Source === "EventReward" (matched defensively against
   * SourceId === courseId, in case a claim ever produces more than one
   * change entry). InventoryGold was absent from the one real example (a
   * gems+boosters claim, no gold) - see EventReward's own doc comment in
   * types.ts for why that field is treated as best-effort rather than
   * fully confirmed. GrantedCards was present but empty, so only its
   * count is taken here, not any per-card shape.
   */
  private classifyEventClaimPrize(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventClaimPrize" || ev.direction !== "response") return;
    const course = json.Course;
    if (!isObj(course) || typeof course.InternalEventName !== "string" || typeof course.CourseId !== "string") return;
    const inventoryInfo = json.InventoryInfo;
    if (!isObj(inventoryInfo) || !Array.isArray(inventoryInfo.Changes)) return;

    const rewardChange = inventoryInfo.Changes.find(
      (c) => isObj(c) && c.Source === "EventReward" && c.SourceId === course.CourseId,
    );
    if (!isObj(rewardChange)) return;

    const boosters = Array.isArray(rewardChange.Boosters)
      ? rewardChange.Boosters.filter(isObj).map((b) => ({ setCode: String(b.SetCode ?? ""), count: Number(b.Count ?? 0) }))
      : [];

    out.push({
      kind: "EventReward",
      eventId: course.InternalEventName,
      courseId: course.CourseId,
      gems: Number(rewardChange.InventoryGems ?? 0),
      gold: Number(rewardChange.InventoryGold ?? 0),
      boosters,
      grantedCardCount: Array.isArray(rewardChange.GrantedCards) ? rewardChange.GrantedCards.length : 0,
      ts: ev.ts,
    });

    // Milestone 18: same generic Course.CardPool capture as
    // classifyCourseStandings above - EventClaimPrize's own Course also
    // carries it (see EventCardPool's doc comment in types.ts).
    if (Array.isArray(course.CardPool) && course.CardPool.length > 0) {
      out.push({
        kind: "EventCardPool",
        eventId: course.InternalEventName,
        courseId: course.CourseId,
        cardPool: course.CardPool.map(Number),
        ts: ev.ts,
      });
    }
  }

  /**
   * Milestone 21: generic capture behind "track overall rewards from
   * quests etc." - see RewardGrant's doc comment in types.ts for the full
   * rationale. Deliberately NOT scoped to method === "EventClaimPrize"
   * (unlike classifyEventClaimPrize above): confirmed real from the
   * user's own log that json.InventoryInfo.Changes is a top-level sibling
   * on EventClaimPrize, GraphProcessV2 (Mastery Pass tier-ups), and
   * EventJoin (entry cost + sealed-pool grant) alike, all at the exact
   * same top-level position - so this fires on ANY response carrying it,
   * regardless of method, and emits one RewardGrant per Changes[] entry
   * with no Source filtering at all. That means a genuine event-prize
   * claim produces BOTH an EventReward (from classifyEventClaimPrize,
   * above, untouched by this method) AND a RewardGrant from this one -
   * intentional duplication across two different-purpose types, not a
   * bug (see RewardGrant's doc comment).
   *
   * Confirmed real and explicitly ruled out as a capture source:
   * StartHook - it also carries InventoryInfo.Changes (39/56 of the
   * user's real occurrences), but every single one is an empty array
   * (pure login/session snapshot, no deltas) - so it's harmless to
   * include here rather than special-case out, since an empty Changes
   * array simply yields zero pushes.
   */
  private classifyRewardGrants(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.direction !== "response") return;
    const inventoryInfo = json.InventoryInfo;
    if (!isObj(inventoryInfo) || !Array.isArray(inventoryInfo.Changes)) return;

    for (const change of inventoryInfo.Changes) {
      if (!isObj(change) || typeof change.Source !== "string") continue;

      const boosters = Array.isArray(change.Boosters)
        ? change.Boosters.filter(isObj).map((b) => ({ setCode: String(b.SetCode ?? ""), count: Number(b.Count ?? 0) }))
        : [];

      const grant: RewardGrant = {
        kind: "RewardGrant",
        source: change.Source,
        sourceId: typeof change.SourceId === "string" ? change.SourceId : null,
        gems: Number(change.InventoryGems ?? 0),
        gold: Number(change.InventoryGold ?? 0),
        boosters,
        grantedCardCount: Array.isArray(change.GrantedCards) ? change.GrantedCards.length : 0,
        ts: ev.ts,
      };
      out.push(grant);
    }
  }

  private classifyMatchRoomState(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    const outer = json.matchGameRoomStateChangedEvent;
    if (!isObj(outer)) return;
    const info = outer.gameRoomInfo;
    if (!isObj(info)) return;

    const config = info.gameRoomConfig;
    const matchIdFromConfig = isObj(config) && typeof config.matchId === "string" ? config.matchId : null;

    if (info.stateType === "MatchGameRoomStateType_Playing" && isObj(config) && Array.isArray(config.reservedPlayers)) {
      const players = config.reservedPlayers
        .filter(isObj)
        .map((p) => ({
          userId: String(p.userId ?? ""),
          playerName: String(p.playerName ?? ""),
          systemSeatId: Number(p.systemSeatId ?? 0),
          teamId: Number(p.teamId ?? 0),
          courseId: typeof p.courseId === "string" ? p.courseId : null,
        }));
      const firstRaw = config.reservedPlayers.find(isObj);
      const eventId = firstRaw && typeof firstRaw.eventId === "string" ? firstRaw.eventId : null;
      out.push({
        kind: "MatchFound",
        matchId: matchIdFromConfig ?? "",
        eventId,
        players,
        ts: ev.ts,
      });
    }

    const finalResult = info.finalMatchResult;
    if (isObj(finalResult) && Array.isArray(finalResult.resultList)) {
      out.push({
        kind: "MatchCompleted",
        matchId: String(finalResult.matchId ?? matchIdFromConfig ?? ""),
        results: finalResult.resultList.filter(isObj).map((r) => ({
          scope: String(r.scope ?? ""),
          result: String(r.result ?? ""),
          winningTeamId: Number(r.winningTeamId ?? -1),
          reason: String(r.reason ?? ""),
        })),
        ts: ev.ts,
      });
    }
  }

  private classifyGreGameState(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    const gre = json.greToClientEvent;
    if (!isObj(gre) || !Array.isArray(gre.greToClientMessages)) return;

    for (const msg of gre.greToClientMessages) {
      if (!isObj(msg) || msg.type !== "GREMessageType_GameStateMessage") continue;
      const gsm = msg.gameStateMessage;
      if (!isObj(gsm)) continue;

      const gameInfo = isObj(gsm.gameInfo) ? gsm.gameInfo : null;
      if (gameInfo && typeof gameInfo.matchID === "string") {
        this.lastKnownMatchId = gameInfo.matchID;
      }

      const players = Array.isArray(gsm.players)
        ? gsm.players.filter(isObj).map((p) => ({
            systemSeatNumber: Number(p.systemSeatNumber ?? 0),
            lifeTotal: Number(p.lifeTotal ?? 0),
            status: String(p.status ?? ""),
            turnNumber: typeof p.turnNumber === "number" ? p.turnNumber : undefined,
            mulliganCount: typeof p.mulliganCount === "number" ? p.mulliganCount : undefined,
          }))
        : [];
      const turnInfo = isObj(gsm.turnInfo) ? gsm.turnInfo : null;

      // Milestone 23 (features e/f): zone/hand/played-card tracking runs
      // for EVERY GameStateMessage, unlike the GameStateSnapshot emission
      // below (which skips "pure noise" diffs) - a pure zone-transfer diff
      // (e.g. a card leaving hand) carries none of players/stage/turnInfo
      // and would never be seen here at all if this ran after that skip.
      if (this.lastKnownMatchId) {
        this.classifyHandAndPlayedCards(ev, gsm, this.lastKnownMatchId, out);
      }

      // Skip pure noise (diffs that touch neither life totals, stage, nor turn).
      if (players.length === 0 && !gameInfo?.stage && !turnInfo) continue;

      out.push({
        kind: "GameStateSnapshot",
        matchId: this.lastKnownMatchId,
        gameNumber: typeof gameInfo?.gameNumber === "number" ? gameInfo.gameNumber : null,
        stage: typeof gameInfo?.stage === "string" ? gameInfo.stage : null,
        turnActivePlayer: typeof turnInfo?.activePlayer === "number" ? turnInfo.activePlayer : null,
        turnDecisionPlayer: typeof turnInfo?.decisionPlayer === "number" ? turnInfo.decisionPlayer : null,
        players,
        ts: ev.ts,
      });
    }
  }

  /**
   * Milestone 23 (features e/f): "track winrate on cards whether I had
   * them in opening hands or not" / "...if I played them during match" -
   * traced against a real captured mulligan (2026-09-18/30, a single
   * London mulligan down to 6): GameStateMessage.players[].pendingMessageType
   * is "ClientMessageType_MulliganResp" while a seat's mulligan decision is
   * pending; `zones` entries are whole-zone replacements (a changed zone's
   * FULL new objectInstanceIds list, not an incremental delta); the
   * post-bottom hand size is already reflected in the SAME diff that first
   * carries a resolved `turnInfo.turnNumber` (turn 1 cannot begin while a
   * decision is still pending), which is what makes "first turnNumber
   * sighting" a safe freeze point for the real opening hand.
   *
   * State is reset ("fresh deal") whenever every player in `players` is
   * simultaneously pending MulliganResp with no mulliganCount yet - the
   * one real signal a brand-new game (1, 2, or 3 of a Bo3) just dealt
   * everyone their first 7, independent of gameInfo.gameNumber's own
   * sparse/unpredictable arrival timing (see ZoneGameState's own comment).
   */
  private classifyHandAndPlayedCards(ev: ClassifiableEvent, gsm: Record<string, unknown>, matchId: string, out: DomainEvent[]) {
    const rawPlayers = Array.isArray(gsm.players) ? gsm.players.filter(isObj) : [];
    const gameInfo = isObj(gsm.gameInfo) ? gsm.gameInfo : null;
    const turnInfo = isObj(gsm.turnInfo) ? gsm.turnInfo : null;

    const isFreshDeal =
      rawPlayers.length >= 2 &&
      rawPlayers.every((p) => p.pendingMessageType === "ClientMessageType_MulliganResp" && !p.mulliganCount);

    let state = this.zoneStateByMatch.get(matchId);
    if (!state || isFreshDeal) {
      state = freshZoneGameState();
      this.zoneStateByMatch.set(matchId, state);
    }
    if (typeof gameInfo?.gameNumber === "number") state.gameNumber = gameInfo.gameNumber;

    if (Array.isArray(gsm.gameObjects)) {
      for (const go of gsm.gameObjects) {
        if (!isObj(go)) continue;
        const instanceId = Number(go.instanceId);
        const grpId = Number(go.grpId);
        if (Number.isFinite(instanceId) && Number.isFinite(grpId)) state.grpIdByInstanceId.set(instanceId, grpId);
      }
    }

    if (Array.isArray(gsm.zones)) {
      for (const z of gsm.zones) {
        if (!isObj(z) || z.type !== "ZoneType_Hand" || typeof z.ownerSeatId !== "number") continue;
        const ownerSeat = z.ownerSeatId;
        const newIds = new Set((Array.isArray(z.objectInstanceIds) ? z.objectInstanceIds : []).map(Number));
        const previousIds = state.lastHandByOwnerSeat.get(ownerSeat);

        // Only once this seat's opening hand has already been frozen below -
        // a card "leaving" hand during the mulligan dance itself (shuffled
        // away, replaced by a fresh redraw, or bottomed post-keep) is not a
        // real play and must never be reported as one.
        if (previousIds && state.openingHandResolvedSeats.has(ownerSeat)) {
          for (const removedId of previousIds) {
            if (newIds.has(removedId)) continue;
            if (state.playedInstanceIdsEmitted.has(removedId)) continue;
            const grpId = state.grpIdByInstanceId.get(removedId);
            if (grpId === undefined) continue; // can't resolve this card's identity - skip rather than report an unknown play
            state.playedInstanceIdsEmitted.add(removedId);
            out.push({ kind: "CardPlayedInGame", matchId, gameNumber: state.gameNumber, seat: ownerSeat, grpId, ts: ev.ts } satisfies CardPlayedInGame);
          }
        }

        state.lastHandByOwnerSeat.set(ownerSeat, newIds);
      }
    }

    // Freeze the opening hand for any seat whose hand we've seen but
    // haven't resolved yet, the first time real turn tracking appears -
    // see this method's own comment for why that moment is safe.
    if (typeof turnInfo?.turnNumber === "number") {
      for (const [ownerSeat, handIds] of state.lastHandByOwnerSeat) {
        if (state.openingHandResolvedSeats.has(ownerSeat)) continue;
        state.openingHandResolvedSeats.add(ownerSeat);
        const grpIds: number[] = [];
        for (const id of handIds) {
          const grpId = state.grpIdByInstanceId.get(id);
          if (grpId !== undefined) grpIds.push(grpId);
        }
        // Only emitted when at least one card actually resolved - in
        // practice this means only the player's OWN seat ever produces a
        // real GameHandResolved (Arena never reveals the opponent's true
        // hidden-hand identities to our client - see this event's own doc
        // comment in types.ts).
        if (grpIds.length > 0) {
          out.push({ kind: "GameHandResolved", matchId, gameNumber: state.gameNumber, seat: ownerSeat, grpIds, ts: ev.ts } satisfies GameHandResolved);
        }
      }
    }
  }
}
