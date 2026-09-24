// Coverage for generateDeckViewerHtml (milestone 7 phase 4) - checks the
// generated page contains the expected content for both the deck-list and
// curve views, without needing a real browser to render it.

import assert from "node:assert/strict";
import { generateDeckViewerHtml, type DeckViewerData, type ViewerCard } from "./deckViewerHtml.js";

function card(overrides: Partial<ViewerCard> & Pick<ViewerCard, "cardId" | "name">): ViewerCard {
  return { quantity: 1, colors: [], types: [], manaCost: null, oracleText: null, imageNormal: null, ...overrides };
}

function run() {
  const data: DeckViewerData = {
    eventId: "ContenderDraft_HOB_20260824",
    format: "Draft",
    definitionLabel: "ContenderDraft - HOB",
    deckName: "Draft Deck",
    colorCombo: "BR",
    winRate: { wins: 4, losses: 2, total: 6, pct: "67%" },
    mainDeck: [
      card({ cardId: 1, name: "Bothersome Noisemaker", quantity: 2, colors: ["R"], types: ["Creature"], manaCost: "{1}{R}", imageNormal: "https://example.com/img.jpg" }),
      card({ cardId: 2, name: "Necromancy", quantity: 1, colors: ["B"], types: ["Enchantment"], manaCost: "{1}{B}", oracleText: "Reanimate a creature." }),
      card({ cardId: 3, name: "Mountain", quantity: 8, types: ["Land"] }),
    ],
    sideboard: [card({ cardId: 4, name: "Shock", quantity: 1, colors: ["R"], types: ["Instant"], manaCost: "{R}" })],
  };

  const html = generateDeckViewerHtml(data);

  // Header content.
  assert.ok(html.includes("Draft Deck"));
  assert.ok(html.includes("ContenderDraft - HOB"));
  assert.ok(html.includes("ContenderDraft_HOB_20260824"));
  assert.ok(html.includes("BR"));
  assert.ok(html.includes("4-2"));
  assert.ok(html.includes("67%"));

  // Maindeck/sideboard card rows.
  assert.ok(html.includes("Bothersome Noisemaker"));
  assert.ok(html.includes("https://example.com/img.jpg")); // hover image
  assert.ok(html.includes("Necromancy"));
  assert.ok(html.includes("Reanimate a creature.")); // oracle-text fallback for a card with no image
  assert.ok(html.includes("Shock")); // sideboard card present

  // Curve section: buckets should include the Mountain's "Land" label and Bothersome Noisemaker's cmc-2 bucket.
  assert.ok(html.includes("curve-label\">Land<"));
  assert.ok(html.includes("curve-label\">2<"));

  // A run with no sideboard data shows the "not captured" message rather than an empty list.
  const noSideboard = generateDeckViewerHtml({ ...data, sideboard: null });
  assert.ok(noSideboard.includes("Not captured for this run"));

  // HTML-escapes card names to avoid injecting markup from a (theoretically) untrusted card name.
  const withSpecialChars = generateDeckViewerHtml({ ...data, mainDeck: [card({ cardId: 5, name: "<script>alert(1)</script>" })] });
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("&lt;script&gt;"));

  console.log("OK: generateDeckViewerHtml renders header/record/colors, maindeck+sideboard card rows (image or oracle-text hover fallback), curve buckets, the no-sideboard-captured message, and escapes card names.");
}

run();
