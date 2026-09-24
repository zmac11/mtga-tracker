import type {
  DomainEvent,
  DraftPickMade,
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

  private classifyDraftPick(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventPlayerDraftMakePick") return;

    if (ev.direction === "request") {
      const req = tryParseJSON(json.request);
      if (!isObj(req) || typeof req.DraftId !== "string" || !Array.isArray(req.GrpIds)) return;
      this.currentDraftId = req.DraftId;
      const pick: DraftPickMade = {
        kind: "DraftPickMade",
        draftId: req.DraftId,
        pack: Number(req.Pack),
        pick: Number(req.Pick),
        grpId: Number(req.GrpIds[0]),
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
   */
  private classifyBotDraftPick(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "BotDraftDraftPick") return;

    if (ev.direction === "request") {
      const req = tryParseJSON(json.request);
      const pickInfo = isObj(req) ? req.PickInfo : undefined;
      if (!isObj(req) || typeof req.EventName !== "string" || !isObj(pickInfo) || !Array.isArray(pickInfo.CardIds)) return;
      this.currentDraftId = req.EventName;
      const pick: DraftPickMade = {
        kind: "DraftPickMade",
        draftId: req.EventName,
        pack: Number(pickInfo.PackNumber ?? 0) + 1,
        pick: Number(pickInfo.PickNumber ?? 0) + 1,
        grpId: Number(pickInfo.CardIds[0]),
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

  private classifyDeckSubmitted(ev: ClassifiableEvent, json: Record<string, unknown>, out: DomainEvent[]) {
    if (ev.method !== "EventSetDeckV3" || ev.direction !== "response") return;
    if (typeof json.InternalEventName !== "string") return;
    const summary = json.CourseDeckSummary;
    const deck = json.CourseDeck;
    if (!isObj(summary) || !isObj(deck) || !Array.isArray(deck.MainDeck)) return;
    out.push({
      kind: "DeckSubmitted",
      eventName: json.InternalEventName,
      deckId: String(summary.DeckId ?? ""),
      deckName: String(summary.Name ?? ""),
      mainDeck: deck.MainDeck.map((c: any) => ({ cardId: Number(c.cardId), quantity: Number(c.quantity) })),
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

    for (const course of json.Courses) {
      if (!isObj(course)) continue;
      if (typeof course.InternalEventName !== "string" || typeof course.CourseId !== "string") continue;
      const deckSummary = course.CourseDeckSummary;
      out.push({
        kind: "CourseStanding",
        eventId: course.InternalEventName,
        courseId: course.CourseId,
        wins: Number(course.CurrentWins ?? 0),
        losses: Number(course.CurrentLosses ?? 0),
        currentModule: typeof course.CurrentModule === "string" ? course.CurrentModule : null,
        deckName: isObj(deckSummary) && typeof deckSummary.Name === "string" ? deckSummary.Name : null,
        ts: ev.ts,
      });
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
          }))
        : [];
      const turnInfo = isObj(gsm.turnInfo) ? gsm.turnInfo : null;

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
}
