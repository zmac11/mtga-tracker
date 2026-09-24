// Coverage for manaValue/groupByManaCurve (milestone 7 phase 4).

import assert from "node:assert/strict";
import { manaValue, groupByManaCurve, type CardCurveInfo } from "./manaCurve.js";

function run() {
  // --- manaValue ---
  assert.equal(manaValue("{2}{U}{U}"), 4);
  assert.equal(manaValue("{W}"), 1);
  assert.equal(manaValue("{0}"), 0);
  assert.equal(manaValue("{X}{R}"), 1); // X counts as 0
  assert.equal(manaValue("{W/U}{B/P}"), 2); // hybrid/Phyrexian pips count as 1 each
  assert.equal(manaValue(""), 0);
  assert.equal(manaValue("{10}"), 10);

  // --- groupByManaCurve ---
  const cardInfo = new Map<number, CardCurveInfo>();
  cardInfo.set(1, { types: ["Creature"], manaCost: "{1}{W}" }); // cmc 2, creature
  cardInfo.set(2, { types: ["Instant"], manaCost: "{U}" }); // cmc 1, non-creature
  cardInfo.set(3, { types: ["Creature"], manaCost: "{1}{W}" }); // same bucket as card 1
  cardInfo.set(4, { types: ["Land"], manaCost: null });
  cardInfo.set(5, { types: ["Creature"], manaCost: null }); // no Scryfall data - unknown cost, but still counts as creature
  cardInfo.set(6, { types: ["Sorcery"], manaCost: "{8}" }); // cmc 8 -> "7+" bucket

  const mainDeck = [
    { cardId: 1, quantity: 2 },
    { cardId: 2, quantity: 3 },
    { cardId: 3, quantity: 1 },
    { cardId: 4, quantity: 17 }, // lands
    { cardId: 5, quantity: 1 },
    { cardId: 6, quantity: 1 },
    { cardId: 999, quantity: 1 }, // not in cardInfo at all - unknown cost, non-creature
  ];

  const buckets = groupByManaCurve(mainDeck, cardInfo);
  const byLabel = new Map(buckets.map((b) => [b.label, b]));

  // Order: low-to-high cost, then Land, then Unknown cost.
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["1", "2", "7+", "Land", "Unknown cost"],
  );

  const bucket2 = byLabel.get("2")!;
  assert.equal(bucket2.creatureCount, 3); // 2 + 1 from cards 1 and 3
  assert.equal(bucket2.nonCreatureCount, 0);

  const bucket1 = byLabel.get("1")!;
  assert.equal(bucket1.nonCreatureCount, 3);

  const land = byLabel.get("Land")!;
  assert.equal(land.creatureCount, 0);
  assert.equal(land.nonCreatureCount, 17);

  const unknown = byLabel.get("Unknown cost")!;
  assert.equal(unknown.creatureCount, 1); // card 5 - no manaCost, but Arena's own types still says Creature
  assert.equal(unknown.nonCreatureCount, 1); // card 999 - entirely unknown card

  console.log("OK: manaValue parses Scryfall mana-cost strings (including X and hybrid pips), and groupByManaCurve buckets by cost while classifying creature/non-creature from Arena's own types regardless of Scryfall data availability.");
}

run();
