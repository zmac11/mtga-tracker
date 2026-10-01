// Coverage for generateStatsHtml (milestone 20/22). statsHtml.ts had no
// dedicated test file before milestone 22 added the "Export filtered
// decks" button - this checks that addition (the embedded shareShell
// data and the button/script wiring it to row.shareFragmentHtml) rather
// than re-covering the filter UI's own logic, which is plain inline JS
// with no exported surface to unit-test directly.

import assert from "node:assert/strict";
import { generateStatsHtml } from "./statsHtml.js";
import type { LimitedStatsRow } from "./domain/statsRollup.js";
import type { ShareShellParts } from "./deckShareHtml.js";

function run() {
  const rows: LimitedStatsRow[] = [
    {
      eventId: "QuickDraft_WOE_20260901",
      courseId: null,
      format: "Draft",
      subtype: "QuickDraft",
      setCode: "WOE",
      definitionLabel: "QuickDraft - WOE",
      deckName: "My Deck",
      colorCombo: "BR",
      splashColors: [],
      wins: 3,
      losses: 1,
      mainDeck: [{ cardId: 1, quantity: 17 }],
      deckVersions: [],
      deckViewerFileName: "QuickDraft_WOE_20260901.html",
      shareFragmentHtml: `<section class="shared-deck">My Deck fragment</section>`,
    },
    {
      eventId: "Sealed_WOE_20260902",
      courseId: null,
      format: "Sealed",
      subtype: "Sealed",
      setCode: "WOE",
      definitionLabel: "Sealed - WOE",
      deckName: null,
      colorCombo: "(no deck captured)",
      splashColors: [],
      wins: 0,
      losses: 0,
      mainDeck: [],
      deckVersions: [],
      deckViewerFileName: null,
      // No deck captured for this run - buildLimitedStatsRows-equivalent
      // null, same convention as deckViewerFileName above.
      shareFragmentHtml: null,
    },
  ];

  const shareShell: ShareShellParts = { head: "<!DOCTYPE html><html><body>", tail: "</body></html>" };

  const html = generateStatsHtml(rows, [], shareShell);

  // Row data (including the new shareFragmentHtml field) is embedded whole for the client-side filter/export JS.
  assert.ok(html.includes("My Deck fragment"));
  assert.ok(html.includes('"shareFragmentHtml":null')); // the no-deck row's null survives JSON.stringify as-is

  // The shareShell wrapper is embedded as its own JSON blob, separate
  // from the per-row data - generateStatsHtml escapes every "<" to a
  // literal backslash-u003c sequence in each embedded JSON block (same
  // treatment as the rows/cardCatalog blocks), so the raw "<!DOCTYPE"
  // substring won't appear verbatim - built via fromCharCode here rather
  // than a backslash-escape literal, to sidestep any ambiguity about how
  // many backslashes a given tool/editor layer collapses.
  const escapeForJsonLt = (s: string) => s.split("<").join(String.fromCharCode(92) + "u003c");
  assert.ok(html.includes('id="share-shell-data"'));
  assert.ok(html.includes(escapeForJsonLt("<!DOCTYPE html><html><body>")));
  assert.ok(html.includes(escapeForJsonLt("</body></html>")));

  // The "Export filtered decks" button and its click handler (Blob + <a download>, no IPC round-trip) are present.
  assert.ok(html.includes('id="export-filtered-btn"'));
  assert.ok(html.includes("Export filtered decks"));
  assert.ok(html.includes("new Blob("));
  assert.ok(html.includes('a.download = "mtga-shared-decks.html"'));
  // Filters out rows with no captured deck (shareFragmentHtml === null) rather than exporting an empty section for them.
  assert.ok(html.includes("filter((r) => r.shareFragmentHtml)"));

  console.log("OK: generateStatsHtml embeds each row's pre-rendered shareFragmentHtml and the shared {head, tail} shareShell as their own JSON blocks, and renders an 'Export filtered decks' button whose client-side handler assembles a combined page (Blob + <a download>) from whichever currently-filtered rows actually have a captured deck.");
}

run();
