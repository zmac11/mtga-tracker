// Coverage for deriveDeckColors (milestone 7 phase 3): the maindeck-colors ->
// combo-key derivation, including the splash-filtering threshold.

import assert from "node:assert/strict";
import { deriveDeckColors } from "./deckColors.js";

function run() {
  // Card catalog: grpId -> Arena-decoded colors.
  const cardColors = new Map<number, string[]>([
    [1, ["W"]], // Plains-adjacent white card
    [2, ["U"]],
    [3, ["R"]],
    [4, []], // colorless artifact/land
    [5, ["W", "U"]], // multicolor card contributes to both
  ]);

  // Mono-white deck with a single splashed red card - the splash shouldn't count.
  const monoWhiteWithSplash = deriveDeckColors(
    [
      { cardId: 1, quantity: 16 },
      { cardId: 4, quantity: 7 },
      { cardId: 3, quantity: 1 }, // one-off splash, below MIN_CARDS_FOR_COLOR
    ],
    cardColors,
  );
  assert.deepEqual(monoWhiteWithSplash.colors, ["W"]);
  assert.equal(monoWhiteWithSplash.comboKey, "Mono-W");
  assert.equal(monoWhiteWithSplash.cardCounts.R, 1); // tracked even though filtered out of colors/comboKey

  // A genuine two-color deck: both colors clear the threshold.
  const twoColor = deriveDeckColors(
    [
      { cardId: 1, quantity: 8 },
      { cardId: 2, quantity: 8 },
      { cardId: 5, quantity: 4 }, // multicolor card - contributes to both W and U counts
      { cardId: 4, quantity: 3 },
    ],
    cardColors,
  );
  assert.deepEqual(twoColor.colors, ["W", "U"]); // sorted WUBRG order regardless of input order
  assert.equal(twoColor.comboKey, "WU");

  // Fully colorless deck.
  const colorless = deriveDeckColors([{ cardId: 4, quantity: 23 }], cardColors);
  assert.deepEqual(colorless.colors, []);
  assert.equal(colorless.comboKey, "Colorless");

  // Cards missing from the catalog (e.g. cards table not refreshed) are treated as colorless, not thrown on.
  const unknownCards = deriveDeckColors([{ cardId: 999, quantity: 23 }], cardColors);
  assert.deepEqual(unknownCards.colors, []);
  assert.equal(unknownCards.comboKey, "Colorless");

  // A custom, lower threshold picks up the splash.
  const withLowerThreshold = deriveDeckColors(
    [
      { cardId: 1, quantity: 16 },
      { cardId: 3, quantity: 1 },
    ],
    cardColors,
    1,
  );
  assert.deepEqual(withLowerThreshold.colors, ["W", "R"]);
  assert.equal(withLowerThreshold.comboKey, "WR");

  console.log("OK: deriveDeckColors sums maindeck card colors, filters below-threshold splashes out of the combo, sorts WUBRG, and degrades gracefully for unknown cards.");
}

run();
