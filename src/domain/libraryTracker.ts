/**
 * Live library tracking for the player's own deck: which cards of the
 * decklist can still be drawn, and how likely each is to be the next draw.
 *
 * Built from real captured Arena game logs (checked against ~70 recorded
 * games in data/raw-events.jsonl), not guessed. What Arena actually tells
 * the client:
 *
 *  - `connectResp.deckMessage.deckCards` - the exact list of grpIds (with
 *    repeats) the player is playing THIS game, so a Bo3 sideboard swap is
 *    reflected automatically.
 *  - Every GameStateMessage carries `zones`: whole-zone replacements, each
 *    with the zone's current `objectInstanceIds`. The library is listed IN
 *    ORDER (index 0 = top = next draw) for both seats, but its cards'
 *    identities are hidden: no `gameObjects` entry (hence no grpId) exists
 *    for an unrevealed library card. Library size is therefore exact.
 *  - Cards that left the library (drawn, milled, ...) show up as
 *    gameObjects with a grpId, owner seat and a zone membership.
 *  - A mulligan-bottomed card (ZoneTransfer category "Put", hand -> library)
 *    is appended at the END of the library list and - being the player's own
 *    card - arrives with its grpId. That is a card whose identity AND
 *    position are known.
 *  - A shuffle (AnnotationType_Shuffle, details OldIds/NewIds) replaces every
 *    library instance id with a fresh one and deletes the old ids
 *    (diffDeletedInstanceIds) - so every previously-known card in the library
 *    simply becomes unknown again, which is exactly the "bottom cards are
 *    random again after a shuffle" rule, with no special casing.
 *
 * So the model is: a library slot is "known" iff its instance id has a
 * gameObject with a grpId; everything else is drawn uniformly from
 * (decklist - own cards seen outside the library - known library cards).
 * Next-draw probability: if the top slot is known it is that card for
 * certain; otherwise unknownCopies(c) / unknownSlots. Known cards sitting
 * at the bottom therefore have 0% until they become the top slot.
 *
 * Deliberately Electron-free/DB-free like classifier.ts - just JSON in,
 * plain snapshot out - so it is unit-testable and replayable against the
 * raw capture. Not persisted: the library only matters live.
 */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Zones whose own-seat cards are definitely out of the library (still part of the deck, just not drawable). */
const OUT_OF_LIBRARY_ZONES = new Set([
  "ZoneType_Hand",
  "ZoneType_Battlefield",
  "ZoneType_Graveyard",
  "ZoneType_Exile",
  "ZoneType_Stack",
]);

/** This many own cards outside the decklist => the decklist is stale (see snapshot()). */
const DECK_MISMATCH_FOREIGN_CARDS = 3;

/** Zones where the opponent's cards are public to us (their hand and library never are). */
const OPPONENT_VISIBLE_ZONES = new Set(["ZoneType_Battlefield", "ZoneType_Graveyard", "ZoneType_Exile", "ZoneType_Stack"]);

/** Remember this many matches' worth of opponent cards (a long session is dozens of matches; nothing needs the old ones). */
const MAX_REMEMBERED_MATCHES = 12;

interface ZoneInfo {
  type: string;
  ownerSeat: number | null;
  ids: number[];
}

interface ObjectInfo {
  grpId: number;
  ownerSeat: number | null;
  type: string;
  /** Set on an Adventure-face helper object: the instance id of the real card it belongs to. */
  parentId: number | null;
}

export interface LibraryCardEntry {
  grpId: number;
  /** Copies of this card in the deck this game. */
  deckCount: number;
  /** Copies still in the library (includes known-position ones, e.g. one bottomed by a mulligan). */
  inLibrary: number;
  /** Probability that the NEXT card drawn is this one (0..1). */
  pNext: number;
}

