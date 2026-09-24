// Coverage for decodeArenaColors (milestone 7 phase 3) - the confirmed
// mapping from Arena's own comma-separated Cards.Colors integers to WUBRG
// letters (1=White, 2=Blue, 3=Black, 4=Red, 5=Green - verified 2026-09-24
// against the real sample card database via the Enums table, including that
// basic lands correctly come back colorless). extractArenaCards() itself
// needs a real Raw_CardDatabase_*.mtga file to run against and isn't
// exercised here - see refreshCards.ts's own real-data validation.

import assert from "node:assert/strict";
import { decodeArenaColors } from "./extractArenaCards.js";

function run() {
  assert.deepEqual(decodeArenaColors(null), [], "null -> colorless");
  assert.deepEqual(decodeArenaColors(""), [], "empty string -> colorless (basic lands)");
  assert.deepEqual(decodeArenaColors("1"), ["W"]);
  assert.deepEqual(decodeArenaColors("3"), ["B"]);
  assert.deepEqual(decodeArenaColors("4,5"), ["R", "G"]);
  // Out-of-WUBRG-order input still comes back sorted in WUBRG order.
  assert.deepEqual(decodeArenaColors("5,2"), ["U", "G"]);
  // Whitespace tolerance.
  assert.deepEqual(decodeArenaColors(" 1, 2 "), ["W", "U"]);
  // Unrecognized ids are dropped rather than throwing.
  assert.deepEqual(decodeArenaColors("1,99"), ["W"]);
  // All five.
  assert.deepEqual(decodeArenaColors("2,4,1,5,3"), ["W", "U", "B", "R", "G"]);

  console.log("OK: decodeArenaColors maps Arena's Colors ids to sorted WUBRG letters, tolerating whitespace/unknown ids and colorless input.");
}

run();
