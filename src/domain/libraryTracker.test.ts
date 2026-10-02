import assert from "node:assert/strict";
import { LibraryTracker } from "./libraryTracker.js";

// Synthetic GRE messages shaped like the real captured ones (checked against
// data/raw-events.jsonl): library zones list instance ids top-first with no
// identities; own cards outside the library arrive as gameObjects with a
// grpId; a shuffle replaces every library id; a mulligan bottom is a "Put"
// that appends a card (with its grpId) at the END of the library.

const MY = 2;
const HAND = 35, LIB = 36, GY = 37, OPP_HAND = 31, OPP_LIB = 32, BF = 28, STACK = 27;

function zone(zoneId: number, type: string, ownerSeatId: number | null, ids: number[]) {
  return { zoneId, type, ownerSeatId, objectInstanceIds: ids };
}
function card(instanceId: number, grpId: number, zoneId: number, ownerSeatId = MY, type = "GameObjectType_Card", extra: Record<string, unknown> = {}) {
  return { instanceId, grpId, zoneId, ownerSeatId, type, ...extra };
}
function gre(messages: unknown[]) {
  return { greToClientEvent: { greToClientMessages: messages } };
}
function connect(deck: number[]) {
  return gre([{ type: "GREMessageType_ConnectResp", systemSeatIds: [MY], connectResp: { deckMessage: { deckCards: deck, sideboardCards: [] } } }]);
}
function gs(type: "Full" | "Diff", body: Record<string, unknown>) {
  return gre([{ type: "GREMessageType_GameStateMessage", systemSeatIds: [MY], gameStateMessage: { type: `GameStateType_${type}`, ...body } }]);
}

function pOf(t: LibraryTracker, grpId: number): number {
  return t.snapshot()!.entries.find((e) => e.grpId === grpId)!.pNext;
}
function leftOf(t: LibraryTracker, grpId: number): number {
  return t.snapshot()!.entries.find((e) => e.grpId === grpId)!.inLibrary;
}

