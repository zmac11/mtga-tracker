// Coverage for buildArenaImportText (milestone 22).

import assert from "node:assert/strict";
import { buildArenaImportText, type ArenaExportCard, type ArenaExportCardInfo } from "./arenaExport.js";

function run() {
  const lookup = new Map<number, ArenaExportCardInfo>([
    [1, { setCode: "WOE", collectorNumber: "123" }],
    [2, { setCode: "WOE", collectorNumber: "45" }],
    [3, { setCode: "MOM", collectorNumber: "6" }],
    // 4 is intentionally absent from the lookup.
  ]);

  const mainDeck: ArenaExportCard[] = [
    { cardId: 1, quantity: 4, name: "Bothersome Noisemaker" },
    { cardId: 2, quantity: 17, name: "Island" },
    { cardId: 4, quantity: 1, name: "Not In Catalog" },
  ];

  // No sideboard at all (null, e.g. not captured) - no "Sideboard" section.
  const noSideboard = buildArenaImportText(mainDeck, null, lookup);
  assert.equal(
    noSideboard,
    ["Deck", "4 Bothersome Noisemaker (WOE) 123", "17 Island (WOE) 45"].join("\n"),
  );
  assert.ok(!noSideboard.includes("Sideboard"));
  // The card missing from the lookup is silently skipped, not thrown on.
  assert.ok(!noSideboard.includes("Not In Catalog"));

  // Empty sideboard array (captured but genuinely empty) also omits the section.
  const emptySideboard = buildArenaImportText(mainDeck, [], lookup);
  assert.ok(!emptySideboard.includes("Sideboard"));

  // A real, non-empty sideboard gets its own blank-line-separated section.
  const sideboard: ArenaExportCard[] = [{ cardId: 3, quantity: 2, name: "Negate" }];
  const withSideboard = buildArenaImportText(mainDeck, sideboard, lookup);
  assert.equal(
    withSideboard,
    ["Deck", "4 Bothersome Noisemaker (WOE) 123", "17 Island (WOE) 45", "", "Sideboard", "2 Negate (MOM) 6"].join("\n"),
  );

  console.log("OK: buildArenaImportText renders Arena's clipboard-import format (qty, name, set code, collector number), omits the Sideboard section when there's no sideboard or it's empty, includes it with a blank-line separator when non-empty, and silently skips a card missing from the lookup instead of throwing.");
}

run();
