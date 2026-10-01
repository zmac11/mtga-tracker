// Coverage for generateDraftPickStatsHtml (milestone 23, feature d) -
// checks the generated page embeds the rows, renders the explanatory copy,
// and includes the color-filter/min-picked controls, without needing a
// real browser to render it.

import assert from "node:assert/strict";
import { generateDraftPickStatsHtml, type DraftPickStatsRow } from "./draftPickStatsHtml.js";

function run() {
  const rows: DraftPickStatsRow[] = [
    { cardId: 1, name: "Ashcoast Skirmisher", colors: ["R"], timesPicked: 5, avgOthersInPack: 6.2, minOthersInPack: 1, maxOthersInPack: 12 },
    { cardId: 2, name: "Driftwood Hull", colors: [], timesPicked: 2, avgOthersInPack: 0.5, minOthersInPack: 0, maxOthersInPack: 1 },
  ];

  const html = generateDraftPickStatsHtml(rows);

  assert.ok(html.includes("Draft Pick Stats"));
  assert.ok(html.includes("avg others in pack")); // explanatory copy mentions the metric by its exact column name
  assert.ok(html.includes('id="min-picked"'));
  assert.ok(html.includes('id="color-chips"'));
  assert.ok(html.includes('id="reset-filters"'));

  // Embedded data (escaped JSON, so look for the escaped form like
  // statsHtml.test.ts's own convention for this project's `<` -> <
  // JSON-escaping gotcha).
  assert.ok(html.includes('"Ashcoast Skirmisher"'));
  assert.ok(html.includes('"avgOthersInPack":6.2'));
  assert.ok(html.includes('"Driftwood Hull"'));

  // HTML-escapes card names in the generated page's own client-side escapeText (can't run it here without a DOM, but the raw name is embedded as JSON data, not interpolated directly into markup - confirm no literal unescaped markup-looking name made it into the page outside the JSON block).
  const withSpecialChars = generateDraftPickStatsHtml([
    { cardId: 99, name: "<script>alert(1)</script>", colors: [], timesPicked: 1, avgOthersInPack: 0, minOthersInPack: 0, maxOthersInPack: 0 },
  ]);
  // The JSON embed escapes "<" to the JS-safe < form (same convention as statsHtml.ts), so a literal "<script>" tag never appears in the page.
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("\\u003cscript>alert(1)\\u003c/script>"));

  // Empty data renders without throwing - empty table, not a missing page.
  const empty = generateDraftPickStatsHtml([]);
  assert.ok(empty.includes("Draft Pick Stats"));
  assert.ok(empty.includes('id="rows-body"'));

  console.log(
    "OK: generateDraftPickStatsHtml embeds pick-priority rows as escaped JSON, renders the color-chip/min-picked filter controls and explanatory copy, and renders without throwing on an empty dataset.",
  );
}

run();