function run() {
  // Deck: 10 cards - A x4, B x3, C x2, D x1. Library ids 101..110 (top first).
  const DECK = [1, 1, 1, 1, 2, 2, 2, 3, 3, 4];
  const libIds = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

  const t = new LibraryTracker();
  assert.equal(t.snapshot(), null, "nothing before a game");
  t.feed(connect(DECK));
  assert.equal(t.snapshot(), null, "nothing until game state arrives");
  t.feed(
    gs("Full", {
      zones: [zone(HAND, "ZoneType_Hand", MY, []), zone(LIB, "ZoneType_Library", MY, libIds), zone(OPP_LIB, "ZoneType_Library", 1, [201, 202]), zone(GY, "ZoneType_Graveyard", MY, [])],
    }),
  );
  let s = t.snapshot()!;
  assert.equal(s.libraryCount, 10);
  assert.equal(s.consistent, true);
  assert.ok(Math.abs(pOf(t, 1) - 0.4) < 1e-9, "4 of 10 are A");
  assert.ok(Math.abs(pOf(t, 4) - 0.1) < 1e-9);
  assert.equal(leftOf(t, 1), 4);

  // Draw two A and one C: hands show their identities.
  t.feed(
    gs("Diff", {
      zones: [zone(HAND, "ZoneType_Hand", MY, [101, 102, 103]), zone(LIB, "ZoneType_Library", MY, libIds.slice(3))],
      gameObjects: [card(101, 1, HAND), card(102, 1, HAND), card(103, 3, HAND)],
    }),
  );
  s = t.snapshot()!;
  assert.equal(s.libraryCount, 7);
  assert.equal(s.consistent, true);
  assert.equal(leftOf(t, 1), 2);
  assert.equal(leftOf(t, 3), 1);
  assert.ok(Math.abs(pOf(t, 1) - 2 / 7) < 1e-9);
  assert.ok(Math.abs(pOf(t, 2) - 3 / 7) < 1e-9);
  assert.ok(Math.abs(pOf(t, 3) - 1 / 7) < 1e-9);
  assert.ok(Math.abs(s.entries.reduce((a, e) => a + e.pNext, 0) - 1) < 1e-9, "probabilities sum to 1");

  // Put a drawn B... not drawn: bottom a KNOWN card (an A, as a London mulligan
  // does) - it is appended at the END with a visible identity.
  t.feed(
    gs("Diff", {
      zones: [zone(HAND, "ZoneType_Hand", MY, [102, 103]), zone(LIB, "ZoneType_Library", MY, [...libIds.slice(3), 101])],
      gameObjects: [card(101, 1, LIB)],
    }),
  );
  s = t.snapshot()!;
  assert.equal(s.libraryCount, 8);
  assert.deepEqual(s.knownBottom, [1], "the bottomed card's identity and position are known");
  assert.equal(leftOf(t, 1), 3, "it is still in the library");
  // Unknown slots: 7 (ids 104..110); unknown copies: A 2 (3 left - 1 known bottom), B 3, C 1, D 1.
  assert.ok(Math.abs(pOf(t, 1) - 2 / 7) < 1e-9, "known bottom card is excluded from the next-draw pool");
  assert.ok(Math.abs(pOf(t, 2) - 3 / 7) < 1e-9);
  assert.equal(s.consistent, true);

  // A shuffle gives every library card a fresh id and deletes the old ones:
  // the bottom card is anonymous again, so A is back to 3 of 8.
  const newIds = [301, 302, 303, 304, 305, 306, 307, 308];
  t.feed(
    gs("Diff", {
      zones: [zone(LIB, "ZoneType_Library", MY, newIds)],
      diffDeletedInstanceIds: [...libIds.slice(3), 101],
      annotations: [{ type: ["AnnotationType_Shuffle"], affectedIds: [MY], details: [] }],
    }),
  );
  s = t.snapshot()!;
  assert.deepEqual(s.knownBottom, [], "a shuffle forgets the known bottom");
  assert.equal(s.libraryCount, 8);
  assert.ok(Math.abs(pOf(t, 1) - 3 / 8) < 1e-9, "after the shuffle the old bottom card is random again");
  assert.equal(s.consistent, true);

  // A known card on TOP (e.g. revealed by a scry/look): certain next draw.
  t.feed(gs("Diff", { zones: [zone(LIB, "ZoneType_Library", MY, newIds)], gameObjects: [card(301, 4, LIB)] }));
  s = t.snapshot()!;
  assert.deepEqual(s.knownTop, [4]);
  assert.equal(pOf(t, 4), 1);
  assert.equal(pOf(t, 1), 0);

  // Opponent cards never count towards my library.
  t.feed(gs("Diff", { gameObjects: [card(401, 999, OPP_HAND, 1)], zones: [zone(OPP_HAND, "ZoneType_Hand", 1, [401])] }));
  assert.equal(t.snapshot()!.libraryCount, 8);

  // Casting an adventure: the stack object carries the ADVENTURE face's grpId;
  // the helper object's parentId links it to the decklist card (grpId 3).
  const t2 = new LibraryTracker();
  t2.feed(connect(DECK));
  t2.feed(gs("Full", { zones: [zone(HAND, "ZoneType_Hand", MY, []), zone(LIB, "ZoneType_Library", MY, libIds.slice(1)), zone(STACK, "ZoneType_Stack", null, [])] }));
  t2.feed(
    gs("Diff", {
      zones: [zone(HAND, "ZoneType_Hand", MY, [101])],
      gameObjects: [card(101, 3, HAND), card(85, 903, HAND, MY, "GameObjectType_Adventure", { parentId: 101 })],
    }),
  );
  t2.feed(gs("Diff", { zones: [zone(HAND, "ZoneType_Hand", MY, []), zone(STACK, "ZoneType_Stack", null, [150])], gameObjects: [card(150, 903, STACK)] }));
  const s2 = t2.snapshot()!;
  assert.equal(s2.consistent, true, "the adventure spell is the card 3, not a foreign card");
  assert.equal(s2.entries.find((e) => e.grpId === 3)!.inLibrary, 1);

  // A decklist that does not belong to this game (connect message missed):
  // several own cards outside the list => no confident numbers.
  const t3 = new LibraryTracker();
  t3.feed(connect([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]));
  t3.feed(
    gs("Full", {
      zones: [zone(HAND, "ZoneType_Hand", MY, [1, 2, 3, 4]), zone(LIB, "ZoneType_Library", MY, [10, 11, 12])],
      gameObjects: [card(1, 70, HAND), card(2, 71, HAND), card(3, 72, HAND), card(4, 73, HAND)],
    }),
  );
  assert.equal(t3.snapshot(), null);

  // Broadcast messages (seats [1, 2]) must not change who we are.
  const t4 = new LibraryTracker();
  t4.feed(connect(DECK));
  t4.feed(gre([{ type: "GREMessageType_DieRollResultsResp", systemSeatIds: [1, 2] }]));
  t4.feed(gs("Full", { zones: [zone(LIB, "ZoneType_Library", MY, libIds)] }));
  assert.equal(t4.snapshot()!.seat, MY);

  // Bo3: the opponent's cards are remembered across games of the same match.
  const OPP = 1;
  const BF2 = 28, OPP_GY = 33;
  const info = (gameNumber: number) => ({ gameInfo: { matchID: "match-1", gameNumber } });
  const t5 = new LibraryTracker();
  t5.feed(connect(DECK));
  t5.feed(gs("Full", { ...info(1), zones: [zone(LIB, "ZoneType_Library", MY, libIds), zone(BF2, "ZoneType_Battlefield", null, []), zone(OPP_GY, "ZoneType_Graveyard", OPP, [])] }));
  assert.equal(t5.opponentSnapshot(), null, "nothing seen yet");
  // Game 1: two copies of 500 on the battlefield, one 600 in the graveyard, plus a token and an ability that must be ignored.
  t5.feed(
    gs("Diff", {
      zones: [zone(BF2, "ZoneType_Battlefield", null, [501, 502, 503]), zone(OPP_GY, "ZoneType_Graveyard", OPP, [601])],
      gameObjects: [card(501, 500, BF2, OPP), card(502, 500, BF2, OPP), card(503, 700, BF2, OPP, "GameObjectType_Token"), card(601, 600, OPP_GY, OPP)],
    }),
  );
  let o = t5.opponentSnapshot()!;
  assert.equal(o.matchId, "match-1");
  assert.equal(o.hasEarlierGames, false);
  assert.deepEqual(
    o.entries.map((e) => [e.grpId, e.copies, e.seenThisGame]),
    [[500, 2, 2], [600, 1, 1]],
    "tokens ignored; copies counted by simultaneous visibility",
  );
  // A reconnect mid-game (Full state again, same game) must not double the counts.
  t5.feed(connect(DECK));
  t5.feed(
    gs("Full", {
      ...info(1),
      zones: [zone(LIB, "ZoneType_Library", MY, libIds), zone(BF2, "ZoneType_Battlefield", null, [511, 512]), zone(OPP_GY, "ZoneType_Graveyard", OPP, [])],
      gameObjects: [card(511, 500, BF2, OPP), card(512, 500, BF2, OPP)],
    }),
  );
  o = t5.opponentSnapshot()!;
  assert.equal(o.entries.find((e) => e.grpId === 500)!.copies, 2);
  // Game 2 of the same match: only one 500 so far; the earlier games' knowledge stays.
  t5.feed(connect(DECK));
  t5.feed(
    gs("Full", {
      ...info(2),
      zones: [zone(LIB, "ZoneType_Library", MY, libIds), zone(BF2, "ZoneType_Battlefield", null, [521]), zone(OPP_GY, "ZoneType_Graveyard", OPP, [])],
      gameObjects: [card(521, 500, BF2, OPP)],
    }),
  );
  o = t5.opponentSnapshot()!;
  assert.equal(o.gameNumber, 2);
  assert.equal(o.hasEarlierGames, true);
  const e500 = o.entries.find((e) => e.grpId === 500)!;
  assert.deepEqual([e500.copies, e500.seenThisGame], [2, 1]);
  const e600 = o.entries.find((e) => e.grpId === 600)!;
  assert.deepEqual([e600.copies, e600.seenThisGame], [1, 0], "seen before, not yet this game");
  assert.ok(o.entries[0].copies - o.entries[0].seenThisGame >= o.entries[o.entries.length - 1].copies - o.entries[o.entries.length - 1].seenThisGame);
  // A different match starts fresh.
  t5.feed(connect(DECK));
  t5.feed(gs("Full", { gameInfo: { matchID: "match-2", gameNumber: 1 }, zones: [zone(LIB, "ZoneType_Library", MY, libIds), zone(BF2, "ZoneType_Battlefield", null, [])] }));
  assert.equal(t5.opponentSnapshot(), null);

  console.log("libraryTracker tests passed");
}

run();