export interface LibrarySnapshot {
  /** The player's own seat this snapshot describes. */
  seat: number;
  /** Cards currently in the library (exact - Arena reports it). */
  libraryCount: number;
  /** One entry per distinct card in the deck, in first-seen decklist order. */
  entries: LibraryCardEntry[];
  /** Library slots whose card is known and sit at the very top, in draw order (e.g. after revealing/scrying to the top). */
  knownTop: number[];
  /** Known cards at the very bottom, top-to-bottom (e.g. a London-mulligan bottom). Forgotten again by a shuffle. */
  knownBottom: number[];
  /** False when the bookkeeping disagrees with Arena's own library size (e.g. a token/copy was miscounted); numbers are then best-effort. */
  consistent: boolean;
}

export interface OpponentCardEntry {
  grpId: number;
  /** Most copies of this card the opponent is known to run: the best showing in any single game of this match so far. */
  copies: number;
  /** Copies already shown in the CURRENT game. */
  seenThisGame: number;
}

export interface OpponentCardsSnapshot {
  matchId: string | null;
  /** The game being played (1-based), when Arena has said. */
  gameNumber: number | null;
  /** Every distinct card the opponent has shown this match, most-still-to-come first. */
  entries: OpponentCardEntry[];
  /** True when at least one EARLIER game of this match contributed (i.e. this is Bo3 game 2/3 and there is real history). */
  hasEarlierGames: boolean;
}

export class LibraryTracker {
  private mySeat: number | null = null;
  private deck = new Map<number, number>(); // grpId -> copies in this game's deck
  private deckOrder: number[] = [];
  private zones = new Map<number, ZoneInfo>();
  private objects = new Map<number, ObjectInfo>();
  /**
   * grpId of a card's other face -> the grpId the decklist uses. Seen in real
   * data for adventures: casting the adventure puts a "Card" on the stack
   * carrying the ADVENTURE's grpId (e.g. 103450), while the decklist (and
   * the card in hand/library) uses the creature's (103449). The two are
   * linked by a GameObjectType_Adventure helper object whose `parentId` is
   * the real card's instance id. Learned as those helpers are seen; the
   * mapping is a fact about the cards, so it is kept across games.
   */
  private faceToDeckGrpId = new Map<number, number>();
  /** matchId -> gameNumber -> grpId -> most copies of the opponent's card visible at once in that game. Survives reconnects/resets: it is match memory, not game state. */
  private opponentByMatch = new Map<string, Map<number, Map<number, number>>>();
  private currentMatchId: string | null = null;
  private currentGameNumber: number | null = null;
  /** How many game connections (connect messages) have been seen - a change means a new game began. */
  connectCount = 0;
  /** True once a game's state has arrived after the last reset - gates the snapshot. */
  private active = false;

  /** Feed one captured JSON block (the same `json` the classifier gets). Returns true if library-relevant state changed. */
  feed(json: unknown): boolean {
    if (!isObj(json)) return false;
    const gre = json.greToClientEvent;
    if (!isObj(gre) || !Array.isArray(gre.greToClientMessages)) return false;
    let changed = false;
    for (const msg of gre.greToClientMessages) {
      if (!isObj(msg)) continue;
      // Messages addressed to ONE seat tell us who we are; broadcast ones
      // (e.g. DieRollResultsResp, seats [1, 2]) say nothing about that.
      if (Array.isArray(msg.systemSeatIds) && msg.systemSeatIds.length === 1 && typeof msg.systemSeatIds[0] === "number") {
        const seat = msg.systemSeatIds[0];
        if (this.mySeat !== seat) {
          this.mySeat = seat;
          changed = true;
        }
      }
      if (isObj(msg.connectResp)) {
        this.onConnect(msg.connectResp);
        changed = true;
      }
      if (isObj(msg.gameStateMessage)) {
        this.onGameState(msg.gameStateMessage);
        changed = true;
      }
    }
    return changed;
  }

  private onConnect(connect: Record<string, unknown>): void {
    this.connectCount++;
    const dm = isObj(connect.deckMessage) ? connect.deckMessage : null;
    const cards = dm && Array.isArray(dm.deckCards) ? dm.deckCards : [];
    this.deck.clear();
    this.deckOrder = [];
    for (const raw of cards) {
      const grpId = Number(raw);
      if (!Number.isFinite(grpId)) continue;
      if (!this.deck.has(grpId)) this.deckOrder.push(grpId);
      this.deck.set(grpId, (this.deck.get(grpId) ?? 0) + 1);
    }
    // A (re)connect is always followed by a fresh Full game state; start clean.
    this.zones.clear();
    this.objects.clear();
    this.active = false;
  }

