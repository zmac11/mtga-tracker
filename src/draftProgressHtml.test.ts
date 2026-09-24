// Coverage for generateDraftProgressHtml (milestone 7 phase 5) - checks the
// generated page shows the current pack, the pick history (newest first),
// the colors-so-far read, and escapes card names, without needing a real
// browser to render it.

import assert from "node:assert/strict";
import { generateDraftProgressHtml, type DraftProgressCard, type DraftProgressData } from "./draftProgressHtml.js";

function card(overrides: Partial<DraftProgressCard> & Pick<DraftProgressCard, "cardId" | "name">): DraftProgressCard {
  return { colors: [], oracleText: null, imageNormal: null, ...overrides };
}

function run() {
  const data: DraftProgressData = {
    draftId: "draft-1",
    pack: 2,
    pick: 5,
    colorCombo: "UR",
    currentPack: [
      card({ cardId: 10, name: "Riverglass Sprite", colors: ["U"], imageNormal: "https://example.com/sprite.jpg" }),
      card({ cardId: 11, name: "Cinder Whelp", colors: ["R"], oracleText: "Flying." }),
    ],
    picks: [
      { pack: 1, pick: 1, card: card({ cardId: 1, name: "Ashcoast Skirmisher", colors: ["R"] }) },
      { pack: 1, pick: 2, card: card({ cardId: 2, name: "Quickstep", colors: ["U"] }) },
    ],
  };

  const html = generateDraftProgressHtml(data);

  // Header content.
  assert.ok(html.includes("Pack 2, Pick 5"));
  assert.ok(html.includes("2 cards in this pack"));
  assert.ok(html.includes("2 picked so far"));
  assert.ok(html.includes("UR"));
  assert.ok(html.includes(`meta http-equiv="refresh" content="3"`)); // auto-refresh, no server involved

  // Current pack: both cards present, with their hover-preview fallbacks (image vs oracle text).
  assert.ok(html.includes("Riverglass Sprite"));
  assert.ok(html.includes("https://example.com/sprite.jpg"));
  assert.ok(html.includes("Cinder Whelp"));
  assert.ok(html.includes("Flying.")); // oracle-text fallback for a card with no image

  // Picks so far, newest first: pick 2 (Quickstep) must appear before pick 1 (Ashcoast Skirmisher) in the markup.
  assert.ok(html.includes("Quickstep"));
  assert.ok(html.includes("Ashcoast Skirmisher"));
  assert.ok(html.indexOf("Quickstep") < html.indexOf("Ashcoast Skirmisher"));
  assert.ok(html.includes("P1p2")); // pack/pick label
  assert.ok(html.includes("P1p1"));

  // No current-draft data (e.g. right at the very start, before any pack has ever been seen)
  // still renders without throwing - empty lists, not missing sections.
  const empty = generateDraftProgressHtml({ draftId: "draft-2", pack: 1, pick: 1, colorCombo: "Colorless", currentPack: [], picks: [] });
  assert.ok(empty.includes("Pack 1, Pick 1"));
  assert.ok(empty.includes("0 cards in this pack"));

  // HTML-escapes card names to avoid injecting markup from a (theoretically) untrusted card name.
  const withSpecialChars = generateDraftProgressHtml({
    ...data,
    currentPack: [card({ cardId: 99, name: "<script>alert(1)</script>" })],
  });
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("&lt;script&gt;"));

  console.log("OK: generateDraftProgressHtml renders pack/pick progress, the current pack, picks-so-far newest-first with pack/pick labels, colors-so-far, auto-refresh, and escapes card names.");
}

run();
