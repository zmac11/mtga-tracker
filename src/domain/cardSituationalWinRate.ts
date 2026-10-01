import type { CardPlayedInGame, GameHandResolved } from "./types.js";
import { winRateFromCounts, type WinRate } from "./rollups.js";
import type { EventFormat } from "./eventIdentity.js";

/**
 * Milestone 23 (features e/f, 2026-09-30 request): "win rate on cards based
 * on whether they were in the opening hand" (e) and "...whether they were
 * played during the match" (f), both split per format.
 *
 * Deliberately pure and Electron-free, same "pure domain layer, Electron
 * layer joins" split this project already uses elsewhere (e.g.
 * deckVersions.ts) - the caller is responsible for resolving, per game: the
 * format that was live (eventIdentity.ts's resolveEventFormat), which deck
 * was live (the matching DeckSubmitted), my own seat for that match
 * (MatchFound.players[].systemSeatId), and that game's own outcome
 * (rollups.ts's buildGameOutcomeIndex, for proper per-game Bo3 accuracy
 * rather than just the whole match's final result). Keeping that resolution
 * out of this module means it stays simple and testable with plain literal
 * fixtures, with no DB/store/Electron dependency of its own.
 *
 * "In opening hand" (e) only ever looks at GameHandResolved - the FINAL
 * kept/bottomed hand after any mulligan, per the user's own stated
 * definition choice, not the pre-mulligan deal. "Played" (f) looks at
 * CardPlayedInGame, which fires for ANY card leaving Hand during the game
 * (drawn-then-played included, not just an opening-hand card) - that's the
 * correct, broader reading of "played during the match" for (f), distinct
 * from (e)'s narrower "was it in the kept opening hand" reading. A card can
 * be played without ever being in the (e)-tracked opening hand (drawn
 * later), and a card can be in the opening hand without ever being played
 * (stuck in hand, or discarded rather than cast - CardPlayedInGame doesn't
 * distinguish the two, see its own doc comment in types.ts) - the two
 * buckets are independent, not one derived from the other.
 *
 * A card is counted at most once per game in each bucket regardless of how
 * many copies of it were drawn/played (GameHandResolved/CardPlayedInGame's
 * grpIds are deduped into a Set below) - this answers "did this card show
 * up" per game, not "how many copies showed up"; a deck running two copies
 * of a card gets one in-hand/played data point per game from this card,
 * same as a deck running one copy.
 */
export interface GameResultContext {
  matchId: string;
  gameNumber: number;
  /** My own seat for this match - same ID space as GameHandResolved/CardPlayedInGame's own `seat` field (confirmed via matchDetails.ts's existing systemSeatId/systemSeatNumber comparison). */
  mySeat: number;
  format: EventFormat;
  /** Every cardId in the deck that was live for this match (mainDeck + sideboard combined - cardId and grpId are the same ID space project-wide, see cardStore.ts/deckViewerLoader.ts). Defines the full universe of cards this game can report on, so a card that was never drawn still correctly counts toward "not in hand"/"not played" rather than being silently absent from the data. */
  deckCardIds: number[];
  outcome: "WIN" | "LOSS";
}

export interface CardSituationalWinRateRow {
  cardId: number;
  format: EventFormat;
  /** Win rate across games where this card was in my final kept (post-mulligan) opening hand. */
  inHand: WinRate;
  /** Win rate across games where it was not. */
  notInHand: WinRate;
  /** Win rate across games where this card left my Hand zone at some point (cast, played as a land, discarded, or otherwise - see CardPlayedInGame's own doc comment). */
  played: WinRate;
  /** Win rate across games where it never did. */
  notPlayed: WinRate;
}

interface Counts {
  inHandW: number;
  inHandL: number;
  notHandW: number;
  notHandL: number;
  playedW: number;
  playedL: number;
  notPlayedW: number;
  notPlayedL: number;
}

function freshCounts(): Counts {
  return { inHandW: 0, inHandL: 0, notHandW: 0, notHandL: 0, playedW: 0, playedL: 0, notPlayedW: 0, notPlayedL: 0 };
}

export function buildCardSituationalWinRateRows(
  games: GameResultContext[],
  handEvents: GameHandResolved[],
  playedEvents: CardPlayedInGame[],
): CardSituationalWinRateRow[] {
  const handByGame = new Map<string, Set<number>>(); // `${matchId}|${gameNumber}|${seat}` -> grpIds in the kept opening hand
  for (const h of handEvents) {
    if (h.gameNumber === null) continue; // capture gap (gameInfo.gameNumber never arrived) - can't key this game, so it can't be attributed
    handByGame.set(`${h.matchId}|${h.gameNumber}|${h.seat}`, new Set(h.grpIds));
  }

  const playedByGame = new Map<string, Set<number>>();
  for (const p of playedEvents) {
    if (p.gameNumber === null) continue;
    const key = `${p.matchId}|${p.gameNumber}|${p.seat}`;
    const set = playedByGame.get(key) ?? new Set<number>();
    set.add(p.grpId);
    playedByGame.set(key, set);
  }

  // Map<format, Map<cardId, Counts>> - nested rather than a single composite
  // string key, so the result-building pass below never has to parse a key
  // back apart.
  const byFormat = new Map<EventFormat, Map<number, Counts>>();

  for (const g of games) {
    const hand = handByGame.get(`${g.matchId}|${g.gameNumber}|${g.mySeat}`);
    if (!hand) continue; // no captured opening-hand data for this specific game - skip it entirely rather than guessing, same "missing data means absent, not zero" convention as buildMatchGameDetails
    const played = playedByGame.get(`${g.matchId}|${g.gameNumber}|${g.mySeat}`) ?? new Set<number>();
    const won = g.outcome === "WIN";

    let cardCounts = byFormat.get(g.format);
    if (!cardCounts) {
      cardCounts = new Map<number, Counts>();
      byFormat.set(g.format, cardCounts);
    }

    for (const cardId of g.deckCardIds) {
      let c = cardCounts.get(cardId);
      if (!c) {
        c = freshCounts();
        cardCounts.set(cardId, c);
      }
      if (hand.has(cardId)) {
        if (won) c.inHandW++;
        else c.inHandL++;
      } else {
        if (won) c.notHandW++;
        else c.notHandL++;
      }
      if (played.has(cardId)) {
        if (won) c.playedW++;
        else c.playedL++;
      } else {
        if (won) c.notPlayedW++;
        else c.notPlayedL++;
      }
    }
  }

  const rows: CardSituationalWinRateRow[] = [];
  for (const [format, cardCounts] of byFormat) {
    for (const [cardId, c] of cardCounts) {
      rows.push({
        cardId,
        format,
        inHand: winRateFromCounts(c.inHandW, c.inHandL),
        notInHand: winRateFromCounts(c.notHandW, c.notHandL),
        played: winRateFromCounts(c.playedW, c.playedL),
        notPlayed: winRateFromCounts(c.notPlayedW, c.notPlayedL),
      });
    }
  }
  return rows;
}