  private onGameState(gsm: Record<string, unknown>): void {
    if (gsm.type === "GameStateType_Full") {
      this.zones.clear();
      this.objects.clear();
    }
    if (Array.isArray(gsm.zones)) {
      for (const z of gsm.zones) {
        if (!isObj(z) || typeof z.zoneId !== "number") continue;
        this.zones.set(z.zoneId, {
          type: String(z.type ?? ""),
          ownerSeat: typeof z.ownerSeatId === "number" ? z.ownerSeatId : null,
          ids: Array.isArray(z.objectInstanceIds) ? z.objectInstanceIds.map(Number) : [],
        });
      }
    }
    if (Array.isArray(gsm.gameObjects)) {
      for (const o of gsm.gameObjects) {
        if (!isObj(o) || typeof o.instanceId !== "number") continue;
        this.objects.set(o.instanceId, {
          grpId: Number(o.grpId),
          ownerSeat: typeof o.ownerSeatId === "number" ? o.ownerSeatId : null,
          type: String(o.type ?? ""),
          parentId: typeof o.parentId === "number" ? o.parentId : null,
        });
      }
      for (const o of gsm.gameObjects) {
        if (!isObj(o) || o.type !== "GameObjectType_Adventure" || typeof o.parentId !== "number") continue;
        const parent = this.objects.get(o.parentId);
        if (parent && parent.grpId > 0 && Number(o.grpId) > 0 && parent.grpId !== Number(o.grpId)) {
          this.faceToDeckGrpId.set(Number(o.grpId), parent.grpId);
        }
      }
    }
    // A card that changes zones gets a new instance id; the old one lingers
    // in Limbo. Forget it so the card is not counted twice.
    if (Array.isArray(gsm.annotations)) {
      for (const a of gsm.annotations) {
        if (!isObj(a) || !Array.isArray(a.type) || !a.type.includes("AnnotationType_ObjectIdChanged")) continue;
        const details = Array.isArray(a.details) ? a.details : [];
        for (const d of details) {
          if (isObj(d) && d.key === "orig_id" && Array.isArray(d.valueInt32) && typeof d.valueInt32[0] === "number") {
            this.objects.delete(d.valueInt32[0]);
          }
        }
      }
    }
    if (Array.isArray(gsm.diffDeletedInstanceIds)) {
      for (const id of gsm.diffDeletedInstanceIds) this.objects.delete(Number(id));
    }
    if (this.zones.size > 0) this.active = true;

    const info = isObj(gsm.gameInfo) ? gsm.gameInfo : null;
    if (info) {
      if (typeof info.matchID === "string") this.currentMatchId = info.matchID;
      if (typeof info.gameNumber === "number") this.currentGameNumber = info.gameNumber;
    }
    this.recordOpponentCards();
  }

  /**
   * The opponent's hand and library are hidden, so what we learn about their
   * deck is the cards that reach a public zone. A physical card sits in one
   * zone at a time, so the number of distinct opponent cards of a grpId that
   * are visible AT ONCE is a lower bound on the copies they run; the best such
   * count over a game is remembered per game. (Instance ids change on every
   * zone move, so counting ids over time would count one card many times.)
   */
  private recordOpponentCards(): void {
    if (this.mySeat === null) return;
    const now = new Map<number, number>();
    for (const z of this.zones.values()) {
      if (!OPPONENT_VISIBLE_ZONES.has(z.type)) continue;
      for (const id of z.ids) {
        const o = this.objects.get(id);
        if (!o || o.ownerSeat === null || o.ownerSeat === this.mySeat || o.type !== "GameObjectType_Card" || !(o.grpId > 0)) continue;
        const grpId = this.toDeckGrpId(o.grpId);
        now.set(grpId, (now.get(grpId) ?? 0) + 1);
      }
    }
    if (now.size === 0) return;
    const matchKey = this.currentMatchId ?? "unknown";
    let games = this.opponentByMatch.get(matchKey);
    if (!games) {
      games = new Map();
      this.opponentByMatch.set(matchKey, games);
      while (this.opponentByMatch.size > MAX_REMEMBERED_MATCHES) {
        const oldest = this.opponentByMatch.keys().next().value;
        if (oldest === undefined) break;
        this.opponentByMatch.delete(oldest);
      }
    }
    const gameKey = this.currentGameNumber ?? 1;
    let best = games.get(gameKey);
    if (!best) {
      best = new Map();
      games.set(gameKey, best);
    }
    for (const [grpId, n] of now) if (n > (best.get(grpId) ?? 0)) best.set(grpId, n);
  }

