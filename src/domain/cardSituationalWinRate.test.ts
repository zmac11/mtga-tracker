// Milestone 23 (features e/f): buildCardSituationalWinRateRows coverage.
// Pure literal fixtures throughout - no real captured data needed, since
// this module takes already-resolved GameResultContext from its caller
// (see its own doc comment) rather than deriving anything from raw events
// itself.

import assert from "node:assert/strict";
import { buildCardSituationalWinRateRows, type GameResultContext } from "./cardSituationalWinRate.js";
import type { GameHandResolved, CardPlayedInGame } from "./types.js";

function hand(matchId: string, gameNumber: number, seat: number, grpIds: number[]): GameHandResolved {
  return { kind: "GameHandResolved", matchId, gameNumber, seat, grpIds, ts: `${matchId}-h${gameNumber}` };
}
function played(matchId: string, gameNumber: number, seat: number, grpId: number): CardPlayedInGame {
  return { kind: "CardPlayedInGame", matchId, gameNumber, seat, grpId, ts: `${matchId}-p${gameNumber}-${grpId}` };
}

function run() {
  // Game 1 (WIN, Draft): hand has card 100 (not 200); played 100 only.
  // Game 2 (LOSS, Draft): hand has 200 (not 100); nothing played.
  // Deck for both games: [100, 200].
  const games: GameResultContext[] = [
    { matchId: "m1", gameNumber: 1, mySeat: 1, format: "Draft", deckCardIds: [100, 200], outcome: "WIN" },
    { matchId: "m1", gameNumber: 2, mySeat: 1, format: "Draft", deckCardIds: [100, 200], outcome: "LOSS" },
  ];
  const handEvents: GameHandResolved[] = [hand("m1", 1, 1, [100]), hand("m1", 2, 1, [200])];
  const playedEvents: CardPlayedInGame[] = [played("m1", 1, 1, 100)];

  const rows = buildCardSituationalWinRateRows(games, handEvents, playedEvents);
  assert.equal(rows.length, 2);

  const row100 = rows.find((r) => r.cardId === 100)!;
  assert.equal(row100.format, "Draft");
  assert.deepEqual(row100.inHand, { wins: 1, losses: 0, total: 1, pct: "100%" }); // card 100 in hand only in game 1 (WIN)
  assert.deepEqual(row100.notInHand, { wins: 0, losses: 1, total: 1, pct: "0%" }); // not in hand in game 2 (LOSS)
  assert.deepEqual(row100.played, { wins: 1, losses: 0, total: 1, pct: "100%" }); // played only in game 1 (WIN)
  assert.deepEqual(row100.notPlayed, { wins: 0, losses: 1, total: 1, pct: "0%" }); // not played in game 2 (LOSS)

  const row200 = rows.find((r) => r.cardId === 200)!;
  assert.deepEqual(row200.inHand, { wins: 0, losses: 1, total: 1, pct: "0%" }); // in hand only in game 2 (LOSS)
  assert.deepEqual(row200.notInHand, { wins: 1, losses: 0, total: 1, pct: "100%" }); // not in hand in game 1 (WIN)
  // Card 200 was never played in either game (not in playedEvents at all) - should be "not played" in BOTH games, not silently missing.
  assert.deepEqual(row200.played, { wins: 0, losses: 0, total: 0, pct: "-" });
  assert.deepEqual(row200.notPlayed, { wins: 1, losses: 1, total: 2, pct: "50%" });

  console.log("OK: basic in-hand/not-in-hand and played/not-played bucketing, including a deck card that was drawn but never played staying correctly in the not-played bucket for every game rather than being omitted.");
}

function runFormatSeparation() {
  // The same cardId (300) appears in decks from two different formats -
  // its Draft performance and its Constructed performance must stay in
  // separate rows, never merged.
  const games: GameResultContext[] = [
    { matchId: "d1", gameNumber: 1, mySeat: 1, format: "Draft", deckCardIds: [300], outcome: "WIN" },
    { matchId: "c1", gameNumber: 1, mySeat: 2, format: "Constructed", deckCardIds: [300], outcome: "LOSS" },
  ];
  const handEvents: GameHandResolved[] = [hand("d1", 1, 1, [300]), hand("c1", 1, 2, [300])];
  const rows = buildCardSituationalWinRateRows(games, handEvents, []);

  assert.equal(rows.length, 2);
  const draftRow = rows.find((r) => r.format === "Draft")!;
  const constructedRow = rows.find((r) => r.format === "Constructed")!;
  assert.equal(draftRow.cardId, 300);
  assert.equal(constructedRow.cardId, 300);
  assert.deepEqual(draftRow.inHand, { wins: 1, losses: 0, total: 1, pct: "100%" });
  assert.deepEqual(constructedRow.inHand, { wins: 0, losses: 1, total: 1, pct: "0%" });

  console.log("OK: the same cardId across two formats produces two independent rows, never merged into one.");
}

function runMissingHandDataSkipped() {
  // A match/game with NO GameHandResolved at all (e.g. the capture started
  // mid-game, or the match never got past a draw-screen before ending) is
  // skipped entirely for that game - it must not be silently counted as
  // "not in hand" for every card, which would be a fabricated data point.
  const games: GameResultContext[] = [
    { matchId: "nodata", gameNumber: 1, mySeat: 1, format: "Draft", deckCardIds: [400], outcome: "WIN" },
  ];
  const rows = buildCardSituationalWinRateRows(games, [], []);
  assert.equal(rows.length, 0, "a game with no captured hand data contributes nothing at all, not a fabricated 'not in hand' data point");

  console.log("OK: a game with no captured GameHandResolved is skipped entirely rather than being counted as a false 'not in hand' data point.");
}

function runMultipleGamesSameMatch() {
  // A single Bo3 match (same matchId) with three games - each game's own
  // outcome (not just the match's final result) must be used per-game,
  // exactly what rollups.ts's buildGameOutcomeIndex exists to resolve for
  // the caller (this module just trusts whatever outcome it's given per
  // GameResultContext).
  const games: GameResultContext[] = [
    { matchId: "bo3", gameNumber: 1, mySeat: 1, format: "Draft", deckCardIds: [500], outcome: "LOSS" },
    { matchId: "bo3", gameNumber: 2, mySeat: 1, format: "Draft", deckCardIds: [500], outcome: "WIN" },
    { matchId: "bo3", gameNumber: 3, mySeat: 1, format: "Draft", deckCardIds: [500], outcome: "WIN" },
  ];
  const handEvents: GameHandResolved[] = [hand("bo3", 1, 1, [500]), hand("bo3", 2, 1, [500]), hand("bo3", 3, 1, [])];
  const rows = buildCardSituationalWinRateRows(games, handEvents, []);
  const row = rows.find((r) => r.cardId === 500)!;
  // In hand in games 1 (LOSS) and 2 (WIN); not in hand in game 3 (WIN).
  assert.deepEqual(row.inHand, { wins: 1, losses: 1, total: 2, pct: "50%" });
  assert.deepEqual(row.notInHand, { wins: 1, losses: 0, total: 1, pct: "100%" });

  console.log("OK: multiple games within one Bo3 match are each attributed their own per-game outcome, not the match's single final result.");
}

run();
runFormatSeparation();
runMissingHandDataSkipped();
runMultipleGamesSameMatch();
