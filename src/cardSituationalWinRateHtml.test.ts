// Coverage for generateCardSituationalWinRateHtml (milestone 23, features
// e/f) - checks the generated page embeds the rows, renders the
// explanatory copy, and includes the format/color-filter/min-games
// controls, without needing a real browser to render it.

import assert from "node:assert/strict";
import { generateCardSituationalWinRateHtml, type CardSituationalWinRateHtmlRow } from "./cardSituationalWinRateHtml.js";

function bucket(wins: number, losses: number) {
  const total = wins + losses;
  return { wins, losses, total, pct: total > 0 ? `${Math.round((wins / total) * 100)}%` : "-" };
}

function run() {
  const rows: CardSituationalWinRateHtmlRow[] = [
    {
      cardId: 1,
      name: "Ashcoast Skirmisher",
      colors: ["R"],
      format: "Draft",
      inHand: bucket(8, 2),
      notInHand: bucket(3, 5),
      played: bucket(7, 1),
      notPlayed: bucket(4, 6),
    },
    {
      cardId: 2,
      name: "Driftwood Hull",
      colors: [],
      format: "Constructed",
      inHand: bucket(1, 1),
      notInHand: bucket(2, 2),
      played: bucket(0, 0),
      notPlayed: bucket(3, 3),
    },
  ];

  const html = generateCardSituationalWinRateHtml(rows);

  assert.ok(html.includes("Card Situational Win Rate"));
  assert.ok(html.includes("final, post-mulligan kept opening hand")); // explanatory copy states (e)'s definition
  assert.ok(html.includes('id="min-games"'));
  assert.ok(html.includes('id="color-chips"'));
  assert.ok(html.includes('id="format-chips"'));
  assert.ok(html.includes('id="reset-filters"'));

  // Embedded data (escaped JSON).
  assert.ok(html.includes('"Ashcoast Skirmisher"'));
  assert.ok(html.includes('"format":"Draft"'));
  assert.ok(html.includes('"Driftwood Hull"'));

  // HTML-escapes card names via the page's own client-side escapeText -
  // same convention as draftPickStatsHtml.ts: the raw name only ever
  // appears inside the escaped JSON data block, never interpolated
  // directly into markup.
  const withSpecialChars = generateCardSituationalWinRateHtml([
    { cardId: 99, name: "<script>alert(1)</script>", colors: [], format: "Draft", inHand: bucket(0, 0), notInHand: bucket(0, 0), played: bucket(0, 0), notPlayed: bucket(0, 0) },
  ]);
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("\\u003cscript>alert(1)\\u003c/script>"));

  // Empty data renders without throwing - empty table, not a missing page.
  const empty = generateCardSituationalWinRateHtml([]);
  assert.ok(empty.includes("Card Situational Win Rate"));
  assert.ok(empty.includes('id="rows-body"'));

  console.log(
    "OK: generateCardSituationalWinRateHtml embeds situational win-rate rows as escaped JSON, renders the format/color-chip/min-games filter controls and explanatory copy, and renders without throwing on an empty dataset.",
  );
}

run();