  /** What the opponent has shown this match, for the current game's "what could they still play" list; null before any is known. */
  opponentSnapshot(): OpponentCardsSnapshot | null {
    if (!this.active) return null;
    const games = this.opponentByMatch.get(this.currentMatchId ?? "unknown");
    if (!games || games.size === 0) return null;
    const current = this.currentGameNumber ?? 1;
    const copies = new Map<number, number>();
    let hasEarlierGames = false;
    for (const [gameNumber, cards] of games) {
      if (gameNumber < current) hasEarlierGames = true;
      for (const [grpId, n] of cards) if (n > (copies.get(grpId) ?? 0)) copies.set(grpId, n);
    }
    const thisGame = games.get(current);
    const entries: OpponentCardEntry[] = [...copies].map(([grpId, n]) => ({ grpId, copies: n, seenThisGame: thisGame?.get(grpId) ?? 0 }));
    // Cards that could still show up first (most unseen copies), then the ones already out.
    entries.sort((a, b) => b.copies - b.seenThisGame - (a.copies - a.seenThisGame) || b.copies - a.copies || a.grpId - b.grpId);
    return { matchId: this.currentMatchId, gameNumber: this.currentGameNumber, entries, hasEarlierGames };
  }

  private toDeckGrpId(grpId: number): number {
    return this.faceToDeckGrpId.get(grpId) ?? grpId;
  }

