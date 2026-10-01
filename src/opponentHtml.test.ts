// Milestone 24 (2026-10-01): first dedicated test coverage for
// opponentHtml.ts, added while wiring in the new "Turns" column.

import assert from "node:assert/strict";
import { generateOpponentHtml } from "./opponentHtml.js";
import type { OpponentMatchRow } from "./domain/opponentStats.js";

function run() {
  const rows: OpponentMatchRow[] = [
    {
      matchId: "m1", opponent: "Alice", eventId: "QuickDraft_HOB_20260915", courseId: null,
      format: "Draft", subtype: "QuickDraft", setCode: "HOB", definitionLabel: "QuickDraft - HOB",
      outcome: "WIN", reason: "Game", ts: "2026-09-18T00:00:00Z", myDeckName: "My Deck", turnCounts: [9],
    },
    {
      // A synthetic multi-game match - turnCounts should render as
      // separate per-game numbers, not summed.
      matchId: "m2", opponent: "Bob", eventId: "Ladder_Standard_20260101", courseId: null,
      format: "Constructed", subtype: "Ladder", setCode: null, definitionLabel: "Ladder",
      outcome: "LOSS", reason: "Game", ts: "2026-09-19T00:00:00Z", myDeckName: "My Deck", turnCounts: [10, 7],
    },
    {
      matchId: "m3", opponent: "Carol", eventId: null, courseId: null,
      format: "Unknown", subtype: null, setCode: null, definitionLabel: "(unknown event)",
      outcome: null, reason: null, ts: "2026-09-20T00:00:00Z", myDeckName: null, turnCounts: [],
    },
  ];

  const html = generateOpponentHtml(rows);

  assert.ok(html.includes("Opponent History"));
  assert.ok(html.includes("<th>Turns</th>"));
  // Embedded data carries turnCounts through as plain JSON.
  assert.ok(html.includes('"turnCounts":[9]'));
  assert.ok(html.includes('"turnCounts":[10,7]'));
  assert.ok(html.includes('"turnCounts":[]'));

  const empty = generateOpponentHtml([]);
  assert.ok(empty.includes("Opponent History"));
  assert.ok(empty.includes('id="opponent-rows-body"'));

  console.log("OK: generateOpponentHtml renders the new Turns column header and embeds each match's own turnCounts array (multi-game and empty cases) as JSON.");
}

run();
