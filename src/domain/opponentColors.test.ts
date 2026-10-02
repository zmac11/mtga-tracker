import assert from "node:assert/strict";
import { basicLandColor, inferOpponentColors, type OpponentColorCard } from "./opponentColors.js";

function run() {
  assert.equal(basicLandColor("Mountain"), "R");
  assert.equal(basicLandColor("Snow-Covered Island"), "U");
  assert.equal(basicLandColor("Cave of Embers"), null);

  const cards = new Map<number, OpponentColorCard>([
    [1, { name: "Mountain", colors: [], types: ["Land"] }],
    [2, { name: "Forest", colors: [], types: ["Land"] }],
    [3, { name: "Blue Wizard", colors: ["U"], types: ["Creature"] }],
    [4, { name: "Odd Land", colors: [], types: ["Land"] }],
    [5, { name: "Gold Card", colors: ["W", "B"], types: ["Creature"] }],
    [6, { name: "Artifact", colors: [], types: ["Artifact"] }],
  ]);
  const lookup = (g: number) => cards.get(g);

  assert.deepEqual(inferOpponentColors([], lookup), [], "nothing seen -> no colors");
  assert.deepEqual(inferOpponentColors([1, 2], lookup), ["R", "G"], "basic lands, in WUBRG order");
  assert.deepEqual(inferOpponentColors([4, 6], lookup), [], "non-basic lands and colorless cards say nothing");
  assert.deepEqual(inferOpponentColors([3, 5, 1], lookup), ["W", "U", "B", "R"], "spell colors count, multicolor adds each");
  assert.deepEqual(inferOpponentColors([99], lookup), [], "unknown cards are ignored");

  console.log("opponentColors tests passed");
}

run();
