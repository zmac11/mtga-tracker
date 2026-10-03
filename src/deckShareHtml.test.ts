// Coverage for generateDeckShareHtml (milestone 22) - the single-deck,
// no-tracker-needed "share" page. Mostly checks it correctly reuses
// deckViewerHtml.ts's own header/visual-grid/sideboard-list rendering
// (which has its own, more thorough coverage in deckViewerHtml.test.ts)
// rather than re-testing that content in depth here, plus the bits unique
// to this page: no tabs, the Arena-import textarea/copy button, and the
// optional app-version/sideboard-empty handling.

import assert from "node:assert/strict";
import { buildShareShellParts, generateDeckShareHtml, renderShareSectionHtml, type ShareDeckData } from "./deckShareHtml.js";
import type { ViewerCard } from "./deckViewerHtml.js";

function card(overrides: Partial<ViewerCard> & Pick<ViewerCard, "cardId" | "name">): ViewerCard {
  return { quantity: 1, colors: [], types: [], manaCost: null, oracleText: null, imageNormal: null, ...overrides };
}

function run() {
  const data: ShareDeckData = {
    eventId: "ContenderDraft_HOB_20260824",
    format: "Draft",
    definitionLabel: "ContenderDraft - HOB",
    deckName: "Draft Deck",
    colorCombo: "BR",
    winRate: { wins: 4, losses: 2, total: 6, pct: "67%" },
    mainDeck: [
      card({ cardId: 1, name: "Bothersome Noisemaker", quantity: 2, colors: ["R"], types: ["Creature"], manaCost: "{1}{R}", imageNormal: "https://example.com/img.jpg" }),
      card({ cardId: 3, name: "Mountain", quantity: 8, types: ["Land"] }),
    ],
    sideboard: null,
    arenaImportText: "Deck\n2 Bothersome Noisemaker (WOE) 123\n8 Mountain (WOE) 270",
  };

  const html = generateDeckShareHtml(data);

  // Reused header (same markup renderDeckHeaderHtml produces for the normal page).
  assert.ok(html.includes("Draft Deck"));
  assert.ok(html.includes("ContenderDraft - HOB"));
  assert.ok(html.includes("BR"));
  assert.ok(html.includes("4-2"));

  // Reused Visual tab grid (the "arts, columns, separated creatures/non-creatures" layout).
  assert.ok(html.includes("Bothersome Noisemaker"));
  assert.ok(html.includes("https://example.com/img.jpg"));
  assert.ok(html.includes(`class="visual-card" data-role="creature"`));
  assert.ok(html.includes(`class="visual-card" data-role="land"`));
  assert.ok(html.includes("toggleVisualSeparate"));
  assert.ok(html.includes("function initVisualHover()"));

  // No tabs on this page at all - it's a single scrolling page, unlike the
  // full deck-viewer page's "Deck list"/"Visual"/"Curve"/etc. tab bar.
  assert.ok(!html.includes('class="tabs"'));
  assert.ok(!html.includes("showView("));

  // No sideboard captured (null) - no "Sideboard" section rendered at all.
  assert.ok(!html.includes("<h2>Sideboard "));

  // The Arena-import textarea carries the exact pre-built text, verbatim.
  assert.ok(html.includes("2 Bothersome Noisemaker (WOE) 123"));
  assert.ok(html.includes("8 Mountain (WOE) 270"));
  assert.ok(html.includes('class="arena-import"'));
  assert.ok(html.includes("copyImportText"));

  // No appVersion passed - no footer DIV at all (not a blank one) - the
  // .app-version-footer CSS rule is always present in <style>, so this
  // checks for the actual markup, not just the class name substring.
  assert.ok(!html.includes('<div class="app-version-footer">'));

  // A real, non-empty sideboard DOES get its own section.
  const withSideboard = generateDeckShareHtml({
    ...data,
    sideboard: [card({ cardId: 4, name: "Shock", quantity: 1, colors: ["R"], types: ["Instant"] })],
    appVersion: "0.3.1",
  });
  assert.ok(withSideboard.includes("<h2>Sideboard "));
  assert.ok(withSideboard.includes("Shock"));
  assert.ok(withSideboard.includes("Shared from MTGA Tracker v0.3.1"));

  // Milestone 22 follow-up: the "export a filtered SET of decks" case
  // (statsHtml.ts's "Export filtered decks" button) builds one combined
  // page as `head + section1 + section2 + ... + tail` - renderShareSectionHtml
  // and buildShareShellParts are the two halves of that formula, and
  // generateDeckShareHtml above is just that formula with exactly one
  // section. Check the formula actually composes into one valid,
  // self-contained page for more than one deck, with no id collisions
  // between the two decks' copy buttons/textareas (both use a class,
  // resolved relative to each button via .closest(".import-box") - see
  // copyImportText in buildShareShellParts's tail).
  const other: ShareDeckData = { ...data, eventId: "QuickDraft_WOE_20260901", deckName: "Second Deck", arenaImportText: "Deck\n1 Shock (WOE) 99" };
  const { head, tail } = buildShareShellParts("2 decks exported - MTGA Tracker");
  const combined = head + renderShareSectionHtml(data) + renderShareSectionHtml(other) + tail;
  assert.ok(combined.startsWith("<!DOCTYPE html>"));
  assert.ok(combined.trim().endsWith("</html>"));
  assert.ok(combined.includes("Draft Deck"));
  assert.ok(combined.includes("Second Deck"));
  assert.ok(combined.includes("1 Shock (WOE) 99"));
  // Exactly one copy of the shared CSS/JS, not one per section.
  assert.equal(combined.split("function initVisualHover()").length - 1, 1);
  assert.equal((combined.match(/<style>/g) ?? []).length, 1);
  assert.ok(!combined.includes('id="arena-import"'));

  // Download bar: one bar in the shared head, one embedded JSON payload per deck section,
  // and a card name can never break out of the payload's <script> tag.
  assert.ok(html.includes('id="download-bar"'));
  for (const kind of ["html", "txt", "csv", "md", "json"]) assert.ok(html.includes(`downloadDecks('${kind}', this)`), kind);
  assert.ok(html.includes("window.print()"));
  assert.equal(html.split('class="download-bar"').length - 1, 1);
  assert.equal(combined.split('class="download-bar"').length - 1, 1);
  const payloads = [...combined.matchAll(/<script type="application\/json" class="deck-data">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].title, "Draft Deck");
  assert.equal(payloads[0].record, "4-2");
  assert.equal(payloads[0].main[0].name, "Bothersome Noisemaker");
  assert.equal(payloads[0].main[0].types, "Creature");
  assert.equal(payloads[0].arenaImport, data.arenaImportText);
  assert.equal(payloads[1].title, "Second Deck");
  const evil = renderShareSectionHtml({ ...data, deckName: "</script><b>x", mainDeck: [card({ cardId: 9, name: "A</script>B", types: ["Land"] })] });
  assert.equal(evil.split("</script>").length - 1, 1, "only the payload's own closing tag may appear");

  console.log("OK: generateDeckShareHtml reuses deckViewerHtml.ts's header and Visual-tab card grid verbatim, renders a tab-free single-page layout, shows the Sideboard list only when one was actually captured, embeds the pre-built Arena-import text with a copy button, shows the app-version footer only when passed, and (via renderShareSectionHtml + buildShareShellParts) composes into one valid combined page for a multi-deck export with exactly one shared copy of the CSS/JS.");
}

run();