  /** Current library state for the player's own deck, or null until a game is under way and the deck is known. */
  snapshot(): LibrarySnapshot | null {
    if (!this.active || this.mySeat === null || this.deck.size === 0) return null;
    const mySeat = this.mySeat;

    let library: ZoneInfo | null = null;
    for (const z of this.zones.values()) {
      if (z.type === "ZoneType_Library" && z.ownerSeat === mySeat) library = z;
    }
    if (!library) return null;

    // Own cards seen outside the library, by grpId. Membership comes from the
    // zone lists (authoritative); an object not listed in any zone (an
    // adventure-face helper, a Limbo leftover) is not a card in play.
    const outCounts = new Map<number, number>();
    let foreignCards = 0; // own cards that are not in the decklist we hold
    for (const z of this.zones.values()) {
      if (!OUT_OF_LIBRARY_ZONES.has(z.type)) continue;
      for (const id of z.ids) {
        const o = this.objects.get(id);
        if (!o || o.ownerSeat !== mySeat || o.type !== "GameObjectType_Card" || !(o.grpId > 0)) continue;
        const grpId = this.toDeckGrpId(o.grpId);
        if (!this.deck.has(grpId)) {
          foreignCards++;
          continue;
        }
        outCounts.set(grpId, (outCounts.get(grpId) ?? 0) + 1);
      }
    }

    // Limbo is a mix of stale previous incarnations of cards that moved on (an
    // ObjectIdChanged annotation usually, but not always, retires those) and
    // cards genuinely in transit (e.g. a spell mid-resolution). It cannot be
    // told apart per card, so it is only used to explain a shortfall below.
    const limboCounts = new Map<number, number>();
    for (const z of this.zones.values()) {
      if (z.type !== "ZoneType_Limbo") continue;
      for (const id of z.ids) {
        const o = this.objects.get(id);
        if (!o || o.ownerSeat !== mySeat || o.type !== "GameObjectType_Card" || !(o.grpId > 0)) continue;
        const grpId = this.toDeckGrpId(o.grpId);
        if (this.deck.has(grpId)) limboCounts.set(grpId, (limboCounts.get(grpId) ?? 0) + 1);
      }
    }

    // A few foreign cards are normal (Alchemy conjures, a face we have not
    // learned the mapping for). Several means the decklist we hold belongs to
    // a different game - the capture missed this game's connect message (the
    // tracker started mid-match, or a log gap) - so say nothing rather than
    // show confident wrong numbers.
    if (foreignCards >= DECK_MISMATCH_FOREIGN_CARDS) return null;

    // Library slots, top first; a slot is known iff its object carries a grpId.
    const slots: Array<number | null> = library.ids.map((id) => {
      const o = this.objects.get(id);
      return o && o.type === "GameObjectType_Card" && o.grpId > 0 ? this.toDeckGrpId(o.grpId) : null;
    });
    const knownInLibrary = new Map<number, number>();
    let unknownSlots = 0;
    for (const g of slots) {
      if (g === null) unknownSlots++;
      else knownInLibrary.set(g, (knownInLibrary.get(g) ?? 0) + 1);
    }

    const knownTop: number[] = [];
    for (const g of slots) {
      if (g === null) break;
      knownTop.push(g);
    }
    const knownBottom: number[] = [];
    if (knownTop.length < slots.length) {
      for (let i = slots.length - 1; i >= 0; i--) {
        const g = slots[i];
        if (g === null) break;
        knownBottom.unshift(g);
      }
    }

    // Arena reports the library size exactly, so the number of cards that must
    // be outside it is known: deckSize - librarySize. If we identified fewer
    // (a card in transit that is only visible in Limbo), and the Limbo
    // candidates account for exactly that shortfall, they are the missing ones.
    let deckSize = 0;
    for (const n of this.deck.values()) deckSize += n;
    let identifiedOut = 0;
    for (const n of outCounts.values()) identifiedOut += n;
    const shortfall = deckSize - slots.length - identifiedOut;
    if (shortfall > 0) {
      const candidates = new Map<number, number>();
      let candidateTotal = 0;
      for (const [grpId, n] of limboCounts) {
        const room = (this.deck.get(grpId) ?? 0) - (outCounts.get(grpId) ?? 0) - (knownInLibrary.get(grpId) ?? 0);
        const take = Math.min(n, Math.max(0, room));
        if (take > 0) {
          candidates.set(grpId, take);
          candidateTotal += take;
        }
      }
      if (candidateTotal === shortfall) {
        for (const [grpId, take] of candidates) outCounts.set(grpId, (outCounts.get(grpId) ?? 0) + take);
      }
    }

    const unknownCopies = new Map<number, number>();
    let unknownTotal = 0;
    const entries: LibraryCardEntry[] = [];
    for (const grpId of this.deckOrder) {
      const deckCount = this.deck.get(grpId) ?? 0;
      const out = outCounts.get(grpId) ?? 0;
      const inLibrary = Math.max(0, deckCount - out);
      const unknown = Math.max(0, deckCount - out - (knownInLibrary.get(grpId) ?? 0));
      unknownCopies.set(grpId, unknown);
      unknownTotal += unknown;
      entries.push({ grpId, deckCount, inLibrary, pNext: 0 });
    }

    const topKnownCard = slots.length > 0 ? slots[0] : null;
    for (const e of entries) {
      if (slots.length === 0) e.pNext = 0;
      else if (topKnownCard !== null) e.pNext = e.grpId === topKnownCard ? 1 : 0;
      // Normalised by the candidate copies, not the slot count: identical when
      // the books balance, and still a proper distribution when a card in
      // transit has not been identified (it is then spread over the candidates).
      else e.pNext = unknownTotal > 0 ? (unknownCopies.get(e.grpId) ?? 0) / unknownTotal : 0;
    }

    return {
      seat: mySeat,
      libraryCount: slots.length,
      entries,
      knownTop,
      knownBottom,
      consistent: unknownTotal === unknownSlots,
    };
  }
}
