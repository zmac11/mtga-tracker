// Coverage for generateDraftProgressHtml (milestone 7 phase 5) - checks the
// generated page shows the current pack, the pick history (newest first),
// the colors-so-far read, and escapes card names, without needing a real
// browser to render it.

import assert from "node:assert/strict";
import { draftBoardFragmentHtml, generateDraftProgressHtml, type DraftProgressCard, type DraftProgressData } from "./draftProgressHtml.js";

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
      { pack: 1, pick: 1, cards: [card({ cardId: 1, name: "Ashcoast Skirmisher", colors: ["R"] })] },
      { pack: 1, pick: 2, cards: [card({ cardId: 2, name: "Quickstep", colors: ["U"] })] },
    ],
    // Milestone 23: the full pack-seen history - pack 1/pick 1 had 3 cards,
    // Ashcoast Skirmisher (cardId 1) was the one picked from it.
    packsSeen: [
      {
        pack: 1,
        pick: 1,
        cards: [
          card({ cardId: 1, name: "Ashcoast Skirmisher", colors: ["R"] }),
          card({ cardId: 3, name: "Left Behind", colors: ["B"] }),
          card({ cardId: 4, name: "Driftwood Hull", colors: [] }),
        ],
        pickedCardIds: [1],
      },
      {
        pack: 1,
        pick: 2,
        cards: [card({ cardId: 2, name: "Quickstep", colors: ["U"] }), card({ cardId: 5, name: "Stormcrag Elemental", colors: ["R"] })],
        pickedCardIds: [2],
      },
    ],
  };

  const html = generateDraftProgressHtml(data);

  // Header content.
  assert.ok(html.includes("Pack 2, Pick 5"));
  assert.ok(html.includes("2 cards in this pack"));
  assert.ok(html.includes("2 picked so far"));
  assert.ok(html.includes("UR"));
  assert.ok(html.includes(`meta http-equiv="refresh" content="3"`)); // auto-refresh, no server involved
  // Milestone 16: this page's card-row previews had the same off-screen-panel
  // bug as the deck viewer's (see deckViewerHtml.test.ts) - it had no <script>
  // at all before this fix, so CARD_PREVIEW_JS is now the whole of it.
  assert.ok(html.includes("function positionPreview(trigger)"));
  assert.ok(html.includes("function initCardPreviewPositioning()"));

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
  const empty = generateDraftProgressHtml({ draftId: "draft-2", pack: 1, pick: 1, colorCombo: "Colorless", currentPack: [], picks: [], packsSeen: [] });
  assert.ok(empty.includes("Pack 1, Pick 1"));
  assert.ok(empty.includes("0 cards in this pack"));

  // HTML-escapes card names to avoid injecting markup from a (theoretically) untrusted card name.
  const withSpecialChars = generateDraftProgressHtml({
    ...data,
    currentPack: [card({ cardId: 99, name: "<script>alert(1)</script>" })],
  });
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("&lt;script&gt;"));

  // "Pick Two" draft (2 cards taken per pick - see types.ts's
  // DraftPickMade.grpIds comment): both cards from one pick render, sharing
  // the same pack/pick label, and count as 2 toward "picked so far".
  const pickTwo = generateDraftProgressHtml({
    ...data,
    picks: [
      {
        pack: 1,
        pick: 1,
        cards: [card({ cardId: 1, name: "Card A", colors: ["R"] }), card({ cardId: 2, name: "Card B", colors: ["U"] })],
      },
    ],
    // Scoped to [] here so the P1p1 count check below is only counting the
    // "Picks so far" column's rows, not also picking up a pack-group-label
    // from the (unrelated, inherited-from `data`) "All packs seen" column.
    packsSeen: [],
  });
  assert.ok(pickTwo.includes("2 picked so far")); // one pick action, 2 cards - counts cards, not pick actions
  assert.ok(pickTwo.includes("Card A"));
  assert.ok(pickTwo.includes("Card B"));
  assert.equal((pickTwo.match(/P1p1/g) ?? []).length, 2); // one row per card, same pack/pick label

  // Milestone 23: "All packs seen" column - every pack-seen entry renders,
  // newest first, with the picked card visually marked (picked-badge +
  // .picked class) and the passed-over cards present but unmarked.
  assert.ok(html.includes("All packs seen"));
  assert.ok(html.includes("Left Behind")); // passed-over card from pack 1/pick 1, still shown
  assert.ok(html.includes("Stormcrag Elemental")); // passed-over card from pack 1/pick 2, still shown
  // Newest pack-seen entry (P1p2) should appear before the older one (P1p1).
  assert.ok(html.indexOf("Stormcrag Elemental") < html.indexOf("Left Behind"));
  // Exactly 2 picked-badges (one per packsSeen entry that had a pick), not one per card.
  // (Matches the title tooltip, not the bare class name, since that also appears once more in this page's own <style> block.)
  assert.equal((html.match(/title="Picked from this pack"/g) ?? []).length, 2);

  // Milestone 23: draftBoardFragmentHtml - the compact fragment the overlay
  // HUD embeds directly (no page wrapper, no <style>/<script> of its own).
  const fragment = draftBoardFragmentHtml(data);
  assert.ok(!fragment.includes("<!DOCTYPE"));
  assert.ok(!fragment.includes("<html"));
  assert.ok(fragment.includes("Pack 2, Pick 5"));
  assert.ok(fragment.includes("UR"));
  assert.ok(fragment.includes("Ashcoast Skirmisher"));
  assert.ok(fragment.includes("Left Behind"));
  assert.ok(fragment.includes("Quickstep"));
  assert.ok(fragment.includes("Stormcrag Elemental"));
  // Newest pack first in the fragment too.
  assert.ok(fragment.indexOf("Stormcrag Elemental") < fragment.indexOf("Left Behind"));
  // Picked cards get the "picked" class on their <li>, passed-over ones don't.
  assert.ok(fragment.includes('class="db-card picked"'));
  assert.ok(fragment.includes('class="db-card"'));
  // Escapes card names here too - same trusted-HTML-fragment convention as the full page.
  const fragmentXss = draftBoardFragmentHtml({
    ...data,
    packsSeen: [{ pack: 1, pick: 1, cards: [card({ cardId: 99, name: "<img onerror=alert(1)>" })], pickedCardIds: [] }],
  });
  assert.ok(!fragmentXss.includes("<img onerror=alert(1)>"));
  assert.ok(fragmentXss.includes("&lt;img"));
  // No current draft at all (empty packsSeen) still renders without throwing.
  const emptyFragment = draftBoardFragmentHtml({ draftId: "draft-2", pack: 1, pick: 1, colorCombo: "", currentPack: [], picks: [], packsSeen: [] });
  assert.ok(emptyFragment.includes("Pack 1, Pick 1"));
  assert.ok(emptyFragment.includes("No colors yet"));

  console.log("OK: generateDraftProgressHtml renders pack/pick progress, the current pack, picks-so-far newest-first with pack/pick labels, colors-so-far, auto-refresh, escapes card names, renders both cards of a multi-card 'Pick Two' pick, lists every pack seen so far with picked cards marked, and renders the overlay's compact draft-board fragment with the same data.");
}

run();
